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
const row=db.prepare('SELECT COUNT(*) AS c FROM sqlite_master WHERE type = ?').get('table');
if (!row || typeof row.c !== 'number' || row.c < 1) {
  throw new Error('No tables found in backup');
}
console.log('✓ Backup verified:', file, '- tables:', row.c);
db.close();
" "$BACKUP_FILE"
