# Church Management System — Engineering Review & Next Steps

## Current status snapshot

- Core product workflows are in place: members, attendance/events, finance, reports, communications, inventory, classes, organizations, authentication, and role-based access.
- Test coverage includes both business logic and HTTP integration paths, and currently passes.
- Deployment targets and local bootstrap are documented for Render, Fly.io, and Procfile-based hosts.

## Recommended roadmap

## 0) Immediate baseline (this week)

1. **Define production environment contracts**
   - Add a single source of truth for required environment variables (example `.env.example` + validation at startup).
   - Fail fast with clear errors when required secrets/config are missing.

2. **Document backup and restore operations end-to-end**
   - Expand operational docs to include restore drills, retention policy, and who is accountable for backup verification.

3. **Set release/version discipline**
   - Start changelog + semantic versioning policy to make deployments and rollbacks predictable.

## 1) Reliability and operations (next 2–4 weeks)

1. **Structured logging + request correlation**
   - Emit JSON logs with request IDs, user IDs (when authenticated), and route metadata.

2. **Health and readiness checks**
   - Add `/healthz` and `/readyz` endpoints that verify DB connectivity and critical dependencies.

3. **Operational metrics**
   - Track auth failures, 4xx/5xx rates, queue/notification outcomes, and backup success rate.

4. **Disaster recovery drill**
   - Perform at least one restore rehearsal from production backups into a staging clone.

## 2) Security hardening (next 2–6 weeks)

1. **Enforce secure defaults in production**
   - Ensure strict cookie/session settings and trust-proxy behavior are explicit for hosted deployments.

2. **Role model review**
   - Build an authorization matrix by route/action (owner/admin/editor/viewer), and verify consistency.

3. **Sensitive data handling policy**
   - Define retention and access policy for pastoral notes and counseling-sensitive records.

4. **Dependency and vulnerability cadence**
   - Monthly dependency patch window + automated audit checks in CI.

## 3) Product improvements (next 1–2 quarters)

1. **Member lifecycle automation**
   - Follow-up workflows for inactive/missed attendance members.

2. **Finance controls**
   - Audit trails for edits/deletes, printable statements by period/fund, and export enhancements.

3. **Communications maturity**
   - Delivery status tracking (SMS/email), bounce/failure reporting, and template management.

4. **Calendar + event quality-of-life**
   - Better recurrence support, attendance import/export, and reminders.

## 4) Engineering quality (ongoing)

1. **CI pipeline**
   - Run tests and linting automatically on pull requests.

2. **Codebase modularization goals**
   - Continue route extraction and service-layer boundaries for easier testing and maintainability.

3. **Test strategy improvements**
   - Add performance smoke tests around key lists/reports with realistic seed volumes.

4. **Documentation ownership**
   - Assign owners for operations docs, release notes, and deployment runbooks.

## Suggested execution order

1. Baseline config + backup/restore runbook
2. Health checks + structured logging
3. Authz matrix and security hardening
4. CI automation and release process
5. Product-level enhancements based on ministry priorities

## Definition of done for the next milestone

- CI enforces test pass on every PR.
- Production environment validation fails fast on bad config.
- Restore drill completed and documented.
- Health/readiness endpoints live and wired into hosting checks.
- Authorization matrix documented and verified for all role-sensitive routes.
