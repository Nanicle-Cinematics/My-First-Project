'use strict';
// Phase 8b verification: thin HTTP smoke tests for the three new HTML
// modules (bible-classes, inventory, organizations) — same pattern as
// test/preaching-html.test.js. Not a substitute for the required manual
// browser click-through.
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
    await db.organizationMembership.deleteMany({ where });
    await db.organization.deleteMany({ where });
    await db.ministry.deleteMany({ where });
    await db.inventoryItem.deleteMany({ where });
    await db.inventoryCategory.deleteMany({ where });
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

async function signedInClient(tag) {
  const client = htmlClient();
  const signup = await client.postJson('/signup', {
    churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'password123',
  });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return client;
}

for (const [path, title] of [['/bible-classes', 'Bible Classes'], ['/inventory', 'Inventory'], ['/organizations', 'Organizations']]) {
  test(`unauthenticated GET ${path} redirects to /login`, async () => {
    const client = htmlClient();
    const res = await client.getHtml(path);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.location, '/login');
  });

  test(`signed-in GET ${path} renders 200 with a CSRF token and the right title`, async () => {
    const client = await signedInClient(`html-smoke-${path.replace('/', '')}`);
    const res = await client.getHtml(path);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, new RegExp(title));
    assert.ok(extractCsrf(res.text), 'expected a CSRF token embedded in the rendered page');
  });
}

test('bible-classes: create without CSRF is rejected, with CSRF succeeds and appears on the page', async () => {
  const client = await signedInClient('html-bc-create');
  const page = await client.getHtml('/bible-classes');
  const csrf = extractCsrf(page.text);

  const rejected = await client.postForm('/bible-classes', { name: 'No CSRF Class' });
  assert.strictEqual(rejected.status, 403);

  const created = await client.postForm('/bible-classes', { name: 'Youth Fellowship', meetsOn: 'Sunday 8am', _csrf: csrf });
  assert.strictEqual(created.status, 302);
  const after = await client.getHtml('/bible-classes');
  assert.match(after.text, /Youth Fellowship/);
});

test('inventory: create an item and a category, then archive the item', async () => {
  const client = await signedInClient('html-inv-create');
  const page = await client.getHtml('/inventory');
  const csrf = extractCsrf(page.text);

  const createdCat = await client.postForm('/inventory/categories', { name: 'Test Category', _csrf: csrf });
  assert.strictEqual(createdCat.status, 302);

  const created = await client.postForm('/inventory', { name: 'Projector', quantity: '2', category: 'Test Category', _csrf: csrf });
  assert.strictEqual(created.status, 302);
  const afterCreate = await client.getHtml('/inventory');
  assert.match(afterCreate.text, /Projector/);
  assert.match(afterCreate.text, /Test Category/);

  const editUrlMatch = afterCreate.text.match(/\/inventory\/(\d+)\/edit/);
  assert.ok(editUrlMatch, 'expected an edit link for the created item');
  const csrf2 = extractCsrf(afterCreate.text);
  const archived = await client.postForm(`/inventory/${editUrlMatch[1]}/delete`, { _csrf: csrf2 });
  assert.strictEqual(archived.status, 302);
  const afterArchive = await client.getHtml('/inventory');
  assert.doesNotMatch(afterArchive.text, /Projector/);
});

test('organizations: create a group, view its roster page, archive it', async () => {
  const client = await signedInClient('html-org-create');
  const listPage = await client.getHtml('/organizations');
  const csrf = extractCsrf(listPage.text);

  const created = await client.postForm('/organizations', { name: 'Sunshine Choir', meetsOn: 'Saturday 5pm', _csrf: csrf });
  assert.strictEqual(created.status, 302);

  const afterCreate = await client.getHtml('/organizations');
  assert.match(afterCreate.text, /Sunshine Choir/);
  const detailUrlMatch = afterCreate.text.match(/\/organizations\/(\d+)"/);
  assert.ok(detailUrlMatch, 'expected a link to the new organization\'s detail page');

  const detail = await client.getHtml(`/organizations/${detailUrlMatch[1]}`);
  assert.strictEqual(detail.status, 200);
  assert.match(detail.text, /Sunshine Choir/);

  const csrf2 = extractCsrf(detail.text);
  const archived = await client.postForm(`/organizations/${detailUrlMatch[1]}/archive`, { _csrf: csrf2 });
  assert.strictEqual(archived.status, 302);
  const afterArchive = await client.getHtml('/organizations');
  assert.doesNotMatch(afterArchive.text, /Sunshine Choir/);
});
