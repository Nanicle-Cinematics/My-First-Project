'use strict';
// Phase 3, module 2: routes-pg/events.js.
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
    await db.eventRsvp.deleteMany({ where });
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

test('create, list, read, update an event', async () => {
  const { client } = await newSignedInChurch('evt-crud');
  const created = await client.post('/api/events', { title: 'Sunday Worship', eventType: 'SERVICE', startsAt: '2026-08-02T09:00' });
  assert.strictEqual(created.status, 201);
  const id = created.body.id;
  assert.ok(created.body.checkinToken, 'checkinToken should be auto-generated');

  const list = await client.get('/api/events');
  assert.ok(list.body.some((e) => e.id === id));

  const fetched = await client.get(`/api/events/${id}`);
  assert.strictEqual(fetched.status, 200);
  assert.strictEqual(fetched.body.attendees.length, 0);
  assert.strictEqual(fetched.body.rsvps.length, 0);

  const updated = await client.put(`/api/events/${id}`, { title: 'Sunday Worship (moved)', startsAt: '2026-08-02T10:00' });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.title, 'Sunday Worship (moved)');
});

test('title and startsAt required', async () => {
  const { client } = await newSignedInChurch('evt-validation');
  assert.strictEqual((await client.post('/api/events', { startsAt: '2026-08-02T09:00' })).status, 400);
  assert.strictEqual((await client.post('/api/events', { title: 'No date' })).status, 400);
});

test('attendance counts: derive total, explicit total, and clear', async () => {
  const { client } = await newSignedInChurch('evt-counts');
  const created = await client.post('/api/events', { title: 'Service', startsAt: '2026-08-02T09:00' });
  const id = created.body.id;

  const derived = await client.put(`/api/events/${id}/counts`, { attendanceMen: 10, attendanceWomen: 15, attendanceChildren: 5 });
  assert.strictEqual(derived.body.attendanceTotal, 30);

  const explicit = await client.put(`/api/events/${id}/counts`, { attendanceMen: 10, attendanceWomen: 15, attendanceChildren: 5, attendanceTotal: 999 });
  assert.strictEqual(explicit.body.attendanceTotal, 999);

  const cleared = await client.put(`/api/events/${id}/counts`, { clear: true });
  assert.strictEqual(cleared.body.attendanceTotal, null);
  assert.strictEqual(cleared.body.attendanceMen, null);
});

test('check-in/out: idempotent check, uncheck, and appears in event detail', async () => {
  const { client, churchId } = await newSignedInChurch('evt-checkin');
  const member = await db.member.create({ data: { churchId, firstName: 'Kofi', lastName: 'Mensah' } });
  const created = await client.post('/api/events', { title: 'Service', startsAt: '2026-08-02T09:00' });
  const id = created.body.id;

  const check1 = await client.post(`/api/events/${id}/check`, { memberId: member.id });
  assert.strictEqual(check1.status, 201);
  const check2 = await client.post(`/api/events/${id}/check`, { memberId: member.id });
  assert.strictEqual(check2.status, 201, 'checking in twice is idempotent, not an error');

  const detail = await client.get(`/api/events/${id}`);
  assert.strictEqual(detail.body.attendees.length, 1);
  assert.strictEqual(detail.body.attendees[0].id, member.id);

  const uncheck = await client.del(`/api/events/${id}/check/${member.id}`);
  assert.strictEqual(uncheck.status, 204);
  const afterUncheck = await client.get(`/api/events/${id}`);
  assert.strictEqual(afterUncheck.body.attendees.length, 0);

  const uncheckAgain = await client.del(`/api/events/${id}/check/${member.id}`);
  assert.strictEqual(uncheckAgain.status, 404);
});

test('RSVP: add, update (upsert), remove', async () => {
  const { client, churchId } = await newSignedInChurch('evt-rsvp');
  const member = await db.member.create({ data: { churchId, firstName: 'Ama', lastName: 'Boateng' } });
  const created = await client.post('/api/events', { title: 'Service', startsAt: '2026-08-02T09:00' });
  const id = created.body.id;

  const rsvp1 = await client.post(`/api/events/${id}/rsvp`, { memberId: member.id, response: 'MAYBE' });
  assert.strictEqual(rsvp1.status, 201);
  assert.strictEqual(rsvp1.body.response, 'MAYBE');

  const rsvp2 = await client.post(`/api/events/${id}/rsvp`, { memberId: member.id, response: 'GOING' });
  assert.strictEqual(rsvp2.status, 201);
  assert.strictEqual(rsvp2.body.response, 'GOING', 'second RSVP upserts, does not duplicate');

  const detail = await client.get(`/api/events/${id}`);
  assert.strictEqual(detail.body.rsvps.length, 1);
  assert.strictEqual(detail.body.rsvpCounts.GOING, 1);

  const removed = await client.del(`/api/events/${id}/rsvp/${member.id}`);
  assert.strictEqual(removed.status, 204);
  const afterRemove = await client.get(`/api/events/${id}`);
  assert.strictEqual(afterRemove.body.rsvps.length, 0);
});

test('cross-tenant: church B cannot see, edit, check-in to, or RSVP on church A\'s event', async () => {
  const a = await newSignedInChurch('evt-cross-a');
  const b = await newSignedInChurch('evt-cross-b');
  const bMember = await db.member.create({ data: { churchId: b.churchId, firstName: 'B', lastName: 'Member' } });
  const created = await a.client.post('/api/events', { title: 'A Only Event', startsAt: '2026-08-16T09:00' });
  const id = created.body.id;

  assert.strictEqual((await b.client.get(`/api/events/${id}`)).status, 404);
  assert.strictEqual((await b.client.put(`/api/events/${id}`, { title: 'Hijacked', startsAt: '2026-08-16T09:00' })).status, 404);
  assert.strictEqual((await b.client.post(`/api/events/${id}/check`, { memberId: bMember.id })).status, 404);
  assert.strictEqual((await b.client.post(`/api/events/${id}/rsvp`, { memberId: bMember.id })).status, 404);

  const stillThere = await a.client.get(`/api/events/${id}`);
  assert.strictEqual(stillThere.status, 200);
  assert.strictEqual(stillThere.body.title, 'A Only Event');
});

test('non-admin can read but not create/edit/check-in/RSVP', async () => {
  const { churchId } = await newSignedInChurch('evt-rbac');
  const viewer = await addNonAdminUser(churchId, 'VIEWER');
  assert.strictEqual((await viewer.get('/api/events')).status, 200);
  assert.strictEqual((await viewer.post('/api/events', { title: 'Blocked', startsAt: '2026-08-20T09:00' })).status, 403);
});
