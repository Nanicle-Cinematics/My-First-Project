'use strict';
// Phase 2, module 1 of 5 (smallest/lowest-risk first): Postgres/Prisma port
// of routes/preaching.js. Same coexistence approach as Phase 1 — this is a
// standalone, fully-tested module mounted onto lib/tenant-http.js's app, NOT
// wired into the live server.js/routes/preaching.js yet (that still serves
// the real production church on SQLite until the Phase 7 data migration).
//
// Surface is JSON, not the original's server-rendered HTML — porting the
// HTML view layer (lib/views.js's pageHero/statsRow/esc helpers) is a
// cross-cutting concern spanning every module, not specific to preaching,
// and is deferred to the real per-route cutover. This module proves the
// CRUD + validation + tenant-isolation + audit-logging logic is correct.
//
// The original's `/preaching/:id/remind` (SMS/email reminder) is NOT ported
// here — it depends on the communications module's send infra, which is a
// later phase. Flagged as deferred, not forgotten.

const asyncHandler = require('../lib/async-handler');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function parsePlanBody(b) {
  const preachDate = b.preachDate ? new Date(b.preachDate) : null;
  return {
    preachDate,
    serviceLabel: (b.serviceLabel || '').trim() || null,
    memberId: b.memberId ? Number(b.memberId) : null,
    preacherName: (b.preacherName || '').trim() || null,
    preacherPhone: (b.preacherPhone || '').trim() || null,
    preacherEmail: (b.preacherEmail || '').trim() || null,
    topic: (b.topic || '').trim() || null,
    scripture: (b.scripture || '').trim() || null,
    notes: (b.notes || '').trim() || null,
  };
}

function register(app) {
  app.get('/api/preaching', requireAuth, asyncHandler(async (req, res) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const db = res.locals.db;
    const [upcoming, past] = await Promise.all([
      db.preachingPlan.findMany({
        where: { deletedAt: null, preachDate: { gte: today } },
        orderBy: { preachDate: 'asc' },
        include: { member: { select: { id: true, firstName: true, lastName: true, mobilePhone: true, email: true } } },
      }),
      db.preachingPlan.findMany({
        where: { deletedAt: null, preachDate: { lt: today } },
        orderBy: { preachDate: 'desc' },
        take: 20,
        include: { member: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ]);
    res.json({ upcoming, past });
  }));

  app.get('/api/preaching/:id', requireAuth, asyncHandler(async (req, res) => {
    const plan = await res.locals.db.preachingPlan.findFirst({
      where: { id: Number(req.params.id), deletedAt: null },
    });
    if (!plan) return res.status(404).json({ error: 'Appointment not found' });
    res.json(plan);
  }));

  app.post('/api/preaching', requireAdmin, asyncHandler(async (req, res) => {
    const v = parsePlanBody(req.body || {});
    if (!v.preachDate || Number.isNaN(v.preachDate.getTime())) {
      return res.status(400).json({ error: 'preachDate is required' });
    }
    const plan = await res.locals.db.preachingPlan.create({ data: v });
    res.status(201).json(plan);
  }));

  app.put('/api/preaching/:id', requireAdmin, asyncHandler(async (req, res) => {
    const v = parsePlanBody(req.body || {});
    if (!v.preachDate || Number.isNaN(v.preachDate.getTime())) {
      return res.status(400).json({ error: 'preachDate is required' });
    }
    try {
      const plan = await res.locals.db.preachingPlan.update({
        where: { id: Number(req.params.id) },
        data: { ...v, updatedAt: new Date() },
      });
      res.json(plan);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Appointment not found' });
      throw e;
    }
  }));

  app.delete('/api/preaching/:id', requireAdmin, asyncHandler(async (req, res) => {
    try {
      await res.locals.db.preachingPlan.update({
        where: { id: Number(req.params.id) },
        data: { deletedAt: new Date() },
      });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Appointment not found' });
      throw e;
    }
  }));
}

module.exports = { register };
