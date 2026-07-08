'use strict';
// Phase 2, module 2 of 5: Postgres/Prisma port of routes/bible-classes.js.
// Same coexistence approach as routes-pg/preaching.js — standalone JSON API,
// not wired into the live server.js yet.

const asyncHandler = require('../lib/async-handler');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

// tenantDb only stamps churchId onto a create's own row — it never validates
// a client-supplied foreign-key id embedded in that row's data, so
// Ministry.leaderId/orgId must be checked explicitly through the scoped
// client first, or a cross-tenant id in the request body would silently
// attach this church's bible class to another church's member/organization.
async function checkLeaderId(db, bodyLeaderId) {
  if (!bodyLeaderId) return { ok: true, leaderId: null };
  const member = await db.member.findUnique({ where: { id: Number(bodyLeaderId) } });
  return member ? { ok: true, leaderId: member.id } : { ok: false, leaderId: null };
}
async function checkOrgId(db, bodyOrgId) {
  if (!bodyOrgId) return { ok: true, orgId: null };
  const org = await db.organization.findUnique({ where: { id: Number(bodyOrgId) } });
  return org ? { ok: true, orgId: org.id } : { ok: false, orgId: null };
}

function register(app) {
  app.get('/api/bible-classes', requireAuth, asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    const db = res.locals.db;
    const rows = await db.ministry.findMany({
      where: q ? { name: { contains: q, mode: 'insensitive' } } : {},
      orderBy: { name: 'asc' },
      include: {
        leader: { select: { id: true, firstName: true, lastName: true } },
        organization: { select: { id: true, name: true } },
        _count: { select: { bibleClassMembers: true } },
      },
    });
    res.json(rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      meetsOn: r.meetsOn,
      active: r.active,
      leader: r.leader,
      organization: r.organization,
      memberCount: r._count.bibleClassMembers,
    })));
  }));

  app.post('/api/bible-classes', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
    const leaderCheck = await checkLeaderId(db, b.leaderId);
    const orgCheck = await checkOrgId(db, b.orgId);
    if (!leaderCheck.ok || !orgCheck.ok) return res.status(400).json({ error: 'Leader or organization not found' });
    try {
      const ministry = await db.ministry.create({
        data: {
          name: String(b.name).trim(),
          description: b.description || null,
          leaderId: leaderCheck.leaderId,
          orgId: orgCheck.orgId,
          meetsOn: b.meetsOn || null,
        },
      });
      res.status(201).json(ministry);
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'A Bible class with that name already exists' });
      throw e;
    }
  }));

  // Matches the original's scope: this endpoint only ever updates leader/org.
  app.put('/api/bible-classes/:id', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const leaderCheck = await checkLeaderId(db, b.leaderId);
    const orgCheck = await checkOrgId(db, b.orgId);
    if (!leaderCheck.ok || !orgCheck.ok) return res.status(400).json({ error: 'Leader or organization not found' });
    try {
      const ministry = await db.ministry.update({
        where: { id: Number(req.params.id) },
        data: {
          leaderId: leaderCheck.leaderId,
          orgId: orgCheck.orgId,
        },
      });
      res.json(ministry);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Bible class not found' });
      throw e;
    }
  }));
}

module.exports = { register };
