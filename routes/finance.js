'use strict';
// Finance: overview, services, harvests, special offerings, tithes, pledges,
// receipts/outstanding statements, giving statements, expenses. Record-only
// ledger (amounts received in person; no payment processing). register(app, ctx).
const { esc, fmtMoney, fmtDate, fmtOutstanding, todayISO, DAYS_OF_WEEK,
  isValidDate, isMoneyNonNeg, isMoneyPositive } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { financeYtd, givingByMember, safeYear, givingYears, memberGivingForYear: libGiving } = require('../lib/finance');

module.exports.register = function register(app, ctx) {
  const { db, requireAdmin, logActivity, flash, CHURCH_NAME, sendSmsBatch, sendEmailEach, loadOrganizations } = ctx;
  const memberGivingForYear = (id, y) => libGiving(db, id, y);

// ---------- finance: shared helpers ----------
const FINANCE_TABS = [
  ['/finance',          'Overview'],
  ['/finance/services', 'Services'],
  ['/finance/tithes',   'Tithes'],
  ['/finance/harvests', 'Harvests'],
  ['/finance/special',  'Special Offerings'],
  ['/finance/pledges',  'Pledges'],
  ['/finance/statements', 'Statements'],
  ['/finance/receipts', 'Receipts'],
  ['/finance/expenses', 'Expenses'],
];
function financeTabs(activePath) {
  return `<div class="finance-tabs">${FINANCE_TABS.map(([href, label]) =>
    `<a class="${href === activePath ? 'active' : ''}" href="${href}">${esc(label)}</a>`).join('')}</div>`;
}
function loadServiceTypes() {
  return db.prepare(`SELECT service_type_id, type_name FROM service_types WHERE is_active=1 ORDER BY type_name`).all();
}
function loadSpecialCategories() {
  return db.prepare(`SELECT special_cat_id, category_name FROM special_categories WHERE is_active=1 ORDER BY category_name`).all();
}
function loadExpenseCategories() {
  return db.prepare(`SELECT expense_cat_id, category_name FROM expense_categories WHERE is_active=1 ORDER BY category_name`).all();
}
function loadMembersList() {
  return db.prepare(`SELECT member_id, first_name || ' ' || last_name AS name, external_id
                     FROM members WHERE deleted_at IS NULL ORDER BY last_name`).all();
}

// Parse day-born inputs from a form body. Returns array of {day, amount, head_count}.
function parseDayBornInputs(b) {
  return DAYS_OF_WEEK.map((day) => ({
    day,
    amount: Number(b[`day_${day}_amount`] || 0),
    head_count: Number(b[`day_${day}_heads`] || 0),
  })).filter((r) => r.amount > 0 || r.head_count > 0);
}
function dayBornFormInputs() {
  return `<div class="day-born-grid">${DAYS_OF_WEEK.map((d) => `
    <div class="db-cell">
      <div class="db-day">${d}</div>
      <label>Amount<input type="number" step="0.01" min="0" name="day_${d}_amount"></label>
      <label>Heads<input type="number" min="0" name="day_${d}_heads"></label>
    </div>`).join('')}</div>`;
}

// ---------- finance: overview ----------
app.get('/finance', (req, res) => {
  const { services, harvests, special, tithes: tithesYtd, expenses, offerings, net } =
    financeYtd(db, new Date().getFullYear());

  const recentServices = db.prepare(`
    SELECT s.service_id, s.service_date, s.total_amount, st.type_name
    FROM services s JOIN service_types st USING(service_type_id)
    WHERE s.deleted_at IS NULL
    ORDER BY s.service_date DESC, s.service_id DESC LIMIT 5`).all();
  const recentSpecial = db.prepare(`
    SELECT sp.special_id, sp.offering_date, sp.amount, sc.category_name,
           COALESCE(m.first_name || ' ' || m.last_name, sp.donor_name_manual, '(anonymous)') donor
    FROM special_offerings sp
    JOIN special_categories sc USING(special_cat_id)
    LEFT JOIN members m ON m.member_id = sp.donor_id
    WHERE sp.deleted_at IS NULL
    ORDER BY sp.offering_date DESC, sp.special_id DESC LIMIT 5`).all();
  const dayBornYtd = db.prepare(`
    SELECT day_born, ROUND(SUM(amount),2) total, SUM(head_count) heads
    FROM day_born_splits dbs
    LEFT JOIN services s USING(service_id)
    WHERE (s.service_date IS NULL OR substr(s.service_date,1,4)=strftime('%Y','now'))
    GROUP BY day_born`).all();
  const dayBornMap = Object.fromEntries(dayBornYtd.map((r) => [r.day_born, r]));

  const body = `
    ${pageHero('Finance', 'Offerings, tithes, harvests and expenses — this year at a glance.')}
    ${financeTabs('/finance')}
    <div class="page-actions">
      <a class="btn primary" href="/finance/services/new">＋ Record Service</a>
      <a class="btn purple" href="/finance/special/new">＋ Special Offering</a>
      <a class="btn ghost" href="/finance/expenses/new">＋ Expense</a>
    </div>
    ${statsRow([
      { cls: 'gold', icon: '₵', value: fmtMoney(services), label: 'Service Offerings YTD' },
      { cls: 'green', icon: '🤲', value: fmtMoney(tithesYtd), label: 'Tithes YTD' },
      { cls: 'blue', icon: '🌾', value: fmtMoney(harvests), label: 'Harvests YTD' },
      { cls: 'purple', icon: '✨', value: fmtMoney(special), label: 'Special Offerings YTD' },
      { cls: 'orange', icon: '🧾', value: fmtMoney(expenses), label: 'Expenses YTD' },
    ])}
    <div class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Net YTD</h2><span class="meta">Offerings + Harvests − Expenses</span></div>
      <div class="value" style="font-size:1.8rem;font-weight:700;color:${net >= 0 ? 'var(--pos)' : 'var(--danger)'}">${fmtMoney(net)}</div>
    </div>

    <div class="two-col">
      <section class="card">
        <div class="card-head"><h2>Recent Services</h2><a href="/finance/services">View all</a></div>
        ${recentServices.length ? table(['Date', 'Type', 'Total'],
          recentServices.map((s) => [esc(s.service_date),
            `<a href="/finance/services/${s.service_id}">${esc(s.type_name)}</a>`,
            fmtMoney(s.total_amount)])) : '<p class="muted-text">No services recorded yet.</p>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Recent Special Offerings</h2><a href="/finance/special">View all</a></div>
        ${recentSpecial.length ? table(['Date', 'Donor', 'Category', 'Amount'],
          recentSpecial.map((s) => [esc(s.offering_date), esc(s.donor),
            esc(s.category_name), fmtMoney(s.amount)])) : '<p class="muted-text">None yet.</p>'}
      </section>
    </div>

    <div class="card" style="margin-top:1rem">
      <div class="card-head"><h2>Day-Born Totals (YTD)</h2><span class="meta">Service offerings</span></div>
      ${table(['Day', 'Amount', 'Heads'],
        DAYS_OF_WEEK.map((d) => {
          const r = dayBornMap[d] || { total: 0, heads: 0 };
          return [esc(d), fmtMoney(r.total || 0), r.heads || 0];
        }))}
    </div>`;
  res.page({ title: 'Finance', active: '/finance', noHeader: true, body });
});

// Old "quick add" shortcut — point to the services page.
app.get('/finance/new', requireAdmin, (req, res) => res.redirect('/finance/services'));

// ---------- finance: services ----------
app.get('/finance/services', (req, res) => {
  const types = loadServiceTypes();
  const recent = db.prepare(`
    SELECT s.service_id, s.service_date, s.total_amount, s.notes,
           st.type_name, u.display_name, u.username
    FROM services s
    JOIN service_types st USING(service_type_id)
    LEFT JOIN users u ON u.user_id = s.recorded_by
    WHERE s.deleted_at IS NULL
    ORDER BY s.service_date DESC, s.service_id DESC LIMIT 50`).all();
  const typeOpts = types.map((t) => `<option value="${t.service_type_id}">${esc(t.type_name)}</option>`).join('');
  const addForm = res.locals.isAdmin
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record a service</strong></summary>
         <form class="form" method="post" action="/finance/services" style="margin-top:0.75rem">
           <label>Date<input type="date" name="service_date" required value="${todayISO()}"></label>
           <label>Service type<select name="service_type_id" required>${typeOpts}</select></label>
           <label>Total amount (GH₵)<input type="number" step="0.01" min="0" name="total_amount" required></label>
           <label class="wide">Notes<input name="notes"></label>
           <fieldset class="wide">
             <legend>Day-born breakdown (optional)</legend>
             ${dayBornFormInputs()}
           </fieldset>
           <div class="actions"><button type="submit">Save service</button></div>
         </form>
       </details>` : '';
  const body = `
    ${financeTabs('/finance/services')}
    ${addForm}
    ${recent.length ? table(['Date', 'Type', 'Total', 'Recorded by', ''],
      recent.map((s) => [esc(s.service_date),
        `<a href="/finance/services/${s.service_id}">${esc(s.type_name)}</a>`,
        fmtMoney(s.total_amount),
        esc(s.display_name || s.username || '—'),
        `<a class="btn ghost" href="/finance/services/${s.service_id}">Open</a>`]))
      : '<p class="muted-text">No services recorded yet.</p>'}`;
  res.page({ title: 'Finance · Services', active: '/finance', body });
});

app.post('/finance/services', requireAdmin, (req, res) => {
  const b = req.body;
  if (!Number(b.service_type_id)) { flash(req, 'Choose a service type.'); return res.redirect('/finance/services'); }
  if (!isValidDate(b.service_date)) { flash(req, 'Enter a valid service date.'); return res.redirect('/finance/services'); }
  if (!isMoneyNonNeg(b.total_amount)) { flash(req, 'Amount must be a number of 0 or more.'); return res.redirect('/finance/services'); }
  const info = db.prepare(`
    INSERT INTO services (service_type_id, service_date, total_amount, recorded_by, notes)
    VALUES (?, ?, ?, ?, ?)`).run(
    Number(b.service_type_id), b.service_date, Number(b.total_amount),
    res.locals.user.user_id, b.notes || null
  );
  const splits = parseDayBornInputs(b);
  const insSplit = db.prepare(`INSERT INTO day_born_splits (service_id, day_born, amount, head_count) VALUES (?, ?, ?, ?)`);
  for (const s of splits) insSplit.run(info.lastInsertRowid, s.day, s.amount, s.head_count);
  logActivity('contribution_recorded',
    `Service offering of ${fmtMoney(b.total_amount)} recorded`,
    `/finance/services/${info.lastInsertRowid}`, res.locals.user.user_id);
  res.redirect(`/finance/services/${info.lastInsertRowid}`);
});

app.get('/finance/services/:id', (req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare(`
    SELECT s.*, st.type_name FROM services s
    JOIN service_types st USING(service_type_id)
    WHERE s.service_id=? AND s.deleted_at IS NULL`).get(id);
  if (!s) return res.status(404).send('Not found');
  const splits = db.prepare(
    `SELECT day_born, amount, head_count FROM day_born_splits WHERE service_id=? ORDER BY split_id`
  ).all(id);
  const splitMap = Object.fromEntries(splits.map((sp) => [sp.day_born, sp]));
  const addSplit = res.locals.isAdmin
    ? `<h2>Day-born breakdown</h2>
       <form class="form" method="post" action="/finance/services/${id}/splits">
         <fieldset class="wide">
           ${dayBornFormInputs()}
         </fieldset>
         <div class="actions"><button type="submit">Save breakdown</button></div>
       </form>` : '';
  const splitTotal = splits.reduce((a, b) => a + b.amount, 0);
  const headTotal = splits.reduce((a, b) => a + (b.head_count || 0), 0);
  const body = `
    ${financeTabs('/finance/services')}
    <div class="card">
      <div class="card-head"><h2>${esc(s.type_name)} · ${esc(s.service_date)}</h2>
        <span class="meta">${fmtMoney(s.total_amount)}</span></div>
      ${s.notes ? `<p>${esc(s.notes)}</p>` : ''}
    </div>
    <h2>Current breakdown</h2>
    ${splits.length
      ? table(['Day', 'Amount', 'Heads'],
          DAYS_OF_WEEK.map((d) => [d,
            fmtMoney((splitMap[d] || {}).amount || 0),
            (splitMap[d] || {}).head_count || 0])
            .concat([['Total', fmtMoney(splitTotal), headTotal]]))
      : '<p class="muted-text">No breakdown recorded.</p>'}
    ${addSplit}
    ${res.locals.isAdmin ? `<form method="post" action="/finance/services/${id}/delete"
        onsubmit="return confirm('Archive this service?')" style="margin-top:1rem">
        <button class="danger" type="submit">Archive service</button>
      </form>` : ''}`;
  res.page({ title: `${s.type_name} · ${s.service_date}`, active: '/finance', body });
});

app.post('/finance/services/:id/splits', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM day_born_splits WHERE service_id=?`).run(id);
  const splits = parseDayBornInputs(req.body);
  const insSplit = db.prepare(`INSERT INTO day_born_splits (service_id, day_born, amount, head_count) VALUES (?, ?, ?, ?)`);
  for (const s of splits) insSplit.run(id, s.day, s.amount, s.head_count);
  res.redirect(`/finance/services/${id}`);
});

app.post('/finance/services/:id/delete', requireAdmin, (req, res) => {
  db.prepare(`UPDATE services SET deleted_at=CURRENT_TIMESTAMP WHERE service_id=?`).run(Number(req.params.id));
  res.redirect('/finance/services');
});

// ---------- finance: harvests ----------
app.get('/finance/harvests', (req, res) => {
  const orgs = loadOrganizations();
  const recent = db.prepare(`
    SELECT h.*, o.name AS org_name FROM harvests h
    LEFT JOIN organizations o USING(org_id)
    WHERE h.deleted_at IS NULL
    ORDER BY h.harvest_year DESC, h.harvest_id DESC LIMIT 50`).all();
  const orgOpts = '<option value="">(church-wide)</option>' +
    orgs.map((o) => `<option value="${o.org_id}">${esc(o.name)}</option>`).join('');
  const addForm = res.locals.isAdmin
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Add a harvest</strong></summary>
         <form class="form" method="post" action="/finance/harvests" style="margin-top:0.75rem">
           <label>Type<select name="harvest_type" required>
             <option value="End-of-Year">End-of-Year</option>
             <option value="Organizational">Organizational</option>
             <option value="Other">Other</option>
           </select></label>
           <label>Year<input type="number" name="harvest_year" required value="${new Date().getFullYear()}"></label>
           <label class="wide">Name<input name="harvest_name" required placeholder="e.g. 2026 End-of-Year Harvest"></label>
           <label>Harvest date<input type="date" name="harvest_date" value="${todayISO()}"></label>
           <label>Organization<select name="org_id">${orgOpts}</select></label>
           <label class="wide">Theme<input name="theme"></label>
           <label>Total collected (GH₵)<input type="number" step="0.01" min="0" name="total_collected" value="0"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save harvest</button></div>
         </form>
       </details>` : '';
  const body = `
    ${financeTabs('/finance/harvests')}
    ${addForm}
    ${recent.length ? table(['Year', 'Type', 'Name', 'Organization', 'Date', 'Collected', ''],
      recent.map((h) => [h.harvest_year, esc(h.harvest_type),
        `<a href="/finance/harvests/${h.harvest_id}">${esc(h.harvest_name)}</a>`,
        esc(h.org_name) || '—', esc(h.harvest_date) || '—',
        fmtMoney(h.total_collected),
        `<a class="btn ghost" href="/finance/harvests/${h.harvest_id}">Open</a>`]))
      : '<p class="muted-text">No harvests recorded yet.</p>'}`;
  res.page({ title: 'Finance · Harvests', active: '/finance', body });
});

app.post('/finance/harvests', requireAdmin, (req, res) => {
  const b = req.body;
  const info = db.prepare(`
    INSERT INTO harvests (harvest_type, harvest_name, harvest_year, harvest_date, theme,
                          org_id, total_collected, recorded_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    b.harvest_type, b.harvest_name, Number(b.harvest_year),
    b.harvest_date || null, b.theme || null,
    b.org_id ? Number(b.org_id) : null,
    Number(b.total_collected || 0), res.locals.user.user_id, b.notes || null
  );
  res.redirect(`/finance/harvests/${info.lastInsertRowid}`);
});

app.get('/finance/harvests/:id', (req, res) => {
  const id = Number(req.params.id);
  const h = db.prepare(`
    SELECT h.*, o.name AS org_name FROM harvests h
    LEFT JOIN organizations o USING(org_id)
    WHERE h.harvest_id=? AND h.deleted_at IS NULL`).get(id);
  if (!h) return res.status(404).send('Not found');
  const splits = db.prepare(
    `SELECT day_born, amount, head_count FROM day_born_splits WHERE harvest_id=?`
  ).all(id);
  const splitMap = Object.fromEntries(splits.map((sp) => [sp.day_born, sp]));
  const pledges = db.prepare(`
    SELECT p.*, m.member_id, m.first_name || ' ' || m.last_name AS member
    FROM pledges p JOIN members m USING(member_id)
    WHERE p.harvest_id=? ORDER BY p.pledge_date DESC`).all(id);
  const totalPledged = pledges.reduce((a, b) => a + b.pledged_amount, 0);
  const totalPaid = pledges.reduce((a, b) => a + b.paid_amount, 0);

  const addSplit = res.locals.isAdmin
    ? `<h2>Day-born breakdown</h2>
       <form class="form" method="post" action="/finance/harvests/${id}/splits">
         <fieldset class="wide">${dayBornFormInputs()}</fieldset>
         <div class="actions"><button type="submit">Save breakdown</button></div>
       </form>` : '';

  const body = `
    ${financeTabs('/finance/harvests')}
    <div class="card">
      <div class="card-head"><h2>${esc(h.harvest_name)}</h2>
        <span class="meta">${esc(h.harvest_type)} · ${h.harvest_year}</span></div>
      <p>${esc(h.theme) || ''}</p>
      <dl class="stats">
        <dt>Date</dt><dd>${esc(h.harvest_date) || '—'}</dd>
        <dt>Organization</dt><dd>${esc(h.org_name) || 'Church-wide'}</dd>
        <dt>Total collected</dt><dd>${fmtMoney(h.total_collected)}</dd>
        <dt>Total pledged</dt><dd>${fmtMoney(totalPledged)} (paid ${fmtMoney(totalPaid)})</dd>
      </dl>
    </div>
    <h2>Day-born breakdown</h2>
    ${splits.length
      ? table(['Day', 'Amount', 'Heads'],
          DAYS_OF_WEEK.map((d) => [d,
            fmtMoney((splitMap[d] || {}).amount || 0),
            (splitMap[d] || {}).head_count || 0]))
      : '<p class="muted-text">No breakdown recorded.</p>'}
    ${addSplit}
    <h2>Pledges</h2>
    ${pledges.length
      ? table(['Date', 'Member', 'Pledged', 'Paid', 'Outstanding', 'Status'],
          pledges.map((p) => [esc(p.pledge_date),
            `<a href="/members/${p.member_id}">${esc(p.member)}</a>`,
            fmtMoney(p.pledged_amount), fmtMoney(p.paid_amount),
            fmtOutstanding(p.pledged_amount - p.paid_amount),
            esc(p.status)]))
      : '<p class="muted-text">No pledges yet. Add them from the <a href="/finance/pledges">Pledges</a> tab.</p>'}
    ${res.locals.isAdmin ? `<form method="post" action="/finance/harvests/${id}/delete"
        onsubmit="return confirm('Archive this harvest?')" style="margin-top:1rem">
        <button class="danger" type="submit">Archive harvest</button>
      </form>` : ''}`;
  res.page({ title: h.harvest_name, active: '/finance', body });
});

app.post('/finance/harvests/:id/splits', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM day_born_splits WHERE harvest_id=?`).run(id);
  const splits = parseDayBornInputs(req.body);
  const insSplit = db.prepare(`INSERT INTO day_born_splits (harvest_id, day_born, amount, head_count) VALUES (?, ?, ?, ?)`);
  for (const s of splits) insSplit.run(id, s.day, s.amount, s.head_count);
  res.redirect(`/finance/harvests/${id}`);
});

app.post('/finance/harvests/:id/delete', requireAdmin, (req, res) => {
  db.prepare(`UPDATE harvests SET deleted_at=CURRENT_TIMESTAMP WHERE harvest_id=?`).run(Number(req.params.id));
  res.redirect('/finance/harvests');
});

// ---------- finance: special offerings ----------
app.get('/finance/special', (req, res) => {
  const cats = loadSpecialCategories();
  const members = loadMembersList();
  const rows = db.prepare(`
    SELECT sp.special_id, sp.offering_date, sp.amount, sp.purpose, sp.receipt_number,
           sc.category_name, sp.donor_id, sp.donor_name_manual,
           m.first_name || ' ' || m.last_name AS member_name
    FROM special_offerings sp
    JOIN special_categories sc USING(special_cat_id)
    LEFT JOIN members m ON m.member_id = sp.donor_id
    WHERE sp.deleted_at IS NULL
    ORDER BY sp.offering_date DESC, sp.special_id DESC LIMIT 100`).all();
  const catOpts = cats.map((c) => `<option value="${c.special_cat_id}">${esc(c.category_name)}</option>`).join('');
  const memOpts = '<option value="">(non-member or anonymous)</option>' +
    members.map((m) => `<option value="${m.member_id}">${esc(m.name)}${m.external_id ? ' · ' + esc(m.external_id) : ''}</option>`).join('');
  const addForm = res.locals.isAdmin
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record a special offering</strong></summary>
         <form class="form" method="post" action="/finance/special" style="margin-top:0.75rem">
           <label>Date<input type="date" name="offering_date" required value="${todayISO()}"></label>
           <label>Category<select name="special_cat_id" required>${catOpts}</select></label>
           <label>Member<select name="donor_id">${memOpts}</select></label>
           <label>Manual donor name<input name="donor_name_manual" placeholder="if not a member"></label>
           <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
           <label>Receipt #<input name="receipt_number"></label>
           <label class="wide">Purpose<input name="purpose"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save</button></div>
         </form>
       </details>` : '';
  const body = `
    ${financeTabs('/finance/special')}
    ${addForm}
    ${rows.length ? table(['Date', 'Donor', 'Category', 'Amount', 'Receipt', 'Purpose'],
      rows.map((r) => [esc(r.offering_date),
        r.donor_id ? `<a href="/members/${r.donor_id}">${esc(r.member_name)}</a>`
          : esc(r.donor_name_manual) || '(anonymous)',
        esc(r.category_name), fmtMoney(r.amount), esc(r.receipt_number),
        esc(r.purpose)]))
      : '<p class="muted-text">No special offerings recorded yet.</p>'}`;
  res.page({ title: 'Finance · Special Offerings', active: '/finance', body });
});

app.post('/finance/special', requireAdmin, (req, res) => {
  const b = req.body;
  if (!Number(b.special_cat_id)) { flash(req, 'Choose a category.'); return res.redirect('/finance/special'); }
  if (!isValidDate(b.offering_date)) { flash(req, 'Enter a valid offering date.'); return res.redirect('/finance/special'); }
  if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/special'); }
  db.prepare(`
    INSERT INTO special_offerings (special_cat_id, offering_date, donor_id, donor_name_manual,
      amount, purpose, receipt_number, recorded_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    Number(b.special_cat_id), b.offering_date,
    b.donor_id ? Number(b.donor_id) : null,
    b.donor_name_manual || null,
    Number(b.amount), b.purpose || null, b.receipt_number || null,
    res.locals.user.user_id, b.notes || null
  );
  logActivity('contribution_recorded',
    `Special offering of ${fmtMoney(b.amount)} recorded`,
    '/finance/special', res.locals.user.user_id);
  res.redirect('/finance/special');
});

// ---------- finance: tithes ----------
app.get('/finance/tithes', (req, res) => {
  const memberId = req.query.member_id ? Number(req.query.member_id) : null;
  const members = loadMembersList();
  const memOpts = '<option value="">— all members —</option>' +
    members.map((m) => `<option value="${m.member_id}" ${m.member_id === memberId ? 'selected' : ''}>${esc(m.name)}${m.external_id ? ' · ' + esc(m.external_id) : ''}</option>`).join('');
  const memOptsForm = members.map((m) => `<option value="${m.member_id}">${esc(m.name)}${m.external_id ? ' · ' + esc(m.external_id) : ''}</option>`).join('');

  const where = memberId ? 'AND t.member_id = ?' : '';
  const params = memberId ? [memberId] : [];

  const rows = db.prepare(`
    SELECT t.tithe_id, t.member_id, t.tithe_date, t.amount, t.method, t.reference, t.notes,
           m.first_name || ' ' || m.last_name AS member, m.external_id,
           COALESCE(u.display_name, u.username) AS recorded_by
    FROM tithes t
    JOIN members m USING(member_id)
    LEFT JOIN users u ON u.user_id = t.recorded_by
    WHERE t.deleted_at IS NULL ${where}
    ORDER BY t.tithe_date DESC, t.tithe_id DESC LIMIT 200
  `).all(...params);

  const ytdTotal = db.prepare(`
    SELECT COALESCE(SUM(amount),0) t FROM tithes
    WHERE deleted_at IS NULL ${where ? where.replace('t.member_id', 'member_id') : ''}
      AND substr(tithe_date,1,4) = strftime('%Y','now')
  `).get(...params).t;
  const monthTotal = db.prepare(`
    SELECT COALESCE(SUM(amount),0) t FROM tithes
    WHERE deleted_at IS NULL ${where ? where.replace('t.member_id', 'member_id') : ''}
      AND substr(tithe_date,1,7) = strftime('%Y-%m','now')
  `).get(...params).t;
  const tithers = db.prepare(`
    SELECT COUNT(DISTINCT member_id) c FROM tithes
    WHERE deleted_at IS NULL
      AND substr(tithe_date,1,4) = strftime('%Y','now')
  `).get().c;

  // Top tithers YTD (when not filtered).
  const topTithers = memberId ? [] : db.prepare(`
    SELECT m.member_id, m.first_name || ' ' || m.last_name AS name, m.external_id,
           ROUND(SUM(t.amount), 2) AS total
    FROM tithes t JOIN members m USING(member_id)
    WHERE t.deleted_at IS NULL AND m.deleted_at IS NULL
      AND substr(t.tithe_date,1,4) = strftime('%Y','now')
    GROUP BY m.member_id ORDER BY total DESC LIMIT 10
  `).all();

  const addForm = res.locals.isAdmin
    ? `<details class="form-toggle" style="margin-bottom:1rem" ${memberId ? 'open' : ''}>
         <summary><strong>+ Record a tithe</strong></summary>
         <form class="form" method="post" action="/finance/tithes" style="margin-top:0.75rem">
           <label>Member<select name="member_id" required>
             ${memberId ? `<option value="${memberId}" selected>${esc((members.find((x) => x.member_id === memberId) || {}).name) || '?'}</option>` : ''}
             ${memOptsForm}
           </select></label>
           <label>Date<input type="date" name="tithe_date" required value="${todayISO()}"></label>
           <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
           <label>Method<select name="method">
             ${['cash','check','card','online','mobile_money','transfer','other'].map((m) => `<option>${m}</option>`).join('')}
           </select></label>
           <label>Reference<input name="reference" placeholder="e.g. MoMo ID"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save</button></div>
         </form>
       </details>` : '';

  const memberFilter = `
    <form class="filters" method="get" action="/finance/tithes">
      <label>Filter by member <select name="member_id" onchange="this.form.submit()">${memOpts}</select></label>
      <noscript><button type="submit">Apply</button></noscript>
      ${memberId ? `<a class="btn ghost" href="/finance/tithes">Clear filter</a>` : ''}
    </form>`;

  const stats = `
    <div class="stat-grid">
      <div class="stat"><div class="ico green">₵</div><div>
        <div class="label">${memberId ? "Member's YTD" : 'YTD Tithes'}</div>
        <div class="value">${fmtMoney(ytdTotal)}</div></div></div>
      <div class="stat"><div class="ico blue">📅</div><div>
        <div class="label">${memberId ? "Member's this month" : 'This month'}</div>
        <div class="value">${fmtMoney(monthTotal)}</div></div></div>
      ${memberId ? '' : `
        <div class="stat"><div class="ico purple">👥</div><div>
          <div class="label">Distinct tithers YTD</div>
          <div class="value">${tithers}</div></div></div>`}
    </div>`;

  const tithesTable = rows.length
    ? table(['Date', 'Member', 'ID', 'Amount', 'Method', 'Reference', 'By'],
        rows.map((r) => [esc(r.tithe_date),
          `<a href="/members/${r.member_id}">${esc(r.member)}</a>`,
          esc(r.external_id) || '—',
          fmtMoney(r.amount), esc(r.method), esc(r.reference),
          esc(r.recorded_by)]))
    : '<p class="muted-text">No tithes recorded for this filter.</p>';

  const topTable = topTithers.length
    ? `<h2>Top tithers · this year</h2>
       ${table(['Member', 'Member ID', 'YTD total'],
         topTithers.map((r) => [`<a href="/members/${r.member_id}">${esc(r.name)}</a>`,
           esc(r.external_id) || '—', fmtMoney(r.total)]))}`
    : '';

  res.page({
    title: 'Finance · Tithes', active: '/finance',
    body: `${financeTabs('/finance/tithes')}
      ${memberFilter}
      ${stats}
      ${addForm}
      ${memberId ? '<h2>Tithe history</h2>' : '<h2>Recent tithes</h2>'}
      ${tithesTable}
      ${topTable}`,
  });
});

app.post('/finance/tithes', requireAdmin, (req, res) => {
  const b = req.body;
  if (!b.member_id || !b.amount || !b.tithe_date) return res.redirect('/finance/tithes');
  const info = db.prepare(`
    INSERT INTO tithes (member_id, amount, tithe_date, method, reference, notes, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    Number(b.member_id), Number(b.amount), b.tithe_date,
    b.method || null, b.reference || null, b.notes || null,
    res.locals.user.user_id
  );
  const m = db.prepare(`SELECT first_name, last_name FROM members WHERE member_id=?`).get(Number(b.member_id));
  logActivity('contribution_recorded',
    `Tithe of ${fmtMoney(b.amount)} from ${m ? m.first_name + ' ' + m.last_name : 'a member'}`,
    `/finance/tithes?member_id=${b.member_id}`, res.locals.user.user_id);
  res.redirect(`/finance/tithes?member_id=${b.member_id}`);
});

// ---------- finance: pledges ----------
app.get('/finance/pledges', (req, res) => {
  const harvests = db.prepare(
    `SELECT harvest_id, harvest_name, harvest_year FROM harvests
       WHERE deleted_at IS NULL ORDER BY harvest_year DESC`
  ).all();
  const members = loadMembersList();
  const rows = db.prepare(`
    SELECT p.*, m.member_id, m.first_name || ' ' || m.last_name AS member,
           h.harvest_name
    FROM pledges p
    JOIN members m USING(member_id)
    JOIN harvests h USING(harvest_id)
    WHERE m.deleted_at IS NULL
    ORDER BY p.pledge_date DESC, p.pledge_id DESC LIMIT 100`).all();
  const harvestOpts = harvests.map((h) => `<option value="${h.harvest_id}">${esc(h.harvest_name)}</option>`).join('');
  const memOpts = members.map((m) => `<option value="${m.member_id}">${esc(m.name)}</option>`).join('');
  const addForm = res.locals.isAdmin && harvests.length
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record a pledge</strong></summary>
         <form class="form" method="post" action="/finance/pledges" style="margin-top:0.75rem">
           <label>Member<select name="member_id" required>${memOpts}</select></label>
           <label>Harvest<select name="harvest_id" required>${harvestOpts}</select></label>
           <label>Pledged amount<input type="number" step="0.01" min="0.01" name="pledged_amount" required></label>
           <label>Paid amount<input type="number" step="0.01" min="0" name="paid_amount" value="0"></label>
           <label>Pledge date<input type="date" name="pledge_date" required value="${todayISO()}"></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save</button></div>
         </form>
       </details>`
    : (res.locals.isAdmin ? '<p class="muted-text">Add a harvest first on the Harvests tab.</p>' : '');
  const tbl = rows.length
    ? table(['Date', 'Member', 'Harvest', 'Pledged', 'Paid', 'Outstanding', 'Status', ''],
        rows.map((p) => [esc(p.pledge_date),
          `<a href="/members/${p.member_id}">${esc(p.member)}</a>`,
          esc(p.harvest_name),
          fmtMoney(p.pledged_amount), fmtMoney(p.paid_amount),
          fmtOutstanding(p.pledged_amount - p.paid_amount),
          `<span class="pill pill-${esc(p.status.toLowerCase())}">${esc(p.status)}</span>`,
          res.locals.isAdmin
            ? `<form method="post" action="/finance/pledges/${p.pledge_id}/pay" class="inline">
                 <input type="number" step="0.01" min="0" name="add" placeholder="add">
                 <button type="submit">Record</button>
               </form>
               <a class="btn-link" href="/finance/pledges/${p.pledge_id}/edit" style="margin-left:0.5rem">Edit</a>` : '']))
    : '<p class="muted-text">No pledges recorded yet.</p>';
  const body = `
    ${financeTabs('/finance/pledges')}
    ${addForm}
    ${tbl}`;
  res.page({ title: 'Finance · Pledges', active: '/finance', body });
});

app.post('/finance/pledges', requireAdmin, (req, res) => {
  const b = req.body;
  const pledged = Number(b.pledged_amount);
  const paid = Number(b.paid_amount || 0);
  const status = paid <= 0 ? 'Pending' : paid >= pledged ? 'Fulfilled' : 'Partial';
  db.prepare(`
    INSERT INTO pledges (member_id, harvest_id, pledged_amount, paid_amount, pledge_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    Number(b.member_id), Number(b.harvest_id),
    pledged, paid, b.pledge_date, status, b.notes || null
  );
  res.redirect('/finance/pledges');
});

app.post('/finance/pledges/:id/pay', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const add = Number(req.body.add || 0);
  if (add <= 0) return res.redirect('/finance/pledges');
  const receipt = recordPledgePayment(id, add, todayISO(), res.locals.user.user_id, null);
  if (!receipt) return res.redirect('/finance/pledges');
  logActivity('pledge_payment',
    `Recorded ${fmtMoney(add)} pledge payment · receipt ${receipt.receipt_number}`,
    `/finance/pledges/payments/${receipt.payment_id}/receipt`, res.locals.user.user_id);
  res.redirect(`/finance/pledges/payments/${receipt.payment_id}/receipt?new=1`);
});

app.get('/finance/pledges/:id/edit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare(`SELECT * FROM pledges WHERE pledge_id=?`).get(id);
  if (!p) return res.redirect('/finance/pledges');
  const harvests = db.prepare(
    `SELECT harvest_id, harvest_name FROM harvests WHERE deleted_at IS NULL ORDER BY harvest_year DESC`
  ).all();
  const members = loadMembersList();
  const harvestOpts = harvests.map((h) =>
    `<option value="${h.harvest_id}" ${h.harvest_id === p.harvest_id ? 'selected' : ''}>${esc(h.harvest_name)}</option>`).join('');
  const memOpts = members.map((m) =>
    `<option value="${m.member_id}" ${m.member_id === p.member_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const body = `
    <p><a href="/finance/pledges">← Back to pledges</a></p>
    <form class="form" method="post" action="/finance/pledges/${id}/edit">
      <label>Member<select name="member_id" required>${memOpts}</select></label>
      <label>Harvest<select name="harvest_id" required>${harvestOpts}</select></label>
      <label>Pledged amount<input type="number" step="0.01" min="0.01" name="pledged_amount" required value="${p.pledged_amount}"></label>
      <label>Paid amount<input type="number" step="0.01" min="0" name="paid_amount" value="${p.paid_amount}"></label>
      <label>Pledge date<input type="date" name="pledge_date" required value="${fmtDate(p.pledge_date)}"></label>
      <label class="wide">Notes<input name="notes" value="${esc(p.notes || '')}"></label>
      <div class="actions"><button type="submit">Save changes</button></div>
    </form>`;
  res.page({ title: 'Edit pledge', active: '/finance', body });
});

app.post('/finance/pledges/:id/edit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const pledged = Number(b.pledged_amount);
  const paid = Number(b.paid_amount || 0);
  const status = paid <= 0 ? 'Pending' : paid >= pledged ? 'Fulfilled' : 'Partial';
  db.prepare(`UPDATE pledges SET member_id=?, harvest_id=?, pledged_amount=?, paid_amount=?,
                                  pledge_date=?, status=?, notes=? WHERE pledge_id=?`).run(
    Number(b.member_id), Number(b.harvest_id), pledged, paid,
    b.pledge_date, status, b.notes || null, id
  );
  logActivity('pledge_edited', `Pledge #${id} edited`, '/finance/pledges', res.locals.user.user_id);
  res.redirect('/finance/pledges');
});

// ---------- finance: pledge receipts & outstanding statements ----------

// Record a payment toward a pledge: append a payment row with its own sequential
// receipt number (RCT-#####), bump the pledge's paid amount + status, all atomically.
const recordPledgePayment = db.transaction((pledgeId, amount, paidOn, userId, notes) => {
  const p = db.prepare(`SELECT pledged_amount, paid_amount FROM pledges WHERE pledge_id=?`).get(pledgeId);
  if (!p) return null;
  const info = db.prepare(
    `INSERT INTO pledge_payments (pledge_id, amount, paid_on, receipt_number, recorded_by, notes)
     VALUES (?, ?, ?, '', ?, ?)`
  ).run(pledgeId, amount, paidOn, userId, notes || null);
  const receiptNumber = 'RCT-' + String(info.lastInsertRowid).padStart(5, '0');
  db.prepare(`UPDATE pledge_payments SET receipt_number=? WHERE payment_id=?`)
    .run(receiptNumber, info.lastInsertRowid);
  const newPaid = p.paid_amount + amount;
  const status = newPaid >= p.pledged_amount ? 'Fulfilled' : 'Partial';
  db.prepare(`UPDATE pledges SET paid_amount=?, status=? WHERE pledge_id=?`).run(newPaid, status, pledgeId);
  return { payment_id: info.lastInsertRowid, receipt_number: receiptNumber };
});

// One payment receipt, with the running balance as of that payment so reprints are stable.
function loadPaymentReceipt(paymentId) {
  return db.prepare(`
    SELECT pay.*, p.pledged_amount, p.member_id, p.harvest_id,
           m.first_name, m.last_name, m.mobile_phone, m.email,
           m.preferred_channel, m.unsubscribe_token,
           h.harvest_name, h.harvest_year,
           u.display_name AS recorded_by_name, u.username AS recorded_by_user,
           (SELECT COALESCE(SUM(x.amount), 0) FROM pledge_payments x
             WHERE x.pledge_id = pay.pledge_id AND x.payment_id <= pay.payment_id) AS paid_to_date
    FROM pledge_payments pay
    JOIN pledges  p ON p.pledge_id  = pay.pledge_id
    JOIN members  m ON m.member_id  = p.member_id
    JOIN harvests h ON h.harvest_id = p.harvest_id
    LEFT JOIN users u ON u.user_id = pay.recorded_by
    WHERE pay.payment_id = ?`).get(paymentId);
}

// Members who still owe on at least one (non-cancelled) pledge.
function membersWithOutstanding() {
  return db.prepare(`
    SELECT m.member_id, m.first_name || ' ' || m.last_name AS name,
           SUM(p.pledged_amount) AS pledged, SUM(p.paid_amount) AS paid,
           SUM(p.pledged_amount - p.paid_amount) AS outstanding,
           COUNT(*) AS pledge_count
    FROM pledges p JOIN members m USING(member_id)
    WHERE m.deleted_at IS NULL AND p.status != 'Cancelled'
      AND p.pledged_amount - p.paid_amount > 0.005
    GROUP BY m.member_id
    ORDER BY outstanding DESC`).all();
}

// A member's still-outstanding pledges, for the statement.
function memberOutstandingDetail(memberId) {
  const member = db.prepare(
    `SELECT member_id, first_name, last_name, mobile_phone, email, preferred_channel, unsubscribe_token
       FROM members WHERE member_id=? AND deleted_at IS NULL`
  ).get(memberId);
  if (!member) return null;
  const pledges = db.prepare(`
    SELECT p.*, h.harvest_name, h.harvest_year
    FROM pledges p JOIN harvests h USING(harvest_id)
    WHERE p.member_id=? AND p.status != 'Cancelled'
      AND p.pledged_amount - p.paid_amount > 0.005
    ORDER BY p.pledge_date`).all(memberId);
  return { member, pledges };
}

// Send a message to a member over the channel(s) their preference allows.
async function sendMemberMessage(member, smsText, emailSubject, emailText) {
  const pref = member.preferred_channel || 'none';
  if (pref === 'none') return { ok: false, reason: 'do_not_contact' };
  const phone = (pref === 'either' || pref === 'sms_only') ? normalizePhoneGH(member.mobile_phone) : null;
  const email = (pref === 'either' || pref === 'email_only') ? (member.email || null) : null;
  if (!phone && !email) return { ok: false, reason: 'no_contact' };
  let sms = null, mail = null;
  if (phone) { try { sms = await sendSmsBatch([phone], smsText); } catch (e) { sms = { ok: false, error: e.message }; } }
  if (email) {
    try { mail = await sendEmailEach([{ addr: email, token: member.unsubscribe_token }], emailSubject, emailText); }
    catch (e) { mail = { ok: false, error: e.message }; }
  }
  const channels = [];
  if (phone) channels.push('SMS');
  if (email) channels.push('email');
  return {
    ok: true, dryRun: (sms && sms.dryRun) || (mail && mail.dryRun),
    channels: channels.join(' + '),
    smsOk: sms ? (sms.ok || sms.dryRun) : null,
    emailOk: mail ? (mail.ok || mail.dryRun) : null,
  };
}

const RECEIPT_FLASH = {
  new: 'Payment recorded. Here is the receipt — print it or send it to the member.',
  sent: 'Receipt sent to the member.',
  dry: 'Receipt logged as a dry run — SMS/email are not configured, so nothing was actually delivered.',
  nocontact: 'Could not send: the member has no phone or email matching their contact preference.',
  donotcontact: 'Could not send: this member is set to "Do not contact". Update their preference first.',
};

app.get('/finance/pledges/payments/:id/receipt', (req, res) => {
  const r = loadPaymentReceipt(Number(req.params.id));
  if (!r) return res.status(404).send('Receipt not found');
  const memberName = `${r.first_name} ${r.last_name}`.trim();
  const outstanding = r.pledged_amount - r.paid_to_date;
  const recordedBy = r.recorded_by_name || r.recorded_by_user || '—';
  const sendForm = res.locals.isAdmin
    ? `<form method="post" action="/finance/pledges/payments/${r.payment_id}/send"
            onsubmit="return confirm('Send this receipt to ${esc(memberName)} via their preferred channel?')">
         <button type="submit">📤 Send receipt to ${esc(r.first_name)}</button>
       </form>` : '';
  const body = `
    <div class="screen-only receipt-actions">
      <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
      ${sendForm}
      <a class="btn-link" href="/finance/receipts">← Back to receipts</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${esc(CHURCH_NAME)}</div>
          <div class="muted-text">Pledge Payment Receipt</div></div>
        <div class="rc-no"><strong>${esc(r.receipt_number)}</strong><br>
          <span class="muted-text">${esc(r.paid_on)}</span></div>
      </div>
      <div class="rc-line"><span>Received from</span><strong>${esc(memberName)}</strong></div>
      <div class="rc-line"><span>For</span><span>${esc(r.harvest_name)}${r.harvest_year ? ' ' + esc(String(r.harvest_year)) : ''} pledge</span></div>
      <div class="rc-line"><span>Amount received</span><strong>${fmtMoney(r.amount)}</strong></div>
      <div class="rc-line"><span>Total pledged</span><span>${fmtMoney(r.pledged_amount)}</span></div>
      <div class="rc-line"><span>Paid to date</span><span>${fmtMoney(r.paid_to_date)}</span></div>
      <div class="rc-line rc-total"><span>Outstanding balance</span><span>${fmtMoney(outstanding)}</span></div>
      <div class="rc-line"><span>Recorded by</span><span>${esc(recordedBy)}</span></div>
      ${r.sent_at ? `<p class="muted-text" style="margin-top:1rem">Sent to member on ${esc(String(r.sent_at).slice(0, 16))}${r.sent_channel ? ` via ${esc(r.sent_channel)}` : ''}.</p>` : ''}
      <p class="rc-foot">${outstanding > 0.005
        ? `Thank you. A balance of <strong>${fmtMoney(outstanding)}</strong> remains on this pledge.`
        : 'This pledge is now fully paid. Thank you!'}</p>
    </div>`;
  res.page({
    title: `Receipt ${r.receipt_number}`, active: '/finance',
    flash: RECEIPT_FLASH[req.query.sent] || RECEIPT_FLASH[req.query.new ? 'new' : ''],
    body,
  });
});

app.post('/finance/pledges/payments/:id/send', requireAdmin, async (req, res) => {
  const r = loadPaymentReceipt(Number(req.params.id));
  if (!r) return res.redirect('/finance/receipts');
  const memberName = `${r.first_name} ${r.last_name}`.trim();
  const outstanding = r.pledged_amount - r.paid_to_date;
  const balanceLine = outstanding > 0.005
    ? `Outstanding balance: ${fmtMoney(outstanding)}.`
    : 'This pledge is now fully paid.';
  const sms = `Receipt ${r.receipt_number}: Dear ${r.first_name}, we received ${fmtMoney(r.amount)} toward your ${r.harvest_name} pledge on ${r.paid_on}. ${balanceLine} Thank you. — ${CHURCH_NAME}`;
  const emailBody =
    `Dear ${memberName},\n\nThank you for your payment. This is your official receipt.\n\n` +
    `Receipt no:   ${r.receipt_number}\n` +
    `Date:         ${r.paid_on}\n` +
    `Pledge:       ${r.harvest_name}${r.harvest_year ? ' ' + r.harvest_year : ''}\n` +
    `Amount paid:  ${fmtMoney(r.amount)}\n` +
    `Total pledged:${fmtMoney(r.pledged_amount)}\n` +
    `Paid to date: ${fmtMoney(r.paid_to_date)}\n` +
    `${balanceLine}\n\nGod bless you.\n${CHURCH_NAME}`;
  const result = await sendMemberMessage(r, sms, `Payment receipt ${r.receipt_number} — ${CHURCH_NAME}`, emailBody);
  if (!result.ok) {
    return res.redirect(`/finance/pledges/payments/${r.payment_id}/receipt?sent=${result.reason === 'do_not_contact' ? 'donotcontact' : 'nocontact'}`);
  }
  db.prepare(`UPDATE pledge_payments SET sent_at=CURRENT_TIMESTAMP, sent_channel=? WHERE payment_id=?`)
    .run(result.channels, r.payment_id);
  logActivity('receipt_sent', `Sent receipt ${r.receipt_number} to ${memberName}`,
    `/finance/pledges/payments/${r.payment_id}/receipt`, res.locals.user.user_id);
  res.redirect(`/finance/pledges/payments/${r.payment_id}/receipt?sent=${result.dryRun ? 'dry' : 'sent'}`);
});

app.get('/finance/pledges/statement/:memberId', (req, res) => {
  const data = memberOutstandingDetail(Number(req.params.memberId));
  if (!data) return res.status(404).send('Member not found');
  const { member, pledges } = data;
  const memberName = `${member.first_name} ${member.last_name}`.trim();
  const totalOutstanding = pledges.reduce((a, p) => a + (p.pledged_amount - p.paid_amount), 0);
  const sendForm = res.locals.isAdmin && pledges.length
    ? `<form method="post" action="/finance/pledges/statement/${member.member_id}/send"
            onsubmit="return confirm('Send this outstanding-balance statement to ${esc(memberName)}?')">
         <button type="submit">📤 Send statement to ${esc(member.first_name)}</button>
       </form>` : '';
  const rowsHtml = pledges.length
    ? table(['Date', 'Harvest', 'Pledged', 'Paid', 'Outstanding'],
        pledges.map((p) => [
          esc(p.pledge_date), esc(p.harvest_name),
          fmtMoney(p.pledged_amount), fmtMoney(p.paid_amount),
          fmtOutstanding(p.pledged_amount - p.paid_amount),
        ]))
    : '<p class="muted-text">This member has no outstanding pledges. 🎉</p>';
  const body = `
    <div class="screen-only receipt-actions">
      <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
      ${sendForm}
      <a class="btn-link" href="/finance/receipts">← Back to receipts</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${esc(CHURCH_NAME)}</div>
          <div class="muted-text">Outstanding Pledge Statement</div></div>
        <div class="rc-no"><strong>${esc(memberName)}</strong><br>
          <span class="muted-text">As of ${todayISO()}</span></div>
      </div>
      ${rowsHtml}
      ${pledges.length ? `<div class="rc-line rc-total" style="margin-top:0.75rem">
        <span>Total outstanding</span><span>${fmtMoney(totalOutstanding)}</span></div>
        <p class="rc-foot">Kindly redeem your outstanding pledge${pledges.length > 1 ? 's' : ''} at your earliest convenience. Thank you.</p>` : ''}
    </div>`;
  res.page({
    title: `Statement — ${memberName}`, active: '/finance',
    flash: RECEIPT_FLASH[req.query.sent],
    body,
  });
});

app.post('/finance/pledges/statement/:memberId/send', requireAdmin, async (req, res) => {
  const data = memberOutstandingDetail(Number(req.params.memberId));
  if (!data) return res.redirect('/finance/receipts');
  const { member, pledges } = data;
  if (!pledges.length) return res.redirect(`/finance/pledges/statement/${member.member_id}`);
  const memberName = `${member.first_name} ${member.last_name}`.trim();
  const total = pledges.reduce((a, p) => a + (p.pledged_amount - p.paid_amount), 0);
  const lines = pledges.map((p) =>
    `  • ${p.harvest_name}: ${fmtMoney(p.pledged_amount - p.paid_amount)} outstanding`).join('\n');
  const sms = `Dear ${member.first_name}, our records show a total outstanding pledge balance of ${fmtMoney(total)} across ${pledges.length} pledge(s). Kindly redeem it when you can. Thank you. — ${CHURCH_NAME}`;
  const emailBody =
    `Dear ${memberName},\n\nThis is a friendly statement of your outstanding pledge balance.\n\n${lines}\n\n` +
    `Total outstanding: ${fmtMoney(total)}\n\nKindly redeem your pledge(s) at your earliest convenience.\n\nGod bless you.\n${CHURCH_NAME}`;
  const result = await sendMemberMessage(member, sms, `Your pledge statement — ${CHURCH_NAME}`, emailBody);
  if (!result.ok) {
    return res.redirect(`/finance/pledges/statement/${member.member_id}?sent=${result.reason === 'do_not_contact' ? 'donotcontact' : 'nocontact'}`);
  }
  logActivity('statement_sent', `Sent outstanding-pledge statement to ${memberName}`,
    `/finance/pledges/statement/${member.member_id}`, res.locals.user.user_id);
  res.redirect(`/finance/pledges/statement/${member.member_id}?sent=${result.dryRun ? 'dry' : 'sent'}`);
});

// ---------- giving statements (per-member annual contribution summary) ----------

app.get('/finance/statements', (req, res) => {
  const year = safeYear(req.query.year);
  const rows = givingByMember(db, year);

  const totalGiving = rows.reduce((s, r) => s + r.total, 0);
  const yearSel = `<form method="get" class="filter-bar" style="margin:0">
      <label class="muted-text" style="display:flex;align-items:center;gap:0.4rem">Year
        <select name="year" onchange="this.form.submit()">
          ${givingYears().map((y) => `<option ${String(y) === year ? 'selected' : ''}>${y}</option>`).join('')}
        </select></label>
    </form>`;
  const inner = rows.length
    ? `<table class="data-table members-table">
        <thead><tr><th>Member</th><th>Gifts</th><th>Total ${year}</th><th>Statement</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td data-label="Member"><a class="m-name" href="/members/${r.member_id}">${esc(r.name)}</a>
            <div class="m-sub">${esc(r.external_id) || '—'}</div></td>
          <td data-label="Gifts">${r.gifts}</td>
          <td data-label="Total">${fmtMoney(r.total)}</td>
          <td data-label="Statement"><a class="btn ghost" href="/members/${r.member_id}/statement?year=${year}">View →</a></td>
        </tr>`).join('')}</tbody>
      </table>`
    : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">🧾</div>
        <h3>No giving recorded for ${year}</h3>
        <p>Once contributions are linked to members, you'll see them here. Try a different year, or record a new offering.</p>
        <a class="btn primary" href="/finance/services/new">＋ Record Service</a>
      </div>`;

  res.page({
    title: 'Finance · Statements', active: '/finance', noHeader: true,
    body: `${pageHero('Giving Statements', 'Per-member annual contribution summaries for year-end records.')}
      ${financeTabs('/finance/statements')}
      ${statsRow([
        { cls: 'gold', icon: '🧾', value: rows.length.toLocaleString(), label: `Givers in ${year}` },
        { cls: 'green', icon: '₵', value: fmtMoney(totalGiving), label: `Attributed Giving ${year}` },
      ], yearSel)}
      ${listCard({ title: `Members with giving in ${year}`, count: rows.length, countLabel: 'members', inner })}`,
  });
});

app.get('/members/:id/statement', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare(`SELECT member_id, external_id, first_name, last_name
    FROM members WHERE member_id=? AND deleted_at IS NULL`).get(id);
  if (!m) return res.status(404).send('Member not found');
  const year = safeYear(req.query.year);
  const { lines, byGroup, total } = memberGivingForYear(id, year);
  const name = `${m.first_name} ${m.last_name}`.trim();

  const yearSel = `<form method="get" class="screen-only" style="display:inline">
      <label>Year <select name="year" onchange="this.form.submit()">
        ${givingYears().map((y) => `<option ${String(y) === year ? 'selected' : ''}>${y}</option>`).join('')}
      </select></label></form>`;
  const rowsHtml = lines.length
    ? table(['Date', 'Category', 'Details', 'Amount'],
        lines.map((l) => [esc(l.dt), esc(l.category), esc(l.detail) || '—', fmtMoney(l.amount)]))
    : `<p class="muted-text">No giving was recorded for ${esc(name)} in ${year}.</p>`;
  const subtotals = Object.entries(byGroup)
    .map(([g, a]) => `<div class="rc-line"><span>${esc(g)}</span><span>${fmtMoney(a)}</span></div>`).join('');

  const body = `
    <div class="screen-only receipt-actions">
      <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
      ${yearSel}
      <a class="btn-link" href="/finance/statements?year=${year}">← Back to statements</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${esc(CHURCH_NAME)}</div>
          <div class="muted-text">Annual Giving Statement · ${year}</div></div>
        <div class="rc-no"><strong>${esc(name)}</strong><br>
          <span class="muted-text">${esc(m.external_id) || ''}</span></div>
      </div>
      ${rowsHtml}
      ${lines.length ? `<div style="margin-top:0.75rem">${subtotals}
        <div class="rc-line rc-total"><span>Total giving ${year}</span><span>${fmtMoney(total)}</span></div></div>
        <p class="rc-foot">Thank you for your faithful giving. This statement summarises contributions
          recorded for the ${year} calendar year and is provided for your records. Please retain it for
          your reference.</p>` : ''}
    </div>`;
  res.page({ title: `Giving Statement — ${name}`, active: '/finance', noHeader: true, body });
});

app.get('/finance/receipts', (req, res) => {
  const outstanding = membersWithOutstanding();
  const recent = db.prepare(`
    SELECT pay.payment_id, pay.receipt_number, pay.amount, pay.paid_on, pay.sent_at, pay.sent_channel,
           m.member_id, m.first_name || ' ' || m.last_name AS member, h.harvest_name
    FROM pledge_payments pay
    JOIN pledges  p ON p.pledge_id  = pay.pledge_id
    JOIN members  m ON m.member_id  = p.member_id
    JOIN harvests h ON h.harvest_id = p.harvest_id
    WHERE m.deleted_at IS NULL
    ORDER BY pay.payment_id DESC LIMIT 50`).all();

  const totalOutstanding = outstanding.reduce((a, r) => a + r.outstanding, 0);
  const outstandingTbl = outstanding.length
    ? table(['Member', 'Pledges', 'Pledged', 'Paid', 'Outstanding', ''],
        outstanding.map((r) => [
          `<a href="/members/${r.member_id}">${esc(r.name)}</a>`,
          r.pledge_count, fmtMoney(r.pledged), fmtMoney(r.paid),
          fmtOutstanding(r.outstanding),
          `<a class="btn-link" href="/finance/pledges/statement/${r.member_id}">Statement</a>`,
        ]))
    : '<p class="muted-text">No members have outstanding pledges. 🎉</p>';

  const recentTbl = recent.length
    ? table(['Receipt', 'Date', 'Member', 'Harvest', 'Amount', 'Delivered', ''],
        recent.map((r) => [
          esc(r.receipt_number), esc(r.paid_on),
          `<a href="/members/${r.member_id}">${esc(r.member)}</a>`,
          esc(r.harvest_name), fmtMoney(r.amount),
          r.sent_at ? `<span class="pill pill-fulfilled">${esc(r.sent_channel || 'sent')}</span>` : '<span class="muted-text">not sent</span>',
          `<a class="btn-link" href="/finance/pledges/payments/${r.payment_id}/receipt">View</a>`,
        ]))
    : '<p class="muted-text">No payment receipts yet. Record a payment on the Pledges tab to issue one.</p>';

  const body = `
    ${financeTabs('/finance/receipts')}
    <section class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Members with outstanding pledges</h2>
        <span class="meta">Total outstanding: <strong>${fmtMoney(totalOutstanding)}</strong></span></div>
      ${outstandingTbl}
    </section>
    <section class="card">
      <h2>Recent payment receipts</h2>
      ${recentTbl}
    </section>`;
  res.page({ title: 'Finance · Receipts', active: '/finance', body });
});

// ---------- finance: expenses ----------
app.get('/finance/expenses', (req, res) => {
  const cats = loadExpenseCategories();
  const currentUser = res.locals.user;
  const rows = db.prepare(`
    SELECT e.expense_id, e.spent_on, e.amount, e.description, e.paid_to,
           e.payment_method, e.reference_number, e.receipt_attached,
           ec.category_name AS cat_name, e.category AS legacy_cat,
           u.display_name, u.username
    FROM expenses e
    LEFT JOIN expense_categories ec USING(expense_cat_id)
    LEFT JOIN users u ON u.user_id = e.approved_by
    ORDER BY e.spent_on DESC, e.expense_id DESC LIMIT 100`).all();
  const catOpts = cats.map((c) => `<option value="${c.expense_cat_id}">${esc(c.category_name)}</option>`).join('');
  const approverName = esc(currentUser.display_name || currentUser.username);
  const userOpts = `<option value="${currentUser.user_id}">${approverName}</option>`;
  const addForm = res.locals.isAdmin
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Record an expense</strong></summary>
         <form class="form" method="post" action="/finance/expenses" style="margin-top:0.75rem">
           <label>Date<input type="date" name="spent_on" required value="${todayISO()}"></label>
           <label>Category<select name="expense_cat_id" required>${catOpts}</select></label>
           <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
           <label>Payment method<select name="payment_method">
             ${['Cash','Bank Transfer','Cheque','Mobile Money','Other'].map((m) => `<option>${m}</option>`).join('')}
           </select></label>
           <label class="wide">Description<input name="description" required></label>
           <label>Paid to<input name="paid_to"></label>
           <label>Reference #<input name="reference_number"></label>
           <label>Approved by<select name="approved_by">${userOpts}</select></label>
           <label><span>&nbsp;</span><label class="check" style="background:none;padding:0">
             <input type="checkbox" name="receipt_attached" value="1"> Receipt attached</label></label>
           <label class="wide">Notes<input name="notes"></label>
           <div class="actions"><button type="submit">Save</button></div>
         </form>
       </details>` : '';
  const body = `
    ${financeTabs('/finance/expenses')}
    ${addForm}
    ${rows.length ? table(['Date', 'Category', 'Description', 'Paid to', 'Method', 'Amount', 'Receipt', ''],
      rows.map((e) => [esc(e.spent_on), esc(e.cat_name || e.legacy_cat),
        esc(e.description), esc(e.paid_to), esc(e.payment_method),
        fmtMoney(e.amount),
        e.receipt_attached ? '✓' : '—',
        res.locals.isAdmin ? `<a class="btn-link" href="/finance/expenses/${e.expense_id}/edit">Edit</a>` : '']))
      : '<p class="muted-text">No expenses recorded yet.</p>'}`;
  res.page({ title: 'Finance · Expenses', active: '/finance', body });
});

app.post('/finance/expenses', requireAdmin, (req, res) => {
  const b = req.body;
  if (!Number(b.expense_cat_id)) { flash(req, 'Choose an expense category.'); return res.redirect('/finance/expenses'); }
  if (!isValidDate(b.spent_on)) { flash(req, 'Enter a valid date.'); return res.redirect('/finance/expenses'); }
  if (!isMoneyNonNeg(b.amount)) { flash(req, 'Amount must be a number of 0 or more.'); return res.redirect('/finance/expenses'); }
  const cat = db.prepare(`SELECT category_name FROM expense_categories WHERE expense_cat_id=?`).get(Number(b.expense_cat_id));
  db.prepare(`
    INSERT INTO expenses (expense_cat_id, category, amount, spent_on, description, paid_to,
                          payment_method, reference_number, approved_by, receipt_attached, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    Number(b.expense_cat_id), cat ? cat.category_name : 'other',
    Number(b.amount), b.spent_on, b.description, b.paid_to || null,
    b.payment_method || null, b.reference_number || null,
    b.approved_by ? Number(b.approved_by) : null,
    b.receipt_attached ? 1 : 0,
    b.notes || null
  );
  logActivity('expense_recorded',
    `Expense ${fmtMoney(b.amount)} (${cat ? cat.category_name : ''}) recorded`,
    '/finance/expenses', res.locals.user.user_id);
  res.redirect('/finance/expenses');
});

app.get('/finance/expenses/:id/edit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare(`SELECT * FROM expenses WHERE expense_id=?`).get(id);
  if (!e) return res.redirect('/finance/expenses');
  const cats = loadExpenseCategories();
  const currentUser = res.locals.user;
  const catOpts = cats.map((c) =>
    `<option value="${c.expense_cat_id}" ${c.expense_cat_id === e.expense_cat_id ? 'selected' : ''}>${esc(c.category_name)}</option>`).join('');
  const methods = ['Cash', 'Bank Transfer', 'Cheque', 'Mobile Money', 'Other'];
  const methodOpts = methods.map((m) =>
    `<option ${m === e.payment_method ? 'selected' : ''}>${m}</option>`).join('');
  const approverName = esc(currentUser.display_name || currentUser.username);
  const body = `
    <p><a href="/finance/expenses">← Back to expenses</a></p>
    <form class="form" method="post" action="/finance/expenses/${id}/edit">
      <label>Date<input type="date" name="spent_on" required value="${fmtDate(e.spent_on)}"></label>
      <label>Category<select name="expense_cat_id" required>${catOpts}</select></label>
      <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required value="${e.amount}"></label>
      <label>Payment method<select name="payment_method">${methodOpts}</select></label>
      <label class="wide">Description<input name="description" required value="${esc(e.description || '')}"></label>
      <label>Paid to<input name="paid_to" value="${esc(e.paid_to || '')}"></label>
      <label>Reference #<input name="reference_number" value="${esc(e.reference_number || '')}"></label>
      <label>Approved by<select name="approved_by"><option value="${currentUser.user_id}">${approverName}</option></select></label>
      <label><span>&nbsp;</span><label class="check" style="background:none;padding:0">
        <input type="checkbox" name="receipt_attached" value="1" ${e.receipt_attached ? 'checked' : ''}> Receipt attached</label></label>
      <label class="wide">Notes<input name="notes" value="${esc(e.notes || '')}"></label>
      <div class="actions"><button type="submit">Save changes</button></div>
    </form>`;
  res.page({ title: 'Edit expense', active: '/finance', body });
});

app.post('/finance/expenses/:id/edit', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const cat = db.prepare(`SELECT category_name FROM expense_categories WHERE expense_cat_id=?`).get(Number(b.expense_cat_id));
  db.prepare(`UPDATE expenses SET expense_cat_id=?, category=?, amount=?, spent_on=?, description=?,
                                   paid_to=?, payment_method=?, reference_number=?,
                                   approved_by=?, receipt_attached=?, notes=?
              WHERE expense_id=?`).run(
    Number(b.expense_cat_id), cat ? cat.category_name : 'other',
    Number(b.amount), b.spent_on, b.description, b.paid_to || null,
    b.payment_method || null, b.reference_number || null,
    b.approved_by ? Number(b.approved_by) : null,
    b.receipt_attached ? 1 : 0, b.notes || null, id
  );
  logActivity('expense_edited',
    `Expense #${id} edited`, '/finance/expenses', res.locals.user.user_id);
  res.redirect('/finance/expenses');
});
};
