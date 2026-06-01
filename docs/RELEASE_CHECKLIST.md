# Release Checklist

Use this checklist for every production release.

## 1) Pre-release (local/CI)

- [ ] Confirm branch is `main` and up to date.
- [ ] Run tests:
  - `npm test`
- [ ] Review DB-impacting changes in `server.js`, `schema.sql`, and route queries.
- [ ] If DB migrations are needed for existing production data, run:
  - `npm run migrate-live-db -- /path/to/church.db`

## 2) Deploy

- [ ] Deploy app image:
  - `flyctl deploy -a church-management-system`
- [ ] (Preferred) use the safe deploy script:
  - `./scripts/deploy-live.sh church-management-system https://church-management-system.fly.dev`
- [ ] Confirm machine is running:
  - `flyctl status -a church-management-system`

## 3) Post-deploy verification

- [ ] Check health endpoint:
  - `curl -i https://church-management-system.fly.dev/healthz`
- [ ] Check readiness endpoint:
  - `curl -i https://church-management-system.fly.dev/readyz`
- [ ] Run production sanity helper:
  - `./scripts/prod-sanity.sh https://church-management-system.fly.dev`
- [ ] Verify core user journey in browser:
  - Login
  - Dashboard loads
  - Inventory page loads
  - Add item flow works

## 4) Rollback readiness

- [ ] Record previous image and machine id before deploy:
  - `flyctl machine list -a church-management-system --json`
- [ ] Keep exact rollback command ready (replace values):
  - `flyctl machine update <machine-id> -a church-management-system --image <previous-image-ref>`
- [ ] Tail logs for 5–10 minutes:
  - `flyctl logs -a church-management-system`
- [ ] If errors spike, rollback immediately and investigate.

## 5) Nightly backup verification

- [ ] Verify downloaded backups are readable before archiving:
  - `./scripts/verify-backup.sh backups/<slug>-<timestamp>.db`
- [ ] Add a cron to automate backup+verify:
  - `0 2 * * * cd /path/to/repo && for d in deploys/*/; do s=$(basename "$d"); ./deploy/manage.sh "$s" backup; latest=$(ls -1t backups/${s}-*.db | head -n1); ./scripts/verify-backup.sh "$latest"; done`
- [ ] Run restore drill weekly on latest backup:
  - `./scripts/dr-restore-drill.sh backups/<slug>-<timestamp>.db`

## 6) Incident quick-fix (DB schema drift)

If a route errors with `no such table: ...`, run migration directly on live DB:

1. `flyctl ssh console -a church-management-system`
2. `CHURCH_DB=/data/church.db node scripts/migrate-live-db.js`
3. `exit`
4. `flyctl machine restart <machine-id> -a church-management-system`

## 7) Security gate

- [ ] Review `docs/SECURITY_BASELINE.md` before release.
