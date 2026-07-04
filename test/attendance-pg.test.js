'use strict';
// Phase 2, module 5: routes-pg/attendance.js.
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
    await db.attendance.deleteMany({ where });
    await db.event.deleteMany({ where });
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

test('create with explicit total, total is respected as-is', async () => {
  const { client } = await newSignedInChurch('att-explicit-total');
  const created = await client.post('/api/attendance', {
    title: 'Sunday Worship', startsAt: '2026-08-02T09:00', attendanceMen: 40, attendanceWomen: 55, attendanceChildren: 20, attendanceTotal: 999,
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.attendanceTotal, 999, 'explicit total overrides the men+women+children sum');
});

test('total is auto-derived from men+women+children when left blank', async () => {
  const { client } = await newSignedInChurch('att-derive-total');
  const created = await client.post('/api/attendance', {
    title: 'Sunday Worship', startsAt: '2026-08-02T09:00', attendanceMen: 40, attendanceWomen: 55, attendanceChildren: 20,
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.attendanceTotal, 115);
});

test('title and startsAt are required', async () => {
  const { client } = await newSignedInChurch('att-validation');
  const noTitle = await client.post('/api/attendance', { startsAt: '2026-08-02T09:00' });
  assert.strictEqual(noTitle.status, 400);
  const noDate = await client.post('/api/attendance', { title: 'No date' });
  assert.strictEqual(noDate.status, 400);
});

test('list, read, update, and delete a service', async () => {
  const { client } = await newSignedInChurch('att-crud');
  const created = await client.post('/api/attendance', { title: 'Wednesday Service', startsAt: '2026-08-05T18:00' });
  const id = created.body.id;

  const fetched = await client.get(`/api/attendance/${id}`);
  assert.strictEqual(fetched.status, 200);
  assert.strictEqual(fetched.body.title, 'Wednesday Service');

  const list = await client.get('/api/attendance');
  assert.ok(list.body.some((s) => s.id === id));

  const updated = await client.put(`/api/attendance/${id}`, { title: 'Wednesday Service', startsAt: '2026-08-05T18:00', attendanceTotal: 200 });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.attendanceTotal, 200);

  const deleted = await client.del(`/api/attendance/${id}`);
  assert.strictEqual(deleted.status, 204);
  assert.strictEqual((await client.get(`/api/attendance/${id}`)).status, 404);
});

test('deleting a non-service event through this endpoint is blocked', async () => {
  const { client, churchId } = await newSignedInChurch('att-guard');
  const nonService = await db.event.create({ data: { churchId, title: 'Youth trip', eventType: 'YOUTH', startsAt: new Date('2026-08-10T10:00') } });
  const res = await client.del(`/api/attendance/${nonService.id}`);
  assert.strictEqual(res.status, 404);
  const stillThere = await db.event.findUnique({ where: { id: nonService.id } });
  assert.ok(stillThere, 'non-service event must not be deleted via /api/attendance');
});

test('cross-tenant: church B cannot see, edit, or delete church A\'s service', async () => {
  const a = await newSignedInChurch('att-cross-a');
  const b = await newSignedInChurch('att-cross-b');
  const created = await a.client.post('/api/attendance', { title: 'A Only Service', startsAt: '2026-08-16T09:00' });
  const id = created.body.id;

  assert.strictEqual((await b.client.get(`/api/attendance/${id}`)).status, 404);
  assert.strictEqual((await b.client.put(`/api/attendance/${id}`, { title: 'Hijacked', startsAt: '2026-08-16T09:00' })).status, 404);
  assert.strictEqual((await b.client.del(`/api/attendance/${id}`)).status, 404);

  const stillThere = await a.client.get(`/api/attendance/${id}`);
  assert.strictEqual(stillThere.status, 200);
  assert.strictEqual(stillThere.body.title, 'A Only Service');
});

test('non-admin can read but not create/edit/delete', async () => {
  const { churchId } = await newSignedInChurch('att-rbac');
  const viewer = await addNonAdminUser(churchId, 'VIEWER');
  assert.strictEqual((await viewer.get('/api/attendance')).status, 200);
  assert.strictEqual((await viewer.post('/api/attendance', { title: 'Blocked', startsAt: '2026-08-20T09:00' })).status, 403);
});
