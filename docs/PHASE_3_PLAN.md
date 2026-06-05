# Phase 3 Plan: Production Hardening

Phase 3 focuses on making the deployed system easier to operate, recover, and monitor after Phase 2 established readiness endpoints, audit logging, migration helpers, and owner command centers.

## Priorities

1. Backup confidence
   - Verify backups in-app before restore.
   - Keep local verification scripts aligned with app verification.
   - Log backup create, verify, delete, and restore-staging events in the security audit log.

2. Recovery practice
   - Run a monthly restore drill against a downloaded backup.
   - Record the backup filename, date, operator, and result.
   - Keep rollback image information from each deploy.

3. Operational monitoring
   - Continue checking `/healthz` and `/readyz` after every deploy.
   - Review `/errors` and `/security/audit` after deploys and account changes.
   - Add alerting once an external monitoring service is selected.

4. Access governance
   - Review users and roles monthly.
   - Keep `dunwelladmin` as the only account that can create/delete users or reset passwords.
   - Archive unused accounts instead of sharing credentials.

## First Slice

This branch starts Phase 3 with backup verification and audit hardening:

- `/backups` exposes a Verify action for each backup.
- Restore staging verifies the selected backup before staging it.
- Uploaded restore files are verified and removed if validation fails.
- `scripts/verify-backup.sh` and `scripts/dr-restore-drill.sh` run integrity checks.

## Acceptance Checks

- `npm test`
- `git diff --check`
- Create a backup from `/backups`, verify it, and confirm the event appears in `/security/audit`.
- Download the backup and run:

```bash
./scripts/verify-backup.sh path/to/backup.db
./scripts/dr-restore-drill.sh path/to/backup.db
```
