# Off-Site Backup Setup

The app supports off-site backup upload with `BACKUP_UPLOAD_URL`.

## Required Environment

- `BACKUP_DIR`: local backup directory mounted on persistent storage.
- `BACKUP_KEEP`: number of retained local backups.
- `BACKUP_UPLOAD_URL`: upload destination.

If `BACKUP_UPLOAD_URL` contains a query string, it is treated as a presigned PUT URL. Otherwise, the backup filename is appended to the URL.

## Recommended Production Pattern

Use an object storage bucket such as S3, Backblaze B2, Cloudflare R2 or a compatible service.

Recommended controls:

- Private bucket.
- Server-side encryption enabled.
- Object versioning enabled.
- Lifecycle retention of at least 30 days.
- Separate credentials per church deployment.
- Monthly restore drill.

## Verification

1. Set `BACKUP_UPLOAD_URL`.
2. Create a backup from `/backups`.
3. Verify the backup from `/backups`.
4. Confirm the object exists in the off-site bucket.
5. Download and restore-test a copy in a non-production environment.

The Operations page reports whether off-site backup upload is configured.
