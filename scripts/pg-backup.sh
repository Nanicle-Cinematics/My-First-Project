#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/church-manager-$stamp.dump"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT
# Strip Prisma-only pool params (pg_dump rejects them as invalid URI query
# parameters), then apply the same sslmode=verify-full policy the app uses,
# via lib/database-url.js so the rule lives in exactly one place. Doing it
# here means the script is correct however it is invoked -- the Fly container
# passes an already-normalized DATABASE_URL, but CI passes the raw secret.
#
# verify-full requires a CA bundle, and libpq does NOT use Node's bundled
# certificates: it reads ~/.postgresql/root.crt unless PGSSLROOTCERT points
# elsewhere. Callers must set PGSSLROOTCERT (fly.toml sets it for the
# container; the backup workflow sets it for the runner) or pg_dump fails
# with: root certificate file "/root/.postgresql/root.crt" does not exist
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_URL="$(SCRIPT_DIR="$SCRIPT_DIR" node -e '
  const { normalizePostgresSslMode } = require(process.env.SCRIPT_DIR + "/../lib/database-url");
  const u = new URL(process.env.DATABASE_URL);
  for (const key of ["connection_limit", "pool_timeout", "pgbouncer"]) u.searchParams.delete(key);
  process.stdout.write(normalizePostgresSslMode(u.toString()));
')"

pg_dump "$PG_URL" --format=custom --no-owner --no-acl --file="$partial"
mv "$partial" "$file"
pg_restore --list "$file" >/dev/null
sha256sum "$file" >"$file.sha256"

if [ -n "${BACKUP_UPLOAD_URL:-}" ]; then
  curl --fail --retry 3 --upload-file "$file" "${BACKUP_UPLOAD_URL%/}/$(basename "$file")"
  curl --fail --retry 3 --upload-file "$file.sha256" "${BACKUP_UPLOAD_URL%/}/$(basename "$file.sha256")"
fi

find "$BACKUP_DIR" -type f \( -name '*.dump' -o -name '*.sha256' \) -mtime "+$BACKUP_KEEP_DAYS" -delete
echo "verified_backup=$file"
