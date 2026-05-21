#!/usr/bin/env bash
# Operator helper for an existing church installation.
# Usage:  ./deploy/manage.sh <slug> <command> [args...]
set -euo pipefail

cd "$(dirname "$0")/.."

usage() {
  cat <<EOF
Usage: $0 <slug> <command>

Where <slug> matches a folder under deploys/ (e.g. dunwell-methodist).

Commands:
  list                  List all configured churches
  status                Show machine status
  logs                  Stream live logs (Ctrl+C to exit)
  open                  Open the church URL in your browser
  redeploy              Ship the current code to this church
  backup                Download a copy of the database to ./backups/
  restore <file>        Upload a .db file to replace the running DB
  ssh                   Open an SSH shell into the machine
  scale-up              Add 1 always-on machine (no cold-start delays)
  scale-down            Set machines to 0 (cold-start on first request)
  secrets-list          List current secret names (values are hidden)
  set-secret KEY=VAL    Update one secret (triggers a redeploy)
  destroy               PERMANENTLY delete the app, volume, and data

Examples:
  $0 list
  $0 grace-methodist logs
  $0 grace-methodist set-secret ARKESEL_API_KEY=ak-xxxx
  $0 grace-methodist backup
EOF
  exit 1
}

if [ "${1:-}" = "list" ] || [ -z "${1:-}" ]; then
  echo "Configured churches:"
  if [ -d deploys ]; then
    for d in deploys/*/; do
      [ -d "$d" ] || continue
      slug=$(basename "$d")
      if [ -f "$d/tenant-info.txt" ]; then
        url=$(grep '^url:' "$d/tenant-info.txt" | cut -d' ' -f2-)
        name=$(grep '^church_name:' "$d/tenant-info.txt" | cut -d' ' -f2-)
        printf "  %-30s %-40s %s\n" "$slug" "$name" "$url"
      else
        printf "  %s (no tenant-info.txt)\n" "$slug"
      fi
    done
  else
    echo "  (no deploys/ directory yet — run ./deploy/new-church.sh)"
  fi
  exit 0
fi

SLUG="${1:-}"; CMD="${2:-}"; shift 2 2>/dev/null || true
[ -z "$SLUG" ] || [ -z "$CMD" ] && usage

TENANT_DIR="deploys/$SLUG"
TOML="$TENANT_DIR/fly.toml"
[ -f "$TOML" ] || { echo "No deployment found for '$SLUG'. Run: ./deploy/new-church.sh"; exit 1; }
APP="$SLUG"

case "$CMD" in
  status)        flyctl status -a "$APP" ;;
  logs)          flyctl logs -a "$APP" ;;
  open)          flyctl open -a "$APP" ;;
  redeploy)      flyctl deploy -c "$TOML" -a "$APP" ;;
  ssh)           flyctl ssh console -a "$APP" ;;
  scale-up)      flyctl scale count 1 --max-per-region 1 -a "$APP" ;;
  scale-down)    flyctl scale count 0 -a "$APP" ;;
  secrets-list)  flyctl secrets list -a "$APP" ;;
  set-secret)
    [ -n "${1:-}" ] || { echo "Usage: $0 $SLUG set-secret KEY=VALUE"; exit 1; }
    flyctl secrets set "$@" -a "$APP"
    ;;
  backup)
    mkdir -p backups
    stamp=$(date -u +"%Y%m%dT%H%M%SZ")
    out="backups/${SLUG}-${stamp}.db"
    echo "Downloading /data/church.db -> $out"
    flyctl ssh sftp get /data/church.db "$out" -a "$APP"
    echo "✓ Saved $out ($(du -h "$out" | cut -f1))"
    ;;
  restore)
    [ -f "${1:-}" ] || { echo "Restore file not found: ${1:-(missing)}"; exit 1; }
    src="$1"
    echo "About to upload $src to $APP and overwrite /data/church.db."
    read -rp "Are you SURE? (type 'yes'): " confirm
    [ "$confirm" = "yes" ] || { echo "Cancelled."; exit 0; }
    flyctl ssh sftp shell -a "$APP" <<EOF
put $src /data/church.db
EOF
    flyctl machine restart -a "$APP" --yes
    echo "✓ Restored from $src and restarted the machine."
    ;;
  destroy)
    echo "⚠  This will permanently delete the Fly app '$APP', its volume, and ALL data."
    echo "   Local config in $TENANT_DIR/ will be moved to $TENANT_DIR.destroyed-$(date -u +%Y%m%dT%H%M%SZ)/."
    read -rp "Type the slug ($SLUG) to confirm: " confirm
    [ "$confirm" = "$SLUG" ] || { echo "Cancelled."; exit 0; }
    flyctl apps destroy "$APP" --yes
    mv "$TENANT_DIR" "${TENANT_DIR}.destroyed-$(date -u +%Y%m%dT%H%M%SZ)"
    echo "✓ App and config removed."
    ;;
  *) usage ;;
esac
