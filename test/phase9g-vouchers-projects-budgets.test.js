'use strict';
// Phase 9g verification: expense categories (seeded at signup), payment
// vouchers (auto-synced 1:1 with expenses, own numbering scheme), finance
// projects (fund-linked and standalone target/raised/spent tracking), and
// finance budgets (budget-vs-actual computed straight from the ledger via
// the new ledger.budgetActual() reader).
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const ledger = require('../lib/ledger-pg');

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
    await db.paymentVoucher.deleteMany({ where });
    await db.financeBudgetLine.deleteMany({ where });
    await db.financeBudget.deleteMany({ where });
    await db.financeReceipt.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.incomeRecord.deleteMany({ where });
    await db.financeProject.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.fund.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
  await pool.end();
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
    async getCsv(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {} });
      remember(res);
      return { status: res.status, text: await res.text() };
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
function csrfOf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  return m ? m[1] : null;
}

test('signup seeds default expense categories', async () => {
  const { churchId } = await signedInChurch('expcats-seed');
  const cats = await db.expenseCategory.findMany({ where: { churchId } });
  assert.strictEqual(cats.length, 7);
  assert.ok(cats.some((c) => c.categoryName === 'Utilities'));
});

test('expense creation auto-issues a payment voucher with its own sequential number, distinct from receipt numbering', async () => {
  const { client: c, churchId } = await signedInChurch('voucherflow');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Utilities' } });

  const page = await c.getHtml('/finance/expenses');
  const csrf = csrfOf(page.text);
  const created = await c.postForm('/finance/expenses', {
    spentOn: '2026-06-01', expenseCatId: String(cat.id), amount: '250.75', fundId: String(fund.id), description: 'June electricity bill', paidTo: 'ECG', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);

  const expense = await db.expense.findFirst({ where: { churchId } });
  const voucher = await db.paymentVoucher.findFirst({ where: { expenseId: expense.id } });
  assert.ok(voucher);
  assert.match(voucher.voucherNo, /^PV-2026-\d{4}$/);
  assert.match(voucher.amountInWords, /two hundred/i);
  assert.strictEqual(voucher.receivedBy, 'ECG');

  const printPage = await c.getHtml(`/finance/vouchers/${voucher.id}/print`);
  assert.strictEqual(printPage.status, 200);
  assert.match(printPage.text, /Payment Voucher/);
  assert.match(printPage.text, /ECG/);
  assert.match(printPage.text, /250\.75/);

  // A second expense gets its own, sequentially-numbered voucher.
  const page2 = await c.getHtml('/finance/expenses');
  const csrf2 = csrfOf(page2.text);
  await c.postForm('/finance/expenses', { spentOn: '2026-06-05', expenseCatId: String(cat.id), amount: '80', fundId: String(fund.id), description: 'Water bill', _csrf: csrf2 });
  const voucherCount = await db.paymentVoucher.count({ where: { churchId } });
  assert.strictEqual(voucherCount, 2);
  const voucher2 = await db.paymentVoucher.findFirst({ where: { churchId, expenseId: { not: expense.id } } });
  assert.notStrictEqual(voucher2.voucherNo, voucher.voucherNo);

  const csvPage = await c.getCsv('/finance/vouchers.csv');
  assert.strictEqual(csvPage.status, 200);
  assert.match(csvPage.text, /June electricity bill/);
});

test('finance project: fund-linked project tracks raised/spent from the ledger; standalone project tracks spent from tagged expenses only', async () => {
  const { client: c, churchId } = await signedInChurch('projectflow');
  const projectFund = await db.fund.create({ data: { churchId, name: 'Building Fund', fundType: 'BUILDING', code: 'BLD' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Maintenance' } });

  const page = await c.getHtml('/finance/projects');
  const csrf = csrfOf(page.text);
  await c.postForm('/finance/projects', { name: 'Roof Repair Project', fundId: String(projectFund.id), targetAmount: '1000', status: 'ACTIVE', _csrf: csrf });
  const fundedProject = await db.financeProject.findFirst({ where: { churchId, name: 'Roof Repair Project' } });

  const page2 = await c.getHtml('/finance/projects');
  const csrf2 = csrfOf(page2.text);
  await c.postForm('/finance/projects', { name: 'Standalone Youth Project', targetAmount: '0', status: 'ACTIVE', _csrf: csrf2 });
  const standaloneProject = await db.financeProject.findFirst({ where: { churchId, name: 'Standalone Youth Project' } });

  // Fund-linked project: post income into its fund via generic income, then check raised.
  const incomePage = await c.getHtml('/finance/income');
  const csrf3 = csrfOf(incomePage.text);
  await c.postForm('/finance/income', { transactionDate: '2026-06-10', category: 'donation', amount: '400', fundId: String(projectFund.id), _csrf: csrf3 });

  const expPage = await c.getHtml('/finance/expenses');
  const csrf4 = csrfOf(expPage.text);
  await c.postForm('/finance/expenses', { spentOn: '2026-06-11', expenseCatId: String(cat.id), amount: '150', fundId: String(projectFund.id), projectId: String(fundedProject.id), description: 'Roofing materials', _csrf: csrf4 });

  const expPage2 = await c.getHtml('/finance/expenses');
  const csrf5 = csrfOf(expPage2.text);
  await c.postForm('/finance/expenses', { spentOn: '2026-06-12', expenseCatId: String(cat.id), amount: '60', projectId: String(standaloneProject.id), description: 'Youth event supplies', _csrf: csrf5 });

  const fundedDetail = await c.getHtml(`/finance/projects/${fundedProject.id}`);
  assert.strictEqual(fundedDetail.status, 200);
  assert.match(fundedDetail.text, /400\.00/); // raised
  assert.match(fundedDetail.text, /150\.00/); // spent
  assert.match(fundedDetail.text, /Roofing materials/);

  const standaloneDetail = await c.getHtml(`/finance/projects/${standaloneProject.id}`);
  assert.strictEqual(standaloneDetail.status, 200);
  assert.match(standaloneDetail.text, /Youth event supplies/);
  assert.match(standaloneDetail.text, /60\.00/); // spent, no fund so no raised

  const csvPage = await c.getCsv('/finance/projects.csv');
  assert.match(csvPage.text, /Roof Repair Project/);
  assert.match(csvPage.text, /Standalone Youth Project/);
});

test('finance budget: budgetActual aggregates real posted journal entries scoped by type/account/fund/period, variance is computed, CLOSED status blocks line edits', async () => {
  const { client: c, churchId } = await signedInChurch('budgetflow');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId, categoryName: 'Utilities' } });
  const utilitiesAccount = await db.account.findFirst({ where: { churchId, code: '5000' } }); // Utilities expense account seeded at signup

  const page = await c.getHtml('/finance/budgets');
  const csrf = csrfOf(page.text);
  const created = await c.postForm('/finance/budgets', { name: '2026 Annual Budget', year: '2026', scope: 'ANNUAL', _csrf: csrf });
  assert.strictEqual(created.status, 302);
  const budget = await db.financeBudget.findFirst({ where: { churchId } });

  const detail = await c.getHtml(`/finance/budgets/${budget.id}`);
  const csrf2 = csrfOf(detail.text);
  await c.postForm(`/finance/budgets/${budget.id}/lines`, { lineType: 'EXPENSE', category: 'Utilities', accountId: String(utilitiesAccount.id), amount: '1000', _csrf: csrf2 });

  // Post a real expense against the Utilities account/fund, within 2026.
  const expPage = await c.getHtml('/finance/expenses');
  const csrf3 = csrfOf(expPage.text);
  await c.postForm('/finance/expenses', { spentOn: '2026-03-15', expenseCatId: String(cat.id), amount: '300', fundId: String(fund.id), description: 'Q1 electricity', _csrf: csrf3 });

  const detailAfter = await c.getHtml(`/finance/budgets/${budget.id}`);
  assert.strictEqual(detailAfter.status, 200);
  assert.match(detailAfter.text, /1,000\.00|1000\.00/); // budgeted
  assert.match(detailAfter.text, /300\.00/); // actual

  // Cross-check directly against the ledger reader used to render this.
  const win = ledger.budgetWindow(budget);
  const actual = await ledger.budgetActual(db, churchId, { lineType: 'EXPENSE', accountId: utilitiesAccount.id, fundId: null, from: win.from, to: win.to });
  assert.strictEqual(actual, 300);

  // Close the budget: line mutation must now be blocked.
  const csrf4 = csrfOf(detailAfter.text);
  await c.postForm(`/finance/budgets/${budget.id}/status`, { status: 'CLOSED', _csrf: csrf4 });
  const closedBudget = await db.financeBudget.findUnique({ where: { id: budget.id } });
  assert.strictEqual(closedBudget.status, 'CLOSED');

  const detailClosed = await c.getHtml(`/finance/budgets/${budget.id}`);
  const csrf5 = csrfOf(detailClosed.text);
  const blockedLine = await c.postForm(`/finance/budgets/${budget.id}/lines`, { lineType: 'INCOME', category: 'Tithes', amount: '500', _csrf: csrf5 });
  assert.strictEqual(blockedLine.status, 302);
  const lineCountAfter = await db.financeBudgetLine.count({ where: { budgetId: budget.id } });
  assert.strictEqual(lineCountAfter, 1, 'no new line should have been created on a CLOSED budget');
});

test('cross-tenant: church B cannot see church A\'s vouchers, projects, or budgets', async () => {
  const { client: cA, churchId: churchA } = await signedInChurch('finance9g-cross-a');
  const { client: cB } = await signedInChurch('finance9g-cross-b');
  const fund = await db.fund.create({ data: { churchId: churchA, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.expenseCategory.findFirst({ where: { churchId: churchA, categoryName: 'Utilities' } });

  const page = await cA.getHtml('/finance/expenses');
  const csrf = csrfOf(page.text);
  await cA.postForm('/finance/expenses', { spentOn: '2026-06-01', expenseCatId: String(cat.id), amount: '99', fundId: String(fund.id), description: 'Church A Only Expense', paidTo: 'Church A Vendor', _csrf: csrf });

  const projPage = await cA.getHtml('/finance/projects');
  const csrf2 = csrfOf(projPage.text);
  await cA.postForm('/finance/projects', { name: 'Church A Only Project', targetAmount: '0', status: 'ACTIVE', _csrf: csrf2 });

  const budgetPage = await cA.getHtml('/finance/budgets');
  const csrf3 = csrfOf(budgetPage.text);
  await cA.postForm('/finance/budgets', { name: 'Church A Only Budget', year: '2026', scope: 'ANNUAL', _csrf: csrf3 });

  const vouchersB = await cB.getHtml('/finance/vouchers');
  assert.doesNotMatch(vouchersB.text, /Church A Only Expense/);
  const projectsB = await cB.getHtml('/finance/projects');
  assert.doesNotMatch(projectsB.text, /Church A Only Project/);
  const budgetsB = await cB.getHtml('/finance/budgets');
  assert.doesNotMatch(budgetsB.text, /Church A Only Budget/);
});
