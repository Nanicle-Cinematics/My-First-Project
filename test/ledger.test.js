'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ACC,
  ensureLedgerSchema,
  postCashIncome,
  postExpensePayment,
  reverseJournal,
  fundBalance,
  fundRaisedSpent,
  incomeAccountFor,
  expenseAccountFor,
} = require('../lib/ledger');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  db.pragma('foreign_keys = ON');
  ensureLedgerSchema(db);
  db.prepare(`INSERT INTO funds (fund_id, code, name, fund_type) VALUES (1, 'GEN', 'General', 'GENERAL')`).run();
  db.prepare(`INSERT INTO funds (fund_id, code, name, fund_type, restricted) VALUES (2, 'BLD', 'Building', 'BUILDING', 1)`).run();
  return db;
}

test('ledger schema seeds the default chart of accounts', () => {
  const db = freshDb();
  const count = db.prepare(`SELECT COUNT(*) c FROM accounts`).get().c;
  assert.ok(count >= 20);
  assert.strictEqual(db.prepare(`SELECT account_type FROM accounts WHERE code=?`).get(ACC.CASH).account_type, 'ASSET');
  assert.strictEqual(incomeAccountFor('Harvest thanksgiving'), ACC.HARVEST);
  assert.strictEqual(expenseAccountFor('Utility bill'), ACC.UTILITIES);
});

test('cash income posts a balanced journal and increases fund balance', () => {
  const db = freshDb();
  const entryId = postCashIncome(db, {
    date: '2026-06-07',
    amount: 250,
    category: 'Tithes',
    fundId: 1,
    sourceType: 'TITHE',
    sourceId: 12,
  });
  const entry = db.prepare(`SELECT * FROM journal_entries WHERE entry_id=?`).get(entryId);
  assert.match(entry.entry_no, /^JV-2026-\d{6}$/);
  assert.strictEqual(entry.source_type, 'TITHE');

  const totals = db.prepare(`
    SELECT ROUND(SUM(debit),2) debit, ROUND(SUM(credit),2) credit
    FROM journal_lines WHERE entry_id=?`).get(entryId);
  assert.deepStrictEqual(totals, { debit: 250, credit: 250 });
  assert.strictEqual(fundBalance(db, 1), 250);
});

test('expense payment posts against fund balance', () => {
  const db = freshDb();
  postCashIncome(db, { date: '2026-06-07', amount: 500, category: 'Offering', fundId: 1, sourceType: 'INCOME' });
  postExpensePayment(db, { date: '2026-06-08', amount: 125, category: 'Utilities', fundId: 1, sourceId: 3 });
  assert.strictEqual(fundBalance(db, 1), 375);
  assert.deepStrictEqual(fundRaisedSpent(db, 1), { raised: 500, spent: 125 });
});

test('unbalanced journals are rejected before persistence', () => {
  const db = freshDb();
  assert.throws(() => {
    require('../lib/ledger').postJournal(db, {
      date: '2026-06-07',
      sourceType: 'OTHER',
      lines: [
        { accountCode: ACC.CASH, debit: 100 },
        { accountCode: ACC.OFFERTORY, credit: 90 },
      ],
    });
  }, /Unbalanced journal entry/);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) c FROM journal_entries`).get().c, 0);
});

test('locked periods block new postings', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO financial_periods (year, month, status) VALUES (2026, 6, 'LOCKED')`).run();
  assert.throws(() => {
    postCashIncome(db, { date: '2026-06-07', amount: 100, category: 'Offering', sourceType: 'INCOME' });
  }, /financial period is locked/);
});

test('reversal mirrors a posted journal and removes fund impact', () => {
  const db = freshDb();
  const original = postCashIncome(db, {
    date: '2026-06-07',
    amount: 100,
    category: 'Special offering',
    fundId: 2,
    sourceType: 'SPECIAL_OFFERING',
    sourceId: 5,
  });
  const reversal = reverseJournal(db, original, 'wrong amount');
  assert.notStrictEqual(reversal, original);
  assert.strictEqual(db.prepare(`SELECT status FROM journal_entries WHERE entry_id=?`).get(original).status, 'REVERSED');
  assert.strictEqual(db.prepare(`SELECT reverses_id FROM journal_entries WHERE entry_id=?`).get(reversal).reverses_id, original);
  assert.strictEqual(fundBalance(db, 2), 0);
});
