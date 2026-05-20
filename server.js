const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const DB_PATH = process.env.CHURCH_DB || path.join(__dirname, 'church.db');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}. Run ./build.sh first.`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const fmtMoney = (n) => (n == null ? '' : '$' + Number(n).toFixed(2));
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '');

const NAV = [
  ['/', 'Dashboard'],
  ['/members', 'Members'],
  ['/households', 'Households'],
  ['/ministries', 'Ministries'],
  ['/events', 'Events'],
  ['/contributions', 'Contributions'],
  ['/reports', 'Reports'],
];

function layout({ title, body, active, flash }) {
  const nav = NAV.map(([href, label]) => {
    const cls = href === active ? 'active' : '';
    return `<a class="${cls}" href="${href}">${esc(label)}</a>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Church Manager</title>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<header>
  <div class="brand">⛪ Church Manager</div>
  <nav>${nav}</nav>
</header>
<main>
  ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
  <h1>${esc(title)}</h1>
  ${body}
</main>
</body></html>`;
}

function table(headers, rows) {
  const ths = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const trs = rows.map((r) =>
    `<tr>${r.map((c) => `<td>${c == null ? '' : c}</td>`).join('')}</tr>`
  ).join('');
  return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

// ---------- routes: dashboard ----------
app.get('/', (req, res) => {
  const stats = {
    members: db.prepare(`SELECT COUNT(*) c FROM members WHERE membership_status IN ('member','regular')`).get().c,
    households: db.prepare(`SELECT COUNT(*) c FROM households`).get().c,
    ministries: db.prepare(`SELECT COUNT(*) c FROM ministries WHERE active=1`).get().c,
    ytdGiving: db.prepare(`
      SELECT COALESCE(SUM(amount),0) total FROM contributions
      WHERE substr(contributed_on,1,4) = strftime('%Y','now')`).get().total,
  };
  const upcoming = db.prepare(`
    SELECT event_id, title, event_type, starts_at, location
    FROM events WHERE starts_at >= datetime('now','-1 day')
    ORDER BY starts_at LIMIT 5`).all();
  const recentContribs = db.prepare(`
    SELECT c.contributed_on, COALESCE(m.first_name||' '||m.last_name,'(anonymous)') donor,
           f.name fund, c.amount, c.method
    FROM contributions c LEFT JOIN members m USING(member_id)
    JOIN funds f USING(fund_id)
    ORDER BY c.contributed_on DESC, c.contribution_id DESC LIMIT 8`).all();

  const cards = `
    <div class="cards">
      <div class="card"><div class="big">${stats.members}</div><div>Active members</div></div>
      <div class="card"><div class="big">${stats.households}</div><div>Households</div></div>
      <div class="card"><div class="big">${stats.ministries}</div><div>Active ministries</div></div>
      <div class="card"><div class="big">${fmtMoney(stats.ytdGiving)}</div><div>YTD giving</div></div>
    </div>`;

  const upcomingTbl = upcoming.length
    ? table(['When', 'Title', 'Type', 'Location'],
        upcoming.map((e) => [esc(e.starts_at), `<a href="/events/${e.event_id}">${esc(e.title)}</a>`,
          esc(e.event_type), esc(e.location)]))
    : '<p>No upcoming events.</p>';

  const contribsTbl = recentContribs.length
    ? table(['Date', 'Donor', 'Fund', 'Amount', 'Method'],
        recentContribs.map((c) => [esc(c.contributed_on), esc(c.donor),
          esc(c.fund), fmtMoney(c.amount), esc(c.method)]))
    : '<p>No contributions yet.</p>';

  res.send(layout({
    title: 'Dashboard', active: '/',
    body: `${cards}<h2>Upcoming events</h2>${upcomingTbl}<h2>Recent contributions</h2>${contribsTbl}`,
  }));
});

// ---------- members ----------
app.get('/members', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const where = [];
  const params = {};
  if (q) {
    where.push(`(m.first_name LIKE @q OR m.last_name LIKE @q OR m.email LIKE @q)`);
    params.q = `%${q}%`;
  }
  if (status) { where.push(`m.membership_status = @status`); params.status = status; }
  const sql = `
    SELECT m.member_id, m.first_name, m.last_name, m.email, m.mobile_phone,
           m.membership_status, h.family_name
    FROM members m LEFT JOIN households h USING(household_id)
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY m.last_name, m.first_name`;
  const rows = db.prepare(sql).all(params);
  const statuses = ['', 'visitor', 'regular', 'member', 'inactive', 'transferred', 'deceased'];
  const opts = statuses.map((s) =>
    `<option value="${s}" ${s === status ? 'selected' : ''}>${s || 'Any status'}</option>`).join('');
  const body = `
    <form class="filters" method="get">
      <input type="search" name="q" placeholder="Search name or email" value="${esc(q)}">
      <select name="status">${opts}</select>
      <button type="submit">Filter</button>
      <a class="btn" href="/members/new">+ New member</a>
    </form>
    ${table(['Name', 'Family', 'Status', 'Email', 'Phone'],
      rows.map((r) => [
        `<a href="/members/${r.member_id}">${esc(r.first_name)} ${esc(r.last_name)}</a>`,
        esc(r.family_name),
        `<span class="pill pill-${esc(r.membership_status)}">${esc(r.membership_status)}</span>`,
        esc(r.email),
        esc(r.mobile_phone),
      ]))}`;
  res.send(layout({ title: `Members (${rows.length})`, active: '/members', body }));
});

function memberForm(member = {}, households = [], action, csrfFlash) {
  const householdOpts = '<option value="">— none —</option>' +
    households.map((h) =>
      `<option value="${h.household_id}" ${h.household_id === member.household_id ? 'selected' : ''}>${esc(h.family_name)}</option>`
    ).join('');
  const statusOpts = ['visitor', 'regular', 'member', 'inactive', 'transferred', 'deceased']
    .map((s) => `<option value="${s}" ${s === member.membership_status ? 'selected' : ''}>${s}</option>`).join('');
  const maritalOpts = ['', 'single', 'married', 'divorced', 'widowed', 'separated']
    .map((s) => `<option value="${s}" ${s === (member.marital_status || '') ? 'selected' : ''}>${s || '—'}</option>`).join('');
  const genderOpts = ['', 'M', 'F', 'O']
    .map((s) => `<option value="${s}" ${s === (member.gender || '') ? 'selected' : ''}>${s || '—'}</option>`).join('');
  return `
    <form method="post" action="${action}" class="form">
      <label>First name<input name="first_name" required value="${esc(member.first_name)}"></label>
      <label>Last name<input name="last_name" required value="${esc(member.last_name)}"></label>
      <label>Email<input type="email" name="email" value="${esc(member.email)}"></label>
      <label>Mobile<input name="mobile_phone" value="${esc(member.mobile_phone)}"></label>
      <label>Date of birth<input type="date" name="date_of_birth" value="${fmtDate(member.date_of_birth)}"></label>
      <label>Gender<select name="gender">${genderOpts}</select></label>
      <label>Marital<select name="marital_status">${maritalOpts}</select></label>
      <label>Household<select name="household_id">${householdOpts}</select></label>
      <label>Status<select name="membership_status">${statusOpts}</select></label>
      <label>Join date<input type="date" name="join_date" value="${fmtDate(member.join_date)}"></label>
      <label>Baptism date<input type="date" name="baptism_date" value="${fmtDate(member.baptism_date)}"></label>
      <label class="wide">Notes<textarea name="notes" rows="3">${esc(member.notes)}</textarea></label>
      <div class="actions"><button type="submit">Save</button></div>
    </form>`;
}

app.get('/members/new', (req, res) => {
  const households = db.prepare(`SELECT household_id, family_name FROM households ORDER BY family_name`).all();
  res.send(layout({
    title: 'New member', active: '/members',
    body: memberForm({}, households, '/members'),
  }));
});

app.post('/members', (req, res) => {
  const b = req.body;
  const info = db.prepare(`
    INSERT INTO members (household_id, first_name, last_name, email, mobile_phone,
      date_of_birth, gender, marital_status, membership_status, join_date, baptism_date, notes)
    VALUES (@household_id, @first_name, @last_name, @email, @mobile_phone,
      @date_of_birth, @gender, @marital_status, @membership_status, @join_date, @baptism_date, @notes)
  `).run({
    household_id: b.household_id ? Number(b.household_id) : null,
    first_name: b.first_name, last_name: b.last_name,
    email: b.email || null, mobile_phone: b.mobile_phone || null,
    date_of_birth: b.date_of_birth || null, gender: b.gender || null,
    marital_status: b.marital_status || null,
    membership_status: b.membership_status || 'visitor',
    join_date: b.join_date || null, baptism_date: b.baptism_date || null,
    notes: b.notes || null,
  });
  res.redirect(`/members/${info.lastInsertRowid}`);
});

app.get('/members/:id', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare(`
    SELECT m.*, h.family_name FROM members m
    LEFT JOIN households h USING(household_id) WHERE m.member_id = ?`).get(id);
  if (!m) return res.status(404).send('Not found');
  const households = db.prepare(`SELECT household_id, family_name FROM households ORDER BY family_name`).all();
  const ministries = db.prepare(`
    SELECT mn.name, mm.role, mm.joined_date FROM ministry_memberships mm
    JOIN ministries mn USING(ministry_id) WHERE mm.member_id = ? AND mm.left_date IS NULL
    ORDER BY mn.name`).all(id);
  const contribs = db.prepare(`
    SELECT c.contributed_on, f.name fund, c.amount, c.method
    FROM contributions c JOIN funds f USING(fund_id)
    WHERE c.member_id = ? ORDER BY c.contributed_on DESC LIMIT 20`).all(id);
  const ytd = db.prepare(`
    SELECT COALESCE(SUM(amount),0) total FROM contributions
    WHERE member_id = ? AND substr(contributed_on,1,4) = strftime('%Y','now')`).get(id).total;
  const sacraments = db.prepare(`
    SELECT sacrament_type, occurred_on, location FROM sacraments
    WHERE member_id = ? OR spouse_id = ? ORDER BY occurred_on DESC`).all(id, id);
  const attendance = db.prepare(`
    SELECT e.title, e.starts_at FROM attendance a
    JOIN events e USING(event_id) WHERE a.member_id = ?
    ORDER BY e.starts_at DESC LIMIT 10`).all(id);

  const body = `
    <div class="two-col">
      <section>
        <h2>Edit</h2>
        ${memberForm(m, households, `/members/${id}`)}
        <form method="post" action="/members/${id}/delete" onsubmit="return confirm('Delete this member?')">
          <button class="danger" type="submit">Delete member</button>
        </form>
      </section>
      <section>
        <h2>At a glance</h2>
        <dl class="stats">
          <dt>Household</dt><dd>${esc(m.family_name) || '—'}</dd>
          <dt>YTD giving</dt><dd>${fmtMoney(ytd)}</dd>
        </dl>

        <h3>Ministries</h3>
        ${ministries.length ? table(['Ministry', 'Role', 'Joined'],
          ministries.map((r) => [esc(r.name), esc(r.role), esc(r.joined_date)]))
          : '<p>Not in any ministry.</p>'}

        <h3>Sacraments</h3>
        ${sacraments.length ? table(['Type', 'Date', 'Location'],
          sacraments.map((r) => [esc(r.sacrament_type), esc(r.occurred_on), esc(r.location)]))
          : '<p>None recorded.</p>'}

        <h3>Recent giving</h3>
        ${contribs.length ? table(['Date', 'Fund', 'Amount', 'Method'],
          contribs.map((r) => [esc(r.contributed_on), esc(r.fund), fmtMoney(r.amount), esc(r.method)]))
          : '<p>No contributions on record.</p>'}

        <h3>Recent attendance</h3>
        ${attendance.length ? table(['Event', 'When'],
          attendance.map((r) => [esc(r.title), esc(r.starts_at)]))
          : '<p>No attendance recorded.</p>'}
      </section>
    </div>`;
  res.send(layout({
    title: `${m.first_name} ${m.last_name}`, active: '/members', body,
  }));
});

app.post('/members/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  db.prepare(`
    UPDATE members SET household_id=@household_id, first_name=@first_name, last_name=@last_name,
      email=@email, mobile_phone=@mobile_phone, date_of_birth=@date_of_birth, gender=@gender,
      marital_status=@marital_status, membership_status=@membership_status,
      join_date=@join_date, baptism_date=@baptism_date, notes=@notes
    WHERE member_id=@id`).run({
    id,
    household_id: b.household_id ? Number(b.household_id) : null,
    first_name: b.first_name, last_name: b.last_name,
    email: b.email || null, mobile_phone: b.mobile_phone || null,
    date_of_birth: b.date_of_birth || null, gender: b.gender || null,
    marital_status: b.marital_status || null,
    membership_status: b.membership_status || 'visitor',
    join_date: b.join_date || null, baptism_date: b.baptism_date || null,
    notes: b.notes || null,
  });
  res.redirect(`/members/${id}`);
});

app.post('/members/:id/delete', (req, res) => {
  db.prepare(`DELETE FROM members WHERE member_id=?`).run(Number(req.params.id));
  res.redirect('/members');
});

// ---------- households ----------
app.get('/households', (req, res) => {
  const rows = db.prepare(`
    SELECT h.*, COUNT(m.member_id) member_count
    FROM households h LEFT JOIN members m USING(household_id)
    GROUP BY h.household_id ORDER BY h.family_name`).all();
  const body = table(['Family', 'Members', 'City', 'Phone'],
    rows.map((r) => [
      esc(r.family_name),
      r.member_count,
      esc(r.city),
      esc(r.home_phone),
    ]));
  res.send(layout({ title: 'Households', active: '/households', body }));
});

// ---------- ministries ----------
app.get('/ministries', (req, res) => {
  const ministries = db.prepare(`
    SELECT mn.*, ml.first_name || ' ' || ml.last_name AS leader_name
    FROM ministries mn LEFT JOIN members ml ON ml.member_id = mn.leader_id
    ORDER BY mn.name`).all();
  const rosters = db.prepare(`
    SELECT mn.ministry_id, mn.name AS ministry,
           m.member_id, m.first_name || ' ' || m.last_name AS member, mm.role
    FROM ministry_memberships mm
    JOIN ministries mn USING(ministry_id)
    JOIN members m USING(member_id)
    WHERE mm.left_date IS NULL
    ORDER BY mn.name, mm.role DESC, m.last_name`).all();

  const sections = ministries.map((mn) => {
    const members = rosters.filter((r) => r.ministry_id === mn.ministry_id);
    const list = members.length
      ? `<ul>${members.map((r) =>
          `<li><a href="/members/${r.member_id}">${esc(r.member)}</a> — <em>${esc(r.role)}</em></li>`).join('')}</ul>`
      : '<p><em>No members.</em></p>';
    return `<section class="card-wide">
      <h2>${esc(mn.name)}</h2>
      <p>${esc(mn.description) || ''}</p>
      <p><strong>Leader:</strong> ${esc(mn.leader_name) || '—'} · <strong>Meets:</strong> ${esc(mn.meets_on) || '—'}</p>
      ${list}
    </section>`;
  }).join('');

  res.send(layout({ title: 'Ministries', active: '/ministries', body: sections }));
});

// ---------- events ----------
app.get('/events', (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, COUNT(a.member_id) attendees
    FROM events e LEFT JOIN attendance a USING(event_id)
    GROUP BY e.event_id ORDER BY e.starts_at DESC`).all();
  const body = `
    <p><a class="btn" href="/events/new">+ New event</a></p>
    ${table(['When', 'Title', 'Type', 'Location', 'Attendees'],
      rows.map((r) => [
        esc(r.starts_at),
        `<a href="/events/${r.event_id}">${esc(r.title)}</a>`,
        esc(r.event_type), esc(r.location), r.attendees,
      ]))}`;
  res.send(layout({ title: 'Events', active: '/events', body }));
});

app.get('/events/new', (req, res) => {
  const body = `
    <form class="form" method="post" action="/events">
      <label>Title<input name="title" required></label>
      <label>Type<select name="event_type">
        ${['service', 'prayer', 'bible_study', 'outreach', 'youth', 'wedding', 'funeral', 'baptism', 'other']
          .map((t) => `<option value="${t}">${t}</option>`).join('')}
      </select></label>
      <label>Starts<input type="datetime-local" name="starts_at" required></label>
      <label>Ends<input type="datetime-local" name="ends_at"></label>
      <label>Location<input name="location"></label>
      <label class="wide">Notes<textarea name="notes" rows="2"></textarea></label>
      <div class="actions"><button type="submit">Save</button></div>
    </form>`;
  res.send(layout({ title: 'New event', active: '/events', body }));
});

app.post('/events', (req, res) => {
  const b = req.body;
  const info = db.prepare(`
    INSERT INTO events (title, event_type, starts_at, ends_at, location, notes)
    VALUES (@title, @event_type, @starts_at, @ends_at, @location, @notes)
  `).run({
    title: b.title, event_type: b.event_type || 'service',
    starts_at: b.starts_at.replace('T', ' '),
    ends_at: b.ends_at ? b.ends_at.replace('T', ' ') : null,
    location: b.location || null, notes: b.notes || null,
  });
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
    ORDER BY last_name`).all(id);

  const attendList = attendees.length
    ? `<ul class="check-list">${attendees.map((a) =>
        `<li><a href="/members/${a.member_id}">${esc(a.name)}</a>
          <form method="post" action="/events/${id}/uncheck">
            <input type="hidden" name="member_id" value="${a.member_id}">
            <button class="link" type="submit">remove</button>
          </form></li>`).join('')}</ul>`
    : '<p>No one checked in yet.</p>';

  const otherOpts = others.map((o) =>
    `<option value="${o.member_id}">${esc(o.name)}</option>`).join('');

  const body = `
    <p><strong>${esc(ev.event_type)}</strong> · ${esc(ev.starts_at)} · ${esc(ev.location) || ''}</p>
    <div class="two-col">
      <section>
        <h2>Attendees (${attendees.length})</h2>
        ${attendList}
      </section>
      <section>
        <h2>Check in</h2>
        <form method="post" action="/events/${id}/check">
          <select name="member_id" required><option value="">— pick a member —</option>${otherOpts}</select>
          <button type="submit">Check in</button>
        </form>
        ${ev.notes ? `<h3>Notes</h3><p>${esc(ev.notes)}</p>` : ''}
      </section>
    </div>`;
  res.send(layout({ title: ev.title, active: '/events', body }));
});

app.post('/events/:id/check', (req, res) => {
  const id = Number(req.params.id);
  const member_id = Number(req.body.member_id);
  if (member_id) {
    db.prepare(`INSERT OR IGNORE INTO attendance (event_id, member_id) VALUES (?, ?)`).run(id, member_id);
  }
  res.redirect(`/events/${id}`);
});
app.post('/events/:id/uncheck', (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM attendance WHERE event_id=? AND member_id=?`).run(id, Number(req.body.member_id));
  res.redirect(`/events/${id}`);
});

// ---------- contributions ----------
app.get('/contributions', (req, res) => {
  const funds = db.prepare(`SELECT * FROM funds WHERE active=1 ORDER BY name`).all();
  const members = db.prepare(`
    SELECT member_id, first_name || ' ' || last_name AS name FROM members
    ORDER BY last_name`).all();
  const rows = db.prepare(`
    SELECT c.contribution_id, c.contributed_on,
           COALESCE(m.first_name || ' ' || m.last_name, '(anonymous)') donor,
           m.member_id, f.name fund, c.amount, c.method, c.reference
    FROM contributions c LEFT JOIN members m USING(member_id)
    JOIN funds f USING(fund_id)
    ORDER BY c.contributed_on DESC, c.contribution_id DESC LIMIT 100`).all();
  const byFund = db.prepare(`
    SELECT f.name fund, ROUND(SUM(c.amount),2) total
    FROM contributions c JOIN funds f USING(fund_id)
    WHERE substr(c.contributed_on,1,4)=strftime('%Y','now')
    GROUP BY f.fund_id ORDER BY total DESC`).all();

  const fundOpts = funds.map((f) => `<option value="${f.fund_id}">${esc(f.name)}</option>`).join('');
  const memOpts = '<option value="">(anonymous)</option>' +
    members.map((m) => `<option value="${m.member_id}">${esc(m.name)}</option>`).join('');

  const body = `
    <div class="two-col">
      <section>
        <h2>Record contribution</h2>
        <form class="form" method="post" action="/contributions">
          <label>Date<input type="date" name="contributed_on" required value="${new Date().toISOString().slice(0,10)}"></label>
          <label>Member<select name="member_id">${memOpts}</select></label>
          <label>Fund<select name="fund_id" required>${fundOpts}</select></label>
          <label>Amount<input type="number" step="0.01" min="0.01" name="amount" required></label>
          <label>Method<select name="method">
            ${['cash','check','card','online','transfer','other'].map((m) => `<option>${m}</option>`).join('')}
          </select></label>
          <label>Reference<input name="reference"></label>
          <div class="actions"><button type="submit">Save</button></div>
        </form>
      </section>
      <section>
        <h2>YTD by fund</h2>
        ${table(['Fund', 'Total'], byFund.map((r) => [esc(r.fund), fmtMoney(r.total)]))}
      </section>
    </div>
    <h2>Recent contributions</h2>
    ${table(['Date', 'Donor', 'Fund', 'Amount', 'Method', 'Reference'],
      rows.map((r) => [esc(r.contributed_on),
        r.member_id ? `<a href="/members/${r.member_id}">${esc(r.donor)}</a>` : esc(r.donor),
        esc(r.fund), fmtMoney(r.amount), esc(r.method), esc(r.reference)]))}`;
  res.send(layout({ title: 'Contributions', active: '/contributions', body }));
});

app.post('/contributions', (req, res) => {
  const b = req.body;
  db.prepare(`
    INSERT INTO contributions (member_id, fund_id, amount, contributed_on, method, reference)
    VALUES (@member_id, @fund_id, @amount, @contributed_on, @method, @reference)
  `).run({
    member_id: b.member_id ? Number(b.member_id) : null,
    fund_id: Number(b.fund_id),
    amount: Number(b.amount),
    contributed_on: b.contributed_on,
    method: b.method || null,
    reference: b.reference || null,
  });
  res.redirect('/contributions');
});

// ---------- reports ----------
app.get('/reports', (req, res) => {
  const attendanceTrend = db.prepare(`
    SELECT e.starts_at, e.title, COUNT(a.member_id) attendees
    FROM events e LEFT JOIN attendance a USING(event_id)
    WHERE e.event_type='service'
    GROUP BY e.event_id ORDER BY e.starts_at DESC LIMIT 12`).all();
  const topGivers = db.prepare(`
    SELECT m.member_id, m.first_name || ' ' || m.last_name name,
           ROUND(SUM(c.amount),2) total
    FROM contributions c JOIN members m USING(member_id)
    WHERE substr(c.contributed_on,1,4)=strftime('%Y','now')
    GROUP BY m.member_id ORDER BY total DESC LIMIT 10`).all();
  const birthdays = db.prepare(`
    SELECT first_name || ' ' || last_name name, date_of_birth
    FROM members WHERE date_of_birth IS NOT NULL
      AND strftime('%m', date_of_birth)=strftime('%m','now')
    ORDER BY strftime('%d', date_of_birth)`).all();
  const missing = db.prepare(`
    WITH last_services AS (
      SELECT event_id FROM events WHERE event_type='service'
      ORDER BY starts_at DESC LIMIT 3
    )
    SELECT m.member_id, m.first_name || ' ' || m.last_name name, m.email
    FROM members m
    WHERE m.membership_status IN ('member','regular')
      AND NOT EXISTS (SELECT 1 FROM attendance a
        WHERE a.member_id=m.member_id AND a.event_id IN (SELECT event_id FROM last_services))`).all();

  const body = `
    <section><h2>Service attendance (last 12)</h2>
      ${table(['Date', 'Title', 'Attendees'],
        attendanceTrend.map((r) => [esc(r.starts_at), esc(r.title), r.attendees]))}
    </section>
    <section><h2>Top givers YTD</h2>
      ${table(['Member', 'Total'],
        topGivers.map((r) => [`<a href="/members/${r.member_id}">${esc(r.name)}</a>`, fmtMoney(r.total)]))}
    </section>
    <section><h2>Birthdays this month</h2>
      ${birthdays.length ? table(['Name', 'DOB'],
        birthdays.map((r) => [esc(r.name), esc(r.date_of_birth)])) : '<p>None.</p>'}
    </section>
    <section><h2>Missed the last 3 Sundays</h2>
      ${missing.length ? table(['Name', 'Email'],
        missing.map((r) => [`<a href="/members/${r.member_id}">${esc(r.name)}</a>`, esc(r.email)]))
        : '<p>Everyone has been attending. 🎉</p>'}
    </section>`;
  res.send(layout({ title: 'Reports', active: '/reports', body }));
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Church Manager running at http://localhost:${PORT}`);
});
