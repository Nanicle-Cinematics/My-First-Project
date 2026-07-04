'use strict';
// Phase 9b verification: public token-based check-in/RSVP + admin QR page.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
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
    await db.activityLog.deleteMany({ where });
    await db.eventRsvp.deleteMany({ where });
    await db.attendance.deleteMany({ where });
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

function client() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async postJson(p, jsonBody) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(jsonBody) });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async getHtml(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, text: res.status < 300 || res.status === 404 ? await res.text() : '' };
    },
    async postForm(p, form) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form).toString(), redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: res.status < 300 ? '' : await res.text() };
    },
  };
}
// A fresh fetch with no cookies at all — simulates a first-time anonymous
// visitor scanning a QR code (no prior session on this device).
async function anonGet(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return { status: res.status, text: await res.text() };
}
async function anonPostForm(path, form) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}
async function signedInChurch(tag) {
  const c = client();
  const signup = await c.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'password123' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return { client: c, churchId: signup.body.church.id };
}

test('QR page: generates a checkin token lazily and renders an SVG QR', async () => {
  const { client: c } = await signedInChurch('qr-gen');
  const listPage = await c.getHtml('/events');
  const csrf = listPage.text.match(/name="_csrf" value="([^"]*)"/)[1];
  const created = await c.postForm('/events', { title: 'Sunday Service', eventType: 'SERVICE', startsAt: '2026-08-02T09:00', _csrf: csrf });
  assert.strictEqual(created.status, 302);
  const eventId = created.location.match(/\/events\/(\d+)/)[1];

  const qrPage = await c.getHtml(`/events/${eventId}/qr`);
  assert.strictEqual(qrPage.status, 200);
  assert.match(qrPage.text, /<svg/);

  const detail = await c.getHtml(`/events/${eventId}`);
  const tokenMatch = detail.text.match(/\/checkin\/([a-f0-9]{32})/);
  assert.ok(tokenMatch, 'expected a checkin token link on the event detail page');
});

test('public check-in: single search match auto-confirms, records attendance, no session required', async () => {
  const { client: c, churchId } = await signedInChurch('checkin-auto');
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-101', firstName: 'Kwame', lastName: 'Asante', membershipStatus: 'MEMBER' } });
  const listPage = await c.getHtml('/events');
  const csrf = listPage.text.match(/name="_csrf" value="([^"]*)"/)[1];
  const created = await c.postForm('/events', { title: 'Bible Study', eventType: 'BIBLE_STUDY', startsAt: '2026-08-03T18:00', _csrf: csrf });
  const eventId = created.location.match(/\/events\/(\d+)/)[1];
  const ev = await db.event.findUnique({ where: { id: Number(eventId) } });

  const checkinPage = await anonGet(`/checkin/${ev.checkinToken}`);
  assert.strictEqual(checkinPage.status, 200);
  assert.match(checkinPage.text, /Your name or Member ID/);

  const res = await fetch(base + `/checkin/${ev.checkinToken}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: 'Kwame Asante' }).toString() });
  const text = await res.text();
  assert.strictEqual(res.status, 200);
  assert.match(text, /Checked in, Kwame/);

  const attendance = await db.attendance.findUnique({ where: { eventId_memberId: { eventId: Number(eventId), memberId: member.id } } });
  assert.ok(attendance, 'expected an Attendance row to have been created');
});

test('public check-in: unknown token returns a graceful 404, not a crash', async () => {
  const page = await anonGet('/checkin/deadbeefdeadbeefdeadbeefdeadbeef');
  assert.strictEqual(page.status, 404);
  assert.match(page.text, /not recognized/i);
});

test('public RSVP: GET shows the form, POST records the response', async () => {
  const { client: c, churchId } = await signedInChurch('rsvp-flow');
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-201', firstName: 'Abena', lastName: 'Osei', membershipStatus: 'MEMBER' } });
  const listPage = await c.getHtml('/events');
  const csrf = listPage.text.match(/name="_csrf" value="([^"]*)"/)[1];
  const created = await c.postForm('/events', { title: 'Youth Camp', eventType: 'YOUTH', startsAt: '2026-08-10T09:00', _csrf: csrf });
  const eventId = created.location.match(/\/events\/(\d+)/)[1];
  const ev = await db.event.findUnique({ where: { id: Number(eventId) } });

  const rsvpPage = await anonGet(`/rsvp/${ev.checkinToken}`);
  assert.strictEqual(rsvpPage.status, 200);
  assert.match(rsvpPage.text, /Abena Osei/);

  const posted = await anonPostForm(`/rsvp/${ev.checkinToken}`, { memberId: String(member.id), response: 'GOING' });
  assert.strictEqual(posted.status, 302);
  assert.match(posted.location, /ok=1/);

  const rsvp = await db.eventRsvp.findUnique({ where: { eventId_memberId: { eventId: Number(eventId), memberId: member.id } } });
  assert.strictEqual(rsvp.response, 'GOING');
});

test('cross-tenant: church A\'s checkin token never surfaces church B\'s members', async () => {
  const { client: cA, churchId: churchA } = await signedInChurch('cross-checkin-a');
  const { churchId: churchB } = await signedInChurch('cross-checkin-b');
  await db.member.create({ data: { churchId: churchA, externalId: 'MBR-A1', firstName: 'Shared', lastName: 'Name', membershipStatus: 'MEMBER' } });
  await db.member.create({ data: { churchId: churchB, externalId: 'MBR-B1', firstName: 'Shared', lastName: 'Name', membershipStatus: 'MEMBER' } });

  const listPage = await cA.getHtml('/events');
  const csrf = listPage.text.match(/name="_csrf" value="([^"]*)"/)[1];
  const created = await cA.postForm('/events', { title: 'Church A Service', eventType: 'SERVICE', startsAt: '2026-08-05T09:00', _csrf: csrf });
  const eventId = created.location.match(/\/events\/(\d+)/)[1];
  const ev = await db.event.findUnique({ where: { id: Number(eventId) } });
  assert.strictEqual(ev.churchId, churchA);

  const res = await fetch(base + `/checkin/${ev.checkinToken}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: 'Shared Name' }).toString() });
  const text = await res.text();
  // Exactly one "Shared Name" should appear as checked-in (church A's), never both/church B's.
  assert.strictEqual(res.status, 200);
  assert.match(text, /Checked in, Shared/);

  const attendanceB = await db.attendance.findMany({ where: { churchId: churchB } });
  assert.strictEqual(attendanceB.length, 0, 'church B must have zero attendance rows from church A\'s check-in link');
});
