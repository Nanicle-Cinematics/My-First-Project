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
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const ministry = await res.locals.db.ministry.create({
        data: {
          name: String(b.name).trim(),
          description: b.description || null,
          leaderId: b.leaderId ? Number(b.leaderId) : null,
          orgId: b.orgId ? Number(b.orgId) : null,
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
    const b = req.body || {};
    try {
      const ministry = await res.locals.db.ministry.update({
        where: { id: Number(req.params.id) },
        data: {
          leaderId: b.leaderId ? Number(b.leaderId) : null,
          orgId: b.orgId ? Number(b.orgId) : null,
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
