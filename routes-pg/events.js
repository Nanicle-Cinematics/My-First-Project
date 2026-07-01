'use strict';
// Phase 3, module 2 of 3: Postgres/Prisma port of routes/events.js.
// Same coexistence approach as the other routes-pg/*.js modules.
//
// DEFERRED (documented, not forgotten): the calendar view (`/events/calendar`,
// purely presentational, no unique data-model logic beyond what the list
// endpoint already returns), QR code image generation (`/events/:id/qr`,
// a rendering concern), and the PUBLIC token-based self-service check-in
// (`/checkin/:token`) + public RSVP (`/rsvp/:token`) flows. Those public
// routes need a genuinely new pattern this rewrite hasn't built yet —
// resolving tenant context from a bare event token with NO session/login —
// which deserves a deliberate design pass of its own rather than being
// bolted on here. Everything else (admin-authenticated CRUD, counts, RSVP
// management, check-in/out) is ported and tenant-isolation-tested below.

const crypto = require('crypto');
const asyncHandler = require('../lib/async-handler');

const EVENT_TYPES = ['SERVICE', 'PRAYER', 'BIBLE_STUDY', 'OUTREACH', 'YOUTH', 'WEDDING', 'FUNERAL', 'BAPTISM', 'CONFIRMATION', 'OTHER'];
const RSVP_RESPONSES = ['GOING', 'MAYBE', 'NO'];

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

function parseEventBody(b) {
  return {
    title: (b.title || '').trim(),
    eventType: EVENT_TYPES.includes(b.eventType) ? b.eventType : 'SERVICE',
    startsAt: b.startsAt ? new Date(b.startsAt) : null,
    endsAt: b.endsAt ? new Date(b.endsAt) : null,
    location: (b.location || '').trim() || null,
    notes: (b.notes || '').trim() || null,
  };
}

function register(app) {
  app.get('/api/events', requireAuth, asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    const rows = await res.locals.db.event.findMany({
      where: q ? { title: { contains: q, mode: 'insensitive' } } : {},
      orderBy: { startsAt: 'desc' },
      include: { _count: { select: { attendance: true } } },
    });
    res.json(rows.map((e) => ({ ...e, _count: undefined, attendees: e._count.attendance })));
  }));

  app.post('/api/events', requireAdmin, asyncHandler(async (req, res) => {
    const v = parseEventBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      return res.status(400).json({ error: 'title and startsAt are required' });
    }
    const ev = await res.locals.db.event.create({ data: { ...v, checkinToken: crypto.randomBytes(16).toString('hex') } });
    res.status(201).json(ev);
  }));

  app.get('/api/events/:id', requireAuth, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const ev = await db.event.findUnique({ where: { id } });
    if (!ev) return res.status(404).json({ error: 'Not found' });

    const [attendees, rsvps] = await Promise.all([
      db.attendance.findMany({
        where: { eventId: id },
        include: { member: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { member: { lastName: 'asc' } },
      }),
      db.eventRsvp.findMany({
        where: { eventId: id },
        include: { member: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: [{ response: 'asc' }, { member: { lastName: 'asc' } }],
      }),
    ]);
    const rsvpCounts = { GOING: 0, MAYBE: 0, NO: 0 };
    for (const r of rsvps) rsvpCounts[r.response] = (rsvpCounts[r.response] || 0) + 1;

    res.json({
      ...ev,
      attendees: attendees.map((a) => ({ ...a.member, checkedInAt: a.checkedInAt })),
      rsvps: rsvps.map((r) => ({ ...r.member, response: r.response })),
      rsvpCounts,
    });
  }));

  app.put('/api/events/:id', requireAdmin, asyncHandler(async (req, res) => {
    const v = parseEventBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      return res.status(400).json({ error: 'title and startsAt are required' });
    }
    try {
      const ev = await res.locals.db.event.update({ where: { id: Number(req.params.id) }, data: v });
      res.json(ev);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.put('/api/events/:id/counts', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const db = res.locals.db;
    if (req.body && req.body.clear === true) {
      try {
        const ev = await db.event.update({
          where: { id },
          data: { attendanceMen: null, attendanceWomen: null, attendanceChildren: null, attendanceTotal: null },
        });
        return res.json(ev);
      } catch (e) {
        if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
        throw e;
      }
    }
    const men = toIntOrNull(req.body.attendanceMen);
    const women = toIntOrNull(req.body.attendanceWomen);
    const children = toIntOrNull(req.body.attendanceChildren);
    let total = toIntOrNull(req.body.attendanceTotal);
    if (total === null && (men !== null || women !== null || children !== null)) {
      total = (men || 0) + (women || 0) + (children || 0);
    }
    try {
      const ev = await db.event.update({
        where: { id },
        data: { attendanceMen: men, attendanceWomen: women, attendanceChildren: children, attendanceTotal: total },
      });
      res.json(ev);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.post('/api/events/:id/rsvp', requireAdmin, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    const response = RSVP_RESPONSES.includes(req.body.response) ? req.body.response : 'GOING';
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });
    const db = res.locals.db;
    const [event, member] = await Promise.all([
      db.event.findUnique({ where: { id: eventId } }),
      db.member.findUnique({ where: { id: memberId } }),
    ]);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const rsvp = await db.eventRsvp.upsert({
      where: { eventId_memberId: { eventId, memberId } },
      update: { response, respondedAt: new Date() },
      create: { eventId, memberId, response },
    });
    res.status(201).json(rsvp);
  }));

  app.delete('/api/events/:id/rsvp/:memberId', requireAdmin, asyncHandler(async (req, res) => {
    try {
      await res.locals.db.eventRsvp.delete({
        where: { eventId_memberId: { eventId: Number(req.params.id), memberId: Number(req.params.memberId) } },
      });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'RSVP not found' });
      throw e;
    }
  }));

  app.post('/api/events/:id/check', requireAdmin, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });
    const db = res.locals.db;
    const [event, member] = await Promise.all([
      db.event.findUnique({ where: { id: eventId } }),
      db.member.findUnique({ where: { id: memberId } }),
    ]);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    // Matches the original's `INSERT OR IGNORE` — already-checked-in is a no-op, not an error.
    const attendance = await db.attendance.upsert({
      where: { eventId_memberId: { eventId, memberId } },
      update: {},
      create: { eventId, memberId },
    });
    res.status(201).json(attendance);
  }));

  app.delete('/api/events/:id/check/:memberId', requireAdmin, asyncHandler(async (req, res) => {
    try {
      await res.locals.db.attendance.delete({
        where: { eventId_memberId: { eventId: Number(req.params.id), memberId: Number(req.params.memberId) } },
      });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not checked in' });
      throw e;
    }
  }));
}

module.exports = { register };
