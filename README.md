# Church Manager

A shared multi-tenant church management SaaS built with Node.js, Express,
PostgreSQL, and Prisma. One deployment serves many churches; every tenant-owned
record carries `churchId`, and database access is scoped centrally through
`tenantDb(churchId)`.

## Core capabilities

- Church signup, authentication, sessions, roles, and permissions
- Members, households, organizations, Bible classes, preaching, and pastoral care
- Events, attendance, public QR check-in, and RSVP
- Communications with SMS/email delivery and dry-run support
- Inventory and reports
- Double-entry finance ledger, funds, financial periods, and audit history
- Tithes, offerings, day-born collections, services, harvests, pledges, receipts,
  vouchers, projects, and budgets
- Tenant-isolated member photos

## Requirements

- Node.js 20 or newer
- PostgreSQL
- A long random `SESSION_SECRET`

## Local setup

```bash
npm install
cp .env.example .env
npx prisma generate
npx prisma db push
npm start
```

Set `DATABASE_URL` and `SESSION_SECRET` before starting the app. Open
`http://localhost:3000`; the public landing page lets a church create its own
tenant and first administrator.

## Tenant isolation

`lib/tenant.js` exports:

- `db`: raw Prisma client for genuine global concerns such as login and signup
- `tenantDb(churchId)`: the application client used for tenant-owned data

The tenant client injects `churchId` into supported reads and writes. Raw SQL is
checked separately:

```bash
npm run check:raw-sql-tenant-scoping
```

Every new route must include cross-tenant tests. Application scoping is the
primary isolation boundary; do not query tenant models through the raw client
without a documented reason.

## Testing

```bash
npm test
npm run check:raw-sql-tenant-scoping
```

The integration suite uses the configured PostgreSQL database and starts
temporary localhost HTTP servers. Use a dedicated non-production database.

## Production configuration

Required:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Signs sessions; must remain stable across deployments |
| `NODE_ENV=production` | Enables production cookie/security behavior |
| `PUBLIC_URL` | Public origin used for check-in, RSVP, and email links |

Common optional configuration:

| Variable | Purpose |
| --- | --- |
| `PHOTO_DIR` | Persistent member-photo directory |
| `ARKESEL_API_KEY` / `ARKESEL_SENDER` | SMS delivery; empty key keeps dry-run mode |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | SMTP email delivery |
| `RESEND_API_KEY` | Resend email delivery |
| `SUPPORT_EMAIL` / `ALERT_EMAIL` / `ALERT_WEBHOOK_URL` | Support and monitoring |

## Deployment

The production app runs on Fly.io using `fly.toml` and `Dockerfile`.

```bash
flyctl secrets set DATABASE_URL='postgresql://...'
flyctl secrets set SESSION_SECRET="$(openssl rand -hex 32)"
flyctl deploy -a church-management-system
```

After deployment, verify:

```bash
curl -fsS https://church-management-system.fly.dev/healthz
curl -fsS https://church-management-system.fly.dev/readyz
./scripts/prod-sanity.sh https://church-management-system.fly.dev
```

See `docs/RELEASE_CHECKLIST.md` for the complete release and rollback process.

## Architecture

| Path | Purpose |
| --- | --- |
| `server.js` | Postgres multi-tenant application bootstrap |
| `prisma/schema.prisma` | PostgreSQL schema |
| `lib/tenant.js` | Central Prisma tenant-scoping layer |
| `lib/tenant-http.js` | Express application assembly |
| `routes-pg/` | JSON/action routes |
| `routes-pg-html/` | Server-rendered product routes |
| `test/` | RBAC, tenant-isolation, finance, and feature integration tests |

The older SQLite modules remain temporarily as rollback/reference material and
must not be used for new production features.
