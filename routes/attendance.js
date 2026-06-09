'use strict';
// Attendance overview + self-contained add/edit of service events.
// The Attendance menu lets admins record Men / Women / Children / Total
// counts for a given service WITHOUT redirecting to the Events page.
module.exports.register = function register(app, ctx) {
  const { db, esc, sparkline, table, pageHero, statsRow, listCard,
    requireAdmin, logActivity, flash } = ctx;

  // ---------- helpers ---------- //
  const isoLocal = (v) => (v ? String(v).replace(' ', 'T').slice(0, 16) : '');
  const toIntOrNull = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(v);
    return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : null;
  };
  function deriveTotal(men, women, children, total) {
    if (total !== null) return total;
    if (men === null && women === null && children === null) return null;
    return (men || 0) + (women || 0) + (children || 0);
  }
  function serviceForm(ev, action, opts = {}) {
    const e = ev || {};
    const isEdit = !!e.event_id;
    return `<form class="form attendance-service-form" method="post" action="${action}">
      <label class="wide">
        <span>Service title <span class="req-star">*</span></span>
        <input name="title" required value="${esc(e.title || '')}"
               placeholder="e.g. Sunday Worship">
      </label>
      <label>
        <span>Date &amp; time <span class="req-star">*</span></span>
        <input type="datetime-local" name="starts_at" required
               value="${esc(isoLocal(e.starts_at))}">
      </label>
      <label>
        <span>Location</span>
        <input name="location" value="${esc(e.location || '')}"
               placeholder="e.g. Sanctuary">
      </label>
      <div class="wide-cell">
        <h3 class="form-section">Attendance counts</h3>
        <p class="muted-text" style="margin:0 0 0.6rem;font-size:0.86rem">
          Leave Total blank to let the system add Men + Women + Children for you.
        </p>
      </div>
      <div class="wide-cell attendance-counts-card" style="padding:0;border:0;box-shadow:none;background:transparent">
        <div class="counts-form">
          <label class="counts-field"><span>Men</span>
            <input type="number" name="attendance_men" min="0" step="1"
                   value="${esc(e.attendance_men ?? '')}"></label>
          <label class="counts-field"><span>Women</span>
            <input type="number" name="attendance_women" min="0" step="1"
                   value="${esc(e.attendance_women ?? '')}"></label>
          <label class="counts-field"><span>Children</span>
            <input type="number" name="attendance_children" min="0" step="1"
                   value="${esc(e.attendance_children ?? '')}"></label>
          <label class="counts-field counts-total"><span>Total</span>
            <input type="number" name="attendance_total" min="0" step="1"
                   value="${esc(e.attendance_total ?? '')}" placeholder="auto">
          </label>
        </div>
      </div>
      <label class="wide">
        <span>Notes</span>
        <textarea name="notes" rows="2"
                  placeholder="Optional notes about the service.">${esc(e.notes || '')}</textarea>
      </label>
      <div class="actions form-actions">
        <a class="btn ghost" href="/attendance">Cancel</a>
        <button type="submit">${isEdit ? 'Save changes' : 'Add service'}</button>
      </div>
      ${opts.extraButtons || ''}
    </form>`;
  }

  // ---------- /attendance — overview ---------- //
  app.get('/attendance', (req, res) => {
    const isAdmin = res.locals.isAdmin;
    const services = db.prepare(`
      SELECT e.event_id, e.title, e.starts_at, e.location,
             COUNT(a.member_id) attendees,
             e.attendance_men, e.attendance_women, e.attendance_children, e.attendance_total
      FROM   events e LEFT JOIN attendance a USING(event_id)
      WHERE  e.event_type='service'
      GROUP BY e.event_id ORDER BY e.starts_at DESC LIMIT 20`).all();
    const trend = services.slice(0, 8).reverse()
      .map((r, i) => ({ label: `Wk ${i + 1}`, value: r.attendance_total ?? r.attendees }));
    const avg = trend.length
      ? Math.round(trend.reduce((a, b) => a + b.value, 0) / trend.length) : 0;
    const total = services.reduce((a, b) => a + (b.attendance_total ?? b.attendees), 0);
    const recorded = services.filter((s) => s.attendance_total !== null && s.attendance_total !== undefined).length;

    const hero = pageHero('Attendance',
      'Track service participation. Record Men / Women / Children counts per service — add or edit a service right here.');
    const stats = statsRow([
      { cls: 'gold', icon: '✓', value: avg.toLocaleString(), label: `Avg attendance (last ${trend.length})` },
      { cls: 'green', icon: '📅', value: services.length.toLocaleString(), label: 'Services tracked' },
      { cls: 'blue', icon: '🧮', value: recorded.toLocaleString(), label: 'Counts recorded' },
      { cls: 'purple', icon: '👥', value: total.toLocaleString(), label: 'Total attendance' },
    ], isAdmin ? '<a class="btn primary" href="/attendance/new">＋ Add Service</a>' : '');

    const trendCard = `<div class="card">
      <div class="card-head"><h2>Attendance trend</h2><span class="meta">Last ${trend.length} services</span></div>
      ${sparkline(trend)}
    </div>`;

    const cell = (v) => v == null || v === '' ? '<span class="muted-text">—</span>' : `<strong>${esc(String(v))}</strong>`;
    const recent = services.length
      ? table(
          ['When', 'Title', 'Men', 'Women', 'Children', 'Total', 'Actions'],
          services.map((s) => [
            esc(s.starts_at),
            isAdmin
              ? `<a href="/attendance/${s.event_id}/edit">${esc(s.title)}</a>`
              : esc(s.title),
            cell(s.attendance_men),
            cell(s.attendance_women),
            cell(s.attendance_children),
            cell(s.attendance_total),
            isAdmin
              ? `<a class="btn ghost" href="/attendance/${s.event_id}/edit">Edit →</a>`
              : '<span class="muted-text">—</span>',
          ]))
      : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">✓</div>
          <h3>No services tracked yet</h3>
          <p>Add your first service to start recording attendance counts.</p>
          ${isAdmin ? '<a class="btn primary" href="/attendance/new">＋ Add Service</a>' : ''}
        </div>`;
    const recentCard = listCard({
      title: 'Recent services',
      count: services.length,
      countLabel: 'services',
      inner: recent,
    });

    res.page({
      title: 'Attendance',
      active: '/attendance',
      noHeader: true,
      body: `${hero}${stats}${trendCard}${recentCard}`,
    });
  });

  // ---------- /attendance/new — add a service + counts in one go ---------- //
  app.get('/attendance/new', requireAdmin, (req, res) => {
    res.page({
      title: 'New service',
      active: '/attendance',
      body: serviceForm(null, '/attendance'),
    });
  });

  app.post('/attendance', requireAdmin, (req, res) => {
    const b = req.body;
    if (!b.title || !b.starts_at) {
      flash(req, 'Service title and date are required.');
      return res.redirect('/attendance/new');
    }
    const men = toIntOrNull(b.attendance_men);
    const women = toIntOrNull(b.attendance_women);
    const children = toIntOrNull(b.attendance_children);
    const total = deriveTotal(men, women, children, toIntOrNull(b.attendance_total));
    const info = db.prepare(`
      INSERT INTO events
        (title, event_type, starts_at, location, notes, checkin_token,
         attendance_men, attendance_women, attendance_children, attendance_total)
      VALUES (@title, 'service', @starts_at, @location, @notes,
              lower(hex(randomblob(16))),
              @men, @women, @children, @total)
    `).run({
      title: b.title,
      starts_at: b.starts_at.replace('T', ' '),
      location: b.location || null,
      notes: b.notes || null,
      men, women, children, total,
    });
    logActivity('attendance_recorded',
      `Service "${b.title}" added · M:${men ?? '—'} W:${women ?? '—'} C:${children ?? '—'} Total:${total ?? '—'}`,
      `/attendance/${info.lastInsertRowid}/edit`,
      res.locals.user.user_id);
    flash(req, 'Service added.', 'success');
    res.redirect('/attendance');
  });

  // ---------- /attendance/:id/edit — edit existing service + counts ---------- //
  app.get('/attendance/:id/edit', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const ev = db.prepare(`SELECT * FROM events WHERE event_id=?`).get(id);
    if (!ev) return res.status(404).send('Not found');
    const extra = `<div class="form-extra-actions" style="grid-column:1/-1;margin-top:0.6rem">
      <form method="post" action="/attendance/${id}/delete"
            onsubmit="return confirm('Delete this service and its counts? This cannot be undone.')"
            style="display:inline">
        <button class="danger" type="submit">Delete service</button>
      </form>
    </div>`;
    res.page({
      title: `Edit service · ${ev.title}`,
      active: '/attendance',
      body: serviceForm(ev, `/attendance/${id}`, { extraButtons: extra }),
    });
  });

  app.post('/attendance/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const ev = db.prepare(`SELECT event_id FROM events WHERE event_id=?`).get(id);
    if (!ev) return res.status(404).send('Not found');
    const b = req.body;
    if (!b.title || !b.starts_at) {
      flash(req, 'Service title and date are required.');
      return res.redirect(`/attendance/${id}/edit`);
    }
    const men = toIntOrNull(b.attendance_men);
    const women = toIntOrNull(b.attendance_women);
    const children = toIntOrNull(b.attendance_children);
    const total = deriveTotal(men, women, children, toIntOrNull(b.attendance_total));
    db.prepare(`UPDATE events
      SET title = @title,
          starts_at = @starts_at,
          location = @location,
          notes = @notes,
          attendance_men = @men,
          attendance_women = @women,
          attendance_children = @children,
          attendance_total = @total
      WHERE event_id = @id`).run({
      id,
      title: b.title,
      starts_at: b.starts_at.replace('T', ' '),
      location: b.location || null,
      notes: b.notes || null,
      men, women, children, total,
    });
    logActivity('attendance_recorded',
      `Counts updated for "${b.title}" · M:${men ?? '—'} W:${women ?? '—'} C:${children ?? '—'} Total:${total ?? '—'}`,
      `/attendance/${id}/edit`,
      res.locals.user.user_id);
    flash(req, 'Service updated.', 'success');
    res.redirect('/attendance');
  });

  app.post('/attendance/:id/delete', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const ev = db.prepare(`SELECT title FROM events WHERE event_id=? AND event_type='service'`).get(id);
    if (!ev) return res.status(404).send('Not found');
    db.transaction(() => {
      db.prepare(`DELETE FROM attendance WHERE event_id=?`).run(id);
      db.prepare(`DELETE FROM events WHERE event_id=?`).run(id);
    })();
    logActivity('attendance_recorded',
      `Service "${ev.title}" deleted`, '/attendance', res.locals.user.user_id);
    flash(req, 'Service deleted.', 'success');
    res.redirect('/attendance');
  });
};
