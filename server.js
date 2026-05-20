const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);

const DB_PATH = process.env.CHURCH_DB || path.join(__dirname, 'church.db');
const PORT = process.env.PORT || 3000;
const CHURCH_NAME = process.env.CHURCH_NAME || 'Dunwell Methodist';

// Auto-create the DB from schema.sql on first boot (so deployments work without shell access).
if (!fs.existsSync(DB_PATH)) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error(`Database not found at ${DB_PATH} and schema.sql is missing.`);
    process.exit(1);
  }
  console.log(`No database at ${DB_PATH}; creating from schema.sql...`);
  const fresh = new Database(DB_PATH);
  fresh.exec(fs.readFileSync(schemaPath, 'utf8'));
  fresh.close();
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// Migrations for older databases.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    display_name  TEXT,
    role          TEXT    NOT NULL DEFAULT 'admin'
                  CHECK (role IN ('admin','viewer')),
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
const hasRole = db.prepare(
  `SELECT 1 FROM pragma_table_info('users') WHERE name='role'`
).get();
if (!hasRole) {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
}

// Migrations for the redesigned dashboard.
db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    expense_id  INTEGER PRIMARY KEY,
    category    TEXT NOT NULL,
    amount      REAL NOT NULL CHECK (amount > 0),
    spent_on    TEXT NOT NULL,
    description TEXT,
    fund_id     INTEGER REFERENCES funds(fund_id),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS welfare_cases (
    case_id          INTEGER PRIMARY KEY,
    member_id        INTEGER NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
    category         TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open',
    amount_disbursed REAL NOT NULL DEFAULT 0,
    opened_on        TEXT NOT NULL DEFAULT CURRENT_DATE,
    closed_on        TEXT,
    summary          TEXT NOT NULL,
    notes            TEXT
  );
  CREATE TABLE IF NOT EXISTS announcements (
    announcement_id INTEGER PRIMARY KEY,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    audience        TEXT NOT NULL DEFAULT 'all',
    posted_by       INTEGER REFERENCES users(user_id),
    posted_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    activity_id INTEGER PRIMARY KEY,
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_id     INTEGER REFERENCES users(user_id),
    kind        TEXT NOT NULL,
    description TEXT NOT NULL,
    link        TEXT
  );
  CREATE TABLE IF NOT EXISTS organizations (
    org_id      INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    leader_id   INTEGER REFERENCES members(member_id),
    meets_on    TEXT,
    active      INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS organization_memberships (
    org_id      INTEGER NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    member_id   INTEGER NOT NULL REFERENCES members(member_id)   ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member',
    joined_date TEXT NOT NULL DEFAULT CURRENT_DATE,
    PRIMARY KEY (org_id, member_id)
  );
`);

// Add new member columns if missing.
function addColumnIfMissing(table, col, ddl) {
  const exists = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, col);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumnIfMissing('members', 'external_id',       `external_id TEXT`);
addColumnIfMissing('members', 'confirmation_date', `confirmation_date TEXT`);
addColumnIfMissing('members', 'bible_class_id',    `bible_class_id INTEGER REFERENCES ministries(ministry_id)`);
addColumnIfMissing('members', 'deleted_at',        `deleted_at TEXT`);
addColumnIfMissing('users',   'deleted_at',        `deleted_at TEXT`);
addColumnIfMissing('ministries', 'org_id',         `org_id INTEGER REFERENCES organizations(org_id)`);
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_external_id ON members(external_id) WHERE external_id IS NOT NULL`); } catch (_) {}

// Seed the five default organizations (idempotent).
const DEFAULT_ORGS = [
  "Church Choir",
  "Gospel Band",
  "Men's Fellowship",
  "Women's Fellowship",
  "Sunday School",
];
const insertOrg = db.prepare(`INSERT OR IGNORE INTO organizations (name) VALUES (?)`);
for (const n of DEFAULT_ORGS) insertOrg.run(n);

// Households are no longer used — clean them up if anything is left.
try {
  db.exec(`UPDATE members SET household_id = NULL WHERE household_id IS NOT NULL`);
  db.exec(`DELETE FROM households`);
} catch (_) {}

const app = express();
// Trust the reverse proxy in production so secure cookies work behind Fly/Render/etc.
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'public')));

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set — generating an ephemeral one (logins will be lost on restart).');
}
app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true } }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
}));

// Render helper that auto-injects the current user into the layout.
app.use((req, res, next) => {
  res.page = (opts) => res.send(layout({ ...opts, user: opts.user ?? res.locals.user }));
  next();
});

// Auth gate: redirect to /setup on first run, /login otherwise.
app.use((req, res, next) => {
  if (req.path.startsWith('/static/')) return next();
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    if (req.path === '/setup') return next();
    return res.redirect('/setup');
  }
  if (req.path === '/login' || req.path === '/logout') return next();
  if (!req.session.userId) return res.redirect('/login');
  res.locals.user = db.prepare(
    'SELECT user_id, username, display_name, role FROM users WHERE user_id=? AND deleted_at IS NULL'
  ).get(req.session.userId);
  if (!res.locals.user) { req.session.destroy(() => {}); return res.redirect('/login'); }
  res.locals.isAdmin = res.locals.user.role === 'admin';
  next();
});

function requireAdmin(req, res, next) {
  if (res.locals.isAdmin) return next();
  res.status(403).send(layout({
    title: 'Read-only access', user: res.locals.user, active: null,
    body: '<p>Your account has read-only access. Ask an admin to make this change.</p>'
         + '<p><a href="/">Back to dashboard</a></p>',
  }));
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const fmtMoney = (n) => {
  if (n == null) return '';
  const v = Number(n);
  return 'GH₵ ' + v.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '');
const initials = (name) => {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
};

const NAV = [
  ['/',                'Dashboard',      '▥'],
  ['/members',         'Members',        '👥'],
  ['/attendance',      'Attendance',     '✓'],
  ['/finance',         'Finance',        '₵'],
  ['/bible-classes',   'Bible Classes',  '📖'],
  ['/organizations',   'Organizations',  '♫'],
  ['/events',          'Events',         '📅'],
  ['/communications',  'Communications', '✉'],
  ['/reports',         'Reports',        '📊'],
  ['/users',           'Users & Roles',  '🔑', 'admin'],
  ['/settings',        'Settings',       '⚙'],
];

// Auto-generated DMS-### member IDs.
const MEMBER_ID_PREFIX = process.env.MEMBER_ID_PREFIX || 'DMS';
function nextMemberId() {
  const rows = db.prepare(
    `SELECT external_id FROM members WHERE external_id LIKE ?`
  ).all(`${MEMBER_ID_PREFIX}-%`);
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.external_id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${MEMBER_ID_PREFIX}-${String(max + 1).padStart(3, '0')}`;
}

// Scripture of the Day — picks a verse from this list based on day-of-year so it changes daily.
const VERSES = [
  ['I was glad when they said to me, "Let us go to the house of the Lord."', 'Psalm 122:1'],
  ['The Lord is my shepherd; I shall not want.', 'Psalm 23:1'],
  ['Trust in the Lord with all your heart, and lean not on your own understanding.', 'Proverbs 3:5'],
  ['For I know the plans I have for you, declares the Lord.', 'Jeremiah 29:11'],
  ['Be still, and know that I am God.', 'Psalm 46:10'],
  ['Cast all your anxiety on him because he cares for you.', '1 Peter 5:7'],
  ['The joy of the Lord is your strength.', 'Nehemiah 8:10'],
  ['Love the Lord your God with all your heart.', 'Matthew 22:37'],
  ['I can do all things through Christ who strengthens me.', 'Philippians 4:13'],
  ['Therefore go and make disciples of all nations.', 'Matthew 28:19'],
  ['Let us not grow weary in doing good.', 'Galatians 6:9'],
  ['The Lord bless you and keep you.', 'Numbers 6:24'],
  ['Come to me, all who labor and are heavy laden, and I will give you rest.', 'Matthew 11:28'],
  ['Rejoice in the Lord always; again I will say, rejoice.', 'Philippians 4:4'],
];
function scriptureOfDay() {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((d - start) / 86400000);
  return VERSES[dayOfYear % VERSES.length];
}

// Lightweight activity log — keeps the dashboard's "Recent Activities" panel fresh.
function logActivity(kind, description, link, userId) {
  try {
    db.prepare(
      `INSERT INTO activity_log (kind, description, link, user_id) VALUES (?, ?, ?, ?)`
    ).run(kind, description, link || null, userId || null);
  } catch (_) { /* table may not exist on very old DBs */ }
}

function layout({ title, subtitle, body, active, flash, user, bare }) {
  if (bare) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(CHURCH_NAME)}</title>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<div class="auth-shell">
  <div class="auth-card">
    <div class="brand-mini">⛪ ${esc(CHURCH_NAME)}</div>
    <h1>${esc(title)}</h1>
    ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
    ${body}
  </div>
</div>
</body></html>`;
  }
  const isAdmin = user && user.role === 'admin';
  const navHtml = NAV
    .filter((item) => !item[3] || (item[3] === 'admin' && isAdmin))
    .map(([href, label, icon]) => {
      const cls = href === active ? 'active' : '';
      return `<a class="${cls}" href="${href}"><span class="ico">${icon}</span><span>${esc(label)}</span></a>`;
    }).join('');
  const verse = scriptureOfDay();
  const userName = user ? (user.display_name || user.username) : '';
  const userInitials = initials(userName);
  const roleLabel = user ? (user.role === 'admin' ? 'Administrator' : 'Viewer') : '';
  const backup = (() => {
    try {
      const last = fs.statSync(DB_PATH).mtime;
      return last.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return '—'; }
  })();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(CHURCH_NAME)}</title>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">⛪</div>
      <div>
        <div class="name">${esc(CHURCH_NAME)}</div>
        <div class="tag">Management System</div>
      </div>
    </div>
    <nav>${navHtml}</nav>
    <div class="scripture">
      <div class="title">📖 Scripture of the Day</div>
      <blockquote>“${esc(verse[0])}”</blockquote>
      <cite>– ${esc(verse[1])}</cite>
    </div>
  </aside>
  <div class="main">
    <div class="topbar">
      <form class="search" action="/members" method="get">
        <span>🔍</span>
        <input type="search" name="q" placeholder="Search members, phone, email…">
      </form>
      <div class="right">
        <a class="bell" href="/communications" title="Notifications">🔔</a>
        <a class="who" href="/profile">
          <div class="avatar">${esc(userInitials)}</div>
          <div>
            <div class="name">${esc(userName)}</div>
            <div class="role">${esc(roleLabel)}</div>
          </div>
        </a>
        <form method="post" action="/logout"><button class="sign-out" type="submit">Sign out</button></form>
      </div>
    </div>
    <main class="page">
      ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
      <h1>${esc(title)}</h1>
      ${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}
      ${body}
    </main>
    <footer class="footer">
      <div>© ${new Date().getFullYear()} ${esc(CHURCH_NAME)}. All rights reserved.</div>
      <div class="status">
        <span>Last backup: ${esc(backup)}</span>
        <span class="status"><span class="dot"></span> System Online</span>
      </div>
    </footer>
  </div>
</div>
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
function sparkline(points) {
  if (!points.length) return '<p class="muted-text">No data yet.</p>';
  const W = 560, H = 200, P = 28;
  const xs = points.map((_, i) => P + (i * (W - P * 2)) / Math.max(1, points.length - 1));
  const max = Math.max(...points.map((p) => p.value), 1);
  const min = Math.min(...points.map((p) => p.value), 0);
  const yScale = (v) => H - P - ((v - min) / Math.max(1, max - min)) * (H - P * 2);
  const ys = points.map((p) => yScale(p.value));
  const line = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ');
  const area = `M ${xs[0]} ${H - P} L ${xs.map((x, i) => `${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' L ')} L ${xs[xs.length - 1]} ${H - P} Z`;
  const dots = xs.map((x, i) =>
    `<circle class="dot" cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3.5"></circle>`).join('');
  const xLabels = points.map((p, i) =>
    `<text x="${xs[i].toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(p.label)}</text>`).join('');
  const yMax = `<text x="6" y="${(P + 4).toFixed(1)}">${max}</text>`;
  const yMin = `<text x="6" y="${(H - P + 4).toFixed(1)}">${min}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path class="area" d="${area}"></path>
    <path class="line" d="${line}"></path>
    ${dots}${xLabels}${yMax}${yMin}
  </svg>`;
}

app.get('/', (req, res) => {
  const totalMembers = db.prepare(
    `SELECT COUNT(*) c FROM members WHERE membership_status IN ('member','regular','visitor')`
  ).get().c;
  const newMembersThisMonth = db.prepare(
    `SELECT COUNT(*) c FROM members WHERE substr(join_date,1,7) = strftime('%Y-%m','now')`
  ).get().c;

  const sundayAttendance = db.prepare(`
    SELECT COUNT(*) c FROM attendance a JOIN events e USING(event_id)
    WHERE e.event_type='service' AND substr(e.starts_at,1,10) >= date('now','-7 days')
  `).get().c;
  const prevSundayAttendance = db.prepare(`
    SELECT COUNT(*) c FROM attendance a JOIN events e USING(event_id)
    WHERE e.event_type='service'
      AND substr(e.starts_at,1,10) BETWEEN date('now','-14 days') AND date('now','-8 days')
  `).get().c;
  const attendanceDelta = prevSundayAttendance > 0
    ? Math.round(((sundayAttendance - prevSundayAttendance) / prevSundayAttendance) * 100)
    : null;

  const offeringsThisMonth = db.prepare(`
    SELECT COALESCE(SUM(amount),0) t FROM contributions
    WHERE substr(contributed_on,1,7) = strftime('%Y-%m','now')
  `).get().t;
  const offeringsLastMonth = db.prepare(`
    SELECT COALESCE(SUM(amount),0) t FROM contributions
    WHERE substr(contributed_on,1,7) = strftime('%Y-%m', date('now','start of month','-1 day'))
  `).get().t;
  const offeringsDelta = offeringsLastMonth > 0
    ? Math.round(((offeringsThisMonth - offeringsLastMonth) / offeringsLastMonth) * 100)
    : null;

  const visitorsThisMonth = db.prepare(
    `SELECT COUNT(*) c FROM members WHERE membership_status='visitor'
       AND substr(join_date,1,7) = strftime('%Y-%m','now')`
  ).get().c;
  const visitorsThisWeek = db.prepare(
    `SELECT COUNT(*) c FROM members WHERE membership_status='visitor'
       AND join_date >= date('now','-7 days')`
  ).get().c;

  // Attendance trend across the last 8 Sunday services.
  const trend = db.prepare(`
    SELECT substr(e.starts_at,1,10) AS dt, COUNT(a.member_id) AS cnt
    FROM   events e LEFT JOIN attendance a USING(event_id)
    WHERE  e.event_type='service'
    GROUP BY e.event_id
    ORDER BY e.starts_at DESC LIMIT 8
  `).all().reverse();
  const trendPts = trend.map((r, i) => ({ label: `Wk ${i + 1}`, value: r.cnt }));

  const recentActivity = db.prepare(`
    SELECT kind, description, link, occurred_at FROM activity_log
    ORDER BY occurred_at DESC LIMIT 6
  `).all();

  const upcoming = db.prepare(`
    SELECT event_id, title, event_type, starts_at, location
    FROM events WHERE starts_at >= datetime('now','-1 day')
    ORDER BY starts_at LIMIT 4
  `).all();

  const monthExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount),0) t FROM expenses
    WHERE substr(spent_on,1,7) = strftime('%Y-%m','now')
  `).get().t;
  const byFundMonth = db.prepare(`
    SELECT f.name, COALESCE(SUM(c.amount),0) t
    FROM funds f LEFT JOIN contributions c
      ON c.fund_id=f.fund_id AND substr(c.contributed_on,1,7)=strftime('%Y-%m','now')
    GROUP BY f.fund_id ORDER BY t DESC
  `).all();

  const birthdays = db.prepare(`
    SELECT member_id, first_name || ' ' || last_name AS name, date_of_birth
    FROM members WHERE date_of_birth IS NOT NULL
      AND strftime('%j', date_of_birth) BETWEEN
          strftime('%j','now') AND strftime('%j', date('now','+7 days'))
    ORDER BY strftime('%m-%d', date_of_birth) LIMIT 5
  `).all();

  const followups = {
    visitors: db.prepare(
      `SELECT COUNT(*) c FROM members WHERE membership_status='visitor' AND join_date >= date('now','-60 days')`
    ).get().c,
    absentees: (() => {
      const ids = db.prepare(`SELECT event_id FROM events WHERE event_type='service'
                              ORDER BY starts_at DESC LIMIT 3`).all().map((r) => r.event_id);
      if (!ids.length) return 0;
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(
        `SELECT COUNT(*) c FROM members m WHERE m.membership_status IN ('member','regular')
           AND NOT EXISTS (SELECT 1 FROM attendance a
             WHERE a.member_id=m.member_id AND a.event_id IN (${placeholders}))`
      ).get(...ids).c;
    })(),
    noClass: db.prepare(`SELECT COUNT(*) c FROM members
                          WHERE deleted_at IS NULL AND bible_class_id IS NULL
                            AND membership_status IN ('member','regular')`).get().c,
    pending: db.prepare(`SELECT COUNT(*) c FROM members WHERE membership_status='regular'
                          AND join_date <= date('now','-90 days') AND deleted_at IS NULL`).get().c,
  };

  const trendDelta = (n) => n == null ? '' :
    `<div class="trend ${n < 0 ? 'down' : ''}">${n >= 0 ? '↑' : '↓'} ${Math.abs(n)}% from last period</div>`;

  const cards = `
    <div class="stat-grid">
      <div class="stat">
        <div class="ico purple">👥</div>
        <div>
          <div class="label">Total Members</div>
          <div class="value">${totalMembers.toLocaleString()}</div>
          <div class="trend">↑ ${newMembersThisMonth} this month</div>
        </div>
      </div>
      <div class="stat">
        <div class="ico green">✓</div>
        <div>
          <div class="label">Sunday Attendance</div>
          <div class="value">${sundayAttendance}</div>
          ${trendDelta(attendanceDelta)}
        </div>
      </div>
      <div class="stat">
        <div class="ico blue">₵</div>
        <div>
          <div class="label">Offerings This Month</div>
          <div class="value">${fmtMoney(offeringsThisMonth)}</div>
          ${trendDelta(offeringsDelta)}
        </div>
      </div>
      <div class="stat">
        <div class="ico orange">🚶</div>
        <div>
          <div class="label">Visitors This Month</div>
          <div class="value">${visitorsThisMonth}</div>
          <div class="trend">↑ ${visitorsThisWeek} new this week</div>
        </div>
      </div>
    </div>`;

  const isAdmin = res.locals.isAdmin;
  const qaLink = (href, icon, label) =>
    `<a class="qa" href="${href}"><span class="ico">${icon}</span> ${label}</a>`;
  const quick = isAdmin ? `
    <div class="quick">
      <div class="label">Quick Actions</div>
      ${qaLink('/members/new',       '👤+', 'Add Member')}
      ${qaLink('/events',            '✓',   'Record Attendance')}
      ${qaLink('/finance/new',       '₵',   'Record Offering')}
      ${qaLink('/communications/new','✉',   'Post Announcement')}
      ${qaLink('/events/new',        '📅',  'Add Event')}
      ${qaLink('/reports',           '📊',  'Generate Report')}
    </div>` : '';

  const activityIcons = {
    member_added: '👤', attendance_recorded: '✓', contribution_recorded: '₵',
    expense_recorded: '🧾', welfare_opened: '♥', announcement: '✉',
    event_created: '📅', user_added: '🔑',
  };
  const activityCard = `
    <div class="card">
      <div class="card-head"><h2>Recent Activities</h2><a href="/reports">View all</a></div>
      ${recentActivity.length ? `<ul class="list">${recentActivity.map((a) => `
        <li>
          <span class="ico">${activityIcons[a.kind] || '•'}</span>
          <span>${a.link ? `<a href="${esc(a.link)}">${esc(a.description)}</a>` : esc(a.description)}</span>
          <span class="when">${esc(a.occurred_at.slice(5, 16).replace('T', ' '))}</span>
        </li>`).join('')}</ul>` : '<p class="muted-text">No recent activity yet.</p>'}
    </div>`;

  const chartCard = `
    <div class="card">
      <div class="card-head"><h2>Attendance Trend</h2><span class="meta">Last 8 services</span></div>
      ${sparkline(trendPts)}
    </div>`;

  const tithesMonth = (byFundMonth.find((r) => r.name === 'Tithes') || { t: 0 }).t;
  const buildingMonth = (byFundMonth.find((r) => r.name === 'Building') || { t: 0 }).t;
  const benevolentMonth = (byFundMonth.find((r) => r.name === 'Benevolence') || { t: 0 }).t;
  const netBalance = offeringsThisMonth - monthExpenses;
  const financeCard = `
    <div class="card">
      <div class="card-head"><h2>Finance Summary</h2><span class="meta">This month</span></div>
      <div class="fin-row"><span class="lbl"><span class="dot">₵</span> Total Offerings</span>
        <span class="val">${fmtMoney(offeringsThisMonth)}</span></div>
      <div class="fin-row"><span class="lbl"><span class="dot">✓</span> Tithes</span>
        <span class="val">${fmtMoney(tithesMonth)}</span></div>
      <div class="fin-row"><span class="lbl"><span class="dot">♥</span> Benevolence</span>
        <span class="val">${fmtMoney(benevolentMonth)}</span></div>
      <div class="fin-row"><span class="lbl"><span class="dot">🏠</span> Building</span>
        <span class="val">${fmtMoney(buildingMonth)}</span></div>
      <div class="fin-row"><span class="lbl"><span class="dot">🧾</span> Expenses</span>
        <span class="val neg">${fmtMoney(monthExpenses)}</span></div>
      <div class="fin-row total"><span class="lbl">Net Balance</span>
        <span class="val">${fmtMoney(netBalance)}</span></div>
    </div>`;

  const upcomingCard = `
    <div class="card">
      <div class="card-head"><h2>Upcoming Events</h2><a href="/events">View all</a></div>
      ${upcoming.length ? upcoming.map((e) => {
        const d = new Date(e.starts_at);
        const m = d.toLocaleString('en', { month: 'short' });
        const day = String(d.getDate()).padStart(2, '0');
        const when = d.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `<div class="event-row">
          <div class="date"><div class="m">${esc(m)}</div><div class="d">${day}</div></div>
          <div>
            <div><a href="/events/${e.event_id}"><strong>${esc(e.title)}</strong></a></div>
            <div class="meta">${esc(when)} · ${esc(e.location || '')}</div>
          </div>
          <span class="tag">${esc(e.event_type)}</span>
        </div>`;
      }).join('') : '<p class="muted-text">No upcoming events.</p>'}
    </div>`;

  const birthdaysCard = `
    <div class="card">
      <div class="card-head"><h2>Birthdays This Week</h2><a href="/members">View all</a></div>
      ${birthdays.length ? birthdays.map((b) => {
        const day = new Date(b.date_of_birth);
        const when = day.toLocaleString('en', { month: 'short', day: '2-digit' });
        return `<div class="bd-row">
          <div class="av">${esc(initials(b.name))}</div>
          <div><a href="/members/${b.member_id}">${esc(b.name)}</a></div>
          <div class="when">${esc(when)}</div>
        </div>`;
      }).join('') : '<p class="muted-text">No birthdays this week.</p>'}
    </div>`;

  const followupsCard = `
    <div class="card">
      <div class="card-head"><h2>Pending Follow-ups</h2><a href="/reports">View all</a></div>
      <div class="fu-row"><div class="lbl"><div class="ico">🚶</div> Visitors to follow up</div><div class="count">${followups.visitors}</div></div>
      <div class="fu-row"><div class="lbl"><div class="ico">⚠</div> Members absent &gt; 3 weeks</div><div class="count">${followups.absentees}</div></div>
      <div class="fu-row"><div class="lbl"><div class="ico">📖</div> Members without a Bible class</div><div class="count">${followups.noClass}</div></div>
      <div class="fu-row"><div class="lbl"><div class="ico">✓</div> Pending membership approvals</div><div class="count">${followups.pending}</div></div>
    </div>`;

  const grid = `
    <div class="dash-grid">
      ${activityCard}
      ${chartCard}
      ${financeCard}
      ${upcomingCard}
      ${birthdaysCard}
      ${followupsCard}
    </div>`;

  res.page({
    title: 'Dashboard',
    subtitle: `Welcome back, ${res.locals.user.display_name || res.locals.user.username}`,
    active: '/',
    body: `${cards}${quick}${grid}`,
  });
});

// ---------- members ----------
function selectMembers({ q, status }) {
  const where = ['m.deleted_at IS NULL'];
  const params = {};
  if (q) {
    where.push(`(m.first_name LIKE @q OR m.last_name LIKE @q OR m.email LIKE @q
                 OR m.mobile_phone LIKE @q OR m.external_id LIKE @q)`);
    params.q = `%${q}%`;
  }
  if (status) { where.push(`m.membership_status = @status`); params.status = status; }
  const sql = `
    SELECT m.member_id, m.external_id, m.first_name, m.last_name, m.email, m.mobile_phone,
           m.membership_status, mn.name AS bible_class
    FROM members m LEFT JOIN ministries mn ON mn.ministry_id = m.bible_class_id
    WHERE ${where.join(' AND ')}
    ORDER BY m.last_name, m.first_name`;
  return db.prepare(sql).all(params);
}

app.get('/members', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const rows = selectMembers({ q, status });
  const statuses = ['', 'visitor', 'regular', 'member', 'inactive', 'transferred', 'deceased'];
  const opts = statuses.map((s) =>
    `<option value="${s}" ${s === status ? 'selected' : ''}>${s || 'Any status'}</option>`).join('');
  const exportQs = new URLSearchParams({ q, status }).toString();
  const body = `
    <form class="filters" method="get">
      <input type="search" name="q" placeholder="Search name, ID, email, phone" value="${esc(q)}">
      <select name="status">${opts}</select>
      <button type="submit">Filter</button>
      ${res.locals.isAdmin ? '<a class="btn" href="/members/new">+ New member</a>' : ''}
      <details class="export">
        <summary>⋯ Export</summary>
        <a href="/members.csv?${exportQs}">Export CSV</a>
        <a href="javascript:window.print()">Print / PDF</a>
      </details>
    </form>
    ${table(['Member ID', 'Name', 'Bible class', 'Status', 'Email', 'Phone'],
      rows.map((r) => [
        esc(r.external_id) || '—',
        `<a href="/members/${r.member_id}">${esc(r.first_name)} ${esc(r.last_name)}</a>`,
        esc(r.bible_class) || '—',
        `<span class="pill pill-${esc(r.membership_status)}">${esc(r.membership_status)}</span>`,
        esc(r.email),
        esc(r.mobile_phone),
      ]))}`;
  res.page({ title: `Members (${rows.length})`, active: '/members', body });
});

app.get('/members.csv', (req, res) => {
  const rows = selectMembers({ q: req.query.q || '', status: req.query.status || '' });
  const headers = ['Member ID', 'First name', 'Last name', 'Bible class', 'Status', 'Email', 'Phone'];
  const csv = [headers.join(',')].concat(
    rows.map((r) => [r.external_id, r.first_name, r.last_name, r.bible_class,
      r.membership_status, r.email, r.mobile_phone]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=members.csv');
  res.send(csv);
});

function memberForm(member = {}, bibleClasses = [], organizations = [], memberOrgIds = [], action) {
  const bibleClassOpts = '<option value="">— none —</option>' +
    bibleClasses.map((b) =>
      `<option value="${b.ministry_id}" ${b.ministry_id === member.bible_class_id ? 'selected' : ''}>${esc(b.name)}</option>`
    ).join('');
  const statusOpts = ['visitor', 'regular', 'member', 'inactive', 'transferred', 'deceased']
    .map((s) => `<option value="${s}" ${s === member.membership_status ? 'selected' : ''}>${s}</option>`).join('');
  const maritalOpts = ['', 'single', 'married', 'divorced', 'widowed', 'separated']
    .map((s) => `<option value="${s}" ${s === (member.marital_status || '') ? 'selected' : ''}>${s || '—'}</option>`).join('');
  const genderOpts = ['', 'M', 'F', 'O']
    .map((s) => `<option value="${s}" ${s === (member.gender || '') ? 'selected' : ''}>${s || '—'}</option>`).join('');
  const orgChecks = organizations.map((o) => `
      <label class="check"><input type="checkbox" name="org_ids" value="${o.org_id}"
        ${memberOrgIds.includes(o.org_id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('');
  const memberIdField = member.member_id
    ? `<label>Member ID<input name="external_id" value="${esc(member.external_id || '')}" readonly></label>`
    : `<label>Member ID<input name="external_id" value="(auto-generated on save)" readonly></label>`;
  return `
    <form method="post" action="${action}" class="form">
      ${memberIdField}
      <label>Status<select name="membership_status">${statusOpts}</select></label>
      <label>First name<input name="first_name" required value="${esc(member.first_name)}"></label>
      <label>Last name<input name="last_name" required value="${esc(member.last_name)}"></label>
      <label>Email<input type="email" name="email" value="${esc(member.email)}"></label>
      <label>Mobile<input name="mobile_phone" value="${esc(member.mobile_phone)}"></label>
      <label>Date of birth<input type="date" name="date_of_birth" value="${fmtDate(member.date_of_birth)}"></label>
      <label>Gender<select name="gender">${genderOpts}</select></label>
      <label>Marital<select name="marital_status">${maritalOpts}</select></label>
      <label>Bible class<select name="bible_class_id">${bibleClassOpts}</select></label>
      <label>Join date<input type="date" name="join_date" value="${fmtDate(member.join_date)}"></label>
      <label>Baptism date<input type="date" name="baptism_date" value="${fmtDate(member.baptism_date)}"></label>
      <label>Confirmation date<input type="date" name="confirmation_date" value="${fmtDate(member.confirmation_date)}"></label>
      <label class="wide">Organizations<div class="check-grid">${orgChecks || '<span class="muted-text">No organizations yet.</span>'}</div></label>
      <label class="wide">Notes<textarea name="notes" rows="3">${esc(member.notes)}</textarea></label>
      <div class="actions"><button type="submit">Save</button></div>
    </form>`;
}

function loadBibleClasses() {
  return db.prepare(`SELECT ministry_id, name FROM ministries WHERE active=1 ORDER BY name`).all();
}
function loadOrganizations() {
  return db.prepare(`SELECT org_id, name FROM organizations WHERE active=1 ORDER BY name`).all();
}

app.get('/members/new', requireAdmin, (req, res) => {
  res.page({
    title: 'New member', active: '/members',
    body: memberForm({}, loadBibleClasses(), loadOrganizations(), [], '/members'),
  });
});

function parseOrgIds(body) {
  const v = body.org_ids;
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => Number(x)).filter((x) => x);
}

function saveMemberOrgs(memberId, orgIds) {
  db.prepare(`DELETE FROM organization_memberships WHERE member_id=?`).run(memberId);
  const ins = db.prepare(`INSERT INTO organization_memberships (org_id, member_id) VALUES (?, ?)`);
  for (const oid of orgIds) ins.run(oid, memberId);
}

app.post('/members', requireAdmin, (req, res) => {
  const b = req.body;
  const externalId = nextMemberId();
  const info = db.prepare(`
    INSERT INTO members (external_id, bible_class_id, first_name, last_name, email, mobile_phone,
      date_of_birth, gender, marital_status, membership_status,
      join_date, baptism_date, confirmation_date, notes)
    VALUES (@external_id, @bible_class_id, @first_name, @last_name, @email, @mobile_phone,
      @date_of_birth, @gender, @marital_status, @membership_status,
      @join_date, @baptism_date, @confirmation_date, @notes)
  `).run({
    external_id: externalId,
    bible_class_id: b.bible_class_id ? Number(b.bible_class_id) : null,
    first_name: b.first_name, last_name: b.last_name,
    email: b.email || null, mobile_phone: b.mobile_phone || null,
    date_of_birth: b.date_of_birth || null, gender: b.gender || null,
    marital_status: b.marital_status || null,
    membership_status: b.membership_status || 'visitor',
    join_date: b.join_date || null, baptism_date: b.baptism_date || null,
    confirmation_date: b.confirmation_date || null,
    notes: b.notes || null,
  });
  saveMemberOrgs(info.lastInsertRowid, parseOrgIds(b));
  logActivity('member_added',
    `New member added: ${b.first_name} ${b.last_name} (${externalId})`,
    `/members/${info.lastInsertRowid}`, res.locals.user.user_id);
  res.redirect(`/members/${info.lastInsertRowid}`);
});

app.get('/members/:id', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare(`
    SELECT m.*, mn.name AS bible_class_name FROM members m
    LEFT JOIN ministries mn ON mn.ministry_id = m.bible_class_id
    WHERE m.member_id = ? AND m.deleted_at IS NULL`).get(id);
  if (!m) return res.status(404).send('Not found');
  const memberOrgs = db.prepare(
    `SELECT org_id FROM organization_memberships WHERE member_id=?`
  ).all(id).map((r) => r.org_id);
  const memberOrgsNamed = db.prepare(`
    SELECT o.org_id, o.name FROM organization_memberships om
    JOIN organizations o USING(org_id) WHERE om.member_id=? ORDER BY o.name`).all(id);
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

  const editPanel = res.locals.isAdmin
    ? `<h2>Edit</h2>
       ${memberForm(m, loadBibleClasses(), loadOrganizations(), memberOrgs, `/members/${id}`)}
       <form method="post" action="/members/${id}/delete" onsubmit="return confirm('Archive this member? They will be hidden but not permanently deleted.')">
         <button class="danger" type="submit">Archive member</button>
       </form>`
    : `<h2>Profile</h2>
       <dl class="stats">
         <dt>Member ID</dt><dd>${esc(m.external_id) || '—'}</dd>
         <dt>Name</dt><dd>${esc(m.first_name)} ${esc(m.last_name)}</dd>
         <dt>Email</dt><dd>${esc(m.email) || '—'}</dd>
         <dt>Mobile</dt><dd>${esc(m.mobile_phone) || '—'}</dd>
         <dt>Status</dt><dd>${esc(m.membership_status)}</dd>
         <dt>Bible class</dt><dd>${esc(m.bible_class_name) || '—'}</dd>
         <dt>Organizations</dt><dd>${memberOrgsNamed.map((o) => esc(o.name)).join(', ') || '—'}</dd>
         <dt>Joined</dt><dd>${esc(m.join_date) || '—'}</dd>
         <dt>Baptized</dt><dd>${esc(m.baptism_date) || '—'}</dd>
         <dt>Confirmed</dt><dd>${esc(m.confirmation_date) || '—'}</dd>
         <dt>Notes</dt><dd>${esc(m.notes) || '—'}</dd>
       </dl>`;
  const body = `
    <div class="two-col">
      <section>
        ${editPanel}
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
  res.page({
    title: `${m.first_name} ${m.last_name}`, active: '/members', body,
  });
});

app.post('/members/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  db.prepare(`
    UPDATE members SET bible_class_id=@bible_class_id, first_name=@first_name, last_name=@last_name,
      email=@email, mobile_phone=@mobile_phone, date_of_birth=@date_of_birth, gender=@gender,
      marital_status=@marital_status, membership_status=@membership_status,
      join_date=@join_date, baptism_date=@baptism_date,
      confirmation_date=@confirmation_date, notes=@notes
    WHERE member_id=@id`).run({
    id,
    bible_class_id: b.bible_class_id ? Number(b.bible_class_id) : null,
    first_name: b.first_name, last_name: b.last_name,
    email: b.email || null, mobile_phone: b.mobile_phone || null,
    date_of_birth: b.date_of_birth || null, gender: b.gender || null,
    marital_status: b.marital_status || null,
    membership_status: b.membership_status || 'visitor',
    join_date: b.join_date || null, baptism_date: b.baptism_date || null,
    confirmation_date: b.confirmation_date || null,
    notes: b.notes || null,
  });
  saveMemberOrgs(id, parseOrgIds(b));
  res.redirect(`/members/${id}`);
});

app.post('/members/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE members SET deleted_at=CURRENT_TIMESTAMP WHERE member_id=?`).run(id);
  res.redirect('/members');
});

// Keep old URLs working.
app.get('/households',  (_, res) => res.redirect('/members'));
app.get('/ministries',  (_, res) => res.redirect('/bible-classes'));
app.get('/welfare',     (_, res) => res.redirect('/organizations'));

// ---------- bible classes (formerly ministries) ----------
app.get('/bible-classes', (req, res) => {
  const rows = db.prepare(`
    SELECT mn.ministry_id, mn.name, mn.description, mn.meets_on, mn.active,
           ml.first_name || ' ' || ml.last_name AS leader_name,
           ml.member_id AS leader_id,
           o.org_id, o.name AS org_name,
           (SELECT COUNT(*) FROM members m WHERE m.bible_class_id=mn.ministry_id AND m.deleted_at IS NULL) AS member_count
    FROM ministries mn
    LEFT JOIN members ml ON ml.member_id = mn.leader_id
    LEFT JOIN organizations o ON o.org_id = mn.org_id
    ORDER BY mn.name`).all();
  const orgs = loadOrganizations();
  const allMembers = db.prepare(
    `SELECT member_id, first_name || ' ' || last_name AS name FROM members
       WHERE deleted_at IS NULL ORDER BY last_name`
  ).all();
  const orgOpts = (selected) => '<option value="">— none —</option>' +
    orgs.map((o) => `<option value="${o.org_id}" ${o.org_id === selected ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  const memberOpts = (selected) => '<option value="">— none —</option>' +
    allMembers.map((m) => `<option value="${m.member_id}" ${m.member_id === selected ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

  const newForm = res.locals.isAdmin
    ? `<h2>Add a Bible class</h2>
       <form class="form" method="post" action="/bible-classes">
         <label>Bible class<input name="name" required></label>
         <label>Leader<select name="leader_id">${memberOpts()}</select></label>
         <label>Organization<select name="org_id">${orgOpts()}</select></label>
         <label>Meets<input name="meets_on" placeholder="e.g. Sunday 8am"></label>
         <label class="wide">Description<input name="description"></label>
         <div class="actions"><button type="submit">Add</button></div>
       </form>` : '';

  const tableRows = rows.map((r) => [
    `<strong>${esc(r.name)}</strong>${r.description ? `<div class="muted-text" style="font-size:0.8rem">${esc(r.description)}</div>` : ''}`,
    r.leader_id ? `<a href="/members/${r.leader_id}">${esc(r.leader_name)}</a>` : '—',
    r.org_id ? esc(r.org_name) : '—',
    esc(r.meets_on) || '—',
    `<a href="/members?q=${encodeURIComponent('')}&class=${r.ministry_id}">${r.member_count}</a>`,
    res.locals.isAdmin
      ? `<form method="post" action="/bible-classes/${r.ministry_id}" class="inline">
           <select name="leader_id">${memberOpts(r.leader_id)}</select>
           <select name="org_id">${orgOpts(r.org_id)}</select>
           <button type="submit">Save</button>
         </form>` : '',
  ]);

  res.page({
    title: 'Bible Classes', active: '/bible-classes',
    body: `${newForm}
      <h2>All Bible classes</h2>
      ${table(['Bible class', 'Leader', 'Organization', 'Meets', 'Members', res.locals.isAdmin ? 'Actions' : ''], tableRows)}`,
  });
});

app.post('/bible-classes', requireAdmin, (req, res) => {
  const b = req.body;
  if (!b.name) return res.redirect('/bible-classes');
  db.prepare(`
    INSERT INTO ministries (name, description, leader_id, org_id, meets_on)
    VALUES (?, ?, ?, ?, ?)`).run(
    b.name, b.description || null,
    b.leader_id ? Number(b.leader_id) : null,
    b.org_id ? Number(b.org_id) : null,
    b.meets_on || null
  );
  res.redirect('/bible-classes');
});

app.post('/bible-classes/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  db.prepare(`UPDATE ministries SET leader_id=?, org_id=? WHERE ministry_id=?`)
    .run(b.leader_id ? Number(b.leader_id) : null,
         b.org_id ? Number(b.org_id) : null, id);
  res.redirect('/bible-classes');
});

// ---------- events ----------
app.get('/events', (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, COUNT(a.member_id) attendees
    FROM events e LEFT JOIN attendance a USING(event_id)
    GROUP BY e.event_id ORDER BY e.starts_at DESC`).all();
  const body = `
    ${res.locals.isAdmin ? '<p><a class="btn" href="/events/new">+ New event</a></p>' : ''}
    ${table(['When', 'Title', 'Type', 'Location', 'Attendees'],
      rows.map((r) => [
        esc(r.starts_at),
        `<a href="/events/${r.event_id}">${esc(r.title)}</a>`,
        esc(r.event_type), esc(r.location), r.attendees,
      ]))}`;
  res.page({ title: 'Events', active: '/events', body });
});

app.get('/events/new', requireAdmin, (req, res) => {
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
  res.page({ title: 'New event', active: '/events', body });
});

app.post('/events', requireAdmin, (req, res) => {
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

  const body = `
    <p><strong>${esc(ev.event_type)}</strong> · ${esc(ev.starts_at)} · ${esc(ev.location) || ''}</p>
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

// Keep old URLs working.
app.get('/contributions', (_, res) => res.redirect('/finance'));

// ---------- finance (offerings + expenses) ----------
app.get('/finance', (req, res) => {
  const funds = db.prepare(`SELECT * FROM funds WHERE active=1 ORDER BY name`).all();
  const members = db.prepare(`
    SELECT member_id, first_name || ' ' || last_name AS name FROM members
    WHERE deleted_at IS NULL ORDER BY last_name`).all();
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

  const recordPanel = res.locals.isAdmin
    ? `<h2>Record contribution</h2>
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
       </form>`
    : '';
  const expenseRows = db.prepare(`
    SELECT e.expense_id, e.spent_on, e.category, e.amount, e.description, f.name fund
    FROM expenses e LEFT JOIN funds f USING(fund_id)
    ORDER BY e.spent_on DESC, e.expense_id DESC LIMIT 50`).all();
  const totalContrib = db.prepare(
    `SELECT COALESCE(SUM(amount),0) t FROM contributions WHERE substr(contributed_on,1,4)=strftime('%Y','now')`
  ).get().t;
  const totalExpense = db.prepare(
    `SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE substr(spent_on,1,4)=strftime('%Y','now')`
  ).get().t;

  const expensePanel = res.locals.isAdmin
    ? `<h2>Record expense</h2>
       <form class="form" method="post" action="/finance/expenses">
         <label>Date<input type="date" name="spent_on" required value="${new Date().toISOString().slice(0,10)}"></label>
         <label>Category<input name="category" placeholder="e.g. utilities" required></label>
         <label>Amount<input type="number" step="0.01" min="0.01" name="amount" required></label>
         <label>Fund<select name="fund_id"><option value="">(none)</option>${fundOpts}</select></label>
         <label class="wide">Description<input name="description"></label>
         <div class="actions"><button type="submit">Save</button></div>
       </form>`
    : '';

  const summary = `
    <div class="stat-grid">
      <div class="stat"><div class="ico green">↑</div><div>
        <div class="label">YTD Offerings</div>
        <div class="value">${fmtMoney(totalContrib)}</div></div></div>
      <div class="stat"><div class="ico orange">↓</div><div>
        <div class="label">YTD Expenses</div>
        <div class="value">${fmtMoney(totalExpense)}</div></div></div>
      <div class="stat"><div class="ico purple">=</div><div>
        <div class="label">Net YTD</div>
        <div class="value">${fmtMoney(totalContrib - totalExpense)}</div></div></div>
    </div>`;

  const body = `
    ${summary}
    <div class="two-col">
      <section>${recordPanel}</section>
      <section>${expensePanel}</section>
    </div>
    <h2>YTD by fund</h2>
    ${table(['Fund', 'Total'], byFund.map((r) => [esc(r.fund), fmtMoney(r.total)]))}
    <h2>Recent contributions</h2>
    ${table(['Date', 'Donor', 'Fund', 'Amount', 'Method', 'Reference'],
      rows.map((r) => [esc(r.contributed_on),
        r.member_id ? `<a href="/members/${r.member_id}">${esc(r.donor)}</a>` : esc(r.donor),
        esc(r.fund), fmtMoney(r.amount), esc(r.method), esc(r.reference)]))}
    <h2>Recent expenses</h2>
    ${expenseRows.length
      ? table(['Date', 'Category', 'Description', 'Fund', 'Amount'],
          expenseRows.map((e) => [esc(e.spent_on), esc(e.category),
            esc(e.description), esc(e.fund), fmtMoney(e.amount)]))
      : '<p class="muted-text">No expenses recorded.</p>'}`;
  res.page({ title: 'Finance', active: '/finance', body });
});

// Quick offering form lives at /finance/new for the dashboard Quick Action.
app.get('/finance/new', requireAdmin, (req, res) => res.redirect('/finance'));

app.post('/contributions', requireAdmin, (req, res) => {
  const b = req.body;
  const info = db.prepare(`
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
  const donor = b.member_id
    ? db.prepare(`SELECT first_name||' '||last_name AS n FROM members WHERE member_id=?`).get(Number(b.member_id))?.n
    : 'anonymous';
  logActivity('contribution_recorded',
    `Offering of ${fmtMoney(b.amount)} recorded${donor ? ' from ' + donor : ''}`,
    `/finance`, res.locals.user.user_id);
  res.redirect('/finance');
});

app.post('/finance/expenses', requireAdmin, (req, res) => {
  const b = req.body;
  db.prepare(`
    INSERT INTO expenses (category, amount, spent_on, description, fund_id)
    VALUES (@category, @amount, @spent_on, @description, @fund_id)
  `).run({
    category: b.category, amount: Number(b.amount),
    spent_on: b.spent_on, description: b.description || null,
    fund_id: b.fund_id ? Number(b.fund_id) : null,
  });
  logActivity('expense_recorded',
    `Expense ${fmtMoney(b.amount)} (${b.category}) recorded`,
    `/finance`, res.locals.user.user_id);
  res.redirect('/finance');
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
  res.page({ title: 'Reports', active: '/reports', body });
});

// ---------- attendance (cross-event view) ----------
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

// ---------- organizations ----------
app.get('/organizations', (req, res) => {
  const orgs = db.prepare(`
    SELECT o.org_id, o.name, o.description, o.meets_on,
           ml.member_id AS leader_id,
           ml.first_name || ' ' || ml.last_name AS leader_name,
           (SELECT COUNT(*) FROM organization_memberships om WHERE om.org_id=o.org_id) AS member_count
    FROM organizations o
    LEFT JOIN members ml ON ml.member_id = o.leader_id
    WHERE o.active=1
    ORDER BY o.name`).all();
  const rosters = db.prepare(`
    SELECT om.org_id, m.member_id, m.external_id,
           m.first_name || ' ' || m.last_name AS member, om.role
    FROM organization_memberships om
    JOIN members m USING(member_id)
    WHERE m.deleted_at IS NULL
    ORDER BY m.last_name`).all();
  const allMembers = db.prepare(
    `SELECT member_id, first_name || ' ' || last_name AS name FROM members
       WHERE deleted_at IS NULL ORDER BY last_name`
  ).all();
  const memberOpts = (sel) => '<option value="">— none —</option>' +
    allMembers.map((m) => `<option value="${m.member_id}" ${m.member_id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

  const sections = orgs.map((o) => {
    const members = rosters.filter((r) => r.org_id === o.org_id);
    const list = members.length
      ? `<table style="margin-top:0.5rem">
           <thead><tr><th>Member ID</th><th>Name</th><th>Role</th>${res.locals.isAdmin ? '<th></th>' : ''}</tr></thead>
           <tbody>${members.map((m) => `
             <tr>
               <td>${esc(m.external_id) || '—'}</td>
               <td><a href="/members/${m.member_id}">${esc(m.member)}</a></td>
               <td>${esc(m.role)}</td>
               ${res.locals.isAdmin ? `<td>
                 <form method="post" action="/organizations/${o.org_id}/remove" class="inline">
                   <input type="hidden" name="member_id" value="${m.member_id}">
                   <button class="link" type="submit">remove</button>
                 </form></td>` : ''}
             </tr>`).join('')}</tbody>
         </table>`
      : '<p class="muted-text">No members assigned yet.</p>';
    const addForm = res.locals.isAdmin
      ? `<form method="post" action="/organizations/${o.org_id}/add" class="inline" style="margin-top:0.5rem">
           <select name="member_id" required>${memberOpts()}</select>
           <select name="role">
             <option value="member">member</option>
             <option value="leader">leader</option>
           </select>
           <button type="submit">Add member</button>
         </form>
         <form method="post" action="/organizations/${o.org_id}/leader" class="inline">
           <select name="leader_id">${memberOpts(o.leader_id)}</select>
           <button type="submit">Set leader</button>
         </form>`
      : '';
    return `<section class="card" style="margin-bottom:1rem">
      <div class="card-head">
        <h2>${esc(o.name)}</h2>
        <span class="meta">${o.member_count} member${o.member_count === 1 ? '' : 's'}</span>
      </div>
      ${o.description ? `<p>${esc(o.description)}</p>` : ''}
      <p><strong>Leader:</strong> ${o.leader_id
        ? `<a href="/members/${o.leader_id}">${esc(o.leader_name)}</a>` : '—'}
        ${o.meets_on ? ` · <strong>Meets:</strong> ${esc(o.meets_on)}` : ''}</p>
      ${list}
      ${addForm}
    </section>`;
  }).join('');

  const newForm = res.locals.isAdmin
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Add an organization</strong></summary>
         <form class="form" method="post" action="/organizations" style="margin-top:0.75rem">
           <label class="wide">Name<input name="name" required></label>
           <label>Meets<input name="meets_on" placeholder="e.g. Saturday 5pm"></label>
           <label>Leader<select name="leader_id">${memberOpts()}</select></label>
           <label class="wide">Description<input name="description"></label>
           <div class="actions"><button type="submit">Add organization</button></div>
         </form>
       </details>` : '';

  res.page({
    title: 'Organizations', active: '/organizations',
    body: `${newForm}${sections}`,
  });
});

app.post('/organizations', requireAdmin, (req, res) => {
  const b = req.body;
  if (!b.name) return res.redirect('/organizations');
  try {
    db.prepare(`INSERT INTO organizations (name, description, meets_on, leader_id) VALUES (?, ?, ?, ?)`)
      .run(b.name, b.description || null, b.meets_on || null,
           b.leader_id ? Number(b.leader_id) : null);
  } catch (_) { /* unique conflict */ }
  res.redirect('/organizations');
});

app.post('/organizations/:id/add', requireAdmin, (req, res) => {
  const oid = Number(req.params.id);
  const mid = Number(req.body.member_id);
  if (!mid) return res.redirect('/organizations');
  try {
    db.prepare(`INSERT INTO organization_memberships (org_id, member_id, role) VALUES (?, ?, ?)`)
      .run(oid, mid, req.body.role === 'leader' ? 'leader' : 'member');
  } catch (_) { /* already a member */ }
  res.redirect('/organizations');
});

app.post('/organizations/:id/remove', requireAdmin, (req, res) => {
  const oid = Number(req.params.id);
  const mid = Number(req.body.member_id);
  db.prepare(`DELETE FROM organization_memberships WHERE org_id=? AND member_id=?`).run(oid, mid);
  res.redirect('/organizations');
});

app.post('/organizations/:id/leader', requireAdmin, (req, res) => {
  const oid = Number(req.params.id);
  const lid = req.body.leader_id ? Number(req.body.leader_id) : null;
  db.prepare(`UPDATE organizations SET leader_id=? WHERE org_id=?`).run(lid, oid);
  res.redirect('/organizations');
});

// ---------- communications (announcements) ----------
app.get('/communications', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.display_name, u.username FROM announcements a
    LEFT JOIN users u ON u.user_id=a.posted_by
    ORDER BY a.posted_at DESC LIMIT 50`).all();
  const newForm = res.locals.isAdmin
    ? `<h2>Post an announcement</h2>
       <form class="form" method="post" action="/communications">
         <label class="wide">Title<input name="title" required></label>
         <label class="wide">Message<textarea name="body" rows="4" required></textarea></label>
         <label>Audience<select name="audience">
           <option value="all">Everyone</option>
           <option value="members">Members only</option>
         </select></label>
         <div class="actions"><button type="submit">Post</button></div>
       </form>` : '';
  const list = rows.length
    ? rows.map((a) => `
        <div class="card" style="margin-bottom:0.75rem">
          <div class="card-head">
            <h2>${esc(a.title)}</h2>
            <span class="meta">${esc(a.posted_at.slice(0, 16).replace('T', ' '))}</span>
          </div>
          <p>${esc(a.body)}</p>
          <p class="muted-text">— ${esc(a.display_name || a.username || 'system')} · audience: ${esc(a.audience)}</p>
        </div>`).join('')
    : '<p class="muted-text">No announcements yet.</p>';
  res.page({
    title: 'Communications', active: '/communications',
    body: `${newForm}<h2>Recent announcements</h2>${list}`,
  });
});

app.get('/communications/new', requireAdmin, (req, res) => res.redirect('/communications'));

app.post('/communications', requireAdmin, (req, res) => {
  const { title, body, audience } = req.body;
  if (!title || !body) return res.redirect('/communications');
  db.prepare(`
    INSERT INTO announcements (title, body, audience, posted_by)
    VALUES (?, ?, ?, ?)`).run(
    title, body, audience || 'all', res.locals.user.user_id
  );
  logActivity('announcement', `New announcement: ${title}`, '/communications', res.locals.user.user_id);
  res.redirect('/communications');
});

// ---------- sacraments ----------
app.get('/sacraments', (req, res) => {
  const counts = db.prepare(`
    SELECT sacrament_type t, COUNT(*) c FROM sacraments GROUP BY sacrament_type`).all();
  const total = counts.reduce((a, b) => a + b.c, 0);
  const rows = db.prepare(`
    SELECT s.sacrament_id, s.sacrament_type, s.occurred_on, s.location,
           s.member_id, m.first_name || ' ' || m.last_name AS member,
           s.spouse_id, sp.first_name || ' ' || sp.last_name AS spouse
    FROM sacraments s
    LEFT JOIN members m  ON m.member_id  = s.member_id
    LEFT JOIN members sp ON sp.member_id = s.spouse_id
    ORDER BY s.occurred_on DESC LIMIT 100`).all();
  const stats = `
    <div class="stat-grid">
      <div class="stat"><div class="ico purple">⛪</div><div>
        <div class="label">Total recorded</div><div class="value">${total}</div></div></div>
      ${counts.map((c) => `
        <div class="stat"><div class="ico green">✓</div><div>
          <div class="label">${esc(c.t)}</div>
          <div class="value">${c.c}</div></div></div>`).join('')}
    </div>`;
  const body = `
    ${stats}
    ${table(['Type', 'Date', 'Member', 'Spouse', 'Location'],
      rows.map((r) => [esc(r.sacrament_type), esc(r.occurred_on),
        r.member_id ? `<a href="/members/${r.member_id}">${esc(r.member)}</a>` : '—',
        r.spouse_id ? `<a href="/members/${r.spouse_id}">${esc(r.spouse)}</a>` : '—',
        esc(r.location)]))}`;
  res.page({ title: 'Sacraments', active: '/sacraments', body });
});

// ---------- settings ----------
app.get('/settings', requireAdmin, (req, res) => {
  const body = `
    <div class="card">
      <h2>Application</h2>
      <dl class="stats">
        <dt>Church name</dt><dd>${esc(CHURCH_NAME)} <span class="muted-text">(set via the CHURCH_NAME env var)</span></dd>
        <dt>Database</dt><dd><code>${esc(DB_PATH)}</code></dd>
        <dt>Currency</dt><dd>Ghanaian cedi (GH₵)</dd>
      </dl>
    </div>
    <div class="card">
      <h2>Roles & access</h2>
      <p>Manage user accounts and permissions on the <a href="/users">Users &amp; Roles</a> page.</p>
    </div>
    <div class="card">
      <h2>Backup</h2>
      <p>Your database file is at <code>${esc(DB_PATH)}</code>. To back it up while running on Fly:</p>
      <pre>flyctl ssh sftp get ${esc(DB_PATH)} ./church-backup.db</pre>
    </div>`;
  res.page({ title: 'Settings', active: '/settings', body });
});

// ---------- profile (any signed-in user) ----------
app.get('/profile', (req, res) => {
  const u = res.locals.user;
  const flash = req.query.ok === '1' ? 'Password updated.' : null;
  const error = req.query.e ? {
    short: 'New password must be at least 8 characters.',
    mismatch: 'New passwords do not match.',
    bad: 'Current password is incorrect.',
  }[req.query.e] : null;
  const body = `
    <p>Signed in as <strong>${esc(u.username)}</strong> (${esc(u.role)}).</p>
    <h2>Change password</h2>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <form class="form" method="post" action="/profile/password">
      <label class="wide">Current password<input type="password" name="current" required></label>
      <label class="wide">New password<input type="password" name="next" required minlength="8"></label>
      <label class="wide">Confirm new password<input type="password" name="next2" required></label>
      <div class="actions"><button type="submit">Update password</button></div>
    </form>`;
  res.page({ title: 'Profile', body, flash });
});

app.post('/profile/password', (req, res) => {
  const { current, next: np, next2 } = req.body;
  const u = db.prepare('SELECT password_hash FROM users WHERE user_id=?').get(res.locals.user.user_id);
  if (!bcrypt.compareSync(current || '', u.password_hash)) return res.redirect('/profile?e=bad');
  if (!np || np.length < 8) return res.redirect('/profile?e=short');
  if (np !== next2) return res.redirect('/profile?e=mismatch');
  db.prepare('UPDATE users SET password_hash=? WHERE user_id=?')
    .run(bcrypt.hashSync(np, 12), res.locals.user.user_id);
  res.redirect('/profile?ok=1');
});

// ---------- users management (admin only) ----------
app.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare(
    `SELECT user_id, username, display_name, role, created_at FROM users
     WHERE deleted_at IS NULL ORDER BY username`
  ).all();
  const rows = users.map((u) => [
    esc(u.username),
    esc(u.display_name) || '—',
    `<span class="role-badge role-${esc(u.role)}">${esc(u.role)}</span>`,
    esc(u.created_at).slice(0, 10),
    `<form method="post" action="/users/${u.user_id}/role" class="inline">
       <select name="role">
         <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
         <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>viewer</option>
       </select>
       <button type="submit">Save</button>
     </form>
     <form method="post" action="/users/${u.user_id}/reset" class="inline">
       <input type="password" name="password" placeholder="new password" minlength="8" required>
       <button type="submit">Reset</button>
     </form>
     ${u.user_id === res.locals.user.user_id
       ? ''
       : `<form method="post" action="/users/${u.user_id}/delete" class="inline"
            onsubmit="return confirm('Delete ${esc(u.username)}?')">
            <button class="danger" type="submit">Delete</button>
          </form>`}`,
  ]);
  const body = `
    <p><a class="btn" href="/users/new">+ New user</a></p>
    ${table(['Username', 'Display name', 'Role', 'Created', 'Actions'], rows)}`;
  res.page({ title: 'Users', body });
});

app.get('/users/new', requireAdmin, (req, res) => {
  const body = `
    <form class="form" method="post" action="/users">
      <label>Username<input name="username" required></label>
      <label>Display name<input name="display_name"></label>
      <label>Password<input type="password" name="password" required minlength="8"></label>
      <label>Role<select name="role">
        <option value="admin">admin</option>
        <option value="viewer" selected>viewer</option>
      </select></label>
      <div class="actions"><button type="submit">Create user</button></div>
    </form>`;
  res.page({ title: 'New user', body });
});

app.post('/users', requireAdmin, (req, res) => {
  const { username, display_name, password, role } = req.body;
  if (!username || !password || password.length < 8) return res.redirect('/users/new');
  const r = role === 'viewer' ? 'viewer' : 'admin';
  try {
    db.prepare(
      `INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)`
    ).run(username.trim(), bcrypt.hashSync(password, 12), (display_name || '').trim() || null, r);
  } catch (e) {
    return res.status(400).send(layout({
      title: 'Could not create user', user: res.locals.user, active: null,
      body: `<p class="error">${esc(e.message)}</p><p><a href="/users/new">Try again</a></p>`,
    }));
  }
  res.redirect('/users');
});

app.post('/users/:id/role', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const r = req.body.role === 'viewer' ? 'viewer' : 'admin';
  // Don't allow removing the last admin.
  if (r !== 'admin') {
    const admins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin'`).get().c;
    const target = db.prepare(`SELECT role FROM users WHERE user_id=?`).get(id);
    if (target && target.role === 'admin' && admins <= 1) {
      return res.status(400).send(layout({
        title: 'Cannot demote the last admin', user: res.locals.user, active: null,
        body: '<p>Promote another user to admin first.</p><p><a href="/users">Back</a></p>',
      }));
    }
  }
  db.prepare(`UPDATE users SET role=? WHERE user_id=?`).run(r, id);
  res.redirect('/users');
});

app.post('/users/:id/reset', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body;
  if (!password || password.length < 8) return res.redirect('/users');
  db.prepare(`UPDATE users SET password_hash=? WHERE user_id=?`)
    .run(bcrypt.hashSync(password, 12), id);
  res.redirect('/users');
});

app.post('/users/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === res.locals.user.user_id) return res.redirect('/users');
  const admins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin'`).get().c;
  const target = db.prepare(`SELECT role FROM users WHERE user_id=?`).get(id);
  if (target && target.role === 'admin' && admins <= 1) return res.redirect('/users');
  db.prepare(`UPDATE users SET deleted_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(id);
  res.redirect('/users');
});

// ---------- auth pages ----------
function authPage(title, body, flash) {
  return layout({
    title, body, bare: true, flash,
    active: null, user: null,
  });
}

app.get('/setup', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount > 0) return res.redirect('/login');
  res.send(authPage('Create the first admin account', `
    <form class="form auth-form" method="post" action="/setup">
      <p class="muted">Welcome! Create an admin account to lock down this church manager.</p>
      <label class="wide">Display name<input name="display_name" placeholder="e.g. Pastor James"></label>
      <label class="wide">Username<input name="username" required autofocus></label>
      <label class="wide">Password<input type="password" name="password" required minlength="8"></label>
      <label class="wide">Confirm password<input type="password" name="password2" required></label>
      <div class="actions"><button type="submit">Create account</button></div>
    </form>
  `));
});

app.post('/setup', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount > 0) return res.redirect('/login');
  const { username, password, password2, display_name } = req.body;
  if (!username || !password || password.length < 8 || password !== password2) {
    return res.status(400).send(authPage('Create the first admin account',
      '<p class="form">Check the form: username required, password ≥ 8 chars, both passwords must match. <a href="/setup">Try again</a>.</p>'));
  }
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`
  ).run(username.trim(), hash, (display_name || '').trim() || null);
  req.session.userId = info.lastInsertRowid;
  res.redirect('/');
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const error = req.query.e === '1' ? 'Wrong username or password.' : null;
  res.send(authPage('Sign in', `
    <form class="form auth-form" method="post" action="/login">
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label class="wide">Username<input name="username" required autofocus></label>
      <label class="wide">Password<input type="password" name="password" required></label>
      <div class="actions"><button type="submit">Sign in</button></div>
    </form>
  `));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare(
    `SELECT user_id, password_hash FROM users WHERE username = ? AND deleted_at IS NULL`
  ).get((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.redirect('/login?e=1');
  }
  req.session.userId = user.user_id;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Church Manager running at http://localhost:${PORT}`);
});
