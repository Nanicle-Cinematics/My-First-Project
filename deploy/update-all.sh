#!/usr/bin/env bash
# Redeploy the current code to every provisioned church in deploys/.
# Run from the project root:  ./deploy/update-all.sh
#
# Options:
#   --dry-run          Print what would be done without deploying
#   --skip <slug>      Skip a specific church (repeat to skip multiple)
#   --only <slug>      Deploy to one church only (repeat to target multiple)
set -euo pipefail

cd "$(dirname "$0")/.."

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }

DRY_RUN=false
SKIP=()
ONLY=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --skip)    SKIP+=("$2"); shift 2 ;;
    --only)    ONLY+=("$2"); shift 2 ;;
    *) red "Unknown option: $1"; exit 1 ;;
  esac
done

if [ ! -d deploys ]; then
  yellow "No deploys/ directory found — nothing to update."
  exit 0
fi

# Collect slugs from deploys/ (each sub-dir with a fly.toml is a live church)
SLUGS=()
for d in deploys/*/; do
  [ -d "$d" ] || continue
  slug=$(basename "$d")
  [[ "$slug" == *.destroyed-* ]] && continue
  [ -f "$d/fly.toml" ] || continue
  SLUGS+=("$slug")
done

if [ ${#SLUGS[@]} -eq 0 ]; then
  yellow "No church deployments found in deploys/ — run ./deploy/new-church.sh first."
  exit 0
fi

# Apply --only filter
if [ ${#ONLY[@]} -gt 0 ]; then
  FILTERED=()
  for slug in "${SLUGS[@]}"; do
    for target in "${ONLY[@]}"; do
      [ "$slug" = "$target" ] && { FILTERED+=("$slug"); break; }
    done
  done
  SLUGS=("${FILTERED[@]}")
fi

# Apply --skip filter
if [ ${#SKIP[@]} -gt 0 ]; then
  FILTERED=()
  for slug in "${SLUGS[@]}"; do
    skip_this=false
    for s in "${SKIP[@]}"; do
      [ "$slug" = "$s" ] && { skip_this=true; break; }
    done
    $skip_this || FILTERED+=("$slug")
  done
  SLUGS=("${FILTERED[@]}")
fi

if [ ${#SLUGS[@]} -eq 0 ]; then
  yellow "No churches match the requested filters — nothing to do."
  exit 0
fi

echo ""
cyan "================================================================"
cyan "  Church Manager — fleet update"
cyan "================================================================"
echo "  Targets: ${#SLUGS[@]} church(es)"
echo "  Dry-run: $DRY_RUN"
echo ""

PASS=()
FAIL=()

for slug in "${SLUGS[@]}"; do
  TOML="deploys/$slug/fly.toml"
  name="$slug"
  if [ -f "deploys/$slug/tenant-info.txt" ]; then
    name=$(grep '^church_name:' "deploys/$slug/tenant-info.txt" 2>/dev/null | cut -d' ' -f2- || echo "$slug")
  fi

  if $DRY_RUN; then
    yellow "  [dry-run] Would deploy to: $slug ($name)"
    PASS+=("$slug")
    continue
  fi

  printf "  Deploying %-30s (%s)..." "$slug" "$name"
  if flyctl deploy -c "$TOML" -a "$slug" --remote-only \
       --no-cache=false 2>"/tmp/church-deploy-${slug}.log"; then
    green " ✓"
    PASS+=("$slug")
  else
    red " ✗ (see /tmp/church-deploy-${slug}.log)"
    FAIL+=("$slug")
  fi
done

echo ""
cyan "================================================================"
echo "  Results"
cyan "================================================================"
echo "  ✓ Deployed:  ${#PASS[@]}"
echo "  ✗ Failed:    ${#FAIL[@]}"

if [ ${#FAIL[@]} -gt 0 ]; then
  echo ""
  red "Failed deployments:"
  for slug in "${FAIL[@]}"; do
    red "  - $slug"
    echo "    Log: /tmp/church-deploy-${slug}.log"
  done
  exit 1
fi

echo ""
green "All churches updated successfully."
