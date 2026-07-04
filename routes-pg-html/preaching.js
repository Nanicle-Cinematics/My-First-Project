'use strict';
// Phase 8a: HTML port of routes/preaching.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/preaching.js (JSON stays at /api/preaching,
// this is the bare-path HTML surface) — see the Phase 8 plan's conversion
// recipe. Reuses lib/views.js/lib/format.js verbatim; data access is copied
// from routes-pg/preaching.js's already-correct Prisma queries.
//
// Role model: admin-only writes (res.locals.user.role === 'ADMIN'), matching
// routes-pg/preaching.js — NOT the original's three-tier admin/editor/viewer
// isAdmin (admin-or-editor) distinction. See the Phase 8 plan's "Recommended
// architecture" section for why.
//
// Phase 9a: /preaching/:id/remind (SMS/email reminder) is now wired in via
// lib/delivery.js (see routes-pg/preaching.js's sendPreachingReminder).

const asyncHandler = require('../lib/async-handler');
const { esc, fmtDate, fmtPreachDate } = require('../lib/format');
const { pageHero, statsRow } = require('../lib/views');
const { logActivity } = require('../lib/tenant-activity');
const { sendPreachingReminder } = require('../routes-pg/preaching');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

// Prisma DateTime fields come back as JS Date objects, not the ISO text
// strings SQLite stored — lib/format.js's fmtDate/fmtPreachDate expect a
// string (or falsy). Normalize at this boundary rather than touching the
// shared formatter.
function iso(d) {
  if (!d) return '';
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
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
  async function preachingMemberOptions(db, selectedId) {
    const members = await db.member.findMany({
      where: { deletedAt: null },
      orderBy: { lastName: 'asc' },
      select: { id: true, firstName: true, lastName: true },
    });
    return '<option value="">— guest / not a member —</option>' +
      members.map((m) =>
        `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${esc(m.firstName + ' ' + m.lastName)}</option>`).join('');
  }

  async function preachingForm(db, plan = {}, action) {
    const options = await preachingMemberOptions(db, plan.memberId);
    return `
      <form class="form" method="post" action="${action}">
        <label>Date<input type="date" name="preachDate" required value="${esc(iso(plan.preachDate))}"></label>
        <label>Service / occasion<input name="serviceLabel" placeholder="e.g. Sunday 9:00 AM service" value="${esc(plan.serviceLabel || '')}"></label>
        <label>Preacher (member)<select name="memberId">${options}</select></label>
        <div class="wide-cell"><span class="hint">If the preacher is a guest (not a member), leave the dropdown on
          <em>guest</em> and fill in their name and contact below so reminders can still reach them.</span></div>
        <label>Guest name<input name="preacherName" value="${esc(plan.preacherName || '')}"></label>
        <label>Guest phone<input name="preacherPhone" value="${esc(plan.preacherPhone || '')}"></label>
        <label>Guest email<input type="email" name="preacherEmail" value="${esc(plan.preacherEmail || '')}"></label>
        <label>Topic / theme<input name="topic" value="${esc(plan.topic || '')}"></label>
        <label>Scripture<input name="scripture" placeholder="e.g. John 3:16" value="${esc(plan.scripture || '')}"></label>
        <label class="wide-cell">Notes<textarea name="notes" rows="2">${esc(plan.notes || '')}</textarea></label>
        <div class="actions form-actions">
          <a class="btn ghost" href="/preaching">Cancel</a>
          <button type="submit">Save</button>
        </div>
      </form>`;
  }

  function preacherLabel(p) {
    if (p.memberId && p.member) return `<a href="/members/${p.memberId}">${esc(p.member.firstName + ' ' + p.member.lastName)}</a>`;
    if (p.preacherName) return `${esc(p.preacherName)} <span class="muted-text">(guest)</span>`;
    return '<span class="muted-text">— unassigned —</span>';
  }
  function preachingHasContact(p) {
    if (p.memberId) return !!(p.member && (p.member.mobilePhone || p.member.email));
    return !!(p.preacherPhone || p.preacherEmail);
  }

  app.get('/preaching', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const today = new Date(); today.setHours(0, 0, 0, 0);
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

    const next = upcoming[0];
    const assigned = upcoming.filter((p) => !!(p.memberId || p.preacherName)).length;
    const contactReady = upcoming.filter(preachingHasContact).length;

    const reminderFlash = {
      ok: 'Preaching reminder sent.',
      dry: 'Reminder logged as a dry run — SMS/email are not configured, so nothing was actually delivered.',
      nocontact: 'Could not send: that preacher has no phone or email on file.',
      fail: 'The reminder could not be sent. Check the SMS / email settings.',
    }[req.query.reminder];

    const nextCard = next
      ? `<section class="card" style="margin-bottom:1rem;border-left:4px solid var(--accent)">
           <div class="card-head"><h2>Next up</h2><span class="meta">${esc(fmtPreachDate(iso(next.preachDate)))}</span></div>
           <p style="font-size:1.05rem"><strong>${preacherLabel(next)}</strong>
             ${next.serviceLabel ? ` · ${esc(next.serviceLabel)}` : ''}</p>
           ${next.topic ? `<p>Topic: ${esc(next.topic)}${next.scripture ? ` · ${esc(next.scripture)}` : ''}</p>` : ''}
           ${next.reminderSentAt ? `<p class="muted-text">Reminder last sent ${esc(iso(next.reminderSentAt).replace('T', ' '))}.</p>` : ''}
           ${isAdmin ? (preachingHasContact(next)
             ? `<form method="post" action="/preaching/${next.id}/remind" onsubmit="return confirm('Send an SMS / email reminder to this preacher?')">
                  <button class="btn primary" type="submit">＋ Send reminder</button>
                </form>`
             : '<p class="muted-text">Add a phone or email for this preacher to enable reminders.</p>') : ''}
         </section>`
      : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">📣</div>
          <h3>No upcoming preaching appointments</h3>
          <p>${isAdmin ? 'Use the form below to schedule the first one.' : 'Once the preaching plan is set, it will appear here.'}</p>
        </div>`;

    const newForm = isAdmin
      ? `<details class="form-toggle" id="schedule" style="margin-bottom:1rem">
           <summary><strong>＋ Schedule a preaching appointment</strong></summary>
           <div style="margin-top:0.75rem">${await preachingForm(db, {}, '/preaching')}</div>
         </details>`
      : '';

    const renderRows = (list) => list.map((p) => `
      <tr>
        <td>${esc(fmtPreachDate(iso(p.preachDate)))}</td>
        <td>${preacherLabel(p)}</td>
        <td>${esc(p.serviceLabel || '—')}</td>
        <td>${p.topic ? esc(p.topic) : '—'}</td>
        ${isAdmin ? `<td style="white-space:nowrap">
          <a href="/preaching/${p.id}/edit" class="link">Edit</a>
          ${preachingHasContact(p)
            ? `<form method="post" action="/preaching/${p.id}/remind" class="inline"
                    onsubmit="return confirm('Send an SMS / email reminder to this preacher?')">
                 <button type="submit" class="link">Remind</button>
               </form>` : ''}
          <form method="post" action="/preaching/${p.id}/delete" class="inline"
                onsubmit="return confirm('Archive this appointment? It will be hidden but not permanently deleted.')">
            <button type="submit" class="link">Archive</button>
          </form>
        </td>` : ''}
      </tr>`).join('');

    const head = `<thead><tr><th>Date</th><th>Preacher</th><th>Service</th><th>Topic</th>${isAdmin ? '<th></th>' : ''}</tr></thead>`;
    const upcomingTable = upcoming.length
      ? `<section class="card" style="margin-bottom:1rem"><div class="card-head"><h2>Upcoming</h2><span class="meta">${upcoming.length} scheduled</span></div><table>${head}<tbody>${renderRows(upcoming)}</tbody></table></section>`
      : '';
    const pastTable = past.length
      ? `<section class="card"><div class="card-head"><h2>Recent (past)</h2><span class="meta">Last ${past.length}</span></div><table>${head}<tbody>${renderRows(past)}</tbody></table></section>`
      : '';

    res.page({
      title: 'Preaching Plan',
      subtitle: 'Schedule of preaching appointments.',
      active: '/preaching',
      noHeader: true,
      flash: reminderFlash,
      body: `${pageHero('Preaching Plan', 'Upcoming preaching assignments, guest contacts and reminder readiness.')}
        ${statsRow([
          { cls: 'gold', icon: '🎤', value: upcoming.length.toLocaleString(), label: 'Upcoming' },
          { cls: 'green', icon: '✓', value: assigned.toLocaleString(), label: 'Assigned' },
          { cls: 'blue', icon: '✉', value: contactReady.toLocaleString(), label: 'Reminder Ready' },
        ])}
        ${nextCard}${newForm}${upcomingTable}${pastTable}`,
    });
  }));

  app.post('/preaching/:id/remind', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const plan = await db.preachingPlan.findFirst({
      where: { id, deletedAt: null },
      include: { member: { select: { firstName: true, lastName: true, mobilePhone: true, email: true, unsubscribeToken: true } } },
    });
    if (!plan) return res.redirect('/preaching');
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const r = await sendPreachingReminder(db, plan, res.locals.user.id, church.name);
    if (!r.ok) return res.redirect('/preaching?reminder=nocontact');
    if (!r.hadPhone && !r.hadEmail) return res.redirect('/preaching?reminder=nocontact');
    if (r.dryRun) return res.redirect('/preaching?reminder=dry');
    const delivered = (r.smsOk === true) || (r.emailOk === true);
    return res.redirect('/preaching?reminder=' + (delivered ? 'ok' : 'fail'));
  }));

  app.post('/preaching', requireAdmin, asyncHandler(async (req, res) => {
    const v = parsePlanBody(req.body || {});
    if (!v.preachDate || Number.isNaN(v.preachDate.getTime())) return res.redirect('/preaching');
    const plan = await res.locals.db.preachingPlan.create({ data: v });
    await logActivity(res.locals.db, 'preaching_scheduled',
      `Scheduled preaching for ${fmtPreachDate(iso(plan.preachDate))}`, '/preaching', res.locals.user.id);
    res.redirect('/preaching');
  }));

  app.get('/preaching/:id/edit', requireAdmin, asyncHandler(async (req, res) => {
    const plan = await res.locals.db.preachingPlan.findFirst({
      where: { id: Number(req.params.id), deletedAt: null },
    });
    if (!plan) return res.status(404).send('Appointment not found');
    res.page({
      title: 'Edit Preaching Appointment', active: '/preaching', noHeader: true,
      body: `${pageHero('Edit Preaching Appointment', '')}${await preachingForm(res.locals.db, plan, `/preaching/${plan.id}`)}`,
    });
  }));

  app.post('/preaching/:id', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const v = parsePlanBody(req.body || {});
    if (!v.preachDate || Number.isNaN(v.preachDate.getTime())) return res.redirect(`/preaching/${id}/edit`);
    try {
      await res.locals.db.preachingPlan.update({
        where: { id },
        data: { ...v, updatedAt: new Date() },
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect('/preaching');
  }));

  app.post('/preaching/:id/delete', requireAdmin, asyncHandler(async (req, res) => {
    try {
      await res.locals.db.preachingPlan.update({
        where: { id: Number(req.params.id) },
        data: { deletedAt: new Date() },
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect('/preaching');
  }));
}

module.exports = { register };
