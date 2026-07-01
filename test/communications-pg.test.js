'use strict';
// Phase 3, module 1: routes-pg/communications.js.
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
    await db.broadcastRecipient.deleteMany({ where });
    await db.broadcast.deleteMany({ where });
    await db.emailSetting.deleteMany({ where });
    await db.announcement.deleteMany({ where });
    await db.organizationMembership.deleteMany({ where });
    await db.organization.deleteMany({ where });
    await db.member.deleteMany({ where });
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
  return {
    get: (p) => send('GET', p),
    post: (p, b) => send('POST', p, b),
    put: (p, b) => send('PUT', p, b),
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

test('announcements: create + list', async () => {
  const { client } = await newSignedInChurch('comm-announce');
  const created = await client.post('/api/communications/announcements', { title: 'Welcome', body: 'Hello church!' });
  assert.strictEqual(created.status, 201);
  const list = await client.get('/api/communications/announcements');
  assert.ok(list.body.some((a) => a.title === 'Welcome'));
});

test('announcements: missing title/body rejected', async () => {
  const { client } = await newSignedInChurch('comm-announce-validation');
  const res = await client.post('/api/communications/announcements', { title: '' });
  assert.strictEqual(res.status, 400);
});

test('email settings: per-church, defaults then saves', async () => {
  const { client } = await newSignedInChurch('comm-email-settings');
  const before = await client.get('/api/communications/email-settings');
  assert.strictEqual(before.status, 200);

  const badSave = await client.put('/api/communications/email-settings', { senderName: 'x', senderEmail: 'not-an-email' });
  assert.strictEqual(badSave.status, 400);

  const goodSave = await client.put('/api/communications/email-settings', { senderName: 'Grace Chapel', senderEmail: 'noreply@grace.test' });
  assert.strictEqual(goodSave.status, 200);
  assert.strictEqual(goodSave.body.senderEmail, 'noreply@grace.test');

  const after = await client.get('/api/communications/email-settings');
  assert.strictEqual(after.body.senderName, 'Grace Chapel');
});

test('broadcast: audience preview and full send-flow with preference skipping', async () => {
  const { client, churchId } = await newSignedInChurch('comm-broadcast');
  await db.member.create({ data: { churchId, firstName: 'Kofi', lastName: 'Mensah', mobilePhone: '0244000001', email: 'kofi@test.com', membershipStatus: 'MEMBER', preferredChannel: 'EITHER' } });
  await db.member.create({ data: { churchId, firstName: 'Ama', lastName: 'Boateng', mobilePhone: '0244000002', membershipStatus: 'MEMBER', preferredChannel: 'SMS_ONLY' } });
  await db.member.create({ data: { churchId, firstName: 'Yaw', lastName: 'Owusu', email: 'yaw@test.com', membershipStatus: 'MEMBER', preferredChannel: 'NONE' } });

  const preview = await client.get('/api/communications/audience-preview?allMembers=1');
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.body.count, 3);
  assert.strictEqual(preview.body.excludedPref, 1, 'the NONE-preference member is excluded from reachability counts');

  const sent = await client.post('/api/communications/broadcasts', { channel: 'both', body: 'Service moved to 10am', allMembers: true });
  assert.strictEqual(sent.status, 201);
  assert.strictEqual(sent.body.totalRecipients, 3);
  assert.strictEqual(sent.body.status, 'DRY_RUN');

  const detail = await client.get(`/api/communications/broadcasts/${sent.body.id}`);
  assert.strictEqual(detail.status, 200);
  // Ama is SMS_ONLY -> her email recipient row should be SKIPPED.
  const amaEmailRow = detail.body.recipients.find((r) => r.channel === 'email' && r.member.firstName === 'Ama');
  assert.strictEqual(amaEmailRow.status, 'SKIPPED');
  // Yaw is NONE -> both his rows should be SKIPPED.
  const yawRows = detail.body.recipients.filter((r) => r.member.firstName === 'Yaw');
  assert.ok(yawRows.every((r) => r.status === 'SKIPPED'));
});

test('broadcast: rejects invalid channel and empty audience', async () => {
  const { client } = await newSignedInChurch('comm-broadcast-validation');
  const badChannel = await client.post('/api/communications/broadcasts', { channel: 'carrier-pigeon', body: 'x', allMembers: true });
  assert.strictEqual(badChannel.status, 400);
  const noAudience = await client.post('/api/communications/broadcasts', { channel: 'sms', body: 'x' });
  assert.strictEqual(noAudience.status, 400);
});

test('cross-tenant: church B cannot see church A\'s announcements or broadcasts', async () => {
  const a = await newSignedInChurch('comm-cross-a');
  const b = await newSignedInChurch('comm-cross-b');
  await a.client.post('/api/communications/announcements', { title: 'A Only', body: 'secret' });
  await db.member.create({ data: { churchId: a.churchId, firstName: 'A', lastName: 'Member', membershipStatus: 'MEMBER', preferredChannel: 'EITHER', email: 'a@test.com' } });
  const sent = await a.client.post('/api/communications/broadcasts', { channel: 'email', body: 'A only broadcast', allMembers: true });

  const bAnnouncements = await b.client.get('/api/communications/announcements');
  assert.ok(!bAnnouncements.body.some((x) => x.title === 'A Only'));

  const bBroadcastRead = await b.client.get(`/api/communications/broadcasts/${sent.body.id}`);
  assert.strictEqual(bBroadcastRead.status, 404);
});

test('non-admin can read but not post announcements/broadcasts or change email settings', async () => {
  const { churchId } = await newSignedInChurch('comm-rbac');
  const viewer = await addNonAdminUser(churchId, 'VIEWER');
  assert.strictEqual((await viewer.get('/api/communications/announcements')).status, 200);
  assert.strictEqual((await viewer.post('/api/communications/announcements', { title: 'x', body: 'y' })).status, 403);
  assert.strictEqual((await viewer.put('/api/communications/email-settings', { senderName: 'x', senderEmail: 'a@b.com' })).status, 403);
});
