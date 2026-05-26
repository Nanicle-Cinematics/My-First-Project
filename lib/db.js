'use strict';
// Database bootstrap: resolve the path, apply any staged restore BEFORE opening,
// auto-create from schema.sql on first boot (guarded in production), then open
// the single shared connection.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.CHURCH_DB || path.join(__dirname, '..', 'church.db');
const RESTORE_PENDING = DB_PATH + '.restore-pending';

// Apply a staged restore (if any) BEFORE the DB is opened. Restores are staged
// from the Backups UI and applied here at a clean startup so they can never
// corrupt a live connection. The current DB is copied aside first as a safety net.
if (fs.existsSync(RESTORE_PENDING)) {
  try {
    const fd = fs.openSync(RESTORE_PENDING, 'r');
    const hdr = Buffer.alloc(16);
    fs.readSync(fd, hdr, 0, 16, 0);
    fs.closeSync(fd);
    if (hdr.toString('latin1', 0, 15) !== 'SQLite format 3') throw new Error('staged file is not a SQLite database');
    if (fs.existsSync(DB_PATH)) {
      const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
      try { fs.copyFileSync(DB_PATH, `${DB_PATH}.pre-restore-${stamp}`); } catch (_) {}
      for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext); } catch (_) {} }
    }
    fs.renameSync(RESTORE_PENDING, DB_PATH);
    console.log('Applied staged database restore.');
  } catch (e) {
    console.error('Staged restore failed, ignoring:', e.message);
    try { fs.unlinkSync(RESTORE_PENDING); } catch (_) {}
  }
}

// Auto-create the DB from schema.sql on first boot (so deployments work without shell access).
// SAFETY: in production, refuse to silently create an empty DB unless ALLOW_DB_INIT=1 is set.
// This prevents a missing/unmounted volume from being papered over with a fresh empty schema,
// which would look like total data loss to the user.
if (!fs.existsSync(DB_PATH)) {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error(`Database not found at ${DB_PATH} and schema.sql is missing.`);
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DB_INIT !== '1') {
    console.error(
      `\nREFUSING TO START: no database at ${DB_PATH}.\n` +
      `\nThis is production (NODE_ENV=production) and a missing DB usually means\n` +
      `the volume isn't mounted — not that you actually want a fresh empty schema.\n` +
      `\nIf you really do want to initialize a brand-new database here, set the\n` +
      `secret ALLOW_DB_INIT=1, redeploy, then unset it once the DB exists:\n` +
      `\n  flyctl secrets set ALLOW_DB_INIT=1 -a <app>\n` +
      `  flyctl deploy -a <app>\n` +
      `  flyctl secrets unset ALLOW_DB_INIT -a <app>\n`
    );
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn(`ALLOW_DB_INIT=1 is set — creating a fresh DB at ${DB_PATH}. Unset this secret after first boot.`);
  }
  console.log(`No database at ${DB_PATH}; creating from schema.sql...`);
  const fresh = new Database(DB_PATH);
  fresh.exec(fs.readFileSync(schemaPath, 'utf8'));
  fresh.close();
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

module.exports = { db, DB_PATH, RESTORE_PENDING };
