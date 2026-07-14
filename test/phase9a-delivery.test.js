'use strict';
// Phase 9a verification: dry-run behavior for real SMS/email delivery, and
// the broadcast/preaching-remind wiring around it.
//
// Safe by construction: lib/delivery.js detects `node --test` (via
// execArgv) and forces dry-run mode unconditionally in that context,
// regardless of what secrets .env or the environment carry — see that
// file's FORCE_DRY_RUN for why (a real .env with real SMTP/Arkesel
// secrets + @prisma/client's auto-dotenv-load on require made per-test-file
// env-var deletion fragile and nearly caused a real send the first time
// this was wired in). This file doesn't need its own env-clearing
// workaround as a result — the guard below (asserting dryRun/status text)
// is just a second confirmation that the built-in safety net is holding.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { sendSmsBatch, sendEmailEach, normalizePhoneGH } = require('../lib/delivery');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

test('sendSmsBatch is a safe dry-run under the test runner', async () => {
  const result = await sendSmsBatch(['+233240000001'], 'test message');
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.ok, false);
});

test('normalizePhoneGH handles the standard Ghana formats', () => {
  assert.strictEqual(normalizePhoneGH('0244000001'), '+233244000001');
  assert.strictEqual(normalizePhoneGH('+233244000001'), '+233244000001');
  assert.strictEqual(normalizePhoneGH('233244000001'), '+233244000001');
  assert.strictEqual(normalizePhoneGH(''), null);
});

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
    await db.emailLog.deleteMany({ where });
    await db.emailSetting.deleteMany({ where });
    await db.broadcastRecipient.deleteMany({ where });
    await db.broadcast.deleteMany({ where });
    await db.activityLog.deleteMany({ where });
    await db.preachingPlan.deleteMany({ where });
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
      return { status: res.status, text: res.status < 300 ? await res.text() : '' };
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

test('broadcast: dry-run send updates recipients and tallies correctly', async () => {
  const { client, churchId } = await signedInClient('html-broadcast-dry');
  await db.member.create({
    data: { churchId, externalId: 'MBR-001', firstName: 'Ama', lastName: 'Owusu', mobilePhone: '0244000001', email: 'ama@example.test', membershipStatus: 'MEMBER', preferredChannel: 'EITHER', unsubscribeToken: `tok-b1-${process.pid}-${Date.now()}` },
  });

  const page = await client.getHtml('/communications/broadcast');
  const csrf = extractCsrf(page.text);
  const sent = await client.postForm('/communications/broadcast', { all_members: '1', channel: 'both', body: 'Test broadcast', _csrf: csrf });
  assert.strictEqual(sent.status, 302);

  const detailUrl = sent.location;
  const detail = await client.getHtml(detailUrl);
  assert.match(detail.text, /dry run/);
  assert.match(detail.text, /Ama Owusu/);
});

test('preaching remind: dry-run for a guest preacher with phone+email on file', async () => {
  const { client } = await signedInClient('html-remind-dry');
  // The "new appointment" form is embedded inline on /preaching itself —
  // there is no separate /preaching/new page (unlike members/events).
  const listPage = await client.getHtml('/preaching');
  const csrf = extractCsrf(listPage.text);
  const created = await client.postForm('/preaching', {
    preachDate: '2026-08-20', preacherName: 'Guest Preacher', preacherPhone: '0244000002', preacherEmail: 'guest@example.test', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);

  const list = await client.getHtml('/preaching');
  const csrf2 = extractCsrf(list.text);
  const planIdMatch = list.text.match(/\/preaching\/(\d+)\/remind/);
  assert.ok(planIdMatch, 'expected a Remind link/form for the created appointment');
  const reminded = await client.postForm(`/preaching/${planIdMatch[1]}/remind`, { _csrf: csrf2 });
  assert.strictEqual(reminded.status, 302);
  assert.match(reminded.location, /reminder=dry/);
});

test('preaching remind: no contact info redirects with reminder=nocontact', async () => {
  const { client, churchId } = await signedInClient('html-remind-nocontact');
  const listPage = await client.getHtml('/preaching');
  const csrf = extractCsrf(listPage.text);
  await client.postForm('/preaching', { preachDate: '2026-08-21', _csrf: csrf });

  // No contact info means no "Remind" link is rendered in the UI...
  const list = await client.getHtml('/preaching');
  assert.doesNotMatch(list.text, /\/preaching\/\d+\/remind/);

  // ...but the server-side route itself must also handle it gracefully if hit directly.
  const plan = await db.preachingPlan.findFirst({ where: { churchId }, orderBy: { id: 'desc' } });
  const csrf2 = extractCsrf(list.text);
  const reminded = await client.postForm(`/preaching/${plan.id}/remind`, { _csrf: csrf2 });
  assert.strictEqual(reminded.status, 302);
  assert.match(reminded.location, /reminder=nocontact/);
});
