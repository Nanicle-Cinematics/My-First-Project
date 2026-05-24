#!/usr/bin/env bash
# Build (or rebuild) the church.db SQLite database from schema + seed data.
set -euo pipefail

DB_FILE="${1:-church.db}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required but not installed." >&2
  exit 1
fi

rm -f "$DB_FILE"
sqlite3 "$DB_FILE" < schema.sql
sqlite3 "$DB_FILE" < seed.sql

echo "Built $DB_FILE"
echo "Try:   sqlite3 $DB_FILE < queries.sql"
