'use strict';
// Phase 8a: activity logging. ActivityLog already exists in
// prisma/schema.prisma (this was a missing helper function, not a schema
// gap) — Postgres equivalent of server.js:1905-1910's logActivity(). `db`
// must be the tenant-scoped client (res.locals.db) so churchId is stamped
// automatically. Best-effort: a logging failure must never break the
// request that triggered it.
async function logActivity(db, kind, description, link, userId) {
  try {
    await db.activityLog.create({ data: { kind, description, link: link || null, userId: userId || null } });
  } catch (e) {
    console.error('[logActivity] failed:', e.message);
  }
}

module.exports = { logActivity };
