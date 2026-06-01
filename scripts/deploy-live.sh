#!/usr/bin/env bash
set -euo pipefail

# Safe deploy helper:
# 1) tests
# 2) deploy
# 3) health/readiness checks
# 4) tail logs briefly
#
# Usage:
#   ./scripts/deploy-live.sh [app-name] [base-url]
# Example:
#   ./scripts/deploy-live.sh church-management-system https://church-management-system.fly.dev

APP="${1:-church-management-system}"
BASE_URL="${2:-https://${APP}.fly.dev}"

echo "==> Running test suite"
npm test

echo "==> Capturing pre-deploy image reference"
PREV_IMAGE="$(flyctl machine list -a "$APP" --json | node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); console.log((d[0]&&d[0].image_ref)||'unknown');")"
echo "Previous image: ${PREV_IMAGE}"

echo "==> Deploying $APP"
flyctl deploy -a "$APP"

echo "==> Verifying health endpoints"
curl -fsS "${BASE_URL}/healthz" >/dev/null
curl -fsS "${BASE_URL}/readyz" >/dev/null
echo "Health checks passed for ${BASE_URL}"

echo "==> Recent logs (last 30 lines)"
flyctl logs -a "$APP" --no-tail | tail -n 30

echo "✅ Deploy complete"
echo "Rollback hint:"
echo "  flyctl machine update <machine-id> -a ${APP} --image \"${PREV_IMAGE}\""
