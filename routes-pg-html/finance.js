'use strict';
// Phase 8e: HTML port of routes/finance.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/finance.js (JSON at /api/finance/..., this
// is the bare-path HTML surface).
//
// SCOPE matches routes-pg/finance.js exactly (its own header comment
// explains why — highest-stakes module, deliberately bounded): chart of
// accounts (read-only), funds CRUD, generic income record + reversal,
// expense record (simplified always-PAID, no approval workflow), journal
// entry detail + manual reversal, financial period lock/unlock. DEFERRED:
// day-borns/harvests/tithes/pledges/vouchers/budgets/projects/receipts-
// printing/CSV-exports/settings UI — all thin wrappers around the same
// postCashIncome/postExpensePayment primitives already proven here, same
// documented-deferral pattern as every prior phase.

const asyncHandler = require('../lib/async-handler');
const { esc, fmtMoney, todayISO, isMoneyPositive, isMoneyNonNeg, isValidDate } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const ledger = require('../lib/ledger-pg');

function requireFinanceWrite(req, res, next) {
  const u = res.locals.user;
  if (u && (u.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(u.financeRole))) return next();
  return res.status(403).send('Forbidden');
}
function requireFundManager(req, res, next) {
  const u = res.locals.user;
  if (u && (u.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(u.financeRole))) return next();
  return res.status(403).send('Forbidden');
}

const INCOME_CATEGORIES = [
  ['donation', 'Donation'], ['event', 'Event income'], ['rent', 'Facility rental'],
  ['bookshop', 'Bookshop / materials'], ['welfare_refund', 'Welfare refund'], ['other', 'Other income'],
];
function incomeCategoryOptions(selected) {
  return INCOME_CATEGORIES.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');
}
function incomeCategoryLabel(value) {
  const found = INCOME_CATEGORIES.find((r) => r[0] === value);
  return found ? found[1] : String(value || 'Other income');
}
const PAYMENT_METHODS = ['Cash', 'Mobile Money', 'Bank Transfer', 'Cheque', 'Card', 'Other'];
function paymentMethodOptions(selected) {
  return PAYMENT_METHODS.map((m) => `<option ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('');
}
const FUND_TYPES = ['GENERAL', 'BUILDING', 'WELFARE', 'MISSION', 'HARVEST', 'ANNIVERSARY', 'YOUTH', 'MUSIC', 'CHILDREN', 'PROJECT', 'RESTRICTED_DONATION'];
function fundTypeOptions(selected) {
  return FUND_TYPES.map((t) => `<option value="${t}" ${t === selected ? 'selected' : ''}>${esc(t.replace(/_/g, ' '))}</option>`).join('');
}

async function defaultFundId(db) {
  const fund = await db.fund.findFirst({ where: { active: true }, orderBy: { id: 'asc' } });
  return fund ? fund.id : null;
}
async function fundOptions(db, selected, includeBlank = true) {
  const funds = await db.fund.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  const options = includeBlank ? ['<option value="">General fund</option>'] : [];
  for (const f of funds) {
    const label = `${f.code ? f.code + ' · ' : ''}${f.name}`;
    options.push(`<option value="${f.id}" ${Number(selected) === f.id ? 'selected' : ''}>${esc(label)}</option>`);
  }
  return options.join('');
}
async function memberOptions(db) {
  const members = await db.member.findMany({ where: { deletedAt: null }, orderBy: { lastName: 'asc' }, select: { id: true, firstName: true, lastName: true, externalId: true } });
  return '<option value="">Non-member / anonymous</option>' +
    members.map((m) => `<option value="${m.id}">${esc(m.firstName + ' ' + m.lastName)}${m.externalId ? ' · ' + esc(m.externalId) : ''}</option>`).join('');
}

async function nextReceiptNo(db, dateStr) {
  const settings = await db.financeSetting.findFirst();
  const prefix = (settings && settings.receiptPrefix) || 'RCT';
  const year = String(dateStr || new Date().toISOString()).slice(0, 4);
  const base = `${prefix}-${year}-`;
  const last = await db.financeReceipt.findFirst({ where: { receiptNumber: { startsWith: base } }, orderBy: { receiptNumber: 'desc' } });
  const next = last ? Number(String(last.receiptNumber).slice(base.length)) + 1 : 1;
  return `${base}${String(next).padStart(5, '0')}`;
}

function register(app) {
  app.get('/finance', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const tiles = [
      ['/finance/funds', '◎', 'Funds', 'Balances, restrictions, raised/spent.'],
      ['/finance/income', '↗', 'Generic Income', 'Record and reverse one-off income.'],
      ['/finance/expenses', '↘', 'Expenses', 'Record expense payments.'],
    ];
    const body = `${pageHero('Finance', 'Funds, income, and expenses.')}
      <div class="report-tiles">${tiles.map(([href, ico, name, desc]) =>
        `<a class="report-tile" href="${href}"><div class="ico">${ico}</div><div><div class="name">${esc(name)}</div><div class="desc">${esc(desc)}</div></div></a>`).join('')}</div>`;
    res.page({ title: 'Finance', active: '/finance', noHeader: true, body });
  }));

  // --- Funds ---
  app.get('/finance/funds', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const funds = await db.fund.findMany({ where: { active: true }, orderBy: [{ fundType: 'asc' }, { name: 'asc' }] });
    const enriched = await Promise.all(funds.map(async (f) => {
      const [balance, raisedSpent] = await Promise.all([ledger.fundBalance(db, churchId, f.id), ledger.fundRaisedSpent(db, churchId, f.id)]);
      return { ...f, balance, ...raisedSpent };
    }));
    const totalBalance = enriched.reduce((s, f) => s + Number(f.balance || 0), 0);
    const restrictedTotal = enriched.filter((f) => f.restricted).reduce((s, f) => s + Number(f.balance || 0), 0);

    const addForm = canManage
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Add a fund</strong></summary>
           <form class="form" method="post" action="/finance/funds" style="margin-top:0.75rem">
             <label>Code<input name="code" maxlength="16" placeholder="GEN"></label>
             <label>Fund name<input name="name" required></label>
             <label>Type<select name="fundType">${fundTypeOptions('GENERAL')}</select></label>
             <label>Opening balance (GH₵)<input type="number" step="0.01" min="0" name="openingBalance" value="0"></label>
             <label>Responsible officer<input name="responsibleOfficer"></label>
             <label><span>&nbsp;</span><label class="check" style="background:none;padding:0"><input type="checkbox" name="restricted" value="1"> Restricted fund</label></label>
             <label class="wide">Notes<input name="notes"></label>
             <div class="actions"><button type="submit">Save fund</button></div>
           </form>
         </details>` : '';
    const tableRows = enriched.map((f) => [
      esc(f.code) || '—', esc(f.name), esc((f.fundType || 'GENERAL').replace(/_/g, ' ')),
      f.restricted ? '<span class="pill pill-pending">Restricted</span>' : '<span class="pill pill-fulfilled">Unrestricted</span>',
      esc(f.responsibleOfficer || '—'), fmtMoney(f.raised), fmtMoney(f.spent), `<strong>${fmtMoney(f.balance)}</strong>`,
    ]);
    const body = `
      ${statsRow([
        { cls: 'blue', icon: '₵', value: fmtMoney(totalBalance), label: 'Total fund balances' },
        { cls: 'orange', icon: 'R', value: fmtMoney(restrictedTotal), label: 'Restricted balances' },
        { cls: 'green', icon: '#', value: enriched.length, label: 'Active funds' },
      ])}
      ${addForm}
      <section class="card">
        <div class="card-head"><h2>Funds</h2><span class="meta">Restricted and unrestricted church money</span></div>
        ${tableRows.length ? table(['Code', 'Fund', 'Type', 'Restriction', 'Officer', 'Raised', 'Spent', 'Balance'], tableRows) : '<p class="muted-text">No funds configured yet.</p>'}
      </section>`;
    res.page({ title: 'Finance · Funds', active: '/finance', noHeader: true, body: `${pageHero('Funds', '')}${body}` });
  }));

  app.post('/finance/funds', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) { flash(req, 'Enter a fund name.'); return res.redirect('/finance/funds'); }
    if (!isMoneyNonNeg(b.openingBalance || 0)) { flash(req, 'Opening balance must be 0 or more.'); return res.redirect('/finance/funds'); }
    try {
      const fund = await db.fund.create({
        data: {
          name, code: String(b.code || '').trim().toUpperCase() || null,
          fundType: FUND_TYPES.includes(b.fundType) ? b.fundType : 'GENERAL',
          restricted: !!b.restricted, openingBalance: Number(b.openingBalance) || 0,
          responsibleOfficer: b.responsibleOfficer || null, notes: b.notes || null,
        },
      });
      await logActivity(db, 'fund_created', `Created finance fund ${fund.name}`, '/finance/funds', res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      flash(req, 'A fund with that name or code already exists.');
    }
    res.redirect('/finance/funds');
  }));

  // --- Generic income ---
  app.get('/finance/income', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const rows = await db.incomeRecord.findMany({
      where: { deletedAt: null }, orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }], take: 100,
      include: { member: { select: { firstName: true, lastName: true } }, fund: { select: { name: true } } },
    });
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const addForm = canWrite
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Record generic income</strong></summary>
           <form class="form" method="post" action="/finance/income" style="margin-top:0.75rem">
             <label>Date<input type="date" name="transactionDate" required value="${todayISO()}"></label>
             <label>Category<select name="category" required>${incomeCategoryOptions('other')}</select></label>
             <label>Subcategory<input name="subcategory" placeholder="e.g. Thanksgiving, hall rental"></label>
             <label>Member<select name="memberId">${await memberOptions(db)}</select></label>
             <label>Received from<input name="receivedFrom" placeholder="if not a member"></label>
             <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
             <label>Payment method<select name="paymentMethod">${paymentMethodOptions('Cash')}</select></label>
             <label>Fund<select name="fundId">${await fundOptions(db, '', true)}</select></label>
             <label>Reference<input name="referenceNumber"></label>
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
          esc(r.transactionDate.toISOString().slice(0, 10)),
          `${esc(incomeCategoryLabel(r.category))}${r.subcategory ? '<br><span class="muted-text">' + esc(r.subcategory) + '</span>' : ''}`,
          r.memberId ? `<a href="/members/${r.memberId}">${esc(r.member.firstName + ' ' + r.member.lastName)}</a>` : esc(r.receivedFrom || 'Anonymous'),
          fmtMoney(r.amount), esc(r.paymentMethod || 'Cash'), esc((r.fund && r.fund.name) || 'General fund'), esc(r.receiptNumber || '—'),
          canWrite ? `<form method="post" action="/finance/income/${r.id}/delete" onsubmit="return confirm('Reverse and archive this income record?')"><button class="link" type="submit">Reverse</button></form>` : '',
        ])) : '<p class="muted-text">No generic income recorded yet.</p>'}`;
    res.page({ title: 'Finance · Generic Income', active: '/finance', noHeader: true, body: `${pageHero('Generic Income', '')}${body}` });
  }));

  app.post('/finance/income', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    if (!isValidDate(b.transactionDate)) { flash(req, 'Enter a valid income date.'); return res.redirect('/finance/income'); }
    if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/income'); }

    const member = b.memberId ? await db.member.findUnique({ where: { id: Number(b.memberId) } }) : null;
    const receivedFrom = (member && `${member.firstName} ${member.lastName}`) || String(b.receivedFrom || '').trim() || 'Anonymous';
    const category = b.category || 'other';
    const label = incomeCategoryLabel(category);
    const fundId = b.fundId ? Number(b.fundId) : await defaultFundId(db);

    const income = await db.incomeRecord.create({
      data: {
        transactionDate: new Date(b.transactionDate), category, subcategory: b.subcategory || null,
        receivedFrom, memberId: member ? member.id : null, amount: Number(b.amount),
        paymentMethod: b.paymentMethod || 'Cash', fundId, referenceNumber: b.referenceNumber || null,
        description: b.description || null, recordedBy: res.locals.user.id,
      },
    });
    const entryId = await ledger.postCashIncome(db, churchId, {
      date: b.transactionDate, amount: Number(b.amount), incomeAccount: ledger.incomeAccountFor(label),
      fundId, sourceType: 'GENERIC_INCOME', sourceId: income.id, createdBy: res.locals.user.id,
      memo: b.description || `${label} from ${receivedFrom}`,
    });
    const receiptNo = await nextReceiptNo(db, b.transactionDate);
    await Promise.all([
      db.incomeRecord.update({ where: { id: income.id }, data: { journalEntryId: entryId, receiptNumber: receiptNo } }),
      db.financeReceipt.create({
        data: {
          receiptNumber: receiptNo, sourceType: 'GENERIC_INCOME', sourceId: income.id, receiptDate: new Date(b.transactionDate),
          receivedFrom, amount: Number(b.amount), description: b.description || label, createdBy: res.locals.user.id,
        },
      }),
    ]);
    await logActivity(db, 'income_recorded', `Generic income ${receiptNo} recorded`, '/finance/income', res.locals.user.id);
    flash(req, `Income recorded — receipt ${receiptNo}.`, 'success');
    res.redirect('/finance/income');
  }));

  app.post('/finance/income/:id/delete', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const income = await db.incomeRecord.findUnique({ where: { id } });
    if (!income) return res.status(404).send('Not found');
    if (income.journalEntryId) await ledger.reverseJournal(db, churchId, income.journalEntryId, 'Generic income archived', res.locals.user.id);
    await db.incomeRecord.update({ where: { id }, data: { deletedAt: new Date() } });
    await db.financeReceipt.updateMany({ where: { sourceType: 'GENERIC_INCOME', sourceId: id }, data: { voidedAt: new Date(), voidReason: 'Generic income archived' } });
    await logActivity(db, 'finance_reversal', `Generic income #${id} archived and journal reversed`, '/finance/income', res.locals.user.id);
    flash(req, 'Income reversed and archived.', 'success');
    res.redirect('/finance/income');
  }));

  // --- Expenses (simplified to always-PAID; approval workflow deferred) ---
  app.get('/finance/expenses', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const [cats, rows] = await Promise.all([
      db.expenseCategory.findMany({ where: { isActive: true }, orderBy: { categoryName: 'asc' } }),
      db.expense.findMany({ where: {}, orderBy: [{ spentOn: 'desc' }, { id: 'desc' }], take: 100, include: { expenseCategory: { select: { categoryName: true } }, fund: { select: { name: true } } } }),
    ]);
    const catOpts = cats.map((c) => `<option value="${c.id}">${esc(c.categoryName)}</option>`).join('');
    const addForm = canWrite
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Record an expense</strong></summary>
           <form class="form" method="post" action="/finance/expenses" style="margin-top:0.75rem">
             <label>Date<input type="date" name="spentOn" required value="${todayISO()}"></label>
             <label>Category<select name="expenseCatId" required>${catOpts}</select></label>
             <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
             <label>Payment method<select name="paymentMethod">${['Cash', 'Bank Transfer', 'Cheque', 'Mobile Money', 'Other'].map((m) => `<option>${m}</option>`).join('')}</select></label>
             <label>Fund<select name="fundId">${await fundOptions(db, await defaultFundId(db), false)}</select></label>
             <label class="wide">Description<input name="description" required></label>
             <label>Paid to<input name="paidTo"></label>
             <label>Reference #<input name="referenceNumber"></label>
             <div class="actions"><button type="submit">Save</button></div>
           </form>
         </details>` : '';
    const body = `${addForm}
      ${rows.length ? table(['Date', 'Category', 'Description', 'Fund', 'Paid to', 'Method', 'Amount', 'Status'],
        rows.map((e) => [esc(e.spentOn.toISOString().slice(0, 10)), esc((e.expenseCategory && e.expenseCategory.categoryName) || e.category),
          esc(e.description), esc((e.fund && e.fund.name) || '—'), esc(e.paidTo) || '—', esc(e.paymentMethod) || '—',
          fmtMoney(e.amount), `<span class="pill pill-${esc(e.approvalStatus.toLowerCase())}">${esc(e.approvalStatus)}</span>`]))
        : '<p class="muted-text">No expenses recorded yet.</p>'}`;
    res.page({ title: 'Finance · Expenses', active: '/finance', noHeader: true, body: `${pageHero('Expenses', '')}${body}` });
  }));

  app.post('/finance/expenses', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    if (!isValidDate(b.spentOn)) { flash(req, 'Enter a valid date.'); return res.redirect('/finance/expenses'); }
    if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/expenses'); }
    const cat = b.expenseCatId ? await db.expenseCategory.findUnique({ where: { id: Number(b.expenseCatId) } }) : null;
    const categoryName = (cat && cat.categoryName) || b.category || 'Other';
    const fundId = b.fundId ? Number(b.fundId) : await defaultFundId(db);

    const expense = await db.expense.create({
      data: {
        expenseCatId: cat ? cat.id : null, category: categoryName, amount: Number(b.amount), spentOn: new Date(b.spentOn),
        description: b.description || null, paidTo: b.paidTo || null, paymentMethod: b.paymentMethod || null,
        referenceNumber: b.referenceNumber || null, fundId, approvalStatus: 'PAID', paidAt: new Date(),
      },
    });
    const entryId = await ledger.postExpensePayment(db, churchId, {
      date: b.spentOn, amount: Number(b.amount), expenseAccount: ledger.expenseAccountFor(categoryName),
      category: categoryName, fundId, sourceId: expense.id, createdBy: res.locals.user.id, memo: b.description || categoryName,
    });
    await db.expense.update({ where: { id: expense.id }, data: { journalEntryId: entryId } });
    await logActivity(db, 'expense_recorded', `Expense recorded: ${categoryName} (${fmtMoney(b.amount)})`, '/finance/expenses', res.locals.user.id);
    flash(req, 'Expense recorded.', 'success');
    res.redirect('/finance/expenses');
  }));

  // --- Journal entries ---
  app.get('/finance/journal/:id', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const entry = await db.journalEntry.findUnique({ where: { id: Number(req.params.id) }, include: { lines: { include: { account: true, fund: true } } } });
    if (!entry) return res.status(404).send('Not found');
    const body = `
      <dl class="stats">
        <dt>Entry No</dt><dd>${esc(entry.entryNo)}</dd>
        <dt>Date</dt><dd>${esc(entry.entryDate.toISOString().slice(0, 10))}</dd>
        <dt>Status</dt><dd><span class="pill pill-${esc(entry.status.toLowerCase())}">${esc(entry.status)}</span></dd>
        <dt>Memo</dt><dd>${esc(entry.memo) || '—'}</dd>
      </dl>
      ${table(['Account', 'Fund', 'Debit', 'Credit', 'Memo'],
        entry.lines.map((l) => [esc(l.account.name), esc((l.fund && l.fund.name) || '—'), fmtMoney(l.debit), fmtMoney(l.credit), esc(l.memo) || '—']))}
      ${canManage && entry.status !== 'REVERSED' && !entry.reversesId ? `
        <form method="post" action="/finance/journal/${entry.id}/reverse" onsubmit="return confirm('Reverse this journal entry?')" style="margin-top:1rem">
          <label>Reason<input name="reason" placeholder="Why is this being reversed?"></label>
          <div class="actions"><button class="danger" type="submit">Reverse entry</button></div>
        </form>` : ''}`;
    res.page({ title: `Journal · ${entry.entryNo}`, active: '/finance', noHeader: true, body: `${pageHero(`Journal · ${entry.entryNo}`, '')}${body}` });
  }));

  app.post('/finance/journal/:id/reverse', requireFundManager, asyncHandler(async (req, res) => {
    try {
      await ledger.reverseJournal(res.locals.db, res.locals.churchId, Number(req.params.id), req.body?.reason, res.locals.user.id);
      flash(req, 'Journal entry reversed.', 'success');
    } catch (e) {
      if (!/not found|already reversed/i.test(e.message)) throw e;
      flash(req, e.message);
    }
    res.redirect(`/finance/journal/${req.params.id}`);
  }));

  // --- Financial periods ---
  app.get('/finance/periods', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const periods = await res.locals.db.financialPeriod.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });
    const now = new Date();
    const lockForm = canManage
      ? `<form class="form" method="post" action="/finance/periods/lock" style="margin-bottom:1rem">
           <label>Year<input type="number" name="year" required value="${now.getFullYear()}"></label>
           <label>Month<input type="number" name="month" min="1" max="12" required value="${now.getMonth() + 1}"></label>
           <div class="actions"><button type="submit">Lock period</button></div>
         </form>` : '';
    const body = `${lockForm}
      ${periods.length ? table(['Year', 'Month', 'Status', 'Closed at', 'Actions'],
        periods.map((p) => [p.year, p.month ?? '—', `<span class="pill pill-${esc(p.status.toLowerCase())}">${esc(p.status)}</span>`,
          p.closedAt ? esc(p.closedAt.toISOString().slice(0, 10)) : '—',
          canManage && p.status === 'LOCKED' ? `<form method="post" action="/finance/periods/unlock" onsubmit="return confirm('Unlock this period?')">
            <input type="hidden" name="year" value="${p.year}"><input type="hidden" name="month" value="${p.month}">
            <input type="hidden" name="reason" value="Reopened from Finance"><button class="link" type="submit">Unlock</button></form>` : '']))
        : '<p class="muted-text">No periods locked yet.</p>'}`;
    res.page({ title: 'Finance · Periods', active: '/finance', noHeader: true, body: `${pageHero('Financial Periods', '')}${body}` });
  }));

  app.post('/finance/periods/lock', requireFundManager, asyncHandler(async (req, res) => {
    const year = Number(req.body.year);
    const month = Number(req.body.month);
    if (!Number.isInteger(year) || !Number.isInteger(month)) { flash(req, 'Year and month are required.'); return res.redirect('/finance/periods'); }
    await res.locals.db.financialPeriod.upsert({
      where: { churchId_year_month: { churchId: res.locals.churchId, year, month } },
      update: { status: 'LOCKED', closedAt: new Date(), closedBy: res.locals.user.id },
      create: { year, month, status: 'LOCKED', closedAt: new Date(), closedBy: res.locals.user.id },
    });
    flash(req, `Period ${year}-${month} locked.`, 'success');
    res.redirect('/finance/periods');
  }));

  app.post('/finance/periods/unlock', requireFundManager, asyncHandler(async (req, res) => {
    const year = Number(req.body.year);
    const month = Number(req.body.month);
    try {
      await res.locals.db.financialPeriod.update({
        where: { churchId_year_month: { churchId: res.locals.churchId, year, month } },
        data: { status: 'OPEN', reopenReason: req.body.reason || null },
      });
      flash(req, `Period ${year}-${month} unlocked.`, 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      flash(req, 'Period not found.');
    }
    res.redirect('/finance/periods');
  }));
}

module.exports = { register };
