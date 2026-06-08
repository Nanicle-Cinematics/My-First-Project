'use strict';
// Attendance overview. register(app, ctx).
module.exports.register = function register(app, ctx) {
  const { db, esc, sparkline, table, pageHero, statsRow, listCard } = ctx;

  app.get('/attendance', (req, res) => {
    const isAdmin = res.locals.isAdmin;
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
    const total = services.reduce((a, b) => a + b.attendees, 0);

    const hero = pageHero('Attendance',
      'Track service participation. Average, totals, and a per-service trend at a glance.');
    const stats = statsRow([
      { cls: 'gold', icon: '✓', value: avg.toLocaleString(), label: `Avg attendance (last ${trend.length})` },
      { cls: 'green', icon: '📅', value: services.length.toLocaleString(), label: 'Services tracked' },
      { cls: 'blue', icon: '👥', value: total.toLocaleString(), label: 'Total check-ins' },
    ], isAdmin ? '<a class="btn primary" href="/events/new">＋ New Service</a>' : '');

    const trendCard = `<div class="card">
      <div class="card-head"><h2>Attendance trend</h2><span class="meta">Last ${trend.length} services</span></div>
      ${sparkline(trend)}
    </div>`;

    const recent = services.length
      ? table(['When', 'Title', 'Location', 'Attendees', 'Actions'],
          services.map((s) => [esc(s.starts_at), esc(s.title), esc(s.location) || '<span class="muted-text">—</span>',
            `<span class="count-badge">${s.attendees}</span>`,
            `<a class="btn ghost" href="/events/${s.event_id}">Open →</a>`]))
      : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">✓</div>
          <h3>No services tracked yet</h3>
          <p>Schedule a service event and start checking in members to populate this view.</p>
          ${isAdmin ? '<a class="btn primary" href="/events/new">＋ New Service</a>' : ''}
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
};
