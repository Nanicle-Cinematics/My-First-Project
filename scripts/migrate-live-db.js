'use strict';

// Non-interactive SQLite migration helper for production-like databases.
// Usage:
//   CHURCH_DB=/data/church.db node scripts/migrate-live-db.js
// or:
//   node scripts/migrate-live-db.js /path/to/church.db

const Database = require('better-sqlite3');

const dbPath = process.argv[2] || process.env.CHURCH_DB || './church.db';
const db = new Database(dbPath);

function run(sql) {
  db.exec(sql);
}

try {
  run(`
    CREATE TABLE IF NOT EXISTS inventory_categories (
      category_id  INTEGER PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_categories_active
      ON inventory_categories(deleted_at);

    CREATE TABLE IF NOT EXISTS security_audit_log (
      audit_id    INTEGER PRIMARY KEY,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor_id    INTEGER REFERENCES users(user_id),
      event       TEXT NOT NULL,
      subject     TEXT,
      ip          TEXT,
      user_agent  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_security_audit_recent
      ON security_audit_log(occurred_at DESC);
  `);

  console.log(`✓ Live DB migrations applied successfully: ${dbPath}`);
} catch (error) {
  console.error(`✗ Live DB migration failed for ${dbPath}`);
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
