# Changelog

All notable changes to this project are documented here.

## v1.4.0 - 2026-06-30

### Added

- Native double-entry finance module built directly into the management app (no external service):
  - Chart of accounts (`accounts` table) with 30 predefined GL codes across ASSET/INCOME/EXPENSE/FUND_EQUITY types.
  - Double-entry journal (`journal_entries` + `journal_lines`) with POSTED/REVERSED lifecycle and reversal chaining.
  - Financial periods (`financial_periods`) for period-open/close controls.
  - Fund management (`funds`) with opening balance, type (GENERAL/BUILDING/WELFARE/etc.), restricted/unrestricted flag, and ledger-derived balance.
  - Finance projects (`finance_projects`) with status workflow (PLANNING/ACTIVE/ON_HOLD/COMPLETED/CANCELLED) and budget tracking.
  - Finance budgets (`finance_budgets` + `finance_budget_lines`) with ANNUAL/MONTHLY scope, account-level lines, and overspending warnings on the finance dashboard.
  - Payment vouchers (`payment_vouchers`) auto-generated from approved expenses, with printable voucher layout and signature fields.
  - Expense approval workflow: SUBMITTED → APPROVED → PAID / REJECTED, with voucher generation on approval.
  - Finance settings page for fiscal year start, default currency, cash account selection.
  - Accounting page with fund balances, trial balance (debit/credit totals, balanced check), and general ledger view.
  - CSV exports for trial balance, general ledger, vouchers, fund report, and projects.
  - User `finance_role` column (none/finance_admin/treasurer/cashier/auditor) with dedicated middleware (`requireFinanceWrite`, `requireFinanceAccounting`, `requireFundViewer`, `requireFundManager`).
  - `lib/ledger.js`: postCashIncome, postExpensePayment, reverseJournal, fundBalance, fundRaisedSpent helpers.
  - `lib/money.js`: amountInWords() Ghanaian-cedi amount-in-words for voucher printing.
- SaaS operations documentation:
  - `docs/LEGAL_AND_SUPPORT_READINESS.md`
  - `docs/MONITORING_AND_ALERTS.md`
  - `docs/OFFSITE_BACKUP_SETUP.md`
  - `docs/SAAS_ONBOARDING_AND_LIMITS.md`
  - `docs/SAAS_TENANCY_REVIEW.md`
  - `docs/USER_ACCEPTANCE_TEST_PLAN.md`

### Removed

- External SSO handoff to the Vercel church-finance app (`lib/sso.js`, `lib/sync.js`, `/sso/authorize`, `/sync/members`). Finance is now fully in-house.
- `FINANCE_ORIGIN` and `SSO_SECRET` environment variables (removed from `.env.example`).

### Notes

- Finance role migration: existing users default to `finance_role='none'`. Assign roles from the Users admin page.
- Ledger tables (`accounts`, `journal_entries`, `journal_lines`, `financial_periods`) are auto-created on first boot from the updated `schema.sql`.

## v1.3.0 - 2026-06-05

### Added

- Phase 3 production-hardening plan and operations runbook.
- In-app backup verification from `/backups`, including SQLite integrity checks and expected table checks.
- Backup create/delete/verify/restore staging events in the security audit log.
- Owner-only Operations page at `/operations` for readiness, backup, error, audit and integration status.

### Changed

- Backup verification and restore drill scripts now run `PRAGMA integrity_check` and validate expected core tables.

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
