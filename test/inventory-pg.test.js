'use strict';
// Phase 2, module 3: routes-pg/inventory.js.
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
    await db.inventoryItem.deleteMany({ where });
    await db.inventoryCategory.deleteMany({ where });
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
    del: (p) => send('DELETE', p),
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

test('categories: recommended list is always present, saved custom categories merge in', async () => {
  const { client } = await newSignedInChurch('inv-categories');
  const before = await client.get('/api/inventory/categories');
  assert.ok(before.body.includes('Instruments'));
  assert.ok(!before.body.includes('Custom Thing'));

  const created = await client.post('/api/inventory/categories', { name: 'Custom Thing' });
  assert.strictEqual(created.status, 201);

  const after = await client.get('/api/inventory/categories');
  assert.ok(after.body.includes('Custom Thing'));
  assert.ok(after.body.includes('Instruments'));
});

test('create, read, search, update, soft-delete an item', async () => {
  const { client } = await newSignedInChurch('inv-crud');

  const created = await client.post('/api/inventory', { name: 'Projector', quantity: 2, category: 'Audio-Visual / Media' });
  assert.strictEqual(created.status, 201);
  const id = created.body.id;

  const fetched = await client.get(`/api/inventory/${id}`);
  assert.strictEqual(fetched.status, 200);
  assert.strictEqual(fetched.body.quantity, 2);

  const list = await client.get('/api/inventory');
  assert.ok(list.body.some((i) => i.id === id));

  const searched = await client.get('/api/inventory?q=proj');
  assert.strictEqual(searched.body.length, 1);
  const noMatch = await client.get('/api/inventory?q=nonexistent');
  assert.strictEqual(noMatch.body.length, 0);

  const updated = await client.put(`/api/inventory/${id}`, { name: 'Projector', quantity: 3 });
  assert.strictEqual(updated.status, 200);
  assert.strictEqual(updated.body.quantity, 3);

  const deleted = await client.del(`/api/inventory/${id}`);
  assert.strictEqual(deleted.status, 204);

  const afterDelete = await client.get(`/api/inventory/${id}`);
  assert.strictEqual(afterDelete.status, 404);

  const listAfterDelete = await client.get('/api/inventory');
  assert.ok(!listAfterDelete.body.some((i) => i.id === id));
});

test('missing name is rejected on create and update', async () => {
  const { client } = await newSignedInChurch('inv-validation');
  const noName = await client.post('/api/inventory', { quantity: 1 });
  assert.strictEqual(noName.status, 400);

  const created = await client.post('/api/inventory', { name: 'Chairs', quantity: 10 });
  const badUpdate = await client.put(`/api/inventory/${created.body.id}`, { name: '' });
  assert.strictEqual(badUpdate.status, 400);
});

test('cross-tenant: church B cannot read, edit, or delete church A\'s item', async () => {
  const a = await newSignedInChurch('inv-cross-a');
  const b = await newSignedInChurch('inv-cross-b');
  const created = await a.client.post('/api/inventory', { name: 'A Only Item', quantity: 1 });
  const id = created.body.id;

  assert.strictEqual((await b.client.get(`/api/inventory/${id}`)).status, 404);
  assert.strictEqual((await b.client.put(`/api/inventory/${id}`, { name: 'Hijacked' })).status, 404);
  assert.strictEqual((await b.client.del(`/api/inventory/${id}`)).status, 404);

  const stillThere = await a.client.get(`/api/inventory/${id}`);
  assert.strictEqual(stillThere.status, 200);
  assert.strictEqual(stillThere.body.name, 'A Only Item');
});

test('non-admin can read but not create/edit/delete', async () => {
  const { churchId } = await newSignedInChurch('inv-rbac');
  const viewer = await addNonAdminUser(churchId, 'VIEWER');

  assert.strictEqual((await viewer.get('/api/inventory')).status, 200);
  assert.strictEqual((await viewer.post('/api/inventory', { name: 'Blocked', quantity: 1 })).status, 403);
});
