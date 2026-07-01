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

module.exports = { db, tenantDb, GLOBAL_MODELS };
