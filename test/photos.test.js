'use strict';
// Phase 9c verification: member photo upload/delete/serve against a local
// temp PHOTO_DIR (isolated from the real dev photos/ directory), including
// the cross-tenant photo-serving check that has no equivalent in the
// single-tenant original (see routes-pg-html/members.js's module header).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');

const tmpPhotoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'church-photos-test-'));
process.env.PHOTO_DIR = tmpPhotoDir;

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
  fs.rmSync(tmpPhotoDir, { recursive: true, force: true });
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
      return { status: res.status, text: res.status < 300 ? await res.text() : '' };
    },
    async getRaw(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {} });
      remember(res);
      return { status: res.status, buffer: res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null };
    },
    async postMultipart(p, csrf, fileBuffer, filename, mimeType) {
      const form = new FormData();
      form.append('_csrf', csrf);
      form.append('photo', new Blob([fileBuffer], { type: mimeType }), filename);
      const res = await fetch(base + p, { method: 'POST', headers: cookie ? { cookie } : {}, body: form, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location') };
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
async function signedInChurch(tag) {
  const c = client();
  const signup = await c.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'password123' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return { client: c, churchId: signup.body.church.id };
}

// Minimal valid 1x1 PNG (matches looksLikeImage()'s PNG magic-byte check).
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

test('photo upload: stores the file, updates photoFilename, memberAvatar picks it up', async () => {
  const { client: c, churchId } = await signedInChurch('photo-upload');
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-301', firstName: 'Efua', lastName: 'Boateng', membershipStatus: 'MEMBER' } });

  const detail = await c.getHtml(`/members/${member.id}`);
  const csrf = detail.text.match(/name="_csrf" value="([^"]*)"/)[1];
  const uploaded = await c.postMultipart(`/members/${member.id}/photo`, csrf, PNG_BYTES, 'test.png', 'image/png');
  assert.strictEqual(uploaded.status, 302);

  const updated = await db.member.findUnique({ where: { id: member.id } });
  assert.strictEqual(updated.photoFilename, `${member.id}.png`);
  assert.ok(fs.existsSync(path.join(tmpPhotoDir, `${member.id}.png`)));

  const afterPage = await c.getHtml(`/members/${member.id}`);
  assert.match(afterPage.text, new RegExp(`/photos/${member.id}\\.png`));

  const served = await c.getRaw(`/photos/${member.id}.png`);
  assert.strictEqual(served.status, 200);
  assert.ok(served.buffer.equals(PNG_BYTES));
});

test('photo upload: a non-image file is rejected', async () => {
  const { client: c, churchId } = await signedInChurch('photo-reject');
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-302', firstName: 'Yaw', lastName: 'Darko', membershipStatus: 'MEMBER' } });
  const detail = await c.getHtml(`/members/${member.id}`);
  const csrf = detail.text.match(/name="_csrf" value="([^"]*)"/)[1];
  const uploaded = await c.postMultipart(`/members/${member.id}/photo`, csrf, Buffer.from('not an image'), 'fake.png', 'image/png');
  assert.strictEqual(uploaded.status, 400);
  const updated = await db.member.findUnique({ where: { id: member.id } });
  assert.strictEqual(updated.photoFilename, null);
});

test('photo delete: removes the file and clears photoFilename', async () => {
  const { client: c, churchId } = await signedInChurch('photo-delete');
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-303', firstName: 'Ama', lastName: 'Serwaa', membershipStatus: 'MEMBER' } });
  const detail = await c.getHtml(`/members/${member.id}`);
  const csrf = detail.text.match(/name="_csrf" value="([^"]*)"/)[1];
  await c.postMultipart(`/members/${member.id}/photo`, csrf, PNG_BYTES, 'test.png', 'image/png');
  assert.ok(fs.existsSync(path.join(tmpPhotoDir, `${member.id}.png`)));

  const detail2 = await c.getHtml(`/members/${member.id}`);
  const csrf2 = detail2.text.match(/name="_csrf" value="([^"]*)"/)[1];
  const deleted = await c.postForm(`/members/${member.id}/photo/delete`, { _csrf: csrf2 });
  assert.strictEqual(deleted.status, 302);

  const updated = await db.member.findUnique({ where: { id: member.id } });
  assert.strictEqual(updated.photoFilename, null);
  assert.ok(!fs.existsSync(path.join(tmpPhotoDir, `${member.id}.png`)));
});

test('cross-tenant: church B cannot fetch church A\'s member photo by guessing the filename', async () => {
  const { client: cA, churchId: churchA } = await signedInChurch('photo-cross-a');
  const { client: cB } = await signedInChurch('photo-cross-b');
  const memberA = await db.member.create({ data: { churchId: churchA, externalId: 'MBR-401', firstName: 'Kojo', lastName: 'Mensah', membershipStatus: 'MEMBER' } });

  const detailA = await cA.getHtml(`/members/${memberA.id}`);
  const csrfA = detailA.text.match(/name="_csrf" value="([^"]*)"/)[1];
  await cA.postMultipart(`/members/${memberA.id}/photo`, csrfA, PNG_BYTES, 'test.png', 'image/png');

  // Church A itself can fetch it fine.
  const servedA = await cA.getRaw(`/photos/${memberA.id}.png`);
  assert.strictEqual(servedA.status, 200);

  // Church B, logged in as its own admin, must NOT be able to fetch church A's photo
  // by guessing the {memberId}.{ext} filename off the shared PHOTO_DIR.
  const servedB = await cB.getRaw(`/photos/${memberA.id}.png`);
  assert.strictEqual(servedB.status, 404);
});
