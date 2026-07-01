'use strict';
// Phase 3, module 1 of 3: Postgres/Prisma port of routes/communications.js.
// Same coexistence approach as the routes-pg/*.js modules from Phase 2.
//
// SCOPE: ports announcements CRUD, per-church email settings, and the full
// broadcast audience-resolution + recipient bookkeeping (the parts that
// actually need tenant isolation and are worth testing). Real SMS/email
// DELIVERY (Arkesel API / SMTP / Resend, server.js:1539 sendSmsBatch /
// server.js:1704 sendEmailEach) is NOT wired in — it's an external-service
// integration depending on live secrets, orthogonal to the multi-tenant
// schema work, and is stubbed to always return a dry-run result so the
// audience/recipient logic stays fully real and testable. Wire real
// delivery in at the actual per-route cutover.

const asyncHandler = require('../lib/async-handler');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

// Verbatim port of server.js:1528 normalizePhoneGH.
function normalizePhoneGH(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0') && s.length === 10) s = '+233' + s.slice(1);
  else if (/^\d{9}$/.test(s)) s = '+233' + s;
  else if (/^233\d{9}$/.test(s)) s = '+' + s;
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

function isEmailish(s) { return /^\S+@\S+\.\S+$/.test(String(s || '')); }

// Decide whether a member can receive a given channel, respecting preferredChannel.
function canReceive(member, channel) {
  const pref = member.preferredChannel || 'NONE';
  if (pref === 'NONE') return false;
  if (channel === 'sms') return pref !== 'EMAIL_ONLY';
  if (channel === 'email') return pref !== 'SMS_ONLY';
  return true;
}

// Deferred real delivery — see module header.
async function sendSmsBatchStub() { return { ok: true, dryRun: true }; }
async function sendEmailEachStub() { return { ok: true, dryRun: true }; }

async function resolveAudience(db, { allMembers, orgIds, memberId }) {
  if (memberId) {
    const m = await db.member.findFirst({ where: { id: memberId, deletedAt: null } });
    return m ? [m] : [];
  }
  const membershipStatuses = ['MEMBER', 'REGULAR', 'VISITOR'];
  if (allMembers || !orgIds || orgIds.length === 0) {
    return db.member.findMany({
      where: { deletedAt: null, membershipStatus: { in: membershipStatuses } },
      orderBy: { lastName: 'asc' },
    });
  }
  return db.member.findMany({
    where: {
      deletedAt: null,
      membershipStatus: { in: membershipStatuses },
      orgMemberships: { some: { orgId: { in: orgIds } } },
    },
    orderBy: { lastName: 'asc' },
    distinct: ['id'],
  });
}

function register(app) {
  // --- Announcements ---
  app.get('/api/communications/announcements', requireAuth, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.announcement.findMany({ orderBy: { postedAt: 'desc' }, take: 50 });
    res.json(rows);
  }));

  app.post('/api/communications/announcements', requireAdmin, asyncHandler(async (req, res) => {
    const { title, body, audience } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
    const row = await res.locals.db.announcement.create({
      data: { title, body, audience: audience || 'all', postedBy: res.locals.user.id },
    });
    res.status(201).json(row);
  }));

  // --- Email settings (per-church; was a global singleton) ---
  app.get('/api/communications/email-settings', requireAuth, asyncHandler(async (req, res) => {
    const settings = await res.locals.db.emailSetting.findUnique({ where: { churchId: res.locals.churchId } });
    res.json(settings || { provider: 'SMTP', senderName: '', senderEmail: '', replyToEmail: '', testRecipientEmail: '' });
  }));

  app.put('/api/communications/email-settings', requireAdmin, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const provider = String(b.provider || 'SMTP').toUpperCase();
    const senderEmail = String(b.senderEmail || '').trim();
    const errors = [];
    if (!['SMTP', 'RESEND'].includes(provider)) errors.push('Choose a valid email provider.');
    if (!b.senderName || !String(b.senderName).trim()) errors.push('Sender name is required.');
    if (!isEmailish(senderEmail)) errors.push('Sender email must be a valid email address.');
    if (b.replyToEmail && !isEmailish(b.replyToEmail)) errors.push('Reply-to email must be valid.');
    if (b.testRecipientEmail && !isEmailish(b.testRecipientEmail)) errors.push('Test recipient email must be valid.');
    if (errors.length) return res.status(400).json({ errors });

    const data = {
      provider,
      senderName: String(b.senderName).trim(),
      senderEmail,
      replyToEmail: String(b.replyToEmail || '').trim(),
      testRecipientEmail: String(b.testRecipientEmail || '').trim(),
    };
    const settings = await res.locals.db.emailSetting.upsert({
      where: { churchId: res.locals.churchId },
      update: data,
      create: data,
    });
    res.json(settings);
  }));

  // --- Broadcasts ---
  app.get('/api/communications/audience-preview', requireAdmin, asyncHandler(async (req, res) => {
    const orgIds = req.query.orgIds ? String(req.query.orgIds).split(',').map(Number).filter(Boolean) : [];
    const memberId = req.query.memberId ? Number(req.query.memberId) : null;
    const allMembers = req.query.allMembers === '1';
    const recipients = await resolveAudience(res.locals.db, { allMembers, orgIds, memberId });

    let both = 0, smsOnly = 0, emailOnly = 0, none = 0, excludedPref = 0;
    for (const m of recipients) {
      if ((m.preferredChannel || 'NONE') === 'NONE') { excludedPref++; continue; }
      const hasPhone = !!normalizePhoneGH(m.mobilePhone) && canReceive(m, 'sms');
      const hasEmail = !!m.email && canReceive(m, 'email');
      if (hasPhone && hasEmail) both++;
      else if (hasPhone) smsOnly++;
      else if (hasEmail) emailOnly++;
      else none++;
    }
    res.json({
      count: recipients.length,
      reachableSms: both + smsOnly,
      reachableEmail: both + emailOnly,
      both, none, excludedPref,
    });
  }));

  app.post('/api/communications/broadcasts', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const { channel, subject, body } = req.body || {};
    if (!body || !['sms', 'email', 'both'].includes(channel)) {
      return res.status(400).json({ error: 'body and a valid channel (sms|email|both) are required' });
    }
    const orgIds = Array.isArray(req.body.orgIds) ? req.body.orgIds.map(Number).filter(Boolean) : [];
    const memberId = req.body.memberId ? Number(req.body.memberId) : null;
    const allMembers = req.body.allMembers === true || req.body.allMembers === '1';
    const ignorePrefs = req.body.ignorePrefs === true || req.body.ignorePrefs === '1';

    const audience = await resolveAudience(db, { allMembers, orgIds, memberId });
    if (!audience.length) return res.status(400).json({ error: 'No recipients matched that audience' });

    const audienceLabel = memberId
      ? `Single member: ${audience[0].firstName} ${audience[0].lastName}`
      : allMembers ? 'All members' : (orgIds.length === 1 ? `Org ${orgIds[0]}` : `${orgIds.length} organizations`);
    const orgIdForRow = (!memberId && !allMembers && orgIds.length === 1) ? orgIds[0] : null;

    const broadcast = await db.broadcast.create({
      data: {
        channel: channel.toUpperCase(),
        audienceLabel,
        orgId: orgIdForRow,
        subject: subject || null,
        body,
        totalRecipients: audience.length,
        status: 'SENDING',
        sentBy: res.locals.user.id,
      },
    });

    const recipientRows = [];
    for (const m of audience) {
      const prefAllowsSms = ignorePrefs || canReceive(m, 'sms');
      const prefAllowsEmail = ignorePrefs || canReceive(m, 'email');
      if (channel === 'sms' || channel === 'both') {
        const phone = normalizePhoneGH(m.mobilePhone);
        recipientRows.push({
          broadcastId: broadcast.id, memberId: m.id, channel: 'sms',
          destination: m.mobilePhone || '',
          status: !prefAllowsSms || !phone ? 'SKIPPED' : 'PENDING',
        });
      }
      if (channel === 'email' || channel === 'both') {
        recipientRows.push({
          broadcastId: broadcast.id, memberId: m.id, channel: 'email',
          destination: m.email || '',
          status: !prefAllowsEmail || !m.email ? 'SKIPPED' : 'PENDING',
        });
      }
    }
    await db.broadcastRecipient.createMany({ data: recipientRows });

    // Deferred real delivery (see module header) — always dry-run for now;
    // PENDING recipient rows above already correctly represent "would send".
    await Promise.all([sendSmsBatchStub(), sendEmailEachStub()]);

    const updated = await db.broadcast.update({
      where: { id: broadcast.id },
      data: { status: 'DRY_RUN', successfulSends: 0, failedSends: 0 },
    });
    res.status(201).json(updated);
  }));

  app.get('/api/communications/broadcasts', requireAuth, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.broadcast.findMany({ orderBy: { sentAt: 'desc' }, take: 100 });
    res.json(rows);
  }));

  app.get('/api/communications/broadcasts/:id', requireAuth, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const broadcast = await db.broadcast.findUnique({ where: { id } });
    if (!broadcast) return res.status(404).json({ error: 'Not found' });
    const recipients = await db.broadcastRecipient.findMany({
      where: { broadcastId: id },
      include: { member: { select: { firstName: true, lastName: true } } },
      orderBy: { status: 'desc' },
    });
    res.json({ ...broadcast, recipients });
  }));
}

module.exports = { register };
