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
// Phase 9a: `/preaching/:id/remind` (SMS/email reminder, deferred above)
// is now wired in via lib/delivery.js.

const asyncHandler = require('../lib/async-handler');
const { sendSmsBatch, sendEmailEach, normalizePhoneGH } = require('../lib/delivery');
const { fmtPreachDate } = require('../lib/format');
const { logActivity } = require('../lib/tenant-activity');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

// Prisma DateTime -> the plain date string fmtPreachDate() expects.
function iso(d) {
  if (!d) return '';
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function preacherContact(plan) {
  if (plan.memberId && plan.member) {
    return {
      name: `${plan.member.firstName} ${plan.member.lastName}`.trim(),
      first: plan.member.firstName || '',
      phone: plan.member.mobilePhone, email: plan.member.email, token: plan.member.unsubscribeToken,
    };
  }
  const name = (plan.preacherName || '').trim();
  return { name, first: name.split(/\s+/)[0] || name, phone: plan.preacherPhone, email: plan.preacherEmail, token: null };
}

// Send a "you're preaching on X" reminder via SMS (if a phone is on file)
// and/or email (if an address is on file). `db` must be tenant-scoped.
async function sendPreachingReminder(db, plan, userId, churchName) {
  const c = preacherContact(plan);
  if (!c.name && !c.phone && !c.email) return { ok: false, reason: 'no_contact' };
  const when = fmtPreachDate(iso(plan.preachDate));
  const where = plan.serviceLabel ? ` (${plan.serviceLabel})` : '';
  const topic = plan.topic ? ` Topic: ${plan.topic}.` : '';
  const msg = `Hello ${c.first || 'Preacher'}, a reminder that you are scheduled to preach on ${when}${where}.${topic} — ${churchName}`;

  const phone = normalizePhoneGH(c.phone);
  let sms = null, email = null;
  if (phone) {
    try { sms = await sendSmsBatch([phone], msg); }
    catch (e) { sms = { ok: false, error: e.message }; }
  }
  if (c.email) {
    try { email = await sendEmailEach(db, [{ addr: c.email, token: c.token }], `Preaching reminder — ${when}`, msg, { withFooter: false, churchName }); }
    catch (e) { email = { ok: false, error: e.message }; }
  }
  await db.preachingPlan.update({ where: { id: plan.id }, data: { reminderSentAt: new Date() } });
  await logActivity(db, 'preaching_reminder', `Sent preaching reminder to ${c.name || 'preacher'} for ${when}`, '/preaching', userId);
  const dryRun = (sms && sms.dryRun) || (email && email.dryRun);
  return {
    ok: true, name: c.name, hadPhone: !!phone, hadEmail: !!c.email,
    smsOk: sms ? (sms.ok || sms.dryRun) : null,
    emailOk: email ? (email.ok || email.dryRun) : null,
    dryRun,
  };
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

  app.post('/api/preaching/:id/remind', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const plan = await db.preachingPlan.findFirst({
      where: { id: Number(req.params.id), deletedAt: null },
      include: { member: { select: { firstName: true, lastName: true, mobilePhone: true, email: true, unsubscribeToken: true } } },
    });
    if (!plan) return res.status(404).json({ error: 'Appointment not found' });
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const result = await sendPreachingReminder(db, plan, res.locals.user.id, church.name);
    if (!result.ok) return res.status(400).json({ error: 'No phone or email on file for this preacher' });
    res.json(result);
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

module.exports = { register, sendPreachingReminder, preacherContact };
