# Changelog

All notable changes to this project are documented here.

## v1.2.0 - 2026-05-28

### Added

- Security audit log for login and user-management events, with owner review page at `/security/audit`.
- Financial summary CSV export at `/reports/financial.csv`.
- Production sanity helper script: `scripts/prod-sanity.sh`.
- Authorization matrix documentation in `docs/AUTHORIZATION_MATRIX.md`.
- Enterprise command-center headers across operational pages, including dashboard, members, finance, events, communications, inventory, preaching, sacraments, backups, errors, users, profile and settings.

### Changed

- Release/security docs now include audit review and production sanity checks.
- Fresh database schema and live migration helper now both create the security audit index used by owner review.

## v1.1.0 - 2026-05-28

### Added

- Runtime health and readiness endpoints:
  - `GET /healthz`
  - `GET /readyz` (DB connectivity check)
- Inventory category model and workflows:
  - persistent `inventory_categories` schema guard
  - recommended categories list for inventory forms
  - category dropdowns for add/edit flows
  - admin route `POST /inventory/categories`
- Live migration/ops helpers:
  - `scripts/migrate-live-db.js`
  - `scripts/deploy-live.sh`
  - `scripts/verify-backup.sh`
- Fly health checks in:
  - `fly.toml`
  - `deploy/fly.toml.template`
- Operations documentation:
  - `docs/NEXT_STEPS.md`
  - `docs/RELEASE_CHECKLIST.md`
  - `docs/ROLLBACK_PIN.md`

### Changed

- Dashboard visual polish with `.dash-shell` modern aesthetic treatment.
- Startup environment validation now fails fast when required env variables are missing (outside tests).
- `package.json` adds `migrate-live-db` script.

### Notes

- If upgrading a long-lived production database, run:
  - `CHURCH_DB=/data/church.db node scripts/migrate-live-db.js`
