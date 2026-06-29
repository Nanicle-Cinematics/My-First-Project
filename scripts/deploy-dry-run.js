'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const dbPath = process.env.CHURCH_DB || path.join(root, 'church.db');
const backupDir = process.env.BACKUP_DIR || path.join(root, 'backups');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}

check('SESSION_SECRET', !!process.env.SESSION_SECRET,
  process.env.SESSION_SECRET ? 'set' : 'missing; required for production logins');
check('Database file', fs.existsSync(dbPath), dbPath);
check('Backup directory', fs.existsSync(backupDir), backupDir);
check('Node version', Number(process.versions.node.split('.')[0]) >= 20, process.version);

let db;
try {
  db = new Database(dbPath, { readonly: true });
  db.prepare('SELECT 1').get();
  check('Database opens readonly', true, 'SELECT 1 succeeded');

  const requiredTables = [
    'members', 'users', 'events', 'attendance', 'announcements',
    'funds', 'accounts', 'journal_entries', 'journal_lines',
    'finance_projects', 'finance_budgets', 'payment_vouchers',
    'activity_log', 'security_audit_log',
  ];
  const found = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((row) => row.name));
  const missing = requiredTables.filter((name) => !found.has(name));
  check('Required tables', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${requiredTables.length} tables present`);

  const users = db.prepare(`SELECT COUNT(*) count FROM users WHERE deleted_at IS NULL`).get().count;
  check('Active user account', users > 0, `${users} active user${users === 1 ? '' : 's'}`);

  const unbalanced = db.prepare(`
    SELECT COUNT(*) count
    FROM (
      SELECT je.entry_id
      FROM journal_entries je
      JOIN journal_lines jl USING(entry_id)
      GROUP BY je.entry_id
      HAVING ROUND(SUM(jl.debit), 2) != ROUND(SUM(jl.credit), 2)
    )`).get().count;
  check('Balanced journals', unbalanced === 0, unbalanced ? `${unbalanced} unbalanced journal(s)` : 'all journal entries balance');
} catch (err) {
  check('Database opens readonly', false, err.message);
} finally {
  if (db) db.close();
}

const failures = checks.filter((row) => !row.ok);
for (const row of checks) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}: ${row.detail}`);
}
if (failures.length) {
  console.error(`\nDeploy dry-run failed: ${failures.length} check(s) need attention.`);
  process.exit(1);
}
console.log('\nDeploy dry-run passed.');
