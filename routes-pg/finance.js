'use strict';
// Phase 5 (last phase): Postgres/Prisma port of routes/finance.js + the
// lib/ledger-pg.js engine it drives. This is the highest-stakes module in
// the whole rewrite — real money, atomicity, concurrency — so scope is
// deliberately bounded to the flows that actually exercise the ledger
// engine's correctness, not an exhaustive port of the original's ~3200
// lines (day-borns/harvests/tithes/pledges/vouchers/budgets/projects/
// receipts-printing/CSV-exports/settings UI are DEFERRED — same documented-
// deferral pattern as every prior phase; they're all thin wrappers around
// the same postCashIncome/postExpensePayment primitives already proven
// here, lower risk to leave for the real per-route cutover).
//
// SCOPE: chart of accounts (seeded at signup, Phase 1), funds CRUD, generic
// income recording + reversal-on-delete, expense recording (simplified to
// always-PAID — the DRAFT/SUBMITTED/APPROVED workflow is deferred), journal
// entry detail + manual reversal, fund balance/raised/spent, and financial
// period locking (the module that most needs a concurrency test, given the
// Postgres period-lock race concern documented in lib/ledger-pg.js).

const asyncHandler = require('../lib/async-handler');
const ledger = require('../lib/ledger-pg');

function requireFinanceWrite(req, res, next) {
  const u = res.locals.user;
  if (u && (u.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(u.financeRole))) return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireFundManager(req, res, next) {
  const u = res.locals.user;
  if (u && (u.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(u.financeRole))) return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function isMoneyPositive(v) { return Number.isFinite(Number(v)) && Number(v) > 0; }
function isValidDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }

async function defaultFundId(db) {
  const fund = await db.fund.findFirst({ where: { active: true }, orderBy: { id: 'asc' } });
  return fund ? fund.id : null;
}

async function nextReceiptNo(db, dateStr) {
  // findFirst (not findUnique) — the scoped client injects churchId into the
  // where clause regardless, and FinanceSetting's only unique key IS
  // churchId itself, so there's no other field to look it up by directly.
  const settings = await db.financeSetting.findFirst();
  const prefix = (settings && settings.receiptPrefix) || 'RCT';
  const year = String(dateStr || new Date().toISOString()).slice(0, 4);
  const base = `${prefix}-${year}-`;
  const last = await db.financeReceipt.findFirst({
    where: { receiptNumber: { startsWith: base } },
    orderBy: { receiptNumber: 'desc' },
  });
  const next = last ? Number(String(last.receiptNumber).slice(base.length)) + 1 : 1;
  return `${base}${String(next).padStart(5, '0')}`;
}

function register(app) {
  // --- Chart of accounts (read-only here — seeded per-church at signup) ---
  app.get('/api/finance/accounts', requireAuth, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.account.findMany({ where: { active: true }, orderBy: { code: 'asc' } });
    res.json(rows);
  }));

  // --- Funds ---
  app.get('/api/finance/funds', requireAuth, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.fund.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    res.json(rows);
  }));

  app.post('/api/finance/funds', requireFundManager, asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const fund = await res.locals.db.fund.create({
        data: {
          name: String(b.name).trim(),
          code: b.code || null,
          fundType: b.fundType || 'GENERAL',
          restricted: !!b.restricted,
          openingBalance: Number(b.openingBalance) || 0,
        },
      });
      res.status(201).json(fund);
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'A fund with that name or code already exists' });
      throw e;
    }
  }));

  app.get('/api/finance/funds/:id/balance', requireAuth, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const fundId = Number(req.params.id);
    const fund = await db.fund.findUnique({ where: { id: fundId } });
    if (!fund) return res.status(404).json({ error: 'Not found' });
    const [balance, raisedSpent] = await Promise.all([
      ledger.fundBalance(db, churchId, fundId),
      ledger.fundRaisedSpent(db, churchId, fundId),
    ]);
    res.json({ fund, balance, ...raisedSpent });
  }));

  // --- Generic income ---
  app.post('/api/finance/income', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    if (!isValidDate(b.transactionDate)) return res.status(400).json({ error: 'Enter a valid income date.' });
    if (!isMoneyPositive(b.amount)) return res.status(400).json({ error: 'Amount must be greater than 0.' });

    const member = b.memberId ? await db.member.findUnique({ where: { id: Number(b.memberId) } }) : null;
    const receivedFrom = (member && `${member.firstName} ${member.lastName}`) || String(b.receivedFrom || '').trim() || 'Anonymous';
    const category = b.category || 'Generic Income';
    const fundId = b.fundId ? Number(b.fundId) : await defaultFundId(db);

    const income = await db.incomeRecord.create({
      data: {
        transactionDate: new Date(b.transactionDate),
        category,
        subcategory: b.subcategory || null,
        receivedFrom,
        memberId: member ? member.id : null,
        amount: Number(b.amount),
        paymentMethod: b.paymentMethod || 'Cash',
        fundId,
        referenceNumber: b.referenceNumber || null,
        description: b.description || null,
        recordedBy: res.locals.user.id,
      },
    });

    const entryId = await ledger.postCashIncome(db, churchId, {
      date: b.transactionDate,
      amount: Number(b.amount),
      incomeAccount: ledger.incomeAccountFor(category),
      fundId,
      sourceType: 'GENERIC_INCOME',
      sourceId: income.id,
      createdBy: res.locals.user.id,
      memo: b.description || `${category} from ${receivedFrom}`,
    });

    const receiptNo = await nextReceiptNo(db, b.transactionDate);
    const [updatedIncome] = await Promise.all([
      db.incomeRecord.update({ where: { id: income.id }, data: { journalEntryId: entryId, receiptNumber: receiptNo } }),
      db.financeReceipt.create({
        data: {
          receiptNumber: receiptNo,
          sourceType: 'GENERIC_INCOME',
          sourceId: income.id,
          receiptDate: new Date(b.transactionDate),
          receivedFrom,
          amount: Number(b.amount),
          description: b.description || category,
          createdBy: res.locals.user.id,
        },
      }),
    ]);
    res.status(201).json(updatedIncome);
  }));

  app.delete('/api/finance/income/:id', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const income = await db.incomeRecord.findUnique({ where: { id } });
    if (!income) return res.status(404).json({ error: 'Not found' });
    if (income.journalEntryId) {
      await ledger.reverseJournal(db, churchId, income.journalEntryId, 'Generic income archived', res.locals.user.id);
    }
    await db.incomeRecord.update({ where: { id }, data: { deletedAt: new Date() } });
    await db.financeReceipt.updateMany({
      where: { sourceType: 'GENERIC_INCOME', sourceId: id },
      data: { voidedAt: new Date(), voidReason: 'Generic income archived' },
    });
    res.status(204).end();
  }));

  // --- Expenses (simplified to always-PAID; approval workflow deferred) ---
  app.post('/api/finance/expenses', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    if (!isValidDate(b.spentOn)) return res.status(400).json({ error: 'Enter a valid date.' });
    if (!isMoneyPositive(b.amount)) return res.status(400).json({ error: 'Amount must be greater than 0.' });
    const cat = b.expenseCatId ? await db.expenseCategory.findUnique({ where: { id: Number(b.expenseCatId) } }) : null;
    const categoryName = (cat && cat.categoryName) || b.category || 'Other';
    const fundId = b.fundId ? Number(b.fundId) : await defaultFundId(db);

    const expense = await db.expense.create({
      data: {
        expenseCatId: cat ? cat.id : null,
        category: categoryName,
        amount: Number(b.amount),
        spentOn: new Date(b.spentOn),
        description: b.description || null,
        paidTo: b.paidTo || null,
        paymentMethod: b.paymentMethod || null,
        referenceNumber: b.referenceNumber || null,
        fundId,
        approvalStatus: 'PAID',
        paidAt: new Date(),
      },
    });

    const entryId = await ledger.postExpensePayment(db, churchId, {
      date: b.spentOn,
      amount: Number(b.amount),
      expenseAccount: ledger.expenseAccountFor(categoryName),
      category: categoryName,
      fundId,
      sourceId: expense.id,
      createdBy: res.locals.user.id,
      memo: b.description || categoryName,
    });
    const updated = await db.expense.update({ where: { id: expense.id }, data: { journalEntryId: entryId } });
    res.status(201).json(updated);
  }));

  // --- Journal entries ---
  app.get('/api/finance/journal/:id', requireAuth, asyncHandler(async (req, res) => {
    const entry = await res.locals.db.journalEntry.findUnique({
      where: { id: Number(req.params.id) },
      include: { lines: { include: { account: true, fund: true } } },
    });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  }));

  app.post('/api/finance/journal/:id/reverse', requireFundManager, asyncHandler(async (req, res) => {
    try {
      const reversalId = await ledger.reverseJournal(
        res.locals.db, res.locals.churchId, Number(req.params.id), req.body?.reason, res.locals.user.id
      );
      res.status(201).json({ reversalId });
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
      if (/already reversed/i.test(e.message)) return res.status(409).json({ error: e.message });
      throw e;
    }
  }));

  // --- Financial periods ---
  app.post('/api/finance/periods/lock', requireFundManager, asyncHandler(async (req, res) => {
    const { year, month } = req.body || {};
    if (!Number.isInteger(year) || !Number.isInteger(month)) return res.status(400).json({ error: 'year and month are required integers' });
    const period = await res.locals.db.financialPeriod.upsert({
      where: { churchId_year_month: { churchId: res.locals.churchId, year, month } },
      update: { status: 'LOCKED', closedAt: new Date(), closedBy: res.locals.user.id },
      create: { year, month, status: 'LOCKED', closedAt: new Date(), closedBy: res.locals.user.id },
    });
    res.json(period);
  }));

  app.post('/api/finance/periods/unlock', requireFundManager, asyncHandler(async (req, res) => {
    const { year, month, reason } = req.body || {};
    try {
      const period = await res.locals.db.financialPeriod.update({
        where: { churchId_year_month: { churchId: res.locals.churchId, year, month } },
        data: { status: 'OPEN', reopenReason: reason || null },
      });
      res.json(period);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Period not found' });
      throw e;
    }
  }));
}

module.exports = { register };
