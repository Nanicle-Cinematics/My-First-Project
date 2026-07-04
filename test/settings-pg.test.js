'use strict';
// Phase 6, module 2: routes-pg/settings.js.
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
  return { get: (p) => send('GET', p), put: (p, b) => send('PUT', p, b), post: (p, b) => send('POST', p, b) };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function newSignedInChurch(tag) {
  const client = cookieClient();
  const email = uniqueEmail(tag);
  const res = await client.post('/signup', { churchName: `${tag} Church`, name: 'Owner', email, password: 'password123' });
  createdChurchIds.push(res.body.church.id);
  return { client, churchId: res.body.church.id };
}

async function addNonAdminUser(churchId, role) {
  const email = uniqueEmail(`non-admin-${role.toLowerCase()}`);
  const passwordHash = await bcrypt.hash('password123', 10);
  await db.user.create({ data: { churchId, username: `u-${Date.now()}`, email, passwordHash, role, financeRole: 'NONE' } });
  const client = cookieClient();
  const login = await client.post('/login', { email, password: 'password123' });
  assert.strictEqual(login.status, 200);
  return client;
}

test('new churches start on the Free plan, reports disabled, max 2 users', async () => {
  const { client } = await newSignedInChurch('settings-free');
  const res = await client.get('/api/settings');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.plan.key, 'free');
  assert.strictEqual(res.body.plan.reports, false);
  assert.strictEqual(res.body.plan.maxUsers, 2);
  assert.strictEqual(res.body.plan.userCount, 1);
});

test('owner can rename the church; non-admin cannot', async () => {
  const { client, churchId } = await newSignedInChurch('settings-rename');
  const updated = await client.put('/api/settings', { name: 'Renamed Chapel' });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.name, 'Renamed Chapel');

  const viewer = await addNonAdminUser(churchId, 'VIEWER');
  assert.strictEqual((await viewer.put('/api/settings', { name: 'Hijacked' })).status, 403);

  const empty = await client.put('/api/settings', { name: '' });
  assert.strictEqual(empty.status, 400);
});

test('a manually-activated Pro church sees Pro limits reflected in settings', async () => {
  const { client, churchId } = await newSignedInChurch('settings-pro');
  await db.church.update({ where: { id: churchId }, data: { plan: 'pro', proSince: new Date() } });
  const res = await client.get('/api/settings');
  assert.strictEqual(res.body.plan.key, 'pro');
  assert.strictEqual(res.body.plan.reports, true);
  assert.strictEqual(res.body.plan.maxUsers, null);
});

test('cross-tenant: church B\'s rename does not affect church A', async () => {
  const a = await newSignedInChurch('settings-cross-a');
  const b = await newSignedInChurch('settings-cross-b');
  await b.client.put('/api/settings', { name: 'B Renamed' });
  const aSettings = await a.client.get('/api/settings');
  assert.notStrictEqual(aSettings.body.church.name, 'B Renamed');
});
