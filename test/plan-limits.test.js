'use strict';
// Plan limits are enforced, not just displayed.
//
// PLAN_LIMITS declared Free = 2 users / no reports for a long time while
// nothing consulted it, so the two tiers behaved identically. These tests pin
// the enforcement so it cannot quietly lapse back to decoration.
//
// The pure-logic cases need no database. The HTTP cases do, and follow the
// same signup-per-test shape as the rest of the suite.

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const { canAddUser, canUseReports, planFor, isPro } = require('../lib/plan');

// ---------- rules, without a server ----------

test('a church with no plan is Free', () => {
  assert.strictEqual(isPro({ plan: 'free' }), false);
  assert.strictEqual(planFor({ plan: 'free' }).label, 'Free');
});

test('Pro without an expiry never lapses; Pro with a past expiry does', () => {
  assert.strictEqual(isPro({ plan: 'pro', proUntil: null }), true);
  const future = new Date(Date.now() + 86400000);
  const past = new Date(Date.now() - 86400000);
  assert.strictEqual(isPro({ plan: 'pro', proUntil: future }), true);
  assert.strictEqual(isPro({ plan: 'pro', proUntil: past }), false);
});

test('Free stops at its seat limit; Pro is unlimited', () => {
  const free = { plan: 'free' };
  assert.strictEqual(canAddUser(free, 0), true);
  assert.strictEqual(canAddUser(free, 1), true);
  assert.strictEqual(canAddUser(free, 2), false);
  assert.strictEqual(canAddUser(free, 9), false);
  const pro = { plan: 'pro' };
  assert.strictEqual(canAddUser(pro, 500), true);
});

test('reports are Pro-only', () => {
  assert.strictEqual(canUseReports({ plan: 'free' }), false);
  assert.strictEqual(canUseReports({ plan: 'pro' }), true);
  // A lapsed subscription loses the feature, not the data.
  assert.strictEqual(canUseReports({ plan: 'pro', proUntil: new Date(Date.now() - 1000) }), false);
});

// ---------- enforcement over HTTP ----------

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
    // Signup is not just a church and a user: lib/provision.js seeds a chart
    // of accounts, special categories, service types and expense categories
    // in the same transaction. All of them hold a foreign key to the church,
    // so deleting the church first fails on accounts_church_id_fkey.
    const where = { churchId: { in: createdChurchIds } };
    await db.account.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
  await pool.end();
});

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function signupChurch(tag) {
  const res = await fetch(`${base}/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ churchName: `${tag} Church`, name: 'Owner', email: uniqueEmail(tag), password: 'password123' }),
  });
  assert.strictEqual(res.status, 201);
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = set.find((c) => c.startsWith('connect.sid='))?.split(';')[0];
  const body = await res.json();
  createdChurchIds.push(body.church.id);
  const call = async (method, p, payload) => {
    const r = await fetch(base + p, {
      method,
      headers: { cookie, ...(payload ? { 'content-type': 'application/json' } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await r.text();
    let b; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  return {
    churchId: body.church.id,
    get: (p) => call('GET', p),
    post: (p, payload) => call('POST', p, payload),
    goPro: () => db.church.update({ where: { id: body.church.id }, data: { plan: 'pro' } }),
  };
}

test('a Free church is refused a third staff account', async () => {
  const c = await signupChurch('plan-seats');
  // Signup created the owner, so one seat remains.
  const second = await c.post('/api/users', {
    username: 'second', email: uniqueEmail('seat2'), password: 'password123',
  });
  assert.strictEqual(second.status, 201);

  const third = await c.post('/api/users', {
    username: 'third', email: uniqueEmail('seat3'), password: 'password123',
  });
  assert.strictEqual(third.status, 402, 'third seat should be refused on Free');
  assert.strictEqual(third.body.code, 'plan_limit');
});

test('upgrading to Pro lifts the seat limit immediately', async () => {
  const c = await signupChurch('plan-seats-pro');
  await c.post('/api/users', { username: 'second', email: uniqueEmail('p2'), password: 'password123' });
  const blocked = await c.post('/api/users', { username: 'third', email: uniqueEmail('p3'), password: 'password123' });
  assert.strictEqual(blocked.status, 402);

  await c.goPro();
  const allowed = await c.post('/api/users', {
    username: 'third', email: uniqueEmail('p4'), password: 'password123',
  });
  assert.strictEqual(allowed.status, 201, 'Pro should accept the seat that Free refused');
});

test('reports are refused on Free and served on Pro', async () => {
  const c = await signupChurch('plan-reports');
  const free = await c.get('/api/reports/members/status-summary');
  assert.strictEqual(free.status, 402);
  assert.strictEqual(free.body.code, 'plan_limit');

  await c.goPro();
  const pro = await c.get('/api/reports/members/status-summary');
  assert.strictEqual(pro.status, 200, 'Pro should be served the report');
});

test('the reports page explains the upgrade rather than erroring', async () => {
  // Only the signed-in path is a plan decision. An earlier version of this
  // test also asserted on an unauthenticated GET, which was both irrelevant
  // and wrong: fetch follows redirects, so that request lands on /login with
  // 200, never the 302 it asserted — and it failed before reaching the checks
  // that actually matter here.
  const c = await signupChurch('plan-reports-html');
  const page = await c.get('/reports');
  assert.strictEqual(page.status, 402);
  assert.ok(String(page.body).includes('Pro'), 'the page should name the plan');
  assert.ok(!String(page.body).includes('Forbidden'), 'it should read as an upsell, not an error');
});
