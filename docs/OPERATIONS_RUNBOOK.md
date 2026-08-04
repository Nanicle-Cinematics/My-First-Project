# Operations Runbook

Use this runbook after each deploy and during monthly maintenance.

## After Every Deploy

1. Confirm public runtime checks:

```bash
curl -fsS https://church-management-system.fly.dev/healthz
curl -fsS https://church-management-system.fly.dev/readyz
```

2. Sign in as an owner and review:

- `/security/audit`
- `/errors`
- `/backups`
- `/settings`

3. Create and verify a backup from `/backups`.

4. Create and verify a Postgres dump locally (writes to `./backups/postgres`,
   then re-reads the dump to confirm it is not truncated):

```bash
DATABASE_URL="$PRODUCTION_DATABASE_URL" ./scripts/pg-backup.sh
```

Note this runs nightly and unattended via `.github/workflows/production-backup.yml`,
which also encrypts the dump and uploads it as an artifact. That workflow only
runs when the `ENABLE_PRODUCTION_BACKUP` repository variable is set to `true`.

## Monthly Restore Drill

1. Download the newest backup from `/backups`.

2. Run:

```bash
RESTORE_DRILL_DATABASE_URL="postgresql://…/disposable_drill_db" \
ALLOW_RESTORE_DRILL=1 \
./scripts/pg-restore-drill.sh path/to/backup.dump
```

The drill DROPs and recreates the target's `public` schema, so it refuses to
run unless `ALLOW_RESTORE_DRILL=1` and the target differs from `DATABASE_URL`.
Point it only at a throwaway database.

3. Record:

- backup filename
- verification result
- restore-drill result
- operator
- date

## Rollback

The deploy helper prints the previous image reference. Keep that output with the release notes.

If rollback is needed:

```bash
flyctl machine update <machine-id> -a church-management-system --image "<previous-image-reference>"
```

After rollback, repeat the deploy checks and inspect `/errors`.

## Backup Restore

Use restore only when the current production database is confirmed bad or incomplete.

1. Verify the backup first.
2. Stage restore from `/backups`.
3. Restart the app so startup restore logic applies the staged file.
4. Check `/readyz`, member directory, finance overview, and `/errors`.
