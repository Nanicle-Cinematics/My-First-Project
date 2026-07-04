'use strict';
// Phase 8c verification: thin HTTP smoke tests for the three new HTML
// modules (attendance, communications, events) — same pattern as
// test/preaching-html.test.js / test/phase8b-html.test.js.
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
    await db.broadcastRecipient.deleteMany({ where });
    await db.broadcast.deleteMany({ where });
    await db.emailSetting.deleteMany({ where });
    await db.announcement.deleteMany({ where });
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

function htmlClient() {
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
      return { status: res.status, location: res.headers.get('location'), text: res.status < 300 ? await res.text() : '' };
    },
    async postForm(p, form) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form).toString(), redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}
function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  return m ? m[1] : null;
}
async function signedInClient(tag) {
  const client = htmlClient();
  const signup = await client.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'password123' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return { client, churchId: signup.body.church.id };
}

for (const [path, title] of [['/attendance', 'Attendance'], ['/communications', 'Communications'], ['/events', 'Events']]) {
  test(`unauthenticated GET ${path} redirects to /login`, async () => {
    const client = htmlClient();
    const res = await client.getHtml(path);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.location, '/login');
  });

  test(`signed-in GET ${path} renders 200 with a CSRF token and the right title`, async () => {
    const { client } = await signedInClient(`html-smoke-${path.replace('/', '')}`);
    const res = await client.getHtml(path);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, new RegExp(title));
    assert.ok(extractCsrf(res.text), 'expected a CSRF token embedded in the rendered page');
  });
}

test('attendance: create a service without CSRF is rejected, with CSRF succeeds, edit it, then delete it', async () => {
  const { client } = await signedInClient('html-att-create');
  const newPage = await client.getHtml('/attendance/new');
  const csrf = extractCsrf(newPage.text);

  const rejected = await client.postForm('/attendance', { title: 'No CSRF Service', startsAt: '2026-08-15T09:00' });
  assert.strictEqual(rejected.status, 403);

  const created = await client.postForm('/attendance', { title: 'Sunday Worship', startsAt: '2026-08-16T09:00', attendanceMen: '10', attendanceWomen: '15' });
  assert.strictEqual(created.status, 403); // still no csrf on this one
  const created2 = await client.postForm('/attendance', { title: 'Sunday Worship', startsAt: '2026-08-16T09:00', attendanceMen: '10', attendanceWomen: '15', _csrf: csrf });
  assert.strictEqual(created2.status, 302);

  const list = await client.getHtml('/attendance');
  assert.match(list.text, /Sunday Worship/);
  const editUrlMatch = list.text.match(/\/attendance\/(\d+)\/edit/);
  assert.ok(editUrlMatch, 'expected an edit link for the created service');

  const editPage = await client.getHtml(`/attendance/${editUrlMatch[1]}/edit`);
  assert.strictEqual(editPage.status, 200);
  const csrf2 = extractCsrf(editPage.text);
  const deleted = await client.postForm(`/attendance/${editUrlMatch[1]}/delete`, { _csrf: csrf2 });
  assert.strictEqual(deleted.status, 302);
  const afterDelete = await client.getHtml('/attendance');
  assert.doesNotMatch(afterDelete.text, /Sunday Worship/);
});

test('communications: post an announcement, then load broadcast composer', async () => {
  const { client } = await signedInClient('html-comm-create');
  const page = await client.getHtml('/communications');
  const csrf = extractCsrf(page.text);

  const created = await client.postForm('/communications', { title: 'Notice', body: 'Choir practice moved', _csrf: csrf });
  assert.strictEqual(created.status, 302);
  const after = await client.getHtml('/communications');
  assert.match(after.text, /Notice/);
  assert.match(after.text, /Choir practice moved/);

  const composer = await client.getHtml('/communications/broadcast');
  assert.strictEqual(composer.status, 200);
  assert.match(composer.text, /Audience/);
});

test('events: create an event, view detail, check in a member, then RSVP', async () => {
  const { client, churchId } = await signedInClient('html-evt-create');
  const member = await db.member.create({
    data: { churchId, externalId: 'MBR-EVT-1', firstName: 'Kofi', lastName: 'Mensah', membershipStatus: 'MEMBER', unsubscribeToken: 'tok-evt-1' },
  });

  const newPage = await client.getHtml('/events/new');
  const csrf = extractCsrf(newPage.text);
  const created = await client.postForm('/events', { title: 'Youth Camp', startsAt: '2026-09-01T08:00', _csrf: csrf });
  assert.strictEqual(created.status, 302);
  assert.match(created.location, /\/events\/\d+/);
  const eventId = created.location.match(/\/events\/(\d+)/)[1];

  const detail = await client.getHtml(`/events/${eventId}`);
  assert.strictEqual(detail.status, 200);
  assert.match(detail.text, /Youth Camp/);
  const csrf2 = extractCsrf(detail.text);

  const checkedIn = await client.postForm(`/events/${eventId}/check`, { memberId: String(member.id), _csrf: csrf2 });
  assert.strictEqual(checkedIn.status, 302);
  const afterCheck = await client.getHtml(`/events/${eventId}`);
  assert.match(afterCheck.text, /Kofi Mensah/);

  const csrf3 = extractCsrf(afterCheck.text);
  const rsvped = await client.postForm(`/events/${eventId}/rsvp`, { memberId: String(member.id), response: 'GOING', _csrf: csrf3 });
  assert.strictEqual(rsvped.status, 302);
  const afterRsvp = await client.getHtml(`/events/${eventId}`);
  assert.match(afterRsvp.text, /Going/);
});
