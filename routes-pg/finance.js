'use strict';
// Phase 5 (last phase): Postgres/Prisma port of routes/finance.js + the
// lib/ledger-pg.js engine it drives. This is the highest-stakes module in
// the whole rewrite — real money, atomicity, concurrency — so scope was
// deliberately bounded to the flows that actually exercise the ledger
// engine's correctness first.
//
// SCOPE: chart of accounts (seeded at signup, Phase 1), funds CRUD, generic
// income recording + reversal-on-delete, expense recording (simplified to
// always-PAID — the DRAFT/SUBMITTED/APPROVED workflow is deferred), journal
// entry detail + manual reversal, fund balance/raised/spent, financial
// period locking, (Phase 9d) tithes/special-offerings/standalone day-born
// collections, (Phase 9e) services/harvests with the shared DayBornSplit
// table, (Phase 9f) pledges/pledge-payments, and (Phase 9g — the LAST
// Finance-parity sub-phase) payment vouchers (auto-synced 1:1 with every
// expense, never independently created), finance projects (fund-raising
// targets that expenses/income can tag via projectId), and finance budgets
// (budget-vs-actual computed straight from the ledger via the new
// ledger.budgetActual() reader) — all thin wrappers around
// postCashIncome/postExpensePayment, matching the original's own behavior
// exactly (see routes-pg-html/finance.js's per-feature sections for the
// receipt/delete-route/validation asymmetry notes across features).
//
// STILL DEFERRED: settings UI (receipt/voucher prefix, expense limits —
// FinanceSetting itself is used read-only here already for defaults).

const asyncHandler = require('../lib/async-handler');
const ledger = require('../lib/ledger-pg');
const { amountInWords } = require('../lib/money');

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

function requireFinanceReportAccess(req, res, next) {
  const u = res.locals.user;
  if (!u) return res.status(401).json({ error: 'not logged in' });
  if (u.role === 'ADMIN' || (u.financeRole && u.financeRole !== 'NONE')) return next();
  return res.status(403).json({ error: 'Finance access required' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function isMoneyPositive(v) { return Number.isFinite(Number(v)) && Number(v) > 0; }
function isMoneyNonNeg(v) { return Number.isFinite(Number(v)) && Number(v) >= 0; }
function isValidDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
const HARVEST_TYPES = ['ORGANIZATIONAL', 'END_OF_YEAR', 'OTHER'];
const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
function parseDayBornSplitInputs(b) {
  return DAY_BORN_VALUES
    .map((day) => ({ dayBorn: day, amount: Number(b[`day_${day}_amount`] || 0), headCount: Number(b[`day_${day}_heads`] || 0) }))
    .filter((r) => r.amount > 0 || r.headCount > 0);
}

const DAY_BORN_VALUES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
function dayBornLabel(v) { return String(v || '').charAt(0) + String(v || '').slice(1).toLowerCase(); }

async function defaultFundId(db) {
  const fund = await db.fund.findFirst({ where: { active: true }, orderBy: { id: 'asc' } });
  return fund ? fund.id : null;
}

// tenantDb's Prisma extension only stamps churchId onto a create's own row —
// it never validates a client-supplied foreign-key id (fundId, memberId,
// harvestId, projectId, ...) embedded in that row's data. Every such id must
// be checked explicitly through the scoped client first, or a cross-tenant
// id in the request body would silently attach this church's records to
// another church's fund/member/harvest/project.
// Returns { ok:false } if bodyFundId was supplied but doesn't resolve to a
// fund in this tenant; otherwise { ok:true, fundId } (null if none supplied).
async function checkFundId(db, bodyFundId) {
  if (!bodyFundId) return { ok: true, fundId: null };
  const fund = await db.fund.findUnique({ where: { id: Number(bodyFundId) } });
  return fund ? { ok: true, fundId: fund.id } : { ok: false, fundId: null };
}

/** Same tenant-validation as checkFundId, for the Expense.projectId reference. */
async function checkProjectId(db, bodyProjectId) {
  if (!bodyProjectId) return { ok: true, projectId: null };
  const project = await db.financeProject.findUnique({ where: { id: Number(bodyProjectId) } });
  return project ? { ok: true, projectId: project.id } : { ok: false, projectId: null };
}

/** Same tenant-validation as checkFundId, for Pledge.memberId/harvestId (both required, not optional). */
async function checkPledgeRefs(db, bodyMemberId, bodyHarvestId) {
  const [member, harvest] = await Promise.all([
    db.member.findUnique({ where: { id: Number(bodyMemberId) } }),
    db.harvest.findUnique({ where: { id: Number(bodyHarvestId) } }),
  ]);
  return { ok: Boolean(member && harvest) };
}

/** Same tenant-validation as checkFundId, for SpecialOffering.donorId. */
async function checkDonorId(db, bodyDonorId) {
  if (!bodyDonorId) return { ok: true, donorId: null };
  const member = await db.member.findUnique({ where: { id: Number(bodyDonorId) } });
  return member ? { ok: true, donorId: member.id } : { ok: false, donorId: null };
}

/** Same tenant-validation as checkFundId, for Service.serviceTypeId (required, not optional). */
async function checkServiceTypeId(db, bodyServiceTypeId) {
  const serviceType = await db.serviceType.findUnique({ where: { id: Number(bodyServiceTypeId) } });
  return serviceType ? { ok: true, serviceTypeId: serviceType.id } : { ok: false, serviceTypeId: null };
}

/** Same tenant-validation as checkFundId, for Harvest.orgId. */
async function checkOrgId(db, bodyOrgId) {
  if (!bodyOrgId) return { ok: true, orgId: null };
  const org = await db.organization.findUnique({ where: { id: Number(bodyOrgId) } });
  return org ? { ok: true, orgId: org.id } : { ok: false, orgId: null };
}

/** Same tenant-validation as checkFundId, for FinanceBudgetLine.accountId. */
async function checkAccountId(db, bodyAccountId) {
  if (!bodyAccountId) return { ok: true, accountId: null };
  const account = await db.account.findUnique({ where: { id: Number(bodyAccountId) } });
  return account ? { ok: true, accountId: account.id } : { ok: false, accountId: null };
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

// Same shape as nextReceiptNo, but 4-digit padding and its own prefix
// (FinanceSetting.voucherPrefix, default 'PV') — a completely independent
// numbering scheme from receipts, matching the original.
async function nextVoucherNo(db, dateStr) {
  const settings = await db.financeSetting.findFirst();
  const prefix = (settings && settings.voucherPrefix) || 'PV';
  const year = String(dateStr || new Date().toISOString()).slice(0, 4);
  const base = `${prefix}-${year}-`;
  const last = await db.paymentVoucher.findFirst({ where: { voucherNo: { startsWith: base } }, orderBy: { voucherNo: 'desc' } });
  const next = last ? Number(String(last.voucherNo).slice(base.length)) + 1 : 1;
  return `${base}${String(next).padStart(4, '0')}`;
}

// Vouchers are 100% derived from expenses — never independently created.
// Direct port of the original's syncExpenseVoucher(): find-or-create,
// re-deriving fields from the (already-updated) expense row every time.
// Called right after an expense is created (or, once expense-editing ever
// lands, edited too) — no separate user action.
async function syncExpenseVoucher(db, expense, userId) {
  const existing = await db.paymentVoucher.findFirst({ where: { expenseId: expense.id } });
  const fields = {
    voucherDate: expense.spentOn,
    amountInWords: amountInWords(expense.amount),
    supportingDocRef: expense.referenceNumber || null,
    approvedBy: expense.approvedBy || null,
    paidBy: userId,
    receivedBy: expense.paidTo || null,
    notes: expense.description || null,
  };
  if (existing) {
    await db.paymentVoucher.update({ where: { id: existing.id }, data: fields });
  } else {
    await db.paymentVoucher.create({
      data: { ...fields, voucherNo: await nextVoucherNo(db, expense.spentOn.toISOString().slice(0, 10)), expenseId: expense.id, preparedBy: userId },
    });
  }
  return expense;
}

function register(app) {
  // --- Chart of accounts (read-only here — seeded per-church at signup) ---
  app.get('/api/finance/accounts', requireAuth, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.account.findMany({ where: { active: true }, orderBy: { code: 'asc' } });
    res.json(rows);
  }));

  // --- Funds ---
  app.get('/api/finance/funds', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
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

  app.get('/api/finance/funds/:id/balance', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
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
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) return res.status(400).json({ error: 'Fund not found' });
    const fundId = fundCheck.fundId ?? await defaultFundId(db);

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

  // --- Standalone day-born collections ---
  app.get('/api/finance/day-borns', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.dayBornCollection.findMany({
      where: { deletedAt: null }, orderBy: [{ collectionDate: 'desc' }, { id: 'desc' }], take: 120,
      include: { fund: { select: { name: true } } },
    });
    res.json(rows);
  }));

  app.post('/api/finance/day-borns', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    if (!isValidDate(b.collectionDate)) return res.status(400).json({ error: 'Enter a valid collection date.' });
    if (!DAY_BORN_VALUES.includes(String(b.dayBorn || '').toUpperCase())) return res.status(400).json({ error: 'Enter a valid day-born.' });
    if (!isMoneyPositive(b.amount)) return res.status(400).json({ error: 'Amount must be greater than 0.' });

    const dayBorn = String(b.dayBorn).toUpperCase();
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) return res.status(400).json({ error: 'Fund not found' });
    const fundId = fundCheck.fundId ?? await defaultFundId(db);
    const receiptNo = await nextReceiptNo(db, b.collectionDate);

    const row = await db.dayBornCollection.create({
      data: {
        collectionDate: new Date(b.collectionDate), dayBorn, amount: Number(b.amount),
        headCount: Number(b.headCount) || 0, paymentMethod: b.paymentMethod || 'Cash', fundId,
        referenceNumber: b.referenceNumber || null, receiptNumber: receiptNo, notes: b.notes || null,
        recordedBy: res.locals.user.id,
      },
    });
    const entryId = await ledger.postCashIncome(db, churchId, {
      date: b.collectionDate, amount: Number(b.amount), incomeAccount: ledger.ACC.DAYBORNS,
      fundId, sourceType: 'DAY_BORN_COLLECTION', sourceId: row.id, createdBy: res.locals.user.id,
      memo: `${dayBornLabel(dayBorn)} day-born collection`,
    });
    const [updated] = await Promise.all([
      db.dayBornCollection.update({ where: { id: row.id }, data: { journalEntryId: entryId } }),
      db.financeReceipt.create({
        data: {
          receiptNumber: receiptNo, sourceType: 'DAY_BORN_COLLECTION', sourceId: row.id, receiptDate: new Date(b.collectionDate),
          receivedFrom: `${dayBornLabel(dayBorn)} day-born group`, amount: Number(b.amount),
          description: `${dayBornLabel(dayBorn)} day-born collection`, createdBy: res.locals.user.id,
        },
      }),
    ]);
    res.status(201).json(updated);
  }));

  app.delete('/api/finance/day-borns/:id', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const row = await db.dayBornCollection.findUnique({ where: { id } });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.journalEntryId) await ledger.reverseJournal(db, churchId, row.journalEntryId, 'Day-born collection archived', res.locals.user.id);
    await db.dayBornCollection.update({ where: { id }, data: { deletedAt: new Date() } });
    await db.financeReceipt.updateMany({ where: { sourceType: 'DAY_BORN_COLLECTION', sourceId: id }, data: { voidedAt: new Date(), voidReason: 'Day-born collection archived' } });
    res.status(204).end();
  }));

  // --- Special offerings (no receipt, no delete route — matches the original) ---
  app.get('/api/finance/special', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.specialOffering.findMany({
      where: { deletedAt: null }, orderBy: [{ offeringDate: 'desc' }, { id: 'desc' }], take: 100,
      include: { specialCategory: { select: { categoryName: true } }, donor: { select: { firstName: true, lastName: true } } },
    });
    res.json(rows);
  }));

  app.post('/api/finance/special', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    const specialCatId = Number(b.specialCatId);
    if (!specialCatId) return res.status(400).json({ error: 'specialCatId is required' });
    if (!isValidDate(b.offeringDate)) return res.status(400).json({ error: 'Enter a valid offering date.' });
    if (!isMoneyPositive(b.amount)) return res.status(400).json({ error: 'Amount must be greater than 0.' });

    const cat = await db.specialCategory.findUnique({ where: { id: specialCatId } });
    if (!cat) return res.status(404).json({ error: 'Special category not found' });
    const donorCheck = await checkDonorId(db, b.donorId);
    if (!donorCheck.ok) return res.status(404).json({ error: 'Donor not found' });
    const donorId = donorCheck.donorId;
    const fundId = await defaultFundId(db);

    const row = await db.specialOffering.create({
      data: {
        specialCatId, offeringDate: new Date(b.offeringDate), donorId, donorNameManual: b.donorNameManual || null,
        amount: Number(b.amount), purpose: b.purpose || null, receiptNumber: b.receiptNumber || null,
        notes: b.notes || null, recordedBy: res.locals.user.id,
      },
    });
    const entryId = await ledger.postCashIncome(db, churchId, {
      date: b.offeringDate, amount: Number(b.amount), incomeAccount: ledger.incomeAccountFor(cat.categoryName),
      fundId, sourceType: 'SPECIAL_OFFERING', sourceId: row.id, createdBy: res.locals.user.id,
      memo: b.purpose || cat.categoryName,
    });
    const updated = await db.specialOffering.update({ where: { id: row.id }, data: { journalEntryId: entryId } });
    res.status(201).json(updated);
  }));

  // --- Tithes (no receipt, no delete route — matches the original) ---
  app.get('/api/finance/tithes', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const memberId = req.query.memberId ? Number(req.query.memberId) : null;
    const rows = await res.locals.db.tithe.findMany({
      where: { deletedAt: null, ...(memberId ? { memberId } : {}) }, orderBy: [{ titheDate: 'desc' }, { id: 'desc' }], take: 200,
      include: { member: { select: { firstName: true, lastName: true, externalId: true } } },
    });
    res.json(rows);
  }));

  app.post('/api/finance/tithes', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    const memberId = Number(b.memberId);
    // Matches the original exactly: looser validation than the other two
    // finance features (no isValidDate/isMoneyPositive calls there either).
    if (!memberId || !b.amount || !b.titheDate) return res.status(400).json({ error: 'memberId, amount and titheDate are required' });

    const member = await db.member.findUnique({ where: { id: memberId } });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const fundId = await defaultFundId(db);

    const row = await db.tithe.create({
      data: {
        memberId, amount: Number(b.amount), titheDate: new Date(b.titheDate),
        method: b.method || null, reference: b.reference || null, notes: b.notes || null, recordedBy: res.locals.user.id,
      },
    });
    const entryId = await ledger.postCashIncome(db, churchId, {
      date: b.titheDate, amount: Number(b.amount), incomeAccount: ledger.ACC.TITHES,
      fundId, sourceType: 'TITHE', sourceId: row.id, createdBy: res.locals.user.id,
      memo: `Tithe from ${member.firstName} ${member.lastName}`,
    });
    const updated = await db.tithe.update({ where: { id: row.id }, data: { journalEntryId: entryId } });
    res.status(201).json(updated);
  }));

  // --- Services (no receipt, no fund/payment-method picker — matches the original) ---
  app.get('/api/finance/services', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.service.findMany({
      where: { deletedAt: null }, orderBy: [{ serviceDate: 'desc' }, { id: 'desc' }], take: 50,
      include: { serviceType: { select: { typeName: true } } },
    });
    res.json(rows);
  }));

  app.get('/api/finance/services/:id', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const service = await db.service.findFirst({ where: { id, deletedAt: null }, include: { serviceType: { select: { typeName: true } } } });
    if (!service) return res.status(404).json({ error: 'Not found' });
    const splits = await db.dayBornSplit.findMany({ where: { serviceId: id } });
    res.json({ ...service, dayBornSplits: splits });
  }));

  app.post('/api/finance/services', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    if (!Number(b.serviceTypeId)) return res.status(400).json({ error: 'serviceTypeId is required' });
    if (!isValidDate(b.serviceDate)) return res.status(400).json({ error: 'Enter a valid service date.' });
    if (!isMoneyNonNeg(b.totalAmount)) return res.status(400).json({ error: 'Total amount must be 0 or more.' });
    const serviceTypeCheck = await checkServiceTypeId(db, b.serviceTypeId);
    if (!serviceTypeCheck.ok) return res.status(404).json({ error: 'Service type not found' });

    const service = await db.service.create({
      data: { serviceTypeId: serviceTypeCheck.serviceTypeId, serviceDate: new Date(b.serviceDate), totalAmount: Number(b.totalAmount) || 0, notes: b.notes || null, recordedBy: res.locals.user.id },
    });
    const splits = parseDayBornSplitInputs(b);
    if (splits.length) {
      await db.dayBornSplit.createMany({ data: splits.map((s) => ({ serviceId: service.id, dayBorn: s.dayBorn, amount: s.amount, headCount: s.headCount })) });
    }
    if (Number(b.totalAmount) > 0) {
      const fundId = await defaultFundId(db);
      const entryId = await ledger.postCashIncome(db, churchId, {
        date: b.serviceDate, amount: Number(b.totalAmount), incomeAccount: ledger.ACC.OFFERTORY,
        fundId, sourceType: 'SERVICE', sourceId: service.id, createdBy: res.locals.user.id, memo: 'Service offering',
      });
      await db.service.update({ where: { id: service.id }, data: { journalEntryId: entryId } });
    }
    res.status(201).json(service);
  }));

  app.put('/api/finance/services/:id/splits', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const service = await db.service.findFirst({ where: { id, deletedAt: null } });
    if (!service) return res.status(404).json({ error: 'Not found' });
    const splits = parseDayBornSplitInputs(req.body || {});
    await db.dayBornSplit.deleteMany({ where: { serviceId: id } });
    if (splits.length) {
      await db.dayBornSplit.createMany({ data: splits.map((s) => ({ serviceId: id, dayBorn: s.dayBorn, amount: s.amount, headCount: s.headCount })) });
    }
    res.json({ ok: true });
  }));

  app.delete('/api/finance/services/:id', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const service = await db.service.findUnique({ where: { id } });
    if (!service) return res.status(404).json({ error: 'Not found' });
    if (service.journalEntryId) await ledger.reverseJournal(db, churchId, service.journalEntryId, 'Service archived', res.locals.user.id);
    await db.service.update({ where: { id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  }));

  // --- Harvests (no receipt, no fund/payment-method picker, read-only pledges) ---
  app.get('/api/finance/harvests', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.harvest.findMany({
      where: { deletedAt: null }, orderBy: [{ harvestYear: 'desc' }, { id: 'desc' }], take: 50,
      include: { organization: { select: { name: true } } },
    });
    res.json(rows);
  }));

  app.get('/api/finance/harvests/:id', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const harvest = await db.harvest.findFirst({ where: { id, deletedAt: null }, include: { organization: { select: { name: true } } } });
    if (!harvest) return res.status(404).json({ error: 'Not found' });
    const [splits, pledges] = await Promise.all([
      db.dayBornSplit.findMany({ where: { harvestId: id } }),
      db.pledge.findMany({ where: { harvestId: id }, include: { member: { select: { id: true, firstName: true, lastName: true } } } }),
    ]);
    res.json({ ...harvest, dayBornSplits: splits, pledges });
  }));

  app.post('/api/finance/harvests', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    // The original had NO server-side validation on harvests (relied on
    // now-absent-in-Postgres DB constraints) — deliberately not matched.
    const harvestType = HARVEST_TYPES.includes(b.harvestType) ? b.harvestType : null;
    const harvestYear = Number(b.harvestYear);
    if (!harvestType) return res.status(400).json({ error: 'harvestType must be one of ' + HARVEST_TYPES.join(', ') });
    if (!Number.isInteger(harvestYear) || harvestYear < 1900) return res.status(400).json({ error: 'Enter a valid harvest year.' });
    if (!b.harvestName || !String(b.harvestName).trim()) return res.status(400).json({ error: 'harvestName is required' });
    if (b.harvestDate && !isValidDate(b.harvestDate)) return res.status(400).json({ error: 'Enter a valid harvest date.' });
    if (!isMoneyNonNeg(b.totalCollected || 0)) return res.status(400).json({ error: 'Total collected must be 0 or more.' });
    const orgCheck = await checkOrgId(db, b.orgId);
    if (!orgCheck.ok) return res.status(404).json({ error: 'Organization not found' });

    const harvest = await db.harvest.create({
      data: {
        harvestType, harvestYear, harvestName: String(b.harvestName).trim(),
        harvestDate: b.harvestDate ? new Date(b.harvestDate) : null,
        orgId: orgCheck.orgId, theme: b.theme || null,
        totalCollected: Number(b.totalCollected) || 0, notes: b.notes || null, recordedBy: res.locals.user.id,
      },
    });
    if (Number(b.totalCollected) > 0) {
      const fundId = await defaultFundId(db);
      const postDate = b.harvestDate || `${harvestYear}-01-01`;
      const entryId = await ledger.postCashIncome(db, churchId, {
        date: postDate, amount: Number(b.totalCollected), incomeAccount: ledger.ACC.HARVEST,
        fundId, sourceType: 'HARVEST', sourceId: harvest.id, createdBy: res.locals.user.id, memo: harvest.harvestName,
      });
      await db.harvest.update({ where: { id: harvest.id }, data: { journalEntryId: entryId } });
    }
    res.status(201).json(harvest);
  }));

  app.put('/api/finance/harvests/:id/splits', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const harvest = await db.harvest.findFirst({ where: { id, deletedAt: null } });
    if (!harvest) return res.status(404).json({ error: 'Not found' });
    const splits = parseDayBornSplitInputs(req.body || {});
    await db.dayBornSplit.deleteMany({ where: { harvestId: id } });
    if (splits.length) {
      await db.dayBornSplit.createMany({ data: splits.map((s) => ({ harvestId: id, dayBorn: s.dayBorn, amount: s.amount, headCount: s.headCount })) });
    }
    res.json({ ok: true });
  }));

  app.delete('/api/finance/harvests/:id', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const harvest = await db.harvest.findUnique({ where: { id } });
    if (!harvest) return res.status(404).json({ error: 'Not found' });
    if (harvest.journalEntryId) await ledger.reverseJournal(db, churchId, harvest.journalEntryId, 'Harvest archived', res.locals.user.id);
    await db.harvest.update({ where: { id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  }));

  // --- Pledges (creation/edit never touch the ledger — only payments do, matching the original) ---
  function pledgeStatusFor(pledged, paid) {
    return paid <= 0 ? 'PENDING' : paid >= pledged ? 'FULFILLED' : 'PARTIAL';
  }
  function pledgePaymentReceiptNo(paymentId) { return 'RCT-' + String(paymentId).padStart(5, '0'); }

  app.get('/api/finance/pledges', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.pledge.findMany({
      where: { member: { deletedAt: null } }, orderBy: [{ pledgeDate: 'desc' }, { id: 'desc' }], take: 100,
      include: { member: { select: { id: true, firstName: true, lastName: true } }, harvest: { select: { harvestName: true } } },
    });
    res.json(rows);
  }));

  app.post('/api/finance/pledges', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const memberId = Number(b.memberId);
    const harvestId = Number(b.harvestId);
    const pledged = Number(b.pledgedAmount);
    const paid = Number(b.paidAmount || 0);
    if (!memberId || !harvestId || !isMoneyPositive(pledged) || !isValidDate(b.pledgeDate)) {
      return res.status(400).json({ error: 'memberId, harvestId, a valid pledgeDate, and pledgedAmount > 0 are required' });
    }
    if (!(await checkPledgeRefs(db, memberId, harvestId)).ok) {
      return res.status(400).json({ error: 'Member or harvest not found' });
    }
    const pledge = await db.pledge.create({
      data: { memberId, harvestId, pledgedAmount: pledged, paidAmount: paid, pledgeDate: new Date(b.pledgeDate), status: pledgeStatusFor(pledged, paid), notes: b.notes || null },
    });
    res.status(201).json(pledge);
  }));

  app.put('/api/finance/pledges/:id', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = req.body || {};
    const pledged = Number(b.pledgedAmount);
    const paid = Number(b.paidAmount || 0);
    if (!(await checkPledgeRefs(db, b.memberId, b.harvestId)).ok) {
      return res.status(400).json({ error: 'Member or harvest not found' });
    }
    try {
      const pledge = await db.pledge.update({
        where: { id },
        data: { memberId: Number(b.memberId), harvestId: Number(b.harvestId), pledgedAmount: pledged, paidAmount: paid, pledgeDate: new Date(b.pledgeDate), status: pledgeStatusFor(pledged, paid), notes: b.notes || null },
      });
      res.json(pledge);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.post('/api/finance/pledges/:id/pay', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const add = Number(req.body.add || 0);
    if (!isMoneyPositive(add)) return res.status(400).json({ error: 'add must be greater than 0' });
    const pledge = await db.pledge.findFirst({ where: { id }, include: { harvest: { select: { harvestName: true } } } });
    if (!pledge) return res.status(404).json({ error: 'Not found' });

    const payment = await db.pledgePayment.create({ data: { pledgeId: id, amount: add, paidOn: new Date(), receiptNumber: '', recordedBy: res.locals.user.id } });
    const receiptNumber = pledgePaymentReceiptNo(payment.id);
    await db.pledgePayment.update({ where: { id: payment.id }, data: { receiptNumber } });
    const newPaid = Number(pledge.paidAmount) + add;
    const status = newPaid >= Number(pledge.pledgedAmount) ? 'FULFILLED' : 'PARTIAL';
    await db.pledge.update({ where: { id }, data: { paidAmount: newPaid, status } });
    const entryId = await ledger.postCashIncome(db, churchId, {
      date: new Date().toISOString().slice(0, 10), amount: add, incomeAccount: ledger.ACC.PLEDGES, fundId: await defaultFundId(db),
      sourceType: 'PLEDGE_PAYMENT', sourceId: payment.id, createdBy: res.locals.user.id,
      memo: `${(pledge.harvest && pledge.harvest.harvestName) || 'Harvest'} pledge payment ${receiptNumber}`,
    });
    const updated = await db.pledgePayment.update({ where: { id: payment.id }, data: { journalEntryId: entryId } });
    res.status(201).json(updated);
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
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) return res.status(400).json({ error: 'Fund not found' });
    const fundId = fundCheck.fundId ?? await defaultFundId(db);
    const projectCheck = await checkProjectId(db, b.projectId);
    if (!projectCheck.ok) return res.status(400).json({ error: 'Project not found' });

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
        projectId: projectCheck.projectId,
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
    let updated = await db.expense.update({ where: { id: expense.id }, data: { journalEntryId: entryId } });
    updated = await syncExpenseVoucher(db, updated, res.locals.user.id);
    res.status(201).json(updated);
  }));

  // --- Payment vouchers (read-only API — vouchers are never independently created) ---
  app.get('/api/finance/vouchers', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.paymentVoucher.findMany({
      orderBy: [{ voucherDate: 'desc' }, { id: 'desc' }], take: 100,
      include: { expense: { select: { category: true, amount: true, description: true } } },
    });
    res.json(rows);
  }));

  app.get('/api/finance/vouchers/:id', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const voucher = await res.locals.db.paymentVoucher.findFirst({
      where: { id: Number(req.params.id) },
      include: { expense: true },
    });
    if (!voucher) return res.status(404).json({ error: 'Not found' });
    res.json(voucher);
  }));

  // --- Finance projects ---
  app.get('/api/finance/projects', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.financeProject.findMany({ orderBy: { name: 'asc' }, include: { fund: { select: { name: true } } } });
    res.json(rows);
  }));

  app.post('/api/finance/projects', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!isMoneyNonNeg(b.targetAmount || 0)) return res.status(400).json({ error: 'targetAmount must be 0 or more' });
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) return res.status(400).json({ error: 'Fund not found' });
    try {
      const project = await db.financeProject.create({
        data: {
          name, description: b.description || null, fundId: fundCheck.fundId,
          targetAmount: Number(b.targetAmount) || 0, responsibleOfficer: b.responsibleOfficer || null,
          startDate: b.startDate ? new Date(b.startDate) : null, endDate: b.endDate ? new Date(b.endDate) : null,
          status: PROJECT_STATUSES.includes(b.status) ? b.status : 'ACTIVE',
        },
      });
      res.status(201).json(project);
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'A project with that name already exists' });
      throw e;
    }
  }));

  app.get('/api/finance/projects/:id', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const project = await db.financeProject.findUnique({ where: { id }, include: { fund: { select: { name: true } } } });
    if (!project) return res.status(404).json({ error: 'Not found' });
    const [raisedSpent, expenseTotal] = await Promise.all([
      project.fundId ? ledger.fundRaisedSpent(db, churchId, project.fundId) : Promise.resolve({ raised: 0, spent: 0 }),
      project.fundId ? Promise.resolve(0) : db.expense.aggregate({ where: { projectId: id }, _sum: { amount: true } }).then((r) => r._sum.amount || 0),
    ]);
    const spent = project.fundId ? raisedSpent.spent : expenseTotal;
    const raised = project.fundId ? raisedSpent.raised : 0;
    res.json({ ...project, raised, spent, balance: raised - spent, pct: project.targetAmount > 0 ? Math.min(100, Math.round((raised / project.targetAmount) * 100)) : 0 });
  }));

  app.put('/api/finance/projects/:id', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = req.body || {};
    if (!isMoneyNonNeg(b.targetAmount || 0)) return res.status(400).json({ error: 'targetAmount must be 0 or more' });
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) return res.status(400).json({ error: 'Fund not found' });
    try {
      const project = await db.financeProject.update({
        where: { id },
        data: {
          name: String(b.name || '').trim(), description: b.description || null, fundId: fundCheck.fundId,
          targetAmount: Number(b.targetAmount) || 0, responsibleOfficer: b.responsibleOfficer || null,
          startDate: b.startDate ? new Date(b.startDate) : null, endDate: b.endDate ? new Date(b.endDate) : null,
          status: PROJECT_STATUSES.includes(b.status) ? b.status : 'ACTIVE',
        },
      });
      res.json(project);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      if (e.code === 'P2002') return res.status(409).json({ error: 'A project with that name already exists' });
      throw e;
    }
  }));

  // --- Finance budgets ---
  app.get('/api/finance/budgets', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.financeBudget.findMany({ orderBy: [{ year: 'desc' }, { id: 'desc' }] });
    res.json(rows);
  }));

  app.post('/api/finance/budgets', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const year = Number(b.year);
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
    if (!Number.isInteger(year)) return res.status(400).json({ error: 'year must be an integer' });
    const scope = b.scope === 'MONTHLY' ? 'MONTHLY' : 'ANNUAL';
    const month = scope === 'MONTHLY' ? Number(b.month) : null;
    if (scope === 'MONTHLY' && !(month >= 1 && month <= 12)) return res.status(400).json({ error: 'month must be 1-12 for a MONTHLY budget' });
    const budget = await db.financeBudget.create({ data: { name: String(b.name).trim(), year, month, scope, notes: b.notes || null } });
    res.status(201).json(budget);
  }));

  app.get('/api/finance/budgets/:id', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const budget = await db.financeBudget.findUnique({ where: { id }, include: { lines: { include: { fund: { select: { name: true } } } } } });
    if (!budget) return res.status(404).json({ error: 'Not found' });
    const win = ledger.budgetWindow(budget);
    const accountIds = [...new Set(budget.lines.map((l) => l.accountId).filter(Boolean))];
    const accounts = accountIds.length ? await db.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true } }) : [];
    const lines = await Promise.all(budget.lines.map(async (l) => {
      const actual = await ledger.budgetActual(db, churchId, { lineType: l.lineType, accountId: l.accountId, fundId: l.fundId, from: win.from, to: win.to });
      return { ...l, accountName: (accounts.find((a) => a.id === l.accountId) || {}).name || null, actual, variance: Number(l.amount) - actual };
    }));
    res.json({ ...budget, lines });
  }));

  app.post('/api/finance/budgets/:id/lines', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = req.body || {};
    const budget = await db.financeBudget.findUnique({ where: { id } });
    if (!budget) return res.status(404).json({ error: 'Not found' });
    if (budget.status === 'CLOSED') return res.status(409).json({ error: 'This budget is closed; lines are immutable' });
    if (!['INCOME', 'EXPENSE'].includes(b.lineType)) return res.status(400).json({ error: 'lineType must be INCOME or EXPENSE' });
    if (!b.category || !String(b.category).trim()) return res.status(400).json({ error: 'category is required' });
    if (!isMoneyNonNeg(b.amount)) return res.status(400).json({ error: 'amount must be 0 or more' });
    const accountCheck = await checkAccountId(db, b.accountId);
    const fundCheck = await checkFundId(db, b.fundId);
    if (!accountCheck.ok || !fundCheck.ok) return res.status(404).json({ error: 'Account or fund not found' });
    const line = await db.financeBudgetLine.create({
      data: { budgetId: id, lineType: b.lineType, category: String(b.category).trim(), accountId: accountCheck.accountId, fundId: fundCheck.fundId, amount: Number(b.amount), notes: b.notes || null },
    });
    res.status(201).json(line);
  }));

  app.put('/api/finance/budgets/:id/lines/:lineId', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const lineId = Number(req.params.lineId);
    const b = req.body || {};
    const budget = await db.financeBudget.findUnique({ where: { id } });
    if (!budget) return res.status(404).json({ error: 'Not found' });
    if (budget.status === 'CLOSED') return res.status(409).json({ error: 'This budget is closed; lines are immutable' });
    if (!isMoneyNonNeg(b.amount)) return res.status(400).json({ error: 'amount must be 0 or more' });
    const accountCheck = await checkAccountId(db, b.accountId);
    const fundCheck = await checkFundId(db, b.fundId);
    if (!accountCheck.ok || !fundCheck.ok) return res.status(404).json({ error: 'Account or fund not found' });
    try {
      const line = await db.financeBudgetLine.update({
        where: { id: lineId },
        data: { lineType: ['INCOME', 'EXPENSE'].includes(b.lineType) ? b.lineType : undefined, category: b.category ? String(b.category).trim() : undefined, accountId: accountCheck.accountId, fundId: fundCheck.fundId, amount: Number(b.amount), notes: b.notes || null },
      });
      res.json(line);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Line not found' });
      throw e;
    }
  }));

  app.delete('/api/finance/budgets/:id/lines/:lineId', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const budget = await db.financeBudget.findUnique({ where: { id: Number(req.params.id) } });
    if (!budget) return res.status(404).json({ error: 'Not found' });
    if (budget.status === 'CLOSED') return res.status(409).json({ error: 'This budget is closed; lines are immutable' });
    try {
      await db.financeBudgetLine.delete({ where: { id: Number(req.params.lineId) } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Line not found' });
      throw e;
    }
  }));

  app.post('/api/finance/budgets/:id/status', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const status = req.body && req.body.status;
    if (!['DRAFT', 'APPROVED', 'CLOSED'].includes(status)) return res.status(400).json({ error: 'status must be DRAFT, APPROVED, or CLOSED' });
    try {
      const budget = await db.financeBudget.update({ where: { id }, data: { status } });
      res.json(budget);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  // --- Journal entries ---
  app.get('/api/finance/journal/:id', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
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
