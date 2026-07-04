'use strict';
// Phase 2, module 1: routes-pg/preaching.js. Same harness/conventions as
// test/tenant-auth.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');

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
    await db.preachingPlan.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  // The `session` table is shared across all test files/the real app —
  // never dropped here (see scripts/ensure-session-table.js).
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
  return { client, churchId: res.body.church.id, email };
}

async function addNonAdminUser(churchId, role) {
  const email = uniqueEmail(`non-admin-${role.toLowerCase()}`);
  const passwordHash = await bcrypt.hash('password123', 10);
  await db.user.create({ data: { churchId, username: `viewer-${Date.now()}`, email, passwordHash, role, financeRole: 'NONE' } });
  const client = cookieClient();
  const login = await client.post('/login', { email, password: 'password123' });
  assert.strictEqual(login.status, 200, 'non-admin login should succeed');
  return client;
}

test('create, read, update, soft-delete a preaching appointment', async () => {
  const { client } = await newSignedInChurch('preaching-crud');

  const created = await client.post('/api/preaching', { preachDate: '2026-08-02', topic: 'Faith', serviceLabel: 'Sunday 9am' });
  assert.strictEqual(created.status, 201);
  const id = created.body.id;

  const fetched = await client.get(`/api/preaching/${id}`);
  assert.strictEqual(fetched.status, 200);
  assert.strictEqual(fetched.body.topic, 'Faith');

  const updated = await client.put(`/api/preaching/${id}`, { preachDate: '2026-08-02', topic: 'Grace' });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.topic, 'Grace');

  const listed = await client.get('/api/preaching');
  assert.strictEqual(listed.status, 200);
  assert.ok(listed.body.upcoming.some((p) => p.id === id));

  const deleted = await client.del(`/api/preaching/${id}`);
  assert.strictEqual(deleted.status, 204);

  const afterDelete = await client.get(`/api/preaching/${id}`);
  assert.strictEqual(afterDelete.status, 404, 'soft-deleted rows are excluded from reads');
});

test('missing preachDate is rejected', async () => {
  const { client } = await newSignedInChurch('preaching-validation');
  const res = await client.post('/api/preaching', { topic: 'No date' });
  assert.strictEqual(res.status, 400);
});

test('editing/deleting someone else\'s appointment id (cross-tenant) 404s, never leaks or mutates', async () => {
  const a = await newSignedInChurch('preaching-cross-a');
  const b = await newSignedInChurch('preaching-cross-b');

  const created = await a.client.post('/api/preaching', { preachDate: '2026-08-16', topic: 'Church A only' });
  const id = created.body.id;

  const crossRead = await b.client.get(`/api/preaching/${id}`);
  assert.strictEqual(crossRead.status, 404);

  const crossUpdate = await b.client.put(`/api/preaching/${id}`, { preachDate: '2026-08-16', topic: 'Hijacked' });
  assert.strictEqual(crossUpdate.status, 404);

  const crossDelete = await b.client.del(`/api/preaching/${id}`);
  assert.strictEqual(crossDelete.status, 404);

  // Still there, still owned by A, untouched.
  const stillThere = await a.client.get(`/api/preaching/${id}`);
  assert.strictEqual(stillThere.status, 200);
  assert.strictEqual(stillThere.body.topic, 'Church A only');
});

test('non-admin (VIEWER) can read but not write', async () => {
  const { churchId } = await newSignedInChurch('preaching-rbac');
  const viewer = await addNonAdminUser(churchId, 'VIEWER');

  const read = await viewer.get('/api/preaching');
  assert.strictEqual(read.status, 200);

  const write = await viewer.post('/api/preaching', { preachDate: '2026-08-20', topic: 'Should be blocked' });
  assert.strictEqual(write.status, 403);
});
