#!/usr/bin/env bash
# Provision a new church installation on Fly.io.
# Run from the project root:  ./deploy/new-church.sh
set -euo pipefail

cd "$(dirname "$0")/.."
TEMPLATE="$(pwd)/deploy/fly.toml.template"
DEPLOYS_DIR="$(pwd)/deploys"
mkdir -p "$DEPLOYS_DIR"

# ---- Tiny helpers ----
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
cyan()   { printf "\033[36m%s\033[0m\n" "$1"; }
prompt() {
  local label="$1" default="${2:-}" var
  if [ -n "$default" ]; then read -rp "$label [$default]: " var; var="${var:-$default}"
  else read -rp "$label: " var; fi
  echo "$var"
}
secret_prompt() {
  local label="$1" var
  read -rsp "$label (input hidden, Enter to skip): " var; echo
  echo "$var"
}
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { red "Missing required command: $1"; exit 1; }
}

require_cmd flyctl
require_cmd openssl

if ! flyctl auth whoami >/dev/null 2>&1; then
  red "You are not logged in to Fly. Run: flyctl auth login"; exit 1
fi

cat <<'BANNER'
================================================================
  Church Manager — new installation wizard
================================================================
Sets up a brand-new Fly.io deployment for one church. You'll be
asked for the church details, then the script provisions the app,
the persistent disk, the SMS / email secrets, and ships the code.

Press Enter to accept the default in [brackets]. Ctrl-C to abort.

BANNER

SLUG=$(prompt "Church slug (lowercase, hyphens — becomes the URL prefix, e.g. 'grace-methodist')")
[[ "$SLUG" =~ ^[a-z][a-z0-9-]{2,29}$ ]] || { red "Slug must be 3-30 chars: lowercase letters, digits, hyphens, starting with a letter."; exit 1; }

CHURCH_NAME=$(prompt "Church display name (e.g. 'Grace Methodist Church')")
REGION=$(prompt "Fly region (lhr=London, jnb=Johannesburg, iad=Virginia, fra=Frankfurt, cdg=Paris)" "lhr")
MEMORY=$(prompt "VM memory" "512mb")
SENDER=$(prompt "Arkesel sender ID (max 11 chars, alphanumeric, e.g. 'GRACE')" "$(echo "$CHURCH_NAME" | tr -dc 'A-Za-z' | head -c 11 | tr a-z A-Z)")

echo
yellow "─── SMS provider (Arkesel) ───"
ARKESEL_API_KEY=$(secret_prompt "Arkesel API key")

echo
yellow "─── Email provider (Gmail SMTP) ───"
SMTP_USER=$(prompt "Gmail address (or Enter to skip)" "")
if [ -n "$SMTP_USER" ]; then
  SMTP_PASS=$(secret_prompt "Gmail App Password (16 chars, NOT your normal password)")
  SMTP_FROM=$(prompt "From: header" "$CHURCH_NAME <$SMTP_USER>")
fi

APP_NAME="$SLUG"
PUBLIC_URL="https://${APP_NAME}.fly.dev"
SESSION_SECRET="$(openssl rand -hex 32)"

cat <<EOF

================================================================
  Summary — about to provision:
================================================================
  Church name:    $CHURCH_NAME
  Fly app:        $APP_NAME
  URL:            $PUBLIC_URL
  Region:         $REGION
  VM memory:      $MEMORY
  SMS sender:     $SENDER
  SMS configured: $([ -n "$ARKESEL_API_KEY" ] && echo yes || echo "no (dry-run)")
  SMTP user:      ${SMTP_USER:-(skipped, dry-run)}
  Config saved:   deploys/$SLUG/fly.toml
EOF

CONFIRM=$(prompt "Proceed? (yes/no)" "no")
[ "$CONFIRM" = "yes" ] || { yellow "Cancelled. Nothing was created."; exit 0; }

# ---- 1. Render the per-tenant fly.toml ----
mkdir -p "$DEPLOYS_DIR/$SLUG"
TARGET="$DEPLOYS_DIR/$SLUG/fly.toml"
sed -e "s|__APP_NAME__|$APP_NAME|g" \
    -e "s|__REGION__|$REGION|g" \
    -e "s|__MEMORY__|$MEMORY|g" \
    "$TEMPLATE" > "$TARGET"
cyan "✓ Wrote $TARGET"

# Symlink so flyctl picks it up when run from the project root with -c
ln -sf "$TARGET" "$DEPLOYS_DIR/$SLUG/.flyctl.toml" 2>/dev/null || true

# ---- 2. Create the Fly app ----
if flyctl apps list --json 2>/dev/null | grep -q "\"Name\":\"$APP_NAME\""; then
  yellow "App $APP_NAME already exists on Fly — skipping create."
else
  cyan "Creating Fly app $APP_NAME..."
  flyctl apps create "$APP_NAME" --org personal || { red "App creation failed"; exit 1; }
fi

# ---- 3. Create the volume ----
if flyctl volumes list -a "$APP_NAME" 2>/dev/null | grep -q "church_data"; then
  yellow "Volume church_data already exists for $APP_NAME — skipping create."
else
  cyan "Creating 1GB volume church_data in $REGION..."
  flyctl volumes create church_data --size 1 --region "$REGION" --yes -a "$APP_NAME"
fi

# ---- 4. Set secrets ----
cyan "Setting secrets..."
SECRETS=(
  "SESSION_SECRET=$SESSION_SECRET"
  "CHURCH_NAME=$CHURCH_NAME"
  "PUBLIC_URL=$PUBLIC_URL"
  "ARKESEL_SENDER=$SENDER"
)
[ -n "$ARKESEL_API_KEY" ] && SECRETS+=("ARKESEL_API_KEY=$ARKESEL_API_KEY")
if [ -n "$SMTP_USER" ]; then
  SECRETS+=("SMTP_HOST=smtp.gmail.com" "SMTP_PORT=465" "SMTP_USER=$SMTP_USER" "SMTP_PASS=$SMTP_PASS" "SMTP_FROM=$SMTP_FROM")
fi
flyctl secrets set --stage "${SECRETS[@]}" -a "$APP_NAME" >/dev/null

# ---- 5. Deploy ----
cyan "Deploying $APP_NAME (this takes ~2-3 min)..."
flyctl deploy -c "$TARGET" -a "$APP_NAME"

# ---- 6. Save a tiny tenant-info file we can grep later ----
INFO="$DEPLOYS_DIR/$SLUG/tenant-info.txt"
cat > "$INFO" <<EOF
slug:        $SLUG
church_name: $CHURCH_NAME
app_name:    $APP_NAME
region:      $REGION
url:         $PUBLIC_URL
sender:      $SENDER
smtp_user:   ${SMTP_USER:-}
created_at:  $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

green ""
green "================================================================"
green "  ✓ $CHURCH_NAME is live at $PUBLIC_URL"
green "================================================================"
cat <<EOF

  First-time login: open the URL — you'll be sent to /setup to
  create the initial admin account.

  Config saved in: deploys/$SLUG/
    - fly.toml          (Fly app config, re-used on every deploy)
    - tenant-info.txt   (quick reference card)

  Common operations for this church:
    ./deploy/manage.sh $SLUG status
    ./deploy/manage.sh $SLUG logs
    ./deploy/manage.sh $SLUG redeploy
    ./deploy/manage.sh $SLUG backup
    ./deploy/manage.sh $SLUG ssh
    ./deploy/manage.sh $SLUG destroy   # ⚠ permanent

  Add to your operator log:  ${SLUG} | ${CHURCH_NAME} | ${PUBLIC_URL}

EOF
