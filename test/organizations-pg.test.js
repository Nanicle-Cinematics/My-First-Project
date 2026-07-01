'use strict';
// Phase 2, module 4: routes-pg/organizations.js.
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
    await db.organizationMembership.deleteMany({ where });
    await db.organization.deleteMany({ where });
    await db.member.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
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

test('create an organization, add/remove members, set leader, roster reflects it', async () => {
  const { client, churchId } = await newSignedInChurch('org-crud');
  const m1 = await db.member.create({ data: { churchId, firstName: 'Kofi', lastName: 'Mensah' } });
  const m2 = await db.member.create({ data: { churchId, firstName: 'Ama', lastName: 'Boateng' } });

  const created = await client.post('/api/organizations', { name: 'Church Choir', meetsOn: 'Saturday 5pm' });
  assert.strictEqual(created.status, 201);
  const id = created.body.id;

  const add1 = await client.post(`/api/organizations/${id}/add`, { memberId: m1.id, role: 'leader' });
  assert.strictEqual(add1.status, 201);
  const add2 = await client.post(`/api/organizations/${id}/add`, { memberId: m2.id });
  assert.strictEqual(add2.status, 201);

  const dup = await client.post(`/api/organizations/${id}/add`, { memberId: m1.id });
  assert.strictEqual(dup.status, 409);

  const setLeader = await client.put(`/api/organizations/${id}/leader`, { leaderId: m1.id });
  assert.strictEqual(setLeader.status, 200);

  const detail = await client.get(`/api/organizations/${id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.members.length, 2);
  assert.strictEqual(detail.body.leader.id, m1.id);

  const list = await client.get('/api/organizations');
  const row = list.body.find((o) => o.id === id);
  assert.strictEqual(row.memberCount, 2);

  const removed = await client.post(`/api/organizations/${id}/remove`, { memberId: m2.id });
  assert.strictEqual(removed.status, 204);
  const detailAfterRemove = await client.get(`/api/organizations/${id}`);
  assert.strictEqual(detailAfterRemove.body.members.length, 1);
});

test('duplicate org name in same church -> 409; missing name -> 400; archive hides it', async () => {
  const { client } = await newSignedInChurch('org-validation');
  const noName = await client.post('/api/organizations', {});
  assert.strictEqual(noName.status, 400);

  const first = await client.post('/api/organizations', { name: 'Ushers' });
  assert.strictEqual(first.status, 201);
  const dup = await client.post('/api/organizations', { name: 'Ushers' });
  assert.strictEqual(dup.status, 409);

  const archived = await client.post(`/api/organizations/${first.body.id}/archive`);
  assert.strictEqual(archived.status, 204);
  const list = await client.get('/api/organizations');
  assert.ok(!list.body.some((o) => o.id === first.body.id));
});

test('cross-tenant: church B cannot see, join, or modify church A\'s organization', async () => {
  const a = await newSignedInChurch('org-cross-a');
  const b = await newSignedInChurch('org-cross-b');
  const created = await a.client.post('/api/organizations', { name: 'A Only Org' });
  const id = created.body.id;
  const bMember = await db.member.create({ data: { churchId: b.churchId, firstName: 'B', lastName: 'Member' } });

  assert.strictEqual((await b.client.get(`/api/organizations/${id}`)).status, 404);
  assert.strictEqual((await b.client.post(`/api/organizations/${id}/add`, { memberId: bMember.id })).status, 404);
  assert.strictEqual((await b.client.put(`/api/organizations/${id}/leader`, { leaderId: bMember.id })).status, 404);

  const stillThere = await a.client.get(`/api/organizations/${id}`);
  assert.strictEqual(stillThere.status, 200);
});

test('non-admin can read but not create/manage', async () => {
  const { churchId } = await newSignedInChurch('org-rbac');
  const viewer = await addNonAdminUser(churchId, 'VIEWER');
  assert.strictEqual((await viewer.get('/api/organizations')).status, 200);
  assert.strictEqual((await viewer.post('/api/organizations', { name: 'Blocked' })).status, 403);
});
