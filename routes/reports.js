'use strict';
// Reports: overview, print-all, day-born, collections, harvests, special,
// expenses, financial summary, members. Read-only. register(app, ctx).
const { esc, fmtMoney, fmtOutstanding, fmtDobShort } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');

module.exports.register = function register(app, ctx) {
  const { db, CHURCH_NAME } = ctx;

// ---------- reports: shared ----------
const REPORT_TABS = [
  ['/reports',          'Overview'],
  ['/reports/day-born', 'Day-Born'],
  ['/reports/collections','Collections'],
  ['/reports/income',     'Income Detail'],
  ['/reports/harvests', 'Harvests'],
  ['/reports/special',  'Special Offerings'],
  ['/reports/expenses', 'Expenses'],
  ['/reports/expense-detail', 'Expense Detail'],
  ['/reports/funds',    'Funds'],
  ['/reports/financial','Financial Summary'],
  ['/reports/members',  'Members'],
];
function reportTabs(active) {
  return `<div class="finance-tabs">${REPORT_TABS.map(([href, label]) =>
    `<a class="${href === active ? 'active' : ''}" href="${href}">${esc(label)}</a>`).join('')}</div>`;
}
function defaultRange(req) {
  const today = new Date();
  const start = req.query.start || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const end   = req.query.end   || today.toISOString().slice(0, 10);
  return { start, end };
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(rows.map((row) => row.map(csvEscape).join(',')).join('\n') + '\n');
}
function rangeForm(action, start, end, extra = '') {
  return `<form class="filters" method="get" action="${action}">
    <label>From <input type="date" name="start" value="${esc(start)}"></label>
    <label>To <input type="date" name="end" value="${esc(end)}"></label>
    ${extra}
    <button type="submit">Apply</button>
    <details class="export">
      <summary>⋯ Export</summary>
      <a href="javascript:window.print()">Print / PDF</a>
    </details>
  </form>`;
}
function incomeRows(start, end) {
  return db.prepare(`
    SELECT service_date AS dt, 'Service Offering' AS category, st.type_name AS detail,
           NULL AS giver_id, NULL AS giver, total_amount AS amount, 'Services' AS source
      FROM services s JOIN service_types st USING(service_type_id)
     WHERE s.deleted_at IS NULL AND s.total_amount > 0 AND s.service_date BETWEEN @start AND @end
    UNION ALL
    SELECT tithe_date, 'Tithe', 'Member tithe',
           m.member_id, m.first_name || ' ' || m.last_name, t.amount, 'Tithes'
      FROM tithes t JOIN members m USING(member_id)
     WHERE t.deleted_at IS NULL AND t.tithe_date BETWEEN @start AND @end
    UNION ALL
    SELECT transaction_date, 'Generic Income',
           COALESCE(NULLIF(subcategory, ''), category),
           ir.member_id, COALESCE(m.first_name || ' ' || m.last_name, ir.received_from), ir.amount, 'Generic Income'
      FROM income_records ir LEFT JOIN members m ON m.member_id=ir.member_id
     WHERE ir.deleted_at IS NULL AND ir.transaction_date BETWEEN @start AND @end
    UNION ALL
    SELECT collection_date, 'Day-Born Collection', day_born,
           NULL, day_born || ' day-born group', amount, 'Day-Borns'
      FROM day_born_collections
     WHERE deleted_at IS NULL AND collection_date BETWEEN @start AND @end
    UNION ALL
    SELECT COALESCE(harvest_date, harvest_year || '-01-01'), 'Harvest', harvest_name,
           NULL, COALESCE(o.name, 'Church-wide'), total_collected, 'Harvests'
      FROM harvests h LEFT JOIN organizations o USING(org_id)
     WHERE h.deleted_at IS NULL AND h.total_collected > 0
       AND COALESCE(harvest_date, harvest_year || '-01-01') BETWEEN @start AND @end
    UNION ALL
    SELECT offering_date, 'Special Offering', sc.category_name,
           sp.donor_id, COALESCE(m.first_name || ' ' || m.last_name, sp.donor_name_manual, 'Anonymous'), sp.amount, 'Special Offerings'
      FROM special_offerings sp
      JOIN special_categories sc USING(special_cat_id)
      LEFT JOIN members m ON m.member_id=sp.donor_id
     WHERE sp.deleted_at IS NULL AND sp.offering_date BETWEEN @start AND @end
    UNION ALL
    SELECT paid_on, 'Pledge Payment', h.harvest_name,
           m.member_id, m.first_name || ' ' || m.last_name, pp.amount, 'Pledge Payments'
      FROM pledge_payments pp
      JOIN pledges p USING(pledge_id)
      JOIN harvests h USING(harvest_id)
      JOIN members m USING(member_id)
     WHERE pp.paid_on BETWEEN @start AND @end
     ORDER BY dt DESC, source, category`).all({ start, end });
}
function groupTotals(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const label = row[key] || 'Unspecified';
    const prev = map.get(label) || { label, count: 0, total: 0 };
    prev.count += 1;
    prev.total += Number(row.amount || 0);
    map.set(label, prev);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}
const DAY_ORDER_CASE = `CASE day_born
  WHEN 'Sunday' THEN 1 WHEN 'Monday' THEN 2 WHEN 'Tuesday' THEN 3
  WHEN 'Wednesday' THEN 4 WHEN 'Thursday' THEN 5 WHEN 'Friday' THEN 6
  WHEN 'Saturday' THEN 7 ELSE 8 END`;
const MONTH_NAMES = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

// ---------- reports: overview ----------
app.get('/reports', (req, res) => {
  const year = new Date().getFullYear().toString();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const metrics = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM members WHERE deleted_at IS NULL) members,
      (SELECT COUNT(*) FROM events WHERE event_type='service') services,
      (SELECT COALESCE(SUM(total_amount),0) FROM services WHERE deleted_at IS NULL AND service_date BETWEEN @monthStart AND @today) service_income_month,
      (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE spent_on BETWEEN @monthStart AND @today) expenses_month,
      (SELECT COUNT(*) FROM broadcasts) broadcasts,
      (SELECT COUNT(*) FROM activity_log WHERE occurred_at >= datetime('now','-7 days')) activity_7d
  `).get({ monthStart, today });
  const tiles = [
    ['/reports/day-born',     '📅', 'Day-Born',          'Sample-screen style: 4 summary cards, bar chart, crosstab.'],
    ['/reports/collections',  '₵',  'Collections',       'Daily, weekly, monthly, annual and year-over-year.'],
    ['/reports/income',       '↗',  'Income Detail',     'All income sources, category mix, top givers and CSV export.'],
    ['/reports/harvests',     '🌾', 'Harvests',          'Status, rankings, pledge fulfillment, year comparison.'],
    ['/reports/special',      '✨', 'Special Offerings', 'By category, by donor, over time, receipts log.'],
    ['/reports/expenses',     '🧾', 'Expenses',          'Categories, monthly trend, payment methods, pending receipts.'],
    ['/reports/expense-detail','↘', 'Expense Detail',    'Expense register by category, method, fund and project.'],
    ['/reports/funds',        '◎',  'Funds',             'Fund balances, raised/spent movement and restricted totals.'],
    ['/reports/financial',    '📊', 'Financial Summary', 'Income vs expenses, cash flow, group contribution.'],
    ['/reports/members',      '👥', 'Members',           'Birthdays, missed Sundays, top givers, follow-ups.'],
  ];
  const quickExports = table(['Export', 'Format', 'Open'], [
    ['Members', 'CSV', '<a href="/members.csv">Download</a>'],
    ['Income detail', 'CSV', `<a href="/reports/income.csv?start=${year}-01-01&end=${year}-12-31">Download</a>`],
    ['Expense detail', 'CSV', `<a href="/reports/expense-detail.csv?start=${year}-01-01&end=${year}-12-31">Download</a>`],
    ['Financial summary', 'CSV', `<a href="/reports/financial.csv?year=${esc(year)}">Download</a>`],
    ['Funds', 'CSV', '<a href="/finance/reports/funds.csv">Download</a>'],
    ['Ledger', 'CSV', '<a href="/finance/accounting/ledger.csv">Download</a>'],
  ]);
  const body = `
    ${pageHero('Reports', 'Command center for church analytics, exports and printable summaries.')}
    ${reportTabs('/reports')}
    ${statsRow([
      { cls: 'gold', icon: '👥', value: Number(metrics.members).toLocaleString(), label: 'Members' },
      { cls: 'green', icon: '✓', value: Number(metrics.services).toLocaleString(), label: 'Services' },
      { cls: 'blue', icon: '₵', value: fmtMoney(metrics.service_income_month), label: 'Service income this month' },
      { cls: 'orange', icon: '→', value: fmtMoney(metrics.expenses_month), label: 'Expenses this month' },
      { cls: 'purple', icon: '📣', value: Number(metrics.broadcasts).toLocaleString(), label: 'Broadcasts' },
      { cls: 'blue', icon: '•', value: Number(metrics.activity_7d).toLocaleString(), label: 'Activity (7d)' },
    ])}
    <p class="muted-text">Pick a report category below. Each report supports a date-range filter and a Print/PDF export.</p>
    <div class="report-tiles">${tiles.map(([href, ico, name, desc]) =>
      `<a class="report-tile" href="${href}">
         <div class="ico">${ico}</div>
         <div><div class="name">${esc(name)}</div><div class="desc">${esc(desc)}</div></div>
       </a>`).join('')}</div>
    ${listCard({ title: 'Quick Exports', count: 4, countLabel: 'exports', inner: quickExports })}
    <div class="card" style="margin-top:1.5rem">
      <div class="card-head"><h2>Print everything</h2><span class="meta">All sections, one document</span></div>
      <p class="muted-text">Build a single printable document containing every report section for a date range. Use your browser's Print dialog → "Save as PDF" to keep a copy.</p>
      <form class="filters" method="get" action="/reports/print">
        <label>From <input type="date" name="start" value="${esc(new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10))}"></label>
        <label>To <input type="date" name="end" value="${esc(new Date().toISOString().slice(0, 10))}"></label>
        <button class="btn primary" type="submit">＋ Open print view</button>
      </form>
    </div>`;
  res.page({ title: 'Reports', active: '/reports', body });
});

// ---------- reports: print all ----------
app.get('/reports/print', (req, res) => {
  const { start, end } = defaultRange(req);
  const year = req.query.year || new Date().getFullYear().toString();
  const p = { start, end };

  // --- Day-born ---
  const summary = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total_amount),0) FROM services
        WHERE deleted_at IS NULL AND service_date BETWEEN @start AND @end) AS total_collected,
      (SELECT COUNT(*) FROM services
        WHERE deleted_at IS NULL AND service_date BETWEEN @start AND @end) AS services_held,
      (SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE ROUND(SUM(total_amount)*1.0/COUNT(*),2) END
        FROM services WHERE deleted_at IS NULL AND service_date BETWEEN @start AND @end) AS avg_per_service,
      (SELECT day_born FROM day_born_splits dbs
        JOIN services s ON s.service_id=dbs.service_id
        WHERE s.deleted_at IS NULL AND s.service_date BETWEEN @start AND @end
        GROUP BY day_born ORDER BY SUM(amount) DESC LIMIT 1) AS top_day_born
  `).get(p);
  const bars = db.prepare(`
    WITH totals AS (
      SELECT day_born, SUM(amount) AS amt
      FROM day_born_splits dbs
      JOIN services s ON s.service_id=dbs.service_id
      WHERE s.deleted_at IS NULL AND s.service_date BETWEEN @start AND @end
      GROUP BY day_born
    ),
    mx AS (SELECT COALESCE(MAX(amt),1) AS m FROM totals)
    SELECT day_born, amt AS total_amount,
           ROUND(amt * 100.0 / (SELECT m FROM mx), 1) AS bar_width_pct
    FROM totals ORDER BY amt DESC
  `).all(p);
  const cross = db.prepare(`
    SELECT dbs.day_born,
      SUM(CASE WHEN st.type_name='Sunday Service'    THEN dbs.amount ELSE 0 END) AS sunday_svc,
      SUM(CASE WHEN st.type_name='Wednesday Service' THEN dbs.amount ELSE 0 END) AS wednesday_svc,
      SUM(CASE WHEN st.type_name='Wedding Service'   THEN dbs.amount ELSE 0 END) AS weddings,
      SUM(CASE WHEN st.type_name='Funeral Service'   THEN dbs.amount ELSE 0 END) AS funerals,
      SUM(dbs.amount) AS day_total,
      ROUND(SUM(dbs.amount) * 100.0 / NULLIF((
        SELECT SUM(dbs3.amount) FROM day_born_splits dbs3
        JOIN services s3 ON s3.service_id=dbs3.service_id
        WHERE s3.deleted_at IS NULL AND s3.service_date BETWEEN @start AND @end), 0), 1) AS pct
    FROM day_born_splits dbs
    JOIN services s ON s.service_id=dbs.service_id
    JOIN service_types st ON st.service_type_id=s.service_type_id
    WHERE s.deleted_at IS NULL AND s.service_date BETWEEN @start AND @end
    GROUP BY dbs.day_born
    ORDER BY ${DAY_ORDER_CASE}
  `).all(p);
  const crossTotals = cross.reduce((a, r) => ({
    sunday: a.sunday + r.sunday_svc, wed: a.wed + r.wednesday_svc,
    weddings: a.weddings + r.weddings, funerals: a.funerals + r.funerals,
    grand: a.grand + r.day_total,
  }), { sunday: 0, wed: 0, weddings: 0, funerals: 0, grand: 0 });

  // --- Collections ---
  const weekly = db.prepare(`
    SELECT service_date,
      CASE strftime('%w', service_date)
        WHEN '0' THEN 'Sun' WHEN '1' THEN 'Mon' WHEN '2' THEN 'Tue'
        WHEN '3' THEN 'Wed' WHEN '4' THEN 'Thu' WHEN '5' THEN 'Fri'
        WHEN '6' THEN 'Sat' END AS day_name,
      COUNT(*) AS num, SUM(total_amount) AS total
    FROM services WHERE deleted_at IS NULL AND service_date BETWEEN ? AND ?
    GROUP BY service_date ORDER BY service_date`).all(start, end);
  const annual = db.prepare(`
    SELECT strftime('%m', service_date) AS m, COUNT(*) AS num, SUM(total_amount) AS total
    FROM services WHERE deleted_at IS NULL AND strftime('%Y', service_date)=?
    GROUP BY m ORDER BY m`).all(year);

  // --- Harvests ---
  const harvestStatus = db.prepare(`
    SELECT h.harvest_id, h.harvest_name, h.harvest_type, h.harvest_year, h.theme,
           o.name AS org_name, h.total_collected,
           COALESCE((SELECT SUM(pledged_amount) FROM pledges WHERE harvest_id=h.harvest_id),0) AS pledged,
           COALESCE((SELECT SUM(paid_amount)    FROM pledges WHERE harvest_id=h.harvest_id),0) AS pledged_paid
    FROM harvests h LEFT JOIN organizations o USING(org_id)
    WHERE h.deleted_at IS NULL AND h.harvest_year=?
    ORDER BY h.harvest_type, o.name`).all(year);

  // --- Special offerings ---
  const specialByCat = db.prepare(`
    SELECT sc.category_name, COUNT(*) AS num, SUM(sp.amount) AS total
    FROM special_offerings sp
    JOIN special_categories sc USING(special_cat_id)
    WHERE sp.deleted_at IS NULL AND sp.offering_date BETWEEN ? AND ?
    GROUP BY sc.special_cat_id ORDER BY total DESC`).all(start, end);
  const specialByDonor = db.prepare(`
    SELECT COALESCE(m.first_name||' '||m.last_name, sp.donor_name_manual, 'Anonymous') AS donor,
           COUNT(*) AS times, SUM(sp.amount) AS total
    FROM special_offerings sp LEFT JOIN members m ON m.member_id=sp.donor_id
    WHERE sp.deleted_at IS NULL AND sp.offering_date BETWEEN ? AND ?
    GROUP BY donor ORDER BY total DESC LIMIT 20`).all(start, end);

  // --- Expenses ---
  const expByCat = db.prepare(`
    SELECT COALESCE(ec.category_name, e.category) AS cat,
           COUNT(*) AS num, SUM(e.amount) AS total
    FROM expenses e LEFT JOIN expense_categories ec USING(expense_cat_id)
    WHERE e.spent_on BETWEEN ? AND ?
    GROUP BY cat ORDER BY total DESC`).all(start, end);
  const expByMethod = db.prepare(`
    SELECT COALESCE(payment_method,'(unspecified)') AS method,
           COUNT(*) AS num, SUM(amount) AS total
    FROM expenses WHERE spent_on BETWEEN ? AND ?
    GROUP BY method ORDER BY total DESC`).all(start, end);

  // --- Financial ---
  const fin = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total_amount),0) FROM services
        WHERE deleted_at IS NULL AND service_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(total_collected),0) FROM harvests
        WHERE deleted_at IS NULL AND COALESCE(harvest_date, harvest_year || '-01-01') BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM special_offerings
        WHERE deleted_at IS NULL AND offering_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM tithes
        WHERE deleted_at IS NULL AND tithe_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM income_records
        WHERE deleted_at IS NULL AND transaction_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM day_born_collections
        WHERE deleted_at IS NULL AND collection_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM pledge_payments
        WHERE paid_on BETWEEN @s AND @e) AS income,
      (SELECT COALESCE(SUM(amount),0) FROM expenses
        WHERE spent_on BETWEEN @s AND @e) AS expenses
  `).get({ s: start, e: end });
  const finNet = fin.income - fin.expenses;
  const cashFlow = db.prepare(`
    WITH mi AS (
      SELECT strftime('%Y-%m', service_date) ym, SUM(total_amount) amt
        FROM services WHERE deleted_at IS NULL AND strftime('%Y', service_date)=@y GROUP BY ym
      UNION ALL
      SELECT strftime('%Y-%m', COALESCE(harvest_date, harvest_year || '-01-01')), SUM(total_collected)
        FROM harvests WHERE deleted_at IS NULL AND harvest_year=CAST(@y AS INTEGER) GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', offering_date), SUM(amount)
        FROM special_offerings WHERE deleted_at IS NULL AND strftime('%Y', offering_date)=@y GROUP BY 1
    ),
    me AS (SELECT strftime('%Y-%m', spent_on) ym, SUM(amount) amt
             FROM expenses WHERE strftime('%Y', spent_on)=@y GROUP BY ym),
    months AS (SELECT DISTINCT ym FROM mi UNION SELECT DISTINCT ym FROM me)
    SELECT m.ym AS year_month,
           COALESCE((SELECT SUM(amt) FROM mi WHERE mi.ym=m.ym),0) AS income,
           COALESCE((SELECT amt FROM me WHERE me.ym=m.ym),0) AS expenses
    FROM months m ORDER BY m.ym`).all({ y: year });

  // --- Members ---
  const topGivers = db.prepare(`
    SELECT m.member_id, m.first_name || ' ' || m.last_name name, ROUND(SUM(sp.amount),2) total
    FROM special_offerings sp JOIN members m ON m.member_id = sp.donor_id
    WHERE sp.deleted_at IS NULL AND m.deleted_at IS NULL
      AND sp.offering_date BETWEEN ? AND ?
    GROUP BY m.member_id ORDER BY total DESC LIMIT 10`).all(start, end);
  const birthdays = db.prepare(`
    SELECT first_name || ' ' || last_name name, date_of_birth
    FROM members WHERE deleted_at IS NULL AND date_of_birth IS NOT NULL
      AND strftime('%m', date_of_birth)=strftime('%m','now')
    ORDER BY strftime('%d', date_of_birth)`).all();

  // --- Render the print document (uses normal layout — print stylesheet hides chrome) ---
  const body = `
    <div class="print-doc">
      <p class="print-meta">Period: <strong>${esc(start)}</strong> → <strong>${esc(end)}</strong>
        · Generated ${new Date().toLocaleString('en-GB')}
        · ${esc(CHURCH_NAME)}</p>
      <p class="screen-only"><button onclick="window.print()">🖨 Print this document</button>
        <a class="btn ghost" href="/reports">Back to Reports</a></p>

      <section class="print-section">
        <h2>1. Day-Born Collection Report</h2>
        <div class="stat-grid">
          <div class="stat"><div class="ico green">₵</div><div>
            <div class="label">Total Collected</div>
            <div class="value">${fmtMoney(summary.total_collected)}</div></div></div>
          <div class="stat"><div class="ico blue">📅</div><div>
            <div class="label">Services Held</div><div class="value">${summary.services_held}</div></div></div>
          <div class="stat"><div class="ico purple">∅</div><div>
            <div class="label">Avg per Service</div>
            <div class="value">${fmtMoney(summary.avg_per_service)}</div></div></div>
          <div class="stat"><div class="ico orange">★</div><div>
            <div class="label">Top Day-Born</div>
            <div class="value" style="font-size:1.2rem">${esc(summary.top_day_born) || '—'}</div></div></div>
        </div>
        ${bars.length ? `<h3>Day-Born Contribution Bars</h3>
          <div class="bar-list">${bars.map((b) => `
            <div class="bar-row">
              <div class="bar-label">${esc(b.day_born)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.max(b.bar_width_pct, 1)}%"></div></div>
              <div class="bar-value">${fmtMoney(b.total_amount)}</div>
            </div>`).join('')}</div>` : ''}
        <h3>Detailed crosstab</h3>
        ${cross.length ? table(['Day-Born', 'Sunday Svc', 'Wed Svc', 'Weddings', 'Funerals', 'Total', '% of period'],
          cross.map((r) => [esc(r.day_born),
            fmtMoney(r.sunday_svc), fmtMoney(r.wednesday_svc),
            fmtMoney(r.weddings), fmtMoney(r.funerals),
            `<strong>${fmtMoney(r.day_total)}</strong>`,
            (r.pct == null ? '—' : r.pct + '%')])
            .concat([[
              '<strong>TOTAL</strong>',
              `<strong>${fmtMoney(crossTotals.sunday)}</strong>`,
              `<strong>${fmtMoney(crossTotals.wed)}</strong>`,
              `<strong>${fmtMoney(crossTotals.weddings)}</strong>`,
              `<strong>${fmtMoney(crossTotals.funerals)}</strong>`,
              `<strong>${fmtMoney(crossTotals.grand)}</strong>`,
              '<strong>100.0%</strong>',
            ]]))
          : '<p class="muted-text">No data for this period.</p>'}
      </section>

      <section class="print-section">
        <h2>2. Collections</h2>
        <h3>Daily totals</h3>
        ${weekly.length ? table(['Date', 'Day', 'Services', 'Total'],
          weekly.map((r) => [esc(r.service_date), esc(r.day_name), r.num, fmtMoney(r.total)]))
          : '<p class="muted-text">No services recorded.</p>'}
        <h3>Annual breakdown · ${esc(year)}</h3>
        ${annual.length ? table(['Month', 'Services', 'Total'],
          annual.map((r) => [MONTH_NAMES[parseInt(r.m, 10)], r.num, fmtMoney(r.total)]))
          : '<p class="muted-text">No services this year.</p>'}
      </section>

      <section class="print-section">
        <h2>3. Harvests · ${esc(year)}</h2>
        ${harvestStatus.length ? table(['Type', 'Name', 'Organization', 'Theme', 'Collected', 'Pledged', 'Pledges paid'],
          harvestStatus.map((r) => [esc(r.harvest_type), esc(r.harvest_name),
            esc(r.org_name) || 'Church-wide', esc(r.theme),
            fmtMoney(r.total_collected), fmtMoney(r.pledged), fmtMoney(r.pledged_paid)]))
          : '<p class="muted-text">No harvests this year.</p>'}
      </section>

      <section class="print-section">
        <h2>4. Special Offerings</h2>
        <h3>By category</h3>
        ${specialByCat.length ? table(['Category', '#', 'Total'],
          specialByCat.map((r) => [esc(r.category_name), r.num, fmtMoney(r.total)]))
          : '<p class="muted-text">None in this period.</p>'}
        <h3>Top donors</h3>
        ${specialByDonor.length ? table(['Donor', '#', 'Total'],
          specialByDonor.map((r) => [esc(r.donor), r.times, fmtMoney(r.total)]))
          : '<p class="muted-text">None in this period.</p>'}
      </section>

      <section class="print-section">
        <h2>5. Expenses</h2>
        <h3>By category</h3>
        ${expByCat.length ? table(['Category', '#', 'Total'],
          expByCat.map((r) => [esc(r.cat), r.num, fmtMoney(r.total)]))
          : '<p class="muted-text">No expenses in this period.</p>'}
        <h3>By payment method</h3>
        ${expByMethod.length ? table(['Method', '#', 'Total'],
          expByMethod.map((r) => [esc(r.method), r.num, fmtMoney(r.total)]))
          : ''}
      </section>

      <section class="print-section">
        <h2>6. Financial Summary</h2>
        <div class="stat-grid">
          <div class="stat"><div class="ico green">↑</div><div>
            <div class="label">Total income</div>
            <div class="value">${fmtMoney(fin.income)}</div></div></div>
          <div class="stat"><div class="ico orange">↓</div><div>
            <div class="label">Total expenses</div>
            <div class="value">${fmtMoney(fin.expenses)}</div></div></div>
          <div class="stat"><div class="ico purple">=</div><div>
            <div class="label">Net</div>
            <div class="value" style="color:${finNet >= 0 ? 'var(--pos)' : 'var(--danger)'}">${fmtMoney(finNet)}</div></div></div>
        </div>
        <h3>Cash flow · ${esc(year)}</h3>
        ${cashFlow.length ? table(['Month', 'Income', 'Expenses', 'Net'],
          cashFlow.map((r) => [esc(r.year_month), fmtMoney(r.income),
            fmtMoney(r.expenses), fmtMoney(r.income - r.expenses)]))
          : '<p class="muted-text">No financial activity this year.</p>'}
      </section>

      <section class="print-section">
        <h2>7. Members</h2>
        <h3>Top givers for the period</h3>
        ${topGivers.length ? table(['Member', 'Total'],
          topGivers.map((r) => [esc(r.name), fmtMoney(r.total)]))
          : '<p class="muted-text">No giving recorded for this period.</p>'}
        <h3>Birthdays this month</h3>
        ${birthdays.length ? table(['Name', 'Birthday'],
          birthdays.map((r) => [esc(r.name), esc(fmtDobShort(r.date_of_birth))]))
          : '<p class="muted-text">None.</p>'}
      </section>
    </div>`;
  res.page({ title: 'All Reports', active: '/reports', body });
});

app.get('/reports/day-born', (req, res) => {
  const { start, end } = defaultRange(req);
  const params = { start, end };

  // 2.2 Summary cards (Z1)
  const summary = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total_amount),0) FROM services
        WHERE deleted_at IS NULL AND service_date BETWEEN @start AND @end) AS total_collected,
      (SELECT COUNT(*) FROM services
        WHERE deleted_at IS NULL AND service_date BETWEEN @start AND @end) AS services_held,
      (SELECT CASE WHEN COUNT(*)=0 THEN 0 ELSE ROUND(SUM(total_amount)*1.0/COUNT(*),2) END
        FROM services WHERE deleted_at IS NULL AND service_date BETWEEN @start AND @end) AS avg_per_service,
      (SELECT day_born FROM day_born_splits dbs
        JOIN services s ON s.service_id=dbs.service_id
        WHERE s.deleted_at IS NULL AND s.service_date BETWEEN @start AND @end
        GROUP BY day_born ORDER BY SUM(amount) DESC LIMIT 1) AS top_day_born
  `).get(params);

  // 2.3 Bar chart data (Z2)
  const bars = db.prepare(`
    WITH totals AS (
      SELECT day_born, SUM(amount) AS amt
      FROM day_born_splits dbs
      JOIN services s ON s.service_id=dbs.service_id
      WHERE s.deleted_at IS NULL AND s.service_date BETWEEN @start AND @end
      GROUP BY day_born
    ),
    mx AS (SELECT COALESCE(MAX(amt),1) AS m FROM totals)
    SELECT day_born, amt AS total_amount,
           ROUND(amt * 100.0 / (SELECT m FROM mx), 1) AS bar_width_pct
    FROM totals
    ORDER BY amt DESC
  `).all(params);

  // 2.6 Crosstab + TOTAL (Z3 + Z4)
  const cross = db.prepare(`
    SELECT dbs.day_born,
      SUM(CASE WHEN st.type_name='Sunday Service'    THEN dbs.amount ELSE 0 END) AS sunday_svc,
      SUM(CASE WHEN st.type_name='Wednesday Service' THEN dbs.amount ELSE 0 END) AS wednesday_svc,
      SUM(CASE WHEN st.type_name='Wedding Service'   THEN dbs.amount ELSE 0 END) AS weddings,
      SUM(CASE WHEN st.type_name='Funeral Service'   THEN dbs.amount ELSE 0 END) AS funerals,
      SUM(dbs.amount) AS day_total,
      ROUND(SUM(dbs.amount) * 100.0 / NULLIF((
        SELECT SUM(dbs3.amount) FROM day_born_splits dbs3
        JOIN services s3 ON s3.service_id=dbs3.service_id
        WHERE s3.deleted_at IS NULL AND s3.service_date BETWEEN @start AND @end), 0), 1) AS pct
    FROM day_born_splits dbs
    JOIN services s ON s.service_id=dbs.service_id
    JOIN service_types st ON st.service_type_id=s.service_type_id
    WHERE s.deleted_at IS NULL AND s.service_date BETWEEN @start AND @end
    GROUP BY dbs.day_born
    ORDER BY ${DAY_ORDER_CASE}
  `).all(params);

  const totals = cross.reduce((a, r) => ({
    sunday: a.sunday + r.sunday_svc,
    wed:    a.wed    + r.wednesday_svc,
    wed_svc: a.wed_svc + r.wednesday_svc,
    weddings: a.weddings + r.weddings,
    funerals: a.funerals + r.funerals,
    grand: a.grand + r.day_total,
  }), { sunday: 0, wed: 0, wed_svc: 0, weddings: 0, funerals: 0, grand: 0 });

  const z1 = `
    <div class="stat-grid">
      <div class="stat"><div class="ico green">₵</div><div>
        <div class="label">Total Collected</div>
        <div class="value">${fmtMoney(summary.total_collected)}</div></div></div>
      <div class="stat"><div class="ico blue">📅</div><div>
        <div class="label">Services Held</div>
        <div class="value">${summary.services_held}</div></div></div>
      <div class="stat"><div class="ico purple">∅</div><div>
        <div class="label">Avg per Service</div>
        <div class="value">${fmtMoney(summary.avg_per_service)}</div></div></div>
      <div class="stat"><div class="ico orange">★</div><div>
        <div class="label">Top Day-Born</div>
        <div class="value" style="font-size:1.2rem">${esc(summary.top_day_born) || '—'}</div></div></div>
    </div>`;

  const z2 = `
    <div class="card">
      <div class="card-head"><h2>Day-Born Contribution Bars</h2>
        <span class="meta">${esc(start)} → ${esc(end)}</span></div>
      ${bars.length ? `<div class="bar-list">${bars.map((b) => `
        <div class="bar-row">
          <div class="bar-label">${esc(b.day_born)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(b.bar_width_pct, 1)}%"></div></div>
          <div class="bar-value">${fmtMoney(b.total_amount)}</div>
        </div>`).join('')}</div>` : '<p class="muted-text">No day-born data for this period.</p>'}
    </div>`;

  const z3z4 = cross.length
    ? table(['Day-Born', 'Sunday Svc', 'Wed Svc', 'Weddings', 'Funerals', 'Total', '% of period'],
        cross.map((r) => [esc(r.day_born),
          fmtMoney(r.sunday_svc), fmtMoney(r.wednesday_svc),
          fmtMoney(r.weddings), fmtMoney(r.funerals),
          `<strong>${fmtMoney(r.day_total)}</strong>`,
          (r.pct == null ? '—' : r.pct + '%')])
          .concat([[
            '<strong>TOTAL</strong>',
            `<strong>${fmtMoney(totals.sunday)}</strong>`,
            `<strong>${fmtMoney(totals.wed_svc)}</strong>`,
            `<strong>${fmtMoney(totals.weddings)}</strong>`,
            `<strong>${fmtMoney(totals.funerals)}</strong>`,
            `<strong>${fmtMoney(totals.grand)}</strong>`,
            '<strong>100.0%</strong>',
          ]]))
    : '<p class="muted-text">No data for this period.</p>';

  res.page({
    title: 'Day-Born Collection Report', active: '/reports',
    body: `
      ${reportTabs('/reports/day-born')}
      ${rangeForm('/reports/day-born', start, end)}
      ${z1}
      ${z2}
      <h2>Detailed crosstab</h2>
      ${z3z4}
    `,
  });
});

// ---------- reports: collections ----------
app.get('/reports/collections', (req, res) => {
  const { start, end } = defaultRange(req);
  const year = req.query.year || new Date().getFullYear().toString();
  const yearA = req.query.year_a || year;
  const yearB = req.query.year_b || (parseInt(year, 10) - 1).toString();
  const ym = req.query.ym || (new Date()).toISOString().slice(0, 7);

  const weekly = db.prepare(`
    SELECT s.service_date,
      CASE strftime('%w', s.service_date)
        WHEN '0' THEN 'Sunday' WHEN '1' THEN 'Monday' WHEN '2' THEN 'Tuesday'
        WHEN '3' THEN 'Wednesday' WHEN '4' THEN 'Thursday' WHEN '5' THEN 'Friday'
        WHEN '6' THEN 'Saturday' END AS day_name,
      COUNT(*) AS num_services, SUM(s.total_amount) AS daily_total
    FROM services s
    WHERE s.deleted_at IS NULL AND s.service_date BETWEEN ? AND ?
    GROUP BY s.service_date
    ORDER BY s.service_date
  `).all(start, end);

  const monthly = db.prepare(`
    SELECT 'Service Offerings' source, COALESCE(SUM(total_amount),0) total
    FROM services WHERE deleted_at IS NULL AND substr(service_date,1,7)=?
    UNION ALL
    SELECT 'Harvests', COALESCE(SUM(total_collected),0) FROM harvests
    WHERE deleted_at IS NULL AND
          strftime('%Y-%m', COALESCE(harvest_date, harvest_year || '-01-01'))=?
    UNION ALL
    SELECT 'Special Offerings', COALESCE(SUM(amount),0) FROM special_offerings
    WHERE deleted_at IS NULL AND substr(offering_date,1,7)=?
  `).all(ym, ym, ym);

  const annual = db.prepare(`
    SELECT strftime('%m', service_date) AS m,
           COUNT(*) AS num_services, SUM(total_amount) AS total
    FROM services WHERE deleted_at IS NULL AND strftime('%Y', service_date)=?
    GROUP BY m ORDER BY m
  `).all(year);

  const yoy = db.prepare(`
    SELECT st.type_name,
      SUM(CASE WHEN strftime('%Y', s.service_date)=@a THEN s.total_amount ELSE 0 END) AS a_total,
      SUM(CASE WHEN strftime('%Y', s.service_date)=@b THEN s.total_amount ELSE 0 END) AS b_total
    FROM services s
    JOIN service_types st ON st.service_type_id=s.service_type_id
    WHERE s.deleted_at IS NULL
      AND strftime('%Y', s.service_date) IN (@a, @b)
    GROUP BY st.type_name ORDER BY st.type_name
  `).all({ a: yearA, b: yearB });

  const body = `
    ${reportTabs('/reports/collections')}
    ${rangeForm('/reports/collections', start, end, `
      <label>Month <input type="month" name="ym" value="${esc(ym)}"></label>
      <label>Year <input type="number" name="year" value="${esc(year)}" min="2000" max="2200" style="width:6rem"></label>
      <label>Compare <input type="number" name="year_a" value="${esc(yearA)}" style="width:5rem">
        vs <input type="number" name="year_b" value="${esc(yearB)}" style="width:5rem"></label>`)}

    <h2>Weekly summary (${esc(start)} → ${esc(end)})</h2>
    ${weekly.length ? table(['Date', 'Day', 'Services', 'Total'],
      weekly.map((r) => [esc(r.service_date), esc(r.day_name), r.num_services, fmtMoney(r.daily_total)]))
      : '<p class="muted-text">No service offerings recorded.</p>'}

    <h2>Monthly roll-up · ${esc(ym)}</h2>
    ${table(['Source', 'Total'], monthly.map((r) => [esc(r.source), fmtMoney(r.total)]))}

    <h2>Annual breakdown · ${esc(year)}</h2>
    ${annual.length ? table(['Month', 'Services', 'Total'],
      annual.map((r) => [MONTH_NAMES[parseInt(r.m, 10)], r.num_services, fmtMoney(r.total)]))
      : '<p class="muted-text">No services recorded this year.</p>'}

    <h2>Year-over-year by service type</h2>
    ${table([`Service type`, esc(yearA), esc(yearB), 'Diff'],
      yoy.map((r) => [esc(r.type_name), fmtMoney(r.a_total), fmtMoney(r.b_total),
        fmtMoney(r.a_total - r.b_total)]))}
  `;
  res.page({ title: 'Collections Report', active: '/reports', body });
});

// ---------- reports: harvests ----------
app.get('/reports/harvests', (req, res) => {
  const year = req.query.year || new Date().getFullYear().toString();
  const harvestId = req.query.harvest_id ? Number(req.query.harvest_id) : null;

  const status = db.prepare(`
    SELECT h.harvest_id, h.harvest_name, h.harvest_type, h.harvest_year, h.theme,
           o.name AS org_name, h.total_collected,
           COALESCE((SELECT SUM(pledged_amount) FROM pledges WHERE harvest_id=h.harvest_id),0) AS pledged,
           COALESCE((SELECT SUM(paid_amount)    FROM pledges WHERE harvest_id=h.harvest_id),0) AS pledged_paid
    FROM harvests h
    LEFT JOIN organizations o USING(org_id)
    WHERE h.deleted_at IS NULL AND h.harvest_year=?
    ORDER BY h.harvest_type, o.name
  `).all(year);

  const rankings = db.prepare(`
    SELECT o.name AS org_name, COUNT(h.harvest_id) AS harvests_count,
           SUM(h.total_collected) AS total_raised
    FROM harvests h
    JOIN organizations o USING(org_id)
    WHERE h.deleted_at IS NULL AND h.harvest_type='Organizational' AND h.harvest_year=?
    GROUP BY o.org_id, o.name
    ORDER BY total_raised DESC
  `).all(year);

  const harvestsForSelect = db.prepare(
    `SELECT harvest_id, harvest_name, harvest_year FROM harvests
       WHERE deleted_at IS NULL ORDER BY harvest_year DESC, harvest_id DESC`
  ).all();

  let pledgeRows = [];
  let pledgeSummary = null;
  if (harvestId) {
    pledgeRows = db.prepare(`
      SELECT m.first_name || ' ' || m.last_name AS member, m.day_born,
             m.member_id, o.name AS org_name,
             p.pledged_amount, p.paid_amount,
             (p.pledged_amount - p.paid_amount) AS outstanding,
             ROUND(p.paid_amount * 100.0 / p.pledged_amount, 1) AS pct_paid,
             p.status
      FROM pledges p
      JOIN members m USING(member_id)
      LEFT JOIN organization_memberships om ON om.member_id=m.member_id
      LEFT JOIN organizations o ON o.org_id=om.org_id
      WHERE p.harvest_id=? AND m.deleted_at IS NULL
      GROUP BY p.pledge_id
      ORDER BY outstanding DESC, p.pledged_amount DESC
    `).all(harvestId);
    pledgeSummary = db.prepare(`
      SELECT h.harvest_name,
             COUNT(p.pledge_id) AS total_pledgers,
             COALESCE(SUM(p.pledged_amount),0) AS total_pledged,
             COALESCE(SUM(p.paid_amount),0) AS total_paid,
             COALESCE(SUM(p.pledged_amount - p.paid_amount),0) AS total_outstanding,
             SUM(CASE WHEN p.status='Fulfilled' THEN 1 ELSE 0 END) AS fulfilled,
             SUM(CASE WHEN p.status='Partial'   THEN 1 ELSE 0 END) AS partial,
             SUM(CASE WHEN p.status='Pending'   THEN 1 ELSE 0 END) AS pending
      FROM harvests h LEFT JOIN pledges p ON p.harvest_id=h.harvest_id
      WHERE h.harvest_id=?
      GROUP BY h.harvest_id, h.harvest_name
    `).get(harvestId);
  }

  const harvestOpts = '<option value="">— pick a harvest —</option>' +
    harvestsForSelect.map((h) =>
      `<option value="${h.harvest_id}" ${h.harvest_id === harvestId ? 'selected' : ''}>${esc(h.harvest_name)} (${h.harvest_year})</option>`
    ).join('');

  const body = `
    ${reportTabs('/reports/harvests')}
    <form class="filters" method="get" action="/reports/harvests">
      <label>Year <input type="number" name="year" value="${esc(year)}" style="width:6rem"></label>
      <label>Harvest for pledge detail <select name="harvest_id">${harvestOpts}</select></label>
      <button type="submit">Apply</button>
      <details class="export"><summary>⋯ Export</summary>
        <a href="javascript:window.print()">Print / PDF</a></details>
    </form>

    <h2>Harvest status · ${esc(year)}</h2>
    ${status.length ? table(['Type', 'Name', 'Organization', 'Theme', 'Collected', 'Pledged', 'Pledges paid'],
      status.map((r) => [esc(r.harvest_type),
        `<a href="/finance/harvests/${r.harvest_id}">${esc(r.harvest_name)}</a>`,
        esc(r.org_name) || 'Church-wide', esc(r.theme),
        fmtMoney(r.total_collected), fmtMoney(r.pledged), fmtMoney(r.pledged_paid)]))
      : '<p class="muted-text">No harvests this year.</p>'}

    <h2>Organizational rankings · ${esc(year)}</h2>
    ${rankings.length ? table(['Position', 'Organization', 'Harvests', 'Raised'],
      rankings.map((r, i) => [`#${i + 1}`, esc(r.org_name), r.harvests_count, fmtMoney(r.total_raised)]))
      : '<p class="muted-text">No organizational harvests this year.</p>'}

    ${pledgeSummary ? `
      <h2>Pledge summary — ${esc(pledgeSummary.harvest_name)}</h2>
      <div class="stat-grid">
        <div class="stat"><div class="ico purple">⛳</div><div>
          <div class="label">Pledgers</div><div class="value">${pledgeSummary.total_pledgers}</div></div></div>
        <div class="stat"><div class="ico blue">↑</div><div>
          <div class="label">Pledged</div><div class="value">${fmtMoney(pledgeSummary.total_pledged)}</div></div></div>
        <div class="stat"><div class="ico green">✓</div><div>
          <div class="label">Paid</div><div class="value">${fmtMoney(pledgeSummary.total_paid)}</div></div></div>
        <div class="stat"><div class="ico orange">!</div><div>
          <div class="label">Outstanding</div><div class="value">${fmtOutstanding(pledgeSummary.total_outstanding)}</div></div></div>
      </div>
      <p class="muted-text">Status counts: ${pledgeSummary.fulfilled} fulfilled · ${pledgeSummary.partial} partial · ${pledgeSummary.pending} pending</p>
      <h3>Pledgers</h3>
      ${pledgeRows.length ? table(['Member', 'Day-Born', 'Organization', 'Pledged', 'Paid', 'Outstanding', '% paid', 'Status'],
        pledgeRows.map((p) => [
          `<a href="/members/${p.member_id}">${esc(p.member)}</a>`,
          esc(p.day_born) || '—', esc(p.org_name) || '—',
          fmtMoney(p.pledged_amount), fmtMoney(p.paid_amount),
          fmtOutstanding(p.outstanding),
          (p.pct_paid == null ? '—' : p.pct_paid + '%'),
          `<span class="pill pill-${esc((p.status || '').toLowerCase())}">${esc(p.status)}</span>`]))
        : '<p class="muted-text">No pledges for this harvest.</p>'}
    ` : ''}
  `;
  res.page({ title: 'Harvest Reports', active: '/reports', body });
});

// ---------- reports: special offerings ----------
app.get('/reports/special', (req, res) => {
  const { start, end } = defaultRange(req);
  const year = req.query.year || new Date().getFullYear().toString();

  const byCat = db.prepare(`
    SELECT sc.category_name,
      COUNT(sp.special_id) AS num,
      COALESCE(SUM(sp.amount),0) AS total,
      COALESCE(AVG(sp.amount),0) AS avg_amt,
      MIN(sp.amount) AS smallest, MAX(sp.amount) AS largest
    FROM special_offerings sp
    JOIN special_categories sc USING(special_cat_id)
    WHERE sp.deleted_at IS NULL AND sp.offering_date BETWEEN ? AND ?
    GROUP BY sc.special_cat_id, sc.category_name
    ORDER BY total DESC
  `).all(start, end);

  const byDonor = db.prepare(`
    SELECT COALESCE(m.first_name || ' ' || m.last_name, sp.donor_name_manual, 'Anonymous') AS donor,
           m.day_born, m.member_id,
           COUNT(sp.special_id) AS times_given,
           COALESCE(SUM(sp.amount),0) AS total
    FROM special_offerings sp
    LEFT JOIN members m ON m.member_id=sp.donor_id
    WHERE sp.deleted_at IS NULL AND sp.offering_date BETWEEN ? AND ?
    GROUP BY donor, m.day_born, m.member_id
    ORDER BY total DESC LIMIT 50
  `).all(start, end);

  const overTime = db.prepare(`
    SELECT strftime('%Y-%m', sp.offering_date) AS ym,
           sc.category_name, SUM(sp.amount) AS total
    FROM special_offerings sp
    JOIN special_categories sc USING(special_cat_id)
    WHERE sp.deleted_at IS NULL AND strftime('%Y', sp.offering_date)=?
    GROUP BY ym, sc.category_name
    ORDER BY ym, sc.category_name
  `).all(year);

  const receipts = db.prepare(`
    SELECT sp.receipt_number, sp.offering_date, sc.category_name,
           COALESCE(m.first_name || ' ' || m.last_name, sp.donor_name_manual, 'Anonymous') AS donor,
           sp.amount, COALESCE(u.display_name, u.username) AS recorded_by
    FROM special_offerings sp
    JOIN special_categories sc USING(special_cat_id)
    LEFT JOIN members m ON m.member_id=sp.donor_id
    LEFT JOIN users u ON u.user_id=sp.recorded_by
    WHERE sp.deleted_at IS NULL AND sp.receipt_number IS NOT NULL
      AND sp.offering_date BETWEEN ? AND ?
    ORDER BY sp.offering_date DESC, sp.receipt_number
  `).all(start, end);

  const body = `
    ${reportTabs('/reports/special')}
    ${rangeForm('/reports/special', start, end,
      `<label>Year for time series <input type="number" name="year" value="${esc(year)}" style="width:6rem"></label>`)}

    <h2>By category</h2>
    ${byCat.length ? table(['Category', '#', 'Total', 'Avg', 'Smallest', 'Largest'],
      byCat.map((r) => [esc(r.category_name), r.num, fmtMoney(r.total),
        fmtMoney(r.avg_amt), fmtMoney(r.smallest), fmtMoney(r.largest)]))
      : '<p class="muted-text">None in this period.</p>'}

    <h2>By donor (top 50)</h2>
    ${byDonor.length ? table(['Donor', 'Day-Born', '#', 'Total'],
      byDonor.map((r) => [r.member_id ? `<a href="/members/${r.member_id}">${esc(r.donor)}</a>` : esc(r.donor),
        esc(r.day_born) || '—', r.times_given, fmtMoney(r.total)]))
      : '<p class="muted-text">None in this period.</p>'}

    <h2>Over time · ${esc(year)}</h2>
    ${overTime.length ? table(['Month', 'Category', 'Total'],
      overTime.map((r) => [esc(r.ym), esc(r.category_name), fmtMoney(r.total)]))
      : '<p class="muted-text">No data for this year.</p>'}

    <h2>Receipts issued</h2>
    ${receipts.length ? table(['Receipt #', 'Date', 'Category', 'Donor', 'Amount', 'Recorded by'],
      receipts.map((r) => [esc(r.receipt_number), esc(r.offering_date),
        esc(r.category_name), esc(r.donor), fmtMoney(r.amount), esc(r.recorded_by)]))
      : '<p class="muted-text">No receipted offerings in this period.</p>'}
  `;
  res.page({ title: 'Special Offerings Report', active: '/reports', body });
});

// ---------- reports: expenses ----------
app.get('/reports/expenses', (req, res) => {
  const { start, end } = defaultRange(req);
  const year = req.query.year || new Date().getFullYear().toString();

  const byCat = db.prepare(`
    SELECT COALESCE(ec.category_name, e.category) AS cat,
           COUNT(*) AS num, SUM(e.amount) AS total, AVG(e.amount) AS avg_amt
    FROM expenses e
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    WHERE e.spent_on BETWEEN ? AND ?
    GROUP BY cat
    ORDER BY total DESC
  `).all(start, end);

  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', e.spent_on) AS ym,
           COALESCE(ec.category_name, e.category) AS cat,
           SUM(e.amount) AS total
    FROM expenses e
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    WHERE strftime('%Y', e.spent_on)=?
    GROUP BY ym, cat
    ORDER BY ym, total DESC
  `).all(year);

  const byMethod = db.prepare(`
    SELECT COALESCE(payment_method, '(unspecified)') AS method,
           COUNT(*) AS num, SUM(amount) AS total
    FROM expenses
    WHERE spent_on BETWEEN ? AND ?
    GROUP BY method
    ORDER BY total DESC
  `).all(start, end);

  const noReceipt = db.prepare(`
    SELECT e.spent_on, COALESCE(ec.category_name, e.category) AS cat,
           e.description, e.amount, e.paid_to
    FROM expenses e
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    WHERE COALESCE(e.receipt_attached, 0) = 0
      AND e.spent_on BETWEEN ? AND ?
    ORDER BY e.spent_on DESC LIMIT 100
  `).all(start, end);

  const body = `
    ${reportTabs('/reports/expenses')}
    ${rangeForm('/reports/expenses', start, end,
      `<label>Year for monthly view <input type="number" name="year" value="${esc(year)}" style="width:6rem"></label>`)}

    <h2>By category</h2>
    ${byCat.length ? table(['Category', '#', 'Total', 'Avg'],
      byCat.map((r) => [esc(r.cat), r.num, fmtMoney(r.total), fmtMoney(r.avg_amt)]))
      : '<p class="muted-text">No expenses in this period.</p>'}

    <h2>Monthly breakdown · ${esc(year)}</h2>
    ${monthly.length ? table(['Month', 'Category', 'Total'],
      monthly.map((r) => [esc(r.ym), esc(r.cat), fmtMoney(r.total)]))
      : '<p class="muted-text">No expenses this year.</p>'}

    <h2>By payment method</h2>
    ${byMethod.length ? table(['Method', '#', 'Total'],
      byMethod.map((r) => [esc(r.method), r.num, fmtMoney(r.total)]))
      : ''}

    <h2>Receipts pending</h2>
    ${noReceipt.length ? table(['Date', 'Category', 'Description', 'Paid to', 'Amount'],
      noReceipt.map((r) => [esc(r.spent_on), esc(r.cat), esc(r.description),
        esc(r.paid_to), fmtMoney(r.amount)]))
      : '<p class="muted-text">All receipts are attached. ✓</p>'}
  `;
  res.page({ title: 'Expenses Report', active: '/reports', body });
});

// ---------- reports: financial summary ----------
app.get('/reports/financial.csv', (req, res) => {
  const { start, end } = defaultRange(req);
  const year = req.query.year || new Date().getFullYear().toString();
  const totals = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total_amount),0) FROM services
        WHERE deleted_at IS NULL AND service_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(total_collected),0) FROM harvests
        WHERE deleted_at IS NULL AND COALESCE(harvest_date, harvest_year || '-01-01') BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM special_offerings
        WHERE deleted_at IS NULL AND offering_date BETWEEN @s AND @e) AS income,
      (SELECT COALESCE(SUM(amount),0) FROM expenses
        WHERE spent_on BETWEEN @s AND @e) AS expenses
  `).get({ s: start, e: end });
  const cashFlow = db.prepare(`
    WITH mi AS (
      SELECT strftime('%Y-%m', service_date) AS ym, SUM(total_amount) AS amt
        FROM services WHERE deleted_at IS NULL AND strftime('%Y', service_date)=@y
        GROUP BY ym
      UNION ALL
      SELECT strftime('%Y-%m', COALESCE(harvest_date, harvest_year || '-01-01')),
             SUM(total_collected)
        FROM harvests WHERE deleted_at IS NULL AND harvest_year=CAST(@y AS INTEGER)
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', offering_date), SUM(amount)
        FROM special_offerings WHERE deleted_at IS NULL AND strftime('%Y', offering_date)=@y
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', tithe_date), SUM(amount)
        FROM tithes WHERE deleted_at IS NULL AND strftime('%Y', tithe_date)=@y
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', transaction_date), SUM(amount)
        FROM income_records WHERE deleted_at IS NULL AND strftime('%Y', transaction_date)=@y
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', collection_date), SUM(amount)
        FROM day_born_collections WHERE deleted_at IS NULL AND strftime('%Y', collection_date)=@y
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', paid_on), SUM(amount)
        FROM pledge_payments WHERE strftime('%Y', paid_on)=@y
        GROUP BY 1
    ),
    me AS (
      SELECT strftime('%Y-%m', spent_on) AS ym, SUM(amount) AS amt
        FROM expenses WHERE strftime('%Y', spent_on)=@y GROUP BY ym
    ),
    months AS (SELECT DISTINCT ym FROM mi UNION SELECT DISTINCT ym FROM me)
    SELECT m.ym AS year_month,
           COALESCE((SELECT SUM(amt) FROM mi WHERE mi.ym=m.ym), 0) AS income,
           COALESCE((SELECT amt FROM me WHERE me.ym=m.ym), 0) AS expenses
    FROM months m ORDER BY m.ym
  `).all({ y: year });
  const rows = [
    ['Section', 'Period/Month', 'Income', 'Expenses', 'Net'],
    ['Summary', `${start} to ${end}`, totals.income, totals.expenses, totals.income - totals.expenses],
    ...cashFlow.map((r) => ['Cash flow', r.year_month, r.income, r.expenses, r.income - r.expenses]),
  ];
  sendCsv(res, `financial-summary-${year}.csv`, rows);
});

app.get('/reports/financial', (req, res) => {
  const { start, end } = defaultRange(req);
  const year = req.query.year || new Date().getFullYear().toString();

  const totals = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total_amount),0) FROM services
        WHERE deleted_at IS NULL AND service_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(total_collected),0) FROM harvests
        WHERE deleted_at IS NULL AND COALESCE(harvest_date, harvest_year || '-01-01') BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM special_offerings
        WHERE deleted_at IS NULL AND offering_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM tithes
        WHERE deleted_at IS NULL AND tithe_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM income_records
        WHERE deleted_at IS NULL AND transaction_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM day_born_collections
        WHERE deleted_at IS NULL AND collection_date BETWEEN @s AND @e)
      + (SELECT COALESCE(SUM(amount),0) FROM pledge_payments
        WHERE paid_on BETWEEN @s AND @e) AS income,
      (SELECT COALESCE(SUM(amount),0) FROM expenses
        WHERE spent_on BETWEEN @s AND @e) AS expenses
  `).get({ s: start, e: end });
  const net = totals.income - totals.expenses;

  const cashFlow = db.prepare(`
    WITH mi AS (
      SELECT strftime('%Y-%m', service_date) AS ym, SUM(total_amount) AS amt
        FROM services WHERE deleted_at IS NULL AND strftime('%Y', service_date)=@y
        GROUP BY ym
      UNION ALL
      SELECT strftime('%Y-%m', COALESCE(harvest_date, harvest_year || '-01-01')),
             SUM(total_collected)
        FROM harvests WHERE deleted_at IS NULL AND harvest_year=CAST(@y AS INTEGER)
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', offering_date), SUM(amount)
        FROM special_offerings WHERE deleted_at IS NULL AND strftime('%Y', offering_date)=@y
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', tithe_date), SUM(amount)
        FROM tithes WHERE deleted_at IS NULL AND strftime('%Y', tithe_date)=@y
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', transaction_date), SUM(amount)
        FROM income_records WHERE deleted_at IS NULL AND strftime('%Y', transaction_date)=@y
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', collection_date), SUM(amount)
        FROM day_born_collections WHERE deleted_at IS NULL AND strftime('%Y', collection_date)=@y
        GROUP BY 1
      UNION ALL
      SELECT strftime('%Y-%m', paid_on), SUM(amount)
        FROM pledge_payments WHERE strftime('%Y', paid_on)=@y
        GROUP BY 1
    ),
    me AS (
      SELECT strftime('%Y-%m', spent_on) AS ym, SUM(amount) AS amt
        FROM expenses WHERE strftime('%Y', spent_on)=@y GROUP BY ym
    ),
    months AS (SELECT DISTINCT ym FROM mi UNION SELECT DISTINCT ym FROM me)
    SELECT m.ym AS year_month,
           COALESCE((SELECT SUM(amt) FROM mi WHERE mi.ym=m.ym), 0) AS income,
           COALESCE((SELECT amt FROM me WHERE me.ym=m.ym), 0) AS expenses
    FROM months m ORDER BY m.ym
  `).all({ y: year });

  const groupSummary = db.prepare(`
    SELECT o.org_id, o.name AS org_name,
           (SELECT COUNT(*) FROM organization_memberships om
             JOIN members m ON m.member_id=om.member_id
             WHERE om.org_id=o.org_id AND m.deleted_at IS NULL) AS member_count,
           COALESCE((SELECT SUM(total_collected) FROM harvests
             WHERE deleted_at IS NULL AND org_id=o.org_id
               AND harvest_year=CAST(? AS INTEGER)),0) AS org_harvest_total,
           COALESCE((SELECT SUM(p.paid_amount) FROM pledges p
             JOIN organization_memberships om2 ON om2.member_id=p.member_id
             JOIN harvests h ON h.harvest_id=p.harvest_id
             WHERE om2.org_id=o.org_id AND h.harvest_year=CAST(? AS INTEGER)), 0)
           AS member_pledges_paid
    FROM organizations o
    WHERE o.active=1
    ORDER BY (org_harvest_total + member_pledges_paid) DESC
  `).all(year, year);

  const body = `
    ${reportTabs('/reports/financial')}
    ${rangeForm('/reports/financial', start, end,
      `<label>Year for cash flow <input type="number" name="year" value="${esc(year)}" style="width:6rem"></label>`)}
    <p><a class="btn ghost" href="/reports/financial.csv?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&year=${encodeURIComponent(year)}">Export financial CSV</a></p>

    <h2>Income vs Expenses (${esc(start)} → ${esc(end)})</h2>
    <div class="stat-grid">
      <div class="stat"><div class="ico green">↑</div><div>
        <div class="label">Total income</div>
        <div class="value">${fmtMoney(totals.income)}</div></div></div>
      <div class="stat"><div class="ico orange">↓</div><div>
        <div class="label">Total expenses</div>
        <div class="value">${fmtMoney(totals.expenses)}</div></div></div>
      <div class="stat"><div class="ico purple">=</div><div>
        <div class="label">Net</div>
        <div class="value" style="color:${net >= 0 ? 'var(--pos)' : 'var(--danger)'}">${fmtMoney(net)}</div></div></div>
    </div>

    <h2>Cash flow · ${esc(year)}</h2>
    ${cashFlow.length ? table(['Month', 'Income', 'Expenses', 'Net'],
      cashFlow.map((r) => [esc(r.year_month), fmtMoney(r.income),
        fmtMoney(r.expenses), fmtMoney(r.income - r.expenses)]))
      : '<p class="muted-text">No financial activity in this year.</p>'}

    <h2>Group / organization contribution · ${esc(year)}</h2>
    ${table(['Organization', 'Members', 'Org harvest total', 'Member pledges paid', 'Total'],
      groupSummary.map((r) => [esc(r.org_name), r.member_count,
        fmtMoney(r.org_harvest_total), fmtMoney(r.member_pledges_paid),
        `<strong>${fmtMoney(r.org_harvest_total + r.member_pledges_paid)}</strong>`]))}
  `;
  res.page({ title: 'Financial Summary', active: '/reports', body });
});

// ---------- reports: in-depth finance ----------
app.get('/reports/income.csv', (req, res) => {
  const { start, end } = defaultRange(req);
  const rows = incomeRows(start, end);
  sendCsv(res, 'income-detail.csv', [
    ['Date', 'Category', 'Detail', 'Giver', 'Amount', 'Source'],
    ...rows.map((row) => [row.dt, row.category, row.detail || '', row.giver || '', row.amount, row.source]),
  ]);
});

app.get('/reports/income', (req, res) => {
  const { start, end } = defaultRange(req);
  const rows = incomeRows(start, end);
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const byCategory = groupTotals(rows, 'category');
  const bySource = groupTotals(rows, 'source');
  const topGivers = groupTotals(rows.filter((row) => row.giver), 'giver').slice(0, 20);
  const monthly = db.prepare(`
    WITH income AS (
      SELECT service_date dt, total_amount amount FROM services WHERE deleted_at IS NULL AND total_amount > 0
      UNION ALL SELECT tithe_date, amount FROM tithes WHERE deleted_at IS NULL
      UNION ALL SELECT transaction_date, amount FROM income_records WHERE deleted_at IS NULL
      UNION ALL SELECT collection_date, amount FROM day_born_collections WHERE deleted_at IS NULL
      UNION ALL SELECT COALESCE(harvest_date, harvest_year || '-01-01'), total_collected FROM harvests WHERE deleted_at IS NULL AND total_collected > 0
      UNION ALL SELECT offering_date, amount FROM special_offerings WHERE deleted_at IS NULL
      UNION ALL SELECT paid_on, amount FROM pledge_payments
    )
    SELECT substr(dt, 1, 7) ym, COALESCE(SUM(amount),0) total
    FROM income
    WHERE dt BETWEEN @start AND @end
    GROUP BY ym ORDER BY ym`).all({ start, end });
  const body = `
    ${reportTabs('/reports/income')}
    ${rangeForm('/reports/income', start, end, `<a class="btn ghost" href="/reports/income.csv?start=${esc(start)}&end=${esc(end)}">Export CSV</a>`)}
    ${statsRow([
      { cls: 'green', icon: '₵', value: fmtMoney(total), label: 'Total income' },
      { cls: 'blue', icon: '#', value: rows.length, label: 'Income records' },
      { cls: 'purple', icon: '↗', value: byCategory.length, label: 'Categories' },
    ])}
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Income by category</h2><span class="meta">${esc(start)} → ${esc(end)}</span></div>
      ${byCategory.length ? table(['Category', 'Records', 'Total'],
        byCategory.map((row) => [esc(row.label), row.count, fmtMoney(row.total)]))
        : '<p class="muted-text">No income in this period.</p>'}
    </section>
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Income by source</h2><span class="meta">Finance app style source mix</span></div>
      ${bySource.length ? table(['Source', 'Records', 'Total'],
        bySource.map((row) => [esc(row.label), row.count, fmtMoney(row.total)]))
        : '<p class="muted-text">No source mix available.</p>'}
    </section>
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Monthly income trend</h2><span class="meta">Period activity</span></div>
      ${monthly.length ? table(['Month', 'Total'], monthly.map((row) => [esc(row.ym), fmtMoney(row.total)]))
        : '<p class="muted-text">No monthly trend for this period.</p>'}
    </section>
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Top givers / payers</h2><span class="meta">Named records only</span></div>
      ${topGivers.length ? table(['Name', 'Records', 'Total'],
        topGivers.map((row) => [esc(row.label), row.count, fmtMoney(row.total)]))
        : '<p class="muted-text">No named givers in this period.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><h2>Income register</h2><span class="meta">${rows.length} rows</span></div>
      ${rows.length ? table(['Date', 'Category', 'Detail', 'Giver', 'Amount', 'Source'],
        rows.slice(0, 200).map((row) => [
          esc(row.dt), esc(row.category), esc(row.detail || '—'), esc(row.giver || '—'), fmtMoney(row.amount), esc(row.source),
        ])) : '<p class="muted-text">No income in this period.</p>'}
    </section>`;
  res.page({ title: 'Income Detail Report', active: '/reports', body });
});

app.get('/reports/expense-detail.csv', (req, res) => {
  const { start, end } = defaultRange(req);
  const rows = db.prepare(`
    SELECT e.spent_on, COALESCE(ec.category_name, e.category) category, e.description,
           e.paid_to, e.payment_method, f.name fund_name, p.name project_name, e.amount, e.approval_status
    FROM expenses e
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    LEFT JOIN funds f USING(fund_id)
    LEFT JOIN finance_projects p USING(project_id)
    WHERE e.spent_on BETWEEN ? AND ?
    ORDER BY e.spent_on DESC, e.expense_id DESC`).all(start, end);
  sendCsv(res, 'expense-detail.csv', [
    ['Date', 'Category', 'Description', 'Paid To', 'Method', 'Fund', 'Project', 'Amount', 'Status'],
    ...rows.map((row) => [
      row.spent_on, row.category || '', row.description || '', row.paid_to || '',
      row.payment_method || '', row.fund_name || '', row.project_name || '', row.amount, row.approval_status || '',
    ]),
  ]);
});

app.get('/reports/expense-detail', (req, res) => {
  const { start, end } = defaultRange(req);
  const rows = db.prepare(`
    SELECT e.*, COALESCE(ec.category_name, e.category) category_name, f.name fund_name, p.name project_name
    FROM expenses e
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    LEFT JOIN funds f USING(fund_id)
    LEFT JOIN finance_projects p USING(project_id)
    WHERE e.spent_on BETWEEN ? AND ?
    ORDER BY e.spent_on DESC, e.expense_id DESC`).all(start, end);
  const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const categoryRows = groupTotals(rows.map((row) => ({ ...row, amount: row.amount, category: row.category_name })), 'category');
  const methodRows = groupTotals(rows.map((row) => ({ ...row, amount: row.amount, method: row.payment_method || 'Unspecified' })), 'method');
  const fundRows = groupTotals(rows.map((row) => ({ ...row, amount: row.amount, fund: row.fund_name || 'General fund' })), 'fund');
  const body = `
    ${reportTabs('/reports/expense-detail')}
    ${rangeForm('/reports/expense-detail', start, end, `<a class="btn ghost" href="/reports/expense-detail.csv?start=${esc(start)}&end=${esc(end)}">Export CSV</a>`)}
    ${statsRow([
      { cls: 'orange', icon: '₵', value: fmtMoney(total), label: 'Total expenses' },
      { cls: 'blue', icon: '#', value: rows.length, label: 'Expense records' },
      { cls: 'purple', icon: '↘', value: categoryRows.length, label: 'Categories' },
    ])}
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Expenses by category</h2><span class="meta">Control spending by type</span></div>
      ${categoryRows.length ? table(['Category', 'Records', 'Total'],
        categoryRows.map((row) => [esc(row.label), row.count, fmtMoney(row.total)]))
        : '<p class="muted-text">No expenses in this period.</p>'}
    </section>
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Expenses by payment method</h2><span class="meta">Cash, bank, mobile money and other</span></div>
      ${methodRows.length ? table(['Method', 'Records', 'Total'],
        methodRows.map((row) => [esc(row.label), row.count, fmtMoney(row.total)]))
        : '<p class="muted-text">No payment-method totals.</p>'}
    </section>
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Expenses by fund</h2><span class="meta">Restricted fund visibility</span></div>
      ${fundRows.length ? table(['Fund', 'Records', 'Total'],
        fundRows.map((row) => [esc(row.label), row.count, fmtMoney(row.total)]))
        : '<p class="muted-text">No fund totals.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><h2>Expense register</h2><span class="meta">${rows.length} rows</span></div>
      ${rows.length ? table(['Date', 'Category', 'Description', 'Paid to', 'Method', 'Fund', 'Project', 'Amount', 'Status'],
        rows.slice(0, 200).map((row) => [
          esc(row.spent_on), esc(row.category_name || '—'), esc(row.description || '—'),
          esc(row.paid_to || '—'), esc(row.payment_method || '—'),
          esc(row.fund_name || 'General fund'), esc(row.project_name || '—'),
          fmtMoney(row.amount), esc(row.approval_status || 'PAID'),
        ])) : '<p class="muted-text">No expenses in this period.</p>'}
    </section>`;
  res.page({ title: 'Expense Detail Report', active: '/reports', body });
});

app.get('/reports/funds', (req, res) => {
  const funds = db.prepare(`
    SELECT f.fund_id, COALESCE(f.code, '') code, f.name, f.fund_type, f.restricted, f.opening_balance, f.responsible_officer,
           ROUND(COALESCE(SUM(CASE WHEN a.account_type='INCOME' THEN jl.credit - jl.debit ELSE 0 END),0),2) raised,
           ROUND(COALESCE(SUM(CASE WHEN a.account_type='EXPENSE' THEN jl.debit - jl.credit ELSE 0 END),0),2) spent
    FROM funds f
    LEFT JOIN journal_lines jl ON jl.fund_id=f.fund_id
    LEFT JOIN journal_entries je ON je.entry_id=jl.entry_id AND je.status IN ('POSTED','REVERSED')
    LEFT JOIN accounts a ON a.account_id=jl.account_id
    WHERE f.active=1
    GROUP BY f.fund_id
    ORDER BY f.restricted DESC, f.name`).all();
  const rows = funds.map((fund) => ({
    ...fund,
    balance: Number(fund.opening_balance || 0) + Number(fund.raised || 0) - Number(fund.spent || 0),
  }));
  const totals = rows.reduce((acc, row) => {
    acc.opening += Number(row.opening_balance || 0);
    acc.raised += Number(row.raised || 0);
    acc.spent += Number(row.spent || 0);
    acc.balance += Number(row.balance || 0);
    if (row.restricted) acc.restricted += Number(row.balance || 0);
    return acc;
  }, { opening: 0, raised: 0, spent: 0, balance: 0, restricted: 0 });
  const body = `
    ${reportTabs('/reports/funds')}
    <div class="page-actions">
      <a class="btn ghost" href="/finance/reports/funds">Printable finance fund report</a>
      <a class="btn ghost" href="/finance/reports/funds.csv">Export CSV</a>
    </div>
    ${statsRow([
      { cls: 'green', icon: '₵', value: fmtMoney(totals.balance), label: 'Total fund balance' },
      { cls: 'orange', icon: 'R', value: fmtMoney(totals.restricted), label: 'Restricted balance' },
      { cls: 'blue', icon: '#', value: rows.length, label: 'Active funds' },
    ])}
    <section class="card">
      <div class="card-head"><h2>Fund movement</h2><span class="meta">Ledger-derived raised and spent totals</span></div>
      ${rows.length ? table(['Code', 'Fund', 'Type', 'Restriction', 'Officer', 'Opening', 'Raised', 'Spent', 'Balance'],
        rows.map((row) => [
          esc(row.code) || '—', esc(row.name), esc((row.fund_type || 'GENERAL').replace(/_/g, ' ')),
          row.restricted ? 'Restricted' : 'Unrestricted',
          esc(row.responsible_officer || '—'),
          fmtMoney(row.opening_balance || 0), fmtMoney(row.raised), fmtMoney(row.spent), `<strong>${fmtMoney(row.balance)}</strong>`,
        ]).concat([[
          '', '<strong>Total</strong>', '', '', '',
          `<strong>${fmtMoney(totals.opening)}</strong>`,
          `<strong>${fmtMoney(totals.raised)}</strong>`,
          `<strong>${fmtMoney(totals.spent)}</strong>`,
          `<strong>${fmtMoney(totals.balance)}</strong>`,
        ]])) : '<p class="muted-text">No active funds configured.</p>'}
    </section>`;
  res.page({ title: 'Fund Report', active: '/reports', body });
});

// ---------- reports: member-focused (existing reports) ----------
app.get('/reports/members', (req, res) => {
  const attendanceTrend = db.prepare(`
    SELECT e.starts_at, e.title, COUNT(a.member_id) attendees
    FROM events e LEFT JOIN attendance a USING(event_id)
    WHERE e.event_type='service'
    GROUP BY e.event_id ORDER BY e.starts_at DESC LIMIT 12`).all();
  const topGivers = db.prepare(`
    SELECT m.member_id, m.first_name || ' ' || m.last_name name,
           ROUND(SUM(sp.amount),2) total
    FROM special_offerings sp
    JOIN members m ON m.member_id = sp.donor_id
    WHERE sp.deleted_at IS NULL AND m.deleted_at IS NULL
      AND substr(sp.offering_date,1,4)=strftime('%Y','now')
    GROUP BY m.member_id ORDER BY total DESC LIMIT 10`).all();
  const birthdays = db.prepare(`
    SELECT member_id, first_name || ' ' || last_name name, date_of_birth
    FROM members WHERE deleted_at IS NULL AND date_of_birth IS NOT NULL
      AND strftime('%m', date_of_birth)=strftime('%m','now')
    ORDER BY strftime('%d', date_of_birth)`).all();
  const missing = db.prepare(`
    WITH last_services AS (
      SELECT event_id FROM events WHERE event_type='service'
      ORDER BY starts_at DESC LIMIT 3
    )
    SELECT m.member_id, m.first_name || ' ' || m.last_name name, m.email
    FROM members m
    WHERE m.deleted_at IS NULL AND m.membership_status IN ('member','regular')
      AND NOT EXISTS (SELECT 1 FROM attendance a
        WHERE a.member_id=m.member_id AND a.event_id IN (SELECT event_id FROM last_services))`).all();

  const body = `
    ${reportTabs('/reports/members')}
    <h2>Service attendance (last 12)</h2>
    ${table(['Date', 'Title', 'Attendees'],
      attendanceTrend.map((r) => [esc(r.starts_at), esc(r.title), r.attendees]))}

    <h2>Top givers YTD</h2>
    ${topGivers.length ? table(['Member', 'Total'],
      topGivers.map((r) => [`<a href="/members/${r.member_id}">${esc(r.name)}</a>`, fmtMoney(r.total)]))
      : '<p class="muted-text">No giving recorded yet this year.</p>'}

    <h2>Birthdays this month</h2>
    ${birthdays.length ? table(['Name', 'Birthday'],
      birthdays.map((r) => [`<a href="/members/${r.member_id}">${esc(r.name)}</a>`, esc(fmtDobShort(r.date_of_birth))]))
      : '<p class="muted-text">None.</p>'}

    <h2>Missed the last 3 Sundays</h2>
    ${missing.length ? table(['Name', 'Email'],
      missing.map((r) => [`<a href="/members/${r.member_id}">${esc(r.name)}</a>`, esc(r.email)]))
      : '<p class="muted-text">Everyone has been attending. 🎉</p>'}
  `;
  res.page({ title: 'Member Reports', active: '/reports', body });
});
};
