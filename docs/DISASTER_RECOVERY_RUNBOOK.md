# Disaster Recovery Runbook

## Targets

- Recovery point objective (RPO): 24 hours.
- Recovery time objective (RTO): 4 hours.
- Incident owner: platform owner.

## Quarterly drill

1. Download the newest encrypted backup artifact from the private GitHub Actions run.
2. Verify its checksum and decrypt it only on an approved operator machine.
3. Create a disposable Neon branch/database. Never use production.
4. Run `ALLOW_RESTORE_DRILL=1 RESTORE_DRILL_DATABASE_URL=... scripts/pg-restore-drill.sh backup.dump`.
5. Verify church/user counts, sign-in, tenant isolation, finance totals and a JSON tenant export.
6. Record the date, backup timestamp, recovery duration, operator, result and corrective actions.
7. Destroy the disposable restore database and securely remove the decrypted backup.

## Production recovery

1. Declare the incident and stop writes if corruption is suspected.
2. Preserve logs and take a final snapshot if safe.
3. Prefer Neon point-in-time recovery for recent logical/operator errors.
4. Otherwise restore the newest verified encrypted dump into a new database.
5. Run readiness, security smoke and tenant-isolation tests.
6. Change `DATABASE_URL`, deploy, and monitor errors before reopening access.
7. Rotate exposed credentials and publish an incident report.
