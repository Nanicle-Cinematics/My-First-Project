# SaaS Tenancy Review

Current production posture: private deployment per church.

## Decision

Use one isolated app/database/volume per church until a true shared multi-tenant architecture is designed, migrated, and audited.

This is the safest near-term SaaS model because:

- One church cannot query another church's records.
- Backups and restores are church-specific.
- Delete-all tools cannot cross tenant boundaries.
- Custom configuration, sender IDs, support and onboarding can be handled per church.

## Shared Multi-Tenant Requirements Before Migration

- Every tenant-owned table must include `tenant_id`.
- Every query must scope by `tenant_id` through helper APIs, not handwritten ad hoc filters.
- Unique constraints must become tenant-scoped, for example `(tenant_id, username)`.
- Backups, exports and delete-all tools must operate tenant-scoped.
- Audit logs must include `tenant_id`.
- File storage paths must include tenant-specific prefixes.
- Tests must prove two tenants cannot read, update, export or delete each other's records.

## Current Isolation Boundary

- Database: one SQLite database per church deployment.
- Files: one photo directory and backup directory per church deployment.
- Users: owner/admin accounts belong to that church deployment only.
- Runtime: one Fly app/volume configuration per church.

## Pilot Rule

For the first paying pilot churches, provision a separate deployment per church. Do not run multiple churches in one database until the shared multi-tenant requirements above are complete.
