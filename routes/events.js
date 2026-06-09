'use strict';
// Events: list, calendar, detail, check-in, RSVPs (incl. public links), QR.
// register(app, ctx). Block moved verbatim to preserve exact rendered output.
module.exports.register = function register(app, ctx) {
  const { db, esc, pageHero, statsRow, filterCard, listCard, table,
    requireAdmin, logActivity, layout, flash, PUBLIC_URL, ICON_EYE, ICON_PENCIL } = ctx;

  // ---------- shared event form ---------- //
  const EVENT_TYPES = ['service', 'prayer', 'bible_study', 'outreach', 'youth', 'wedding', 'funeral', 'baptism', 'confirmation', 'other'];
  function eventForm(ev, action) {
    const e = ev || {};
    const isoLocal = (v) => {
      if (!v) return '';
      // SQLite stores 'YYYY-MM-DD HH:MM[:SS]' — convert to datetime-local input value.
      return String(v).replace(' ', 'T').slice(0, 16);
    };
    return `<form class="form" method="post" action="${action}">
      <label>Title<input name="title" required value="${esc(e.title || '')}"></label>
      <label>Type<select name="event_type">
        ${EVENT_TYPES.map((t) => `<option value="${t}" ${t === (e.event_type || 'service') ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
      <label>Starts<input type="datetime-local" name="starts_at" required value="${esc(isoLocal(e.starts_at))}"></label>
      <label>Ends<input type="datetime-local" name="ends_at" value="${esc(isoLocal(e.ends_at))}"></label>
      <label>Location<input name="location" value="${esc(e.location || '')}"></label>
      <label class="wide">Notes<textarea name="notes" rows="2">${esc(e.notes || '')}</textarea></label>
      <div class="actions form-actions">
        <a class="btn ghost" href="${e.event_id ? `/events/${e.event_id}` : '/events'}">Cancel</a>
        <button type="submit">${e.event_id ? 'Save changes' : 'Save event'}</button>
      </div>
    </form>`;
  }

app.get('/events', (req, res) => {
  const q = (req.query.q || '').trim();
  const isAdmin = res.locals.isAdmin;
  const rows = db.prepare(`
    SELECT e.*, COUNT(a.member_id) attendees
    FROM events e LEFT JOIN attendance a USING(event_id)
    ${q ? 'WHERE e.title LIKE @q' : ''}
    GROUP BY e.event_id ORDER BY e.starts_at DESC`).all(q ? { q: `%${q}%` } : {});

  const totalEvents = db.prepare(`SELECT COUNT(*) c FROM events`).get().c;
  const upcoming = db.prepare(`SELECT COUNT(*) c FROM events WHERE starts_at >= datetime('now')`).get().c;
  const checkins = db.prepare(`SELECT COUNT(*) c FROM attendance`).get().c;

  const hero = pageHero('Events', 'Services, meetings and special events — schedule them and track attendance.');
  const stats = statsRow([
    { cls: 'gold', icon: '📅', value: totalEvents.toLocaleString(), label: 'Total Events' },
    { cls: 'green', icon: '⏭', value: upcoming.toLocaleString(), label: 'Upcoming' },
    { cls: 'blue', icon: '✓', value: checkins.toLocaleString(), label: 'Check-ins Recorded' },
  ], `<a class="btn ghost" href="/events/calendar">Calendar view</a>
      ${isAdmin ? `<a class="btn primary" href="/events/new">＋ New Event</a>` : ''}`);
  const filters = filterCard({ q, placeholder: 'Search events by title…' });

  const rowHtml = rows.map((r) => {
    const d = new Date(r.starts_at.replace(' ', 'T'));
    const when = Number.isNaN(d.getTime()) ? esc(r.starts_at)
      : d.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<tr>
      <td data-label="When">${when}</td>
      <td data-label="Event">
        <div><span class="evt-type">${esc(r.event_type)}</span></div>
        <a class="m-name" href="/events/${r.event_id}">${esc(r.title)}</a>
      </td>
      <td data-label="Location">${esc(r.location) || '<span class="muted-text">—</span>'}</td>
      <td data-label="Attendees"><span class="count-badge">${r.attendees}</span></td>
      <td data-label="Actions"><div class="row-actions">
        <a class="icon-btn view" href="/events/${r.event_id}" title="View" aria-label="View">${ICON_EYE}</a>
        ${isAdmin ? `<a class="icon-btn edit" href="/events/${r.event_id}/edit" title="Edit" aria-label="Edit">${ICON_PENCIL}</a>` : ''}
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
});

app.get('/events/calendar', (req, res) => {
  const now = new Date();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [y, mo] = month.split('-').map(Number);
  const first = new Date(y, mo - 1, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, mo, 0).getDate();
  const prev = new Date(y, mo - 2, 1);
  const next = new Date(y, mo, 1);
  const fmtMonthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const events = db.prepare(`SELECT event_id, title, event_type, starts_at FROM events
    WHERE substr(starts_at,1,7)=? ORDER BY starts_at`).all(month);
  const byDay = {};
  for (const e of events) { const d = Number(String(e.starts_at).slice(8, 10)); (byDay[d] = byDay[d] || []).push(e); }

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push('<div class="cal-cell blank"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const dayKey = `${month}-${String(d).padStart(2, '0')}`;
    const evs = (byDay[d] || []).map((e) =>
      `<a class="cal-ev" href="/events/${e.event_id}" title="${esc(e.title)}">${esc(e.title)}</a>`).join('');
    cells.push(`<div class="cal-cell${dayKey === todayKey ? ' today' : ''}"><div class="cal-day">${d}</div>${evs}</div>`);
  }
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('');
  const monthLabel = first.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  const body = `
    ${pageHero('Events Calendar', 'A month-at-a-glance view of every scheduled event.')}
    ${statsRow([{ cls: 'gold', icon: '🗓', value: events.length.toLocaleString(), label: `Events in ${monthLabel}` }],
      `<a class="btn ghost" href="/events">List view</a>
      ${res.locals.isAdmin ? `<a class="btn primary" href="/events/new">＋ New Event</a>` : ''}`)}
    <div class="card">
      <div class="card-head cal-nav">
        <a class="btn ghost" href="/events/calendar?month=${fmtMonthKey(prev)}">← ${prev.toLocaleString('en-GB', { month: 'short' })}</a>
        <h2>${esc(monthLabel)}</h2>
        <a class="btn ghost" href="/events/calendar?month=${fmtMonthKey(next)}">${next.toLocaleString('en-GB', { month: 'short' })} →</a>
      </div>
      <div class="calendar">${dows}${cells.join('')}</div>
    </div>`;
  res.page({ title: 'Events Calendar', active: '/events', noHeader: true, body });
});

app.get('/events/new', requireAdmin, (req, res) => {
  res.page({ title: 'New event', active: '/events', body: eventForm(null, '/events') });
});

app.get('/events/:id/edit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ev = db.prepare(`SELECT * FROM events WHERE event_id=?`).get(id);
  if (!ev) return res.status(404).send('Not found');
  res.page({
    title: `Edit · ${ev.title}`,
    active: '/events',
    body: `<p><a href="/events/${id}">← Back to event</a></p>${eventForm(ev, `/events/${id}/edit`)}`,
  });
});

app.post('/events/:id/edit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ev = db.prepare(`SELECT * FROM events WHERE event_id=?`).get(id);
  if (!ev) return res.status(404).send('Not found');
  const b = req.body;
  if (!b.title || !b.starts_at) {
    flash(req, 'Title and start time are required.');
    return res.redirect(`/events/${id}/edit`);
  }
  db.prepare(`
    UPDATE events
       SET title = @title,
           event_type = @event_type,
           starts_at = @starts_at,
           ends_at = @ends_at,
           location = @location,
           notes = @notes
     WHERE event_id = @id
  `).run({
    id,
    title: b.title,
    event_type: EVENT_TYPES.includes(b.event_type) ? b.event_type : 'service',
    starts_at: b.starts_at.replace('T', ' '),
    ends_at: b.ends_at ? b.ends_at.replace('T', ' ') : null,
    location: b.location || null,
    notes: b.notes || null,
  });
  logActivity('event_updated', `Event updated: ${b.title}`, `/events/${id}`, res.locals.user.user_id);
  flash(req, 'Event updated.', 'success');
  res.redirect(`/events/${id}`);
});

app.post('/events', requireAdmin, (req, res) => {
  const b = req.body;
  const info = db.prepare(`
    INSERT INTO events (title, event_type, starts_at, ends_at, location, notes, checkin_token)
    VALUES (@title, @event_type, @starts_at, @ends_at, @location, @notes, lower(hex(randomblob(16))))
  `).run({
    title: b.title, event_type: b.event_type || 'service',
    starts_at: b.starts_at.replace('T', ' '),
    ends_at: b.ends_at ? b.ends_at.replace('T', ' ') : null,
    location: b.location || null, notes: b.notes || null,
  });
  logActivity('event_created', `Event scheduled: ${b.title}`,
    `/events/${info.lastInsertRowid}`, res.locals.user.user_id);
  res.redirect(`/events/${info.lastInsertRowid}`);
});

app.get('/events/:id', (req, res) => {
  const id = Number(req.params.id);
  const ev = db.prepare(`SELECT * FROM events WHERE event_id=?`).get(id);
  if (!ev) return res.status(404).send('Not found');
  const attendees = db.prepare(`
    SELECT m.member_id, m.first_name || ' ' || m.last_name AS name, a.checked_in_at
    FROM attendance a JOIN members m USING(member_id)
    WHERE a.event_id=? ORDER BY m.last_name`).all(id);
  const others = db.prepare(`
    SELECT member_id, first_name || ' ' || last_name AS name
    FROM members WHERE member_id NOT IN (SELECT member_id FROM attendance WHERE event_id=?)
      AND membership_status IN ('member','regular','visitor')
      AND deleted_at IS NULL
    ORDER BY last_name`).all(id);

  const removeForm = (mid) => res.locals.isAdmin
    ? `<form method="post" action="/events/${id}/uncheck">
         <input type="hidden" name="member_id" value="${mid}">
         <button class="link" type="submit">remove</button>
       </form>`
    : '';
  const attendList = attendees.length
    ? `<ul class="check-list">${attendees.map((a) =>
        `<li><a href="/members/${a.member_id}">${esc(a.name)}</a>${removeForm(a.member_id)}</li>`).join('')}</ul>`
    : '<p>No one checked in yet.</p>';

  const otherOpts = others.map((o) =>
    `<option value="${o.member_id}">${esc(o.name)}</option>`).join('');

  const checkInPanel = res.locals.isAdmin
    ? `<h2>Check in</h2>
       <form method="post" action="/events/${id}/check">
         <select name="member_id" required><option value="">— pick a member —</option>${otherOpts}</select>
         <button type="submit">Check in</button>
       </form>`
    : '';

  const qrButton = res.locals.isAdmin
    ? `<p><a class="btn" href="/events/${id}/qr">📱 QR check-in page</a>
         <a class="btn ghost" href="/checkin/${esc(ev.checkin_token || '')}" target="_blank" rel="noopener">Preview self-check-in</a></p>`
    : '';

  // RSVPs
  const RSVP_LABELS = { going: 'Going', maybe: 'Maybe', no: "Can't" };
  const rsvps = db.prepare(`
    SELECT r.member_id, r.response, m.first_name || ' ' || m.last_name AS name
    FROM event_rsvps r JOIN members m USING(member_id)
    WHERE r.event_id=? AND m.deleted_at IS NULL
    ORDER BY r.response, m.last_name`).all(id);
  const rsvpCounts = { going: 0, maybe: 0, no: 0 };
  for (const r of rsvps) rsvpCounts[r.response] = (rsvpCounts[r.response] || 0) + 1;
  const rsvpPillClass = { going: 'pill-member', maybe: 'pill-visitor', no: 'pill-inactive' };
  const rsvpList = rsvps.length
    ? `<ul class="check-list">${rsvps.map((r) => `<li>
        <a href="/members/${r.member_id}">${esc(r.name)}</a>
        <span class="pill ${rsvpPillClass[r.response]}">${RSVP_LABELS[r.response]}</span>
        ${res.locals.isAdmin ? `<form method="post" action="/events/${id}/rsvp/remove">
          <input type="hidden" name="member_id" value="${r.member_id}">
          <button class="link" type="submit">remove</button></form>` : ''}
      </li>`).join('')}</ul>`
    : '<p class="muted-text">No responses yet.</p>';
  const rsvpAdmin = res.locals.isAdmin
    ? `<form method="post" action="/events/${id}/rsvp" class="filter-bar" style="margin-top:0.6rem">
         <select name="member_id" required style="flex:1;min-width:180px"><option value="">— pick a member —</option>${otherOpts}</select>
         <select name="response">${Object.entries(RSVP_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
         <button type="submit">Save RSVP</button>
       </form>` : '';
  const rsvpLink = `<p class="muted-text" style="margin-top:0.4rem">Public RSVP link:
    <a href="/rsvp/${esc(ev.checkin_token || '')}" target="_blank" rel="noopener">/rsvp/${esc(ev.checkin_token || '')}</a></p>`;

  // Attendance segment counts: editable per service.
  const men = ev.attendance_men ?? '';
  const women = ev.attendance_women ?? '';
  const children = ev.attendance_children ?? '';
  const totalEntered = ev.attendance_total ?? '';
  const hasCounts = (men !== '' || women !== '' || children !== '' || totalEntered !== '');
  const countsCard = `
    <div class="card attendance-counts-card" style="margin-bottom:1rem">
      <div class="card-head">
        <div>
          <h2>Attendance counts</h2>
          <div class="meta">Head-count for the service · editable</div>
        </div>
        ${hasCounts ? `<span class="pill pill-ok">⚬ Recorded</span>` : ''}
      </div>
      ${res.locals.isAdmin ? `<form method="post" action="/events/${id}/counts" class="counts-form" data-no-confirm="1">
        <label class="counts-field"><span>Men</span><input type="number" name="attendance_men" min="0" step="1" value="${esc(men)}"></label>
        <label class="counts-field"><span>Women</span><input type="number" name="attendance_women" min="0" step="1" value="${esc(women)}"></label>
        <label class="counts-field"><span>Children</span><input type="number" name="attendance_children" min="0" step="1" value="${esc(children)}"></label>
        <label class="counts-field counts-total"><span>Total</span><input type="number" name="attendance_total" min="0" step="1" value="${esc(totalEntered)}" placeholder="auto"></label>
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
        <div class="evt-type">${esc(ev.event_type)}</div>
        <div class="event-detail-meta">${esc(ev.starts_at)}${ev.location ? ` · ${esc(ev.location)}` : ''}</div>
      </div>
      ${res.locals.isAdmin ? `<a class="btn primary" href="/events/${id}/edit">✎ Edit event</a>` : ''}
    </div>
    ${qrButton}
    ${countsCard}
    <div class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>RSVPs</h2>
        <span class="meta">✅ ${rsvpCounts.going} going · 🤔 ${rsvpCounts.maybe} maybe · ✖ ${rsvpCounts.no} can't</span></div>
      ${rsvpList}
      ${rsvpAdmin}
      ${res.locals.isAdmin ? rsvpLink : ''}
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
  res.page({ title: ev.title, active: '/events', body });
});

app.post('/events/:id/counts', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ev = db.prepare(`SELECT event_id FROM events WHERE event_id=?`).get(id);
  if (!ev) return res.status(404).send('Not found');
  if (req.body.clear === '1') {
    db.prepare(`UPDATE events SET attendance_men=NULL, attendance_women=NULL,
      attendance_children=NULL, attendance_total=NULL WHERE event_id=?`).run(id);
    flash(req, 'Attendance counts cleared.', 'success');
    return res.redirect(`/events/${id}`);
  }
  const toIntOrNull = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(v);
    return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : null;
  };
  const men = toIntOrNull(req.body.attendance_men);
  const women = toIntOrNull(req.body.attendance_women);
  const children = toIntOrNull(req.body.attendance_children);
  let total = toIntOrNull(req.body.attendance_total);
  if (total === null && (men !== null || women !== null || children !== null)) {
    total = (men || 0) + (women || 0) + (children || 0);
  }
  db.prepare(`UPDATE events
    SET attendance_men = ?, attendance_women = ?, attendance_children = ?, attendance_total = ?
    WHERE event_id = ?`).run(men, women, children, total, id);
  logActivity('attendance_recorded',
    `Counts saved · M:${men ?? '—'} W:${women ?? '—'} C:${children ?? '—'} Total:${total ?? '—'}`,
    `/events/${id}`, res.locals.user.user_id);
  flash(req, 'Attendance counts saved.', 'success');
  res.redirect(`/events/${id}`);
});

app.post('/events/:id/rsvp', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const memberId = Number(req.body.member_id);
  const response = ['going', 'maybe', 'no'].includes(req.body.response) ? req.body.response : 'going';
  if (memberId) {
    db.prepare(`INSERT INTO event_rsvps (event_id, member_id, response) VALUES (?, ?, ?)
      ON CONFLICT(event_id, member_id) DO UPDATE SET response=excluded.response, responded_at=CURRENT_TIMESTAMP`)
      .run(id, memberId, response);
  }
  res.redirect(`/events/${id}`);
});
app.post('/events/:id/rsvp/remove', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM event_rsvps WHERE event_id=? AND member_id=?`).run(id, Number(req.body.member_id));
  res.redirect(`/events/${id}`);
});

// Public self-service RSVP (no login), keyed by the event's token.
app.get('/rsvp/:token', (req, res) => {
  const ev = db.prepare(`SELECT * FROM events WHERE checkin_token=?`).get(req.params.token);
  if (!ev) return res.status(404).send(layout({ title: 'RSVP link not recognized', bare: true, body: '<p>This RSVP link is not valid.</p>' }));
  const members = db.prepare(`SELECT member_id, first_name || ' ' || last_name AS name FROM members
    WHERE membership_status IN ('member','regular','visitor') AND deleted_at IS NULL ORDER BY last_name`).all();
  const opts = members.map((m) => `<option value="${m.member_id}">${esc(m.name)}</option>`).join('');
  const done = req.query.ok === '1';
  res.send(layout({
    title: `RSVP · ${ev.title}`, bare: true,
    body: `<p class="muted">${esc(ev.event_type)} · ${esc(ev.starts_at)}${ev.location ? ` · ${esc(ev.location)}` : ''}</p>
      ${done ? '<div class="flash flash-success">Thank you — your response has been recorded.</div>' : ''}
      <form class="form auth-form" method="post" action="/rsvp/${esc(req.params.token)}">
        <label class="wide">Your name<select name="member_id" required><option value="">— find your name —</option>${opts}</select></label>
        <label class="wide">Will you attend?
          <select name="response"><option value="going">Yes, I'll be there</option><option value="maybe">Maybe</option><option value="no">Can't make it</option></select></label>
        <div class="actions"><button type="submit">Send RSVP</button></div>
      </form>`,
  }));
});
app.post('/rsvp/:token', (req, res) => {
  const ev = db.prepare(`SELECT event_id FROM events WHERE checkin_token=?`).get(req.params.token);
  if (!ev) return res.status(404).send('Not found');
  const memberId = Number(req.body.member_id);
  const response = ['going', 'maybe', 'no'].includes(req.body.response) ? req.body.response : 'going';
  if (memberId) {
    db.prepare(`INSERT INTO event_rsvps (event_id, member_id, response) VALUES (?, ?, ?)
      ON CONFLICT(event_id, member_id) DO UPDATE SET response=excluded.response, responded_at=CURRENT_TIMESTAMP`)
      .run(ev.event_id, memberId, response);
  }
  res.redirect(`/rsvp/${req.params.token}?ok=1`);
});

app.post('/events/:id/check', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const member_id = Number(req.body.member_id);
  if (member_id) {
    db.prepare(`INSERT OR IGNORE INTO attendance (event_id, member_id) VALUES (?, ?)`).run(id, member_id);
  }
  res.redirect(`/events/${id}`);
});
app.post('/events/:id/uncheck', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM attendance WHERE event_id=? AND member_id=?`).run(id, Number(req.body.member_id));
  res.redirect(`/events/${id}`);
});

// ---------- QR check-in (admin display) ----------
app.get('/events/:id/qr', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const ev = db.prepare(`SELECT * FROM events WHERE event_id=?`).get(id);
  if (!ev) return res.status(404).send('Not found');
  if (!ev.checkin_token) {
    db.prepare(`UPDATE events SET checkin_token = lower(hex(randomblob(16))) WHERE event_id=?`).run(id);
    ev.checkin_token = db.prepare(`SELECT checkin_token FROM events WHERE event_id=?`).get(id).checkin_token;
  }
  const baseUrl = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/checkin/${ev.checkin_token}`;
  const QRCode = require('qrcode');
  let qrSvg;
  try {
    qrSvg = await QRCode.toString(url, { type: 'svg', width: 400, margin: 2, errorCorrectionLevel: 'M' });
  } catch (e) {
    return res.status(500).send('QR generation failed: ' + e.message);
  }
  const when = new Date(ev.starts_at);
  const dateStr = when.toLocaleString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const body = `
    <p><a href="/events/${id}">← Back to event</a></p>
    <div class="qr-page">
      <div class="qr-card">
        <div class="qr-meta">
          <h2>${esc(ev.title)}</h2>
          <p>${esc(dateStr)}</p>
          ${ev.location ? `<p class="muted-text">${esc(ev.location)}</p>` : ''}
        </div>
        <div class="qr-art">${qrSvg}</div>
        <p class="qr-instruct"><strong>Scan with your phone camera</strong> to check in.</p>
        <p class="qr-url muted-text">${esc(url)}</p>
      </div>
      <div class="qr-actions screen-only">
        <button onclick="window.print()">🖨 Print this QR sign</button>
        <a class="btn ghost" href="javascript:document.body.requestFullscreen ? document.body.requestFullscreen() : null">
          Full-screen (for display)
        </a>
      </div>
    </div>`;
  res.page({ title: `Check-in QR · ${ev.title}`, active: '/events', body });
});

// ---------- QR check-in (public) ----------
function findEventByToken(token) {
  return db.prepare(
    `SELECT event_id, title, starts_at, location, checkin_token
       FROM events WHERE checkin_token = ?`
  ).get(token);
}

app.get('/checkin/:token', (req, res) => {
  const ev = findEventByToken(req.params.token);
  if (!ev) {
    return res.status(404).send(layout({
      title: 'Check-in link not recognized', bare: true,
      body: '<p>This check-in QR is no longer valid. Please ask an usher for help.</p>',
    }));
  }
  const when = new Date(ev.starts_at).toLocaleString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  res.send(layout({
    title: `Check in · ${ev.title}`, bare: true,
    body: `
      <p class="muted-text">${esc(when)}${ev.location ? ' · ' + esc(ev.location) : ''}</p>
      <form method="post" action="/checkin/${esc(req.params.token)}" class="form auth-form">
        <label class="wide">Your name or Member ID
          <input name="q" required autofocus
                 placeholder="e.g. John Anderson or DMS-001">
        </label>
        <div class="actions"><button type="submit">Find me →</button></div>
      </form>`,
  }));
});

app.post('/checkin/:token', (req, res) => {
  const ev = findEventByToken(req.params.token);
  if (!ev) return res.status(404).send(layout({ title: 'Check-in link not recognized', bare: true,
    body: '<p>This check-in QR is no longer valid.</p>' }));

  // If the form posted a confirmed member_id, record attendance and finish.
  if (req.body.member_id) {
    const mid = Number(req.body.member_id);
    const m = db.prepare(
      `SELECT member_id, first_name, last_name FROM members WHERE member_id=? AND deleted_at IS NULL`
    ).get(mid);
    if (!m) return res.redirect(`/checkin/${req.params.token}`);
    db.prepare(`INSERT OR IGNORE INTO attendance (event_id, member_id) VALUES (?, ?)`).run(ev.event_id, mid);
    logActivity('attendance_recorded',
      `${m.first_name} ${m.last_name} self-checked in to ${ev.title}`,
      `/events/${ev.event_id}`, null);
    return res.send(layout({
      title: `✓ Checked in, ${m.first_name}`, bare: true,
      body: `
        <p style="font-size:1.1rem">Welcome, <strong>${esc(m.first_name)} ${esc(m.last_name)}</strong>.</p>
        <p>You're checked in to <strong>${esc(ev.title)}</strong>. Have a blessed time. 🙏</p>
        <p style="margin-top:1.25rem"><a href="/checkin/${esc(req.params.token)}">Check in another person</a></p>`,
    }));
  }

  // Otherwise, search by name or external_id.
  const q = (req.body.q || '').trim();
  if (!q) return res.redirect(`/checkin/${req.params.token}`);
  const like = `%${q}%`;
  const matches = db.prepare(`
    SELECT m.member_id, m.first_name, m.last_name, m.external_id,
           m.mobile_phone, m.bible_class_id,
           bc.name AS bible_class,
           (SELECT 1 FROM attendance a WHERE a.event_id=? AND a.member_id=m.member_id) AS already
    FROM members m
    LEFT JOIN ministries bc ON bc.ministry_id = m.bible_class_id
    WHERE m.deleted_at IS NULL
      AND (
        (m.first_name || ' ' || m.last_name) LIKE ?
        OR m.external_id = ?
        OR m.first_name LIKE ?
        OR m.last_name  LIKE ?
        OR m.mobile_phone LIKE ?
      )
    ORDER BY m.last_name LIMIT 12
  `).all(ev.event_id, like, q.toUpperCase(), like, like, like);

  if (matches.length === 0) {
    return res.send(layout({
      title: 'No match found', bare: true,
      body: `
        <p>No member found for <strong>"${esc(q)}"</strong>. Please ask an usher for help, or try a different spelling / your Member ID (e.g. DMS-007).</p>
        <p><a href="/checkin/${esc(req.params.token)}">← Try again</a></p>`,
    }));
  }

  if (matches.length === 1 && !matches[0].already) {
    // Auto-confirm the single match.
    db.prepare(`INSERT OR IGNORE INTO attendance (event_id, member_id) VALUES (?, ?)`).run(ev.event_id, matches[0].member_id);
    logActivity('attendance_recorded',
      `${matches[0].first_name} ${matches[0].last_name} self-checked in to ${ev.title}`,
      `/events/${ev.event_id}`, null);
    return res.send(layout({
      title: `✓ Checked in, ${matches[0].first_name}`, bare: true,
      body: `
        <p style="font-size:1.1rem">Welcome, <strong>${esc(matches[0].first_name)} ${esc(matches[0].last_name)}</strong>.</p>
        <p>You're checked in to <strong>${esc(ev.title)}</strong>. Have a blessed time. 🙏</p>
        <p style="margin-top:1.25rem"><a href="/checkin/${esc(req.params.token)}">Check in another person</a></p>`,
    }));
  }

  // Otherwise show a list to pick from.
  const list = matches.map((m) => `
    <form method="post" action="/checkin/${esc(req.params.token)}" class="checkin-pick">
      <input type="hidden" name="member_id" value="${m.member_id}">
      <button type="submit" ${m.already ? 'disabled' : ''}>
        <div class="who">
          <div class="name">${esc(m.first_name)} ${esc(m.last_name)}</div>
          <div class="meta">${esc(m.external_id) || ''}${m.bible_class ? ' · ' + esc(m.bible_class) : ''}</div>
        </div>
        <span class="pick-tag">${m.already ? '✓ already checked in' : 'Tap to check in'}</span>
      </button>
    </form>`).join('');

  res.send(layout({
    title: matches.length === 1 ? 'Already checked in' : 'Pick your name', bare: true,
    body: `
      <p class="muted-text">${matches.length} match${matches.length === 1 ? '' : 'es'} for "${esc(q)}":</p>
      ${list}
      <p style="margin-top:1rem"><a href="/checkin/${esc(req.params.token)}">← Search again</a></p>`,
  }));
});

// Keep old URLs working.
app.get('/contributions', (_, res) => res.redirect('/finance'));
};
