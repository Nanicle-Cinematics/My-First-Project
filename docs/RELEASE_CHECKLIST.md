# Release Checklist

Use this checklist for every production release.

## 1) Pre-release (local/CI)

- [ ] Confirm branch is `main` and up to date.
- [ ] Run tests:
  - `npm test`
- [ ] Run the tenant-scope audit:
  - `npm run check:raw-sql-tenant-scoping`
- [ ] Review DB-impacting changes in `prisma/schema.prisma`, `lib/tenant.js`,
  `lib/ledger-pg.js`, and Postgres route queries.
- [ ] Test Prisma schema changes against a non-production database before
  applying them to production.

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

## 5) PostgreSQL backup verification

- [ ] Confirm the PostgreSQL provider's automated backups/PITR are enabled.
- [ ] Record the retention window and responsible operator.
- [ ] Run a restore drill into a separate database before major releases.
- [ ] Verify the restored database with `/readyz` and tenant-isolation smoke tests.

## 6) Incident response (DB schema drift)

Do not run ad-hoc destructive SQL against production. Reproduce the drift
against a separate database, prepare a reviewed Prisma migration/schema change,
take or confirm a current backup, then apply it through the release process.

## 7) Security gate

- [ ] Review `docs/SECURITY_BASELINE.md` before release.
