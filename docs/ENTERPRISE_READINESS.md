# Enterprise readiness

## Implemented application controls

- Shared PostgreSQL tenancy with church-scoped data access and isolation tests.
- Password hashing, account lockout, CSRF protection, and session regeneration after authentication.
- HTTP-only, SameSite session cookies; production cookies require HTTPS and expire after eight hours.
- Login and signup throttling with standard rate-limit response headers.
- Browser security headers including CSP, HSTS, frame denial, MIME sniffing protection, and restricted permissions.
- Tenant-specific authentication audit events with IP address and user-agent context.
- TOTP two-factor authentication for every user, with ten salted-hash one-time recovery codes.
- MFA login challenges expire after five minutes and are independently rate limited.
- Owner-only tenant export covering every church-owned PostgreSQL model while excluding authentication secrets and reset tokens.
- Persistent PostgreSQL error logging plus `/healthz` and database-aware `/readyz`.
- CI runs against a disposable PostgreSQL service, checks tenant-scoped raw SQL, runs tests, and audits production dependencies.
- Fly deployment verifies health, database readiness, and public authentication pages.

## Operational controls requiring an owner or provider decision

These cannot be completed honestly through application code alone:

1. Enable and document Neon automated backups/PITR, retention, and restore ownership.
2. Create a separate Fly staging app connected to a separate Neon branch.
3. Select an external uptime/error-alert provider and configure escalation recipients.
4. Commission an independent penetration test before claiming enterprise certification.
5. Approve data-retention periods, privacy terms, service levels, and support escalation policy.
6. Run and record quarterly restore drills and annual incident-response exercises.

## Next application milestones

1. Owner-approved off-boarding/deletion workflow with a cooling-off period.
2. Admin security-audit and error-log views with retention/export controls.
3. Load tests for concurrent check-in, reporting, and finance posting.
4. Provider-backed distributed rate limiting if production expands beyond one application instance.
