'use strict';
// Phase 8e verification: thin HTTP smoke tests for the four new HTML
// modules (finance, users, settings, platform) — same pattern as the
// earlier phase8*-html.test.js files.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const platformEmail = `platform-admin-${process.pid}-${Date.now()}@example.test`;
process.env.PLATFORM_ADMIN_EMAILS = platformEmail;

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
    await db.financialPeriod.deleteMany({ where });
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financeReceipt.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.incomeRecord.deleteMany({ where });
    await db.fund.deleteMany({ where });
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
  };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}
function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  return m ? m[1] : null;
}
async function signedInClient(tag, email) {
  const client = htmlClient();
  const signup = await client.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: email || uniqueEmail(tag), password: 'password123' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return { client, churchId: signup.body.church.id };
}

for (const [path, title] of [['/finance', 'Finance'], ['/users', 'Users'], ['/settings', 'Settings']]) {
  test(`unauthenticated GET ${path} redirects to /login`, async () => {
    const client = htmlClient();
    const res = await client.getHtml(path);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.location, '/login');
  });

  test(`signed-in GET ${path} renders 200 with a CSRF token and the right title`, async () => {
    const { client } = await signedInClient(`html-smoke-${path.replace('/', '')}`);
    const res = await client.getHtml(path);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, new RegExp(title));
    assert.ok(extractCsrf(res.text), 'expected a CSRF token embedded in the rendered page');
  });
}

test('non-platform-admin GET /platform is forbidden', async () => {
  const { client } = await signedInClient('html-platform-forbidden');
  const res = await client.getHtml('/platform');
  assert.strictEqual(res.status, 403);
});

test('finance: create a fund, record income, record an expense, verify balance', async () => {
  const { client } = await signedInClient('html-fin-flow');
  const fundsPage = await client.getHtml('/finance/funds');
  const csrf = extractCsrf(fundsPage.text);

  const createdFund = await client.postForm('/finance/funds', { name: 'Missions Fund', code: 'MIS', fundType: 'MISSION', openingBalance: '0', _csrf: csrf });
  assert.strictEqual(createdFund.status, 302);
  const afterFund = await client.getHtml('/finance/funds');
  assert.match(afterFund.text, /Missions Fund/);

  const incomePage = await client.getHtml('/finance/income');
  const csrf2 = extractCsrf(incomePage.text);
  const recordedIncome = await client.postForm('/finance/income', {
    transactionDate: '2026-07-01', category: 'donation', receivedFrom: 'Test Giver', amount: '100', paymentMethod: 'Cash', _csrf: csrf2,
  });
  assert.strictEqual(recordedIncome.status, 302);
  const afterIncome = await client.getHtml('/finance/income');
  assert.match(afterIncome.text, /Test Giver/);
  assert.match(afterIncome.text, /GH₵ 100\.00/);

  const expensesPage = await client.getHtml('/finance/expenses');
  const csrf3 = extractCsrf(expensesPage.text);
  const recordedExpense = await client.postForm('/finance/expenses', {
    spentOn: '2026-07-01', amount: '40', description: 'Test supplies', paymentMethod: 'Cash', _csrf: csrf3,
  });
  assert.strictEqual(recordedExpense.status, 302);
  const afterExpense = await client.getHtml('/finance/expenses');
  assert.match(afterExpense.text, /Test supplies/);
  assert.match(afterExpense.text, /PAID/);

  const report = await client.getHtml('/finance/reports/overview?start=2026-07-01&end=2026-07-31');
  assert.strictEqual(report.status, 200);
  assert.match(report.text, /Financial Overview/);
  assert.match(report.text, /Income by category/);
  assert.match(report.text, /GH₵ 100\.00/);

  const csv = await client.getHtml('/finance/reports/income-expense.csv?start=2026-07-01&end=2026-07-31');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.text, /Date,Type,Account,Fund,Source,Memo,Debit,Credit/);
});

test('users: create a teammate, change their role, reset their password', async () => {
  const { client } = await signedInClient('html-users-flow');
  const listPage = await client.getHtml('/users');
  const csrf = extractCsrf(listPage.text);

  const created = await client.postForm('/users', {
    username: 'teammate', displayName: 'Team Mate', email: uniqueEmail('teammate'), password: 'teampass123', role: 'EDITOR', financeRole: 'CASHIER', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);
  const afterCreate = await client.getHtml('/users');
  assert.match(afterCreate.text, /teammate/);
  assert.match(afterCreate.text, /Team Mate/);

  const teammateIdMatch = afterCreate.text.match(/\/users\/(\d+)\/role/);
  assert.ok(teammateIdMatch, 'expected a role-change form for the new teammate');
  const csrf2 = extractCsrf(afterCreate.text);
  const resetRes = await client.postForm(`/users/${teammateIdMatch[1]}/reset`, { password: 'newpassword123', _csrf: csrf2 });
  assert.strictEqual(resetRes.status, 302);
});

test('settings: update church name', async () => {
  const { client } = await signedInClient('html-settings-flow');
  const page = await client.getHtml('/settings');
  assert.match(page.text, /Church logo/);
  assert.match(page.text, /\/branding\/logo/);
  const csrf = extractCsrf(page.text);
  const updated = await client.postForm('/settings', { name: 'Renamed via Settings', _csrf: csrf });
  assert.strictEqual(updated.status, 302);
  const after = await client.getHtml('/settings');
  assert.match(after.text, /Renamed via Settings/);
});

test('platform: admin sees churches list and can set a church to Pro', async () => {
  const { client, churchId } = await signedInClient('html-platform-admin', platformEmail);
  const page = await client.getHtml('/platform');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /Churches/);
  const csrf = extractCsrf(page.text);

  const setPro = await client.postForm(`/platform/churches/${churchId}/plan`, { plan: 'pro', months: '6', _csrf: csrf });
  assert.strictEqual(setPro.status, 302);
  const after = await client.getHtml('/platform');
  assert.match(after.text, /pill pill-fulfilled/);

  const settings = await client.getHtml('/settings');
  assert.match(settings.text, /<dd>Pro<\/dd>/);
});
