'use strict';
// Phase 8d: HTML port of routes/reports.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/reports.js (JSON at /api/reports/..., this
// is the bare-path HTML surface).
//
// SCOPE matches routes-pg/reports.js exactly (its own header comment
// explains why): day-born (bars + crosstab), income detail (UNION ALL
// register), members "missed the last 3 Sundays", and a members
// status-summary. The other ~7 original report pages (collections,
// harvests, special, expenses, expense-detail, funds, financial-summary)
// and every CSV export are DEFERRED, same reasoning as routes-pg/reports.js.
//
// Raw SQL here is copy-pasted VERBATIM from routes-pg/reports.js (already
// churchId-scoped and guardrail-checked) — not re-derived. This file is
// scanned by the SAME scripts/check-raw-sql-tenant-scoping.js guardrail
// (extended to cover routes-pg-html/ alongside routes-pg/ in this phase).

const asyncHandler = require('../lib/async-handler');
const { esc, fmtMoney, fmtDobShort } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { db: rawDb } = require('../lib/tenant');
const { icon } = require('../lib/icons');
const { canUseReports, upgradeMessage } = require('../lib/plan');

const REPORT_TABS = [
  ['/reports', 'Overview'],
  ['/reports/day-born', 'Day-Born'],
  ['/reports/income', 'Income Detail'],
  ['/reports/members', 'Members'],
];
function reportTabs(active) {
  return `<div class="finance-tabs">${REPORT_TABS.map(([href, label]) => `<a class="${href === active ? 'active' : ''}" href="${href}">${esc(label)}</a>`).join('')}</div>`;
}
function defaultRange(req) {
  const today = new Date();
  const start = req.query.start || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const end = req.query.end || today.toISOString().slice(0, 10);
  return { start, end };
}
function rangeForm(action, start, end) {
  return `<form class="filters" method="get" action="${action}">
    <label>From <input type="date" name="start" value="${esc(start)}"></label>
    <label>To <input type="date" name="end" value="${esc(end)}"></label>
    <button type="submit">Apply</button>
  </form>`;
}
function groupTotals(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const label = r[key] == null ? '—' : String(r[key]);
    const prev = map.get(label) || { label, count: 0, total: 0 };
    prev.count += 1; prev.total += Number(r.amount || 0);
    map.set(label, prev);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

// Reports are a Pro feature. Free churches get an explanation and a route to
// upgrade rather than a 403 — the page is not broken, it is not included, and
// the difference matters to someone deciding whether to pay.
function requireReports(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  if (canUseReports(res.locals.church)) return next();
  const body = `${pageHero('Reports', upgradeMessage('reports'))}
    <div class="card">
      <h2>What Pro adds</h2>
      <ul class="list">
        <li><div>Day-born collections, income and member reports</div></li>
        <li><div>CSV export of every report</div></li>
        <li><div>Unlimited staff accounts</div></li>
      </ul>
      <div class="actions"><a class="btn primary" href="/settings">See your plan</a></div>
    </div>`;
  return res.status(402).page({ title: 'Reports', active: '/reports', noHeader: true, body });
}

function register(app) {
  app.get('/reports', requireReports, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const tiles = [
      ['/reports/day-born', '📅', 'Day-Born', 'Summary cards, bar chart, crosstab.'],
      ['/reports/income', '↗', 'Income Detail', 'All income sources and category mix.'],
      ['/reports/members', '👥', 'Members', 'Missed Sundays and status breakdown.'],
    ];
    const body = `
      ${pageHero('Reports', 'Command center for church analytics.')}
      ${reportTabs('/reports')}
      <p class="muted-text">Pick a report category below. Each report supports a date-range filter.</p>
      <div class="report-tiles">${tiles.map(([href, ico, name, desc]) =>
        `<a class="report-tile" href="${href}">
           <div class="ico">${ico}</div>
           <div><div class="name">${esc(name)}</div><div class="desc">${esc(desc)}</div></div>
         </a>`).join('')}</div>`;
    res.page({ title: 'Reports', active: '/reports', noHeader: true, body });
  }));

  app.get('/reports/day-born', requireReports, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    // Named per-day-born amounts — same sensitivity as /reports/income and
    // finance.js's /finance/reports/giving, which require financeRole access.
    const u = res.locals.user;
    if (!(u.role === 'ADMIN' || (u.financeRole && u.financeRole !== 'NONE'))) {
      return res.status(403).send('Finance access required');
    }
    const churchId = res.locals.churchId;
    const { start, end } = defaultRange(req);

    const bars = await rawDb.$queryRaw`
      WITH totals AS (
        SELECT dbs.day_born::text AS day_born, SUM(dbs.amount) AS amt
        FROM day_born_splits dbs
        JOIN services s ON s.service_id = dbs.service_id
        WHERE s.church_id = ${churchId} AND s.deleted_at IS NULL
          AND s.service_date BETWEEN ${start}::date AND ${end}::date
        GROUP BY dbs.day_born
      ),
      mx AS (SELECT COALESCE(MAX(amt), 1) AS m FROM totals)
      SELECT day_born, amt AS total_amount,
             ROUND((amt * 100.0 / (SELECT m FROM mx))::numeric, 1) AS bar_width_pct
      FROM totals
      ORDER BY amt DESC
    `;
    const cross = await rawDb.$queryRaw`
      SELECT dbs.day_born::text AS day_born,
        SUM(CASE WHEN st.type_name = 'Sunday Service' THEN dbs.amount ELSE 0 END) AS sunday_svc,
        SUM(CASE WHEN st.type_name = 'Wednesday Service' THEN dbs.amount ELSE 0 END) AS wednesday_svc,
        SUM(CASE WHEN st.type_name = 'Wedding Service' THEN dbs.amount ELSE 0 END) AS weddings,
        SUM(CASE WHEN st.type_name = 'Funeral Service' THEN dbs.amount ELSE 0 END) AS funerals,
        SUM(dbs.amount) AS day_total,
        ROUND((SUM(dbs.amount) * 100.0 / NULLIF((
          SELECT SUM(dbs3.amount) FROM day_born_splits dbs3
          JOIN services s3 ON s3.service_id = dbs3.service_id
          WHERE s3.church_id = ${churchId} AND s3.deleted_at IS NULL
            AND s3.service_date BETWEEN ${start}::date AND ${end}::date
        ), 0))::numeric, 1) AS pct
      FROM day_born_splits dbs
      JOIN services s ON s.service_id = dbs.service_id
      JOIN service_types st ON st.service_type_id = s.service_type_id
      WHERE s.church_id = ${churchId} AND s.deleted_at IS NULL
        AND s.service_date BETWEEN ${start}::date AND ${end}::date
      GROUP BY dbs.day_born
      ORDER BY CASE dbs.day_born::text
        WHEN 'SUNDAY' THEN 1 WHEN 'MONDAY' THEN 2 WHEN 'TUESDAY' THEN 3
        WHEN 'WEDNESDAY' THEN 4 WHEN 'THURSDAY' THEN 5 WHEN 'FRIDAY' THEN 6
        WHEN 'SATURDAY' THEN 7 ELSE 8 END
    `;

    // Summary cards derived from `bars` (already fetched, no extra query) —
    // "Services Held"/"Avg per Service" from the original page needs a
    // separate services-count query outside the ported JSON scope, dropped.
    const totalCollected = bars.reduce((s, b) => s + Number(b.total_amount || 0), 0);
    const topDayBorn = bars.length ? bars[0].day_born : null;

    const z1 = `
      <div class="stat-grid">
        <div class="stat"><div class="ico green">₵</div><div><div class="label">Total Collected</div><div class="value">${fmtMoney(totalCollected)}</div></div></div>
        <div class="stat"><div class="ico orange">★</div><div><div class="label">Top Day-Born</div><div class="value" style="font-size:1.2rem">${esc(topDayBorn) || '—'}</div></div></div>
      </div>`;
    const z2 = `
      <div class="card">
        <div class="card-head"><h2>Day-Born Contribution Bars</h2><span class="meta">${esc(start)} → ${esc(end)}</span></div>
        ${bars.length ? `<div class="bar-list">${bars.map((b) => `
          <div class="bar-row">
            <div class="bar-label">${esc(b.day_born)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.max(Number(b.bar_width_pct), 1)}%"></div></div>
            <div class="bar-value">${fmtMoney(b.total_amount)}</div>
          </div>`).join('')}</div>` : '<p class="muted-text">No day-born data for this period.</p>'}
      </div>`;
    const z3z4 = cross.length
      ? table(['Day-Born', 'Sunday Svc', 'Wed Svc', 'Weddings', 'Funerals', 'Total', '% of period'],
          cross.map((r) => [esc(r.day_born), fmtMoney(r.sunday_svc), fmtMoney(r.wednesday_svc), fmtMoney(r.weddings), fmtMoney(r.funerals),
            `<strong>${fmtMoney(r.day_total)}</strong>`, (r.pct == null ? '—' : r.pct + '%')]))
      : '<p class="muted-text">No data for this period.</p>';

    res.page({
      title: 'Day-Born Collection Report', active: '/reports', noHeader: true,
      body: `${pageHero('Day-Born Collection Report', '')}${reportTabs('/reports/day-born')}${rangeForm('/reports/day-born', start, end)}${z1}${z2}<h2>Detailed crosstab</h2>${z3z4}`,
    });
  }));

  app.get('/reports/income', requireReports, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    // Named per-donor amounts — same sensitivity as finance.js's
    // /finance/reports/giving, which requires financeRole access. This older
    // report predates that gate and must enforce the identical check.
    const u = res.locals.user;
    if (!(u.role === 'ADMIN' || (u.financeRole && u.financeRole !== 'NONE'))) {
      return res.status(403).send('Finance access required');
    }
    const churchId = res.locals.churchId;
    const { start, end } = defaultRange(req);

    const rows = await rawDb.$queryRaw`
      SELECT s.service_date AS dt, 'Service Offering' AS category, st.type_name AS detail,
             NULL::int AS giver_id, NULL::text AS giver, s.total_amount AS amount, 'Services' AS source
        FROM services s JOIN service_types st ON st.service_type_id = s.service_type_id
       WHERE s.church_id = ${churchId} AND s.deleted_at IS NULL AND s.total_amount > 0
         AND s.service_date BETWEEN ${start}::date AND ${end}::date
      UNION ALL
      SELECT t.tithe_date, 'Tithe', 'Member tithe',
             m.member_id, m.first_name || ' ' || m.last_name, t.amount, 'Tithes'
        FROM tithes t JOIN members m ON m.member_id = t.member_id
       WHERE t.church_id = ${churchId} AND t.deleted_at IS NULL
         AND t.tithe_date BETWEEN ${start}::date AND ${end}::date
      UNION ALL
      SELECT ir.transaction_date, 'Generic Income',
             COALESCE(NULLIF(ir.subcategory, ''), ir.category),
             ir.member_id, COALESCE(m.first_name || ' ' || m.last_name, ir.received_from), ir.amount, 'Generic Income'
        FROM income_records ir LEFT JOIN members m ON m.member_id = ir.member_id
       WHERE ir.church_id = ${churchId} AND ir.deleted_at IS NULL
         AND ir.transaction_date BETWEEN ${start}::date AND ${end}::date
      UNION ALL
      SELECT dbc.collection_date, 'Day-Born Collection', dbc.day_born::text,
             NULL::int, dbc.day_born::text || ' day-born group', dbc.amount, 'Day-Borns'
        FROM day_born_collections dbc
       WHERE dbc.church_id = ${churchId} AND dbc.deleted_at IS NULL
         AND dbc.collection_date BETWEEN ${start}::date AND ${end}::date
      UNION ALL
      SELECT COALESCE(h.harvest_date, make_date(h.harvest_year, 1, 1)), 'Harvest', h.harvest_name,
             NULL::int, COALESCE(o.name, 'Church-wide'), h.total_collected, 'Harvests'
        FROM harvests h LEFT JOIN organizations o ON o.org_id = h.org_id
       WHERE h.church_id = ${churchId} AND h.deleted_at IS NULL AND h.total_collected > 0
         AND COALESCE(h.harvest_date, make_date(h.harvest_year, 1, 1)) BETWEEN ${start}::date AND ${end}::date
      UNION ALL
      SELECT sp.offering_date, 'Special Offering', sc.category_name,
             sp.donor_id, COALESCE(m.first_name || ' ' || m.last_name, sp.donor_name_manual, 'Anonymous'), sp.amount, 'Special Offerings'
        FROM special_offerings sp
        JOIN special_categories sc ON sc.special_cat_id = sp.special_cat_id
        LEFT JOIN members m ON m.member_id = sp.donor_id
       WHERE sp.church_id = ${churchId} AND sp.deleted_at IS NULL
         AND sp.offering_date BETWEEN ${start}::date AND ${end}::date
      UNION ALL
      SELECT pp.paid_on, 'Pledge Payment', h2.harvest_name,
             m2.member_id, m2.first_name || ' ' || m2.last_name, pp.amount, 'Pledge Payments'
        FROM pledge_payments pp
        JOIN pledges p2 ON p2.pledge_id = pp.pledge_id
        JOIN harvests h2 ON h2.harvest_id = p2.harvest_id
        JOIN members m2 ON m2.member_id = p2.member_id
       WHERE pp.church_id = ${churchId}
         AND pp.paid_on BETWEEN ${start}::date AND ${end}::date
      ORDER BY dt DESC, source, category
    `;
    const shaped = rows.map((r) => ({ ...r, amount: Number(r.amount) }));
    const total = shaped.reduce((sum, row) => sum + row.amount, 0);
    const byCategory = groupTotals(shaped, 'category');
    const bySource = groupTotals(shaped, 'source');
    const topGivers = groupTotals(shaped.filter((r) => r.giver), 'giver').slice(0, 20);

    const body = `
      ${reportTabs('/reports/income')}
      ${rangeForm('/reports/income', start, end)}
      ${statsRow([
        { cls: 'green', icon: icon('finance'), value: fmtMoney(total), label: 'Total income' },
        { cls: 'blue', icon: icon('hash'), value: shaped.length, label: 'Income records' },
        { cls: 'purple', icon: icon('trend'), value: byCategory.length, label: 'Categories' },
      ])}
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Income by category</h2><span class="meta">${esc(start)} → ${esc(end)}</span></div>
        ${byCategory.length ? table(['Category', 'Records', 'Total'], byCategory.map((row) => [esc(row.label), row.count, fmtMoney(row.total)])) : '<p class="muted-text">No income in this period.</p>'}
      </section>
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Income by source</h2><span class="meta">Finance app style source mix</span></div>
        ${bySource.length ? table(['Source', 'Records', 'Total'], bySource.map((row) => [esc(row.label), row.count, fmtMoney(row.total)])) : '<p class="muted-text">No source mix available.</p>'}
      </section>
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Top givers / payers</h2><span class="meta">Named records only</span></div>
        ${topGivers.length ? table(['Name', 'Records', 'Total'], topGivers.map((row) => [esc(row.label), row.count, fmtMoney(row.total)])) : '<p class="muted-text">No named givers in this period.</p>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Income register</h2><span class="meta">${shaped.length} rows</span></div>
        ${shaped.length ? table(['Date', 'Category', 'Detail', 'Giver', 'Amount', 'Source'],
          shaped.slice(0, 200).map((row) => [esc(row.dt), esc(row.category), esc(row.detail || '—'), esc(row.giver || '—'), fmtMoney(row.amount), esc(row.source)]))
          : '<p class="muted-text">No income in this period.</p>'}
      </section>`;
    res.page({ title: 'Income Detail Report', active: '/reports', noHeader: true, body: `${pageHero('Income Detail Report', '')}${body}` });
  }));

  app.get('/reports/members', requireReports, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const churchId = res.locals.churchId;
    const db = res.locals.db;

    const [missing, statusSummary] = await Promise.all([
      rawDb.$queryRaw`
        WITH last_services AS (
          SELECT event_id FROM events
          WHERE church_id = ${churchId} AND event_type = 'SERVICE'
          ORDER BY starts_at DESC LIMIT 3
        )
        SELECT m.member_id AS member_id, m.first_name || ' ' || m.last_name AS name, m.email
        FROM members m
        WHERE m.church_id = ${churchId} AND m.deleted_at IS NULL
          AND m.membership_status IN ('MEMBER', 'REGULAR')
          AND NOT EXISTS (
            SELECT 1 FROM attendance a
            WHERE a.church_id = ${churchId} AND a.member_id = m.member_id
              AND a.event_id IN (SELECT event_id FROM last_services)
          )
      `,
      db.member.groupBy({ by: ['membershipStatus'], where: { deletedAt: null }, _count: { _all: true } }),
    ]);

    const body = `
      ${reportTabs('/reports/members')}
      <h2>Membership status breakdown</h2>
      ${statusSummary.length ? table(['Status', 'Count'], statusSummary.map((s) => [esc(s.membershipStatus), s._count._all]))
        : '<p class="muted-text">No members yet.</p>'}
      <h2>Missed the last 3 Sundays</h2>
      ${missing.length ? table(['Name', 'Email'], missing.map((r) => [`<a href="/members/${r.member_id}">${esc(r.name)}</a>`, esc(r.email) || '—']))
        : '<p class="muted-text">Everyone has been attending. 🎉</p>'}`;
    res.page({ title: 'Member Reports', active: '/reports', noHeader: true, body: `${pageHero('Member Reports', '')}${body}` });
  }));
}

module.exports = { register };
