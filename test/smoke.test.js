'use strict';
// Integration smoke tests. No external deps: Node's built-in test runner +
// the global fetch, driving the real Express app against a throwaway SQLite DB.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Point the app at a temp DB BEFORE requiring it (it opens the DB on import).
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const TMP_DB = path.join(TMP_ROOT, `cms-test-${process.pid}-${Date.now()}.db`);
const TMP_BACKUPS = `${TMP_DB}-backups`;
process.env.CHURCH_DB = TMP_DB;
process.env.BACKUP_DIR = TMP_BACKUPS;
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const app = require('../server.js');
const { db } = require('../lib/db');

let server, base, cookie;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + ext); } catch (_) {} }
  try { fs.rmSync(TMP_BACKUPS, { recursive: true, force: true }); } catch (_) {}
});

// --- tiny cookie-aware client + CSRF token extraction ---
function rememberCookie(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) {
    if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  }
}
async function get(p) {
  const res = await fetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  rememberCookie(res);
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), contentType: res.headers.get('content-type') || '', body };
}
function tokenFrom(html) {
  const m = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  return m ? m[1] : null;
}
async function post(p, fields) {
  const res = await fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  rememberCookie(res);
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), body };
}

test('unauthenticated root redirects to setup on first run', async () => {
  const r = await get('/');
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /\/setup/);
});

test('health and readiness endpoints are available', async () => {
  const health = await get('/healthz');
  assert.strictEqual(health.status, 200);
  assert.deepStrictEqual(JSON.parse(health.body), { status: 'ok' });

  const ready = await get('/readyz');
  assert.strictEqual(ready.status, 200);
  assert.deepStrictEqual(JSON.parse(ready.body), { status: 'ready', db: 'ok' });
});

test('setup form carries a CSRF token and creates the admin', async () => {
  const form = await get('/setup');
  const token = tokenFrom(form.body);
  assert.ok(token, 'setup form should contain a CSRF token');
  const r = await post('/setup', {
    username: 'dunwelladmin', display_name: 'Tester',
    password: 'testpass1', password2: 'testpass1', _csrf: token,
  });
  assert.strictEqual(r.status, 302);
  const home = await get('/');
  assert.strictEqual(home.status, 200);
  assert.match(home.body, /Welcome back/);
  assert.match(home.body, /class="stat mockup-stat dashboard-clickable"/);
  assert.match(home.body, /Total Members/);
  assert.match(home.body, /Attendance · This Week/);
  assert.match(home.body, /Offering · /);
  assert.match(home.body, /Birthdays · This Week/);
  assert.match(home.body, /class="quick-drop"/);
  assert.match(home.body, /class="dash-grid mockup-grid"/);
  assert.match(home.body, /data-command-center="true"/);
  assert.match(home.body, /data-card-href="\/reports\/financial"/);
  assert.match(home.body, /data-card-href="\/members"/);
  assert.match(home.body, /data-card-href="\/members\?birthday=week"/);
  assert.match(home.body, /Day-born Groups/);
  assert.match(home.body, /Akan fellowship view/);
  assert.match(home.body, /Recent Members/);
  assert.match(home.body, /Attendance trend/);
  const cardOrder = [
    'Attendance trend',
    'Upcoming',
    'Day-born Groups',
    'Recent Members',
  ].map((label) => home.body.indexOf(label));
  assert.ok(cardOrder.every((idx) => idx >= 0), 'dashboard should render every premium layout card');
  assert.deepStrictEqual([...cardOrder].sort((a, b) => a - b), cardOrder);
});

test('dashboard day-born grid CSS is scoped away from finance forms', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.dash-grid \.day-born-grid\s*\{[\s\S]*?grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(css, /(?:^|\n)\.day-born-grid\s*\{[^}]*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
});

test('dashboard nested day-born cards keep their own member filter links', () => {
  const shell = fs.readFileSync(path.join(__dirname, '..', 'lib', 'shell.js'), 'utf8');
  assert.match(shell, /e\.target\.closest\('\[data-card-href\]'\) !== card/);
});

test('summary stat labels can wrap instead of clipping on small cards', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.hs-label\s*\{[\s\S]*?white-space:\s*normal/);
  assert.match(css, /\.hs-label\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
});

test('state-changing POST without a CSRF token is rejected (403)', async () => {
  const r = await post('/members', { first_name: 'No', last_name: 'Token' });
  assert.strictEqual(r.status, 403);
});

test('a member can be created and shows in the directory', async () => {
  const form = await get('/members/new');
  const token = tokenFrom(form.body);
  assert.ok(token);
  const created = await post('/members', {
    first_name: 'Grace', last_name: 'Tester', membership_status: 'member',
    mobile_phone: '0200000000', day_born: 'Friday', gender: 'F', preferred_channel: 'none', _csrf: token,
  });
  assert.strictEqual(created.status, 302);
  const list = await get('/members');
  assert.match(list.body, /Grace<\/a>|Grace Tester|Grace/);
  assert.match(list.body, /Members Directory/);
  assert.match(list.body, /Day Name/);
  assert.match(list.body, /Akan Names: Afia \/ Kofi/);
  assert.match(list.body, /MoMo ready/);
  assert.match(list.body, /Missing Contact/);
  assert.match(list.body, /Inactive \/ Other/);
});

test('invalid member submission is rejected with a flash message', async () => {
  const form = await get('/members/new');
  const token = tokenFrom(form.body);
  const r = await post('/members', { first_name: '', last_name: '', mobile_phone: '123', _csrf: token });
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /\/members\/new/);
  const back = await get('/members/new');
  assert.match(back.body, /First name is required/);
});

test('negative finance amount is rejected', async () => {
  const form = await get('/finance/services');
  const token = tokenFrom(form.body);
  const r = await post('/finance/services', {
    service_type_id: '1', service_date: '2025-01-05', total_amount: '-50', _csrf: token,
  });
  assert.strictEqual(r.status, 302);
  const back = await get('/finance/services');
  assert.match(back.body, /Amount must be a number of 0 or more/);
});

test('finance write routes post balanced ledger entries', async () => {
  const memberForm = await get('/members/new');
  const memberCreated = await post('/members', {
    first_name: 'Ledger', last_name: 'Tester', membership_status: 'member',
    mobile_phone: '0200001111', gender: 'F', preferred_channel: 'none',
    _csrf: tokenFrom(memberForm.body),
  });
  assert.strictEqual(memberCreated.status, 302);
  const member = db.prepare(`SELECT member_id FROM members WHERE first_name='Ledger' AND last_name='Tester'`).get();
  assert.ok(member);

  const services = await get('/finance/services');
  const servicePosted = await post('/finance/services', {
    service_type_id: '1',
    service_date: '2026-06-07',
    total_amount: '120',
    _csrf: tokenFrom(services.body),
  });
  assert.strictEqual(servicePosted.status, 302);
  const serviceId = Number((servicePosted.location || '').match(/\/finance\/services\/(\d+)/)[1]);

  const tithes = await get('/finance/tithes');
  const tithePosted = await post('/finance/tithes', {
    member_id: String(member.member_id),
    tithe_date: '2026-06-08',
    amount: '45',
    method: 'cash',
    _csrf: tokenFrom(tithes.body),
  });
  assert.strictEqual(tithePosted.status, 302);

  const special = await get('/finance/special');
  const specialPosted = await post('/finance/special', {
    special_cat_id: '1',
    offering_date: '2026-06-09',
    donor_id: String(member.member_id),
    amount: '35',
    purpose: 'Ledger test',
    _csrf: tokenFrom(special.body),
  });
  assert.strictEqual(specialPosted.status, 302);

  const harvests = await get('/finance/harvests');
  const harvestPosted = await post('/finance/harvests', {
    harvest_type: 'Other',
    harvest_year: '2026',
    harvest_name: 'Ledger Test Harvest',
    harvest_date: '2026-06-10',
    total_collected: '0',
    _csrf: tokenFrom(harvests.body),
  });
  assert.strictEqual(harvestPosted.status, 302);
  const harvest = db.prepare(`SELECT harvest_id FROM harvests WHERE harvest_name='Ledger Test Harvest'`).get();
  assert.ok(harvest);

  const pledges = await get('/finance/pledges');
  const pledgePosted = await post('/finance/pledges', {
    member_id: String(member.member_id),
    harvest_id: String(harvest.harvest_id),
    pledged_amount: '100',
    paid_amount: '0',
    pledge_date: '2026-06-10',
    _csrf: tokenFrom(pledges.body),
  });
  assert.strictEqual(pledgePosted.status, 302);
  const pledge = db.prepare(`SELECT pledge_id FROM pledges WHERE member_id=? AND harvest_id=?`).get(member.member_id, harvest.harvest_id);
  assert.ok(pledge);
  const pledgePaid = await post(`/finance/pledges/${pledge.pledge_id}/pay`, {
    add: '25',
    _csrf: tokenFrom((await get('/finance/pledges')).body),
  });
  assert.strictEqual(pledgePaid.status, 302);

  const fundsForm = await get('/finance/funds');
  assert.strictEqual(fundsForm.status, 200);
  assert.match(fundsForm.body, /Funds/);
  const fundCreated = await post('/finance/funds', {
    code: 'BLDG',
    name: 'Building Test Fund',
    fund_type: 'BUILDING',
    opening_balance: '75',
    responsible_officer: 'Finance Steward',
    restricted: '1',
    _csrf: tokenFrom(fundsForm.body),
  });
  assert.strictEqual(fundCreated.status, 302);
  const fund = db.prepare(`SELECT * FROM funds WHERE code='BLDG'`).get();
  assert.ok(fund);
  assert.strictEqual(fund.restricted, 1);

  const incomeForm = await get('/finance/income');
  assert.strictEqual(incomeForm.status, 200);
  assert.match(incomeForm.body, /Generic Income/);
  const incomePosted = await post('/finance/income', {
    transaction_date: '2026-06-11',
    category: 'donation',
    subcategory: 'Thanksgiving',
    member_id: String(member.member_id),
    amount: '55',
    payment_method: 'Cash',
    fund_id: String(fund.fund_id),
    description: 'Generic income smoke test',
    _csrf: tokenFrom(incomeForm.body),
  });
  assert.strictEqual(incomePosted.status, 302);
  assert.match(incomePosted.location || '', /\/finance\/receipts\/DMC-RCT-2026-\d{5}\/print/);
  const income = db.prepare(`SELECT * FROM income_records WHERE description='Generic income smoke test'`).get();
  assert.ok(income && income.journal_entry_id);
  assert.match(income.receipt_number, /^DMC-RCT-2026-\d{5}$/);
  assert.ok(db.prepare(`SELECT receipt_id FROM finance_receipts WHERE receipt_number=?`).get(income.receipt_number));
  const incomeReceipt = await get(`/finance/receipts/${income.receipt_number}/print`);
  assert.strictEqual(incomeReceipt.status, 200);
  assert.match(incomeReceipt.body, /Official Income Receipt/);
  assert.match(incomeReceipt.body, /Generic income smoke test/);

  const dayBornForm = await get('/finance/day-borns');
  assert.strictEqual(dayBornForm.status, 200);
  assert.match(dayBornForm.body, /Record day-born collection/);
  const dayBornPosted = await post('/finance/day-borns', {
    collection_date: '2026-06-11',
    day_born: 'Friday',
    amount: '33',
    head_count: '7',
    payment_method: 'Cash',
    fund_id: String(fund.fund_id),
    notes: 'Standalone day-born smoke test',
    _csrf: tokenFrom(dayBornForm.body),
  });
  assert.strictEqual(dayBornPosted.status, 302);
  const dayBorn = db.prepare(`SELECT * FROM day_born_collections WHERE notes='Standalone day-born smoke test'`).get();
  assert.ok(dayBorn && dayBorn.journal_entry_id);
  assert.match(dayBorn.receipt_number, /^DMC-RCT-2026-\d{5}$/);

  const settingsPage = await get('/finance/settings');
  assert.strictEqual(settingsPage.status, 200);
  assert.match(settingsPage.body, /Finance settings/);
  assert.match(settingsPage.body, /DMC-RCT/);

  const fundsPage = await get('/finance/funds');
  assert.match(fundsPage.body, /Building Test Fund/);
  assert.match(fundsPage.body, /Restricted/);
  assert.match(fundsPage.body, /finance\/reports\/funds\.csv/);
  const fundReport = await get('/finance/reports/funds');
  assert.strictEqual(fundReport.status, 200);
  assert.match(fundReport.body, /Fund Report/);
  assert.match(fundReport.body, /Building Test Fund/);
  const fundCsv = await get('/finance/reports/funds.csv');
  assert.strictEqual(fundCsv.status, 200);
  assert.match(fundCsv.contentType, /csv/);
  assert.match(fundCsv.body, /Building Test Fund/);

  const projectsForm = await get('/finance/projects');
  assert.strictEqual(projectsForm.status, 200);
  assert.match(projectsForm.body, /Projects &amp; Campaigns|Projects & Campaigns/);
  const projectPosted = await post('/finance/projects', {
    name: 'Roof Replacement',
    status: 'ACTIVE',
    fund_id: String(fund.fund_id),
    target_amount: '500',
    responsible_officer: 'Finance Steward',
    description: 'Replace chapel roof',
    _csrf: tokenFrom(projectsForm.body),
  });
  assert.strictEqual(projectPosted.status, 302);
  const project = db.prepare(`SELECT * FROM finance_projects WHERE name='Roof Replacement'`).get();
  assert.ok(project);
  assert.strictEqual(project.fund_id, fund.fund_id);

  const expenses = await get('/finance/expenses');
  const expensePosted = await post('/finance/expenses', {
    expense_cat_id: '1',
    spent_on: '2026-06-11',
    amount: '30',
    payment_method: 'Cash',
    fund_id: String(fund.fund_id),
    project_id: String(project.project_id),
    description: 'Ledger test expense',
    _csrf: tokenFrom(expenses.body),
  });
  assert.strictEqual(expensePosted.status, 302);
  const expense = db.prepare(`SELECT expense_id, journal_entry_id, project_id FROM expenses WHERE description='Ledger test expense'`).get();
  assert.ok(expense && expense.journal_entry_id);
  assert.strictEqual(expense.project_id, project.project_id);
  const voucher = db.prepare(`SELECT * FROM payment_vouchers WHERE expense_id=?`).get(expense.expense_id);
  assert.ok(voucher);
  assert.match(voucher.voucher_no, /^DMC-PV-2026-\d{4}$/);
  assert.match(voucher.amount_in_words, /Ghana Cedis/);

  const projectsPage = await get('/finance/projects');
  assert.match(projectsPage.body, /Roof Replacement/);
  assert.match(projectsPage.body, /GHS|GH₵|30\.00/);
  assert.match(projectsPage.body, new RegExp(`/finance/projects/${project.project_id}`));
  assert.match(projectsPage.body, /finance\/projects\.csv/);
  const projectsCsv = await get('/finance/projects.csv');
  assert.strictEqual(projectsCsv.status, 200);
  assert.match(projectsCsv.contentType, /csv/);
  assert.match(projectsCsv.body, /Roof Replacement/);
  const projectDetail = await get(`/finance/projects/${project.project_id}`);
  assert.strictEqual(projectDetail.status, 200);
  assert.match(projectDetail.body, /Project Profile/);
  assert.match(projectDetail.body, /Linked Expenses/);
  assert.match(projectDetail.body, /Ledger test expense/);

  const budgetsForm = await get('/finance/budgets');
  assert.strictEqual(budgetsForm.status, 200);
  assert.match(budgetsForm.body, /Budgets/);
  assert.match(budgetsForm.body, /finance\/budgets\.csv/);
  const budgetPosted = await post('/finance/budgets', {
    name: '2026 Test Budget',
    year: '2026',
    scope: 'ANNUAL',
    notes: 'Smoke test budget',
    _csrf: tokenFrom(budgetsForm.body),
  });
  assert.strictEqual(budgetPosted.status, 302);
  const budgetId = Number((budgetPosted.location || '').match(/\/finance\/budgets\/(\d+)/)[1]);
  const budgetPage = await get(`/finance/budgets/${budgetId}`);
  assert.strictEqual(budgetPage.status, 200);
  const expenseAccount = db.prepare(`SELECT account_id FROM accounts WHERE code='5000'`).get();
  const budgetLinePosted = await post(`/finance/budgets/${budgetId}/lines`, {
    line_type: 'EXPENSE',
    category: 'Utilities',
    expense_account_id: String(expenseAccount.account_id),
    fund_id: String(fund.fund_id),
    amount: '100',
    _csrf: tokenFrom(budgetPage.body),
  });
  assert.strictEqual(budgetLinePosted.status, 302);
  const budgetActuals = await get(`/finance/budgets/${budgetId}`);
  assert.match(budgetActuals.body, /Budget vs Actual/);
  assert.match(budgetActuals.body, /Utilities/);
  assert.match(budgetActuals.body, /100\.00/);
  assert.match(budgetActuals.body, /30\.00/);
  assert.match(budgetActuals.body, /Edit/);
  assert.match(budgetActuals.body, /Delete/);
  assert.match(budgetActuals.body, new RegExp(`/finance/budgets/${budgetId}\\.csv`));
  const budgetsCsv = await get('/finance/budgets.csv');
  assert.strictEqual(budgetsCsv.status, 200);
  assert.match(budgetsCsv.contentType, /csv/);
  assert.match(budgetsCsv.body, /2026 Test Budget/);
  const budgetLinesCsv = await get(`/finance/budgets/${budgetId}.csv`);
  assert.strictEqual(budgetLinesCsv.status, 200);
  assert.match(budgetLinesCsv.contentType, /csv/);
  assert.match(budgetLinesCsv.body, /Utilities/);
  const budgetLine = db.prepare(`SELECT line_id FROM finance_budget_lines WHERE budget_id=? AND category='Utilities'`).get(budgetId);
  assert.ok(budgetLine);
  const budgetLineEdit = await get(`/finance/budgets/${budgetId}/lines/${budgetLine.line_id}/edit`);
  assert.strictEqual(budgetLineEdit.status, 200);
  assert.match(budgetLineEdit.body, /Edit budget line/);
  const budgetLineEdited = await post(`/finance/budgets/${budgetId}/lines/${budgetLine.line_id}/edit`, {
    line_type: 'EXPENSE',
    category: 'Utilities Updated',
    expense_account_id: String(expenseAccount.account_id),
    fund_id: String(fund.fund_id),
    amount: '150',
    _csrf: tokenFrom(budgetLineEdit.body),
  });
  assert.strictEqual(budgetLineEdited.status, 302);
  const budgetAfterLineEdit = await get(`/finance/budgets/${budgetId}`);
  assert.match(budgetAfterLineEdit.body, /Utilities Updated/);
  assert.match(budgetAfterLineEdit.body, /150\.00/);
  const deletedLine = await post(`/finance/budgets/${budgetId}/lines/${budgetLine.line_id}/delete`, {
    _csrf: tokenFrom(budgetAfterLineEdit.body),
  });
  assert.strictEqual(deletedLine.status, 302);
  const budgetAfterLineDelete = await get(`/finance/budgets/${budgetId}`);
  assert.doesNotMatch(budgetAfterLineDelete.body, /Utilities Updated/);

  const vouchersPage = await get('/finance/vouchers');
  assert.strictEqual(vouchersPage.status, 200);
  assert.match(vouchersPage.body, /Payment Vouchers/);
  assert.match(vouchersPage.body, new RegExp(voucher.voucher_no));
  assert.match(vouchersPage.body, /finance\/vouchers\.csv/);
  const vouchersCsv = await get('/finance/vouchers.csv');
  assert.strictEqual(vouchersCsv.status, 200);
  assert.match(vouchersCsv.contentType, /csv/);
  assert.match(vouchersCsv.body, new RegExp(voucher.voucher_no));
  const voucherPrint = await get(`/finance/vouchers/${voucher.voucher_id}/print`);
  assert.strictEqual(voucherPrint.status, 200);
  assert.match(voucherPrint.body, /Payment Voucher/);
  assert.match(voucherPrint.body, /Ledger test expense/);
  assert.match(voucherPrint.body, /Ghana Cedis/);

  const linkedRows = db.prepare(`
    SELECT 'services' table_name, COUNT(*) c FROM services WHERE journal_entry_id IS NOT NULL AND service_date='2026-06-07'
    UNION ALL SELECT 'tithes', COUNT(*) FROM tithes WHERE journal_entry_id IS NOT NULL AND member_id=?
    UNION ALL SELECT 'special', COUNT(*) FROM special_offerings WHERE journal_entry_id IS NOT NULL AND purpose='Ledger test'
    UNION ALL SELECT 'pledge_payments', COUNT(*) FROM pledge_payments WHERE journal_entry_id IS NOT NULL AND pledge_id=?
    UNION ALL SELECT 'income_records', COUNT(*) FROM income_records WHERE journal_entry_id IS NOT NULL AND description='Generic income smoke test'
    UNION ALL SELECT 'day_born_collections', COUNT(*) FROM day_born_collections WHERE journal_entry_id IS NOT NULL AND notes='Standalone day-born smoke test'
    UNION ALL SELECT 'expenses', COUNT(*) FROM expenses WHERE journal_entry_id IS NOT NULL AND description='Ledger test expense'
  `).all(member.member_id, pledge.pledge_id);
  assert.deepStrictEqual(Object.fromEntries(linkedRows.map((r) => [r.table_name, r.c])), {
    services: 1,
    tithes: 1,
    special: 1,
    pledge_payments: 1,
    income_records: 1,
    day_born_collections: 1,
    expenses: 1,
  });

  const service = db.prepare(`SELECT journal_entry_id FROM services WHERE service_id=?`).get(serviceId);
  assert.ok(service && service.journal_entry_id);
  const serviceDetail = await get(`/finance/services/${serviceId}`);
  assert.match(serviceDetail.body, new RegExp(`<form[^>]+action="/finance/services/${serviceId}/delete"[\\s\\S]*name="_csrf"`));
  const serviceDeleted = await post(`/finance/services/${serviceId}/delete`, { _csrf: tokenFrom(serviceDetail.body) });
  assert.strictEqual(serviceDeleted.status, 302);
  assert.strictEqual(db.prepare(`SELECT status FROM journal_entries WHERE entry_id=?`).get(service.journal_entry_id).status, 'REVERSED');
  assert.ok(db.prepare(`SELECT entry_id FROM journal_entries WHERE reverses_id=?`).get(service.journal_entry_id));

  const expenseEdit = await get(`/finance/expenses/${expense.expense_id}/edit`);
  assert.match(expenseEdit.body, /Approval History/);
  const expenseEdited = await post(`/finance/expenses/${expense.expense_id}/edit`, {
    expense_cat_id: '1',
    spent_on: '2026-06-12',
    amount: '40',
    payment_method: 'Cash',
    fund_id: String(fund.fund_id),
    project_id: String(project.project_id),
    description: 'Ledger test expense edited',
    _csrf: tokenFrom(expenseEdit.body),
  });
  assert.strictEqual(expenseEdited.status, 302);
  const editedExpense = db.prepare(`SELECT journal_entry_id FROM expenses WHERE expense_id=?`).get(expense.expense_id);
  assert.ok(editedExpense.journal_entry_id);
  assert.notStrictEqual(editedExpense.journal_entry_id, expense.journal_entry_id);
  assert.strictEqual(db.prepare(`SELECT status FROM journal_entries WHERE entry_id=?`).get(expense.journal_entry_id).status, 'REVERSED');
  assert.strictEqual(db.prepare(`SELECT status FROM journal_entries WHERE entry_id=?`).get(editedExpense.journal_entry_id).status, 'POSTED');
  const editedVoucher = db.prepare(`SELECT * FROM payment_vouchers WHERE expense_id=?`).get(expense.expense_id);
  assert.strictEqual(editedVoucher.voucher_id, voucher.voucher_id);
  assert.match(editedVoucher.amount_in_words, /Forty Ghana Cedis/);
  const editedVoucherPrint = await get(`/finance/vouchers/${voucher.voucher_id}/print`);
  assert.match(editedVoucherPrint.body, /Ledger test expense edited/);
  assert.match(editedVoucherPrint.body, /Forty Ghana Cedis/);
  const approvalChanged = await post(`/finance/expenses/${expense.expense_id}/status`, {
    status: 'APPROVED',
    _csrf: tokenFrom((await get('/finance/expenses')).body),
  });
  assert.strictEqual(approvalChanged.status, 302);
  assert.strictEqual(
    db.prepare(`SELECT approval_status FROM expenses WHERE expense_id=?`).get(expense.expense_id).approval_status,
    'APPROVED'
  );

  const unbalanced = db.prepare(`
    SELECT je.entry_id
    FROM journal_entries je JOIN journal_lines jl USING(entry_id)
    GROUP BY je.entry_id
    HAVING ROUND(SUM(jl.debit), 2) != ROUND(SUM(jl.credit), 2)
  `).all();
  assert.deepStrictEqual(unbalanced, []);

  const accounting = await get('/finance/accounting');
  assert.strictEqual(accounting.status, 200);
  assert.match(accounting.body, /Fund Balances/);
  assert.match(accounting.body, /Trial Balance/);
  assert.match(accounting.body, /General Ledger/);
  assert.match(accounting.body, /Balanced/);
  assert.match(accounting.body, /JV-2026-/);
  assert.match(accounting.body, /trial-balance\.csv/);
  assert.match(accounting.body, /ledger\.csv/);
  const trialCsv = await get('/finance/accounting/trial-balance.csv');
  assert.strictEqual(trialCsv.status, 200);
  assert.match(trialCsv.contentType, /csv/);
  assert.match(trialCsv.body, /Cash in hand/);
  const ledgerCsv = await get('/finance/accounting/ledger.csv');
  assert.strictEqual(ledgerCsv.status, 200);
  assert.match(ledgerCsv.contentType, /csv/);
  assert.match(ledgerCsv.body, /JV-2026-/);

  const receiptsPage = await get('/finance/receipts');
  assert.strictEqual(receiptsPage.status, 200);
  assert.match(receiptsPage.body, /Printable income receipts/);
  assert.match(receiptsPage.body, new RegExp(income.receipt_number));

  const incomeReport = await get('/reports/income?start=2026-06-01&end=2026-06-30');
  assert.strictEqual(incomeReport.status, 200);
  assert.match(incomeReport.body, /Income by category/);
  assert.match(incomeReport.body, /Generic Income/);
  assert.match(incomeReport.body, /Day-Born Collection/);
  const incomeReportCsv = await get('/reports/income.csv?start=2026-06-01&end=2026-06-30');
  assert.strictEqual(incomeReportCsv.status, 200);
  assert.match(incomeReportCsv.contentType, /csv/);
  assert.match(incomeReportCsv.body, /Thanksgiving/);

  const expenseDetail = await get('/reports/expense-detail?start=2026-06-01&end=2026-06-30');
  assert.strictEqual(expenseDetail.status, 200);
  assert.match(expenseDetail.body, /Expenses by category/);
  assert.match(expenseDetail.body, /Ledger test expense/);
  const reportFunds = await get('/reports/funds');
  assert.strictEqual(reportFunds.status, 200);
  assert.match(reportFunds.body, /Fund movement/);
  assert.match(reportFunds.body, /Building Test Fund/);

  const financeDashboard = await get('/finance');
  assert.strictEqual(financeDashboard.status, 200);
  assert.match(financeDashboard.body, /Income this month/);
  assert.match(financeDashboard.body, /Expenses this month/);
  assert.match(financeDashboard.body, /Net this month/);
  assert.match(financeDashboard.body, /unpaid pledges/);
  assert.match(financeDashboard.body, /Top Funds/);
  assert.match(financeDashboard.body, /Recent Vouchers/);
  assert.match(financeDashboard.body, /Budget Overspending Warnings/);
});

test('bulk export of selected members returns CSV', async () => {
  const list = await get('/members');
  const m = list.body.match(/class="bulk-box" value="(\d+)"/);
  assert.ok(m, 'members list should expose selectable checkboxes');
  const token = tokenFrom(list.body);
  const res = await fetch(base + '/members/bulk', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ member_ids: m[1], action: 'export', _csrf: token }).toString(),
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /csv/);
  assert.match(await res.text(), /Member ID,First name/);
});

test('live-search and bulk markup is present on the members page', async () => {
  const r = await get('/members');
  assert.match(r.body, /data-live-search/);
  assert.match(r.body, /data-results/);
  assert.match(r.body, /class="bulk-bar"/);
});

test('member drill-down filters and profile timeline render', async () => {
  const birthdayFiltered = await get('/members?birthday=week');
  assert.strictEqual(birthdayFiltered.status, 200);
  assert.match(birthdayFiltered.body, /Birthdays this week/);
  const member = db.prepare(`SELECT member_id FROM members WHERE deleted_at IS NULL ORDER BY member_id LIMIT 1`).get();
  assert.ok(member);
  const profile = await get(`/members/${member.member_id}`);
  assert.strictEqual(profile.status, 200);
  assert.match(profile.body, /Member timeline/);
  assert.match(profile.body, /Giving and pledges/);
});

test('giving statement pages render', async () => {
  const idx = await get('/finance/statements');
  assert.strictEqual(idx.status, 200);
  assert.match(idx.body, /Giving Statements/);
  const stmt = await get('/members/1/statement');
  assert.strictEqual(stmt.status, 200);
  assert.match(stmt.body, /Annual Giving Statement/);
});

test('backups page renders and a backup can be created', async () => {
  const page = await get('/backups');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Backups &amp; Restore/);
  assert.match(page.body, /Command Center/);
  const token = tokenFrom(page.body);
  const r = await post('/backups/create', { _csrf: token });
  assert.strictEqual(r.status, 302);
  const after = await get('/backups');
  assert.match(after.body, /church-\d+\.db/);
  assert.match(after.body, /Off-site Upload/);
  assert.match(after.body, />Verify<\/button>/);
  const m = after.body.match(/\/backups\/(church-\d+\.db)\/verify/);
  assert.ok(m, 'backup list should expose a verify action');
  const verified = await post(`/backups/${m[1]}/verify`, { _csrf: tokenFrom(after.body) });
  assert.strictEqual(verified.status, 302);
  const verifiedPage = await get('/backups');
  assert.match(verifiedPage.body, /Backup verified:/);
});

test('events calendar renders', async () => {
  const r = await get('/events/calendar');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Events Calendar/);
});

test('public RSVP link rejects an unknown token', async () => {
  const r = await get('/rsvp/deadbeef');
  assert.strictEqual(r.status, 404);
});

test('editor role can edit content but is blocked from owner areas', async () => {
  // As the owner (dunwelladmin from setup), create an editor account.
  const form = await get('/users/new');
  const token = tokenFrom(form.body);
  const made = await post('/users', { username: 'editor1', display_name: 'Ed', password: 'editorpass1', role: 'editor', _csrf: token });
  assert.strictEqual(made.status, 302);
  const owner = cookie;
  // Log in as the editor (fresh session).
  cookie = undefined;
  const lp = await get('/login');
  const li = await post('/login', { username: 'editor1', password: 'editorpass1', _csrf: tokenFrom(lp.body) });
  assert.strictEqual(li.status, 302);
  const newMember = await get('/members/new');
  assert.strictEqual(newMember.status, 200);           // editor can edit content
  const emailSettings = await get('/communications/email-settings');
  assert.strictEqual(emailSettings.status, 403);       // but not admin-only email settings
  const backups = await get('/backups');
  assert.strictEqual(backups.status, 403);             // but not owner-only areas
  const operations = await get('/operations');
  assert.strictEqual(operations.status, 403);
  cookie = owner;
});

test('finance auditor can review accounting but cannot record transactions', async () => {
  const form = await get('/users/new');
  const made = await post('/users', {
    username: 'auditor1',
    display_name: 'Auditor',
    password: 'auditorpass1',
    role: 'viewer',
    finance_role: 'auditor',
    _csrf: tokenFrom(form.body),
  });
  assert.strictEqual(made.status, 302);
  const owner = cookie;

  cookie = undefined;
  const lp = await get('/login');
  const li = await post('/login', { username: 'auditor1', password: 'auditorpass1', _csrf: tokenFrom(lp.body) });
  assert.strictEqual(li.status, 302);

  const accounting = await get('/finance/accounting');
  assert.strictEqual(accounting.status, 200);
  assert.match(accounting.body, /Trial Balance/);

  const vouchers = await get('/finance/vouchers');
  assert.strictEqual(vouchers.status, 200);
  assert.match(vouchers.body, /Payment Vouchers/);

  const funds = await get('/finance/funds');
  assert.strictEqual(funds.status, 200);
  assert.doesNotMatch(funds.body, /\+ Add a fund/);
  const fundReport = await get('/finance/reports/funds');
  assert.strictEqual(fundReport.status, 200);
  const profileForToken = await get('/profile');
  const blockedFund = await post('/finance/funds', {
    code: 'AUD',
    name: 'Auditor Fund',
    fund_type: 'GENERAL',
    opening_balance: '0',
    _csrf: tokenFrom(profileForToken.body),
  });
  assert.strictEqual(blockedFund.status, 403);

  const profile = profileForToken;
  assert.match(profile.body, /Auditor/);
  const blocked = await post('/finance/expenses', {
    expense_cat_id: '1',
    spent_on: '2026-06-13',
    amount: '10',
    payment_method: 'Cash',
    description: 'Blocked auditor expense',
    _csrf: tokenFrom(profile.body),
  });
  assert.strictEqual(blocked.status, 403);

  cookie = owner;
});

test('delete-all tools are restricted and permanently delete the selected menu data', async () => {
  const inv = await get('/inventory');
  assert.strictEqual(inv.status, 200);
  assert.match(inv.body, /Delete all/);
  const cat = await post('/inventory/categories', {
    name: 'Delete Scope Test',
    _csrf: tokenFrom(inv.body),
  });
  assert.strictEqual(cat.status, 302);
  const invWithCat = await get('/inventory');
  const item = await post('/inventory', {
    name: 'Delete Scope Keyboard',
    quantity: '1',
    category: 'Delete Scope Test',
    _csrf: tokenFrom(invWithCat.body),
  });
  assert.strictEqual(item.status, 302);
  assert.ok(db.prepare(`SELECT item_id FROM inventory_items WHERE name='Delete Scope Keyboard'`).get());

  const confirmPage = await get('/delete-all/inventory');
  assert.strictEqual(confirmPage.status, 200);
  assert.match(confirmPage.body, /DELETE ALL INVENTORY/);
  assert.match(confirmPage.body, /inventory_items/);
  const wrong = await post('/delete-all/inventory', {
    confirm_phrase: 'delete inventory',
    _csrf: tokenFrom(confirmPage.body),
  });
  assert.strictEqual(wrong.status, 302);
  assert.ok(db.prepare(`SELECT item_id FROM inventory_items WHERE name='Delete Scope Keyboard'`).get());

  const confirmAgain = await get('/delete-all/inventory');
  const backupsBeforeDelete = fs.existsSync(TMP_BACKUPS)
    ? fs.readdirSync(TMP_BACKUPS).filter((name) => /^church-\d+\.db$/.test(name)).length
    : 0;
  const deleted = await post('/delete-all/inventory', {
    confirm_phrase: 'DELETE ALL INVENTORY',
    reason: 'smoke test',
    _csrf: tokenFrom(confirmAgain.body),
  });
  assert.strictEqual(deleted.status, 302);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM inventory_items`).get().c, 0);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM inventory_categories`).get().c, 0);
  const backupsAfterDelete = fs.readdirSync(TMP_BACKUPS).filter((name) => /^church-\d+\.db$/.test(name)).length;
  assert.strictEqual(backupsAfterDelete, backupsBeforeDelete + 1);
  assert.ok(db.prepare(`SELECT audit_id FROM security_audit_log WHERE event='pre_delete_backup_created'`).get());
  db.prepare(`INSERT INTO inventory_categories (name) VALUES ('Audio-Visual / Media')`).run();

  const form = await get('/users/new');
  const made = await post('/users', {
    username: 'steward1',
    display_name: 'Steward',
    password: 'stewardpass1',
    role: 'viewer',
    finance_role: 'treasurer',
    _csrf: tokenFrom(form.body),
  });
  assert.strictEqual(made.status, 302);
  const owner = cookie;
  cookie = undefined;
  const lp = await get('/login');
  const li = await post('/login', { username: 'steward1', password: 'stewardpass1', _csrf: tokenFrom(lp.body) });
  assert.strictEqual(li.status, 302);
  const stewardPage = await get('/delete-all/inventory');
  assert.strictEqual(stewardPage.status, 200);
  assert.match(stewardPage.body, /Delete all Inventory/);
  cookie = owner;
});

test('inventory (extracted route module) can add and list an item', async () => {
  const page = await get('/inventory');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Inventory/);
  assert.match(page.body, /Command Center/);
  assert.match(page.body, />Audio-Visual \/ Media<\/option>/);
  assert.match(page.body, /Date of purchase\/Donated/);
  const cat = await post('/inventory/categories', { name: 'Instruments', _csrf: tokenFrom(page.body) });
  assert.strictEqual(cat.status, 302);
  const withCategory = await get('/inventory');
  assert.match(withCategory.body, /Create inventory category/);
  assert.match(withCategory.body, />Instruments<\/option>/);
  const token = tokenFrom(page.body);
  const created = await post('/inventory', { name: 'Keyboard', quantity: '2', category: 'Instruments', _csrf: token });
  assert.strictEqual(created.status, 302);
  const after = await get('/inventory');
  assert.match(after.body, /Keyboard/);
  assert.match(after.body, /Instruments/);
  assert.match(after.body, /Purchase \/ Donation Date/);
});

test('bible classes (extracted route module) can add and list a class', async () => {
  const page = await get('/bible-classes');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Bible Classes/);
  const created = await post('/bible-classes', { name: 'Adonai Class', _csrf: tokenFrom(page.body) });
  assert.strictEqual(created.status, 302);
  const after = await get('/bible-classes');
  assert.match(after.body, /Adonai Class/);
});

test('organizations (extracted route module) lists, creates, and shows detail', async () => {
  const page = await get('/organizations');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Organizations/);
  assert.match(page.body, /Church Choir/);            // seeded default org
  assert.match(page.body, /Girl&#39;s Fellowship/);
  assert.match(page.body, /Ushers/);
  const created = await post('/organizations', { name: 'Prayer Tower', _csrf: tokenFrom(page.body) });
  assert.strictEqual(created.status, 302);
  const after = await get('/organizations');
  assert.match(after.body, /Prayer Tower/);
  const detail = await get('/organizations/1');
  assert.strictEqual(detail.status, 200);
  assert.match(detail.body, /Roster/);
});

test('finance services includes Friday Service', async () => {
  const page = await get('/finance/services');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Friday Service/);
});

test('events (extracted route module) list/create/detail work', async () => {
  const form = await get('/events/new');
  const created = await post('/events', {
    title: 'Sunday Service', event_type: 'service', starts_at: '2026-06-01T09:00', _csrf: tokenFrom(form.body),
  });
  assert.strictEqual(created.status, 302);
  const list = await get('/events');
  assert.strictEqual(list.status, 200);            // regression guard: list uses ICON_EYE
  assert.match(list.body, /Sunday Service/);
  assert.match(list.body, /Command Center/);
  const cal = await get('/events/calendar');
  assert.strictEqual(cal.status, 200);
});

test('attendance dashboard includes insights and CSV export', async () => {
  const page = await get('/attendance');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Last service change/);
  assert.match(page.body, /href="\/attendance\.csv"/);
  const csv = await get('/attendance.csv');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.contentType, /csv/);
  assert.match(csv.body, /Date,Title,Location,Men,Women,Children,Total/);
});

test('broadcasts can target a single selected member', async () => {
  const memberForm = await get('/members/new');
  const created = await post('/members', {
    first_name: 'Solo', last_name: 'Message', membership_status: 'member',
    mobile_phone: '0244123456', email: 'solo@example.com', gender: 'M',
    preferred_channel: 'either', _csrf: tokenFrom(memberForm.body),
  });
  assert.strictEqual(created.status, 302);

  const members = await get('/members?q=Solo');
  const m = members.body.match(/href="\/members\/(\d+)">Solo Message/);
  assert.ok(m, 'new single-recipient member should be listed');

  const broadcast = await get(`/communications/broadcast?member_id=${m[1]}`);
  assert.strictEqual(broadcast.status, 200);
  assert.match(broadcast.body, /Single member SMS\/email/);
  assert.match(broadcast.body, /Solo Message/);
  assert.match(broadcast.body, /Both \(1 SMS · 1 email\)/);

  const sent = await post('/communications/broadcast', {
    member_id: m[1], channel: 'both', subject: 'Hello Solo', body: 'Private update',
    _csrf: tokenFrom(broadcast.body),
  });
  assert.strictEqual(sent.status, 302);
  assert.match(sent.location, /\/communications\/broadcasts\/\d+/);

  const detail = await get(sent.location);
  assert.strictEqual(detail.status, 200);
  assert.match(detail.body, /Single member: Solo Message/);
  assert.match(detail.body, /Private update/);
  assert.match(detail.body, /solo@example.com/);
});

test('reports + communications (extracted modules) render and post', async () => {
  assert.strictEqual((await get('/reports')).status, 200);
  assert.strictEqual((await get('/reports/financial')).status, 200);
  const financialCsv = await get('/reports/financial.csv');
  assert.strictEqual(financialCsv.status, 200);
  assert.match(financialCsv.body, /Section,Period\/Month,Income,Expenses,Net/);
  const comms = await get('/communications');
  assert.strictEqual(comms.status, 200);
  assert.match(comms.body, /Command Center/);
  assert.match(comms.body, /Messaging Readiness/);
  assert.match(comms.body, /Failed Recipients/);
  assert.match(comms.body, /SMS provider/);
  assert.match(comms.body, /Email provider/);
  assert.strictEqual((await get('/communications/broadcast')).status, 200);
  const posted = await post('/communications', { title: 'Welcome', body: 'Service 9am', audience: 'all', _csrf: tokenFrom(comms.body) });
  assert.strictEqual(posted.status, 302);
  assert.match((await get('/communications')).body, /Welcome/);
  const reports = await get('/reports');
  assert.match(reports.body, /Quick Exports/);
  assert.match(reports.body, /Service income this month/);
  assert.match(reports.body, /Activity \(7d\)/);
});

test('help page renders with the documentation sections', async () => {
  const page = await get('/help');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Help &amp; Guide|Help &amp;amp; Guide|Help &amp; Guide/);
  assert.match(page.body, /Dashboard/);
  assert.match(page.body, /Attendance/);
});

test('login page links to /forgot, which renders without auth', async () => {
  // sign out to an anonymous session
  const saved = cookie;
  try {
    cookie = undefined;
    const login = await get('/login');
    assert.match(login.body, /class="auth-layout"/);
    assert.match(login.body, /Refined Ministry Operations/);
    assert.match(login.body, /href="\/forgot"/);
    assert.match(login.body, /Forgot password\?/);
    const forgot = await get('/forgot');
    assert.strictEqual(forgot.status, 200);
    assert.match(forgot.body, /Reset your password/);
    assert.match(forgot.body, /Send reset link/);
  } finally {
    cookie = saved;
  }
});

test('anonymous visitors see the trial landing page and can request signup', async () => {
  const saved = cookie;
  try {
    cookie = undefined;
    const landing = await get('/?plan=enterprise');
    assert.strictEqual(landing.status, 200);
    assert.match(landing.body, /Run your church like a pro/);
    assert.match(landing.body, /Keep members, attendance, finance, communications and reports/);
    assert.match(landing.body, /Simple pricing/);
    assert.match(landing.body, /Use a real email address so we can send the verification link/);
    assert.match(landing.body, /value="enterprise" selected/);
    assert.match(landing.body, /href="\/terms"/);
    assert.match(landing.body, /href="\/privacy"/);
    assert.match(landing.body, /href="\/support"/);
    const terms = await get('/terms');
    assert.strictEqual(terms.status, 200);
    assert.match(terms.body, /Terms of Service/);
    const privacy = await get('/privacy');
    assert.strictEqual(privacy.status, 200);
    assert.match(privacy.body, /Privacy Policy/);
    const support = await get('/support');
    assert.strictEqual(support.status, 200);
    assert.match(support.body, /Priority issues/);
    const token = tokenFrom(landing.body);
    assert.ok(token, 'trial signup form should include CSRF token');
    const before = db.prepare(`SELECT COUNT(*) c FROM trial_signups`).get().c;
    const posted = await post('/trial-signup', {
      church_name: 'Grace Chapel',
      contact_name: 'Ama Secretary',
      role: 'Secretary',
      phone: '+233 24 000 0000',
      email: 'office@example.com',
      plan: 'enterprise',
      member_count: '300 - 1000',
      notes: 'Need member import',
      _csrf: token,
    });
    assert.strictEqual(posted.status, 302);
    assert.match(posted.location, /trial=received/);
    const after = db.prepare(`SELECT COUNT(*) c FROM trial_signups`).get().c;
    assert.strictEqual(after, before + 1);
    const row = db.prepare(`SELECT church_name, plan, status, email, activation_token FROM trial_signups ORDER BY signup_id DESC LIMIT 1`).get();
    assert.deepStrictEqual(row, {
      church_name: 'Grace Chapel',
      plan: 'enterprise',
      status: 'invited',
      email: 'office@example.com',
      activation_token: row.activation_token,
    });
    const activation = await get(`/activate/${row.activation_token}`);
    assert.strictEqual(activation.status, 200);
    assert.match(activation.body, /Verify your account/);
    assert.match(activation.body, /Choose a username and password for sign in/);
    const activationToken = tokenFrom(activation.body);
    assert.ok(activationToken, 'activation form should include CSRF token');
    const activated = await post(`/activate/${row.activation_token}`, {
      username: 'gracechapeladmin',
      display_name: 'Grace Chapel Admin',
      password: 'testpass123',
      password2: 'testpass123',
      _csrf: activationToken,
    });
    assert.strictEqual(activated.status, 302);
    assert.strictEqual(activated.location, '/');
    const createdUser = db.prepare(`SELECT username, display_name, role FROM users WHERE username='gracechapeladmin'`).get();
    assert.deepStrictEqual(createdUser, {
      username: 'gracechapeladmin',
      display_name: 'Grace Chapel Admin',
      role: 'admin',
    });
    const activatedRow = db.prepare(`SELECT status, activated_at, activated_user_id FROM trial_signups ORDER BY signup_id DESC LIMIT 1`).get();
    assert.strictEqual(activatedRow.status, 'activated');
    assert.ok(activatedRow.activated_at);
    assert.ok(activatedRow.activated_user_id);
    const home = await get('/');
    assert.strictEqual(home.status, 200);
    assert.match(home.body, /Welcome back/);
  } finally {
    cookie = saved;
  }
});

test('settings test-send tools report dry-run when SMS/email unconfigured', async () => {
  const settings = await get('/settings');
  assert.match(settings.body, /Send a test message/);
  const token = tokenFrom(settings.body);
  const sms = await post('/settings/test-sms', { to: '0244123456', _csrf: token });
  assert.strictEqual(sms.status, 302);
  const after = await get('/settings');
  assert.match(after.body, /dry-run mode/);                 // SMS dry-run notice (no ARKESEL key in tests)
  const bad = await post('/settings/test-sms', { to: 'not-a-phone', _csrf: token });
  assert.strictEqual(bad.status, 302);
  assert.match((await get('/settings')).body, /not a valid phone/);
  const email = await post('/settings/test-email', { to: 'a@b.com', _csrf: token });
  assert.strictEqual(email.status, 302);
  assert.match((await get('/settings')).body, /dry-run mode/);
});

test('email settings page saves non-sensitive config and records test sends', async () => {
  const page = await get('/communications/email-settings');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Email Settings/);
  assert.match(page.body, /Send Test Email/);
  const token = tokenFrom(page.body);
  const saved = await post('/communications/email-settings', {
    provider: 'smtp',
    sender_name: 'Dunwell Methodist',
    sender_email: 'noreply@example.com',
    reply_to_email: 'reply@example.com',
    test_recipient_email: 'test@example.com',
    _csrf: token,
  });
  assert.strictEqual(saved.status, 302);
  const afterSave = await get('/communications/email-settings');
  assert.match(afterSave.body, /noreply@example.com/);
  assert.match(afterSave.body, /test@example.com/);
  const sent = await post('/communications/email-settings/test', {
    recipient: 'test@example.com',
    _csrf: tokenFrom(afterSave.body),
  });
  assert.strictEqual(sent.status, 302);
  const afterSend = await get('/communications/email-settings');
  assert.match(afterSend.body, /test@example.com/);
  assert.match(afterSend.body, /dry run/);
});

test('SMS broadcast send path works (dry-run, all members)', async () => {
  const page = await get('/communications/broadcast');
  assert.strictEqual(page.status, 200);
  const r = await post('/communications/broadcast', {
    channel: 'sms', body: 'Service at 9am', all_members: '1', _csrf: tokenFrom(page.body),
  });
  // Must not 500 — regression guard for the missing normalizePhoneGH dep.
  assert.ok([302, 200].includes(r.status), `expected redirect/ok, got ${r.status}`);
});

test('members import page + template download work for admins', async () => {
  const page = await get('/members/import');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Import members/);
  assert.match(page.body, /Preview import/);
  const tmpl = await get('/members/import/template.csv');
  assert.strictEqual(tmpl.status, 200);
  assert.match(tmpl.body, /first_name,last_name/);
});

test('members import preview exposes rejected rows download for bad CSV data', async () => {
  const page = await get('/members/import');
  const fd = new FormData();
  fd.append('_csrf', tokenFrom(page.body));
  fd.append('csv', new Blob([
    'first_name,last_name,mobile_phone,email\nBad,Row,123,not-an-email\n',
  ], { type: 'text/csv' }), 'bad-members.csv');
  const res = await fetch(base + '/members/import', {
    method: 'POST',
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
    body: fd,
  });
  rememberCookie(res);
  const body = await res.text();
  assert.strictEqual(res.status, 200);
  assert.match(body, /Download rejected rows/);
});

test('unknown route returns a 404 page', async () => {
  const r = await get('/no/such/page');
  assert.strictEqual(r.status, 404);
  assert.match(r.body, /Page not found/);
});

test('the error handler catches a thrown route error, logs it, shows 500', async () => {
  const r = await get('/__throw');
  assert.strictEqual(r.status, 500);
  assert.match(r.body, /Something went wrong/);
  // The owner can then see it in the error log.
  const log = await get('/errors');
  assert.strictEqual(log.status, 200);
  assert.match(log.body, /Error Log/);
  assert.match(log.body, /Command Center/);
  assert.match(log.body, /\/__throw/);
});


test('owner can review security audit events', async () => {
  const audit = await get('/security/audit');
  assert.strictEqual(audit.status, 200);
  assert.match(audit.body, /Security Audit/);
  assert.match(audit.body, /Command Center/);
  assert.match(audit.body, /login_success|user_created|user_role_changed/);
  assert.match(audit.body, /backup_created|backup_verified/);
});

test('owner can review general activity audit', async () => {
  const activity = await get('/activity');
  assert.strictEqual(activity.status, 200);
  assert.match(activity.body, /Activity Audit/);
  assert.match(activity.body, /Recent Activity/);
  assert.match(activity.body, /finance_|member_|announcement|attendance_recorded/);
});

test('operational command centers render for core owner and ministry pages', async () => {
  const pages = [
    '/members',
    '/finance',
    '/preaching',
    '/help',
    '/operations',
    '/users',
    '/profile',
    '/settings',
  ];
  for (const path of pages) {
    const r = await get(path);
    assert.strictEqual(r.status, 200, `${path} should render`);
    assert.match(r.body, /Command Center/, `${path} should use the command center shell`);
  }
});

test('finance quick-action links land on real entry pages', async () => {
  const dashboard = await get('/');
  assert.strictEqual(dashboard.status, 200);
  assert.match(dashboard.body, /href="\/finance\/services"/);
  assert.doesNotMatch(dashboard.body, /href="\/finance\/services\/new"/);

  const finance = await get('/finance');
  assert.strictEqual(finance.status, 200);
  assert.match(finance.body, /href="\/finance\/services"/);
  assert.match(finance.body, /href="\/finance\/special"/);
  assert.match(finance.body, /href="\/finance\/expenses"/);
  assert.doesNotMatch(finance.body, /href="\/finance\/(?:services|special|expenses)\/new"/);

  const redirects = [
    ['/finance/services/new', '/finance/services'],
    ['/finance/special/new', '/finance/special'],
    ['/finance/expenses/new', '/finance/expenses'],
  ];
  for (const [from, to] of redirects) {
    const r = await get(from);
    assert.strictEqual(r.status, 302, `${from} should redirect`);
    assert.strictEqual(r.location, to);
  }
});

test('operations page summarizes production readiness signals', async () => {
  const page = await get('/operations');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Operations/);
  assert.match(page.body, /Operational Checks/);
  assert.match(page.body, /Database readiness/);
  assert.match(page.body, /Tenant plan limits/);
  assert.match(page.body, /Backup verification/);
  assert.match(page.body, /Alert routing/);
  assert.match(page.body, /Off-site backup upload/);
  assert.match(page.body, /docs\/OPERATIONS_RUNBOOK.md/);
  assert.match(page.body, /operations\/health-report\.txt/);
  const report = await get('/operations/health-report.txt');
  assert.strictEqual(report.status, 200);
  assert.match(report.contentType, /text\/plain/);
  assert.match(report.body, /Unbalanced journals/);
  const alerts = await get('/operations/alerts.json');
  assert.strictEqual(alerts.status, 200);
  assert.match(alerts.contentType, /json/);
  assert.match(alerts.body, /alert_routing/);
});

test('tenant admin page shows plan limits and can update tenant settings', async () => {
  const page = await get('/tenant');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Tenant Admin/);
  assert.match(page.body, /Usage Against Limits/);
  assert.match(page.body, /SaaS Readiness/);
  assert.match(page.body, /Starter/);
  const saved = await post('/tenant', {
    plan: 'starter',
    status: 'active',
    _csrf: tokenFrom(page.body),
  });
  assert.strictEqual(saved.status, 302);
  const after = await get('/tenant');
  assert.match(after.body, /Tenant settings updated/);
  assert.match(after.body, /Starter/);
});

test('security headers are present', async () => {
  const res = await fetch(base + '/login', { redirect: 'manual' });
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
});

test('deploy dry-run script validates local readiness', () => {
  const result = spawnSync(process.execPath, ['scripts/deploy-dry-run.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      CHURCH_DB: TMP_DB,
      BACKUP_DIR: TMP_BACKUPS,
      SESSION_SECRET: 'test-secret',
    },
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS Required tables/);
  assert.match(result.stdout, /Deploy dry-run passed/);
});

test('expired trial blocks signed-in access and shows billing page', async () => {
  const saved = cookie;
  try {
    cookie = undefined;
    const login = await get('/login');
    const token = tokenFrom(login.body);
    const signedIn = await post('/login', { username: 'dunwelladmin', password: 'testpass1', _csrf: token });
    assert.strictEqual(signedIn.status, 302);

    const home = await get('/?__trial=expired');
    assert.strictEqual(home.status, 302);
    assert.strictEqual(home.location, '/billing');

    const billing = await get('/billing?__trial=expired');
    assert.strictEqual(billing.status, 200);
    assert.match(billing.body, /trial has expired/i);
    assert.match(billing.body, /Select Pro/);
  } finally {
    cookie = saved;
  }
});

test('members delete-all clears remaining member references before deleting profiles', async () => {
  const memberId = db.prepare(`
    INSERT INTO members (first_name, last_name, membership_status)
    VALUES ('Delete', 'Reference', 'member')`).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO preaching_plan (preach_date, service_label, member_id, topic)
    VALUES ('2026-07-05', 'Sunday Service', ?, 'Reference cleanup')`).run(memberId);
  assert.ok(db.prepare(`SELECT plan_id FROM preaching_plan WHERE member_id=?`).get(memberId));

  const confirmPage = await get('/delete-all/members');
  assert.strictEqual(confirmPage.status, 200);
  const deleted = await post('/delete-all/members', {
    confirm_phrase: 'DELETE ALL MEMBERS',
    reason: 'smoke test reference cleanup',
    _csrf: tokenFrom(confirmPage.body),
  });
  assert.strictEqual(deleted.status, 302);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM members`).get().c, 0);
  assert.strictEqual(db.prepare(`
    SELECT COUNT(*) c FROM preaching_plan WHERE member_id IS NOT NULL`).get().c, 0);
});

// Runs LAST: tripping the throttle blocks this IP, so no login may follow it.
test('login throttle returns 429 after repeated failures', async () => {
  const saved = cookie; cookie = undefined;
  const form = await get('/login');
  const token = tokenFrom(form.body);
  assert.ok(token, 'login form should contain a CSRF token');
  let last = 0;
  for (let i = 0; i < 11; i++) {
    const r = await post('/login', { username: 'dunwelladmin', password: 'WRONG', _csrf: token });
    last = r.status;
  }
  assert.strictEqual(last, 429);
  cookie = saved;
});
