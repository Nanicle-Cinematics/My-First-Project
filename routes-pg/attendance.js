'use strict';
// Phase 2, module 5 of 5: Postgres/Prisma port of routes/attendance.js.
// Same coexistence approach as the other routes-pg/*.js modules. Operates on
// Event rows where eventType=SERVICE, plus the Men/Women/Children/Total
// count columns stored directly on the event.
//
// The original's CSV export (`/attendance.csv`) is NOT ported — it's just a
// different serialization of the same list data this module already
// returns as JSON; a real CSV formatter belongs with the cross-cutting view
// layer work deferred to the real per-route cutover (same reasoning as
// skipping preaching's HTML/remind endpoint).

const crypto = require('crypto');
const asyncHandler = require('../lib/async-handler');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function toIntOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function deriveTotal(men, women, children, total) {
  if (total !== null) return total;
  if (men === null && women === null && children === null) return null;
  return (men || 0) + (women || 0) + (children || 0);
}

function parseServiceBody(b) {
  const men = toIntOrNull(b.attendanceMen);
  const women = toIntOrNull(b.attendanceWomen);
  const children = toIntOrNull(b.attendanceChildren);
  const total = deriveTotal(men, women, children, toIntOrNull(b.attendanceTotal));
  return {
    title: (b.title || '').trim(),
    startsAt: b.startsAt ? new Date(b.startsAt) : null,
    location: (b.location || '').trim() || null,
    notes: (b.notes || '').trim() || null,
    attendanceMen: men,
    attendanceWomen: women,
    attendanceChildren: children,
    attendanceTotal: total,
  };
}

function shapeService(e) {
  return {
    id: e.id,
    title: e.title,
    startsAt: e.startsAt,
    location: e.location,
    notes: e.notes,
    attendanceMen: e.attendanceMen,
    attendanceWomen: e.attendanceWomen,
    attendanceChildren: e.attendanceChildren,
    attendanceTotal: e.attendanceTotal,
    attendees: e._count ? e._count.attendance : undefined,
  };
}

function register(app) {
  app.get('/api/attendance', requireAuth, asyncHandler(async (req, res) => {
    const services = await res.locals.db.event.findMany({
      where: { eventType: 'SERVICE' },
      orderBy: { startsAt: 'desc' },
      take: 20,
      include: { _count: { select: { attendance: true } } },
    });
    res.json(services.map(shapeService));
  }));

  app.get('/api/attendance/:id', requireAuth, asyncHandler(async (req, res) => {
    const ev = await res.locals.db.event.findFirst({
      where: { id: Number(req.params.id), eventType: 'SERVICE' },
      include: { _count: { select: { attendance: true } } },
    });
    if (!ev) return res.status(404).json({ error: 'Not found' });
    res.json(shapeService(ev));
  }));

  app.post('/api/attendance', requireAdmin, asyncHandler(async (req, res) => {
    const v = parseServiceBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      return res.status(400).json({ error: 'title and startsAt are required' });
    }
    const ev = await res.locals.db.event.create({
      data: { ...v, eventType: 'SERVICE', checkinToken: crypto.randomBytes(16).toString('hex') },
    });
    res.status(201).json(shapeService(ev));
  }));

  app.put('/api/attendance/:id', requireAdmin, asyncHandler(async (req, res) => {
    const v = parseServiceBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      return res.status(400).json({ error: 'title and startsAt are required' });
    }
    try {
      const ev = await res.locals.db.event.update({
        where: { id: Number(req.params.id) },
        data: v,
      });
      res.json(shapeService(ev));
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.delete('/api/attendance/:id', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    // Matches the original's guard: only a SERVICE-type event may be
    // deleted through this endpoint, not any event by id.
    const ev = await db.event.findFirst({ where: { id, eventType: 'SERVICE' } });
    if (!ev) return res.status(404).json({ error: 'Not found' });
    // Attendance rows cascade-delete with their Event (schema.prisma:
    // Attendance.event has onDelete: Cascade) — no manual pre-delete needed,
    // unlike the original's explicit two-statement db.transaction().
    await db.event.delete({ where: { id } });
    res.status(204).end();
  }));
}

module.exports = { register };
