'use strict';
// Phase 8c: HTML port of routes/communications.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/communications.js (JSON at
// /api/communications/..., this is the bare-path HTML surface).
//
// SCOPE matches routes-pg/communications.js exactly: announcements CRUD,
// per-church email settings (view/edit only), and full broadcast
// audience-resolution + recipient bookkeeping. Real SMS/email DELIVERY is
// NOT wired in (always dry-run, per routes-pg/communications.js's own
// deferral) — so the original's provider-readiness banners (ARKESEL_API_KEY/
// SMTP_HOST env checks) and "Send Test Email" button are dropped here too;
// there is no live delivery path backing them yet.
//
// Role model: admin-only writes. The original's separate isOwner-only gate
// on email settings is folded into the same admin-only-writes gate — no
// "owner" concept was ever ported to the Postgres UserRole enum.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

const PREF_LABELS = { EITHER: 'Both', SMS_ONLY: 'SMS only', EMAIL_ONLY: 'Email only', NONE: 'Do not contact' };

// Verbatim port of routes-pg/communications.js's normalizePhoneGH/canReceive/isEmailish.
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
function canReceive(member, channel) {
  const pref = member.preferredChannel || 'NONE';
  if (pref === 'NONE') return false;
  if (channel === 'sms') return pref !== 'EMAIL_ONLY';
  if (channel === 'email') return pref !== 'SMS_ONLY';
  return true;
}

async function resolveAudience(db, { allMembers, orgIds, memberId }) {
  if (memberId) {
    const m = await db.member.findFirst({ where: { id: memberId, deletedAt: null } });
    return m ? [m] : [];
  }
  const membershipStatuses = ['MEMBER', 'REGULAR', 'VISITOR'];
  if (allMembers || !orgIds || orgIds.length === 0) {
    return db.member.findMany({ where: { deletedAt: null, membershipStatus: { in: membershipStatuses } }, orderBy: { lastName: 'asc' } });
  }
  return db.member.findMany({
    where: { deletedAt: null, membershipStatus: { in: membershipStatuses }, orgMemberships: { some: { orgId: { in: orgIds } } } },
    orderBy: { lastName: 'asc' }, distinct: ['id'],
  });
}

function parseOrgChoice(b) {
  const memberId = Number(b.member_id) || null;
  if (memberId) return { allMembers: false, orgIds: [], memberId };
  if (b.all_members === '1') return { allMembers: true, orgIds: [], memberId: null };
  let raw = b.org_ids;
  if (!raw) return { allMembers: false, orgIds: [], memberId: null };
  const ids = (Array.isArray(raw) ? raw : [raw]).map((x) => Number(x)).filter(Boolean);
  return { allMembers: false, orgIds: ids, memberId: null };
}

function audienceLabel(orgs, choice, recipients = []) {
  if (choice.memberId) return recipients[0] ? `Single member: ${recipients[0].firstName} ${recipients[0].lastName}` : 'Single member';
  if (choice.allMembers) return 'All members';
  if (!choice.orgIds.length) return 'None';
  const names = orgs.filter((o) => choice.orgIds.includes(o.id)).map((o) => o.name);
  return names.length === 1 ? names[0] : names.join(' + ');
}

function fmtDt(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? '' : dt.toISOString().slice(0, 16).replace('T', ' ');
}

function register(app) {
  app.get('/communications', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';

    const [announcements, announcementCount, broadcastCount, contactable, failedRecipients] = await Promise.all([
      db.announcement.findMany({ orderBy: { postedAt: 'desc' }, take: 50 }),
      db.announcement.count(),
      db.broadcast.count(),
      db.member.count({ where: { deletedAt: null, preferredChannel: { not: 'NONE' } } }),
      db.broadcastRecipient.count({ where: { status: 'FAILED' } }),
    ]);
    // Announcement.postedBy/Broadcast.sentBy are plain scalar user-id
    // columns, not Prisma relations — batch-resolve display names separately.
    const posterIds = [...new Set(announcements.map((a) => a.postedBy).filter(Boolean))];
    const posters = posterIds.length
      ? await db.user.findMany({ where: { id: { in: posterIds } }, select: { id: true, displayName: true, username: true } })
      : [];
    const posterName = (id) => { const u = posters.find((p) => p.id === id); return u ? (u.displayName || u.username) : 'system'; };

    const newForm = isAdmin
      ? `<div class="card" style="margin-bottom:1rem">
           <div class="card-head"><h2>Post an announcement</h2></div>
           <form class="form" method="post" action="/communications" style="box-shadow:none;border:0;padding:0">
             <label class="wide">Title<input name="title" required></label>
             <label class="wide">Message<textarea name="body" rows="4" required></textarea></label>
             <label>Audience<select name="audience">
               <option value="all">Everyone</option>
               <option value="members">Members only</option>
             </select></label>
             <div class="actions form-actions"><button type="submit">Post announcement</button></div>
           </form>
         </div>` : '';
    const list = announcements.length
      ? announcements.map((a) => `
          <div class="card" style="margin-bottom:0.75rem">
            <div class="card-head">
              <h2>${esc(a.title)}</h2>
              <span class="meta">${esc(fmtDt(a.postedAt))}</span>
            </div>
            <p>${esc(a.body)}</p>
            <p class="muted-text">— ${esc(posterName(a.postedBy))} · audience: ${esc(a.audience)}</p>
          </div>`).join('')
      : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">✉</div>
          <h3>No announcements yet</h3>
          <p>${isAdmin ? 'Use the form above to post your first announcement.' : 'Once an admin posts an announcement it will appear here.'}</p>
        </div>`;

    const broadcastCta = isAdmin
      ? `<div class="page-actions">
           <a class="btn primary" href="/communications/broadcast">＋ Send SMS/email broadcast</a>
           <a class="btn ghost" href="/communications/broadcasts">View broadcast history</a>
           <a class="btn ghost" href="/communications/email-settings">Email settings</a>
         </div>` : '';

    res.page({
      title: 'Communications', active: '/communications', noHeader: true,
      body: `${pageHero('Communications', 'Announcements, broadcast history and member messaging readiness. Deliveries currently run in dry-run mode (no live SMS/email provider is wired in yet).')}
        ${statsRow([
          { cls: 'gold', icon: '✉', value: announcementCount.toLocaleString(), label: 'Announcements' },
          { cls: 'green', icon: '📣', value: broadcastCount.toLocaleString(), label: 'Broadcasts' },
          { cls: 'blue', icon: '✓', value: contactable.toLocaleString(), label: 'Contactable Members' },
          { cls: failedRecipients ? 'orange' : 'green', icon: '!', value: failedRecipients.toLocaleString(), label: 'Failed Recipients' },
        ])}
        ${broadcastCta}
        ${newForm}<div class="card-head" style="padding-top:0.5rem"><h2>Recent announcements</h2></div>${list}`,
    });
  }));

  app.post('/communications', requireAdmin, asyncHandler(async (req, res) => {
    const { title, body, audience } = req.body || {};
    if (!title || !body) return res.redirect('/communications');
    await res.locals.db.announcement.create({ data: { title, body, audience: audience || 'all', postedBy: res.locals.user.id } });
    await logActivity(res.locals.db, 'announcement', `New announcement: ${title}`, '/communications', res.locals.user.id);
    res.redirect('/communications');
  }));

  app.get('/communications/broadcast', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const [orgs, memberChoices] = await Promise.all([
      db.organization.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      db.member.findMany({ where: { deletedAt: null }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], take: 500, select: { id: true, firstName: true, lastName: true, email: true, mobilePhone: true, preferredChannel: true } }),
    ]);
    const choice = parseOrgChoice(req.query);
    const audienceChosen = choice.allMembers || choice.orgIds.length > 0 || !!choice.memberId;
    const recipients = audienceChosen ? await resolveAudience(db, choice) : [];

    let bothCount = 0, smsOnlyCount = 0, emailOnlyCount = 0, noneCount = 0, excludedPref = 0;
    for (const r of recipients) {
      if ((r.preferredChannel || 'NONE') === 'NONE') { excludedPref++; continue; }
      const hasPhone = !!normalizePhoneGH(r.mobilePhone) && canReceive(r, 'sms');
      const hasEmail = !!r.email && canReceive(r, 'email');
      if (hasPhone && hasEmail) bothCount++;
      else if (hasPhone) smsOnlyCount++;
      else if (hasEmail) emailOnlyCount++;
      else noneCount++;
    }
    const reachableSms = bothCount + smsOnlyCount;
    const reachableEmail = bothCount + emailOnlyCount;

    const statusBanner = `<div class="flash"><strong>Dry-run mode.</strong> No live SMS/email provider is wired in yet — broadcasts are logged with a full recipient breakdown but nothing is actually delivered.</div>`;

    const audienceForm = `
      <form method="get" action="/communications/broadcast" class="card" style="margin-bottom:1rem">
        <h2 style="margin-top:0">Audience</h2>
        <label class="check" style="background:none;padding:0;margin-bottom:0.5rem">
          <input type="checkbox" name="all_members" value="1" ${choice.allMembers ? 'checked' : ''}>
          <strong>All members</strong> <span class="muted-text">(every active member)</span>
        </label>
        <label>Single member SMS/email
          <select name="member_id">
            <option value="">Choose one member…</option>
            ${memberChoices.map((m) => `
              <option value="${m.id}" ${choice.memberId === m.id ? 'selected' : ''}>
                ${esc(m.firstName + ' ' + m.lastName)}${m.mobilePhone ? ` · ${esc(m.mobilePhone)}` : ''}${m.email ? ` · ${esc(m.email)}` : ''}
              </option>`).join('')}
          </select>
          <span class="hint">Choose one member to send an individual SMS/email instead of a group broadcast.</span>
        </label>
        <p class="muted-text" style="margin:0.5rem 0">Or choose organization audiences:</p>
        <div class="check-grid" style="opacity:${choice.allMembers ? '0.5' : '1'}">
          ${orgs.map((o) => `
            <label class="check">
              <input type="checkbox" name="org_ids" value="${o.id}"
                ${choice.orgIds.includes(o.id) ? 'checked' : ''}
                ${choice.allMembers ? 'disabled' : ''}>
              ${esc(o.name)}
            </label>`).join('')}
        </div>
        <div class="actions" style="margin-top:0.75rem"><button type="submit">Load audience</button></div>
      </form>`;

    const previewSection = audienceChosen ? `
      <h2>Audience preview · ${recipients.length} member${recipients.length === 1 ? '' : 's'}</h2>
      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
        <div class="stat"><div class="ico green">✓</div><div><div class="label">Reachable by SMS</div><div class="value">${reachableSms}</div></div></div>
        <div class="stat"><div class="ico blue">✉</div><div><div class="label">Reachable by email</div><div class="value">${reachableEmail}</div></div></div>
        <div class="stat"><div class="ico purple">📲</div><div><div class="label">Both</div><div class="value">${bothCount}</div></div></div>
        <div class="stat"><div class="ico orange">⚠</div><div><div class="label">No contact info</div><div class="value">${noneCount}</div></div></div>
        <div class="stat"><div class="ico orange">🚫</div><div><div class="label">Excluded (opted out)</div><div class="value">${excludedPref}</div></div></div>
      </div>
      ${recipients.length ? `<details style="margin:0.75rem 0 1rem">
        <summary>Show recipient list</summary>
        ${table(['Name', 'Phone', 'Email', 'Preference'],
          recipients.map((r) => [esc(r.firstName + ' ' + r.lastName),
            normalizePhoneGH(r.mobilePhone) || `<span class="muted-text">${esc(r.mobilePhone) || '—'}</span>`,
            esc(r.email) || '<span class="muted-text">—</span>',
            esc(PREF_LABELS[r.preferredChannel || 'NONE'] || 'Do not contact')]))}
      </details>` : ''}
    ` : '';

    const audienceHidden = choice.memberId
      ? `<input type="hidden" name="member_id" value="${choice.memberId}">`
      : (choice.allMembers
        ? `<input type="hidden" name="all_members" value="1">`
        : choice.orgIds.map((id) => `<input type="hidden" name="org_ids" value="${id}">`).join(''));

    const composeForm = audienceChosen && recipients.length ? `
      <h2>Compose message</h2>
      <form class="form" method="post" action="/communications/broadcast">
        ${audienceHidden}
        <label>Channel<select name="channel" required>
          <option value="sms">SMS only (${reachableSms})</option>
          <option value="email">Email only (${reachableEmail})</option>
          <option value="both" selected>Both (${reachableSms} SMS · ${reachableEmail} email)</option>
        </select></label>
        <label>Email subject<input name="subject" placeholder="(required for email)"></label>
        <label class="wide">Message body<textarea name="body" rows="5" required maxlength="900" placeholder="Keep it under 160 chars for a single SMS."></textarea></label>
        <p class="muted-text wide" style="margin:0">Members with only a phone receive just the SMS; members with only an email receive just the email. Members missing both are skipped.</p>
        <label class="wide check" style="background:var(--danger-soft);padding:0.5rem 0.75rem;border-radius:8px;margin-top:0.5rem">
          <input type="checkbox" name="ignore_prefs" value="1">
          <strong>Override member preferences (urgent only)</strong> — sends to opted-out members too.
        </label>
        <div class="actions">
          <button type="submit" onclick="return confirm('Send this broadcast?')">📣 Send broadcast</button>
        </div>
      </form>` : '';

    res.page({
      title: 'Send broadcast', active: '/communications', noHeader: true,
      body: `${pageHero('Send broadcast', '')}${statusBanner}${audienceForm}${previewSection}${composeForm}
        <p style="margin-top:1.5rem"><a href="/communications/broadcasts">View broadcast history →</a></p>`,
    });
  }));

  app.post('/communications/broadcast', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const { channel, subject, body } = req.body || {};
    if (!body || !['sms', 'email', 'both'].includes(channel)) return res.redirect('/communications/broadcast');

    const orgs = await db.organization.findMany({ where: { active: true }, select: { id: true, name: true } });
    const choice = parseOrgChoice(req.body);
    if (!choice.memberId && !choice.allMembers && choice.orgIds.length === 0) return res.redirect('/communications/broadcast');
    const audience = await resolveAudience(db, choice);
    if (!audience.length) return res.redirect('/communications/broadcast');
    const audienceLbl = audienceLabel(orgs, choice, audience);
    const orgIdForRow = (!choice.memberId && !choice.allMembers && choice.orgIds.length === 1) ? choice.orgIds[0] : null;
    const ignorePrefs = req.body.ignore_prefs === '1';

    const broadcast = await db.broadcast.create({
      data: {
        channel: channel.toUpperCase(), audienceLabel: audienceLbl, orgId: orgIdForRow,
        subject: subject || null, body, totalRecipients: audience.length, status: 'SENDING', sentBy: res.locals.user.id,
      },
    });

    const recipientRows = [];
    for (const m of audience) {
      const prefAllowsSms = ignorePrefs || canReceive(m, 'sms');
      const prefAllowsEmail = ignorePrefs || canReceive(m, 'email');
      if (channel === 'sms' || channel === 'both') {
        const phone = normalizePhoneGH(m.mobilePhone);
        recipientRows.push({ broadcastId: broadcast.id, memberId: m.id, channel: 'sms', destination: m.mobilePhone || '', status: !prefAllowsSms || !phone ? 'SKIPPED' : 'PENDING' });
      }
      if (channel === 'email' || channel === 'both') {
        recipientRows.push({ broadcastId: broadcast.id, memberId: m.id, channel: 'email', destination: m.email || '', status: !prefAllowsEmail || !m.email ? 'SKIPPED' : 'PENDING' });
      }
    }
    await db.broadcastRecipient.createMany({ data: recipientRows });
    // Deferred real delivery (see module header) — always dry-run for now.
    await db.broadcast.update({ where: { id: broadcast.id }, data: { status: 'DRY_RUN', successfulSends: 0, failedSends: 0 } });

    await logActivity(res.locals.db, 'announcement', `Broadcast to ${audienceLbl}: ${audience.length} recipient(s) [dry_run]`, `/communications/broadcasts/${broadcast.id}`, res.locals.user.id);
    res.redirect(`/communications/broadcasts/${broadcast.id}`);
  }));

  app.get('/communications/broadcasts', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const rows = await db.broadcast.findMany({ orderBy: { sentAt: 'desc' }, take: 100 });
    const senderIds = [...new Set(rows.map((b) => b.sentBy).filter(Boolean))];
    const senders = senderIds.length
      ? await db.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, displayName: true, username: true } })
      : [];
    const senderName = (id) => { const u = senders.find((s) => s.id === id); return u ? (u.displayName || u.username) : '—'; };
    const body = `
      <div class="page-actions"><a class="btn primary" href="/communications/broadcast">＋ Compose new broadcast</a></div>
      ${rows.length ? table(['Sent', 'Channel', 'Audience', 'Recipients', '✓ sent', '✗ failed', 'Status', 'By'],
        rows.map((b) => [esc(fmtDt(b.sentAt)), esc(b.channel),
          `<a href="/communications/broadcasts/${b.id}">${esc(b.audienceLabel)}</a>`,
          b.totalRecipients, b.successfulSends, b.failedSends,
          `<span class="pill pill-${esc(b.status.toLowerCase())}">${esc(b.status.replace('_', ' ').toLowerCase())}</span>`,
          esc(senderName(b.sentBy))]))
        : '<p class="muted-text">No broadcasts sent yet.</p>'}`;
    res.page({ title: 'Broadcast history', active: '/communications', noHeader: true, body: `${pageHero('Broadcast history', '')}${body}` });
  }));

  app.get('/communications/broadcasts/:id', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = await db.broadcast.findUnique({ where: { id } });
    if (!b) return res.status(404).send('Not found');
    const sender = b.sentBy ? await db.user.findUnique({ where: { id: b.sentBy }, select: { displayName: true, username: true } }) : null;
    const recipients = await db.broadcastRecipient.findMany({
      where: { broadcastId: id },
      include: { member: { select: { firstName: true, lastName: true } } },
      orderBy: { status: 'desc' },
    });
    const body = `
      <div class="card">
        <div class="card-head">
          <h2>${esc(b.audienceLabel)} · ${esc(b.channel)}</h2>
          <span class="meta">${esc(fmtDt(b.sentAt))} · by ${esc((sender && (sender.displayName || sender.username)) || '—')}</span>
        </div>
        <dl class="stats">
          <dt>Status</dt><dd><span class="pill pill-${esc(b.status.toLowerCase())}">${esc(b.status.replace('_', ' ').toLowerCase())}</span></dd>
          <dt>Recipients</dt><dd>${b.totalRecipients} (${b.successfulSends} sent, ${b.failedSends} failed)</dd>
          ${b.subject ? `<dt>Subject</dt><dd>${esc(b.subject)}</dd>` : ''}
        </dl>
        <h3>Message</h3>
        <pre style="white-space:pre-wrap;background:var(--soft);padding:0.75rem;border-radius:8px">${esc(b.body)}</pre>
      </div>
      <h2>Per-recipient log</h2>
      ${table(['Name', 'Channel', 'Destination', 'Status', 'Error'],
        recipients.map((r) => [(r.member ? esc(r.member.firstName + ' ' + r.member.lastName) : '—'), esc(r.channel),
          esc(r.destination) || '<span class="muted-text">—</span>',
          `<span class="pill pill-${esc(r.status.toLowerCase())}">${esc(r.status.toLowerCase())}</span>`,
          esc(r.error) || '']))}`;
    res.page({ title: 'Broadcast detail', active: '/communications', noHeader: true, body: `${pageHero('Broadcast detail', '')}${body}` });
  }));

  app.get('/communications/email-settings', requireAdmin, asyncHandler(async (req, res) => {
    const settings = await res.locals.db.emailSetting.findUnique({ where: { churchId: res.locals.churchId } })
      || { provider: 'SMTP', senderName: '', senderEmail: '', replyToEmail: '', testRecipientEmail: '' };
    const body = `
      <div class="card">
        <h2>Delivery profile</h2>
        <dl class="stats">
          <dt>Provider</dt><dd>${esc(settings.provider)} <span class="pill pill-dry_run">dry-run only</span></dd>
          <dt>Sender</dt><dd>${esc(settings.senderName || '')} &lt;${esc(settings.senderEmail || '')}&gt;</dd>
          <dt>Reply-to</dt><dd>${esc(settings.replyToEmail || '—')}</dd>
          <dt>Test recipient</dt><dd>${esc(settings.testRecipientEmail || '—')}</dd>
        </dl>
        <p class="muted-text">No live SMS/email provider is wired in yet — these settings are stored for when delivery is turned on.</p>
      </div>
      <div class="card">
        <h2>Configure email</h2>
        <form class="form" method="post" action="/communications/email-settings">
          <label>Email provider
            <select name="provider" required>
              <option value="SMTP"${settings.provider === 'SMTP' ? ' selected' : ''}>SMTP</option>
              <option value="RESEND"${settings.provider === 'RESEND' ? ' selected' : ''}>Resend API</option>
            </select>
          </label>
          <label>Sender name<input name="senderName" value="${esc(settings.senderName || '')}" required></label>
          <label>Sender email<input type="email" name="senderEmail" value="${esc(settings.senderEmail || '')}" required></label>
          <label>Reply-to email<input type="email" name="replyToEmail" value="${esc(settings.replyToEmail || '')}" placeholder="Optional"></label>
          <label>Test recipient email<input type="email" name="testRecipientEmail" value="${esc(settings.testRecipientEmail || '')}" placeholder="Optional"></label>
          <div class="actions"><button type="submit">Save settings</button></div>
        </form>
      </div>`;
    res.page({ title: 'Email Settings', active: '/communications', noHeader: true, body: `${pageHero('Email Settings', '')}${body}` });
  }));

  app.post('/communications/email-settings', requireAdmin, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const provider = String(b.provider || 'SMTP').toUpperCase();
    const senderEmail = String(b.senderEmail || '').trim();
    const errors = [];
    if (!['SMTP', 'RESEND'].includes(provider)) errors.push('Choose a valid email provider.');
    if (!b.senderName || !String(b.senderName).trim()) errors.push('Sender name is required.');
    if (!isEmailish(senderEmail)) errors.push('Sender email must be a valid email address.');
    if (b.replyToEmail && !isEmailish(b.replyToEmail)) errors.push('Reply-to email must be valid.');
    if (b.testRecipientEmail && !isEmailish(b.testRecipientEmail)) errors.push('Test recipient email must be valid.');
    if (errors.length) { flash(req, errors.join(' ')); return res.redirect('/communications/email-settings'); }

    const data = {
      provider, senderName: String(b.senderName).trim(), senderEmail,
      replyToEmail: String(b.replyToEmail || '').trim(), testRecipientEmail: String(b.testRecipientEmail || '').trim(),
    };
    await res.locals.db.emailSetting.upsert({ where: { churchId: res.locals.churchId }, update: data, create: data });
    await logActivity(res.locals.db, 'settings', 'Updated email settings', '/communications/email-settings', res.locals.user.id);
    flash(req, 'Email settings saved.', 'success');
    res.redirect('/communications/email-settings');
  }));
}

module.exports = { register };
