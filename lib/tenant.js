const { PrismaClient } = require('@prisma/client');

// ---------------------------------------------------------------------------
//  MULTI-TENANCY CHOKE POINT
//  Every tenant-owned row carries `churchId`. tenantDb(churchId) returns a
//  Prisma client extension that AUTOMATICALLY scopes every query to that
//  church:
//    - read/filter/update/delete ops get `where.churchId = churchId`
//    - create / createMany / upsert get `churchId` written into the data
//  Route handlers use the returned client and never write a churchId filter
//  by hand. Direct port of poultry-manager's src/lib/tenant.ts.
// ---------------------------------------------------------------------------

const db = new PrismaClient();

// Models WITHOUT a churchId column (pre-tenant / the tenant itself). Never scoped.
const GLOBAL_MODELS = new Set(['Church', 'TrialSignup']);

// Operations whose `args.where` should be constrained to the church.
const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

function tenantDb(churchId) {
  return db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || GLOBAL_MODELS.has(model)) return query(args);
          const a = { ...(args ?? {}) };

          if (WHERE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), churchId };
          }
          if (operation === 'create') {
            a.data = { ...(a.data ?? {}), churchId };
          }
          if (operation === 'createMany') {
            const d = a.data;
            a.data = Array.isArray(d) ? d.map((x) => ({ ...x, churchId })) : { ...(d ?? {}), churchId };
          }
          if (operation === 'upsert') {
            a.create = { ...(a.create ?? {}), churchId };
          }
          return query(a);
        },
      },
    },
  });
}

// Resolves the tenant for a public, session-less token-based route (QR
// check-in, RSVP). Event.checkinToken is declared @unique GLOBALLY (not
// per-church) in the schema, so looking it up via the raw, unscoped `db`
// is safe — there's no cross-tenant ambiguity to resolve. Once the event
// (and its churchId) is found, everything else in the request should use
// the returned tenantDb(), never the raw client. Returns null if the
// token doesn't match any event.
async function resolveChurchByCheckinToken(token) {
  if (!token) return null;
  const event = await db.event.findUnique({ where: { checkinToken: token } });
  if (!event) return null;
  return { event, churchId: event.churchId, db: tenantDb(event.churchId) };
}

module.exports = { db, tenantDb, GLOBAL_MODELS, resolveChurchByCheckinToken };
