'use strict';
// Phase 6, module 3: routes-pg/platform.js — the cross-tenant SaaS-operator
// admin surface. Gated by PLATFORM_ADMIN_EMAILS (env allowlist), and every
// handler deliberately uses the RAW (unscoped) Prisma client, so these
// tests exist specifically to prove the gate itself is airtight — an
// ordinary church admin, even a church OWNER, must never reach this data.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const createdChurchIds = [];

let server, base, platformEmail, platformAdminClient;
test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  platformEmail = `platform-admin-${process.pid}-${Date.now()}@example.test`;
  process.env.PLATFORM_ADMIN_EMAILS = platformEmail;
  // Created ONCE — email must be globally unique, so every test that needs
  // a logged-in platform admin reuses this same client/session rather than
  // re-signing-up with the same email.
  const admin = await newSignedInChurch('platform-admin-owner', platformEmail);
  platformAdminClient = admin.client;
});
test.after(async () => {
  server.close();
  delete process.env.PLATFORM_ADMIN_EMAILS;
  if (createdChurchIds.length) {
    const where = { churchId: { in: createdChurchIds } };
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
  return { get: (p) => send('GET', p), post: (p, b) => send('POST', p, b) };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function newSignedInChurch(tag, email) {
  const client = cookieClient();
  const res = await client.post('/signup', { churchName: `${tag} Church`, name: 'Owner', email: email || uniqueEmail(tag), password: 'password123' });
  createdChurchIds.push(res.body.church.id);
  return { client, churchId: res.body.church.id };
}

test('an ordinary church owner (even ADMIN) cannot reach platform endpoints', async () => {
  const { client } = await newSignedInChurch('platform-blocked');
  assert.strictEqual((await client.get('/api/platform/churches')).status, 403);
  assert.strictEqual((await client.get('/api/platform/summary')).status, 403);
});

test('the church owner whose login email matches PLATFORM_ADMIN_EMAILS gets platform access (proves the gate checks the real session, not a static flag)', async () => {
  const res = await platformAdminClient.get('/api/platform/churches');
  assert.strictEqual(res.status, 200);
});

test('platform admin sees ALL churches across tenants, with usage stats', async () => {
  const other = await newSignedInChurch('platform-list-other');

  const res = await platformAdminClient.get('/api/platform/churches');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.some((c) => c.id === other.churchId), 'platform admin sees a DIFFERENT church it has no membership in');
  const otherRow = res.body.find((c) => c.id === other.churchId);
  assert.strictEqual(otherRow.userCount, 1);
  assert.strictEqual(otherRow.plan, 'free');
});

test('platform admin can activate a church to Pro; the change is visible via that church\'s own settings', async () => {
  const target = await newSignedInChurch('platform-activate-target');

  const activated = await platformAdminClient.post(`/api/platform/churches/${target.churchId}/plan`, { plan: 'pro', months: 12 });
  assert.strictEqual(activated.status, 200);
  assert.strictEqual(activated.body.plan, 'pro');
  assert.ok(activated.body.proUntil);

  const targetSettings = await target.client.get('/api/settings');
  assert.strictEqual(targetSettings.body.plan.key, 'pro');
});

test('summary counts reflect churches actually created in this run', async () => {
  const before = await platformAdminClient.get('/api/platform/summary');
  await newSignedInChurch('platform-summary-extra');
  const after = await platformAdminClient.get('/api/platform/summary');
  assert.strictEqual(after.body.churches, before.body.churches + 1);
});
