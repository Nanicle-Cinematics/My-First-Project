'use strict';
// Phase 5: lib/ledger-pg.js, tested directly (not over HTTP) — mirrors the
// original's test/ledger.test.js. This is the highest-stakes file in the
// whole rewrite: real money, atomicity, and (new vs. SQLite) real
// concurrency. Test 6 below is the one that actually proves the
// Postgres-specific period-lock race fix works, not just that the code runs.
const test = require('node:test');
const assert = require('node:assert');
const { db, tenantDb } = require('../lib/tenant');
const { signupChurch } = require('../lib/provision');
const ledger = require('../lib/ledger-pg');

const createdChurchIds = [];

test.after(async () => {
  if (createdChurchIds.length) {
    const where = { churchId: { in: createdChurchIds } };
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.incomeRecord.deleteMany({ where });
    await db.expense.deleteMany({ where });
    await db.fund.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
});

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function newChurch(tag) {
  const { church } = await signupChurch({ churchName: `${tag} Church`, name: 'Owner', email: uniqueEmail(tag), password: 'password123' });
  createdChurchIds.push(church.id);
  return church.id;
}

test('postCashIncome + postExpensePayment produce balanced entries; fund balance reflects net', async () => {
  const churchId = await newChurch('ledger-basic');
  const scoped = tenantDb(churchId);
  const fund = await scoped.fund.create({ data: { name: 'General', fundType: 'GENERAL' } });

  await ledger.postCashIncome(scoped, churchId, { date: '2026-06-01', amount: 500, category: 'Tithe', fundId: fund.id, sourceType: 'TEST' });
  await ledger.postExpensePayment(scoped, churchId, { date: '2026-06-02', amount: 150, category: 'Utilities', fundId: fund.id });

  const balance = await ledger.fundBalance(scoped, churchId, fund.id);
  assert.strictEqual(balance, 350);
  const { raised, spent } = await ledger.fundRaisedSpent(scoped, churchId, fund.id);
  assert.strictEqual(raised, 500);
  assert.strictEqual(spent, 150);
});

test('unbalanced journal entry is rejected before anything is written', async () => {
  const churchId = await newChurch('ledger-unbalanced');
  const scoped = tenantDb(churchId);
  await assert.rejects(
    () => scoped.$transaction((tx) => ledger.postJournal(tx, churchId, {
      date: '2026-06-01',
      lines: [
        { accountCode: ledger.ACC.CASH, debit: 100 },
        { accountCode: ledger.ACC.OTHER_INCOME, credit: 99 },
      ],
    })),
    /Unbalanced journal entry/
  );
  const entries = await scoped.journalEntry.findMany({});
  assert.strictEqual(entries.length, 0, 'a rejected unbalanced entry must not leave a partial row behind');
});

test('reverseJournal nets the fund balance back to zero and links correctly', async () => {
  const churchId = await newChurch('ledger-reverse');
  const scoped = tenantDb(churchId);
  const fund = await scoped.fund.create({ data: { name: 'General', fundType: 'GENERAL' } });

  const entryId = await ledger.postCashIncome(scoped, churchId, { date: '2026-06-01', amount: 200, category: 'Donation', fundId: fund.id });
  assert.strictEqual(await ledger.fundBalance(scoped, churchId, fund.id), 200);

  const reversalId = await ledger.reverseJournal(scoped, churchId, entryId, 'test reversal', null);
  assert.strictEqual(await ledger.fundBalance(scoped, churchId, fund.id), 0, 'reversal must net the balance back to zero');

  const original = await scoped.journalEntry.findUnique({ where: { id: entryId } });
  const reversal = await scoped.journalEntry.findUnique({ where: { id: reversalId } });
  assert.strictEqual(original.status, 'REVERSED');
  assert.strictEqual(reversal.reversesId, entryId);

  await assert.rejects(
    () => ledger.reverseJournal(scoped, churchId, entryId, 'again', null),
    /already reversed/
  );
});

test('a LOCKED financial period rejects new postings into it', async () => {
  const churchId = await newChurch('ledger-locked');
  const scoped = tenantDb(churchId);
  const fund = await scoped.fund.create({ data: { name: 'General', fundType: 'GENERAL' } });
  await scoped.financialPeriod.create({ data: { year: 2026, month: 3, status: 'LOCKED' } });

  await assert.rejects(
    () => ledger.postCashIncome(scoped, churchId, { date: '2026-03-15', amount: 100, category: 'Tithe', fundId: fund.id }),
    /financial period is locked/
  );
  // A different, open month still works fine.
  const entryId = await ledger.postCashIncome(scoped, churchId, { date: '2026-04-15', amount: 100, category: 'Tithe', fundId: fund.id });
  assert.ok(entryId);
});

test('two churches get independent journal-number sequences (both start at JV-2026-000001)', async () => {
  const churchA = await newChurch('ledger-seq-a');
  const churchB = await newChurch('ledger-seq-b');
  const scopedA = tenantDb(churchA);
  const scopedB = tenantDb(churchB);
  const fundA = await scopedA.fund.create({ data: { name: 'General', fundType: 'GENERAL' } });
  const fundB = await scopedB.fund.create({ data: { name: 'General', fundType: 'GENERAL' } });

  const entryIdA = await ledger.postCashIncome(scopedA, churchA, { date: '2026-06-01', amount: 100, category: 'Tithe', fundId: fundA.id });
  const entryIdB = await ledger.postCashIncome(scopedB, churchB, { date: '2026-06-01', amount: 100, category: 'Tithe', fundId: fundB.id });

  const entryA = await scopedA.journalEntry.findUnique({ where: { id: entryIdA } });
  const entryB = await scopedB.journalEntry.findUnique({ where: { id: entryIdB } });
  assert.strictEqual(entryA.entryNo, 'JV-2026-000001');
  assert.strictEqual(entryB.entryNo, 'JV-2026-000001');
});

test('CONCURRENCY: N simultaneous postings into a brand-new period do not corrupt the period row or collide on entry numbers', async () => {
  // This is the actual proof of the Postgres-specific fix in
  // lib/ledger-pg.js's ensurePeriod()/lockPeriod() — SQLite's single-writer
  // serialization made this race structurally impossible, so this test has
  // no equivalent in the original SQLite ledger test suite.
  const churchId = await newChurch('ledger-concurrency');
  const scoped = tenantDb(churchId);
  const fund = await scoped.fund.create({ data: { name: 'General', fundType: 'GENERAL' } });

  const N = 6;
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      ledger.postCashIncome(scoped, churchId, {
        date: '2026-09-10', amount: 10 + i, category: 'Tithe', fundId: fund.id, sourceType: 'CONCURRENCY_TEST',
      }))
  );

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.strictEqual(fulfilled.length, N, `all ${N} concurrent postings should succeed: ${JSON.stringify(results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message))}`);

  const periods = await scoped.financialPeriod.findMany({ where: { year: 2026, month: 9 } });
  assert.strictEqual(periods.length, 1, 'exactly one financial_periods row must exist for the month, not one per racing request');

  const entryIds = fulfilled.map((r) => r.value);
  const entries = await scoped.journalEntry.findMany({ where: { id: { in: entryIds } } });
  const entryNos = entries.map((e) => e.entryNo);
  assert.strictEqual(new Set(entryNos).size, N, 'every concurrently-posted entry must get a distinct entry number, no collisions');

  const balance = await ledger.fundBalance(scoped, churchId, fund.id);
  const expected = Array.from({ length: N }, (_, i) => 10 + i).reduce((a, b) => a + b, 0);
  assert.strictEqual(balance, expected, 'no postings were lost or double-counted under concurrency');
});
