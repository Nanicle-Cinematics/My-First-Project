'use strict';
// Phase 8a verification: the HTML view layer (routes-pg-html/preaching.js)
// on top of lib/tenant-http.js — the thin automated backstop the Phase 8
// plan calls for (wiring/auth-gate/CSRF regressions), NOT a substitute for
// the required manual browser click-through. Same fetch()-based cookie
// client pattern as test/tenant-auth.test.js, extended to read HTML bodies
// and follow/inspect redirects instead of JSON.
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
    await db.preachingPlan.deleteMany({ where });
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
    async getJson(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {} });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async postJson(p, jsonBody) {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(jsonBody),
      });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async getHtml(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: res.status < 300 ? await res.text() : '' };
    },
    async postForm(p, form) {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
      });
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

test('unauthenticated GET /preaching redirects to /login', async () => {
  const client = htmlClient();
  const res = await client.getHtml('/preaching');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.location, '/login');
});

test('signed-in user sees the preaching page, CSRF token is present and required, and can schedule/archive an appointment', async () => {
  const client = htmlClient();
  const signup = await client.postJson('/signup', {
    churchName: 'HTML Test Church', name: 'Admin Person', email: uniqueEmail('html-preaching'), password: 'password123',
  });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);

  const page = await client.getHtml('/preaching');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Preaching Plan/);
  const csrf = extractCsrf(page.text);
  assert.ok(csrf, 'expected a CSRF token embedded in the rendered form');

  // POST without a CSRF token must be rejected.
  const rejected = await client.postForm('/preaching', { preachDate: '2026-09-01' });
  assert.strictEqual(rejected.status, 403);

  // POST with a valid CSRF token succeeds and the appointment shows up.
  const created = await client.postForm('/preaching', {
    preachDate: '2026-08-15', serviceLabel: 'Sunday 9am', preacherName: 'Guest Preacher', topic: 'Faith', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);
  assert.strictEqual(created.location, '/preaching');

  const afterCreate = await client.getHtml('/preaching');
  assert.match(afterCreate.text, /Guest Preacher/);

  // Archive it via the edit page's plan id, then confirm it's gone from the list.
  const planIdMatch = afterCreate.text.match(/\/preaching\/(\d+)\/edit/);
  assert.ok(planIdMatch, 'expected an edit link for the created appointment');
  const csrf2 = extractCsrf(afterCreate.text);
  const archived = await client.postForm(`/preaching/${planIdMatch[1]}/delete`, { _csrf: csrf2 });
  assert.strictEqual(archived.status, 302);

  const afterArchive = await client.getHtml('/preaching');
  assert.doesNotMatch(afterArchive.text, /Guest Preacher/);
});
