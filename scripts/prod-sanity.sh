#!/usr/bin/env bash
set -euo pipefail

# Production sanity checks for public runtime endpoints.
# Usage:
#   ./scripts/prod-sanity.sh https://church-management-system.fly.dev

BASE_URL="${1:-https://church-management-system.fly.dev}"
BASE_URL="${BASE_URL%/}"

check() {
  local path="$1"
  echo "==> Checking ${BASE_URL}${path}"
  curl -fsS -o /dev/null "${BASE_URL}${path}"
}

check /healthz
check /readyz

echo "✓ Production sanity checks passed for ${BASE_URL}"
