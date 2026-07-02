'use strict';
// Phase 8c: HTML port of routes/attendance.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/attendance.js (JSON at /api/attendance,
// this is the bare-path HTML surface) — see the Phase 8 plan's recipe.
// Role model: admin-only writes, matching routes-pg/attendance.js.
//
// The original's CSV export (/attendance.csv) is NOT ported — same
// deferral routes-pg/attendance.js's own header comment already made.

const crypto = require('crypto');
const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { sparkline } = require('../lib/charts');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
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
    attendanceMen: men, attendanceWomen: women, attendanceChildren: children, attendanceTotal: total,
  };
}

// Prisma DateTime -> the local "YYYY-MM-DDTHH:mm" <input type=datetime-local> expects.
function isoLocal(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? '' : dt.toISOString().slice(0, 16);
}

function serviceForm(ev, action, opts = {}) {
  const e = ev || {};
  const isEdit = !!e.id;
  return `<form class="form attendance-service-form" method="post" action="${action}">
    <label class="wide">
      <span>Service title <span class="req-star">*</span></span>
      <input name="title" required value="${esc(e.title || '')}" placeholder="e.g. Sunday Worship">
    </label>
    <label>
      <span>Date &amp; time <span class="req-star">*</span></span>
      <input type="datetime-local" name="startsAt" required value="${esc(isoLocal(e.startsAt))}">
    </label>
    <label>
      <span>Location</span>
      <input name="location" value="${esc(e.location || '')}" placeholder="e.g. Sanctuary">
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
          <input type="number" name="attendanceMen" min="0" step="1" value="${esc(e.attendanceMen ?? '')}"></label>
        <label class="counts-field"><span>Women</span>
          <input type="number" name="attendanceWomen" min="0" step="1" value="${esc(e.attendanceWomen ?? '')}"></label>
        <label class="counts-field"><span>Children</span>
          <input type="number" name="attendanceChildren" min="0" step="1" value="${esc(e.attendanceChildren ?? '')}"></label>
        <label class="counts-field counts-total"><span>Total</span>
          <input type="number" name="attendanceTotal" min="0" step="1" value="${esc(e.attendanceTotal ?? '')}" placeholder="auto">
        </label>
      </div>
    </div>
    <label class="wide">
      <span>Notes</span>
      <textarea name="notes" rows="2" placeholder="Optional notes about the service.">${esc(e.notes || '')}</textarea>
    </label>
    <div class="actions form-actions">
      <a class="btn ghost" href="/attendance">Cancel</a>
      <button type="submit">${isEdit ? 'Save changes' : 'Add service'}</button>
    </div>
    ${opts.extraButtons || ''}
  </form>`;
}

function register(app) {
  app.get('/attendance', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';

    const services = await db.event.findMany({
      where: { eventType: 'SERVICE' },
      orderBy: { startsAt: 'desc' },
      take: 20,
      include: { _count: { select: { attendance: true } } },
    });
    const attendeesOf = (s) => s.attendanceTotal ?? s._count.attendance;
    const trend = services.slice(0, 8).reverse().map((r, i) => ({ label: `Wk ${i + 1}`, value: attendeesOf(r) }));
    const avg = trend.length ? Math.round(trend.reduce((a, b) => a + b.value, 0) / trend.length) : 0;
    const total = services.reduce((a, b) => a + attendeesOf(b), 0);
    const recorded = services.filter((s) => s.attendanceTotal !== null).length;
    const last = services[0];
    const previous = services[1];
    const lastTotal = last ? attendeesOf(last) : 0;
    const previousTotal = previous ? attendeesOf(previous) : 0;
    const change = previous ? lastTotal - previousTotal : 0;

    const hero = pageHero('Attendance',
      'Track service participation. Record Men / Women / Children counts per service — add or edit a service right here.');
    const stats = statsRow([
      { cls: 'gold', icon: '✓', value: avg.toLocaleString(), label: `Avg attendance (last ${trend.length})` },
      { cls: 'green', icon: '📅', value: services.length.toLocaleString(), label: 'Services tracked' },
      { cls: 'blue', icon: '🧮', value: recorded.toLocaleString(), label: 'Counts recorded' },
      { cls: 'purple', icon: '👥', value: total.toLocaleString(), label: 'Total attendance' },
      { cls: change >= 0 ? 'green' : 'orange', icon: '↕', value: previous ? `${change >= 0 ? '+' : ''}${change}` : '—', label: 'Last service change' },
    ], isAdmin ? '<a class="btn primary" href="/attendance/new">＋ Add Service</a>' : '');

    const trendCard = `<div class="card">
      <div class="card-head"><h2>Attendance trend</h2><span class="meta">Last ${trend.length} services</span></div>
      ${sparkline(trend)}
    </div>`;

    const cell = (v) => v == null ? '<span class="muted-text">—</span>' : `<strong>${esc(String(v))}</strong>`;
    const recent = services.length
      ? table(
          ['When', 'Title', 'Men', 'Women', 'Children', 'Total', 'Actions'],
          services.map((s) => [
            esc(isoLocal(s.startsAt).replace('T', ' ')),
            isAdmin ? `<a href="/attendance/${s.id}/edit">${esc(s.title)}</a>` : esc(s.title),
            cell(s.attendanceMen), cell(s.attendanceWomen), cell(s.attendanceChildren), cell(s.attendanceTotal),
            isAdmin ? `<a class="btn ghost" href="/attendance/${s.id}/edit">Edit →</a>` : '<span class="muted-text">—</span>',
          ]))
      : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">✓</div>
          <h3>No services tracked yet</h3>
          <p>Add your first service to start recording attendance counts.</p>
          ${isAdmin ? '<a class="btn primary" href="/attendance/new">＋ Add Service</a>' : ''}
        </div>`;
    const recentCard = listCard({ title: 'Recent services', count: services.length, countLabel: 'services', inner: recent });

    res.page({ title: 'Attendance', active: '/attendance', noHeader: true, body: `${hero}${stats}${trendCard}${recentCard}` });
  }));

  app.get('/attendance/new', requireAdmin, (req, res) => {
    res.page({ title: 'New service', active: '/attendance', noHeader: true, body: `${pageHero('New service', '')}${serviceForm(null, '/attendance')}` });
  });

  app.post('/attendance', requireAdmin, asyncHandler(async (req, res) => {
    const v = parseServiceBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      flash(req, 'Service title and date are required.');
      return res.redirect('/attendance/new');
    }
    const ev = await res.locals.db.event.create({ data: { ...v, eventType: 'SERVICE', checkinToken: crypto.randomBytes(16).toString('hex') } });
    await logActivity(res.locals.db, 'attendance_recorded',
      `Service "${v.title}" added · M:${v.attendanceMen ?? '—'} W:${v.attendanceWomen ?? '—'} C:${v.attendanceChildren ?? '—'} Total:${v.attendanceTotal ?? '—'}`,
      `/attendance/${ev.id}/edit`, res.locals.user.id);
    flash(req, 'Service added.', 'success');
    res.redirect('/attendance');
  }));

  app.get('/attendance/:id/edit', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const ev = await res.locals.db.event.findFirst({ where: { id, eventType: 'SERVICE' } });
    if (!ev) return res.status(404).send('Not found');
    const extra = `<div class="form-extra-actions" style="grid-column:1/-1;margin-top:0.6rem">
      <form method="post" action="/attendance/${id}/delete"
            onsubmit="return confirm('Delete this service and its counts? This cannot be undone.')" style="display:inline">
        <button class="danger" type="submit">Delete service</button>
      </form>
    </div>`;
    res.page({
      title: `Edit service · ${ev.title}`, active: '/attendance', noHeader: true,
      body: `${pageHero(`Edit service · ${ev.title}`, '')}${serviceForm(ev, `/attendance/${id}`, { extraButtons: extra })}`,
    });
  }));

  app.post('/attendance/:id', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const v = parseServiceBody(req.body || {});
    if (!v.title || !v.startsAt || Number.isNaN(v.startsAt.getTime())) {
      flash(req, 'Service title and date are required.');
      return res.redirect(`/attendance/${id}/edit`);
    }
    try {
      await res.locals.db.event.update({ where: { id }, data: v });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    await logActivity(res.locals.db, 'attendance_recorded',
      `Counts updated for "${v.title}" · M:${v.attendanceMen ?? '—'} W:${v.attendanceWomen ?? '—'} C:${v.attendanceChildren ?? '—'} Total:${v.attendanceTotal ?? '—'}`,
      `/attendance/${id}/edit`, res.locals.user.id);
    flash(req, 'Service updated.', 'success');
    res.redirect('/attendance');
  }));

  app.post('/attendance/:id/delete', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const ev = await res.locals.db.event.findFirst({ where: { id, eventType: 'SERVICE' } });
    if (!ev) return res.status(404).send('Not found');
    // Attendance rows cascade-delete with their Event (schema.prisma:
    // Attendance.event onDelete: Cascade) — matches routes-pg/attendance.js's note.
    await res.locals.db.event.delete({ where: { id } });
    await logActivity(res.locals.db, 'attendance_recorded', `Service "${ev.title}" deleted`, '/attendance', res.locals.user.id);
    flash(req, 'Service deleted.', 'success');
    res.redirect('/attendance');
  }));
}

module.exports = { register };
