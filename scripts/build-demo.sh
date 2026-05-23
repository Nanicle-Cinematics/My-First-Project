#!/usr/bin/env bash
# Build demo.db — a SQLite database loaded with realistic Ghanaian sample
# data, used for marketing screenshots / demos / sales walkthroughs.
#
# It is COMPLETELY SEPARATE from church.db (your real data is not touched).
#
# Usage:
#   ./scripts/build-demo.sh                   # builds demo.db in repo root
#   CHURCH_DB=demo.db npm start               # run the app pointing at it
#   open http://localhost:3000                # screenshot away
set -euo pipefail
cd "$(dirname "$0")/.."

DB_FILE="demo.db"
DATA_FILE="scripts/demo-data-ghana.sql"

command -v sqlite3 >/dev/null 2>&1 || {
  echo "✗ sqlite3 is required. On macOS:  brew install sqlite3"
  exit 1
}

echo "→ Removing any existing $DB_FILE..."
rm -f "$DB_FILE"

echo "→ Loading schema..."
sqlite3 "$DB_FILE" < schema.sql

echo "→ Loading Ghanaian demo data..."
sqlite3 "$DB_FILE" < "$DATA_FILE"

ROWS=$(sqlite3 "$DB_FILE" "SELECT 'members='||COUNT(*) FROM members;")
ROWS2=$(sqlite3 "$DB_FILE" "SELECT 'tithes_GHC='||ROUND(COALESCE(SUM(amount),0),2) FROM contributions WHERE fund_id=2;")
ROWS3=$(sqlite3 "$DB_FILE" "SELECT 'pledges='||COUNT(*) FROM pledges;")

cat <<EOF

✓ $DB_FILE ready ($(du -h "$DB_FILE" | cut -f1)) — $ROWS, $ROWS2, $ROWS3

Next steps:

  1. Run the app pointed at the demo database:

       CHURCH_DB=$DB_FILE npm start

  2. Open http://localhost:3000 in your browser.
     First visit will redirect to /setup — create an admin account
     (you can use any email/password since this is just for screenshots).

  3. Take screenshots of:
     • Dashboard (stats cards, recent activity)
     • Members list (shows Ghanaian names)
     • A member's profile page
     • Finance → Contributions (tithe history)
     • Finance → Reports → Day-born offering crosstab
     • Harvest → End-of-Year Harvest 2025 (pledge tracker)
     • Communications (compose screen)

  4. Save screenshots into marketing/images/ and we'll wire them
     into the landing page hero / features.

When you're done screenshotting, delete the demo database:

       rm $DB_FILE

EOF
