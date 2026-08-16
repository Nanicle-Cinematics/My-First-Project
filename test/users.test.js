'use strict';
// Phase 6, module 1: routes-pg/users.js.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const createdChurchIds = [];

let server, base;
test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  if (createdChurchIds.length) {
    const where = { churchId: { in: createdChurchIds } };
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
  await pool.end();
});

function cookieClient() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  const send = async (method, p, jsonBody) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    });
    remember(res);
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  };
  return {
    get: (p) => send('GET', p),
    post: (p, b) => send('POST', p, b),
    put: (p, b) => send('PUT', p, b),
    del: (p) => send('DELETE', p),
  };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function newSignedInChurch(tag) {
  const client = cookieClient();
  const email = uniqueEmail(tag);
  const res = await client.post('/signup', { churchName: `${tag} Church`, name: 'Owner', email, password: 'password123' });
  createdChurchIds.push(res.body.church.id);
  // These tests cover user management, not the Free plan's seat limit — that
  // has its own coverage in test/plan-limits.test.js — so they run on Pro,
  // where seats are unlimited.
  await db.church.update({ where: { id: res.body.church.id }, data: { plan: 'pro' } });
  return { client, churchId: res.body.church.id, ownerId: res.body.user.id };
}

async function addNonAdminUser(churchId, role) {
  const email = uniqueEmail(`non-admin-${role.toLowerCase()}`);
  const passwordHash = await bcrypt.hash('password123', 10);
  const user = await db.user.create({ data: { churchId, username: `u-${Date.now()}`, email, passwordHash, role, financeRole: 'NONE' } });
  const client = cookieClient();
  const login = await client.post('/login', { email, password: 'password123' });
  assert.strictEqual(login.status, 200);
  return { client, userId: user.id };
}

test('owner sees themself in the user list after signup (seeded ADMIN)', async () => {
  const { client, ownerId } = await newSignedInChurch('users-list');
  const res = await client.get('/api/users');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.some((u) => u.id === ownerId && u.role === 'ADMIN'));
});

test('invite a new user with a role and finance role; duplicate username in same church rejected', async () => {
  const { client } = await newSignedInChurch('users-invite');
  const invited = await client.post('/api/users', {
    username: 'treasurer1', email: uniqueEmail('treasurer'), password: 'password123', role: 'VIEWER', financeRole: 'TREASURER',
  });
  assert.strictEqual(invited.status, 201);
  assert.strictEqual(invited.body.financeRole, 'TREASURER');

  const dup = await client.post('/api/users', {
    username: 'treasurer1', email: uniqueEmail('treasurer2'), password: 'password123',
  });
  assert.strictEqual(dup.status, 409);
});

test('email is globally unique across churches, not just per-church', async () => {
  const a = await newSignedInChurch('users-global-email-a');
  const b = await newSignedInChurch('users-global-email-b');
  const email = uniqueEmail('shared');
  const first = await a.client.post('/api/users', { username: 'person', email, password: 'password123' });
  assert.strictEqual(first.status, 201);
  const second = await b.client.post('/api/users', { username: 'person', email, password: 'password123' });
  assert.strictEqual(second.status, 409);
});

test('cannot demote the church\'s last admin', async () => {
  const { client, ownerId } = await newSignedInChurch('users-last-admin');
  const res = await client.put(`/api/users/${ownerId}/role`, { role: 'VIEWER' });
  assert.strictEqual(res.status, 400);
});

test('reset-password, disable-2fa, delete a teammate; cannot delete self', async () => {
  const { client, ownerId } = await newSignedInChurch('users-manage');
  const invited = await client.post('/api/users', { username: 'staff1', email: uniqueEmail('staff'), password: 'password123' });
  const id = invited.body.id;

  assert.strictEqual((await client.post(`/api/users/${id}/reset-password`, { password: 'newpassword123' })).status, 204);
  assert.strictEqual((await client.post(`/api/users/${id}/disable-2fa`)).status, 204);
  assert.strictEqual((await client.del(`/api/users/${id}`)).status, 204);
  assert.strictEqual((await client.del(`/api/users/${ownerId}`)).status, 400, 'cannot delete your own account');

  const list = await client.get('/api/users');
  assert.ok(!list.body.some((u) => u.id === id), 'deleted (deactivated) users are excluded from the list');
});

test('cross-tenant: church B admin cannot see or modify church A\'s users', async () => {
  const a = await newSignedInChurch('users-cross-a');
  const b = await newSignedInChurch('users-cross-b');
  const invited = await a.client.post('/api/users', { username: 'a-staff', email: uniqueEmail('a-staff'), password: 'password123' });

  const bList = await b.client.get('/api/users');
  assert.ok(!bList.body.some((u) => u.id === invited.body.id));

  assert.strictEqual((await b.client.put(`/api/users/${invited.body.id}/role`, { role: 'ADMIN' })).status, 404);
  assert.strictEqual((await b.client.del(`/api/users/${invited.body.id}`)).status, 404);
});

test('non-admin (VIEWER) cannot manage users at all', async () => {
  const { churchId } = await newSignedInChurch('users-rbac');
  const { client: viewer } = await addNonAdminUser(churchId, 'VIEWER');
  assert.strictEqual((await viewer.get('/api/users')).status, 403);
  assert.strictEqual((await viewer.post('/api/users', { username: 'x', email: uniqueEmail('x'), password: 'password123' })).status, 403);
});
