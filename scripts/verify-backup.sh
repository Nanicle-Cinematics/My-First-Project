#!/usr/bin/env bash
set -euo pipefail

# Verify a SQLite backup file can be opened and queried.
# Usage:
#   ./scripts/verify-backup.sh backups/<file>.db

BACKUP_FILE="${1:-}"
[ -n "$BACKUP_FILE" ] || { echo "Usage: $0 backups/<file>.db"; exit 1; }
[ -f "$BACKUP_FILE" ] || { echo "Backup not found: $BACKUP_FILE"; exit 1; }

node -e "
const Database=require('better-sqlite3');
const file=process.argv[1];
const db=new Database(file, { readonly:true });
const integrityRow=db.prepare('PRAGMA integrity_check').get();
const integrity=integrityRow && Object.values(integrityRow)[0];
if (integrity !== 'ok') {
  throw new Error('SQLite integrity_check returned: ' + (integrity || 'unknown'));
}
const required=['members','users','events','inventory_items'];
const placeholders=required.map(() => '?').join(',');
const found=new Set(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name IN (' + placeholders + ')').all('table', ...required).map((r) => r.name));
const missing=required.filter((name) => !found.has(name));
if (missing.length) {
  throw new Error('Missing expected table(s): ' + missing.join(', '));
}
const row=db.prepare('SELECT COUNT(*) AS c FROM sqlite_master WHERE type = ?').get('table');
console.log('✓ Backup verified:', file, '- tables:', row.c, '- integrity:', integrity);
db.close();
" "$BACKUP_FILE"
