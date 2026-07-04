'use strict';
// Phase 1 verification: the new Postgres-backed multi-tenant signup/login/
// session subsystem (lib/auth.js, lib/provision.js, lib/tenant-http.js),
// driven over real HTTP exactly like test/smoke.test.js drives the existing
// SQLite app. Runs against the Neon DEV branch (see .env) and cleans up
// every church/user it creates in test.after.
//
// Deliberately separate from test/smoke.test.js / server.js — this proves
// the new subsystem works standalone before it's wired into the live app.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const OTPAuth = require('otpauth');
const { createTotpSecret, createRecoveryCodes } = require('../lib/mfa');

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
    // Church has no cascade-delete to its children (deliberate — real
    // off-boarding should be an explicit, tenant-scoped export/delete flow,
    // not an implicit cascade), so clean up dependents before the church.
    await db.preachingPlan.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.securityAuditLog.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  // The `session` table is shared across all test files/the real app —
  // never dropped here (see scripts/ensure-session-table.js).
  await db.$disconnect();
  await pool.end();
});

// --- tiny cookie-aware client (same pattern as test/smoke.test.js) ---
function cookieClient() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async post(p, jsonBody) {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(jsonBody),
      });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async get(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {} });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async getHtml(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {} });
      remember(res);
      return { status: res.status, body: await res.text() };
    },
    cookie: () => cookie,
  };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

test('signup creates a church + admin user and starts a session', async () => {
  const client = cookieClient();
  const emailA = uniqueEmail('owner-a');
  const signup = await client.post('/signup', {
    churchName: 'Grace Chapel',
    name: 'Ama Owner',
    email: emailA,
    password: 'correct-horse-battery',
  });
  assert.strictEqual(signup.status, 201);
  assert.ok(signup.body.church.id);
  createdChurchIds.push(signup.body.church.id);

  const who = await client.get('/whoami');
  assert.strictEqual(who.status, 200);
  assert.strictEqual(who.body.email, emailA);
  assert.strictEqual(who.body.churchId, signup.body.church.id);
});

test('duplicate email is rejected', async () => {
  const client = cookieClient();
  const email = uniqueEmail('dup');
  const first = await client.post('/signup', { churchName: 'First Church', name: 'A', email, password: 'password123' });
  assert.strictEqual(first.status, 201);
  createdChurchIds.push(first.body.church.id);

  const second = await client.post('/signup', { churchName: 'Second Church', name: 'B', email, password: 'password123' });
  assert.strictEqual(second.status, 400);
});

test('two churches can each have a user with the same display username, no collision', async () => {
  const clientA = cookieClient();
  const clientB = cookieClient();
  const signupA = await clientA.post('/signup', { churchName: 'Alpha Church', name: 'Same Name', email: uniqueEmail('alpha'), password: 'password123' });
  const signupB = await clientB.post('/signup', { churchName: 'Beta Church', name: 'Same Name', email: uniqueEmail('beta'), password: 'password123' });
  assert.strictEqual(signupA.status, 201);
  assert.strictEqual(signupB.status, 201);
  createdChurchIds.push(signupA.body.church.id, signupB.body.church.id);
});

test('authenticated shell uses each tenant church name without cross-tenant branding', async () => {
  const clientA = cookieClient();
  const clientB = cookieClient();
  const signupA = await clientA.post('/signup', { churchName: 'Brand Alpha Church', name: 'Owner A', email: uniqueEmail('brand-a'), password: 'password123' });
  const signupB = await clientB.post('/signup', { churchName: 'Brand Beta Church', name: 'Owner B', email: uniqueEmail('brand-b'), password: 'password123' });
  createdChurchIds.push(signupA.body.church.id, signupB.body.church.id);

  const pageA = await clientA.getHtml('/');
  const pageB = await clientB.getHtml('/');
  assert.strictEqual(pageA.status, 200);
  assert.strictEqual(pageB.status, 200);
  assert.match(pageA.body, /Brand Alpha Church/);
  assert.doesNotMatch(pageA.body, /Brand Beta Church/);
  assert.match(pageB.body, /Brand Beta Church/);
  assert.doesNotMatch(pageB.body, /Brand Alpha Church/);
});

test('login works and wrong password is rejected generically', async () => {
  const email = uniqueEmail('login');
  const setup = cookieClient();
  const signup = await setup.post('/signup', { churchName: 'Login Test Church', name: 'Owner', email, password: 'correct-password' });
  createdChurchIds.push(signup.body.church.id);

  const fresh = cookieClient();
  const bad = await fresh.post('/login', { email, password: 'wrong-password' });
  assert.strictEqual(bad.status, 401);
  const cookieAfterFailure = fresh.cookie();

  const good = await fresh.post('/login', { email, password: 'correct-password' });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.body.user.email, email);
  assert.notStrictEqual(fresh.cookie(), cookieAfterFailure);

  const events = await db.securityAuditLog.findMany({
    where: { churchId: signup.body.church.id },
    orderBy: { occurredAt: 'asc' },
  });
  assert.deepStrictEqual(events.map((row) => row.event), [
    'auth.login_failed',
    'auth.login_succeeded',
  ]);
  assert.ok(events.every((row) => row.ip));
});

test('account locks after 5 failed attempts', async () => {
  const email = uniqueEmail('lockout');
  const setup = cookieClient();
  const signup = await setup.post('/signup', { churchName: 'Lockout Church', name: 'Owner', email, password: 'correct-password' });
  createdChurchIds.push(signup.body.church.id);

  const attacker = cookieClient();
  let last;
  for (let i = 0; i < 5; i++) last = await attacker.post('/login', { email, password: 'wrong' });
  assert.strictEqual(last.status, 423);

  // Even the CORRECT password is rejected while locked.
  const stillLocked = await attacker.post('/login', { email, password: 'correct-password' });
  assert.strictEqual(stillLocked.status, 423);
});

test('MFA-enabled users must complete TOTP challenge before receiving an authenticated session', async () => {
  const email = uniqueEmail('mfa-login');
  const setup = cookieClient();
  const signup = await setup.post('/signup', { churchName: 'MFA Church', name: 'Owner', email, password: 'correct-password' });
  createdChurchIds.push(signup.body.church.id);

  const enrollment = createTotpSecret(email);
  const recovery = createRecoveryCodes();
  await db.user.update({
    where: { id: signup.body.user.id },
    data: { totpEnabled: true, totpSecret: enrollment.secret, totpRecoveryCodes: recovery.serialized },
  });

  const fresh = cookieClient();
  const passwordStep = await fresh.post('/login', { email, password: 'correct-password' });
  assert.strictEqual(passwordStep.status, 202);
  assert.strictEqual(passwordStep.body.mfaRequired, true);
  assert.strictEqual((await fresh.get('/whoami')).status, 401);

  const totp = new OTPAuth.TOTP({
    issuer: 'Church Manager',
    label: email,
    secret: OTPAuth.Secret.fromBase32(enrollment.secret),
  });
  const challenge = await fresh.post('/login/mfa', { code: totp.generate() });
  assert.strictEqual(challenge.status, 200);
  assert.strictEqual((await fresh.get('/whoami')).status, 200);
});

test('cross-tenant isolation: church B cannot see church A rows via a converted feature route', async () => {
  const clientA = cookieClient();
  const clientB = cookieClient();
  const signupA = await clientA.post('/signup', { churchName: 'Isolation Church A', name: 'Owner A', email: uniqueEmail('iso-a'), password: 'password123' });
  const signupB = await clientB.post('/signup', { churchName: 'Isolation Church B', name: 'Owner B', email: uniqueEmail('iso-b'), password: 'password123' });
  createdChurchIds.push(signupA.body.church.id, signupB.body.church.id);

  await db.preachingPlan.create({ data: { churchId: signupA.body.church.id, preachDate: new Date('2026-09-06'), topic: 'Only for A' } });

  const seenByA = await clientA.get('/api/preaching');
  const seenByB = await clientB.get('/api/preaching');
  assert.strictEqual(seenByA.body.upcoming.length, 1);
  assert.strictEqual(seenByB.body.upcoming.length, 0);
});

test('no session -> 401 on protected routes', async () => {
  const client = cookieClient();
  const res = await client.get('/whoami');
  assert.strictEqual(res.status, 401);
});
