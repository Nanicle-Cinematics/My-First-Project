'use strict';
// Finance: overview, services, harvests, special offerings, tithes, pledges,
// receipts/outstanding statements, giving statements, expenses. Manual records
// with a hidden double-entry ledger behind income and expense actions.
const { esc, fmtMoney, fmtDate, fmtOutstanding, todayISO, DAYS_OF_WEEK,
  isValidDate, isMoneyNonNeg, isMoneyPositive } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { financeYtd, givingByMember, safeYear, givingYears, memberGivingForYear: libGiving } = require('../lib/finance');
const { postCashIncome, postExpensePayment, reverseJournal, fundBalance,
  fundRaisedSpent, incomeAccountFor, expenseAccountFor } = require('../lib/ledger');
const { amountInWords } = require('../lib/money');

module.exports.register = function register(app, ctx) {
  const { db, requireFinanceWrite, requireFinanceAccounting,
    logActivity, flash, CHURCH_NAME, sendSmsBatch, sendEmailEach, loadOrganizations } = ctx;
  const memberGivingForYear = (id, y) => libGiving(db, id, y);

// ---------- finance: shared helpers ----------
const FINANCE_TABS = [
  { label: null, links: [
    ['/finance', 'Overview'],
  ]},
  { label: 'Income', links: [
    ['/finance/services',  'Services'],
    ['/finance/tithes',    'Tithes'],
    ['/finance/income',    'Income'],
    ['/finance/day-borns', 'Day-Borns'],
    ['/finance/harvests',  'Harvests'],
    ['/finance/special',   'Special Offerings'],
  ]},
  { label: 'Expenses', links: [
    ['/finance/expenses', 'Expenses'],
    ['/finance/vouchers', 'Vouchers'],
  ]},
  { label: 'Pledges', links: [
    ['/finance/pledges',    'Pledges'],
    ['/finance/statements', 'Statements'],
    ['/finance/receipts',   'Receipts'],
  ]},
  { label: 'Planning', links: [
    ['/finance/funds',    'Funds'],
    ['/finance/projects', 'Projects'],
    ['/finance/budgets',  'Budgets'],
  ]},
  { label: 'Accounting', links: [
    ['/finance/accounting', 'Accounting'],
    ['/finance/audit',      'Audit Trail'],
    ['/finance/settings',   'Settings'],
  ]},
];
function financeTabs(activePath) {
  const groups = FINANCE_TABS.map((group, i) => {
    const sep = i > 0 ? '<span class="ftab-sep" aria-hidden="true"></span>' : '';
    const label = group.label
      ? `<span class="ftab-label">${esc(group.label)}</span>`
      : '<span class="ftab-label" aria-hidden="true"></span>';
    const links = `<div class="ftab-links">${group.links.map(([href, text]) =>
      `<a class="${href === activePath ? 'active' : ''}" href="${href}">${esc(text)}</a>`
    ).join('')}</div>`;
    return `${sep}<div class="ftab-group">${label}${links}</div>`;
  }).join('');
  return `<div class="finance-tabs" role="navigation" aria-label="Finance sections">${groups}</div>`;
}
function loadServiceTypes() {
  return db.prepare(`SELECT service_type_id, type_name FROM service_types WHERE is_active=1 ORDER BY type_name`).all();
}
function loadSpecialCategories() {
  return db.prepare(`SELECT special_cat_id, category_name FROM special_categories WHERE is_active=1 ORDER BY category_name`).all();
}
function loadExpenseCategories() {
  return db.prepare(`SELECT expense_cat_id, category_name FROM expense_categories WHERE is_active=1 ORDER BY category_name`).all();
}
function loadMembersList() {
  return db.prepare(`SELECT member_id, first_name || ' ' || last_name AS name, external_id
                     FROM members WHERE deleted_at IS NULL ORDER BY last_name`).all();
}
function defaultFundId() {
  const row = db.prepare(`SELECT fund_id FROM funds WHERE active=1 ORDER BY fund_id LIMIT 1`).get();
  return row ? row.fund_id : null;
}
function updateJournalLink(table, idColumn, id, entryId) {
  db.prepare(`UPDATE ${table} SET journal_entry_id=? WHERE ${idColumn}=?`).run(entryId, id);
}
function reverseLinkedJournal(table, idColumn, id, reason, userId) {
  const row = db.prepare(`SELECT journal_entry_id FROM ${table} WHERE ${idColumn}=?`).get(id);
  if (row && row.journal_entry_id) {
    reverseJournal(db, row.journal_entry_id, reason, userId);
  }
}
function fmtDebitCredit(value) {
  return Number(value || 0) ? fmtMoney(value) : '<span class="muted-text">—</span>';
}
const FUND_TYPES = [
  'GENERAL', 'BUILDING', 'WELFARE', 'MISSION', 'HARVEST', 'ANNIVERSARY',
  'YOUTH', 'MUSIC', 'CHILDREN', 'PROJECT', 'RESTRICTED_DONATION',
];
function fundTypeOptions(selected) {
  return FUND_TYPES.map((type) =>
    `<option value="${type}" ${type === selected ? 'selected' : ''}>${esc(type.replace(/_/g, ' '))}</option>`).join('');
}
const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
function statusOptions(statuses, selected) {
  return statuses.map((status) =>
    `<option value="${status}" ${status === selected ? 'selected' : ''}>${esc(status.replace(/_/g, ' '))}</option>`).join('');
}
function loadFundsList() {
  return db.prepare(`SELECT fund_id, COALESCE(code, '') code, name FROM funds WHERE active=1 ORDER BY name`).all();
}
function fundOptions(selected, includeBlank = true) {
  const options = includeBlank ? ['<option value="">General fund</option>'] : [];
  for (const fund of loadFundsList()) {
    const label = `${fund.code ? fund.code + ' · ' : ''}${fund.name}`;
    options.push(`<option value="${fund.fund_id}" ${Number(selected) === fund.fund_id ? 'selected' : ''}>${esc(label)}</option>`);
  }
  return options.join('');
}
function projectOptions(selected) {
  const projects = db.prepare(`
    SELECT project_id, name FROM finance_projects
    WHERE status IN ('PLANNING','ACTIVE','ON_HOLD')
    ORDER BY name`).all();
  return ['<option value="">No project</option>'].concat(projects.map((project) =>
    `<option value="${project.project_id}" ${Number(selected) === project.project_id ? 'selected' : ''}>${esc(project.name)}</option>`
  )).join('');
}
function financeSettings() {
  const row = db.prepare(`SELECT * FROM finance_settings WHERE setting_id=1`).get();
  return row || {
    receipt_prefix: 'DMC-RCT',
    voucher_prefix: 'DMC-PV',
    small_expense_max: 500,
    medium_expense_max: 5000,
  };
}
function prefixedNo(table, column, prefix, year, width) {
  const cleanPrefix = String(prefix || '').trim() || 'DMC-RCT';
  const base = `${cleanPrefix}-${year}-`;
  const row = db.prepare(`SELECT ${column} value FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`).get(`${base}%`);
  const next = row ? Number(String(row.value).slice(base.length)) + 1 : 1;
  return `${base}${String(next).padStart(width, '0')}`;
}
function accountOptions(type, selected) {
  return db.prepare(`
    SELECT account_id, code, name FROM accounts
    WHERE active=1 AND account_type=?
    ORDER BY code`).all(type).map((account) =>
    `<option value="${account.account_id}" ${Number(selected) === account.account_id ? 'selected' : ''}>${esc(account.code)} · ${esc(account.name)}</option>`
  ).join('');
}
function budgetWindow(row) {
  if (row.scope === 'MONTHLY' && Number(row.month)) {
    const month = String(Number(row.month)).padStart(2, '0');
    const last = new Date(Number(row.year), Number(row.month), 0).getDate();
    return { from: `${row.year}-${month}-01`, to: `${row.year}-${month}-${String(last).padStart(2, '0')}` };
  }
  return { from: `${row.year}-01-01`, to: `${row.year}-12-31` };
}
function budgetActual(line, budget) {
  const win = budgetWindow(budget);
  const accountClause = line.account_id ? 'AND jl.account_id = @account_id' : '';
  const fundClause = line.fund_id ? 'AND jl.fund_id = @fund_id' : '';
  const row = db.prepare(`
    SELECT ROUND(SUM(CASE
      WHEN a.account_type='INCOME' THEN jl.credit - jl.debit
      WHEN a.account_type='EXPENSE' THEN jl.debit - jl.credit
      ELSE 0 END), 2) actual
    FROM journal_lines jl
    JOIN journal_entries je USING(entry_id)
    JOIN accounts a USING(account_id)
    WHERE je.status IN ('POSTED','REVERSED')
      AND je.entry_date BETWEEN @from AND @to
      AND a.account_type = @line_type
      ${accountClause}
      ${fundClause}`).get({
    from: win.from,
    to: win.to,
    line_type: line.line_type,
    account_id: line.account_id,
    fund_id: line.fund_id,
  });
  return Number(row && row.actual || 0);
}
function budgetLineFormFields(line = {}) {
  const lineType = line.line_type === 'EXPENSE' ? 'EXPENSE' : 'INCOME';
  return `
    <label>Type<select name="line_type">
      <option value="INCOME" ${lineType === 'INCOME' ? 'selected' : ''}>Income</option>
      <option value="EXPENSE" ${lineType === 'EXPENSE' ? 'selected' : ''}>Expense</option>
    </select></label>
    <label>Category<input name="category" required value="${esc(line.category || '')}"></label>
    <label>Income account<select name="income_account_id"><option value="">All income accounts</option>${accountOptions('INCOME', lineType === 'INCOME' ? line.account_id : null)}</select></label>
    <label>Expense account<select name="expense_account_id"><option value="">All expense accounts</option>${accountOptions('EXPENSE', lineType === 'EXPENSE' ? line.account_id : null)}</select></label>
    <label>Fund<select name="fund_id">${fundOptions(line.fund_id || '', true)}</select></label>
    <label>Amount (GH₵)<input type="number" step="0.01" min="0" name="amount" required value="${esc(line.amount || '')}"></label>
    <label class="wide">Notes<input name="notes" value="${esc(line.notes || '')}"></label>`;
}
function canViewFunds(res) {
  return res.locals.canFinanceWrite || res.locals.canFinanceAccounting;
}
function requireFundViewer(req, res, next) {
  if (!canViewFunds(res)) return res.status(403).send('Forbidden');
  next();
}
function requireFundManager(req, res, next) {
  if (!res.locals.canFinanceManageFunds) return res.status(403).send('Forbidden');
  next();
}
function nextVoucherNo(year) {
  return prefixedNo('payment_vouchers', 'voucher_no', financeSettings().voucher_prefix, year, 4);
}
function nextReceiptNo(date) {
  return prefixedNo('finance_receipts', 'receipt_number', financeSettings().receipt_prefix, String(date || todayISO()).slice(0, 4), 5);
}
function recordFinanceReceipt({ sourceType, sourceId, receiptDate, receivedFrom, amount, description, userId, receiptNumber }) {
  const no = receiptNumber || nextReceiptNo(receiptDate);
  db.prepare(`
    INSERT INTO finance_receipts (
      receipt_number, source_type, source_id, receipt_date, received_from, amount, description, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    no,
    sourceType,
    sourceId,
    receiptDate,
    receivedFrom || null,
    Number(amount),
    description || null,
    userId || null
  );
  return no;
}
function loadExpenseForVoucher(expenseId) {
  return db.prepare(`
    SELECT e.*, ec.category_name
    FROM expenses e LEFT JOIN expense_categories ec USING(expense_cat_id)
    WHERE e.expense_id=?`).get(expenseId);
}
function syncExpenseVoucher(expenseId, userId) {
  const existing = db.prepare(`SELECT voucher_id, voucher_no FROM payment_vouchers WHERE expense_id=?`).get(expenseId);
  const expense = loadExpenseForVoucher(expenseId);
  if (!expense) return null;
  if (existing) {
    db.prepare(`
      UPDATE payment_vouchers
         SET voucher_date=?, amount_in_words=?, supporting_doc_ref=?,
             approved_by=?, paid_by=?, received_by=?, notes=?
       WHERE voucher_id=?`).run(
      expense.spent_on,
      amountInWords(expense.amount),
      expense.reference_number || null,
      expense.approved_by || null,
      userId || null,
      expense.paid_to || null,
      expense.notes || null,
      existing.voucher_id
    );
    return existing;
  }
  const voucherNo = nextVoucherNo(String(expense.spent_on || todayISO()).slice(0, 4));
  const info = db.prepare(`
    INSERT INTO payment_vouchers (
      voucher_no, expense_id, voucher_date, amount_in_words, supporting_doc_ref,
      prepared_by, approved_by, paid_by, received_by, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    voucherNo,
    expenseId,
    expense.spent_on,
    amountInWords(expense.amount),
    expense.reference_number || null,
    userId || null,
    expense.approved_by || null,
    userId || null,
    expense.paid_to || null,
    expense.notes || null
  );
  return { voucher_id: info.lastInsertRowid, voucher_no: voucherNo };
}
// Parse day-born inputs from a form body. Returns array of {day, amount, head_count}.
function parseDayBornInputs(b) {
  return DAYS_OF_WEEK.map((day) => ({
    day,
    amount: Number(b[`day_${day}_amount`] || 0),
    head_count: Number(b[`day_${day}_heads`] || 0),
  })).filter((r) => r.amount > 0 || r.head_count > 0);
}
function dayBornFormInputs() {
  return `<div class="day-born-grid">${DAYS_OF_WEEK.map((d) => `
    <div class="db-cell">
      <div class="db-day">${d}</div>
      <label>Amount<input type="number" step="0.01" min="0" name="day_${d}_amount"></label>
      <label>Heads<input type="number" min="0" name="day_${d}_heads"></label>
    </div>`).join('')}</div>`;
}
const DAY_ORDER_CASE = `CASE day_born
  WHEN 'Sunday' THEN 1 WHEN 'Monday' THEN 2 WHEN 'Tuesday' THEN 3
  WHEN 'Wednesday' THEN 4 WHEN 'Thursday' THEN 5 WHEN 'Friday' THEN 6
  WHEN 'Saturday' THEN 7 ELSE 8 END`;
function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendFinanceCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n');
}
function currentMonthRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const mm = String(month).padStart(2, '0');
  const last = new Date(year, month, 0).getDate();
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}
function projectFinanceRows() {
  const rows = db.prepare(`
    SELECT p.*, f.name AS fund_name,
           COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.project_id=p.project_id), 0) direct_spent
    FROM finance_projects p
    LEFT JOIN funds f USING(fund_id)
    ORDER BY p.created_at DESC`).all();
  return rows.map((project) => {
    const ledger = project.fund_id ? fundRaisedSpent(db, project.fund_id) : { raised: 0, spent: Number(project.direct_spent || 0) };
    const raised = Number(ledger.raised || 0);
    const spent = project.fund_id ? Number(ledger.spent || 0) : Number(project.direct_spent || 0);
    const target = Number(project.target_amount || 0);
    return {
      ...project,
      raised,
      spent,
      balance: raised - spent,
      pct: target > 0 ? Math.min(100, Math.round((raised / target) * 100)) : 0,
    };
  });
}
function budgetSummaryRows() {
  const budgets = db.prepare(`
    SELECT b.*, COUNT(bl.line_id) line_count, COALESCE(SUM(bl.amount), 0) budgeted
    FROM finance_budgets b
    LEFT JOIN finance_budget_lines bl USING(budget_id)
    GROUP BY b.budget_id
    ORDER BY b.year DESC, COALESCE(b.month, 0) DESC, b.created_at DESC`).all();
  return budgets.map((budget) => {
    const lines = db.prepare(`SELECT * FROM finance_budget_lines WHERE budget_id=?`).all(budget.budget_id);
    const actual = lines.reduce((sum, line) => sum + budgetActual(line, budget), 0);
    return { ...budget, actual, variance: Number(budget.budgeted || 0) - actual };
  });
}

// ---------- finance: overview ----------
app.get('/finance', (req, res) => {
  const { services, harvests, special, tithes: tithesYtd, expenses, offerings, net } =
    financeYtd(db, new Date().getFullYear());
  const month = currentMonthRange();
  const monthTotals = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total_amount),0) FROM services
        WHERE deleted_at IS NULL AND service_date BETWEEN @start AND @end)
      + (SELECT COALESCE(SUM(total_collected),0) FROM harvests
        WHERE deleted_at IS NULL AND COALESCE(harvest_date, harvest_year || '-01-01') BETWEEN @start AND @end)
      + (SELECT COALESCE(SUM(amount),0) FROM special_offerings
        WHERE deleted_at IS NULL AND offering_date BETWEEN @start AND @end)
      + (SELECT COALESCE(SUM(amount),0) FROM tithes
        WHERE deleted_at IS NULL AND tithe_date BETWEEN @start AND @end) AS income,
      (SELECT COALESCE(SUM(amount),0) FROM expenses
        WHERE spent_on BETWEEN @start AND @end) AS expenses
  `).get(month);
  monthTotals.net = Number(monthTotals.income || 0) - Number(monthTotals.expenses || 0);
  const unpaidPledges = db.prepare(`
    SELECT COUNT(*) count, COALESCE(SUM(pledged_amount - paid_amount), 0) total
    FROM pledges
    WHERE pledged_amount - paid_amount > 0.005`).get();
  const fundRows = db.prepare(`
    SELECT fund_id, COALESCE(code, '') code, name
    FROM funds
    WHERE active=1
    ORDER BY name`).all().map((fund) => ({ ...fund, balance: fundBalance(db, fund.fund_id) }))
    .sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0))
    .slice(0, 5);
  const recentVouchers = db.prepare(`
    SELECT pv.voucher_id, pv.voucher_no, pv.voucher_date, e.amount, e.paid_to, e.description
    FROM payment_vouchers pv
    JOIN expenses e USING(expense_id)
    ORDER BY pv.voucher_date DESC, pv.voucher_id DESC
    LIMIT 5`).all();
  const budgetWarnings = budgetSummaryRows()
    .filter((budget) => Number(budget.variance || 0) < 0)
    .slice(0, 5);

  const recentServices = db.prepare(`
    SELECT s.service_id, s.service_date, s.total_amount, st.type_name
    FROM services s JOIN service_types st USING(service_type_id)
    WHERE s.deleted_at IS NULL
    ORDER BY s.service_date DESC, s.service_id DESC LIMIT 5`).all();
  const recentSpecial = db.prepare(`
    SELECT sp.special_id, sp.offering_date, sp.amount, sc.category_name,
           COALESCE(m.first_name || ' ' || m.last_name, sp.donor_name_manual, '(anonymous)') donor
    FROM special_offerings sp
    JOIN special_categories sc USING(special_cat_id)
    LEFT JOIN members m ON m.member_id = sp.donor_id
    WHERE sp.deleted_at IS NULL
    ORDER BY sp.offering_date DESC, sp.special_id DESC LIMIT 5`).all();
  const dayBornYtd = db.prepare(`
    SELECT day_born, ROUND(SUM(amount),2) total, SUM(head_count) heads
    FROM day_born_splits dbs
    LEFT JOIN services s USING(service_id)
    WHERE (s.service_date IS NULL OR substr(s.service_date,1,4)=strftime('%Y','now'))
    GROUP BY day_born`).all();
  const dayBornMap = Object.fromEntries(dayBornYtd.map((r) => [r.day_born, r]));

  const body = `
    ${pageHero('Finance', 'Offerings, tithes, harvests and expenses — this year at a glance.')}
    <div class="page-actions">
      <a class="btn primary" href="/finance/services">＋ Record Service</a>
      <a class="btn purple" href="/finance/special">＋ Special Offering</a>
      <a class="btn ghost" href="/finance/expenses">＋ Expense</a>
    </div>
    ${statsRow([
      { cls: 'green', icon: 'M', value: fmtMoney(monthTotals.income), label: 'Income this month' },
      { cls: 'orange', icon: 'M', value: fmtMoney(monthTotals.expenses), label: 'Expenses this month' },
      { cls: monthTotals.net >= 0 ? 'blue' : 'orange', icon: '=', value: fmtMoney(monthTotals.net), label: 'Net this month' },
      { cls: 'purple', icon: 'P', value: fmtMoney(unpaidPledges.total), label: `${unpaidPledges.count} unpaid pledges` },
    ])}
    ${statsRow([
      { cls: 'gold', icon: '₵', value: fmtMoney(services), label: 'Service Offerings YTD' },
      { cls: 'green', icon: '🤲', value: fmtMoney(tithesYtd), label: 'Tithes YTD' },
      { cls: 'blue', icon: '🌾', value: fmtMoney(harvests), label: 'Harvests YTD' },
      { cls: 'purple', icon: '✨', value: fmtMoney(special), label: 'Special Offerings YTD' },
      { cls: 'orange', icon: '🧾', value: fmtMoney(expenses), label: 'Expenses YTD' },
    ])}
    <div class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Net YTD</h2><span class="meta">Offerings + Harvests − Expenses</span></div>
      <div class="value" style="font-size:1.8rem;font-weight:700;color:${net >= 0 ? 'var(--pos)' : 'var(--danger)'}">${fmtMoney(net)}</div>
    </div>

    <div class="two-col">
      <section class="card">
        <div class="card-head"><h2>Recent Services</h2><a href="/finance/services">View all</a></div>
        ${recentServices.length ? table(['Date', 'Type', 'Total'],
          recentServices.map((s) => [esc(s.service_date),
            `<a href="/finance/services/${s.service_id}">${esc(s.type_name)}</a>`,
            fmtMoney(s.total_amount)])) : '<p class="muted-text">No services recorded yet.</p>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Recent Special Offerings</h2><a href="/finance/special">View all</a></div>
        ${recentSpecial.length ? table(['Date', 'Donor', 'Category', 'Amount'],
          recentSpecial.map((s) => [esc(s.offering_date), esc(s.donor),
            esc(s.category_name), fmtMoney(s.amount)])) : '<p class="muted-text">None yet.</p>'}
      </section>
    </div>

    <div class="two-col" style="margin-top:1rem">
      <section class="card">
        <div class="card-head"><h2>Top Funds</h2><a href="/finance/funds">View all</a></div>
        ${fundRows.length ? table(['Fund', 'Balance'],
          fundRows.map((fund) => [
            `${esc(fund.code ? fund.code + ' · ' : '')}${esc(fund.name)}`,
            fmtMoney(fund.balance),
          ])) : '<p class="muted-text">No funds configured yet.</p>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Recent Vouchers</h2><a href="/finance/vouchers">View all</a></div>
        ${recentVouchers.length ? table(['Date', 'Voucher', 'Payee', 'Amount'],
          recentVouchers.map((v) => [
            esc(v.voucher_date),
            `<a href="/finance/vouchers/${v.voucher_id}/print">${esc(v.voucher_no)}</a>`,
            esc(v.paid_to || v.description || '—'),
            fmtMoney(v.amount),
          ])) : '<p class="muted-text">No vouchers generated yet.</p>'}
      </section>
    </div>

    <section class="card" style="margin-top:1rem">
      <div class="card-head"><h2>Budget Overspending Warnings</h2><a href="/finance/budgets">View budgets</a></div>
      ${budgetWarnings.length ? table(['Budget', 'Period', 'Budgeted', 'Actual', 'Over by'],
        budgetWarnings.map((budget) => [
          `<a href="/finance/budgets/${budget.budget_id}">${esc(budget.name)}</a>`,
          budget.scope === 'MONTHLY' ? `${budget.year}-${String(budget.month || '').padStart(2, '0')}` : String(budget.year),
          fmtMoney(budget.budgeted),
          fmtMoney(budget.actual),
          fmtMoney(Math.abs(budget.variance)),
        ])) : '<p class="muted-text">No budget overspending warnings.</p>'}
    </section>

    <div class="card" style="margin-top:1rem">
      <div class="card-head"><h2>Day-Born Totals (YTD)</h2><span class="meta">Service offerings</span></div>
      ${table(['Day', 'Amount', 'Heads'],
        DAYS_OF_WEEK.map((d) => {
          const r = dayBornMap[d] || { total: 0, heads: 0 };
          return [esc(d), fmtMoney(r.total || 0), r.heads || 0];
        }))}
    </div>`;
  res.page({ title: 'Finance', active: '/finance', noHeader: true, body });
});

// Old "quick add" shortcut — point to the services page.
app.get('/finance/new', requireFinanceWrite, (req, res) => res.redirect('/finance/services'));
app.get('/finance/services/new', requireFinanceWrite, (req, res) => res.redirect('/finance/services'));
app.get('/finance/income/new', requireFinanceWrite, (req, res) => res.redirect('/finance/income'));
app.get('/finance/day-borns/new', requireFinanceWrite, (req, res) => res.redirect('/finance/day-borns'));
app.get('/finance/special/new', requireFinanceWrite, (req, res) => res.redirect('/finance/special'));
app.get('/finance/expenses/new', requireFinanceWrite, (req, res) => res.redirect('/finance/expenses'));

const INCOME_CATEGORIES = [
  ['donation', 'Donation'],
  ['event', 'Event income'],
  ['rent', 'Facility rental'],
  ['bookshop', 'Bookshop / materials'],
  ['welfare_refund', 'Welfare refund'],
  ['other', 'Other income'],
];
function incomeCategoryOptions(selected) {
  return INCOME_CATEGORIES.map(([value, label]) =>
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
}
function incomeCategoryLabel(value) {
  const found = INCOME_CATEGORIES.find((row) => row[0] === value);
  return found ? found[1] : String(value || 'Other income');
}
const PAYMENT_METHODS = ['Cash', 'Mobile Money', 'Bank Transfer', 'Cheque', 'Card', 'Other'];
function paymentMethodOptions(selected) {
  return PAYMENT_METHODS.map((method) =>
    `<option ${method === selected ? 'selected' : ''}>${esc(method)}</option>`).join('');
}

// ---------- finance: generic income ----------
app.get('/finance/income', (req, res) => {
  const rows = db.prepare(`
    SELECT ir.*, m.first_name || ' ' || m.last_name AS member_name, f.name fund_name, p.name project_name
    FROM income_records ir
    LEFT JOIN members m ON m.member_id=ir.member_id
    LEFT JOIN funds f ON f.fund_id=ir.fund_id
    LEFT JOIN finance_projects p ON p.project_id=ir.project_id
    WHERE ir.deleted_at IS NULL
    ORDER BY ir.transaction_date DESC, ir.income_id DESC
    LIMIT 100`).all();
  const members = loadMembersList();
  const memOpts = '<option value="">Non-member / anonymous</option>' +
    members.map((m) => `<option value="${m.member_id}">${esc(m.name)}${m.external_id ? ' · ' + esc(m.external_id) : ''}</option>`).join('');
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const addForm = res.locals.canFinanceWrite
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record generic income</strong></summary>
         <form class="form" method="post" action="/finance/income" style="margin-top:0.75rem">
           <label>Date<input type="date" name="transaction_date" required value="${todayISO()}"></label>
           <label>Category<select name="category" required>${incomeCategoryOptions('other')}</select></label>
           <label>Subcategory<input name="subcategory" placeholder="e.g. Thanksgiving, hall rental"></label>
           <label>Member<select name="member_id">${memOpts}</select></label>
           <label>Received from<input name="received_from" placeholder="if not a member"></label>
           <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
           <label>Payment method<select name="payment_method">${paymentMethodOptions('Cash')}</select></label>
           <label>Fund<select name="fund_id">${fundOptions('', true)}</select></label>
           <label>Project<select name="project_id">${projectOptions('')}</select></label>
           <label>Reference<input name="reference_number"></label>
           <label class="wide">Description<input name="description"></label>
           <div class="actions"><button type="submit">Save and issue receipt</button></div>
         </form>
       </details>` : '';
  const body = `
    ${statsRow([
      { cls: 'green', icon: '₵', value: fmtMoney(total), label: 'Recent generic income' },
      { cls: 'blue', icon: '#', value: rows.length, label: 'Records shown' },
    ])}
    ${addForm}
    ${rows.length ? table(['Date', 'Category', 'Received from', 'Amount', 'Method', 'Fund', 'Receipt', ''],
      rows.map((r) => [
        esc(r.transaction_date),
        `${esc(incomeCategoryLabel(r.category))}${r.subcategory ? '<br><span class="muted-text">' + esc(r.subcategory) + '</span>' : ''}`,
        r.member_id ? `<a href="/members/${r.member_id}">${esc(r.member_name)}</a>` : esc(r.received_from || 'Anonymous'),
        fmtMoney(r.amount),
        esc(r.payment_method || 'Cash'),
        esc(r.fund_name || 'General fund'),
        esc(r.receipt_number || '—'),
        r.receipt_number ? `<a class="btn-link" href="/finance/receipts/${encodeURIComponent(r.receipt_number)}/print">Print</a>` : '',
      ])) : '<p class="muted-text">No generic income recorded yet.</p>'}`;
  res.page({ title: 'Finance · Generic Income', active: '/finance', body });
});

app.post('/finance/income', requireFinanceWrite, (req, res) => {
  const b = req.body;
  const category = INCOME_CATEGORIES.some((row) => row[0] === b.category) ? b.category : 'other';
  if (!isValidDate(b.transaction_date)) { flash(req, 'Enter a valid income date.'); return res.redirect('/finance/income'); }
  if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/income'); }
  const result = db.transaction(() => {
    const member = b.member_id ? db.prepare(`SELECT first_name || ' ' || last_name name FROM members WHERE member_id=?`).get(Number(b.member_id)) : null;
    const receivedFrom = (member && member.name) || String(b.received_from || '').trim() || 'Anonymous';
    const receiptNo = nextReceiptNo(b.transaction_date);
    const info = db.prepare(`
      INSERT INTO income_records (
        transaction_date, category, subcategory, received_from, member_id, amount,
        payment_method, fund_id, project_id, reference_number, description,
        receipt_number, recorded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      b.transaction_date,
      category,
      b.subcategory || null,
      receivedFrom,
      b.member_id ? Number(b.member_id) : null,
      Number(b.amount),
      b.payment_method || 'Cash',
      b.fund_id ? Number(b.fund_id) : defaultFundId(),
      b.project_id ? Number(b.project_id) : null,
      b.reference_number || null,
      b.description || null,
      receiptNo,
      res.locals.user.user_id
    );
    const label = incomeCategoryLabel(category);
    const entryId = postCashIncome(db, {
      date: b.transaction_date,
      amount: Number(b.amount),
      incomeAccount: incomeAccountFor(label),
      fundId: b.fund_id ? Number(b.fund_id) : defaultFundId(),
      sourceType: 'GENERIC_INCOME',
      sourceId: info.lastInsertRowid,
      createdBy: res.locals.user.user_id,
      memo: b.description || `${label} from ${receivedFrom}`,
    });
    updateJournalLink('income_records', 'income_id', info.lastInsertRowid, entryId);
    recordFinanceReceipt({
      sourceType: 'GENERIC_INCOME',
      sourceId: info.lastInsertRowid,
      receiptDate: b.transaction_date,
      receivedFrom,
      amount: Number(b.amount),
      description: b.description || label,
      userId: res.locals.user.user_id,
      receiptNumber: receiptNo,
    });
    return { income_id: info.lastInsertRowid, receipt_number: receiptNo };
  })();
  logActivity('income_recorded', `Generic income ${result.receipt_number} recorded`, '/finance/income', res.locals.user.user_id);
  res.redirect(`/finance/receipts/${encodeURIComponent(result.receipt_number)}/print?new=1`);
});

app.post('/finance/income/:id/delete', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    reverseLinkedJournal('income_records', 'income_id', id, 'Generic income archived', res.locals.user.user_id);
    db.prepare(`UPDATE income_records SET deleted_at=CURRENT_TIMESTAMP WHERE income_id=?`).run(id);
    db.prepare(`UPDATE finance_receipts SET voided_at=CURRENT_TIMESTAMP, void_reason=? WHERE source_type='GENERIC_INCOME' AND source_id=?`)
      .run('Generic income archived', id);
  })();
  logActivity('finance_reversal', `Generic income #${id} archived and journal reversed`, '/finance/income', res.locals.user.user_id);
  res.redirect('/finance/income');
});

// ---------- finance: standalone day-born collections ----------
app.get('/finance/day-borns', (req, res) => {
  const rows = db.prepare(`
    SELECT dbc.*, f.name fund_name
    FROM day_born_collections dbc
    LEFT JOIN funds f ON f.fund_id=dbc.fund_id
    WHERE dbc.deleted_at IS NULL
    ORDER BY dbc.collection_date DESC, dbc.collection_id DESC
    LIMIT 120`).all();
  const byDay = db.prepare(`
    SELECT day_born, COUNT(*) records, COALESCE(SUM(amount),0) total, COALESCE(SUM(head_count),0) heads
    FROM day_born_collections
    WHERE deleted_at IS NULL
    GROUP BY day_born
    ORDER BY ${DAY_ORDER_CASE}`).all();
  const addForm = res.locals.canFinanceWrite
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record day-born collection</strong></summary>
         <form class="form" method="post" action="/finance/day-borns" style="margin-top:0.75rem">
           <label>Date<input type="date" name="collection_date" required value="${todayISO()}"></label>
           <label>Day-born<select name="day_born" required>${DAYS_OF_WEEK.map((d) => `<option>${esc(d)}</option>`).join('')}</select></label>
           <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
           <label>Heads<input type="number" min="0" name="head_count" value="0"></label>
           <label>Payment method<select name="payment_method">${paymentMethodOptions('Cash')}</select></label>
           <label>Fund<select name="fund_id">${fundOptions('', true)}</select></label>
           <label>Reference<input name="reference_number"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save and issue receipt</button></div>
         </form>
       </details>` : '';
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const body = `
    ${statsRow([
      { cls: 'green', icon: '₵', value: fmtMoney(total), label: 'Recent standalone collections' },
      { cls: 'purple', icon: '#', value: rows.length, label: 'Records shown' },
    ])}
    ${addForm}
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Summary by day-born</h2><span class="meta">Standalone records only</span></div>
      ${byDay.length ? table(['Day-born', 'Records', 'Heads', 'Total'],
        byDay.map((r) => [esc(r.day_born), r.records, r.heads, fmtMoney(r.total)]))
        : '<p class="muted-text">No standalone day-born collections yet.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><h2>Recent day-born collections</h2><span class="meta">Receipted entries</span></div>
      ${rows.length ? table(['Date', 'Day-born', 'Amount', 'Heads', 'Method', 'Fund', 'Receipt', ''],
        rows.map((r) => [
          esc(r.collection_date),
          esc(r.day_born),
          fmtMoney(r.amount),
          r.head_count || 0,
          esc(r.payment_method || 'Cash'),
          esc(r.fund_name || 'General fund'),
          esc(r.receipt_number || '—'),
          r.receipt_number ? `<a class="btn-link" href="/finance/receipts/${encodeURIComponent(r.receipt_number)}/print">Print</a>` : '',
        ])) : '<p class="muted-text">No standalone day-born collections recorded yet.</p>'}
    </section>`;
  res.page({ title: 'Finance · Day-Borns', active: '/finance', body });
});

app.post('/finance/day-borns', requireFinanceWrite, (req, res) => {
  const b = req.body;
  if (!isValidDate(b.collection_date)) { flash(req, 'Enter a valid collection date.'); return res.redirect('/finance/day-borns'); }
  if (!DAYS_OF_WEEK.includes(b.day_born)) { flash(req, 'Choose a valid day-born.'); return res.redirect('/finance/day-borns'); }
  if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/day-borns'); }
  const result = db.transaction(() => {
    const receiptNo = nextReceiptNo(b.collection_date);
    const info = db.prepare(`
      INSERT INTO day_born_collections (
        collection_date, day_born, amount, head_count, payment_method, fund_id,
        reference_number, receipt_number, recorded_by, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      b.collection_date,
      b.day_born,
      Number(b.amount),
      Number(b.head_count || 0),
      b.payment_method || 'Cash',
      b.fund_id ? Number(b.fund_id) : defaultFundId(),
      b.reference_number || null,
      receiptNo,
      res.locals.user.user_id,
      b.notes || null
    );
    const entryId = postCashIncome(db, {
      date: b.collection_date,
      amount: Number(b.amount),
      incomeAccount: incomeAccountFor('day-born collection'),
      fundId: b.fund_id ? Number(b.fund_id) : defaultFundId(),
      sourceType: 'DAY_BORN_COLLECTION',
      sourceId: info.lastInsertRowid,
      createdBy: res.locals.user.user_id,
      memo: `${b.day_born} day-born collection`,
    });
    updateJournalLink('day_born_collections', 'collection_id', info.lastInsertRowid, entryId);
    recordFinanceReceipt({
      sourceType: 'DAY_BORN_COLLECTION',
      sourceId: info.lastInsertRowid,
      receiptDate: b.collection_date,
      receivedFrom: `${b.day_born} day-born group`,
      amount: Number(b.amount),
      description: `${b.day_born} day-born collection`,
      userId: res.locals.user.user_id,
      receiptNumber: receiptNo,
    });
    return { collection_id: info.lastInsertRowid, receipt_number: receiptNo };
  })();
  logActivity('income_recorded', `Day-born receipt ${result.receipt_number} recorded`, '/finance/day-borns', res.locals.user.user_id);
  res.redirect(`/finance/receipts/${encodeURIComponent(result.receipt_number)}/print?new=1`);
});

app.post('/finance/day-borns/:id/delete', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    reverseLinkedJournal('day_born_collections', 'collection_id', id, 'Day-born collection archived', res.locals.user.user_id);
    db.prepare(`UPDATE day_born_collections SET deleted_at=CURRENT_TIMESTAMP WHERE collection_id=?`).run(id);
    db.prepare(`UPDATE finance_receipts SET voided_at=CURRENT_TIMESTAMP, void_reason=? WHERE source_type='DAY_BORN_COLLECTION' AND source_id=?`)
      .run('Day-born collection archived', id);
  })();
  logActivity('finance_reversal', `Day-born collection #${id} archived and journal reversed`, '/finance/day-borns', res.locals.user.user_id);
  res.redirect('/finance/day-borns');
});

// ---------- finance: services ----------
app.get('/finance/services', (req, res) => {
  const types = loadServiceTypes();
  const recent = db.prepare(`
    SELECT s.service_id, s.service_date, s.total_amount, s.notes,
           st.type_name, u.display_name, u.username
    FROM services s
    JOIN service_types st USING(service_type_id)
    LEFT JOIN users u ON u.user_id = s.recorded_by
    WHERE s.deleted_at IS NULL
    ORDER BY s.service_date DESC, s.service_id DESC LIMIT 50`).all();
  const typeOpts = types.map((t) => `<option value="${t.service_type_id}">${esc(t.type_name)}</option>`).join('');
  const addForm = res.locals.canFinanceWrite
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record a service</strong></summary>
         <form class="form" method="post" action="/finance/services" style="margin-top:0.75rem">
           <label>Date<input type="date" name="service_date" required value="${todayISO()}"></label>
           <label>Service type<select name="service_type_id" required>${typeOpts}</select></label>
           <label>Total amount (GH₵)<input type="number" step="0.01" min="0" name="total_amount" required></label>
           <label class="wide">Notes<input name="notes"></label>
           <fieldset class="wide">
             <legend>Day-born breakdown (optional)</legend>
             ${dayBornFormInputs()}
           </fieldset>
           <div class="actions"><button type="submit">Save service</button></div>
         </form>
       </details>` : '';
  const body = `
    ${addForm}
    ${recent.length ? table(['Date', 'Type', 'Total', 'Recorded by', ''],
      recent.map((s) => [esc(s.service_date),
        `<a href="/finance/services/${s.service_id}">${esc(s.type_name)}</a>`,
        fmtMoney(s.total_amount),
        esc(s.display_name || s.username || '—'),
        `<a class="btn ghost" href="/finance/services/${s.service_id}">Open</a>`]))
      : '<p class="muted-text">No services recorded yet.</p>'}`;
  res.page({ title: 'Finance · Services', active: '/finance', body });
});

app.post('/finance/services', requireFinanceWrite, (req, res) => {
  const b = req.body;
  if (!Number(b.service_type_id)) { flash(req, 'Choose a service type.'); return res.redirect('/finance/services'); }
  if (!isValidDate(b.service_date)) { flash(req, 'Enter a valid service date.'); return res.redirect('/finance/services'); }
  if (!isMoneyNonNeg(b.total_amount)) { flash(req, 'Amount must be a number of 0 or more.'); return res.redirect('/finance/services'); }
  const serviceId = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO services (service_type_id, service_date, total_amount, recorded_by, notes)
      VALUES (?, ?, ?, ?, ?)`).run(
      Number(b.service_type_id), b.service_date, Number(b.total_amount),
      res.locals.user.user_id, b.notes || null
    );
    const splits = parseDayBornInputs(b);
    const insSplit = db.prepare(`INSERT INTO day_born_splits (service_id, day_born, amount, head_count) VALUES (?, ?, ?, ?)`);
    for (const s of splits) insSplit.run(info.lastInsertRowid, s.day, s.amount, s.head_count);
    if (Number(b.total_amount) > 0) {
      const entryId = postCashIncome(db, {
        date: b.service_date,
        amount: Number(b.total_amount),
        incomeAccount: incomeAccountFor('service offering'),
        fundId: defaultFundId(),
        sourceType: 'INCOME',
        sourceId: info.lastInsertRowid,
        createdBy: res.locals.user.user_id,
        memo: 'Service offering',
      });
      updateJournalLink('services', 'service_id', info.lastInsertRowid, entryId);
    }
    return info.lastInsertRowid;
  })();
  logActivity('contribution_recorded',
    `Service offering of ${fmtMoney(b.total_amount)} recorded`,
    `/finance/services/${serviceId}`, res.locals.user.user_id);
  res.redirect(`/finance/services/${serviceId}`);
});

app.get('/finance/services/:id', (req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare(`
    SELECT s.*, st.type_name FROM services s
    JOIN service_types st USING(service_type_id)
    WHERE s.service_id=? AND s.deleted_at IS NULL`).get(id);
  if (!s) return res.status(404).send('Not found');
  const splits = db.prepare(
    `SELECT day_born, amount, head_count FROM day_born_splits WHERE service_id=? ORDER BY split_id`
  ).all(id);
  const splitMap = Object.fromEntries(splits.map((sp) => [sp.day_born, sp]));
  const addSplit = res.locals.canFinanceWrite
    ? `<h2>Day-born breakdown</h2>
       <form class="form" method="post" action="/finance/services/${id}/splits">
         <input type="hidden" name="_csrf" value="${esc(res.locals.csrfToken)}">
         <fieldset class="wide">
           ${dayBornFormInputs()}
         </fieldset>
         <div class="actions"><button type="submit">Save breakdown</button></div>
       </form>` : '';
  const splitTotal = splits.reduce((a, b) => a + b.amount, 0);
  const headTotal = splits.reduce((a, b) => a + (b.head_count || 0), 0);
  const body = `
    <div class="card">
      <div class="card-head"><h2>${esc(s.type_name)} · ${esc(s.service_date)}</h2>
        <span class="meta">${fmtMoney(s.total_amount)}</span></div>
      ${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
    </div>
    <h2>Current breakdown</h2>
    ${splits.length
      ? table(['Day', 'Amount', 'Heads'],
          DAYS_OF_WEEK.map((d) => [d,
            fmtMoney((splitMap[d] || {}).amount || 0),
            (splitMap[d] || {}).head_count || 0])
            .concat([['Total', fmtMoney(splitTotal), headTotal]]))
      : '<p class="muted-text">No breakdown recorded.</p>'}
    ${addSplit}
    ${res.locals.canFinanceWrite ? `<form method="post" action="/finance/services/${id}/delete"
        onsubmit="return confirm('Archive this service?')" style="margin-top:1rem">
        <input type="hidden" name="_csrf" value="${esc(res.locals.csrfToken)}">
        <button class="danger" type="submit">Archive service</button>
      </form>` : ''}`;
  res.page({ title: `${s.type_name} · ${s.service_date}`, active: '/finance', body });
});

app.post('/finance/services/:id/splits', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM day_born_splits WHERE service_id=?`).run(id);
  const splits = parseDayBornInputs(req.body);
  const insSplit = db.prepare(`INSERT INTO day_born_splits (service_id, day_born, amount, head_count) VALUES (?, ?, ?, ?)`);
  for (const s of splits) insSplit.run(id, s.day, s.amount, s.head_count);
  res.redirect(`/finance/services/${id}`);
});

app.post('/finance/services/:id/delete', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    reverseLinkedJournal('services', 'service_id', id, 'Service offering archived', res.locals.user.user_id);
    db.prepare(`UPDATE services SET deleted_at=CURRENT_TIMESTAMP WHERE service_id=?`).run(id);
  })();
  logActivity('finance_reversal', `Service offering #${id} archived and journal reversed`,
    '/finance/services', res.locals.user.user_id);
  res.redirect('/finance/services');
});

// ---------- finance: harvests ----------
app.get('/finance/harvests', (req, res) => {
  const orgs = loadOrganizations();
  const recent = db.prepare(`
    SELECT h.*, o.name AS org_name FROM harvests h
    LEFT JOIN organizations o USING(org_id)
    WHERE h.deleted_at IS NULL
    ORDER BY h.harvest_year DESC, h.harvest_id DESC LIMIT 50`).all();
  const orgOpts = '<option value="">(church-wide)</option>' +
    orgs.map((o) => `<option value="${o.org_id}">${esc(o.name)}</option>`).join('');
  const addForm = res.locals.canFinanceWrite
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Add a harvest</strong></summary>
         <form class="form" method="post" action="/finance/harvests" style="margin-top:0.75rem">
           <label>Type<select name="harvest_type" required>
             <option value="End-of-Year">End-of-Year</option>
             <option value="Organizational">Organizational</option>
             <option value="Other">Other</option>
           </select></label>
           <label>Year<input type="number" name="harvest_year" required value="${new Date().getFullYear()}"></label>
           <label class="wide">Name<input name="harvest_name" required placeholder="e.g. 2026 End-of-Year Harvest"></label>
           <label>Harvest date<input type="date" name="harvest_date" value="${todayISO()}"></label>
           <label>Organization<select name="org_id">${orgOpts}</select></label>
           <label class="wide">Theme<input name="theme"></label>
           <label>Total collected (GH₵)<input type="number" step="0.01" min="0" name="total_collected" value="0"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save harvest</button></div>
         </form>
       </details>` : '';
  const body = `
    ${addForm}
    ${recent.length ? table(['Year', 'Type', 'Name', 'Organization', 'Date', 'Collected', ''],
      recent.map((h) => [h.harvest_year, esc(h.harvest_type),
        `<a href="/finance/harvests/${h.harvest_id}">${esc(h.harvest_name)}</a>`,
        esc(h.org_name) || '—', esc(h.harvest_date) || '—',
        fmtMoney(h.total_collected),
        `<a class="btn ghost" href="/finance/harvests/${h.harvest_id}">Open</a>`]))
      : '<p class="muted-text">No harvests recorded yet.</p>'}`;
  res.page({ title: 'Finance · Harvests', active: '/finance', body });
});

app.post('/finance/harvests', requireFinanceWrite, (req, res) => {
  const b = req.body;
  const harvestId = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO harvests (harvest_type, harvest_name, harvest_year, harvest_date, theme,
                            org_id, total_collected, recorded_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      b.harvest_type, b.harvest_name, Number(b.harvest_year),
      b.harvest_date || null, b.theme || null,
      b.org_id ? Number(b.org_id) : null,
      Number(b.total_collected || 0), res.locals.user.user_id, b.notes || null
    );
    if (Number(b.total_collected || 0) > 0) {
      const entryId = postCashIncome(db, {
        date: b.harvest_date || `${Number(b.harvest_year)}-01-01`,
        amount: Number(b.total_collected || 0),
        incomeAccount: incomeAccountFor('harvest'),
        fundId: defaultFundId(),
        sourceType: 'HARVEST',
        sourceId: info.lastInsertRowid,
        createdBy: res.locals.user.user_id,
        memo: b.harvest_name || 'Harvest',
      });
      updateJournalLink('harvests', 'harvest_id', info.lastInsertRowid, entryId);
    }
    return info.lastInsertRowid;
  })();
  res.redirect(`/finance/harvests/${harvestId}`);
});

app.get('/finance/harvests/:id', (req, res) => {
  const id = Number(req.params.id);
  const h = db.prepare(`
    SELECT h.*, o.name AS org_name FROM harvests h
    LEFT JOIN organizations o USING(org_id)
    WHERE h.harvest_id=? AND h.deleted_at IS NULL`).get(id);
  if (!h) return res.status(404).send('Not found');
  const splits = db.prepare(
    `SELECT day_born, amount, head_count FROM day_born_splits WHERE harvest_id=?`
  ).all(id);
  const splitMap = Object.fromEntries(splits.map((sp) => [sp.day_born, sp]));
  const pledges = db.prepare(`
    SELECT p.*, m.member_id, m.first_name || ' ' || m.last_name AS member
    FROM pledges p JOIN members m USING(member_id)
    WHERE p.harvest_id=? ORDER BY p.pledge_date DESC`).all(id);
  const totalPledged = pledges.reduce((a, b) => a + b.pledged_amount, 0);
  const totalPaid = pledges.reduce((a, b) => a + b.paid_amount, 0);

  const addSplit = res.locals.canFinanceWrite
    ? `<h2>Day-born breakdown</h2>
       <form class="form" method="post" action="/finance/harvests/${id}/splits">
         <fieldset class="wide">${dayBornFormInputs()}</fieldset>
         <div class="actions"><button type="submit">Save breakdown</button></div>
       </form>` : '';

  const body = `
    <div class="card">
      <div class="card-head"><h2>${esc(h.harvest_name)}</h2>
        <span class="meta">${esc(h.harvest_type)} · ${h.harvest_year}</span></div>
      <p>${esc(h.theme) || ''}</p>
      <dl class="stats">
        <dt>Date</dt><dd>${esc(h.harvest_date) || '—'}</dd>
        <dt>Organization</dt><dd>${esc(h.org_name) || 'Church-wide'}</dd>
        <dt>Total collected</dt><dd>${fmtMoney(h.total_collected)}</dd>
        <dt>Total pledged</dt><dd>${fmtMoney(totalPledged)} (paid ${fmtMoney(totalPaid)})</dd>
      </dl>
    </div>
    <h2>Day-born breakdown</h2>
    ${splits.length
      ? table(['Day', 'Amount', 'Heads'],
          DAYS_OF_WEEK.map((d) => [d,
            fmtMoney((splitMap[d] || {}).amount || 0),
            (splitMap[d] || {}).head_count || 0]))
      : '<p class="muted-text">No breakdown recorded.</p>'}
    ${addSplit}
    <h2>Pledges</h2>
    ${pledges.length
      ? table(['Date', 'Member', 'Pledged', 'Paid', 'Outstanding', 'Status'],
          pledges.map((p) => [esc(p.pledge_date),
            `<a href="/members/${p.member_id}">${esc(p.member)}</a>`,
            fmtMoney(p.pledged_amount), fmtMoney(p.paid_amount),
            fmtOutstanding(p.pledged_amount - p.paid_amount),
            esc(p.status)]))
      : '<p class="muted-text">No pledges yet. Add them from the <a href="/finance/pledges">Pledges</a> tab.</p>'}
    ${res.locals.canFinanceWrite ? `<form method="post" action="/finance/harvests/${id}/delete"
        onsubmit="return confirm('Archive this harvest?')" style="margin-top:1rem">
        <button class="danger" type="submit">Archive harvest</button>
      </form>` : ''}`;
  res.page({ title: h.harvest_name, active: '/finance', body });
});

app.post('/finance/harvests/:id/splits', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM day_born_splits WHERE harvest_id=?`).run(id);
  const splits = parseDayBornInputs(req.body);
  const insSplit = db.prepare(`INSERT INTO day_born_splits (harvest_id, day_born, amount, head_count) VALUES (?, ?, ?, ?)`);
  for (const s of splits) insSplit.run(id, s.day, s.amount, s.head_count);
  res.redirect(`/finance/harvests/${id}`);
});

app.post('/finance/harvests/:id/delete', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    reverseLinkedJournal('harvests', 'harvest_id', id, 'Harvest archived', res.locals.user.user_id);
    db.prepare(`UPDATE harvests SET deleted_at=CURRENT_TIMESTAMP WHERE harvest_id=?`).run(id);
  })();
  logActivity('finance_reversal', `Harvest #${id} archived and journal reversed`,
    '/finance/harvests', res.locals.user.user_id);
  res.redirect('/finance/harvests');
});

// ---------- finance: special offerings ----------
app.get('/finance/special', (req, res) => {
  const cats = loadSpecialCategories();
  const members = loadMembersList();
  const rows = db.prepare(`
    SELECT sp.special_id, sp.offering_date, sp.amount, sp.purpose, sp.receipt_number,
           sc.category_name, sp.donor_id, sp.donor_name_manual,
           m.first_name || ' ' || m.last_name AS member_name
    FROM special_offerings sp
    JOIN special_categories sc USING(special_cat_id)
    LEFT JOIN members m ON m.member_id = sp.donor_id
    WHERE sp.deleted_at IS NULL
    ORDER BY sp.offering_date DESC, sp.special_id DESC LIMIT 100`).all();
  const catOpts = cats.map((c) => `<option value="${c.special_cat_id}">${esc(c.category_name)}</option>`).join('');
  const memOpts = '<option value="">(non-member or anonymous)</option>' +
    members.map((m) => `<option value="${m.member_id}">${esc(m.name)}${m.external_id ? ' · ' + esc(m.external_id) : ''}</option>`).join('');
  const addForm = res.locals.canFinanceWrite
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record a special offering</strong></summary>
         <form class="form" method="post" action="/finance/special" style="margin-top:0.75rem">
           <label>Date<input type="date" name="offering_date" required value="${todayISO()}"></label>
           <label>Category<select name="special_cat_id" required>${catOpts}</select></label>
           <label>Member<select name="donor_id">${memOpts}</select></label>
           <label>Manual donor name<input name="donor_name_manual" placeholder="if not a member"></label>
           <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
           <label>Receipt #<input name="receipt_number"></label>
           <label class="wide">Purpose<input name="purpose"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save</button></div>
         </form>
       </details>` : '';
  const body = `
    ${addForm}
    ${rows.length ? table(['Date', 'Donor', 'Category', 'Amount', 'Receipt', 'Purpose'],
      rows.map((r) => [esc(r.offering_date),
        r.donor_id ? `<a href="/members/${r.donor_id}">${esc(r.member_name)}</a>`
          : esc(r.donor_name_manual) || '(anonymous)',
        esc(r.category_name), fmtMoney(r.amount), esc(r.receipt_number),
        esc(r.purpose)]))
      : '<p class="muted-text">No special offerings recorded yet.</p>'}`;
  res.page({ title: 'Finance · Special Offerings', active: '/finance', body });
});

app.post('/finance/special', requireFinanceWrite, (req, res) => {
  const b = req.body;
  if (!Number(b.special_cat_id)) { flash(req, 'Choose a category.'); return res.redirect('/finance/special'); }
  if (!isValidDate(b.offering_date)) { flash(req, 'Enter a valid offering date.'); return res.redirect('/finance/special'); }
  if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/special'); }
  db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO special_offerings (special_cat_id, offering_date, donor_id, donor_name_manual,
        amount, purpose, receipt_number, recorded_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Number(b.special_cat_id), b.offering_date,
      b.donor_id ? Number(b.donor_id) : null,
      b.donor_name_manual || null,
      Number(b.amount), b.purpose || null, b.receipt_number || null,
      res.locals.user.user_id, b.notes || null
    );
    const cat = db.prepare(`SELECT category_name FROM special_categories WHERE special_cat_id=?`).get(Number(b.special_cat_id));
    const entryId = postCashIncome(db, {
      date: b.offering_date,
      amount: Number(b.amount),
      incomeAccount: incomeAccountFor(cat ? cat.category_name : 'special offering'),
      fundId: defaultFundId(),
      sourceType: 'SPECIAL_OFFERING',
      sourceId: info.lastInsertRowid,
      createdBy: res.locals.user.user_id,
      memo: b.purpose || (cat ? cat.category_name : 'Special offering'),
    });
    updateJournalLink('special_offerings', 'special_id', info.lastInsertRowid, entryId);
  })();
  logActivity('contribution_recorded',
    `Special offering of ${fmtMoney(b.amount)} recorded`,
    '/finance/special', res.locals.user.user_id);
  res.redirect('/finance/special');
});

// ---------- finance: tithes ----------
app.get('/finance/tithes', (req, res) => {
  const memberId = req.query.member_id ? Number(req.query.member_id) : null;
  const members = loadMembersList();
  const memOpts = '<option value="">— all members —</option>' +
    members.map((m) => `<option value="${m.member_id}" ${m.member_id === memberId ? 'selected' : ''}>${esc(m.name)}${m.external_id ? ' · ' + esc(m.external_id) : ''}</option>`).join('');
  const memOptsForm = members.map((m) => `<option value="${m.member_id}">${esc(m.name)}${m.external_id ? ' · ' + esc(m.external_id) : ''}</option>`).join('');

  const where = memberId ? 'AND t.member_id = ?' : '';
  const params = memberId ? [memberId] : [];

  const rows = db.prepare(`
    SELECT t.tithe_id, t.member_id, t.tithe_date, t.amount, t.method, t.reference, t.notes,
           m.first_name || ' ' || m.last_name AS member, m.external_id,
           COALESCE(u.display_name, u.username) AS recorded_by
    FROM tithes t
    JOIN members m USING(member_id)
    LEFT JOIN users u ON u.user_id = t.recorded_by
    WHERE t.deleted_at IS NULL ${where}
    ORDER BY t.tithe_date DESC, t.tithe_id DESC LIMIT 200
  `).all(...params);

  const ytdTotal = db.prepare(`
    SELECT COALESCE(SUM(amount),0) t FROM tithes
    WHERE deleted_at IS NULL ${where ? where.replace('t.member_id', 'member_id') : ''}
      AND substr(tithe_date,1,4) = strftime('%Y','now')
  `).get(...params).t;
  const monthTotal = db.prepare(`
    SELECT COALESCE(SUM(amount),0) t FROM tithes
    WHERE deleted_at IS NULL ${where ? where.replace('t.member_id', 'member_id') : ''}
      AND substr(tithe_date,1,7) = strftime('%Y-%m','now')
  `).get(...params).t;
  const tithers = db.prepare(`
    SELECT COUNT(DISTINCT member_id) c FROM tithes
    WHERE deleted_at IS NULL
      AND substr(tithe_date,1,4) = strftime('%Y','now')
  `).get().c;

  // Top tithers YTD (when not filtered).
  const topTithers = memberId ? [] : db.prepare(`
    SELECT m.member_id, m.first_name || ' ' || m.last_name AS name, m.external_id,
           ROUND(SUM(t.amount), 2) AS total
    FROM tithes t JOIN members m USING(member_id)
    WHERE t.deleted_at IS NULL AND m.deleted_at IS NULL
      AND substr(t.tithe_date,1,4) = strftime('%Y','now')
    GROUP BY m.member_id ORDER BY total DESC LIMIT 10
  `).all();

  const addForm = res.locals.canFinanceWrite
    ? `<details class="form-toggle" style="margin-bottom:1rem" ${memberId ? 'open' : ''}>
         <summary><strong>+ Record a tithe</strong></summary>
         <form class="form" method="post" action="/finance/tithes" style="margin-top:0.75rem">
           <label>Member<select name="member_id" required>
             ${memberId ? `<option value="${memberId}" selected>${esc((members.find((x) => x.member_id === memberId) || {}).name) || '?'}</option>` : ''}
             ${memOptsForm}
           </select></label>
           <label>Date<input type="date" name="tithe_date" required value="${todayISO()}"></label>
           <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
           <label>Method<select name="method">
             ${['cash','check','card','online','mobile_money','transfer','other'].map((m) => `<option>${m}</option>`).join('')}
           </select></label>
           <label>Reference<input name="reference" placeholder="e.g. MoMo ID"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save</button></div>
         </form>
       </details>` : '';

  const memberFilter = `
    <form class="filters" method="get" action="/finance/tithes">
      <label>Filter by member <select name="member_id" onchange="this.form.submit()">${memOpts}</select></label>
      <noscript><button type="submit">Apply</button></noscript>
      ${memberId ? `<a class="btn ghost" href="/finance/tithes">Clear filter</a>` : ''}
    </form>`;

  const stats = `
    <div class="stat-grid">
      <div class="stat"><div class="ico green">₵</div><div>
        <div class="label">${memberId ? "Member's YTD" : 'YTD Tithes'}</div>
        <div class="value">${fmtMoney(ytdTotal)}</div></div></div>
      <div class="stat"><div class="ico blue">📅</div><div>
        <div class="label">${memberId ? "Member's this month" : 'This month'}</div>
        <div class="value">${fmtMoney(monthTotal)}</div></div></div>
      ${memberId ? '' : `
        <div class="stat"><div class="ico purple">👥</div><div>
          <div class="label">Distinct tithers YTD</div>
          <div class="value">${tithers}</div></div></div>`}
    </div>`;

  const tithesTable = rows.length
    ? table(['Date', 'Member', 'ID', 'Amount', 'Method', 'Reference', 'By'],
        rows.map((r) => [esc(r.tithe_date),
          `<a href="/members/${r.member_id}">${esc(r.member)}</a>`,
          esc(r.external_id) || '—',
          fmtMoney(r.amount), esc(r.method), esc(r.reference),
          esc(r.recorded_by)]))
    : '<p class="muted-text">No tithes recorded for this filter.</p>';

  const topTable = topTithers.length
    ? `<h2>Top tithers · this year</h2>
       ${table(['Member', 'Member ID', 'YTD total'],
         topTithers.map((r) => [`<a href="/members/${r.member_id}">${esc(r.name)}</a>`,
           esc(r.external_id) || '—', fmtMoney(r.total)]))}`
    : '';

  res.page({
    title: 'Finance · Tithes', active: '/finance',
    body: `
      ${memberFilter}
      ${stats}
      ${addForm}
      ${memberId ? '<h2>Tithe history</h2>' : '<h2>Recent tithes</h2>'}
      ${tithesTable}
      ${topTable}`,
  });
});

app.post('/finance/tithes', requireFinanceWrite, (req, res) => {
  const b = req.body;
  if (!b.member_id || !b.amount || !b.tithe_date) return res.redirect('/finance/tithes');
  db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO tithes (member_id, amount, tithe_date, method, reference, notes, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      Number(b.member_id), Number(b.amount), b.tithe_date,
      b.method || null, b.reference || null, b.notes || null,
      res.locals.user.user_id
    );
    const entryId = postCashIncome(db, {
      date: b.tithe_date,
      amount: Number(b.amount),
      incomeAccount: incomeAccountFor('tithe'),
      fundId: defaultFundId(),
      sourceType: 'TITHE',
      sourceId: info.lastInsertRowid,
      createdBy: res.locals.user.user_id,
      memo: `Tithe from member #${b.member_id}`,
    });
    updateJournalLink('tithes', 'tithe_id', info.lastInsertRowid, entryId);
  })();
  const m = db.prepare(`SELECT first_name, last_name FROM members WHERE member_id=?`).get(Number(b.member_id));
  logActivity('contribution_recorded',
    `Tithe of ${fmtMoney(b.amount)} from ${m ? m.first_name + ' ' + m.last_name : 'a member'}`,
    `/finance/tithes?member_id=${b.member_id}`, res.locals.user.user_id);
  res.redirect(`/finance/tithes?member_id=${b.member_id}`);
});

// ---------- finance: pledges ----------
app.get('/finance/pledges', (req, res) => {
  const harvests = db.prepare(
    `SELECT harvest_id, harvest_name, harvest_year FROM harvests
       WHERE deleted_at IS NULL ORDER BY harvest_year DESC`
  ).all();
  const members = loadMembersList();
  const rows = db.prepare(`
    SELECT p.*, m.member_id, m.first_name || ' ' || m.last_name AS member,
           h.harvest_name
    FROM pledges p
    JOIN members m USING(member_id)
    JOIN harvests h USING(harvest_id)
    WHERE m.deleted_at IS NULL
    ORDER BY p.pledge_date DESC, p.pledge_id DESC LIMIT 100`).all();
  const harvestOpts = harvests.map((h) => `<option value="${h.harvest_id}">${esc(h.harvest_name)}</option>`).join('');
  const memOpts = members.map((m) => `<option value="${m.member_id}">${esc(m.name)}</option>`).join('');
  const addForm = res.locals.canFinanceWrite && harvests.length
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record a pledge</strong></summary>
         <form class="form" method="post" action="/finance/pledges" style="margin-top:0.75rem">
           <label>Member<select name="member_id" required>${memOpts}</select></label>
           <label>Harvest<select name="harvest_id" required>${harvestOpts}</select></label>
           <label>Pledged amount<input type="number" step="0.01" min="0.01" name="pledged_amount" required></label>
           <label>Paid amount<input type="number" step="0.01" min="0" name="paid_amount" value="0"></label>
           <label>Pledge date<input type="date" name="pledge_date" required value="${todayISO()}"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save</button></div>
         </form>
       </details>`
    : (res.locals.canFinanceWrite ? '<p class="muted-text">Add a harvest first on the Harvests tab.</p>' : '');
  const tbl = rows.length
    ? table(['Date', 'Member', 'Harvest', 'Pledged', 'Paid', 'Outstanding', 'Status', ''],
        rows.map((p) => [esc(p.pledge_date),
          `<a href="/members/${p.member_id}">${esc(p.member)}</a>`,
          esc(p.harvest_name),
          fmtMoney(p.pledged_amount), fmtMoney(p.paid_amount),
          fmtOutstanding(p.pledged_amount - p.paid_amount),
          `<span class="pill pill-${esc(p.status.toLowerCase())}">${esc(p.status)}</span>`,
          res.locals.canFinanceWrite
            ? `<form method="post" action="/finance/pledges/${p.pledge_id}/pay" class="inline">
                 <input type="number" step="0.01" min="0" name="add" placeholder="add">
                 <button type="submit">Record</button>
               </form>
               <a class="btn-link" href="/finance/pledges/${p.pledge_id}/edit" style="margin-left:0.5rem">Edit</a>` : '']))
    : '<p class="muted-text">No pledges recorded yet.</p>';
  const body = `
    ${addForm}
    ${tbl}`;
  res.page({ title: 'Finance · Pledges', active: '/finance', body });
});

app.post('/finance/pledges', requireFinanceWrite, (req, res) => {
  const b = req.body;
  const pledged = Number(b.pledged_amount);
  const paid = Number(b.paid_amount || 0);
  const status = paid <= 0 ? 'Pending' : paid >= pledged ? 'Fulfilled' : 'Partial';
  db.prepare(`
    INSERT INTO pledges (member_id, harvest_id, pledged_amount, paid_amount, pledge_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    Number(b.member_id), Number(b.harvest_id),
    pledged, paid, b.pledge_date, status, b.notes || null
  );
  res.redirect('/finance/pledges');
});

app.post('/finance/pledges/:id/pay', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  const add = Number(req.body.add || 0);
  if (add <= 0) return res.redirect('/finance/pledges');
  const receipt = recordPledgePayment(id, add, todayISO(), res.locals.user.user_id, null);
  if (!receipt) return res.redirect('/finance/pledges');
  logActivity('pledge_payment',
    `Recorded ${fmtMoney(add)} pledge payment · receipt ${receipt.receipt_number}`,
    `/finance/pledges/payments/${receipt.payment_id}/receipt`, res.locals.user.user_id);
  res.redirect(`/finance/pledges/payments/${receipt.payment_id}/receipt?new=1`);
});

app.get('/finance/pledges/:id/edit', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare(`SELECT * FROM pledges WHERE pledge_id=?`).get(id);
  if (!p) return res.redirect('/finance/pledges');
  const harvests = db.prepare(
    `SELECT harvest_id, harvest_name FROM harvests WHERE deleted_at IS NULL ORDER BY harvest_year DESC`
  ).all();
  const members = loadMembersList();
  const harvestOpts = harvests.map((h) =>
    `<option value="${h.harvest_id}" ${h.harvest_id === p.harvest_id ? 'selected' : ''}>${esc(h.harvest_name)}</option>`).join('');
  const memOpts = members.map((m) =>
    `<option value="${m.member_id}" ${m.member_id === p.member_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const body = `
    <p><a href="/finance/pledges">← Back to pledges</a></p>
    <form class="form" method="post" action="/finance/pledges/${id}/edit">
      <label>Member<select name="member_id" required>${memOpts}</select></label>
      <label>Harvest<select name="harvest_id" required>${harvestOpts}</select></label>
      <label>Pledged amount<input type="number" step="0.01" min="0.01" name="pledged_amount" required value="${p.pledged_amount}"></label>
      <label>Paid amount<input type="number" step="0.01" min="0" name="paid_amount" value="${p.paid_amount}"></label>
      <label>Pledge date<input type="date" name="pledge_date" required value="${fmtDate(p.pledge_date)}"></label>
      <label class="wide">Notes<input name="notes" value="${esc(p.notes || '')}"></label>
      <div class="actions"><button type="submit">Save changes</button></div>
    </form>`;
  res.page({ title: 'Edit pledge', active: '/finance', body });
});

app.post('/finance/pledges/:id/edit', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const pledged = Number(b.pledged_amount);
  const paid = Number(b.paid_amount || 0);
  const status = paid <= 0 ? 'Pending' : paid >= pledged ? 'Fulfilled' : 'Partial';
  db.prepare(`UPDATE pledges SET member_id=?, harvest_id=?, pledged_amount=?, paid_amount=?,
                                  pledge_date=?, status=?, notes=? WHERE pledge_id=?`).run(
    Number(b.member_id), Number(b.harvest_id), pledged, paid,
    b.pledge_date, status, b.notes || null, id
  );
  logActivity('pledge_edited', `Pledge #${id} edited`, '/finance/pledges', res.locals.user.user_id);
  res.redirect('/finance/pledges');
});

// ---------- finance: pledge receipts & outstanding statements ----------

// Record a payment toward a pledge: append a payment row with its own sequential
// receipt number (RCT-#####), bump the pledge's paid amount + status, all atomically.
const recordPledgePayment = db.transaction((pledgeId, amount, paidOn, userId, notes) => {
  const p = db.prepare(`
    SELECT p.pledged_amount, p.paid_amount, h.harvest_name
    FROM pledges p JOIN harvests h USING(harvest_id)
    WHERE p.pledge_id=?`).get(pledgeId);
  if (!p) return null;
  const info = db.prepare(
    `INSERT INTO pledge_payments (pledge_id, amount, paid_on, receipt_number, recorded_by, notes)
     VALUES (?, ?, ?, '', ?, ?)`
  ).run(pledgeId, amount, paidOn, userId, notes || null);
  const receiptNumber = 'RCT-' + String(info.lastInsertRowid).padStart(5, '0');
  db.prepare(`UPDATE pledge_payments SET receipt_number=? WHERE payment_id=?`)
    .run(receiptNumber, info.lastInsertRowid);
  const newPaid = p.paid_amount + amount;
  const status = newPaid >= p.pledged_amount ? 'Fulfilled' : 'Partial';
  db.prepare(`UPDATE pledges SET paid_amount=?, status=? WHERE pledge_id=?`).run(newPaid, status, pledgeId);
  const entryId = postCashIncome(db, {
    date: paidOn,
    amount,
    incomeAccount: incomeAccountFor('pledge payment'),
    fundId: defaultFundId(),
    sourceType: 'PLEDGE_PAYMENT',
    sourceId: info.lastInsertRowid,
    createdBy: userId,
    memo: `${p.harvest_name || 'Harvest'} pledge payment ${receiptNumber}`,
  });
  updateJournalLink('pledge_payments', 'payment_id', info.lastInsertRowid, entryId);
  return { payment_id: info.lastInsertRowid, receipt_number: receiptNumber };
});

// One payment receipt, with the running balance as of that payment so reprints are stable.
function loadPaymentReceipt(paymentId) {
  return db.prepare(`
    SELECT pay.*, p.pledged_amount, p.member_id, p.harvest_id,
           m.first_name, m.last_name, m.mobile_phone, m.email,
           m.preferred_channel, m.unsubscribe_token,
           h.harvest_name, h.harvest_year,
           u.display_name AS recorded_by_name, u.username AS recorded_by_user,
           (SELECT COALESCE(SUM(x.amount), 0) FROM pledge_payments x
             WHERE x.pledge_id = pay.pledge_id AND x.payment_id <= pay.payment_id) AS paid_to_date
    FROM pledge_payments pay
    JOIN pledges  p ON p.pledge_id  = pay.pledge_id
    JOIN members  m ON m.member_id  = p.member_id
    JOIN harvests h ON h.harvest_id = p.harvest_id
    LEFT JOIN users u ON u.user_id = pay.recorded_by
    WHERE pay.payment_id = ?`).get(paymentId);
}

// Members who still owe on at least one (non-cancelled) pledge.
function membersWithOutstanding() {
  return db.prepare(`
    SELECT m.member_id, m.first_name || ' ' || m.last_name AS name,
           SUM(p.pledged_amount) AS pledged, SUM(p.paid_amount) AS paid,
           SUM(p.pledged_amount - p.paid_amount) AS outstanding,
           COUNT(*) AS pledge_count
    FROM pledges p JOIN members m USING(member_id)
    WHERE m.deleted_at IS NULL AND p.status != 'Cancelled'
      AND p.pledged_amount - p.paid_amount > 0.005
    GROUP BY m.member_id
    ORDER BY outstanding DESC`).all();
}

// A member's still-outstanding pledges, for the statement.
function memberOutstandingDetail(memberId) {
  const member = db.prepare(
    `SELECT member_id, first_name, last_name, mobile_phone, email, preferred_channel, unsubscribe_token
       FROM members WHERE member_id=? AND deleted_at IS NULL`
  ).get(memberId);
  if (!member) return null;
  const pledges = db.prepare(`
    SELECT p.*, h.harvest_name, h.harvest_year
    FROM pledges p JOIN harvests h USING(harvest_id)
    WHERE p.member_id=? AND p.status != 'Cancelled'
      AND p.pledged_amount - p.paid_amount > 0.005
    ORDER BY p.pledge_date`).all(memberId);
  return { member, pledges };
}

// Send a message to a member over the channel(s) their preference allows.
async function sendMemberMessage(member, smsText, emailSubject, emailText) {
  const pref = member.preferred_channel || 'none';
  if (pref === 'none') return { ok: false, reason: 'do_not_contact' };
  const phone = (pref === 'either' || pref === 'sms_only') ? normalizePhoneGH(member.mobile_phone) : null;
  const email = (pref === 'either' || pref === 'email_only') ? (member.email || null) : null;
  if (!phone && !email) return { ok: false, reason: 'no_contact' };
  let sms = null, mail = null;
  if (phone) { try { sms = await sendSmsBatch([phone], smsText); } catch (e) { sms = { ok: false, error: e.message }; } }
  if (email) {
    try { mail = await sendEmailEach([{ addr: email, token: member.unsubscribe_token }], emailSubject, emailText); }
    catch (e) { mail = { ok: false, error: e.message }; }
  }
  const channels = [];
  if (phone) channels.push('SMS');
  if (email) channels.push('email');
  return {
    ok: true, dryRun: (sms && sms.dryRun) || (mail && mail.dryRun),
    channels: channels.join(' + '),
    smsOk: sms ? (sms.ok || sms.dryRun) : null,
    emailOk: mail ? (mail.ok || mail.dryRun) : null,
  };
}

const RECEIPT_FLASH = {
  new: 'Payment recorded. Here is the receipt — print it or send it to the member.',
  sent: 'Receipt sent to the member.',
  dry: 'Receipt logged as a dry run — SMS/email are not configured, so nothing was actually delivered.',
  nocontact: 'Could not send: the member has no phone or email matching their contact preference.',
  donotcontact: 'Could not send: this member is set to "Do not contact". Update their preference first.',
};

app.get('/finance/pledges/payments/:id/receipt', (req, res) => {
  const r = loadPaymentReceipt(Number(req.params.id));
  if (!r) return res.status(404).send('Receipt not found');
  const memberName = `${r.first_name} ${r.last_name}`.trim();
  const outstanding = r.pledged_amount - r.paid_to_date;
  const recordedBy = r.recorded_by_name || r.recorded_by_user || '—';
  const sendForm = res.locals.canFinanceWrite
    ? `<form method="post" action="/finance/pledges/payments/${r.payment_id}/send"
            onsubmit="return confirm('Send this receipt to ${esc(memberName)} via their preferred channel?')">
         <button type="submit">📤 Send receipt to ${esc(r.first_name)}</button>
       </form>` : '';
  const body = `
    <div class="screen-only receipt-actions">
      <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
      ${sendForm}
      <a class="btn-link" href="/finance/receipts">← Back to receipts</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${esc(CHURCH_NAME)}</div>
          <div class="muted-text">Pledge Payment Receipt</div></div>
        <div class="rc-no"><strong>${esc(r.receipt_number)}</strong><br>
          <span class="muted-text">${esc(r.paid_on)}</span></div>
      </div>
      <div class="rc-line"><span>Received from</span><strong>${esc(memberName)}</strong></div>
      <div class="rc-line"><span>For</span><span>${esc(r.harvest_name)}${r.harvest_year ? ' ' + esc(String(r.harvest_year)) : ''} pledge</span></div>
      <div class="rc-line"><span>Amount received</span><strong>${fmtMoney(r.amount)}</strong></div>
      <div class="rc-line"><span>Total pledged</span><span>${fmtMoney(r.pledged_amount)}</span></div>
      <div class="rc-line"><span>Paid to date</span><span>${fmtMoney(r.paid_to_date)}</span></div>
      <div class="rc-line rc-total"><span>Outstanding balance</span><span>${fmtMoney(outstanding)}</span></div>
      <div class="rc-line"><span>Recorded by</span><span>${esc(recordedBy)}</span></div>
      ${r.sent_at ? `<p class="muted-text" style="margin-top:1rem">Sent to member on ${esc(String(r.sent_at).slice(0, 16))}${r.sent_channel ? ` via ${esc(r.sent_channel)}` : ''}.</p>` : ''}
      <p class="rc-foot">${outstanding > 0.005
        ? `Thank you. A balance of <strong>${fmtMoney(outstanding)}</strong> remains on this pledge.`
        : 'This pledge is now fully paid. Thank you!'}</p>
    </div>`;
  res.page({
    title: `Receipt ${r.receipt_number}`, active: '/finance',
    flash: RECEIPT_FLASH[req.query.sent] || RECEIPT_FLASH[req.query.new ? 'new' : ''],
    body,
  });
});

app.post('/finance/pledges/payments/:id/send', requireFinanceWrite, async (req, res) => {
  const r = loadPaymentReceipt(Number(req.params.id));
  if (!r) return res.redirect('/finance/receipts');
  const memberName = `${r.first_name} ${r.last_name}`.trim();
  const outstanding = r.pledged_amount - r.paid_to_date;
  const balanceLine = outstanding > 0.005
    ? `Outstanding balance: ${fmtMoney(outstanding)}.`
    : 'This pledge is now fully paid.';
  const sms = `Receipt ${r.receipt_number}: Dear ${r.first_name}, we received ${fmtMoney(r.amount)} toward your ${r.harvest_name} pledge on ${r.paid_on}. ${balanceLine} Thank you. — ${CHURCH_NAME}`;
  const emailBody =
    `Dear ${memberName},\n\nThank you for your payment. This is your official receipt.\n\n` +
    `Receipt no:   ${r.receipt_number}\n` +
    `Date:         ${r.paid_on}\n` +
    `Pledge:       ${r.harvest_name}${r.harvest_year ? ' ' + r.harvest_year : ''}\n` +
    `Amount paid:  ${fmtMoney(r.amount)}\n` +
    `Total pledged:${fmtMoney(r.pledged_amount)}\n` +
    `Paid to date: ${fmtMoney(r.paid_to_date)}\n` +
    `${balanceLine}\n\nGod bless you.\n${CHURCH_NAME}`;
  const result = await sendMemberMessage(r, sms, `Payment receipt ${r.receipt_number} — ${CHURCH_NAME}`, emailBody);
  if (!result.ok) {
    return res.redirect(`/finance/pledges/payments/${r.payment_id}/receipt?sent=${result.reason === 'do_not_contact' ? 'donotcontact' : 'nocontact'}`);
  }
  db.prepare(`UPDATE pledge_payments SET sent_at=CURRENT_TIMESTAMP, sent_channel=? WHERE payment_id=?`)
    .run(result.channels, r.payment_id);
  logActivity('receipt_sent', `Sent receipt ${r.receipt_number} to ${memberName}`,
    `/finance/pledges/payments/${r.payment_id}/receipt`, res.locals.user.user_id);
  res.redirect(`/finance/pledges/payments/${r.payment_id}/receipt?sent=${result.dryRun ? 'dry' : 'sent'}`);
});

app.get('/finance/pledges/statement/:memberId', (req, res) => {
  const data = memberOutstandingDetail(Number(req.params.memberId));
  if (!data) return res.status(404).send('Member not found');
  const { member, pledges } = data;
  const memberName = `${member.first_name} ${member.last_name}`.trim();
  const totalOutstanding = pledges.reduce((a, p) => a + (p.pledged_amount - p.paid_amount), 0);
  const sendForm = res.locals.canFinanceWrite && pledges.length
    ? `<form method="post" action="/finance/pledges/statement/${member.member_id}/send"
            onsubmit="return confirm('Send this outstanding-balance statement to ${esc(memberName)}?')">
         <button type="submit">📤 Send statement to ${esc(member.first_name)}</button>
       </form>` : '';
  const rowsHtml = pledges.length
    ? table(['Date', 'Harvest', 'Pledged', 'Paid', 'Outstanding'],
        pledges.map((p) => [
          esc(p.pledge_date), esc(p.harvest_name),
          fmtMoney(p.pledged_amount), fmtMoney(p.paid_amount),
          fmtOutstanding(p.pledged_amount - p.paid_amount),
        ]))
    : '<p class="muted-text">This member has no outstanding pledges. 🎉</p>';
  const body = `
    <div class="screen-only receipt-actions">
      <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
      ${sendForm}
      <a class="btn-link" href="/finance/receipts">← Back to receipts</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${esc(CHURCH_NAME)}</div>
          <div class="muted-text">Outstanding Pledge Statement</div></div>
        <div class="rc-no"><strong>${esc(memberName)}</strong><br>
          <span class="muted-text">As of ${todayISO()}</span></div>
      </div>
      ${rowsHtml}
      ${pledges.length ? `<div class="rc-line rc-total" style="margin-top:0.75rem">
        <span>Total outstanding</span><span>${fmtMoney(totalOutstanding)}</span></div>
        <p class="rc-foot">Kindly redeem your outstanding pledge${pledges.length > 1 ? 's' : ''} at your earliest convenience. Thank you.</p>` : ''}
    </div>`;
  res.page({
    title: `Statement — ${memberName}`, active: '/finance',
    flash: RECEIPT_FLASH[req.query.sent],
    body,
  });
});

app.post('/finance/pledges/statement/:memberId/send', requireFinanceWrite, async (req, res) => {
  const data = memberOutstandingDetail(Number(req.params.memberId));
  if (!data) return res.redirect('/finance/receipts');
  const { member, pledges } = data;
  if (!pledges.length) return res.redirect(`/finance/pledges/statement/${member.member_id}`);
  const memberName = `${member.first_name} ${member.last_name}`.trim();
  const total = pledges.reduce((a, p) => a + (p.pledged_amount - p.paid_amount), 0);
  const lines = pledges.map((p) =>
    `  • ${p.harvest_name}: ${fmtMoney(p.pledged_amount - p.paid_amount)} outstanding`).join('\n');
  const sms = `Dear ${member.first_name}, our records show a total outstanding pledge balance of ${fmtMoney(total)} across ${pledges.length} pledge(s). Kindly redeem it when you can. Thank you. — ${CHURCH_NAME}`;
  const emailBody =
    `Dear ${memberName},\n\nThis is a friendly statement of your outstanding pledge balance.\n\n${lines}\n\n` +
    `Total outstanding: ${fmtMoney(total)}\n\nKindly redeem your pledge(s) at your earliest convenience.\n\nGod bless you.\n${CHURCH_NAME}`;
  const result = await sendMemberMessage(member, sms, `Your pledge statement — ${CHURCH_NAME}`, emailBody);
  if (!result.ok) {
    return res.redirect(`/finance/pledges/statement/${member.member_id}?sent=${result.reason === 'do_not_contact' ? 'donotcontact' : 'nocontact'}`);
  }
  logActivity('statement_sent', `Sent outstanding-pledge statement to ${memberName}`,
    `/finance/pledges/statement/${member.member_id}`, res.locals.user.user_id);
  res.redirect(`/finance/pledges/statement/${member.member_id}?sent=${result.dryRun ? 'dry' : 'sent'}`);
});

// ---------- giving statements (per-member annual contribution summary) ----------

app.get('/finance/statements', (req, res) => {
  const year = safeYear(req.query.year);
  const rows = givingByMember(db, year);

  const totalGiving = rows.reduce((s, r) => s + r.total, 0);
  const yearSel = `<form method="get" class="filter-bar" style="margin:0">
      <label class="muted-text" style="display:flex;align-items:center;gap:0.4rem">Year
        <select name="year" onchange="this.form.submit()">
          ${givingYears().map((y) => `<option ${String(y) === year ? 'selected' : ''}>${y}</option>`).join('')}
        </select></label>
    </form>`;
  const inner = rows.length
    ? `<table class="data-table members-table">
        <thead><tr><th>Member</th><th>Gifts</th><th>Total ${year}</th><th>Statement</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td data-label="Member"><a class="m-name" href="/members/${r.member_id}">${esc(r.name)}</a>
            <div class="m-sub">${esc(r.external_id) || '—'}</div></td>
          <td data-label="Gifts">${r.gifts}</td>
          <td data-label="Total">${fmtMoney(r.total)}</td>
          <td data-label="Statement"><a class="btn ghost" href="/members/${r.member_id}/statement?year=${year}">View →</a></td>
        </tr>`).join('')}</tbody>
      </table>`
    : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">🧾</div>
        <h3>No giving recorded for ${year}</h3>
        <p>Once contributions are linked to members, you'll see them here. Try a different year, or record a new offering.</p>
        <a class="btn primary" href="/finance/services/new">＋ Record Service</a>
      </div>`;

  res.page({
    title: 'Finance · Statements', active: '/finance', noHeader: true,
    body: `${pageHero('Giving Statements', 'Per-member annual contribution summaries for year-end records.')}
      ${statsRow([
        { cls: 'gold', icon: '🧾', value: rows.length.toLocaleString(), label: `Givers in ${year}` },
        { cls: 'green', icon: '₵', value: fmtMoney(totalGiving), label: `Attributed Giving ${year}` },
      ], yearSel)}
      ${listCard({ title: `Members with giving in ${year}`, count: rows.length, countLabel: 'members', inner })}`,
  });
});

app.get('/members/:id/statement', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare(`SELECT member_id, external_id, first_name, last_name
    FROM members WHERE member_id=? AND deleted_at IS NULL`).get(id);
  if (!m) return res.status(404).send('Member not found');
  const year = safeYear(req.query.year);
  const { lines, byGroup, total } = memberGivingForYear(id, year);
  const name = `${m.first_name} ${m.last_name}`.trim();

  const yearSel = `<form method="get" class="screen-only" style="display:inline">
      <label>Year <select name="year" onchange="this.form.submit()">
        ${givingYears().map((y) => `<option ${String(y) === year ? 'selected' : ''}>${y}</option>`).join('')}
      </select></label></form>`;
  const rowsHtml = lines.length
    ? table(['Date', 'Category', 'Details', 'Amount'],
        lines.map((l) => [esc(l.dt), esc(l.category), esc(l.detail) || '—', fmtMoney(l.amount)]))
    : `<p class="muted-text">No giving was recorded for ${esc(name)} in ${year}.</p>`;
  const subtotals = Object.entries(byGroup)
    .map(([g, a]) => `<div class="rc-line"><span>${esc(g)}</span><span>${fmtMoney(a)}</span></div>`).join('');

  const body = `
    <div class="screen-only receipt-actions">
      <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
      ${yearSel}
      <a class="btn-link" href="/finance/statements?year=${year}">← Back to statements</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${esc(CHURCH_NAME)}</div>
          <div class="muted-text">Annual Giving Statement · ${year}</div></div>
        <div class="rc-no"><strong>${esc(name)}</strong><br>
          <span class="muted-text">${esc(m.external_id) || ''}</span></div>
      </div>
      ${rowsHtml}
      ${lines.length ? `<div style="margin-top:0.75rem">${subtotals}
        <div class="rc-line rc-total"><span>Total giving ${year}</span><span>${fmtMoney(total)}</span></div></div>
        <p class="rc-foot">Thank you for your faithful giving. This statement summarises contributions
          recorded for the ${year} calendar year and is provided for your records. Please retain it for
          your reference.</p>` : ''}
    </div>`;
  res.page({ title: `Giving Statement — ${name}`, active: '/finance', noHeader: true, body });
});

app.get('/finance/receipts', (req, res) => {
  const outstanding = membersWithOutstanding();
  const unified = db.prepare(`
    SELECT fr.*, u.display_name, u.username
    FROM finance_receipts fr
    LEFT JOIN users u ON u.user_id=fr.created_by
    ORDER BY fr.receipt_date DESC, fr.receipt_id DESC
    LIMIT 80`).all();
  const recent = db.prepare(`
    SELECT pay.payment_id, pay.receipt_number, pay.amount, pay.paid_on, pay.sent_at, pay.sent_channel,
           m.member_id, m.first_name || ' ' || m.last_name AS member, h.harvest_name
    FROM pledge_payments pay
    JOIN pledges  p ON p.pledge_id  = pay.pledge_id
    JOIN members  m ON m.member_id  = p.member_id
    JOIN harvests h ON h.harvest_id = p.harvest_id
    WHERE m.deleted_at IS NULL
    ORDER BY pay.payment_id DESC LIMIT 50`).all();

  const totalOutstanding = outstanding.reduce((a, r) => a + r.outstanding, 0);
  const outstandingTbl = outstanding.length
    ? table(['Member', 'Pledges', 'Pledged', 'Paid', 'Outstanding', ''],
        outstanding.map((r) => [
          `<a href="/members/${r.member_id}">${esc(r.name)}</a>`,
          r.pledge_count, fmtMoney(r.pledged), fmtMoney(r.paid),
          fmtOutstanding(r.outstanding),
          `<a class="btn-link" href="/finance/pledges/statement/${r.member_id}">Statement</a>`,
        ]))
    : '<p class="muted-text">No members have outstanding pledges. 🎉</p>';

  const unifiedTbl = unified.length
    ? table(['Receipt', 'Date', 'Received from', 'Type', 'Amount', 'Status', ''],
        unified.map((r) => [
          esc(r.receipt_number),
          esc(r.receipt_date),
          esc(r.received_from || '—'),
          esc(String(r.source_type || '').replace(/_/g, ' ')),
          fmtMoney(r.amount),
          r.voided_at ? `<span class="pill pill-cancelled">Voided</span>` : `<span class="pill pill-fulfilled">Issued</span>`,
          `<a class="btn-link" href="/finance/receipts/${encodeURIComponent(r.receipt_number)}/print">Print</a>`,
        ]))
    : '<p class="muted-text">No all-purpose receipts yet. Record generic income or a day-born collection to issue one.</p>';

  const recentTbl = recent.length
    ? table(['Receipt', 'Date', 'Member', 'Harvest', 'Amount', 'Delivered', ''],
        recent.map((r) => [
          esc(r.receipt_number), esc(r.paid_on),
          `<a href="/members/${r.member_id}">${esc(r.member)}</a>`,
          esc(r.harvest_name), fmtMoney(r.amount),
          r.sent_at ? `<span class="pill pill-fulfilled">${esc(r.sent_channel || 'sent')}</span>` : '<span class="muted-text">not sent</span>',
          `<a class="btn-link" href="/finance/pledges/payments/${r.payment_id}/receipt">View</a>`,
        ]))
    : '<p class="muted-text">No payment receipts yet. Record a payment on the Pledges tab to issue one.</p>';

  const body = `
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Members with outstanding pledges</h2>
        <span class="meta">Total outstanding: <strong>${fmtMoney(totalOutstanding)}</strong></span></div>
      ${outstandingTbl}
    </section>
    <section class="card" style="margin-bottom:1rem">
      <h2>Printable income receipts</h2>
      ${unifiedTbl}
    </section>
    <section class="card">
      <h2>Recent pledge payment receipts</h2>
      ${recentTbl}
    </section>`;
  res.page({ title: 'Finance · Receipts', active: '/finance', body });
});

app.get('/finance/receipts/:receiptNo/print', (req, res) => {
  const receiptNo = decodeURIComponent(req.params.receiptNo);
  const r = db.prepare(`
    SELECT fr.*, u.display_name AS created_by_name, u.username AS created_by_user
    FROM finance_receipts fr
    LEFT JOIN users u ON u.user_id=fr.created_by
    WHERE fr.receipt_number=?`).get(receiptNo);
  if (!r) return res.status(404).send('Receipt not found');
  const createdBy = r.created_by_name || r.created_by_user || '—';
  const body = `
    <div class="screen-only receipt-actions">
      <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
      <a class="btn-link" href="/finance/receipts">← Back to receipts</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${esc(CHURCH_NAME)}</div>
          <div class="muted-text">Official Income Receipt</div></div>
        <div class="rc-no"><strong>${esc(r.receipt_number)}</strong><br>
          <span class="muted-text">${esc(r.receipt_date)}</span></div>
      </div>
      ${r.voided_at ? `<p class="pill pill-cancelled">Voided ${esc(String(r.voided_at).slice(0, 16))}${r.void_reason ? ': ' + esc(r.void_reason) : ''}</p>` : ''}
      <div class="rc-line"><span>Received from</span><strong>${esc(r.received_from || '—')}</strong></div>
      <div class="rc-line"><span>For</span><span>${esc(r.description || String(r.source_type || '').replace(/_/g, ' '))}</span></div>
      <div class="rc-line"><span>Receipt type</span><span>${esc(String(r.source_type || '').replace(/_/g, ' '))}</span></div>
      <div class="rc-line rc-total"><span>Amount received</span><strong>${fmtMoney(r.amount)}</strong></div>
      <div class="rc-line"><span>Recorded by</span><span>${esc(createdBy)}</span></div>
      <p class="rc-foot">Thank you for your support of ${esc(CHURCH_NAME)}.</p>
    </div>`;
  res.page({
    title: `Receipt ${r.receipt_number}`, active: '/finance', noHeader: true,
    flash: req.query.new ? 'Receipt issued. Print it or save it as PDF.' : null,
    body,
  });
});

// ---------- finance: settings ----------
app.get('/finance/settings', requireFundViewer, (req, res) => {
  const s = financeSettings();
  const canManage = res.locals.canFinanceManageFunds;
  const body = `
    <section class="card">
      <div class="card-head"><h2>Finance settings</h2><span class="meta">Receipt and voucher numbering</span></div>
      <form class="form" method="post" action="/finance/settings">
        <label>Receipt prefix<input name="receipt_prefix" required maxlength="24" value="${esc(s.receipt_prefix)}" ${canManage ? '' : 'disabled'}></label>
        <label>Voucher prefix<input name="voucher_prefix" required maxlength="24" value="${esc(s.voucher_prefix)}" ${canManage ? '' : 'disabled'}></label>
        <label>Small expense limit<input type="number" step="0.01" min="0" name="small_expense_max" value="${esc(s.small_expense_max || 0)}" ${canManage ? '' : 'disabled'}></label>
        <label>Medium expense limit<input type="number" step="0.01" min="0" name="medium_expense_max" value="${esc(s.medium_expense_max || 0)}" ${canManage ? '' : 'disabled'}></label>
        <label class="wide">Next receipt preview<input value="${esc(nextReceiptNo(todayISO()))}" disabled></label>
        <label class="wide">Next voucher preview<input value="${esc(nextVoucherNo(String(todayISO()).slice(0, 4)))}" disabled></label>
        ${canManage ? '<div class="actions"><button type="submit">Save settings</button></div>' : '<p class="muted-text wide">Only finance fund managers can change these settings.</p>'}
      </form>
    </section>`;
  res.page({ title: 'Finance · Settings', active: '/finance', body });
});

app.post('/finance/settings', requireFundManager, (req, res) => {
  const receiptPrefix = String(req.body.receipt_prefix || '').trim().replace(/\s+/g, '-').toUpperCase();
  const voucherPrefix = String(req.body.voucher_prefix || '').trim().replace(/\s+/g, '-').toUpperCase();
  if (!receiptPrefix || !voucherPrefix || !isMoneyNonNeg(req.body.small_expense_max || 0) || !isMoneyNonNeg(req.body.medium_expense_max || 0)) {
    flash(req, 'Enter valid prefixes and expense limits.');
    return res.redirect('/finance/settings');
  }
  db.prepare(`
    INSERT INTO finance_settings (setting_id, receipt_prefix, voucher_prefix, small_expense_max, medium_expense_max, updated_at)
    VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_id) DO UPDATE SET
      receipt_prefix=excluded.receipt_prefix,
      voucher_prefix=excluded.voucher_prefix,
      small_expense_max=excluded.small_expense_max,
      medium_expense_max=excluded.medium_expense_max,
      updated_at=CURRENT_TIMESTAMP`).run(
    receiptPrefix,
    voucherPrefix,
    Number(req.body.small_expense_max || 0),
    Number(req.body.medium_expense_max || 0)
  );
  logActivity('finance_settings_updated', 'Updated finance numbering settings', '/finance/settings', res.locals.user.user_id);
  res.redirect('/finance/settings');
});

// ---------- finance: funds ----------
app.get('/finance/funds', requireFundViewer, (req, res) => {
  const rows = db.prepare(`
    SELECT fund_id, COALESCE(code, '') code, name, fund_type, restricted,
           opening_balance, responsible_officer, notes, active
    FROM funds
    WHERE active=1
    ORDER BY fund_type, name`).all();
  const enriched = rows.map((fund) => ({
    ...fund,
    ...fundRaisedSpent(db, fund.fund_id),
    balance: fundBalance(db, fund.fund_id),
  }));
  const totalBalance = enriched.reduce((sum, row) => sum + Number(row.balance || 0), 0);
  const restrictedTotal = enriched
    .filter((row) => row.restricted)
    .reduce((sum, row) => sum + Number(row.balance || 0), 0);
  const addForm = res.locals.canFinanceManageFunds
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Add a fund</strong></summary>
         <form class="form" method="post" action="/finance/funds" style="margin-top:0.75rem">
           <label>Code<input name="code" maxlength="16" placeholder="GEN"></label>
           <label>Fund name<input name="name" required></label>
           <label>Type<select name="fund_type">${fundTypeOptions('GENERAL')}</select></label>
           <label>Opening balance (GH₵)<input type="number" step="0.01" min="0" name="opening_balance" value="0"></label>
           <label>Responsible officer<input name="responsible_officer"></label>
           <label><span>&nbsp;</span><label class="check" style="background:none;padding:0">
             <input type="checkbox" name="restricted" value="1"> Restricted fund</label></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save fund</button></div>
         </form>
       </details>` : '';
  const tableRows = enriched.map((fund) => {
    const restriction = fund.restricted
      ? '<span class="pill pill-pending">Restricted</span>'
      : '<span class="pill pill-fulfilled">Unrestricted</span>';
    const toggle = res.locals.canFinanceManageFunds
      ? `<form method="post" action="/finance/funds/${fund.fund_id}/restriction" style="display:inline">
           <input type="hidden" name="restricted" value="${fund.restricted ? '0' : '1'}">
           <button class="btn-link" type="submit">${fund.restricted ? 'Mark unrestricted' : 'Mark restricted'}</button>
         </form>`
      : '';
    const edit = res.locals.canFinanceManageFunds
      ? `<details>
           <summary class="btn-link">Edit</summary>
           <form class="form" method="post" action="/finance/funds/${fund.fund_id}" style="margin-top:0.75rem">
             <label>Code<input name="code" maxlength="16" value="${esc(fund.code || '')}"></label>
             <label>Fund name<input name="name" required value="${esc(fund.name)}"></label>
             <label>Type<select name="fund_type">${fundTypeOptions(fund.fund_type || 'GENERAL')}</select></label>
             <label>Opening balance (GH₵)<input type="number" step="0.01" min="0" name="opening_balance" value="${esc(fund.opening_balance || 0)}"></label>
             <label>Responsible officer<input name="responsible_officer" value="${esc(fund.responsible_officer || '')}"></label>
             <label><span>&nbsp;</span><label class="check" style="background:none;padding:0">
               <input type="checkbox" name="restricted" value="1" ${fund.restricted ? 'checked' : ''}> Restricted fund</label></label>
             <label class="wide">Notes<input name="notes" value="${esc(fund.notes || '')}"></label>
             <div class="actions"><button type="submit">Save changes</button></div>
           </form>
         </details>`
      : '';
    return [
      esc(fund.code) || '—',
      esc(fund.name),
      esc((fund.fund_type || 'GENERAL').replace(/_/g, ' ')),
      `${restriction}${toggle ? '<br>' + toggle : ''}`,
      esc(fund.responsible_officer || '—'),
      fmtMoney(fund.raised),
      fmtMoney(fund.spent),
      `<strong>${fmtMoney(fund.balance)}</strong>`,
      edit || '',
    ];
  });
  const body = `
    ${statsRow([
      { cls: 'blue', icon: '₵', value: fmtMoney(totalBalance), label: 'Total fund balances' },
      { cls: 'orange', icon: 'R', value: fmtMoney(restrictedTotal), label: 'Restricted balances' },
      { cls: 'green', icon: '#', value: enriched.length, label: 'Active funds' },
    ])}
    <div class="actions" style="margin-bottom:1rem">
      <a class="btn ghost" href="/finance/reports/funds">Fund report</a>
      <a class="btn ghost" href="/finance/reports/funds.csv">Export CSV</a>
    </div>
    ${addForm}
    <section class="card">
      <div class="card-head"><h2>Funds</h2><span class="meta">Restricted and unrestricted church money</span></div>
      ${tableRows.length ? table(['Code', 'Fund', 'Type', 'Restriction', 'Officer', 'Raised', 'Spent', 'Balance', ''], tableRows)
        : '<p class="muted-text">No funds configured yet.</p>'}
    </section>`;
  res.page({ title: 'Finance · Funds', active: '/finance', body });
});

app.post('/finance/funds', requireFundManager, (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim();
  const code = String(b.code || '').trim().toUpperCase() || null;
  const fundType = FUND_TYPES.includes(b.fund_type) ? b.fund_type : 'GENERAL';
  if (!name) { flash(req, 'Enter a fund name.'); return res.redirect('/finance/funds'); }
  if (!isMoneyNonNeg(b.opening_balance || 0)) { flash(req, 'Opening balance must be 0 or more.'); return res.redirect('/finance/funds'); }
  try {
    db.prepare(`
      INSERT INTO funds (code, name, fund_type, restricted, opening_balance, responsible_officer, notes, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
      code,
      name,
      fundType,
      b.restricted ? 1 : 0,
      Number(b.opening_balance || 0),
      b.responsible_officer || null,
      b.notes || null
    );
    logActivity('fund_created', `Created finance fund ${name}`, '/finance/funds', res.locals.user.user_id);
  } catch (err) {
    flash(req, /UNIQUE/.test(String(err && err.message)) ? 'Fund code or name already exists.' : 'Could not save fund.');
  }
  res.redirect('/finance/funds');
});

app.post('/finance/funds/:id', requireFundManager, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const name = String(b.name || '').trim();
  const code = String(b.code || '').trim().toUpperCase() || null;
  const fundType = FUND_TYPES.includes(b.fund_type) ? b.fund_type : 'GENERAL';
  if (!name) { flash(req, 'Enter a fund name.'); return res.redirect('/finance/funds'); }
  if (!isMoneyNonNeg(b.opening_balance || 0)) { flash(req, 'Opening balance must be 0 or more.'); return res.redirect('/finance/funds'); }
  try {
    db.prepare(`
      UPDATE funds
         SET code=?, name=?, fund_type=?, restricted=?, opening_balance=?,
             responsible_officer=?, notes=?
       WHERE fund_id=?`).run(
      code,
      name,
      fundType,
      b.restricted ? 1 : 0,
      Number(b.opening_balance || 0),
      b.responsible_officer || null,
      b.notes || null,
      id
    );
    logActivity('fund_updated', `Updated finance fund ${name}`, '/finance/funds', res.locals.user.user_id);
  } catch (err) {
    flash(req, /UNIQUE/.test(String(err && err.message)) ? 'Fund code or name already exists.' : 'Could not update fund.');
  }
  res.redirect('/finance/funds');
});

app.post('/finance/funds/:id/restriction', requireFundManager, (req, res) => {
  const id = Number(req.params.id);
  const restricted = req.body.restricted === '1' ? 1 : 0;
  const fund = db.prepare(`SELECT name FROM funds WHERE fund_id=?`).get(id);
  if (fund) {
    db.prepare(`UPDATE funds SET restricted=? WHERE fund_id=?`).run(restricted, id);
    logActivity('fund_restriction_updated',
      `${fund.name} marked ${restricted ? 'restricted' : 'unrestricted'}`,
      '/finance/funds', res.locals.user.user_id);
  }
  res.redirect('/finance/funds');
});

app.get('/finance/reports/funds', requireFundViewer, (req, res) => {
  const rows = db.prepare(`
    SELECT fund_id, COALESCE(code, '') code, name, fund_type, restricted,
           opening_balance, responsible_officer
    FROM funds
    WHERE active=1
    ORDER BY fund_type, name`).all().map((fund) => ({
      ...fund,
      ...fundRaisedSpent(db, fund.fund_id),
      balance: fundBalance(db, fund.fund_id),
    }));
  const totalRaised = rows.reduce((sum, row) => sum + Number(row.raised || 0), 0);
  const totalSpent = rows.reduce((sum, row) => sum + Number(row.spent || 0), 0);
  const totalBalance = rows.reduce((sum, row) => sum + Number(row.balance || 0), 0);
  const restrictedTotal = rows.filter((row) => row.restricted)
    .reduce((sum, row) => sum + Number(row.balance || 0), 0);
  const body = `
    <div class="screen-only receipt-actions">
      <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
      <a class="btn-link" href="/finance/funds">← Back to funds</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${esc(CHURCH_NAME)}</div>
          <div class="muted-text">Fund Report</div></div>
        <div class="rc-no"><strong>${todayISO()}</strong><br>
          <span class="muted-text">Restricted total ${fmtMoney(restrictedTotal)}</span></div>
      </div>
      ${rows.length ? table(['Code', 'Fund', 'Type', 'Restriction', 'Officer', 'Opening', 'Raised', 'Spent', 'Balance'],
        rows.map((fund) => [
          esc(fund.code) || '—',
          esc(fund.name),
          esc((fund.fund_type || 'GENERAL').replace(/_/g, ' ')),
          fund.restricted ? 'Restricted' : 'Unrestricted',
          esc(fund.responsible_officer || '—'),
          fmtMoney(fund.opening_balance || 0),
          fmtMoney(fund.raised),
          fmtMoney(fund.spent),
          `<strong>${fmtMoney(fund.balance)}</strong>`,
        ]).concat([[
          '',
          '<strong>Total</strong>',
          '',
          '',
          '',
          '',
          `<strong>${fmtMoney(totalRaised)}</strong>`,
          `<strong>${fmtMoney(totalSpent)}</strong>`,
          `<strong>${fmtMoney(totalBalance)}</strong>`,
        ]])) : '<p class="muted-text">No active funds configured.</p>'}
    </div>`;
  res.page({ title: 'Finance · Fund Report', active: '/finance', noHeader: true, body });
});

app.get('/finance/reports/funds.csv', requireFundViewer, (req, res) => {
  const rows = db.prepare(`
    SELECT fund_id, COALESCE(code, '') code, name, fund_type, restricted,
           opening_balance, responsible_officer
    FROM funds
    WHERE active=1
    ORDER BY fund_type, name`).all().map((fund) => ({
    ...fund,
    ...fundRaisedSpent(db, fund.fund_id),
    balance: fundBalance(db, fund.fund_id),
  }));
  sendFinanceCsv(res, 'finance-funds.csv', [
    ['Code', 'Fund', 'Type', 'Restricted', 'Officer', 'Opening', 'Raised', 'Spent', 'Balance'],
    ...rows.map((fund) => [
      fund.code,
      fund.name,
      fund.fund_type,
      fund.restricted ? 'Yes' : 'No',
      fund.responsible_officer || '',
      fund.opening_balance || 0,
      fund.raised,
      fund.spent,
      fund.balance,
    ]),
  ]);
});

// ---------- finance: projects ----------
app.get('/finance/projects', requireFundViewer, (req, res) => {
  const enriched = projectFinanceRows().sort((a, b) => {
    const rank = { ACTIVE: 1, PLANNING: 2, ON_HOLD: 3, COMPLETED: 4, CANCELLED: 5 };
    return (rank[a.status] || 9) - (rank[b.status] || 9) || String(b.created_at).localeCompare(String(a.created_at));
  });
  const addForm = res.locals.canFinanceManageFunds
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Add a project</strong></summary>
         <form class="form" method="post" action="/finance/projects" style="margin-top:0.75rem">
           <label>Project name<input name="name" required></label>
           <label>Status<select name="status">${statusOptions(PROJECT_STATUSES, 'ACTIVE')}</select></label>
           <label>Linked fund<select name="fund_id">${fundOptions('', true)}</select></label>
           <label>Target amount (GH₵)<input type="number" step="0.01" min="0" name="target_amount" value="0"></label>
           <label>Start date<input type="date" name="start_date"></label>
           <label>End date<input type="date" name="end_date"></label>
           <label>Responsible officer<input name="responsible_officer"></label>
           <label class="wide">Description<input name="description"></label>
           <div class="actions"><button type="submit">Save project</button></div>
         </form>
       </details>` : '';
  const totals = enriched.reduce((acc, project) => {
    acc.target += Number(project.target_amount || 0);
    acc.raised += project.raised;
    acc.spent += project.spent;
    return acc;
  }, { target: 0, raised: 0, spent: 0 });
  const body = `
    ${statsRow([
      { cls: 'blue', icon: '#', value: enriched.length, label: 'Projects' },
      { cls: 'green', icon: '₵', value: fmtMoney(totals.raised), label: 'Raised' },
      { cls: 'orange', icon: '→', value: fmtMoney(totals.spent), label: 'Spent' },
      { cls: 'purple', icon: '◎', value: fmtMoney(totals.target), label: 'Targets' },
    ])}
    <div class="page-actions"><a class="btn ghost" href="/finance/projects.csv">Export CSV</a></div>
    ${addForm}
    <section class="card">
      <div class="card-head"><h2>Projects & Campaigns</h2><span class="meta">Fundraising targets and linked spending</span></div>
      ${enriched.length ? table(['Project', 'Status', 'Fund', 'Target', 'Raised', 'Spent', 'Progress', 'Officer', ''],
        enriched.map((p) => [
          `<a href="/finance/projects/${p.project_id}"><strong>${esc(p.name)}</strong></a><br><span class="muted-text">${esc(p.description || '')}</span>`,
          esc(p.status.replace(/_/g, ' ')),
          esc(p.fund_name || '—'),
          fmtMoney(p.target_amount || 0),
          fmtMoney(p.raised),
          fmtMoney(p.spent),
          `${p.pct}%`,
          esc(p.responsible_officer || '—'),
          res.locals.canFinanceManageFunds
            ? `<a class="btn-link" href="/finance/projects/${p.project_id}">Open</a> · <a class="btn-link" href="/finance/projects/${p.project_id}/edit">Edit</a>`
            : `<a class="btn-link" href="/finance/projects/${p.project_id}">Open</a>`,
        ])) : '<p class="muted-text">No projects yet.</p>'}
    </section>`;
  res.page({ title: 'Finance · Projects', active: '/finance', body });
});

app.get('/finance/projects.csv', requireFundViewer, (req, res) => {
  const rows = projectFinanceRows();
  sendFinanceCsv(res, 'finance-projects.csv', [
    ['Project', 'Status', 'Fund', 'Target', 'Raised', 'Spent', 'Balance', 'Progress %', 'Officer', 'Start', 'End'],
    ...rows.map((project) => [
      project.name,
      project.status,
      project.fund_name || '',
      project.target_amount || 0,
      project.raised,
      project.spent,
      project.balance,
      project.pct,
      project.responsible_officer || '',
      project.start_date || '',
      project.end_date || '',
    ]),
  ]);
});

app.post('/finance/projects', requireFundManager, (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim();
  const status = PROJECT_STATUSES.includes(b.status) ? b.status : 'ACTIVE';
  if (!name) { flash(req, 'Enter a project name.'); return res.redirect('/finance/projects'); }
  if (!isMoneyNonNeg(b.target_amount || 0)) { flash(req, 'Target amount must be 0 or more.'); return res.redirect('/finance/projects'); }
  db.prepare(`
    INSERT INTO finance_projects (name, description, fund_id, target_amount, responsible_officer, start_date, end_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    name,
    b.description || null,
    b.fund_id ? Number(b.fund_id) : null,
    Number(b.target_amount || 0),
    b.responsible_officer || null,
    b.start_date || null,
    b.end_date || null,
    status
  );
  logActivity('finance_project_created', `Created finance project ${name}`, '/finance/projects', res.locals.user.user_id);
  res.redirect('/finance/projects');
});

app.get('/finance/projects/:id', requireFundViewer, (req, res) => {
  const project = db.prepare(`
    SELECT p.*, f.name fund_name, f.code fund_code
    FROM finance_projects p
    LEFT JOIN funds f USING(fund_id)
    WHERE p.project_id=?`).get(Number(req.params.id));
  if (!project) return res.redirect('/finance/projects');
  const directExpenses = db.prepare(`
    SELECT e.expense_id, e.spent_on, e.amount, e.description, e.paid_to,
           e.payment_method, ec.category_name AS cat_name, e.category AS legacy_cat,
           pv.voucher_id, pv.voucher_no
    FROM expenses e
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    LEFT JOIN payment_vouchers pv ON pv.expense_id=e.expense_id
    WHERE e.project_id=?
    ORDER BY e.spent_on DESC, e.expense_id DESC`).all(project.project_id);
  const ledger = project.fund_id ? fundRaisedSpent(db, project.fund_id) : { raised: 0, spent: 0 };
  const directSpent = directExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const raised = Number(ledger.raised || 0);
  const spent = project.fund_id ? Number(ledger.spent || 0) : directSpent;
  const balance = raised - spent;
  const target = Number(project.target_amount || 0);
  const pct = target > 0 ? Math.min(100, Math.round((raised / target) * 100)) : 0;
  const body = `
    <p><a href="/finance/projects">← Back to projects</a></p>
    ${pageHero(esc(project.name), `${esc(project.status.replace(/_/g, ' '))} · ${project.fund_name ? 'Fund: ' + esc(project.fund_name) : 'No linked fund'}`)}
    <div class="page-actions">
      ${res.locals.canFinanceWrite ? '<a class="btn primary" href="/finance/expenses">＋ Add linked expense</a>' : ''}
      ${res.locals.canFinanceManageFunds ? `<a class="btn ghost" href="/finance/projects/${project.project_id}/edit">Edit project</a>` : ''}
    </div>
    ${statsRow([
      { cls: 'purple', icon: '◎', value: fmtMoney(target), label: 'Target' },
      { cls: 'green', icon: '₵', value: fmtMoney(raised), label: 'Raised' },
      { cls: 'orange', icon: '→', value: fmtMoney(spent), label: 'Spent' },
      { cls: balance >= 0 ? 'blue' : 'orange', icon: '=', value: fmtMoney(balance), label: 'Balance' },
    ])}
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Project Profile</h2><span class="meta">${pct}% of target raised</span></div>
      ${table(['Field', 'Value'], [
        ['Fund', project.fund_name ? `${esc(project.fund_code || '')} ${esc(project.fund_name)}` : '—'],
        ['Responsible officer', esc(project.responsible_officer || '—')],
        ['Start date', esc(project.start_date || '—')],
        ['End date', esc(project.end_date || '—')],
        ['Description', esc(project.description || '—')],
      ])}
    </section>
    <section class="card">
      <div class="card-head"><h2>Linked Expenses</h2><span class="meta">${directExpenses.length} records</span></div>
      ${directExpenses.length ? table(['Date', 'Category', 'Description', 'Paid to', 'Method', 'Amount', 'Voucher'],
        directExpenses.map((expense) => [
          esc(expense.spent_on),
          esc(expense.cat_name || expense.legacy_cat || '—'),
          esc(expense.description || '—'),
          esc(expense.paid_to || '—'),
          esc(expense.payment_method || '—'),
          fmtMoney(expense.amount),
          expense.voucher_id ? `<a class="btn-link" href="/finance/vouchers/${expense.voucher_id}/print">${esc(expense.voucher_no)}</a>` : '—',
        ])) : '<p class="muted-text">No expenses linked to this project yet.</p>'}
    </section>`;
  res.page({ title: `Finance · ${project.name}`, active: '/finance', body });
});

app.get('/finance/projects/:id/edit', requireFundManager, (req, res) => {
  const project = db.prepare(`SELECT * FROM finance_projects WHERE project_id=?`).get(Number(req.params.id));
  if (!project) return res.redirect('/finance/projects');
  const body = `
    <p><a href="/finance/projects">← Back to projects</a></p>
    <form class="form" method="post" action="/finance/projects/${project.project_id}/edit">
      <label>Project name<input name="name" required value="${esc(project.name)}"></label>
      <label>Status<select name="status">${statusOptions(PROJECT_STATUSES, project.status)}</select></label>
      <label>Linked fund<select name="fund_id">${fundOptions(project.fund_id, true)}</select></label>
      <label>Target amount (GH₵)<input type="number" step="0.01" min="0" name="target_amount" value="${esc(project.target_amount || 0)}"></label>
      <label>Start date<input type="date" name="start_date" value="${esc(project.start_date || '')}"></label>
      <label>End date<input type="date" name="end_date" value="${esc(project.end_date || '')}"></label>
      <label>Responsible officer<input name="responsible_officer" value="${esc(project.responsible_officer || '')}"></label>
      <label class="wide">Description<input name="description" value="${esc(project.description || '')}"></label>
      <div class="actions"><button type="submit">Save changes</button></div>
    </form>`;
  res.page({ title: 'Edit project', active: '/finance', body });
});

app.post('/finance/projects/:id/edit', requireFundManager, (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim();
  const status = PROJECT_STATUSES.includes(b.status) ? b.status : 'ACTIVE';
  if (!name) { flash(req, 'Enter a project name.'); return res.redirect('/finance/projects'); }
  db.prepare(`
    UPDATE finance_projects
       SET name=?, description=?, fund_id=?, target_amount=?, responsible_officer=?,
           start_date=?, end_date=?, status=?
     WHERE project_id=?`).run(
    name,
    b.description || null,
    b.fund_id ? Number(b.fund_id) : null,
    Number(b.target_amount || 0),
    b.responsible_officer || null,
    b.start_date || null,
    b.end_date || null,
    status,
    Number(req.params.id)
  );
  logActivity('finance_project_updated', `Updated finance project ${name}`, '/finance/projects', res.locals.user.user_id);
  res.redirect('/finance/projects');
});

// ---------- finance: budgets ----------
app.get('/finance/budgets', requireFinanceAccounting, (req, res) => {
  const budgets = budgetSummaryRows();
  const year = new Date().getFullYear();
  const addForm = res.locals.canFinanceManageFunds
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Create a budget</strong></summary>
         <form class="form" method="post" action="/finance/budgets" style="margin-top:0.75rem">
           <label>Name<input name="name" required value="Annual Budget ${year}"></label>
           <label>Year<input type="number" name="year" min="2000" max="2100" required value="${year}"></label>
           <label>Scope<select name="scope"><option value="ANNUAL">Annual</option><option value="MONTHLY">Monthly</option></select></label>
           <label>Month<input type="number" name="month" min="1" max="12" placeholder="Only for monthly"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Create budget</button></div>
         </form>
       </details>` : '';
  const body = `
    <div class="page-actions"><a class="btn ghost" href="/finance/budgets.csv">Export CSV</a></div>
    ${addForm}
    <section class="card">
      <div class="card-head"><h2>Budgets</h2><span class="meta">Budget versus actual from posted ledger entries</span></div>
      ${budgets.length ? table(['Budget', 'Period', 'Status', 'Lines', 'Budgeted', 'Actual', 'Variance', ''],
        budgets.map((budget) => [
          `<strong>${esc(budget.name)}</strong><br><span class="muted-text">${esc(budget.notes || '')}</span>`,
          budget.scope === 'MONTHLY' ? `${budget.year}-${String(budget.month || '').padStart(2, '0')}` : String(budget.year),
          esc(budget.status),
          budget.line_count,
          fmtMoney(budget.budgeted),
          fmtMoney(budget.actual),
          fmtMoney(budget.variance),
          `<a class="btn-link" href="/finance/budgets/${budget.budget_id}">Open</a>`,
        ])) : '<p class="muted-text">No budgets yet.</p>'}
    </section>`;
  res.page({ title: 'Finance · Budgets', active: '/finance', body });
});

app.get('/finance/budgets.csv', requireFinanceAccounting, (req, res) => {
  const budgets = budgetSummaryRows();
  sendFinanceCsv(res, 'finance-budgets.csv', [
    ['Budget', 'Year', 'Month', 'Scope', 'Status', 'Lines', 'Budgeted', 'Actual', 'Variance'],
    ...budgets.map((budget) => [
      budget.name,
      budget.year,
      budget.month || '',
      budget.scope,
      budget.status,
      budget.line_count,
      budget.budgeted,
      budget.actual,
      budget.variance,
    ]),
  ]);
});

app.post('/finance/budgets', requireFundManager, (req, res) => {
  const b = req.body;
  const year = Number(b.year);
  const scope = b.scope === 'MONTHLY' ? 'MONTHLY' : 'ANNUAL';
  const month = scope === 'MONTHLY' && b.month ? Number(b.month) : null;
  if (!String(b.name || '').trim() || year < 2000 || year > 2100 || (month !== null && (month < 1 || month > 12))) {
    flash(req, 'Enter a valid budget name and period.');
    return res.redirect('/finance/budgets');
  }
  const info = db.prepare(`
    INSERT INTO finance_budgets (name, year, month, scope, notes)
    VALUES (?, ?, ?, ?, ?)`).run(String(b.name).trim(), year, month, scope, b.notes || null);
  logActivity('finance_budget_created', `Created finance budget ${b.name}`, `/finance/budgets/${info.lastInsertRowid}`, res.locals.user.user_id);
  res.redirect(`/finance/budgets/${info.lastInsertRowid}`);
});

app.get('/finance/budgets/:id.csv', requireFinanceAccounting, (req, res) => {
  const budget = db.prepare(`SELECT * FROM finance_budgets WHERE budget_id=?`).get(Number(req.params.id));
  if (!budget) return res.redirect('/finance/budgets');
  const lines = db.prepare(`
    SELECT bl.*, a.code account_code, a.name account_name, f.name fund_name
    FROM finance_budget_lines bl
    LEFT JOIN accounts a USING(account_id)
    LEFT JOIN funds f USING(fund_id)
    WHERE bl.budget_id=?
    ORDER BY bl.line_type, bl.line_id`).all(budget.budget_id);
  sendFinanceCsv(res, `finance-budget-${budget.budget_id}.csv`, [
    ['Budget', 'Type', 'Category', 'Account', 'Fund', 'Budgeted', 'Actual', 'Variance', 'Used %'],
    ...lines.map((line) => {
      const actual = budgetActual(line, budget);
      const variance = Number(line.amount || 0) - actual;
      const pct = Number(line.amount || 0) > 0 ? Math.round((actual / Number(line.amount)) * 100) : 0;
      return [
        budget.name,
        line.line_type,
        line.category,
        line.account_code ? `${line.account_code} ${line.account_name}` : 'All accounts',
        line.fund_name || 'All funds',
        line.amount,
        actual,
        variance,
        pct,
      ];
    }),
  ]);
});

app.get('/finance/budgets/:id', requireFinanceAccounting, (req, res) => {
  const budget = db.prepare(`SELECT * FROM finance_budgets WHERE budget_id=?`).get(Number(req.params.id));
  if (!budget) return res.redirect('/finance/budgets');
  const lines = db.prepare(`
    SELECT bl.*, a.code account_code, a.name account_name, f.name fund_name
    FROM finance_budget_lines bl
    LEFT JOIN accounts a USING(account_id)
    LEFT JOIN funds f USING(fund_id)
    WHERE bl.budget_id=?
    ORDER BY bl.line_type, bl.line_id`).all(budget.budget_id);
  const rows = lines.map((line) => {
    const actual = budgetActual(line, budget);
    const variance = Number(line.amount || 0) - actual;
    const pct = Number(line.amount || 0) > 0 ? Math.round((actual / Number(line.amount)) * 100) : 0;
    const actions = res.locals.canFinanceManageFunds && budget.status !== 'CLOSED'
      ? `<a class="btn-link" href="/finance/budgets/${budget.budget_id}/lines/${line.line_id}/edit">Edit</a>
         <form method="post" action="/finance/budgets/${budget.budget_id}/lines/${line.line_id}/delete" style="display:inline" onsubmit="return confirm('Delete this budget line?')">
           <button type="submit" class="btn-link">Delete</button>
         </form>`
      : '';
    return [
      esc(line.line_type),
      esc(line.category),
      line.account_code ? `${esc(line.account_code)} · ${esc(line.account_name)}` : 'All accounts',
      esc(line.fund_name || 'All funds'),
      fmtMoney(line.amount),
      fmtMoney(actual),
      `<span class="${variance < 0 ? 'text-danger' : ''}">${fmtMoney(variance)}</span>`,
      `${pct}%`,
      actions,
    ];
  });
  const canManage = res.locals.canFinanceManageFunds && budget.status !== 'CLOSED';
  const addLine = canManage
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Add budget line</strong></summary>
         <form class="form" method="post" action="/finance/budgets/${budget.budget_id}/lines" style="margin-top:0.75rem">
           ${budgetLineFormFields()}
           <div class="actions"><button type="submit">Add line</button></div>
         </form>
       </details>` : '';
  const statusActions = res.locals.canFinanceManageFunds
    ? `<form method="post" action="/finance/budgets/${budget.budget_id}/status" class="actions" style="margin:0 0 1rem">
         <select name="status">${statusOptions(['DRAFT','APPROVED','CLOSED'], budget.status)}</select>
         <button type="submit">Update status</button>
       </form>` : '';
  const body = `
    <p><a href="/finance/budgets">← Back to budgets</a></p>
    ${pageHero(esc(budget.name), `${budget.scope === 'MONTHLY' ? 'Monthly' : 'Annual'} budget · ${budget.year}${budget.month ? '-' + String(budget.month).padStart(2, '0') : ''} · ${budget.status}`)}
    <div class="page-actions"><a class="btn ghost" href="/finance/budgets/${budget.budget_id}.csv">Export CSV</a></div>
    ${statusActions}
    ${addLine}
    <section class="card">
      <div class="card-head"><h2>Budget vs Actual</h2><span class="meta">Actuals come from posted journals</span></div>
      ${rows.length ? table(['Type', 'Category', 'Account', 'Fund', 'Budget', 'Actual', 'Variance', 'Used', ''], rows)
        : '<p class="muted-text">No budget lines yet.</p>'}
    </section>`;
  res.page({ title: `Finance · ${budget.name}`, active: '/finance', body });
});

app.post('/finance/budgets/:id/lines', requireFundManager, (req, res) => {
  const b = req.body;
  const budget = db.prepare(`SELECT * FROM finance_budgets WHERE budget_id=?`).get(Number(req.params.id));
  if (!budget || budget.status === 'CLOSED') return res.redirect('/finance/budgets');
  const lineType = b.line_type === 'EXPENSE' ? 'EXPENSE' : 'INCOME';
  const accountId = lineType === 'EXPENSE' ? Number(b.expense_account_id || 0) : Number(b.income_account_id || 0);
  if (!String(b.category || '').trim() || !isMoneyNonNeg(b.amount || 0)) {
    flash(req, 'Enter a budget category and amount.');
    return res.redirect(`/finance/budgets/${budget.budget_id}`);
  }
  db.prepare(`
    INSERT INTO finance_budget_lines (budget_id, line_type, category, account_id, fund_id, amount, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    budget.budget_id,
    lineType,
    String(b.category).trim(),
    accountId || null,
    b.fund_id ? Number(b.fund_id) : null,
    Number(b.amount || 0),
    b.notes || null
  );
  res.redirect(`/finance/budgets/${budget.budget_id}`);
});

app.get('/finance/budgets/:id/lines/:lineId/edit', requireFundManager, (req, res) => {
  const budget = db.prepare(`SELECT * FROM finance_budgets WHERE budget_id=?`).get(Number(req.params.id));
  if (!budget || budget.status === 'CLOSED') return res.redirect(`/finance/budgets/${Number(req.params.id)}`);
  const line = db.prepare(`
    SELECT * FROM finance_budget_lines
    WHERE budget_id=? AND line_id=?`).get(budget.budget_id, Number(req.params.lineId));
  if (!line) return res.redirect(`/finance/budgets/${budget.budget_id}`);
  const body = `
    <p><a href="/finance/budgets/${budget.budget_id}">← Back to budget</a></p>
    <form class="form" method="post" action="/finance/budgets/${budget.budget_id}/lines/${line.line_id}/edit">
      ${budgetLineFormFields(line)}
      <div class="actions"><button type="submit">Save line</button></div>
    </form>`;
  res.page({ title: 'Edit budget line', active: '/finance', body });
});

app.post('/finance/budgets/:id/lines/:lineId/edit', requireFundManager, (req, res) => {
  const b = req.body;
  const budget = db.prepare(`SELECT * FROM finance_budgets WHERE budget_id=?`).get(Number(req.params.id));
  if (!budget || budget.status === 'CLOSED') return res.redirect('/finance/budgets');
  const lineType = b.line_type === 'EXPENSE' ? 'EXPENSE' : 'INCOME';
  const accountId = lineType === 'EXPENSE' ? Number(b.expense_account_id || 0) : Number(b.income_account_id || 0);
  if (!String(b.category || '').trim() || !isMoneyNonNeg(b.amount || 0)) {
    flash(req, 'Enter a budget category and amount.');
    return res.redirect(`/finance/budgets/${budget.budget_id}/lines/${Number(req.params.lineId)}/edit`);
  }
  db.prepare(`
    UPDATE finance_budget_lines
       SET line_type=?, category=?, account_id=?, fund_id=?, amount=?, notes=?
     WHERE budget_id=? AND line_id=?`).run(
    lineType,
    String(b.category).trim(),
    accountId || null,
    b.fund_id ? Number(b.fund_id) : null,
    Number(b.amount || 0),
    b.notes || null,
    budget.budget_id,
    Number(req.params.lineId)
  );
  res.redirect(`/finance/budgets/${budget.budget_id}`);
});

app.post('/finance/budgets/:id/lines/:lineId/delete', requireFundManager, (req, res) => {
  const budget = db.prepare(`SELECT * FROM finance_budgets WHERE budget_id=?`).get(Number(req.params.id));
  if (!budget || budget.status === 'CLOSED') return res.redirect('/finance/budgets');
  db.prepare(`DELETE FROM finance_budget_lines WHERE budget_id=? AND line_id=?`).run(
    budget.budget_id,
    Number(req.params.lineId)
  );
  res.redirect(`/finance/budgets/${budget.budget_id}`);
});

app.post('/finance/budgets/:id/status', requireFundManager, (req, res) => {
  const status = ['DRAFT', 'APPROVED', 'CLOSED'].includes(req.body.status) ? req.body.status : 'DRAFT';
  db.prepare(`UPDATE finance_budgets SET status=? WHERE budget_id=?`).run(status, Number(req.params.id));
  res.redirect(`/finance/budgets/${Number(req.params.id)}`);
});

// ---------- finance: accounting ----------
app.get('/finance/accounting', requireFinanceAccounting, (req, res) => {
  const funds = db.prepare(`
    SELECT fund_id, COALESCE(code, '') code, name, fund_type, restricted, opening_balance
    FROM funds
    WHERE active=1
    ORDER BY name`).all();
  const fundRows = funds.map((fund) => {
    const balance = fundBalance(db, fund.fund_id);
    return [
      esc(fund.code) || '—',
      esc(fund.name),
      esc(fund.fund_type || 'GENERAL'),
      fund.restricted ? '<span class="pill pill-pending">Restricted</span>' : '<span class="pill pill-fulfilled">Unrestricted</span>',
      fmtMoney(fund.opening_balance || 0),
      `<strong>${fmtMoney(balance)}</strong>`,
    ];
  });

  const trialRows = db.prepare(`
    SELECT a.code, a.name, a.account_type,
           ROUND(COALESCE(SUM(jl.debit), 0), 2) debit,
           ROUND(COALESCE(SUM(jl.credit), 0), 2) credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.account_id
    LEFT JOIN journal_entries je ON je.entry_id = jl.entry_id
      AND je.status IN ('POSTED','REVERSED')
    WHERE a.active=1
    GROUP BY a.account_id
    HAVING debit > 0 OR credit > 0
    ORDER BY a.code`).all();
  const debitTotal = trialRows.reduce((sum, row) => sum + Number(row.debit || 0), 0);
  const creditTotal = trialRows.reduce((sum, row) => sum + Number(row.credit || 0), 0);
  const balanced = Math.round((debitTotal - creditTotal) * 100) === 0;
  const trialTableRows = trialRows.map((row) => [
    esc(row.code),
    esc(row.name),
    esc(row.account_type),
    fmtDebitCredit(row.debit),
    fmtDebitCredit(row.credit),
  ]).concat([[
    '',
    '<strong>Total</strong>',
    balanced ? '<span class="pill pill-fulfilled">Balanced</span>' : '<span class="pill pill-cancelled">Out of balance</span>',
    `<strong>${fmtMoney(debitTotal)}</strong>`,
    `<strong>${fmtMoney(creditTotal)}</strong>`,
  ]]);

  const ledgerRows = db.prepare(`
    SELECT je.entry_no, je.entry_date, je.source_type, je.source_id, je.status,
           a.code account_code, a.name account_name, f.name fund_name,
           jl.debit, jl.credit, COALESCE(jl.memo, je.memo, '') memo
    FROM journal_lines jl
    JOIN journal_entries je USING(entry_id)
    JOIN accounts a USING(account_id)
    LEFT JOIN funds f USING(fund_id)
    ORDER BY je.entry_date DESC, je.entry_id DESC, jl.line_id
    LIMIT 80`).all();

  const journalCount = db.prepare(`SELECT COUNT(*) c FROM journal_entries`).get().c;
  const lineCount = db.prepare(`SELECT COUNT(*) c FROM journal_lines`).get().c;
  const body = `
    <div class="page-actions">
      <a class="btn ghost" href="/finance/accounting/trial-balance.csv">Export trial balance</a>
      <a class="btn ghost" href="/finance/accounting/ledger.csv">Export ledger</a>
    </div>
    ${statsRow([
      { cls: balanced ? 'green' : 'orange', icon: '≡', value: balanced ? 'Balanced' : 'Review', label: 'Trial Balance' },
      { cls: 'blue', icon: 'JV', value: journalCount, label: 'Journal Entries' },
      { cls: 'purple', icon: '↔', value: lineCount, label: 'Journal Lines' },
    ])}
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Fund Balances</h2><span class="meta">Ledger-derived</span></div>
      ${fundRows.length ? table(['Code', 'Fund', 'Type', 'Restriction', 'Opening', 'Balance'], fundRows)
        : '<p class="muted-text">No active funds configured.</p>'}
    </section>
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Trial Balance</h2><span class="meta">Posted and reversed journals included</span></div>
      ${trialRows.length ? table(['Code', 'Account', 'Type', 'Debit', 'Credit'], trialTableRows)
        : '<p class="muted-text">No journal activity yet.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><h2>General Ledger</h2><span class="meta">Recent journal lines</span></div>
      ${ledgerRows.length ? table(['Entry', 'Date', 'Source', 'Status', 'Account', 'Fund', 'Debit', 'Credit', 'Memo'],
        ledgerRows.map((row) => [
          esc(row.entry_no),
          esc(row.entry_date),
          `${esc(row.source_type)}${row.source_id ? ' #' + esc(row.source_id) : ''}`,
          esc(row.status),
          `${esc(row.account_code)} · ${esc(row.account_name)}`,
          esc(row.fund_name) || '—',
          fmtDebitCredit(row.debit),
          fmtDebitCredit(row.credit),
          esc(row.memo),
        ])) : '<p class="muted-text">No journal lines posted yet.</p>'}
    </section>`;
  res.page({ title: 'Finance · Accounting', active: '/finance', body });
});

app.get('/finance/accounting/trial-balance.csv', requireFinanceAccounting, (req, res) => {
  const rows = db.prepare(`
    SELECT a.code, a.name, a.account_type,
           ROUND(COALESCE(SUM(jl.debit), 0), 2) debit,
           ROUND(COALESCE(SUM(jl.credit), 0), 2) credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.account_id
    LEFT JOIN journal_entries je ON je.entry_id = jl.entry_id
      AND je.status IN ('POSTED','REVERSED')
    WHERE a.active=1
    GROUP BY a.account_id
    HAVING debit > 0 OR credit > 0
    ORDER BY a.code`).all();
  sendFinanceCsv(res, 'finance-trial-balance.csv', [
    ['Code', 'Account', 'Type', 'Debit', 'Credit'],
    ...rows.map((row) => [row.code, row.name, row.account_type, row.debit, row.credit]),
  ]);
});

app.get('/finance/accounting/ledger.csv', requireFinanceAccounting, (req, res) => {
  const rows = db.prepare(`
    SELECT je.entry_no, je.entry_date, je.source_type, je.source_id, je.status,
           a.code account_code, a.name account_name, f.name fund_name,
           jl.debit, jl.credit, COALESCE(jl.memo, je.memo, '') memo
    FROM journal_lines jl
    JOIN journal_entries je USING(entry_id)
    JOIN accounts a USING(account_id)
    LEFT JOIN funds f USING(fund_id)
    ORDER BY je.entry_date DESC, je.entry_id DESC, jl.line_id`).all();
  sendFinanceCsv(res, 'finance-ledger.csv', [
    ['Entry', 'Date', 'Source Type', 'Source ID', 'Status', 'Account Code', 'Account', 'Fund', 'Debit', 'Credit', 'Memo'],
    ...rows.map((row) => [
      row.entry_no,
      row.entry_date,
      row.source_type,
      row.source_id || '',
      row.status,
      row.account_code,
      row.account_name,
      row.fund_name || '',
      row.debit,
      row.credit,
      row.memo || '',
    ]),
  ]);
});

// ---------- finance: payment vouchers ----------
app.get('/finance/vouchers', (req, res) => {
  if (!res.locals.canFinanceWrite && !res.locals.canFinanceAccounting) return res.status(403).send('Forbidden');
  const rows = db.prepare(`
    SELECT pv.voucher_id, pv.voucher_no, pv.voucher_date, pv.amount_in_words,
           e.amount, e.description, e.paid_to, e.payment_method,
           ec.category_name AS cat_name, e.category AS legacy_cat,
           prep.display_name AS prepared_name, prep.username AS prepared_user
    FROM payment_vouchers pv
    JOIN expenses e USING(expense_id)
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    LEFT JOIN users prep ON prep.user_id = pv.prepared_by
    ORDER BY pv.voucher_date DESC, pv.voucher_id DESC
    LIMIT 150`).all();
  const body = `
    <div class="page-actions"><a class="btn ghost" href="/finance/vouchers.csv">Export CSV</a></div>
    <section class="card">
      <div class="card-head"><h2>Payment Vouchers</h2><span class="meta">Expense disbursement register</span></div>
      ${rows.length ? table(['Voucher', 'Date', 'Payee', 'Category', 'Description', 'Method', 'Amount', 'Prepared by', ''],
        rows.map((v) => [
          esc(v.voucher_no),
          esc(v.voucher_date),
          esc(v.paid_to || '—'),
          esc(v.cat_name || v.legacy_cat || '—'),
          esc(v.description || '—'),
          esc(v.payment_method || '—'),
          fmtMoney(v.amount),
          esc(v.prepared_name || v.prepared_user || '—'),
          `<a class="btn-link" href="/finance/vouchers/${v.voucher_id}/print">Print</a>`,
        ])) : '<p class="muted-text">No payment vouchers have been generated yet.</p>'}
    </section>`;
  res.page({ title: 'Finance · Vouchers', active: '/finance', body });
});

app.get('/finance/vouchers.csv', (req, res) => {
  if (!res.locals.canFinanceWrite && !res.locals.canFinanceAccounting) return res.status(403).send('Forbidden');
  const rows = db.prepare(`
    SELECT pv.voucher_no, pv.voucher_date, pv.amount_in_words,
           e.amount, e.description, e.paid_to, e.payment_method,
           ec.category_name AS cat_name, e.category AS legacy_cat,
           prep.display_name AS prepared_name, prep.username AS prepared_user
    FROM payment_vouchers pv
    JOIN expenses e USING(expense_id)
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    LEFT JOIN users prep ON prep.user_id = pv.prepared_by
    ORDER BY pv.voucher_date DESC, pv.voucher_id DESC`).all();
  sendFinanceCsv(res, 'finance-vouchers.csv', [
    ['Voucher', 'Date', 'Payee', 'Category', 'Description', 'Method', 'Amount', 'Amount In Words', 'Prepared By'],
    ...rows.map((v) => [
      v.voucher_no,
      v.voucher_date,
      v.paid_to || '',
      v.cat_name || v.legacy_cat || '',
      v.description || '',
      v.payment_method || '',
      v.amount,
      v.amount_in_words,
      v.prepared_name || v.prepared_user || '',
    ]),
  ]);
});

app.get('/finance/vouchers/:id/print', (req, res) => {
  if (!res.locals.canFinanceWrite && !res.locals.canFinanceAccounting) return res.status(403).send('Forbidden');
  const v = db.prepare(`
    SELECT pv.*, e.amount, e.description, e.paid_to, e.payment_method, e.reference_number,
           ec.category_name AS cat_name, e.category AS legacy_cat,
           prep.display_name AS prepared_name, prep.username AS prepared_user,
           appr.display_name AS approved_name, appr.username AS approved_user,
           paid.display_name AS paid_name, paid.username AS paid_user
    FROM payment_vouchers pv
    JOIN expenses e USING(expense_id)
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    LEFT JOIN users prep ON prep.user_id = pv.prepared_by
    LEFT JOIN users appr ON appr.user_id = pv.approved_by
    LEFT JOIN users paid ON paid.user_id = pv.paid_by
    WHERE pv.voucher_id=?`).get(Number(req.params.id));
  if (!v) return res.status(404).send('Voucher not found');
  const preparedBy = v.prepared_name || v.prepared_user || '—';
  const approvedBy = v.approved_name || v.approved_user || '—';
  const paidBy = v.paid_name || v.paid_user || '—';
  const reference = v.supporting_doc_ref || v.reference_number || '—';
  const body = `
    <div class="screen-only receipt-actions">
      <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
      <a class="btn-link" href="/finance/vouchers">← Back to vouchers</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${esc(CHURCH_NAME)}</div>
          <div class="muted-text">Payment Voucher</div></div>
        <div class="rc-no"><strong>${esc(v.voucher_no)}</strong><br>
          <span class="muted-text">${esc(v.voucher_date)}</span></div>
      </div>
      <div class="rc-line"><span>Paid to</span><strong>${esc(v.paid_to || v.received_by || '—')}</strong></div>
      <div class="rc-line"><span>Expense category</span><span>${esc(v.cat_name || v.legacy_cat || '—')}</span></div>
      <div class="rc-line"><span>Description</span><span>${esc(v.description || '—')}</span></div>
      <div class="rc-line"><span>Payment method</span><span>${esc(v.payment_method || '—')}</span></div>
      <div class="rc-line"><span>Supporting document</span><span>${esc(reference)}</span></div>
      <div class="rc-line"><span>Amount</span><strong>${fmtMoney(v.amount)}</strong></div>
      <div class="rc-line rc-total"><span>Amount in words</span><span>${esc(v.amount_in_words)}</span></div>
      ${v.notes ? `<p class="muted-text" style="margin-top:1rem">${esc(v.notes)}</p>` : ''}
      <div class="signature-grid" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin-top:2rem">
        ${[
          ['Prepared by', preparedBy],
          ['Checked by', v.checked_by || ''],
          ['Approved by', approvedBy],
          ['Paid by', paidBy],
        ].map(([label, name]) => `<div><div style="border-top:1px solid #111;padding-top:0.35rem;min-height:2rem">${esc(name || ' ')}</div><div class="muted-text">${esc(label)}</div></div>`).join('')}
      </div>
      <div class="rc-line" style="margin-top:1.5rem"><span>Received by</span><span>${esc(v.received_by || '—')}</span></div>
    </div>`;
  res.page({ title: `Payment Voucher ${v.voucher_no}`, active: '/finance', noHeader: true, body });
});

// ---------- finance: expenses ----------
function approvalPill(status) {
  const s = String(status || 'PAID').toUpperCase();
  const cls = s === 'PAID' || s === 'APPROVED' ? 'sent' : s === 'REJECTED' ? 'failed' : s === 'SUBMITTED' ? 'pending' : 'dry_run';
  return `<span class="pill pill-${cls}">${esc(s)}</span>`;
}

app.get('/finance/expenses', (req, res) => {
  const cats = loadExpenseCategories();
  const currentUser = res.locals.user;
  const rows = db.prepare(`
    SELECT e.expense_id, e.spent_on, e.amount, e.description, e.paid_to,
           e.payment_method, e.reference_number, e.receipt_attached,
           e.approval_status, e.submitted_at, e.approved_at, e.paid_at, e.rejected_at,
           ec.category_name AS cat_name, e.category AS legacy_cat,
           u.display_name, u.username, f.name AS fund_name, p.name AS project_name,
           pv.voucher_id, pv.voucher_no
    FROM expenses e
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    LEFT JOIN users u ON u.user_id = e.approved_by
    LEFT JOIN funds f ON f.fund_id = e.fund_id
    LEFT JOIN finance_projects p ON p.project_id = e.project_id
    LEFT JOIN payment_vouchers pv ON pv.expense_id = e.expense_id
    ORDER BY e.spent_on DESC, e.expense_id DESC LIMIT 100`).all();
  const catOpts = cats.map((c) => `<option value="${c.expense_cat_id}">${esc(c.category_name)}</option>`).join('');
  const approverName = esc(currentUser.display_name || currentUser.username);
  const userOpts = `<option value="${currentUser.user_id}">${approverName}</option>`;
  const addForm = res.locals.canFinanceWrite
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record an expense</strong></summary>
         <form class="form" method="post" action="/finance/expenses" style="margin-top:0.75rem">
           <label>Date<input type="date" name="spent_on" required value="${todayISO()}"></label>
           <label>Category<select name="expense_cat_id" required>${catOpts}</select></label>
           <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
           <label>Payment method<select name="payment_method">
             ${['Cash','Bank Transfer','Cheque','Mobile Money','Other'].map((m) => `<option>${m}</option>`).join('')}
           </select></label>
           <label>Fund<select name="fund_id">${fundOptions(defaultFundId(), false)}</select></label>
           <label>Project<select name="project_id">${projectOptions('')}</select></label>
           <label class="wide">Description<input name="description" required></label>
           <label>Paid to<input name="paid_to"></label>
           <label>Reference #<input name="reference_number"></label>
           <label>Approved by<select name="approved_by">${userOpts}</select></label>
           <label>Status<select name="approval_status">
             ${['DRAFT','SUBMITTED','APPROVED','PAID'].map((s) => `<option value="${s}" ${s === 'PAID' ? 'selected' : ''}>${s}</option>`).join('')}
           </select></label>
           <label><span>&nbsp;</span><label class="check" style="background:none;padding:0">
             <input type="checkbox" name="receipt_attached" value="1"> Receipt attached</label></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save</button></div>
         </form>
       </details>` : '';
  const body = `
    ${addForm}
    ${rows.length ? table(['Date', 'Category', 'Description', 'Fund', 'Project', 'Paid to', 'Method', 'Amount', 'Status', 'Receipt', 'Voucher', 'Actions'],
      rows.map((e) => [esc(e.spent_on), esc(e.cat_name || e.legacy_cat),
        esc(e.description), esc(e.fund_name || '—'), esc(e.project_name || '—'),
        esc(e.paid_to), esc(e.payment_method),
        fmtMoney(e.amount),
        approvalPill(e.approval_status),
        e.receipt_attached ? '✓' : '—',
        e.voucher_id ? `<a class="btn-link" href="/finance/vouchers/${e.voucher_id}/print">${esc(e.voucher_no)}</a>` : '—',
        res.locals.canFinanceWrite ? `<div class="row-actions">
          <a class="btn-link" href="/finance/expenses/${e.expense_id}/edit">Edit</a>
          ${['SUBMITTED','APPROVED','PAID','REJECTED'].map((s) => `<form method="post" action="/finance/expenses/${e.expense_id}/status" style="display:inline"><input type="hidden" name="status" value="${s}"><button class="btn-link" type="submit">${s === 'PAID' ? 'Mark paid' : s.charAt(0) + s.slice(1).toLowerCase()}</button></form>`).join('')}
        </div>` : '']))
      : '<p class="muted-text">No expenses recorded yet.</p>'}`;
  res.page({ title: 'Finance · Expenses', active: '/finance', body });
});

app.post('/finance/expenses', requireFinanceWrite, (req, res) => {
  const b = req.body;
  if (!Number(b.expense_cat_id)) { flash(req, 'Choose an expense category.'); return res.redirect('/finance/expenses'); }
  if (!isValidDate(b.spent_on)) { flash(req, 'Enter a valid date.'); return res.redirect('/finance/expenses'); }
  if (!isMoneyNonNeg(b.amount)) { flash(req, 'Amount must be a number of 0 or more.'); return res.redirect('/finance/expenses'); }
  const cat = db.prepare(`SELECT category_name FROM expense_categories WHERE expense_cat_id=?`).get(Number(b.expense_cat_id));
  const status = ['DRAFT','SUBMITTED','APPROVED','PAID','REJECTED'].includes(String(b.approval_status || '').toUpperCase())
    ? String(b.approval_status).toUpperCase()
    : 'PAID';
  db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO expenses (expense_cat_id, category, amount, spent_on, description, paid_to,
                            payment_method, reference_number, approved_by, receipt_attached, fund_id, project_id, notes,
                            approval_status, submitted_at, approved_at, paid_at, rejected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Number(b.expense_cat_id), cat ? cat.category_name : 'other',
      Number(b.amount), b.spent_on, b.description, b.paid_to || null,
      b.payment_method || null, b.reference_number || null,
      b.approved_by ? Number(b.approved_by) : null,
      b.receipt_attached ? 1 : 0,
      b.fund_id ? Number(b.fund_id) : defaultFundId(),
      b.project_id ? Number(b.project_id) : null,
      b.notes || null,
      status,
      ['SUBMITTED','APPROVED','PAID'].includes(status) ? new Date().toISOString() : null,
      ['APPROVED','PAID'].includes(status) ? new Date().toISOString() : null,
      status === 'PAID' ? new Date().toISOString() : null,
      status === 'REJECTED' ? new Date().toISOString() : null
    );
    const entryId = postExpensePayment(db, {
      date: b.spent_on,
      amount: Number(b.amount),
      expenseAccount: expenseAccountFor(cat ? cat.category_name : 'other'),
      category: cat ? cat.category_name : 'other',
      fundId: b.fund_id ? Number(b.fund_id) : defaultFundId(),
      sourceId: info.lastInsertRowid,
      createdBy: res.locals.user.user_id,
      memo: b.description || (cat ? cat.category_name : 'Expense'),
    });
    updateJournalLink('expenses', 'expense_id', info.lastInsertRowid, entryId);
    syncExpenseVoucher(info.lastInsertRowid, res.locals.user.user_id);
  })();
  logActivity('expense_recorded',
    `Expense ${fmtMoney(b.amount)} (${cat ? cat.category_name : ''}) recorded`,
    '/finance/expenses', res.locals.user.user_id);
  res.redirect('/finance/expenses');
});

app.post('/finance/expenses/:id/status', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '').toUpperCase();
  if (!['DRAFT','SUBMITTED','APPROVED','PAID','REJECTED'].includes(status)) {
    flash(req, 'Choose a valid expense status.');
    return res.redirect('/finance/expenses');
  }
  const existing = db.prepare(`SELECT expense_id FROM expenses WHERE expense_id=?`).get(id);
  if (!existing) return res.redirect('/finance/expenses');
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE expenses SET
      approval_status=@status,
      submitted_at=CASE WHEN @status IN ('SUBMITTED','APPROVED','PAID') AND submitted_at IS NULL THEN @now ELSE submitted_at END,
      approved_at=CASE WHEN @status IN ('APPROVED','PAID') THEN @now ELSE approved_at END,
      paid_at=CASE WHEN @status='PAID' THEN @now ELSE paid_at END,
      rejected_at=CASE WHEN @status='REJECTED' THEN @now ELSE NULL END,
      approval_note=@note
    WHERE expense_id=@id`).run({
      id,
      status,
      now,
      note: req.body.note || null,
    });
  logActivity('expense_approval',
    `Expense #${id} marked ${status}`,
    `/finance/expenses/${id}/edit`,
    res.locals.user.user_id);
  flash(req, `Expense #${id} marked ${status}.`, 'success');
  res.redirect('/finance/expenses');
});

app.get('/finance/expenses/:id/edit', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare(`SELECT * FROM expenses WHERE expense_id=?`).get(id);
  if (!e) return res.redirect('/finance/expenses');
  const cats = loadExpenseCategories();
  const currentUser = res.locals.user;
  const catOpts = cats.map((c) =>
    `<option value="${c.expense_cat_id}" ${c.expense_cat_id === e.expense_cat_id ? 'selected' : ''}>${esc(c.category_name)}</option>`).join('');
  const methods = ['Cash', 'Bank Transfer', 'Cheque', 'Mobile Money', 'Other'];
  const methodOpts = methods.map((m) =>
    `<option ${m === e.payment_method ? 'selected' : ''}>${m}</option>`).join('');
  const statusOpts = ['DRAFT','SUBMITTED','APPROVED','PAID','REJECTED'].map((s) =>
    `<option value="${s}" ${s === (e.approval_status || 'PAID') ? 'selected' : ''}>${s}</option>`).join('');
  const auditRows = db.prepare(`
    SELECT occurred_at, kind, description
    FROM activity_log
    WHERE link=? OR description LIKE ?
    ORDER BY activity_id DESC LIMIT 10`).all(`/finance/expenses/${id}/edit`, `%Expense #${id}%`);
  const approverName = esc(currentUser.display_name || currentUser.username);
  const body = `
    <p><a href="/finance/expenses">← Back to expenses</a></p>
    <form class="form" method="post" action="/finance/expenses/${id}/edit">
      <label>Date<input type="date" name="spent_on" required value="${fmtDate(e.spent_on)}"></label>
      <label>Category<select name="expense_cat_id" required>${catOpts}</select></label>
      <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required value="${e.amount}"></label>
      <label>Payment method<select name="payment_method">${methodOpts}</select></label>
      <label>Fund<select name="fund_id">${fundOptions(e.fund_id || defaultFundId(), false)}</select></label>
      <label>Project<select name="project_id">${projectOptions(e.project_id)}</select></label>
      <label class="wide">Description<input name="description" required value="${esc(e.description || '')}"></label>
      <label>Paid to<input name="paid_to" value="${esc(e.paid_to || '')}"></label>
      <label>Reference #<input name="reference_number" value="${esc(e.reference_number || '')}"></label>
      <label>Approved by<select name="approved_by"><option value="${currentUser.user_id}">${approverName}</option></select></label>
      <label>Status<select name="approval_status">${statusOpts}</select></label>
      <label><span>&nbsp;</span><label class="check" style="background:none;padding:0">
        <input type="checkbox" name="receipt_attached" value="1" ${e.receipt_attached ? 'checked' : ''}> Receipt attached</label></label>
      <label class="wide">Notes<input name="notes" value="${esc(e.notes || '')}"></label>
      <div class="actions"><button type="submit">Save changes</button></div>
    </form>
    <section class="card" style="margin-top:1rem">
      <div class="card-head"><h2>Approval History</h2><span class="meta">${approvalPill(e.approval_status)}</span></div>
      ${auditRows.length ? table(['When', 'Type', 'Description'], auditRows.map((r) => [
        esc(r.occurred_at), esc(r.kind), esc(r.description),
      ])) : '<p class="muted-text">No approval or edit history recorded for this expense yet.</p>'}
    </section>`;
  res.page({ title: 'Edit expense', active: '/finance', body });
});

app.post('/finance/expenses/:id/edit', requireFinanceWrite, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const cat = db.prepare(`SELECT category_name FROM expense_categories WHERE expense_cat_id=?`).get(Number(b.expense_cat_id));
  const current = db.prepare(`SELECT * FROM expenses WHERE expense_id=?`).get(id);
  if (!current) return res.redirect('/finance/expenses');
  db.transaction(() => {
    reverseLinkedJournal('expenses', 'expense_id', id, 'Expense edited', res.locals.user.user_id);
    db.prepare(`UPDATE expenses SET expense_cat_id=?, category=?, amount=?, spent_on=?, description=?,
                                     paid_to=?, payment_method=?, reference_number=?,
      approved_by=?, receipt_attached=?, fund_id=?, project_id=?, notes=?,
      approval_status=?,
      submitted_at=CASE WHEN ? IN ('SUBMITTED','APPROVED','PAID') AND submitted_at IS NULL THEN CURRENT_TIMESTAMP ELSE submitted_at END,
      approved_at=CASE WHEN ? IN ('APPROVED','PAID') THEN CURRENT_TIMESTAMP ELSE approved_at END,
      paid_at=CASE WHEN ?='PAID' THEN CURRENT_TIMESTAMP ELSE paid_at END,
      rejected_at=CASE WHEN ?='REJECTED' THEN CURRENT_TIMESTAMP ELSE NULL END
                WHERE expense_id=?`).run(
      Number(b.expense_cat_id), cat ? cat.category_name : 'other',
      Number(b.amount), b.spent_on, b.description, b.paid_to || null,
      b.payment_method || null, b.reference_number || null,
      b.approved_by ? Number(b.approved_by) : null,
      b.receipt_attached ? 1 : 0,
      b.fund_id ? Number(b.fund_id) : defaultFundId(),
      b.project_id ? Number(b.project_id) : null,
      b.notes || null,
      ['DRAFT','SUBMITTED','APPROVED','PAID','REJECTED'].includes(String(b.approval_status || '').toUpperCase())
        ? String(b.approval_status).toUpperCase()
        : (current.approval_status || 'PAID'),
      String(b.approval_status || '').toUpperCase(),
      String(b.approval_status || '').toUpperCase(),
      String(b.approval_status || '').toUpperCase(),
      String(b.approval_status || '').toUpperCase(),
      id
    );
    const entryId = postExpensePayment(db, {
      date: b.spent_on,
      amount: Number(b.amount),
      expenseAccount: expenseAccountFor(cat ? cat.category_name : 'other'),
      category: cat ? cat.category_name : 'other',
      fundId: b.fund_id ? Number(b.fund_id) : (current.fund_id || defaultFundId()),
      sourceId: id,
      createdBy: res.locals.user.user_id,
      memo: b.description || (cat ? cat.category_name : 'Expense'),
    });
    updateJournalLink('expenses', 'expense_id', id, entryId);
    syncExpenseVoucher(id, res.locals.user.user_id);
  })();
  logActivity('expense_edited',
    `Expense #${id} edited and journal reposted`, '/finance/expenses', res.locals.user.user_id);
  res.redirect('/finance/expenses');
});

// ---------- finance: audit trail ----------
const FINANCE_ACTIVITY_KINDS = [
  'income_recorded', 'contribution_recorded', 'pledge_payment', 'pledge_edited',
  'finance_reversal', 'receipt_sent', 'statement_sent', 'finance_settings_updated',
  'fund_created', 'fund_updated', 'fund_restriction_updated',
  'finance_project_created', 'finance_project_updated',
  'budget_created', 'budget_updated', 'budget_line_added', 'budget_line_edited',
  'budget_line_deleted', 'budget_status_changed',
  'expense_submitted', 'expense_approved', 'expense_rejected', 'expense_paid',
  'expense_created', 'expense_edited', 'voucher_generated',
];

app.get('/finance/audit', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 50;
  const offset = (page - 1) * perPage;
  const kindFilter = req.query.kind || '';
  const placeholders = FINANCE_ACTIVITY_KINDS.map(() => '?').join(',');
  const whereKind = kindFilter && FINANCE_ACTIVITY_KINDS.includes(kindFilter)
    ? `AND a.kind = ?`
    : `AND a.kind IN (${placeholders})`;
  const params = kindFilter && FINANCE_ACTIVITY_KINDS.includes(kindFilter)
    ? [kindFilter, perPage, offset]
    : [...FINANCE_ACTIVITY_KINDS, perPage, offset];
  const countParams = kindFilter && FINANCE_ACTIVITY_KINDS.includes(kindFilter)
    ? [kindFilter]
    : [...FINANCE_ACTIVITY_KINDS];

  const total = db.prepare(
    `SELECT COUNT(*) c FROM activity_log a WHERE 1=1 ${whereKind}`
  ).get(...countParams).c;
  const rows = db.prepare(`
    SELECT a.activity_id, a.occurred_at, a.kind, a.description, a.link,
           COALESCE(u.display_name, u.username) AS actor
    FROM activity_log a
    LEFT JOIN users u ON u.user_id = a.user_id
    WHERE 1=1 ${whereKind}
    ORDER BY a.activity_id DESC
    LIMIT ? OFFSET ?`).all(...params);

  const totalPages = Math.ceil(total / perPage);
  const kindOptions = FINANCE_ACTIVITY_KINDS.map((k) =>
    `<option value="${esc(k)}" ${k === kindFilter ? 'selected' : ''}>${esc(k.replace(/_/g, ' '))}</option>`).join('');
  const filterForm = `
    <form method="get" action="/finance/audit" class="filter-bar">
      <select name="kind" onchange="this.form.submit()">
        <option value="">All finance events</option>
        ${kindOptions}
      </select>
      <a class="btn ghost" href="/finance/audit">Clear</a>
    </form>`;
  const pagination = totalPages > 1 ? `
    <div class="filter-bar" style="margin-top:1rem">
      ${page > 1 ? `<a class="btn ghost" href="/finance/audit?page=${page - 1}${kindFilter ? '&kind=' + esc(kindFilter) : ''}">← Prev</a>` : ''}
      <span class="muted-text">Page ${page} of ${totalPages} (${total} events)</span>
      ${page < totalPages ? `<a class="btn ghost" href="/finance/audit?page=${page + 1}${kindFilter ? '&kind=' + esc(kindFilter) : ''}">Next →</a>` : ''}
    </div>` : '';

  const body = `
    ${filterForm}
    <section class="card">
      <div class="card-head"><h2>Finance Audit Trail</h2><span class="meta">${total} event${total === 1 ? '' : 's'}</span></div>
      ${rows.length ? table(['When', 'Event', 'Description', 'By', ''],
        rows.map((r) => [
          esc(r.occurred_at.slice(0, 16).replace('T', ' ')),
          `<code style="font-size:0.8rem">${esc(r.kind.replace(/_/g, ' '))}</code>`,
          esc(r.description),
          esc(r.actor || '—'),
          r.link ? `<a href="${esc(r.link)}">View</a>` : '',
        ])) : '<p class="muted-text">No finance audit events recorded yet.</p>'}
    </section>
    ${pagination}`;
  res.page({ title: 'Finance · Audit Trail', active: '/finance', body });
});
};
