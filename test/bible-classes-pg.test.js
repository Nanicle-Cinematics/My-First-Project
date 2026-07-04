'use strict';
// Phase 2, module 2: routes-pg/bible-classes.js.
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
    await db.member.updateMany({ where, data: { bibleClassId: null } });
    await db.ministry.deleteMany({ where });
    await db.member.deleteMany({ where });
    await db.organization.deleteMany({ where });
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

test('create, list (with search + member count), and update leader/org', async () => {
  const { client, churchId } = await newSignedInChurch('bc-crud');

  const org = await db.organization.create({ data: { churchId, name: 'Youth Ministry' } });
  const leader = await db.member.create({ data: { churchId, firstName: 'Kofi', lastName: 'Mensah' } });

  const created = await client.post('/api/bible-classes', { name: 'Young Adults', meetsOn: 'Sunday 8am' });
  assert.strictEqual(created.status, 201);
  const id = created.body.id;

  await db.member.create({ data: { churchId, firstName: 'Ama', lastName: 'Boateng', bibleClassId: id } });

  const list = await client.get('/api/bible-classes');
  assert.strictEqual(list.status, 200);
  const row = list.body.find((r) => r.id === id);
  assert.strictEqual(row.memberCount, 1);
  assert.strictEqual(row.leader, null);

  const searched = await client.get('/api/bible-classes?q=young');
  assert.strictEqual(searched.body.length, 1);
  const noMatch = await client.get('/api/bible-classes?q=nonexistent');
  assert.strictEqual(noMatch.body.length, 0);

  const updated = await client.put(`/api/bible-classes/${id}`, { leaderId: leader.id, orgId: org.id });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.leaderId, leader.id);
  assert.strictEqual(updated.body.orgId, org.id);
});

test('missing name is rejected; duplicate name in the same church is rejected (409)', async () => {
  const { client } = await newSignedInChurch('bc-validation');
  const noName = await client.post('/api/bible-classes', {});
  assert.strictEqual(noName.status, 400);

  const first = await client.post('/api/bible-classes', { name: 'Same Name' });
  assert.strictEqual(first.status, 201);
  const dup = await client.post('/api/bible-classes', { name: 'Same Name' });
  assert.strictEqual(dup.status, 409);
});

test('two churches CAN each have a class with the same name (tenant-scoped uniqueness)', async () => {
  const a = await newSignedInChurch('bc-uniq-a');
  const b = await newSignedInChurch('bc-uniq-b');
  const createdA = await a.client.post('/api/bible-classes', { name: 'Youth Class' });
  const createdB = await b.client.post('/api/bible-classes', { name: 'Youth Class' });
  assert.strictEqual(createdA.status, 201);
  assert.strictEqual(createdB.status, 201);
});

test('cross-tenant: church B cannot see or edit church A\'s class', async () => {
  const a = await newSignedInChurch('bc-cross-a');
  const b = await newSignedInChurch('bc-cross-b');
  const created = await a.client.post('/api/bible-classes', { name: 'A Only Class' });
  const id = created.body.id;

  const listByB = await b.client.get('/api/bible-classes');
  assert.ok(!listByB.body.some((r) => r.id === id));

  const editByB = await b.client.put(`/api/bible-classes/${id}`, { leaderId: null });
  assert.strictEqual(editByB.status, 404);
});

test('non-admin can read but not create/edit', async () => {
  const { churchId } = await newSignedInChurch('bc-rbac');
  const viewer = await addNonAdminUser(churchId, 'VIEWER');

  const read = await viewer.get('/api/bible-classes');
  assert.strictEqual(read.status, 200);

  const write = await viewer.post('/api/bible-classes', { name: 'Should be blocked' });
  assert.strictEqual(write.status, 403);
});
