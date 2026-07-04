'use strict';
// Phase 5: Postgres/Prisma port of lib/ledger.js — the double-entry ledger
// engine. This is the highest-stakes port in the whole rewrite (real money,
// atomicity, concurrency), so it gets extra scrutiny beyond the usual
// mechanical conversion:
//
// 1. Every write path (postJournal, reverseJournal) ALWAYS runs inside a
//    Prisma interactive $transaction — callers pass a scoped tenantDb(church)
//    client and this module opens its own transaction, mirroring the
//    original's `db.transaction(() => {...})()` pattern but async.
// 2. NEW correctness concern that has NO SQLite equivalent (flagged in the
//    original migration plan): SQLite's single-writer serialization made
//    period-lock races structurally impossible. Postgres's default READ
//    COMMITTED isolation does NOT — two concurrent postJournal calls could
//    both read a period as OPEN and both proceed. ensurePeriod() below uses
//    `SELECT ... FOR UPDATE` (raw SQL, manually churchId-scoped per the
//    Phase-4 guardrail — see scripts/check-raw-sql-tenant-scoping.js, which
//    is extended to also scan this file) to serialize concurrent postJournal
//    calls against the same period row, with a create+retry-on-conflict
//    fallback for the "first entry ever in this period" case where there's
//    nothing to lock yet.
// 3. Per-church sequential journal numbering (JV-2026-000001) can also
//    collide under concurrency; postJournal retries entry-number generation
//    on a unique-constraint conflict rather than assuming its first read is
//    still valid by the time it writes.

const { Prisma } = require('@prisma/client');

const ACC = {
  CASH: '1000',
  BANK_CLEARING: '1010',
  RECEIVABLES: '1100',
  FUND_BALANCE: '3000',
  TITHES: '4000',
  OFFERTORY: '4010',
  DAYBORNS: '4020',
  HARVEST: '4030',
  SPECIAL: '4040',
  DONATIONS: '4050',
  PLEDGES: '4060',
  EVENT_INCOME: '4070',
  OTHER_INCOME: '4900',
  UTILITIES: '5000',
  ADMIN: '5010',
  MINISTERIAL: '5020',
  WELFARE: '5030',
  REPAIRS: '5040',
  EVENT_EXPENSE: '5050',
  MUSIC: '5060',
  MISSION: '5070',
  YOUTH: '5080',
  CHILDREN: '5090',
  BANK_CHARGES: '5100',
  EQUIPMENT: '5110',
  PRINTING: '5120',
  TRANSPORT: '5130',
  REFRESHMENT: '5140',
  OTHER_EXPENSE: '5900',
};

function incomeAccountFor(category) {
  const c = String(category || '').toLowerCase();
  if (c.includes('tithe')) return ACC.TITHES;
  if (c.includes('day-born') || c.includes('day born')) return ACC.DAYBORNS;
  if (c.includes('harvest')) return ACC.HARVEST;
  if (c.includes('special')) return ACC.SPECIAL;
  if (c.includes('pledge')) return ACC.PLEDGES;
  if (c.includes('donation')) return ACC.DONATIONS;
  if (c.includes('anniversary') || c.includes('event')) return ACC.EVENT_INCOME;
  if (c.includes('offertory') || c.includes('collection') || c.includes('offering')) return ACC.OFFERTORY;
  return ACC.OTHER_INCOME;
}

function expenseAccountFor(category) {
  const c = String(category || '').toLowerCase();
  if (c.includes('ministerial')) return ACC.MINISTERIAL;
  if (c.includes('admin')) return ACC.ADMIN;
  if (c.includes('utilit')) return ACC.UTILITIES;
  if (c.includes('repair') || c.includes('maintenance')) return ACC.REPAIRS;
  if (c.includes('welfare') || c.includes('benevolence')) return ACC.WELFARE;
  if (c.includes('mission') || c.includes('evangel')) return ACC.MISSION;
  if (c.includes('music') || c.includes('choir')) return ACC.MUSIC;
  if (c.includes('youth')) return ACC.YOUTH;
  if (c.includes('children')) return ACC.CHILDREN;
  if (c.includes('stationery') || c.includes('printing')) return ACC.PRINTING;
  if (c.includes('transport')) return ACC.TRANSPORT;
  if (c.includes('refreshment')) return ACC.REFRESHMENT;
  if (c.includes('event') || c.includes('anniversary')) return ACC.EVENT_EXPENSE;
  if (c.includes('bank')) return ACC.BANK_CHARGES;
  if (c.includes('equipment')) return ACC.EQUIPMENT;
  return ACC.OTHER_EXPENSE;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeDate(value) {
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Journal date must be YYYY-MM-DD.');
  return s;
}

// Raw SQL, manually churchId-scoped (see module header). Locks the period
// row for the duration of the enclosing transaction so a concurrent
// postJournal against the same period cannot proceed until this one commits
// or rolls back.
async function lockPeriod(tx, churchId, year, month) {
  const rows = await tx.$queryRaw`
    SELECT period_id, status FROM financial_periods
    WHERE church_id = ${churchId} AND year = ${year} AND month = ${month}
    FOR UPDATE
  `;
  return rows[0] || null;
}

// PostgreSQL marks a transaction as aborted after any unique-constraint
// violation, so "catch P2002 and retry inside the same transaction" is not a
// valid concurrency strategy. Serialize journal-number allocation per
// church/year before creating a first period or entry number. The lock is
// transaction-scoped and releases automatically on commit/rollback.
async function lockJournalSequence(tx, churchId, year) {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${'journal:' + churchId + ':' + year}, 0)
    )::text AS locked
  `;
}

async function ensurePeriod(tx, churchId, dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const existing = await lockPeriod(tx, churchId, year, month);
  if (existing) return { id: existing.period_id, status: existing.status };
  try {
    const created = await tx.financialPeriod.create({ data: { churchId, year, month } });
    return { id: created.id, status: created.status };
  } catch (e) {
    // Lost the create race to a concurrent transaction — refetch (now
    // FOR UPDATE-locked, so this blocks until the winner commits).
    if (e.code === 'P2002') {
      const retry = await lockPeriod(tx, churchId, year, month);
      return { id: retry.period_id, status: retry.status };
    }
    throw e;
  }
}

async function nextJournalNo(tx, year) {
  const prefix = `JV-${year}-`;
  const last = await tx.journalEntry.findFirst({
    where: { entryNo: { startsWith: prefix } },
    orderBy: { entryNo: 'desc' },
  });
  const next = last ? Number(String(last.entryNo).slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(6, '0')}`;
}

/**
 * Post a balanced journal entry. `tx` must be an already-open transaction
 * client (i.e. called from inside `db.$transaction(async (tx) => ...)`),
 * never the bare scoped client — every caller in this module opens its own
 * transaction around a postJournal() call.
 */
async function postJournal(tx, churchId, params) {
  const lines = params.lines || [];
  if (!lines.length) throw new Error('Journal entry requires at least one line.');
  const debit = roundMoney(lines.reduce((sum, l) => sum + Number(l.debit || 0), 0));
  const credit = roundMoney(lines.reduce((sum, l) => sum + Number(l.credit || 0), 0));
  if (debit <= 0 || credit <= 0 || debit !== credit) {
    throw new Error(`Unbalanced journal entry: debits ${debit} != credits ${credit}.`);
  }

  const date = normalizeDate(params.date);
  await lockJournalSequence(tx, churchId, date.slice(0, 4));
  const period = await ensurePeriod(tx, churchId, date);
  if (period.status === 'LOCKED') throw new Error('This financial period is locked.');

  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const accounts = await tx.account.findMany({ where: { code: { in: codes }, active: true } });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  for (const code of codes) {
    if (!byCode.has(code)) throw new Error(`Chart of accounts missing account code ${code}.`);
  }

  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const entryNo = await nextJournalNo(tx, date.slice(0, 4));
    try {
      const entry = await tx.journalEntry.create({
        data: {
          entryNo,
          entryDate: new Date(date),
          memo: params.memo || null,
          sourceType: params.sourceType || 'OTHER',
          sourceId: params.sourceId == null ? null : String(params.sourceId),
          periodId: period.id,
          createdBy: params.createdBy || null,
        },
      });
      // Deliberately NOT a nested `lines: { create: [...] }` write — the
      // tenantDb extension only auto-stamps churchId on the TOP-LEVEL
      // create() call, never into nested relational writes, so a nested
      // JournalLine create would be missing its required churchId. Two
      // flat creates inside the same `tx` are just as atomic and side-step
      // the footgun entirely; this is the pattern to follow anywhere else a
      // one-to-many nested write might otherwise seem convenient.
      await tx.journalLine.createMany({
        data: lines.map((l) => ({
          churchId,
          entryId: entry.id,
          accountId: byCode.get(l.accountCode).id,
          fundId: l.fundId || null,
          debit: Number(l.debit || 0),
          credit: Number(l.credit || 0),
          memo: l.memo || null,
        })),
      });
      return entry.id;
    } catch (e) {
      if (e.code === 'P2002') { lastErr = e; continue; } // entryNo collision — retry with a fresh number
      throw e;
    }
  }
  throw lastErr;
}

async function postCashIncome(db, churchId, opts) {
  return db.$transaction(async (tx) => postJournal(tx, churchId, {
    date: opts.date,
    memo: opts.memo,
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    createdBy: opts.createdBy,
    lines: [
      { accountCode: ACC.CASH, debit: opts.amount, fundId: opts.fundId },
      { accountCode: opts.incomeAccount || incomeAccountFor(opts.category), credit: opts.amount, fundId: opts.fundId },
    ],
  }), { timeout: 15000, maxWait: 15000 });
}

async function postExpensePayment(db, churchId, opts) {
  return db.$transaction(async (tx) => postJournal(tx, churchId, {
    date: opts.date,
    memo: opts.memo,
    sourceType: 'EXPENSE',
    sourceId: opts.sourceId,
    createdBy: opts.createdBy,
    lines: [
      { accountCode: opts.expenseAccount || expenseAccountFor(opts.category), debit: opts.amount, fundId: opts.fundId },
      { accountCode: ACC.CASH, credit: opts.amount, fundId: opts.fundId },
    ],
  }), { timeout: 15000, maxWait: 15000 });
}

async function reverseJournal(db, churchId, entryId, reason, createdBy) {
  return db.$transaction(async (tx) => {
    const original = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
    if (!original) throw new Error('Journal entry not found.');
    if (original.status === 'REVERSED') throw new Error('Entry already reversed.');

    const accountIds = [...new Set(original.lines.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({ where: { id: { in: accountIds } } });
    const codeById = new Map(accounts.map((a) => [a.id, a.code]));

    const reversalId = await postJournal(tx, churchId, {
      date: new Date().toISOString().slice(0, 10),
      memo: `Reversal of ${original.entryNo}: ${reason || 'No reason provided'}`,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      createdBy,
      lines: original.lines.map((l) => ({
        accountCode: codeById.get(l.accountId),
        fundId: l.fundId,
        debit: l.credit,
        credit: l.debit,
        memo: l.memo ? `Reversal: ${l.memo}` : 'Reversal',
      })),
    });
    await tx.journalEntry.update({ where: { id: entryId }, data: { status: 'REVERSED' } });
    await tx.journalEntry.update({ where: { id: reversalId }, data: { reversesId: entryId } });
    return reversalId;
  }, { timeout: 15000, maxWait: 15000 });
}

// Raw SQL, manually churchId-scoped (see module header + the guardrail).
async function fundBalance(db, churchId, fundId) {
  const fund = await db.fund.findUnique({ where: { id: fundId }, select: { openingBalance: true } });
  if (!fund) return 0;
  const rows = await db.$queryRaw`
    SELECT a.account_type, jl.debit, jl.credit
    FROM journal_lines jl
    JOIN accounts a ON a.account_id = jl.account_id
    JOIN journal_entries je ON je.entry_id = jl.entry_id
    WHERE jl.church_id = ${churchId} AND jl.fund_id = ${fundId} AND je.status IN ('POSTED', 'REVERSED')
  `;
  return roundMoney(rows.reduce((balance, row) => {
    if (row.account_type === 'INCOME') return balance + Number(row.credit) - Number(row.debit);
    if (row.account_type === 'EXPENSE') return balance - Number(row.debit) + Number(row.credit);
    return balance;
  }, Number(fund.openingBalance || 0)));
}

async function fundRaisedSpent(db, churchId, fundId) {
  const rows = await db.$queryRaw`
    SELECT a.account_type, jl.debit, jl.credit
    FROM journal_lines jl
    JOIN accounts a ON a.account_id = jl.account_id
    JOIN journal_entries je ON je.entry_id = jl.entry_id
    WHERE jl.church_id = ${churchId} AND jl.fund_id = ${fundId} AND je.status IN ('POSTED', 'REVERSED')
  `;
  let raised = 0, spent = 0;
  for (const row of rows) {
    if (row.account_type === 'INCOME') raised += Number(row.credit) - Number(row.debit);
    if (row.account_type === 'EXPENSE') spent += Number(row.debit) - Number(row.credit);
  }
  return { raised: roundMoney(raised), spent: roundMoney(spent) };
}

// The (from, to) date range a budget line's "actual" should be summed over —
// the full calendar year for an ANNUAL-scope budget, or one calendar month
// for MONTHLY scope. Pure JS/Date logic, no SQL — direct port of the
// original's budgetWindow().
function budgetWindow({ scope, year, month }) {
  if (scope === 'MONTHLY' && Number(month)) {
    const m = String(Number(month)).padStart(2, '0');
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    return { from: `${year}-${m}-01`, to: `${year}-${m}-${String(lastDay).padStart(2, '0')}` };
  }
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

// Actual income/expense for one budget line, summed straight from the
// ledger (journal_lines/journal_entries/accounts) — same source tables as
// fundBalance/fundRaisedSpent, not from expenses/income_records directly.
// Direct port of the original's budgetActual(). `lineType` is 'INCOME' or
// 'EXPENSE' (maps onto accounts.account_type); accountId/fundId narrow the
// sum to one account/fund when the line specifies them, otherwise "all
// accounts of that type" / "all funds".
async function budgetActual(db, churchId, { lineType, accountId, fundId, from, to }) {
  const rows = await db.$queryRaw`
    SELECT jl.debit, jl.credit
    FROM journal_lines jl
    JOIN accounts a ON a.account_id = jl.account_id
    JOIN journal_entries je ON je.entry_id = jl.entry_id
    WHERE jl.church_id = ${churchId}
      AND je.status IN ('POSTED', 'REVERSED')
      AND je.entry_date >= ${new Date(from)}::date AND je.entry_date <= ${new Date(to)}::date
      AND a.account_type = ${lineType}::"AccountType"
      ${accountId ? Prisma.sql`AND jl.account_id = ${accountId}` : Prisma.empty}
      ${fundId ? Prisma.sql`AND jl.fund_id = ${fundId}` : Prisma.empty}
  `;
  let actual = 0;
  for (const row of rows) {
    actual += lineType === 'INCOME' ? Number(row.credit) - Number(row.debit) : Number(row.debit) - Number(row.credit);
  }
  return roundMoney(actual);
}

module.exports = {
  ACC,
  incomeAccountFor,
  expenseAccountFor,
  postJournal,
  postCashIncome,
  postExpensePayment,
  reverseJournal,
  fundBalance,
  fundRaisedSpent,
  budgetWindow,
  budgetActual,
  ensurePeriod,
};
