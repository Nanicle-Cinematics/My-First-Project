# Security Baseline (v1.2 hardening)

This checklist captures the minimum security posture expected for production.

## Application controls

- Enforce `SESSION_SECRET` in non-test environments.
- Keep CSRF enabled on state-changing routes.
- Keep secure cookie defaults (`httpOnly`, `sameSite`, `secure` in production).
- Keep security headers enabled (CSP, frame deny, content-type, referrer policy).

## Access controls

- Review owner/admin/editor/viewer permissions quarterly.
- Require strong passwords for operator/admin users.
- Remove/disable stale user accounts.

## Operations controls

- Run `npm test` before every deploy.
- Track health and readiness (`/healthz`, `/readyz`) in hosting checks.
- Keep rollback pin documented for each release.
- Verify backups nightly and run periodic restore drills.

## Dependency hygiene

- Run `npm audit --omit=dev --audit-level=high` in CI.
- Patch high/critical vulnerabilities before release.

## Security audit review

- Review `/security/audit` after account changes, password resets, and suspicious login activity.
- Investigate repeated `login_failed` or `login_blocked` events from the same IP.
