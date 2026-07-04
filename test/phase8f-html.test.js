'use strict';
// Phase 8f verification: thin HTTP smoke tests for the landing page,
// authenticated dashboard, and forgot-password flow — same pattern as the
// earlier phase8*-html.test.js files.
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
    await db.passwordResetToken.deleteMany({ where });
    await db.emailVerificationToken.deleteMany({ where });
    await db.emailLog.deleteMany({ where });
    await db.financeReceipt.deleteMany({ where });
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.incomeRecord.deleteMany({ where });
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
    async postFormText(p, form) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form).toString() });
      remember(res);
      return res.text();
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
  const email = uniqueEmail(tag);
  const signup = await client.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email, password: 'password123' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return { client, churchId: signup.body.church.id, email };
}

test('GET / unauthenticated shows the landing page, not a redirect', async () => {
  const client = htmlClient();
  const res = await client.getHtml('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Run your church like a pro/);
});

test('GET / authenticated shows the dashboard, aggregating live data', async () => {
  const { client, churchId } = await signedInClient('html-dash');
  const dashboard = await client.getHtml('/');
  assert.strictEqual(dashboard.status, 200);
  assert.match(dashboard.text, /Dashboard/);
  assert.match(dashboard.text, /Upcoming events/);

  const csrf = extractCsrf(dashboard.text);
  const created = await client.postForm('/events', { title: 'Dashboard Smoke Event', startsAt: '2026-09-01T09:00', _csrf: csrf });
  assert.strictEqual(created.status, 302);

  const after = await client.getHtml('/');
  assert.match(after.text, /Dashboard Smoke Event/);
});

test('forgot-password: real link works end to end, non-matching email shows no link, token is single-use', async () => {
  const { email } = await signedInClient('html-forgot');
  // Use a fresh unauthenticated client for the actual forgot-password flow.
  const forgotClient = htmlClient();
  const forgotPage = await forgotClient.getHtml('/forgot');
  const csrf = extractCsrf(forgotPage.text);

  const nonMatchText = await forgotClient.postFormText('/forgot', { email: uniqueEmail('no-such-account'), _csrf: csrf });
  assert.doesNotMatch(nonMatchText, /reset-password\//, 'non-matching email must not reveal a reset link');

  const matchText = await forgotClient.postFormText('/forgot', { email, _csrf: csrf });
  assert.doesNotMatch(matchText, /reset-password\//, 'reset links must never be exposed in the response');
  const user = await db.user.findUnique({ where: { email } });
  const resetToken = await db.passwordResetToken.findFirst({ where: { userId: user.id, usedAt: null }, orderBy: { createdAt: 'desc' } });
  assert.ok(resetToken, 'matching email must create a reset token for email delivery');
  const resetPath = `/reset-password/${resetToken.token}`;

  const resetPage = await forgotClient.getHtml(resetPath);
  assert.strictEqual(resetPage.status, 200);
  assert.match(resetPage.text, /New password/);
  const csrf3 = extractCsrf(resetPage.text);

  const reset = await forgotClient.postForm(resetPath, { password: 'brandnewpass123', password2: 'brandnewpass123', _csrf: csrf3 });
  assert.strictEqual(reset.status, 302);
  assert.strictEqual(reset.location, '/login');

  // Check while still unauthenticated — a logged-in session redirects away
  // from /reset-password/:token before reaching the token-validity check.
  const reusedReset = await forgotClient.getHtml(resetPath);
  assert.match(reusedReset.text, /invalid or has expired/);

  const oldLogin = await forgotClient.postJson('/login', { email, password: 'password123' });
  assert.strictEqual(oldLogin.status, 401);
  const newLogin = await forgotClient.postJson('/login', { email, password: 'brandnewpass123' });
  assert.strictEqual(newLogin.status, 200);
});
