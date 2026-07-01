'use strict';
// Phase 5: routes-pg/finance.js (income/expense recording, journal detail +
// reversal, fund balance, period locking). Same conventions as the other
// routes-pg/*.js test files; lib/ledger-pg.js's own correctness (balance
// validation, reversal, locking, concurrency) is covered directly and more
// thoroughly in test/ledger-pg.test.js — this file focuses on the HTTP
// surface, RBAC, and cross-tenant isolation.
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
    await db.financeReceipt.deleteMany({ where });
    await db.incomeRecord.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.fund.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
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

async function addUser(churchId, role, financeRole) {
  const email = uniqueEmail(`u-${role}-${financeRole}`.toLowerCase());
  const passwordHash = await bcrypt.hash('password123', 10);
  await db.user.create({ data: { churchId, username: `u-${Date.now()}`, email, passwordHash, role, financeRole } });
  const client = cookieClient();
  const login = await client.post('/login', { email, password: 'password123' });
  assert.strictEqual(login.status, 200);
  return client;
}

test('signup seeds a full chart of accounts for the new church', async () => {
  const { client } = await newSignedInChurch('fin-accounts');
  const res = await client.get('/api/finance/accounts');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.length >= 25);
  assert.ok(res.body.some((a) => a.code === '1000' && a.name === 'Cash in hand'));
});

test('record income: creates income record + journal entry + auto-numbered receipt, updates fund balance', async () => {
  const { client } = await newSignedInChurch('fin-income');
  const fund = await client.post('/api/finance/funds', { name: 'General', fundType: 'GENERAL' });
  assert.strictEqual(fund.status, 201);

  const recorded = await client.post('/api/finance/income', {
    transactionDate: '2026-06-10', amount: 250, category: 'Tithe', fundId: fund.body.id, receivedFrom: 'Kofi Mensah',
  });
  assert.strictEqual(recorded.status, 201);
  assert.ok(recorded.body.journalEntryId);
  assert.match(recorded.body.receiptNumber, /^RCT-2026-\d{5}$/);

  const balance = await client.get(`/api/finance/funds/${fund.body.id}/balance`);
  assert.strictEqual(balance.body.balance, 250);
  assert.strictEqual(balance.body.raised, 250);
});

test('record expense: creates expense + journal entry, reduces fund balance', async () => {
  const { client } = await newSignedInChurch('fin-expense');
  const fund = await client.post('/api/finance/funds', { name: 'General', fundType: 'GENERAL' });
  await client.post('/api/finance/income', { transactionDate: '2026-06-01', amount: 500, category: 'Donation', fundId: fund.body.id });

  const expense = await client.post('/api/finance/expenses', {
    spentOn: '2026-06-05', amount: 120, category: 'Utilities', fundId: fund.body.id, description: 'Electricity bill',
  });
  assert.strictEqual(expense.status, 201);
  assert.ok(expense.body.journalEntryId);

  const balance = await client.get(`/api/finance/funds/${fund.body.id}/balance`);
  assert.strictEqual(balance.body.balance, 380);
  assert.strictEqual(balance.body.spent, 120);
});

test('deleting income reverses its journal entry and voids the receipt, netting the fund balance back', async () => {
  const { client } = await newSignedInChurch('fin-income-delete');
  const fund = await client.post('/api/finance/funds', { name: 'General', fundType: 'GENERAL' });
  const income = await client.post('/api/finance/income', { transactionDate: '2026-06-10', amount: 300, category: 'Donation', fundId: fund.body.id });

  const deleted = await client.del(`/api/finance/income/${income.body.id}`);
  assert.strictEqual(deleted.status, 204);

  const balance = await client.get(`/api/finance/funds/${fund.body.id}/balance`);
  assert.strictEqual(balance.body.balance, 0, 'reversal must net the fund balance back to zero');

  const journal = await client.get(`/api/finance/journal/${income.body.journalEntryId}`);
  assert.strictEqual(journal.body.status, 'REVERSED');
});

test('validation: bad date/amount rejected on income and expenses', async () => {
  const { client } = await newSignedInChurch('fin-validation');
  assert.strictEqual((await client.post('/api/finance/income', { transactionDate: 'not-a-date', amount: 10 })).status, 400);
  assert.strictEqual((await client.post('/api/finance/income', { transactionDate: '2026-06-10', amount: -5 })).status, 400);
  assert.strictEqual((await client.post('/api/finance/expenses', { spentOn: 'nope', amount: 10 })).status, 400);
});

test('period locking: a locked period blocks further income recording into it', async () => {
  const { client } = await newSignedInChurch('fin-period-lock');
  const fund = await client.post('/api/finance/funds', { name: 'General', fundType: 'GENERAL' });

  const lock = await client.post('/api/finance/periods/lock', { year: 2026, month: 5 });
  assert.strictEqual(lock.status, 200);
  assert.strictEqual(lock.body.status, 'LOCKED');

  const blocked = await client.post('/api/finance/income', { transactionDate: '2026-05-15', amount: 50, category: 'Tithe', fundId: fund.body.id });
  assert.strictEqual(blocked.status, 500, 'ledger throws for a locked period; surfaced as a 500 by the generic error handler');

  const unlock = await client.post('/api/finance/periods/unlock', { year: 2026, month: 5, reason: 'correction needed' });
  assert.strictEqual(unlock.status, 200);
  assert.strictEqual(unlock.body.status, 'OPEN');

  const allowed = await client.post('/api/finance/income', { transactionDate: '2026-05-15', amount: 50, category: 'Tithe', fundId: fund.body.id });
  assert.strictEqual(allowed.status, 201);
});

test('cross-tenant: church B cannot see, reverse, or affect church A\'s journal entries or funds', async () => {
  const a = await newSignedInChurch('fin-cross-a');
  const b = await newSignedInChurch('fin-cross-b');
  const fundA = await a.client.post('/api/finance/funds', { name: 'General', fundType: 'GENERAL' });
  const income = await a.client.post('/api/finance/income', { transactionDate: '2026-06-10', amount: 100, category: 'Tithe', fundId: fundA.body.id });

  assert.strictEqual((await b.client.get(`/api/finance/journal/${income.body.journalEntryId}`)).status, 404);
  assert.strictEqual((await b.client.post(`/api/finance/journal/${income.body.journalEntryId}/reverse`)).status, 404);
  assert.strictEqual((await b.client.get(`/api/finance/funds/${fundA.body.id}/balance`)).status, 404);

  const stillThere = await a.client.get(`/api/finance/journal/${income.body.journalEntryId}`);
  assert.strictEqual(stillThere.status, 200);
  assert.strictEqual(stillThere.body.status, 'POSTED');
});

test('RBAC: a VIEWER (no finance role) can read but not record income/expenses; CASHIER can record but not manage funds', async () => {
  const { churchId } = await newSignedInChurch('fin-rbac');
  const viewer = await addUser(churchId, 'VIEWER', 'NONE');
  const cashier = await addUser(churchId, 'VIEWER', 'CASHIER');

  assert.strictEqual((await viewer.get('/api/finance/accounts')).status, 200);
  assert.strictEqual((await viewer.post('/api/finance/income', { transactionDate: '2026-06-10', amount: 10, category: 'Tithe' })).status, 403);
  assert.strictEqual((await viewer.post('/api/finance/funds', { name: 'Blocked' })).status, 403);

  const fund = await cashier.post('/api/finance/funds', { name: 'Cashier Fund' });
  assert.strictEqual(fund.status, 403, 'CASHIER can write income/expenses but not manage funds (requireFundManager)');

  const income = await cashier.post('/api/finance/income', { transactionDate: '2026-06-10', amount: 10, category: 'Tithe' });
  assert.strictEqual(income.status, 201, 'CASHIER is allowed to record income (requireFinanceWrite)');
});
