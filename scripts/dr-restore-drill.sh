#!/usr/bin/env bash
set -euo pipefail

# Dry-run restore drill for a downloaded SQLite backup file.
# - Copies backup into a throwaway path
# - Verifies schema can be read
# - Optionally runs a lightweight sanity query
#
# Usage:
#   ./scripts/dr-restore-drill.sh backups/<file>.db

BACKUP_FILE="${1:-}"
[ -n "$BACKUP_FILE" ] || { echo "Usage: $0 backups/<file>.db"; exit 1; }
[ -f "$BACKUP_FILE" ] || { echo "Backup not found: $BACKUP_FILE"; exit 1; }

TMP_RESTORE="/tmp/restore-drill-$(basename "$BACKUP_FILE" .db)-$$.db"
cp "$BACKUP_FILE" "$TMP_RESTORE"

echo "Running restore drill on: $TMP_RESTORE"
node -e "
const Database=require('better-sqlite3');
const db=new Database(process.argv[1], { readonly:true });
const integrityRow=db.prepare('PRAGMA integrity_check').get();
const integrity=integrityRow && Object.values(integrityRow)[0];
if (integrity !== 'ok') throw new Error('SQLite integrity_check returned: ' + (integrity || 'unknown'));
const tables=db.prepare(\"SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'\").get().c;
if (!tables || tables < 1) throw new Error('No tables found in restored backup');
const hasMembers=db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name='members'\").get();
console.log('✓ restore drill passed:', { tables, has_members: !!hasMembers, integrity });
db.close();
" "$TMP_RESTORE"

rm -f "$TMP_RESTORE"
echo "✓ Restore drill complete."
