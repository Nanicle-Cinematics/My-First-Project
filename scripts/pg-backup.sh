#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/church-manager-$stamp.dump"

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file="$file"
pg_restore --list "$file" >/dev/null
sha256sum "$file" >"$file.sha256"

if [ -n "${BACKUP_UPLOAD_URL:-}" ]; then
  curl --fail --retry 3 --upload-file "$file" "${BACKUP_UPLOAD_URL%/}/$(basename "$file")"
  curl --fail --retry 3 --upload-file "$file.sha256" "${BACKUP_UPLOAD_URL%/}/$(basename "$file.sha256")"
fi

find "$BACKUP_DIR" -type f \( -name '*.dump' -o -name '*.sha256' \) -mtime "+$BACKUP_KEEP_DAYS" -delete
echo "verified_backup=$file"
