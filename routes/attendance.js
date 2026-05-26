'use strict';
// Attendance overview. register(app, ctx).
module.exports.register = function register(app, ctx) {
  const { db, esc, sparkline, table } = ctx;

  app.get('/attendance', (req, res) => {
    const services = db.prepare(`
      SELECT e.event_id, e.title, e.starts_at, e.location,
             COUNT(a.member_id) attendees
      FROM   events e LEFT JOIN attendance a USING(event_id)
      WHERE  e.event_type='service'
      GROUP BY e.event_id ORDER BY e.starts_at DESC LIMIT 20`).all();
    const trend = services.slice(0, 8).reverse()
      .map((r, i) => ({ label: `Wk ${i + 1}`, value: r.attendees }));
    const avg = trend.length
      ? Math.round(trend.reduce((a, b) => a + b.value, 0) / trend.length) : 0;
    const body = `
      <div class="stat-grid">
        <div class="stat"><div class="ico purple">✓</div><div>
          <div class="label">Avg attendance (last ${trend.length})</div>
          <div class="value">${avg}</div></div></div>
        <div class="stat"><div class="ico green">📅</div><div>
          <div class="label">Services tracked</div>
          <div class="value">${services.length}</div></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Attendance Trend</h2><span class="meta">Last ${trend.length} services</span></div>
        ${sparkline(trend)}
      </div>
      <h2>Recent services</h2>
      ${table(['When', 'Title', 'Location', 'Attendees', ''],
        services.map((s) => [esc(s.starts_at), esc(s.title), esc(s.location),
          s.attendees,
          `<a class="btn ghost" href="/events/${s.event_id}">Open</a>`]))}`;
    res.page({ title: 'Attendance', active: '/attendance', body });
  });
};
