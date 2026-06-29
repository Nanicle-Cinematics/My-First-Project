'use strict';

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

const DEFAULT_ACCOUNTS = [
  [ACC.CASH, 'Cash in hand', 'ASSET', 'DEBIT', 1],
  [ACC.BANK_CLEARING, 'Bank deposit clearing', 'ASSET', 'DEBIT', 1],
  [ACC.RECEIVABLES, 'Receivables', 'ASSET', 'DEBIT', 1],
  [ACC.FUND_BALANCE, 'Fund balances', 'FUND_EQUITY', 'CREDIT', 1],
  [ACC.TITHES, 'Tithes', 'INCOME', 'CREDIT', 1],
  [ACC.OFFERTORY, 'Offertory / service collections', 'INCOME', 'CREDIT', 1],
  [ACC.DAYBORNS, 'Day-born offerings', 'INCOME', 'CREDIT', 1],
  [ACC.HARVEST, 'Harvest', 'INCOME', 'CREDIT', 1],
  [ACC.SPECIAL, 'Special offerings', 'INCOME', 'CREDIT', 1],
  [ACC.DONATIONS, 'Donations', 'INCOME', 'CREDIT', 1],
  [ACC.PLEDGES, 'Pledges received', 'INCOME', 'CREDIT', 1],
  [ACC.EVENT_INCOME, 'Event income', 'INCOME', 'CREDIT', 0],
  [ACC.OTHER_INCOME, 'Other income', 'INCOME', 'CREDIT', 0],
  [ACC.UTILITIES, 'Utilities', 'EXPENSE', 'DEBIT', 0],
  [ACC.ADMIN, 'Administration', 'EXPENSE', 'DEBIT', 0],
  [ACC.MINISTERIAL, 'Ministerial support', 'EXPENSE', 'DEBIT', 0],
  [ACC.WELFARE, 'Welfare / benevolence', 'EXPENSE', 'DEBIT', 0],
  [ACC.REPAIRS, 'Repairs and maintenance', 'EXPENSE', 'DEBIT', 0],
  [ACC.EVENT_EXPENSE, 'Events and anniversaries', 'EXPENSE', 'DEBIT', 0],
  [ACC.MUSIC, 'Music and choir', 'EXPENSE', 'DEBIT', 0],
  [ACC.MISSION, 'Mission and evangelism', 'EXPENSE', 'DEBIT', 0],
  [ACC.YOUTH, 'Youth ministry', 'EXPENSE', 'DEBIT', 0],
  [ACC.CHILDREN, 'Children ministry', 'EXPENSE', 'DEBIT', 0],
  [ACC.BANK_CHARGES, 'Bank charges', 'EXPENSE', 'DEBIT', 0],
  [ACC.EQUIPMENT, 'Equipment', 'EXPENSE', 'DEBIT', 0],
  [ACC.PRINTING, 'Stationery and printing', 'EXPENSE', 'DEBIT', 0],
  [ACC.TRANSPORT, 'Transport', 'EXPENSE', 'DEBIT', 0],
  [ACC.REFRESHMENT, 'Refreshment', 'EXPENSE', 'DEBIT', 0],
  [ACC.OTHER_EXPENSE, 'Other expenses', 'EXPENSE', 'DEBIT', 0],
];

function ensureLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','FUND_EQUITY','INCOME','EXPENSE')),
      normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
      is_system INTEGER NOT NULL DEFAULT 0,
      parent_id INTEGER REFERENCES accounts(account_id),
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(account_type);

    CREATE TABLE IF NOT EXISTS financial_periods (
      period_id INTEGER PRIMARY KEY,
      year INTEGER NOT NULL,
      month INTEGER,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','LOCKED')),
      closed_at TEXT,
      closed_by INTEGER REFERENCES users(user_id),
      reopen_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(year, month)
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      entry_id INTEGER PRIMARY KEY,
      entry_no TEXT NOT NULL UNIQUE,
      entry_date TEXT NOT NULL,
      memo TEXT,
      status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT','POSTED','REVERSED')),
      source_type TEXT NOT NULL DEFAULT 'OTHER',
      source_id TEXT,
      period_id INTEGER REFERENCES financial_periods(period_id),
      reverses_id INTEGER UNIQUE REFERENCES journal_entries(entry_id),
      created_by INTEGER REFERENCES users(user_id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);

    CREATE TABLE IF NOT EXISTS journal_lines (
      line_id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES journal_entries(entry_id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(account_id),
      fund_id INTEGER REFERENCES funds(fund_id),
      debit REAL NOT NULL DEFAULT 0 CHECK (debit >= 0),
      credit REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
      memo TEXT,
      CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
    );
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_fund ON journal_lines(fund_id);
  `);

  addColumnIfMissing(db, 'funds', 'code', 'code TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_funds_code ON funds(code) WHERE code IS NOT NULL`);
  addColumnIfMissing(db, 'funds', 'fund_type', "fund_type TEXT NOT NULL DEFAULT 'GENERAL'");
  addColumnIfMissing(db, 'funds', 'restricted', 'restricted INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'funds', 'opening_balance', 'opening_balance REAL NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'funds', 'responsible_officer', 'responsible_officer TEXT');
  addColumnIfMissing(db, 'funds', 'notes', 'notes TEXT');
  addColumnIfMissing(db, 'expenses', 'project_id', 'project_id INTEGER REFERENCES finance_projects(project_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS finance_projects (
      project_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      fund_id INTEGER REFERENCES funds(fund_id),
      target_amount REAL NOT NULL DEFAULT 0 CHECK (target_amount >= 0),
      responsible_officer TEXT,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PLANNING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_finance_projects_status ON finance_projects(status);
    CREATE INDEX IF NOT EXISTS idx_finance_projects_fund ON finance_projects(fund_id);

    CREATE TABLE IF NOT EXISTS finance_budgets (
      budget_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER,
      scope TEXT NOT NULL DEFAULT 'ANNUAL' CHECK (scope IN ('ANNUAL','MONTHLY')),
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','CLOSED')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (month IS NULL OR (month BETWEEN 1 AND 12))
    );
    CREATE INDEX IF NOT EXISTS idx_finance_budgets_year ON finance_budgets(year, month);

    CREATE TABLE IF NOT EXISTS finance_budget_lines (
      line_id INTEGER PRIMARY KEY,
      budget_id INTEGER NOT NULL REFERENCES finance_budgets(budget_id) ON DELETE CASCADE,
      line_type TEXT NOT NULL CHECK (line_type IN ('INCOME','EXPENSE')),
      category TEXT NOT NULL,
      account_id INTEGER REFERENCES accounts(account_id),
      fund_id INTEGER REFERENCES funds(fund_id),
      amount REAL NOT NULL CHECK (amount >= 0),
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_finance_budget_lines_budget ON finance_budget_lines(budget_id);
  `);
  seedDefaultAccounts(db);
}

function addColumnIfMissing(db, table, col, ddl) {
  const exists = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, col);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function seedDefaultAccounts(db) {
  const insert = db.prepare(`
    INSERT INTO accounts (code, name, account_type, normal_balance, is_system)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(code) DO NOTHING`);
  const tx = db.transaction(() => {
    for (const row of DEFAULT_ACCOUNTS) insert.run(...row);
  });
  tx();
}

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

function postJournal(db, params) {
  const lines = params.lines || [];
  if (!lines.length) throw new Error('Journal entry requires at least one line.');
  const debit = roundMoney(lines.reduce((sum, line) => sum + Number(line.debit || 0), 0));
  const credit = roundMoney(lines.reduce((sum, line) => sum + Number(line.credit || 0), 0));
  if (debit <= 0 || credit <= 0 || debit !== credit) {
    throw new Error(`Unbalanced journal entry: debits ${debit} != credits ${credit}.`);
  }

  const date = normalizeDate(params.date);
  const period = ensurePeriod(db, date);
  if (period.status === 'LOCKED') throw new Error('This financial period is locked.');
  const accountByCode = resolveAccounts(db, lines.map((line) => line.accountCode));
  const entryNo = nextJournalNo(db, date.slice(0, 4));

  const tx = db.transaction(() => {
    const entry = db.prepare(`
      INSERT INTO journal_entries (entry_no, entry_date, memo, source_type, source_id, period_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      entryNo,
      date,
      params.memo || null,
      params.sourceType || 'OTHER',
      params.sourceId == null ? null : String(params.sourceId),
      period.period_id,
      params.createdBy || null
    );
    const insertLine = db.prepare(`
      INSERT INTO journal_lines (entry_id, account_id, fund_id, debit, credit, memo)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const line of lines) {
      insertLine.run(
        entry.lastInsertRowid,
        accountByCode.get(line.accountCode).account_id,
        line.fundId || null,
        Number(line.debit || 0),
        Number(line.credit || 0),
        line.memo || null
      );
    }
    return entry.lastInsertRowid;
  });
  return tx();
}

function postCashIncome(db, opts) {
  return postJournal(db, {
    date: opts.date,
    memo: opts.memo,
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    createdBy: opts.createdBy,
    lines: [
      { accountCode: ACC.CASH, debit: opts.amount, fundId: opts.fundId },
      { accountCode: opts.incomeAccount || incomeAccountFor(opts.category), credit: opts.amount, fundId: opts.fundId },
    ],
  });
}

function postExpensePayment(db, opts) {
  return postJournal(db, {
    date: opts.date,
    memo: opts.memo,
    sourceType: 'EXPENSE',
    sourceId: opts.sourceId,
    createdBy: opts.createdBy,
    lines: [
      { accountCode: opts.expenseAccount || expenseAccountFor(opts.category), debit: opts.amount, fundId: opts.fundId },
      { accountCode: ACC.CASH, credit: opts.amount, fundId: opts.fundId },
    ],
  });
}

function reverseJournal(db, entryId, reason, createdBy) {
  const original = db.prepare(`SELECT * FROM journal_entries WHERE entry_id=?`).get(entryId);
  if (!original) throw new Error('Journal entry not found.');
  if (original.status === 'REVERSED') throw new Error('Entry already reversed.');
  const lines = db.prepare(`SELECT * FROM journal_lines WHERE entry_id=? ORDER BY line_id`).all(entryId);
  const reversalId = postJournal(db, {
    date: new Date().toISOString().slice(0, 10),
    memo: `Reversal of ${original.entry_no}: ${reason || 'No reason provided'}`,
    sourceType: original.source_type,
    sourceId: original.source_id,
    createdBy,
    lines: lines.map((line) => ({
      accountCode: db.prepare(`SELECT code FROM accounts WHERE account_id=?`).get(line.account_id).code,
      fundId: line.fund_id,
      debit: line.credit,
      credit: line.debit,
      memo: line.memo ? `Reversal: ${line.memo}` : 'Reversal',
    })),
  });
  db.prepare(`UPDATE journal_entries SET status='REVERSED' WHERE entry_id=?`).run(entryId);
  db.prepare(`UPDATE journal_entries SET reverses_id=? WHERE entry_id=?`).run(entryId, reversalId);
  return reversalId;
}

function fundBalance(db, fundId) {
  const fund = db.prepare(`SELECT opening_balance FROM funds WHERE fund_id=?`).get(fundId);
  if (!fund) return 0;
  const rows = db.prepare(`
    SELECT a.account_type, jl.debit, jl.credit
    FROM journal_lines jl
    JOIN accounts a USING(account_id)
    JOIN journal_entries je USING(entry_id)
    WHERE jl.fund_id=? AND je.status IN ('POSTED','REVERSED')`).all(fundId);
  return roundMoney(rows.reduce((balance, row) => {
    if (row.account_type === 'INCOME') return balance + Number(row.credit) - Number(row.debit);
    if (row.account_type === 'EXPENSE') return balance - Number(row.debit) + Number(row.credit);
    return balance;
  }, Number(fund.opening_balance || 0)));
}

function fundRaisedSpent(db, fundId) {
  const row = db.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN a.account_type='INCOME' THEN jl.credit - jl.debit ELSE 0 END), 2) raised,
      ROUND(SUM(CASE WHEN a.account_type='EXPENSE' THEN jl.debit - jl.credit ELSE 0 END), 2) spent
    FROM journal_lines jl
    JOIN accounts a USING(account_id)
    JOIN journal_entries je USING(entry_id)
    WHERE jl.fund_id=? AND je.status IN ('POSTED','REVERSED')`).get(fundId);
  return {
    raised: roundMoney(row && row.raised),
    spent: roundMoney(row && row.spent),
  };
}

function ensurePeriod(db, date) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  let period = db.prepare(`SELECT * FROM financial_periods WHERE year=? AND month=?`).get(year, month);
  if (!period) {
    db.prepare(`INSERT INTO financial_periods (year, month) VALUES (?, ?)`).run(year, month);
    period = db.prepare(`SELECT * FROM financial_periods WHERE year=? AND month=?`).get(year, month);
  }
  return period;
}

function resolveAccounts(db, codes) {
  const unique = [...new Set(codes)];
  const rows = db.prepare(
    `SELECT * FROM accounts WHERE code IN (${unique.map(() => '?').join(',')}) AND active=1`
  ).all(...unique);
  const byCode = new Map(rows.map((row) => [row.code, row]));
  for (const code of unique) {
    if (!byCode.has(code)) throw new Error(`Chart of accounts missing account code ${code}.`);
  }
  return byCode;
}

function nextJournalNo(db, year) {
  const prefix = `JV-${year}-`;
  const row = db.prepare(`SELECT entry_no FROM journal_entries WHERE entry_no LIKE ? ORDER BY entry_no DESC LIMIT 1`).get(`${prefix}%`);
  const next = row ? Number(String(row.entry_no).slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(6, '0')}`;
}

function normalizeDate(value) {
  const s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Journal date must be YYYY-MM-DD.');
  return s;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  ACC,
  DEFAULT_ACCOUNTS,
  ensureLedgerSchema,
  seedDefaultAccounts,
  incomeAccountFor,
  expenseAccountFor,
  postJournal,
  postCashIncome,
  postExpensePayment,
  reverseJournal,
  fundBalance,
  fundRaisedSpent,
};
