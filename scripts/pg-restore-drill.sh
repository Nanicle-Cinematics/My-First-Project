#!/usr/bin/env bash
set -euo pipefail

: "${RESTORE_DRILL_DATABASE_URL:?RESTORE_DRILL_DATABASE_URL is required}"
: "${ALLOW_RESTORE_DRILL:?Set ALLOW_RESTORE_DRILL=1 after confirming the target is disposable}"
[ "$ALLOW_RESTORE_DRILL" = "1" ] || { echo "Refusing: ALLOW_RESTORE_DRILL must equal 1"; exit 1; }
[ "${DATABASE_URL:-}" != "$RESTORE_DRILL_DATABASE_URL" ] || { echo "Refusing to restore into DATABASE_URL"; exit 1; }
file="${1:?Usage: pg-restore-drill.sh backup.dump}"

pg_restore --list "$file" >/dev/null
psql "$RESTORE_DRILL_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
pg_restore "$RESTORE_DRILL_DATABASE_URL" --no-owner --no-acl --exit-on-error "$file"
tables="$(psql "$RESTORE_DRILL_DATABASE_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
[ "$tables" -gt 20 ] || { echo "Restore drill failed: only $tables tables"; exit 1; }
psql "$RESTORE_DRILL_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS churches FROM churches; SELECT count(*) AS users FROM users;'
echo "restore_drill=passed tables=$tables"
