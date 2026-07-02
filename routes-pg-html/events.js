'use strict';
// Phase 8c: HTML port of routes/events.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/events.js (JSON at /api/events, this is the
// bare-path HTML surface).
//
// DEFERRED, matching routes-pg/events.js's own header comment exactly: the
// calendar view, QR code generation, and the PUBLIC token-based self-service
// check-in (/checkin/:token) + RSVP (/rsvp/:token) flows — those need a
// genuinely new "resolve tenant from a bare token, no session" pattern this
// rewrite hasn't built yet. Everything else (admin CRUD, counts, RSVP
// management, check-in/out) is ported below.
//
// Members aren't HTML-ported yet (Phase 8d) — /members/:id links here will
// 404 until then. Expected, documented in the Phase 8 plan's roadmap.

const crypto = require('crypto');
const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, filterCard, listCard, ICON_EYE, ICON_PENCIL } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');

const EVENT_TYPES = ['SERVICE', 'PRAYER', 'BIBLE_STUDY', 'OUTREACH', 'YOUTH', 'WEDDING', 'FUNERAL', 'BAPTISM', 'CONFIRMATION', 'OTHER'];
const RSVP_RESPONSES = ['GOING', 'MAYBE', 'NO'];
const RSVP_LABELS = { GOING: 'Going', MAYBE: 'Maybe', NO: "Can't" };
const RSVP_PILL_CLASS = { GOING: 'pill-member', MAYBE: 'pill-visitor', NO: 'pill-inactive' };

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

function iso(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? '' : dt.toISOString().slice(0, 16);
}
function fmtDt(d) { return iso(d).replace('T', ' '); }

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

function eventForm(ev, action) {
  const e = ev || {};
  return `<form class="form" method="post" action="${action}">
    <label>Title<input name="title" required value="${esc(e.title || '')}"></label>
    <label>Type<select name="eventType">
      ${EVENT_TYPES.map((t) => `<option value="${t}" ${t === (e.eventType || 'SERVICE') ? 'selected' : ''}>${t}</option>`).join('')}
    </select></label>
    <label>Starts<input type="datetime-local" name="startsAt" required value="${esc(iso(e.startsAt))}"></label>
    <label>Ends<input type="datetime-local" name="endsAt" value="${esc(iso(e.endsAt))}"></label>
    <label>Location<input name="location" value="${esc(e.location || '')}"></label>
    <label class="wide">Notes<textarea name="notes" rows="2">${esc(e.notes || '')}</textarea></label>
    <div class="actions form-actions">
      <a class="btn ghost" href="${e.id ? `/events/${e.id}` : '/events'}">Cancel</a>
      <button type="submit">${e.id ? 'Save changes' : 'Save event'}</button>
    </div>
  </form>`;
}

function register(app) {
  app.get('/events', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const q = (req.query.q || '').trim();

    const [rows, totalEvents, upcoming, checkins] = await Promise.all([
      db.event.findMany({
        where: q ? { title: { contains: q, mode: 'insensitive' } } : {},
        orderBy: { startsAt: 'desc' },
        include: { _count: { select: { attendance: true } } },
      }),
      db.event.count(),
      db.event.count({ where: { startsAt: { gte: new Date() } } }),
      db.attendance.count(),
    ]);

    const hero = pageHero('Events', 'Services, meetings and special events — schedule them and track attendance.');
    const stats = statsRow([
      { cls: 'gold', icon: '📅', value: totalEvents.toLocaleString(), label: 'Total Events' },
      { cls: 'green', icon: '⏭', value: upcoming.toLocaleString(), label: 'Upcoming' },
      { cls: 'blue', icon: '✓', value: checkins.toLocaleString(), label: 'Check-ins Recorded' },
    ], isAdmin ? `<a class="btn primary" href="/events/new">＋ New Event</a>` : '');
    const filters = filterCard({ q, placeholder: 'Search events by title…' });

    const rowHtml = rows.map((r) => {
      const when = r.startsAt.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `<tr>
        <td data-label="When">${esc(when)}</td>
        <td data-label="Event">
          <div><span class="evt-type">${esc(r.eventType)}</span></div>
          <a class="m-name" href="/events/${r.id}">${esc(r.title)}</a>
        </td>
        <td data-label="Location">${esc(r.location) || '<span class="muted-text">—</span>'}</td>
        <td data-label="Attendees"><span class="count-badge">${r._count.attendance}</span></td>
        <td data-label="Actions"><div class="row-actions">
          <a class="icon-btn view" href="/events/${r.id}" title="View" aria-label="View">${ICON_EYE}</a>
          ${isAdmin ? `<a class="icon-btn edit" href="/events/${r.id}/edit" title="Edit" aria-label="Edit">${ICON_PENCIL}</a>` : ''}
        </div></td>
      </tr>`;
    }).join('');

    const list = listCard({
      title: 'Events', count: rows.length, countLabel: 'events',
      inner: rows.length ? `<table class="data-table members-table">
          <thead><tr><th>When</th><th>Event</th><th>Location</th><th>Attendees</th><th>Actions</th></tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>` : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">📅</div>
          <h3>${q ? `No events match "${esc(q)}"` : 'No events scheduled yet'}</h3>
          <p>${q ? 'Try a different search term, or schedule a new event.' : 'Add your first event and it will appear here.'}</p>
          ${isAdmin ? '<a class="btn primary" href="/events/new">＋ New Event</a>' : ''}
          ${q ? '<div style="margin-top:0.6rem"><a class="link" href="/events">Clear search →</a></div>' : ''}
        </div>`,
    });

    res.page({ title: 'Events', active: '/events', noHeader: true, body: `${hero}${stats}${filters}${list}` });
  }));

  app.get('/events/new', requireAdmin, (req, res) => {
    res.page({ title: 'New event', active: '/events', noHeader: true, body: `${pageHero('New event', '')}${eventForm(null, '/events')}` });
  });

  app.get('/events/:id/edit', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const ev = await res.locals.db.event.findUnique({ where: { id } });
    if (!ev) return res.status(404).send('Not found');
    res.page({
      title: `Edit · ${ev.title}`, active: '/events', noHeader: true,
      body: `${pageHero(`Edit · ${ev.title}`, '')}<p><a href="/events/${id}">← Back to event</a></p>${eventForm(ev, `/events/${id}/edit`)}`,
    });
  }));

  app.post('/events/:id/edit', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const v = parseEventBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      flash(req, 'Title and start time are required.');
      return res.redirect(`/events/${id}/edit`);
    }
    try {
      await res.locals.db.event.update({ where: { id }, data: v });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    await logActivity(res.locals.db, 'event_updated', `Event updated: ${v.title}`, `/events/${id}`, res.locals.user.id);
    flash(req, 'Event updated.', 'success');
    res.redirect(`/events/${id}`);
  }));

  app.post('/events', requireAdmin, asyncHandler(async (req, res) => {
    const v = parseEventBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      flash(req, 'Title and start time are required.');
      return res.redirect('/events/new');
    }
    const ev = await res.locals.db.event.create({ data: { ...v, checkinToken: crypto.randomBytes(16).toString('hex') } });
    await logActivity(res.locals.db, 'event_created', `Event scheduled: ${v.title}`, `/events/${ev.id}`, res.locals.user.id);
    res.redirect(`/events/${ev.id}`);
  }));

  app.get('/events/:id', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const id = Number(req.params.id);
    const ev = await db.event.findUnique({ where: { id } });
    if (!ev) return res.status(404).send('Not found');

    const [attendees, others, rsvps] = await Promise.all([
      db.attendance.findMany({
        where: { eventId: id }, include: { member: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { member: { lastName: 'asc' } },
      }),
      db.member.findMany({
        where: { deletedAt: null, membershipStatus: { in: ['MEMBER', 'REGULAR', 'VISITOR'] }, attendance: { none: { eventId: id } } },
        orderBy: { lastName: 'asc' }, select: { id: true, firstName: true, lastName: true },
      }),
      db.eventRsvp.findMany({
        where: { eventId: id }, include: { member: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: [{ response: 'asc' }, { member: { lastName: 'asc' } }],
      }),
    ]);

    const removeForm = (mid) => isAdmin
      ? `<form method="post" action="/events/${id}/uncheck">
           <input type="hidden" name="memberId" value="${mid}">
           <button class="link" type="submit">remove</button>
         </form>` : '';
    const attendList = attendees.length
      ? `<ul class="check-list">${attendees.map((a) => `<li><a href="/members/${a.member.id}">${esc(a.member.firstName + ' ' + a.member.lastName)}</a>${removeForm(a.member.id)}</li>`).join('')}</ul>`
      : '<p>No one checked in yet.</p>';

    const otherOpts = others.map((o) => `<option value="${o.id}">${esc(o.firstName + ' ' + o.lastName)}</option>`).join('');
    const checkInPanel = isAdmin
      ? `<h2>Check in</h2>
         <form method="post" action="/events/${id}/check">
           <select name="memberId" required><option value="">— pick a member —</option>${otherOpts}</select>
           <button type="submit">Check in</button>
         </form>` : '';

    const rsvpCounts = { GOING: 0, MAYBE: 0, NO: 0 };
    for (const r of rsvps) rsvpCounts[r.response] = (rsvpCounts[r.response] || 0) + 1;
    const rsvpList = rsvps.length
      ? `<ul class="check-list">${rsvps.map((r) => `<li>
          <a href="/members/${r.member.id}">${esc(r.member.firstName + ' ' + r.member.lastName)}</a>
          <span class="pill ${RSVP_PILL_CLASS[r.response]}">${RSVP_LABELS[r.response]}</span>
          ${isAdmin ? `<form method="post" action="/events/${id}/rsvp/remove">
            <input type="hidden" name="memberId" value="${r.member.id}">
            <button class="link" type="submit">remove</button></form>` : ''}
        </li>`).join('')}</ul>`
      : '<p class="muted-text">No responses yet.</p>';
    const rsvpAdmin = isAdmin
      ? `<form method="post" action="/events/${id}/rsvp" class="filter-bar" style="margin-top:0.6rem">
           <select name="memberId" required style="flex:1;min-width:180px"><option value="">— pick a member —</option>${otherOpts}</select>
           <select name="response">${RSVP_RESPONSES.map((v) => `<option value="${v}">${RSVP_LABELS[v]}</option>`).join('')}</select>
           <button type="submit">Save RSVP</button>
         </form>` : '';

    const men = ev.attendanceMen ?? '';
    const women = ev.attendanceWomen ?? '';
    const children = ev.attendanceChildren ?? '';
    const totalEntered = ev.attendanceTotal ?? '';
    const hasCounts = (men !== '' || women !== '' || children !== '' || totalEntered !== '');
    const countsCard = `
      <div class="card attendance-counts-card" style="margin-bottom:1rem">
        <div class="card-head">
          <div><h2>Attendance counts</h2><div class="meta">Head-count for the service · editable</div></div>
          ${hasCounts ? `<span class="pill pill-ok">⚬ Recorded</span>` : ''}
        </div>
        ${isAdmin ? `<form method="post" action="/events/${id}/counts" class="counts-form" data-no-confirm="1">
          <label class="counts-field"><span>Men</span><input type="number" name="attendanceMen" min="0" step="1" value="${esc(men)}"></label>
          <label class="counts-field"><span>Women</span><input type="number" name="attendanceWomen" min="0" step="1" value="${esc(women)}"></label>
          <label class="counts-field"><span>Children</span><input type="number" name="attendanceChildren" min="0" step="1" value="${esc(children)}"></label>
          <label class="counts-field counts-total"><span>Total</span><input type="number" name="attendanceTotal" min="0" step="1" value="${esc(totalEntered)}" placeholder="auto"></label>
          <div class="counts-actions">
            <button class="btn primary" type="submit">${hasCounts ? 'Update counts' : 'Save counts'}</button>
            ${hasCounts ? `<button class="btn ghost" type="submit" name="clear" value="1" formnovalidate>Clear</button>` : ''}
          </div>
          <p class="muted-text counts-hint">Leave Total blank and we'll add Men + Women + Children for you.</p>
        </form>` : `<dl class="counts-readonly">
          <div><dt>Men</dt><dd>${men === '' ? '—' : esc(men)}</dd></div>
          <div><dt>Women</dt><dd>${women === '' ? '—' : esc(women)}</dd></div>
          <div><dt>Children</dt><dd>${children === '' ? '—' : esc(children)}</dd></div>
          <div><dt>Total</dt><dd>${totalEntered === '' ? '—' : esc(totalEntered)}</dd></div>
        </dl>`}
      </div>`;

    const body = `
      <div class="event-detail-head">
        <div>
          <div class="evt-type">${esc(ev.eventType)}</div>
          <div class="event-detail-meta">${esc(fmtDt(ev.startsAt))}${ev.location ? ` · ${esc(ev.location)}` : ''}</div>
        </div>
        ${isAdmin ? `<a class="btn primary" href="/events/${id}/edit">✎ Edit event</a>` : ''}
      </div>
      ${countsCard}
      <div class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>RSVPs</h2>
          <span class="meta">✅ ${rsvpCounts.GOING} going · 🤔 ${rsvpCounts.MAYBE} maybe · ✖ ${rsvpCounts.NO} can't</span></div>
        ${rsvpList}
        ${rsvpAdmin}
      </div>
      <div class="two-col">
        <section>
          <h2>Attendees (${attendees.length})</h2>
          ${attendList}
        </section>
        <section>
          ${checkInPanel}
          ${ev.notes ? `<h3>Notes</h3><p>${esc(ev.notes)}</p>` : ''}
        </section>
      </div>`;
    res.page({ title: ev.title, active: '/events', noHeader: true, body: `${pageHero(ev.title, '')}${body}` });
  }));

  app.post('/events/:id/counts', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const ev = await res.locals.db.event.findUnique({ where: { id } });
    if (!ev) return res.status(404).send('Not found');
    if (req.body.clear === '1') {
      await res.locals.db.event.update({ where: { id }, data: { attendanceMen: null, attendanceWomen: null, attendanceChildren: null, attendanceTotal: null } });
      flash(req, 'Attendance counts cleared.', 'success');
      return res.redirect(`/events/${id}`);
    }
    const men = toIntOrNull(req.body.attendanceMen);
    const women = toIntOrNull(req.body.attendanceWomen);
    const children = toIntOrNull(req.body.attendanceChildren);
    let total = toIntOrNull(req.body.attendanceTotal);
    if (total === null && (men !== null || women !== null || children !== null)) total = (men || 0) + (women || 0) + (children || 0);
    await res.locals.db.event.update({ where: { id }, data: { attendanceMen: men, attendanceWomen: women, attendanceChildren: children, attendanceTotal: total } });
    await logActivity(res.locals.db, 'attendance_recorded', `Counts saved · M:${men ?? '—'} W:${women ?? '—'} C:${children ?? '—'} Total:${total ?? '—'}`, `/events/${id}`, res.locals.user.id);
    flash(req, 'Attendance counts saved.', 'success');
    res.redirect(`/events/${id}`);
  }));

  app.post('/events/:id/rsvp', requireAdmin, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    const response = RSVP_RESPONSES.includes(req.body.response) ? req.body.response : 'GOING';
    if (memberId) {
      await res.locals.db.eventRsvp.upsert({
        where: { eventId_memberId: { eventId, memberId } },
        update: { response, respondedAt: new Date() },
        create: { eventId, memberId, response },
      });
    }
    res.redirect(`/events/${eventId}`);
  }));

  app.post('/events/:id/rsvp/remove', requireAdmin, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    try {
      await res.locals.db.eventRsvp.delete({ where: { eventId_memberId: { eventId, memberId: Number(req.body.memberId) } } });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect(`/events/${eventId}`);
  }));

  app.post('/events/:id/check', requireAdmin, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    if (memberId) {
      await res.locals.db.attendance.upsert({ where: { eventId_memberId: { eventId, memberId } }, update: {}, create: { eventId, memberId } });
    }
    res.redirect(`/events/${eventId}`);
  }));

  app.post('/events/:id/uncheck', requireAdmin, asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    try {
      await res.locals.db.attendance.delete({ where: { eventId_memberId: { eventId, memberId: Number(req.body.memberId) } } });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect(`/events/${eventId}`);
  }));
}

module.exports = { register };
