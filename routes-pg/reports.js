'use strict';
// Phase 4: Postgres/Prisma port of routes/reports.js — read-only, and
// deliberately the module that stress-tests the raw-SQL tenant-scoping
// guardrail, since lib/tenant.js's Prisma extension only intercepts MODEL
// operations, never `$queryRaw`. Every raw-SQL block below has churchId
// bound as a parameter in every branch/subquery, and
// scripts/check-raw-sql-tenant-scoping.js enforces this mechanically.
//
// SCOPE: 4 representative reports, not an exhaustive port of all 15 in the
// original (overview dashboard, print-all, collections, harvests, special,
// expenses, funds, financial-summary, and all the .csv export variants are
// DEFERRED — read-only historical reports, lower risk to leave for the real
// per-route cutover; financial-summary in particular is ledger/account-
// balance territory that belongs closer to Phase 5). The 4 chosen here
// cover three distinct raw-SQL shapes (CTE+crosstab, UNION ALL across 6
// tables, CTE+NOT EXISTS anti-join) plus one pure-Prisma case for contrast.

const asyncHandler = require('../lib/async-handler');
const { db: rawDb } = require('../lib/tenant');

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

// day-born and income both carry named per-donor amounts — same sensitivity
// as finance.js's /finance/reports/giving and the HTML /reports/day-born
// and /reports/income routes, which require financeRole access.
function requireFinanceReportAccess(req, res, next) {
  const u = res.locals.user;
  if (!u) return res.status(401).json({ error: 'not logged in' });
  if (u.role === 'ADMIN' || (u.financeRole && u.financeRole !== 'NONE')) return next();
  return res.status(403).json({ error: 'Finance access required' });
}

function defaultRange(query) {
  const today = new Date();
  const start = query.start || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const end = query.end || today.toISOString().slice(0, 10);
  return { start, end };
}

function register(app) {
  // --- Day-born report: CTE (totals/mx) + crosstab (CASE-based pivot). ---
  app.get('/api/reports/day-born', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const churchId = res.locals.churchId;
    const { start, end } = defaultRange(req.query);

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

    const toNum = (rows, keys) => rows.map((r) => {
      const out = { ...r };
      for (const k of keys) out[k] = out[k] == null ? out[k] : Number(out[k]);
      return out;
    });

    res.json({
      start, end,
      bars: toNum(bars, ['total_amount', 'bar_width_pct']),
      crosstab: toNum(cross, ['sunday_svc', 'wednesday_svc', 'weddings', 'funerals', 'day_total', 'pct']),
    });
  }));

  // --- Income detail: UNION ALL across 6 income-bearing tables. ---
  app.get('/api/reports/income', requireAuth, requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const churchId = res.locals.churchId;
    const { start, end } = defaultRange(req.query);

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
    const byCategory = new Map();
    for (const r of shaped) {
      const prev = byCategory.get(r.category) || { category: r.category, count: 0, total: 0 };
      prev.count += 1; prev.total += r.amount;
      byCategory.set(r.category, prev);
    }
    res.json({
      start, end,
      rows: shaped,
      byCategory: Array.from(byCategory.values()).sort((a, b) => b.total - a.total),
    });
  }));

  // --- Members: "missed the last 3 Sundays" — CTE + NOT EXISTS anti-join. ---
  app.get('/api/reports/members/missing', requireAuth, asyncHandler(async (req, res) => {
    const churchId = res.locals.churchId;
    const rows = await rawDb.$queryRaw`
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
    `;
    res.json(rows);
  }));

  // --- Members: status breakdown — pure Prisma groupBy, no raw SQL, for
  //     contrast (tenantDb auto-scopes this the normal way). ---
  app.get('/api/reports/members/status-summary', requireAuth, asyncHandler(async (req, res) => {
    const summary = await res.locals.db.member.groupBy({
      by: ['membershipStatus'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    res.json(summary.map((s) => ({ status: s.membershipStatus, count: s._count._all })));
  }));
}

module.exports = { register };
