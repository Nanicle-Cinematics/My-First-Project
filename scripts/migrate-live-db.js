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

    CREATE TABLE IF NOT EXISTS email_settings (
      setting_id           INTEGER PRIMARY KEY CHECK (setting_id = 1),
      provider             TEXT NOT NULL DEFAULT 'smtp' CHECK (provider IN ('smtp', 'resend')),
      sender_name          TEXT NOT NULL DEFAULT '',
      sender_email         TEXT NOT NULL DEFAULT '',
      reply_to_email       TEXT NOT NULL DEFAULT '',
      test_recipient_email TEXT NOT NULL DEFAULT '',
      created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_logs (
      email_log_id   INTEGER PRIMARY KEY,
      occurred_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      recipient      TEXT NOT NULL,
      subject        TEXT NOT NULL,
      status         TEXT NOT NULL,
      sent_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      error_message  TEXT,
      provider       TEXT,
      sender_name    TEXT,
      sender_email   TEXT,
      reply_to_email TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_logs_recent
      ON email_logs(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_logs_status
      ON email_logs(status);

    INSERT OR IGNORE INTO email_settings
      (setting_id, provider, sender_name, sender_email, reply_to_email, test_recipient_email)
    VALUES (1, 'smtp', '', '', '', '');
  `);

  console.log(`✓ Live DB migrations applied successfully: ${dbPath}`);
} catch (error) {
  console.error(`✗ Live DB migration failed for ${dbPath}`);
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
