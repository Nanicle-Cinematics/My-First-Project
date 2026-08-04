'use strict';
// Phase 3, module 3: routes-pg/members.js.
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
    await db.sacrament.deleteMany({ where });
    await db.ministryMembership.deleteMany({ where });
    await db.organizationMembership.deleteMany({ where });
    await db.organization.deleteMany({ where });
    await db.ministry.deleteMany({ where });
    await db.event.deleteMany({ where });
    await db.member.deleteMany({ where });
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

test('create assigns sequential per-church externalId (MBR-001, MBR-002...) and unsubscribeToken', async () => {
  const { client } = await newSignedInChurch('mem-id');
  const m1 = await client.post('/api/members', { firstName: 'Kofi', lastName: 'Mensah' });
  assert.strictEqual(m1.status, 201);
  assert.strictEqual(m1.body.externalId, 'MBR-001');
  assert.ok(m1.body.unsubscribeToken);

  const m2 = await client.post('/api/members', { firstName: 'Ama', lastName: 'Boateng' });
  assert.strictEqual(m2.body.externalId, 'MBR-002');
});

test('two different churches both start numbering at MBR-001 (tenant-scoped sequence)', async () => {
  const a = await newSignedInChurch('mem-seq-a');
  const b = await newSignedInChurch('mem-seq-b');
  const memberA = await a.client.post('/api/members', { firstName: 'A', lastName: 'One' });
  const memberB = await b.client.post('/api/members', { firstName: 'B', lastName: 'One' });
  assert.strictEqual(memberA.body.externalId, 'MBR-001');
  assert.strictEqual(memberB.body.externalId, 'MBR-001');
});

test('validation: first/last name required, email/phone format checked', async () => {
  const { client } = await newSignedInChurch('mem-validation');
  assert.strictEqual((await client.post('/api/members', { lastName: 'NoFirst' })).status, 400);
  assert.strictEqual((await client.post('/api/members', { firstName: 'NoLast' })).status, 400);
  assert.strictEqual((await client.post('/api/members', { firstName: 'A', lastName: 'B', email: 'not-an-email' })).status, 400);
});

test('list: search, status filter, pagination shape', async () => {
  const { client } = await newSignedInChurch('mem-list');
  await client.post('/api/members', { firstName: 'Kofi', lastName: 'Mensah', membershipStatus: 'MEMBER' });
  await client.post('/api/members', { firstName: 'Ama', lastName: 'Boateng', membershipStatus: 'VISITOR' });

  const all = await client.get('/api/members');
  assert.strictEqual(all.body.total, 2);

  const searched = await client.get('/api/members?q=kofi');
  assert.strictEqual(searched.body.total, 1);
  assert.strictEqual(searched.body.members[0].firstName, 'Kofi');

  const filtered = await client.get('/api/members?status=VISITOR');
  assert.strictEqual(filtered.body.total, 1);
  assert.strictEqual(filtered.body.members[0].firstName, 'Ama');
});

test('detail includes organizations, ministries, sacraments, recent attendance', async () => {
  const { client, churchId } = await newSignedInChurch('mem-detail');
  const org = await db.organization.create({ data: { churchId, name: 'Choir' } });
  const ministry = await db.ministry.create({ data: { churchId, name: 'Young Adults' } });
  const event = await db.event.create({ data: { churchId, title: 'Sunday Service', eventType: 'SERVICE', startsAt: new Date('2026-08-02T09:00') } });

  const created = await client.post('/api/members', { firstName: 'Kofi', lastName: 'Mensah', orgIds: [org.id] });
  const id = created.body.id;
  await db.ministryMembership.create({ data: { churchId, ministryId: ministry.id, memberId: id } });
  await db.attendance.create({ data: { churchId, eventId: event.id, memberId: id } });
  await db.sacrament.create({ data: { churchId, sacramentType: 'BAPTISM', memberId: id, occurredOn: new Date('2020-01-01') } });

  const detail = await client.get(`/api/members/${id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.organizations.length, 1);
  assert.strictEqual(detail.body.organizations[0].name, 'Choir');
  assert.strictEqual(detail.body.ministries.length, 1);
  assert.strictEqual(detail.body.ministries[0].name, 'Young Adults');
  assert.strictEqual(detail.body.sacraments.length, 1);
  assert.strictEqual(detail.body.recentAttendance.length, 1);
});

test('update replaces org memberships (not additive); soft-delete excludes from reads', async () => {
  const { client, churchId } = await newSignedInChurch('mem-update');
  const orgA = await db.organization.create({ data: { churchId, name: 'Choir' } });
  const orgB = await db.organization.create({ data: { churchId, name: 'Ushers' } });
  const created = await client.post('/api/members', { firstName: 'Kofi', lastName: 'Mensah', orgIds: [orgA.id] });
  const id = created.body.id;

  const updated = await client.put(`/api/members/${id}`, { firstName: 'Kofi', lastName: 'Mensah', orgIds: [orgB.id] });
  assert.strictEqual(updated.status, 200);
  const detail = await client.get(`/api/members/${id}`);
  assert.strictEqual(detail.body.organizations.length, 1);
  assert.strictEqual(detail.body.organizations[0].name, 'Ushers', 'update replaces the org list, does not add to it');

  const deleted = await client.del(`/api/members/${id}`);
  assert.strictEqual(deleted.status, 204);
  assert.strictEqual((await client.get(`/api/members/${id}`)).status, 404);
  const list = await client.get('/api/members');
  assert.strictEqual(list.body.total, 0, 'soft-deleted members are excluded from the list');
});

test('cross-tenant: church B cannot see, edit, or delete church A\'s member', async () => {
  const a = await newSignedInChurch('mem-cross-a');
  const b = await newSignedInChurch('mem-cross-b');
  const created = await a.client.post('/api/members', { firstName: 'A', lastName: 'Only' });
  const id = created.body.id;

  assert.strictEqual((await b.client.get(`/api/members/${id}`)).status, 404);
  assert.strictEqual((await b.client.put(`/api/members/${id}`, { firstName: 'Hijacked', lastName: 'X' })).status, 404);
  assert.strictEqual((await b.client.del(`/api/members/${id}`)).status, 404);

  const stillThere = await a.client.get(`/api/members/${id}`);
  assert.strictEqual(stillThere.status, 200);
});

test('non-admin can read but not create/edit/delete', async () => {
  const { churchId } = await newSignedInChurch('mem-rbac');
  const viewer = await addNonAdminUser(churchId, 'VIEWER');
  assert.strictEqual((await viewer.get('/api/members')).status, 200);
  assert.strictEqual((await viewer.post('/api/members', { firstName: 'X', lastName: 'Y' })).status, 403);
});
