const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const SqliteStore = require('better-sqlite3-session-store')(session);
const { db, DB_PATH, RESTORE_PENDING } = require('./lib/db');
const {
  givingYears, safeYear, financeYtd, givingByMember,
  memberGivingForYear: financeMemberGiving,
} = require('./lib/finance');
const memberGivingForYear = (memberId, year) => financeMemberGiving(db, memberId, year);

const PORT = process.env.PORT || 3000;
const CHURCH_NAME = process.env.CHURCH_NAME || 'Dunwell Methodist';
const PUBLIC_URL  = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// ---------- backups ----------
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 12);
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (_) {}
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^church-\d+\.db$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, mtime: st.mtime }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) { return []; }
}
async function createBackup() {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const name = `church-${stamp}.db`;
  const full = path.join(BACKUP_DIR, name);
  await db.backup(full);
  for (const old of listBackups().slice(BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch (_) {}
  }
  await uploadBackupOffsite(full, name);
  return name;
}
// Off-site copy: if BACKUP_UPLOAD_URL is set (e.g. a presigned S3/Backblaze PUT
// URL), upload the backup there. No-op when unset; never throws (logs instead).
async function uploadBackupOffsite(filePath, name) {
  const base = process.env.BACKUP_UPLOAD_URL;
  if (!base) return false;
  try {
    const url = base.includes('?') ? base : base.replace(/\/$/, '') + '/' + encodeURIComponent(name);
    const body = fs.readFileSync(filePath);
    const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`Off-site backup uploaded: ${name}`);
    return true;
  } catch (e) {
    console.error('Off-site backup upload failed:', e.message);
    return false;
  }
}
// Schedule automatic daily backups only when running as a server (not under tests).
if (require.main === module) {
  const t1 = setTimeout(() => { createBackup().catch((e) => console.error('backup failed:', e.message)); }, 60 * 1000);
  const t2 = setInterval(() => { createBackup().catch((e) => console.error('backup failed:', e.message)); }, 24 * 60 * 60 * 1000);
  if (t1.unref) t1.unref();
  if (t2.unref) t2.unref();
}

// Migrations for older databases.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    display_name  TEXT,
    role          TEXT    NOT NULL DEFAULT 'admin'
                  CHECK (role IN ('admin','editor','viewer')),
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
addColumnIfMissing('members', 'day_born',          `day_born TEXT`);
addColumnIfMissing('members', 'deleted_at',        `deleted_at TEXT`);
addColumnIfMissing('users',   'deleted_at',        `deleted_at TEXT`);
addColumnIfMissing('ministries', 'org_id',         `org_id INTEGER REFERENCES organizations(org_id)`);
addColumnIfMissing('expenses', 'paid_to',          `paid_to TEXT`);
addColumnIfMissing('expenses', 'payment_method',   `payment_method TEXT`);
addColumnIfMissing('expenses', 'approved_by',      `approved_by INTEGER REFERENCES users(user_id)`);
addColumnIfMissing('expenses', 'receipt_attached', `receipt_attached INTEGER NOT NULL DEFAULT 0`);
addColumnIfMissing('expenses', 'reference_number', `reference_number TEXT`);
addColumnIfMissing('expenses', 'expense_cat_id',   `expense_cat_id INTEGER REFERENCES expense_categories(expense_cat_id)`);
addColumnIfMissing('expenses', 'notes',            `notes TEXT`);
addColumnIfMissing('members', 'preferred_channel',`preferred_channel TEXT NOT NULL DEFAULT 'none'`);
addColumnIfMissing('members', 'unsubscribe_token',`unsubscribe_token TEXT`);
addColumnIfMissing('events',  'checkin_token',    `checkin_token TEXT`);
addColumnIfMissing('members', 'photo_filename',   `photo_filename TEXT`);
addColumnIfMissing('members', 'emergency_contact_name',     `emergency_contact_name TEXT`);
addColumnIfMissing('members', 'emergency_contact_phone',    `emergency_contact_phone TEXT`);
addColumnIfMissing('members', 'emergency_contact_relation', `emergency_contact_relation TEXT`);

// Server-side error log (captured by the global error handler) for visibility.
db.exec(`CREATE TABLE IF NOT EXISTS error_log (
  error_id    INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  method      TEXT,
  path        TEXT,
  message     TEXT,
  stack       TEXT,
  user_id     INTEGER
);`);

// Persistent app state for scheduled jobs (last birthday run, etc.).
db.exec(`CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);`);

// Per-member tithes — distinct from general offerings (services) and
// special offerings, lets us track an individual's giving over time.
db.exec(`CREATE TABLE IF NOT EXISTS tithes (
  tithe_id     INTEGER PRIMARY KEY,
  member_id    INTEGER NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
  amount       REAL NOT NULL CHECK (amount > 0),
  tithe_date   TEXT NOT NULL,
  method       TEXT,
  reference    TEXT,
  notes        TEXT,
  recorded_by  INTEGER REFERENCES users(user_id),
  deleted_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tithes_member ON tithes(member_id);
CREATE INDEX IF NOT EXISTS idx_tithes_date   ON tithes(tithe_date);`);

// Event RSVPs — a member's intended response to an event (going / maybe / no).
db.exec(`CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id     INTEGER NOT NULL REFERENCES events(event_id)   ON DELETE CASCADE,
  member_id    INTEGER NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
  response     TEXT NOT NULL DEFAULT 'going' CHECK (response IN ('going','maybe','no')),
  responded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_rsvps_event ON event_rsvps(event_id);`);
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_external_id ON members(external_id) WHERE external_id IS NOT NULL`); } catch (_) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_unsub ON members(unsubscribe_token) WHERE unsubscribe_token IS NOT NULL`); } catch (_) {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_checkin ON events(checkin_token) WHERE checkin_token IS NOT NULL`); } catch (_) {}
// Backfill tokens for every existing member and event.
db.prepare(`UPDATE members SET unsubscribe_token = lower(hex(randomblob(16))) WHERE unsubscribe_token IS NULL`).run();
db.prepare(`UPDATE events  SET checkin_token     = lower(hex(randomblob(16))) WHERE checkin_token     IS NULL`).run();

// Inventory: simple register of physical items the church owns/tracks.
db.exec(`CREATE TABLE IF NOT EXISTS inventory_items (
  item_id     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 0,
  category    TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_inventory_active ON inventory_items(deleted_at);`);

// Preaching plan: who preaches on which date. The preacher may be a linked
// member (member_id) or a guest with their own contact details, so reminders
// can reach either.
db.exec(`CREATE TABLE IF NOT EXISTS preaching_plan (
  plan_id          INTEGER PRIMARY KEY,
  preach_date      TEXT NOT NULL,
  service_label    TEXT,
  member_id        INTEGER REFERENCES members(member_id),
  preacher_name    TEXT,
  preacher_phone   TEXT,
  preacher_email   TEXT,
  topic            TEXT,
  scripture        TEXT,
  notes            TEXT,
  reminder_sent_at TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_preaching_date ON preaching_plan(preach_date);`);

// Finance schema (services, harvests, day-born splits, special offerings, pledges, lookups).
db.exec(`
  CREATE TABLE IF NOT EXISTS service_types (
    service_type_id INTEGER PRIMARY KEY,
    type_name       TEXT NOT NULL UNIQUE,
    description     TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS services (
    service_id      INTEGER PRIMARY KEY,
    service_type_id INTEGER NOT NULL REFERENCES service_types(service_type_id),
    service_date    TEXT NOT NULL,
    total_amount    REAL NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    recorded_by     INTEGER REFERENCES users(user_id),
    notes           TEXT,
    deleted_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_services_date ON services(service_date);

  CREATE TABLE IF NOT EXISTS harvests (
    harvest_id      INTEGER PRIMARY KEY,
    harvest_type    TEXT NOT NULL CHECK (harvest_type IN ('Organizational','End-of-Year')),
    harvest_name    TEXT NOT NULL,
    harvest_year    INTEGER NOT NULL,
    harvest_date    TEXT,
    theme           TEXT,
    org_id          INTEGER REFERENCES organizations(org_id),
    total_collected REAL NOT NULL DEFAULT 0 CHECK (total_collected >= 0),
    recorded_by     INTEGER REFERENCES users(user_id),
    notes           TEXT,
    deleted_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_harvests_year ON harvests(harvest_year);

  CREATE TABLE IF NOT EXISTS day_born_splits (
    split_id    INTEGER PRIMARY KEY,
    service_id  INTEGER REFERENCES services(service_id)  ON DELETE CASCADE,
    harvest_id  INTEGER REFERENCES harvests(harvest_id)  ON DELETE CASCADE,
    day_born    TEXT NOT NULL CHECK (day_born IN ('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')),
    amount      REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
    head_count  INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((service_id IS NOT NULL AND harvest_id IS NULL)
        OR (service_id IS NULL     AND harvest_id IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_splits_service ON day_born_splits(service_id);
  CREATE INDEX IF NOT EXISTS idx_splits_harvest ON day_born_splits(harvest_id);

  CREATE TABLE IF NOT EXISTS special_categories (
    special_cat_id INTEGER PRIMARY KEY,
    category_name  TEXT NOT NULL UNIQUE,
    description    TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS special_offerings (
    special_id        INTEGER PRIMARY KEY,
    special_cat_id    INTEGER NOT NULL REFERENCES special_categories(special_cat_id),
    offering_date     TEXT NOT NULL,
    donor_id          INTEGER REFERENCES members(member_id),
    donor_name_manual TEXT,
    amount            REAL NOT NULL CHECK (amount > 0),
    purpose           TEXT,
    receipt_number    TEXT,
    recorded_by       INTEGER REFERENCES users(user_id),
    notes             TEXT,
    deleted_at        TEXT,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_special_date ON special_offerings(offering_date);

  CREATE TABLE IF NOT EXISTS pledges (
    pledge_id      INTEGER PRIMARY KEY,
    member_id      INTEGER NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
    harvest_id     INTEGER NOT NULL REFERENCES harvests(harvest_id) ON DELETE CASCADE,
    pledged_amount REAL NOT NULL CHECK (pledged_amount > 0),
    paid_amount    REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    pledge_date    TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'Pending'
                   CHECK (status IN ('Pending','Partial','Fulfilled','Cancelled')),
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pledge_payments (
    payment_id     INTEGER PRIMARY KEY,
    pledge_id      INTEGER NOT NULL REFERENCES pledges(pledge_id) ON DELETE CASCADE,
    amount         REAL NOT NULL CHECK (amount > 0),
    paid_on        TEXT NOT NULL,
    receipt_number TEXT NOT NULL UNIQUE,
    recorded_by    INTEGER REFERENCES users(user_id),
    sent_at        TEXT,
    sent_channel   TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_pledge_payments_pledge ON pledge_payments(pledge_id);

  CREATE TABLE IF NOT EXISTS expense_categories (
    expense_cat_id INTEGER PRIMARY KEY,
    category_name  TEXT NOT NULL UNIQUE,
    description    TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS broadcasts (
    broadcast_id     INTEGER PRIMARY KEY,
    channel          TEXT NOT NULL CHECK (channel IN ('sms','email','both')),
    audience_label   TEXT NOT NULL,
    org_id           INTEGER REFERENCES organizations(org_id),
    subject          TEXT,
    body             TEXT NOT NULL,
    total_recipients INTEGER NOT NULL DEFAULT 0,
    successful_sends INTEGER NOT NULL DEFAULT 0,
    failed_sends     INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sending','sent','failed','dry_run')),
    sent_by          INTEGER REFERENCES users(user_id),
    sent_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS broadcast_recipients (
    recipient_id INTEGER PRIMARY KEY,
    broadcast_id INTEGER NOT NULL REFERENCES broadcasts(broadcast_id) ON DELETE CASCADE,
    member_id    INTEGER REFERENCES members(member_id),
    channel      TEXT NOT NULL,
    destination  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','failed','skipped')),
    error        TEXT,
    sent_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast ON broadcast_recipients(broadcast_id);
`);

// Seed default lookup values (idempotent).
const insertServiceType = db.prepare(`INSERT OR IGNORE INTO service_types (type_name, description) VALUES (?, ?)`);
[
  ['Sunday Service',    'Regular Sunday worship service'],
  ['Wednesday Service', 'Midweek service'],
  ['Wedding Service',   'Wedding ceremony offering'],
  ['Funeral Service',   'Funeral / memorial service offering'],
  ['Other',             'Other service offering'],
].forEach(([n, d]) => insertServiceType.run(n, d));

const insertSpecialCat = db.prepare(`INSERT OR IGNORE INTO special_categories (category_name, description) VALUES (?, ?)`);
[
  ['Building Fund',          'Church construction / renovation'],
  ['Mission / Outreach',     'Evangelism and outreach work'],
  ['Thanksgiving',           'Thanksgiving offerings'],
  ["Pastor's Appreciation",  'Pastor appreciation offering'],
  ['Welfare / Benevolence',  'Support for members in need'],
  ['Convention / Camp',      'Conventions, camps, conferences'],
  ['Vow / Pledge',           'Personal vows and pledges'],
].forEach(([n, d]) => insertSpecialCat.run(n, d));

const insertExpenseCat = db.prepare(`INSERT OR IGNORE INTO expense_categories (category_name, description) VALUES (?, ?)`);
[
  ['Utilities',       'Electricity, water, internet'],
  ['Salaries',        'Pastor and staff salaries'],
  ['Maintenance',     'Building and equipment upkeep'],
  ['Office Supplies', 'Stationery, printing'],
  ['Outreach',        'Mission and outreach expenses'],
  ['Welfare',         'Support to members'],
  ['Events',          'Convention, camp, special events'],
].forEach(([n, d]) => insertExpenseCat.run(n, d));

// Seed the default organizations (idempotent).
const DEFAULT_ORGS = [
  "Church Choir",
  "Singing Band",
  "Gospel Band",
  "Guild",
  "Boy's Brigade",
  "Girl's Brigade",
  "Men's Fellowship",
  "Women's Fellowship",
  "Sunday School",
  "Youth Ministry",
];
const insertOrg = db.prepare(`INSERT OR IGNORE INTO organizations (name) VALUES (?)`);
for (const n of DEFAULT_ORGS) insertOrg.run(n);

// One-time migrations log (so destructive changes only run once).
db.exec(`CREATE TABLE IF NOT EXISTS app_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
function runOnce(id, fn) {
  const seen = db.prepare(`SELECT 1 FROM app_migrations WHERE migration_id = ?`).get(id);
  if (seen) return;
  try { fn(); db.prepare(`INSERT INTO app_migrations (migration_id) VALUES (?)`).run(id); }
  catch (e) { console.error(`Migration ${id} failed:`, e.message); }
}
runOnce('wipe_old_contributions_v1', () => {
  // The new Finance module replaces the legacy `contributions` table for new entries.
  db.exec(`DELETE FROM contributions`);
});

// Widen the users.role CHECK to add an 'editor' role (rebuild — SQLite can't ALTER a CHECK).
runOnce('users_role_add_editor_v1', () => {
  const allowsEditor = (() => {
    try { db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get(); }
    catch (_) { return false; }
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get();
    return row && /editor/.test(row.sql);
  })();
  if (allowsEditor) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          user_id       INTEGER PRIMARY KEY,
          username      TEXT    NOT NULL UNIQUE,
          password_hash TEXT    NOT NULL,
          display_name  TEXT,
          role          TEXT    NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer')),
          created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
          deleted_at    TEXT
        );
        INSERT INTO users_new (user_id, username, password_hash, display_name, role, created_at, deleted_at)
          SELECT user_id, username, password_hash, display_name, role, created_at, deleted_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    })();
  } finally {
    // Always restore FK enforcement, even if the rebuild throws.
    db.pragma('foreign_keys = ON');
  }
});

// Households are no longer used — clean them up if anything is left.
try {
  db.exec(`UPDATE members SET household_id = NULL WHERE household_id IS NOT NULL`);
  db.exec(`DELETE FROM households`);
} catch (_) {}

const app = express();
// Trust the reverse proxy in production so secure cookies work behind Fly/Render/etc.
app.set('trust proxy', 1);

// Baseline security headers (no external deps). CSP allows inline scripts/styles
// because the app renders them inline; it still blocks external sources, framing,
// plugins, and constrains form submission targets.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "form-action 'self'",
  ].join('; '));
  next();
});
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

// CSRF: a synchronizer token per session, auto-injected into every POST form
// rendered as HTML, and validated on every state-changing request.
app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  const token = req.session.csrfToken;
  res.locals.csrfToken = token;
  const field = `<input type="hidden" name="_csrf" value="${token}">`;
  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (typeof body === 'string' && body.indexOf('<form') !== -1) {
      body = body.replace(/(<form\b[^>]*\bmethod=["']post["'][^>]*>)/gi, `$1${field}`);
    }
    return origSend(body);
  };
  next();
});

function csrfValid(req) {
  const t = req.body && req.body._csrf;
  return !!t && t === req.session.csrfToken;
}
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/webhooks/')) return next();   // external, separately verified
  if (req.path.startsWith('/checkin/')) return next();    // public QR check-in (no session)
  if (req.path.startsWith('/rsvp/')) return next();       // public RSVP (no session)
  if (req.is('multipart/form-data')) return next();       // body parsed later; checked in-route
  if (csrfValid(req)) return next();
  return res.status(403).send(layout({
    title: 'Security check failed', active: null, user: res.locals.user,
    body: '<p>This form was stale or your session expired. Please go back and try again.</p>'
        + '<p><a href="/">Back to dashboard</a></p>',
  }));
});

// One-shot flash messages stored on the session.
function flash(req, msg, type = 'error') { req.session.flash = { msg, type }; }

app.use((req, res, next) => {
  if (req.session.flash) {
    res.locals.flash = req.session.flash.msg;
    res.locals.flashType = req.session.flash.type;
    delete req.session.flash;
  }
  next();
});

// Render helper that auto-injects the current user (and any flash) into the layout.
app.use((req, res, next) => {
  res.page = (opts) => res.send(layout({
    ...opts,
    user: opts.user ?? res.locals.user,
    flash: opts.flash ?? res.locals.flash,
    flashType: opts.flashType ?? res.locals.flashType,
  }));
  next();
});

// Auth gate: redirect to /setup on first run, /login otherwise.
app.use((req, res, next) => {
  if (req.path.startsWith('/static/')) return next();
  if (req.path.startsWith('/u/')) return next();        // public unsubscribe pages
  if (req.path.startsWith('/webhooks/')) return next(); // inbound webhooks (Arkesel STOP)
  if (req.path.startsWith('/checkin/')) return next();  // public QR check-in
  if (req.path.startsWith('/rsvp/')) return next();     // public RSVP
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
  res.locals.role = res.locals.user.role;
  res.locals.isOwner = res.locals.user.role === 'admin';
  // isAdmin here means "can create/edit content" — admins and editors. Owner-only
  // areas (users, roles, backups, settings) use requireOwner instead.
  res.locals.isAdmin = res.locals.user.role === 'admin' || res.locals.user.role === 'editor';
  // Adding/deleting accounts and resetting passwords is reserved for the main administrator.
  res.locals.isUserManager = res.locals.isOwner
    && String(res.locals.user.username || '').toLowerCase() === 'dunwelladmin';
  next();
});

function requireOwner(req, res, next) {
  if (res.locals.isOwner) return next();
  res.status(403).send(layout({
    title: 'Administrators only', user: res.locals.user, active: null,
    body: '<p>This area is reserved for administrators. Editors can manage records but not'
         + ' users, backups or settings.</p><p><a href="/">Back to dashboard</a></p>',
  }));
}

function requireAdmin(req, res, next) {
  if (res.locals.isAdmin) return next();
  res.status(403).send(layout({
    title: 'Read-only access', user: res.locals.user, active: null,
    body: '<p>Your account has read-only access. Ask an admin to make this change.</p>'
         + '<p><a href="/">Back to dashboard</a></p>',
  }));
}

function requireUserManager(req, res, next) {
  if (res.locals.isUserManager) return next();
  res.status(403).send(layout({
    title: 'Not allowed', user: res.locals.user, active: null,
    body: '<p>Only the main administrator (<strong>dunwelladmin</strong>) can add or delete user accounts and reset passwords.</p>'
         + '<p><a href="/users">Back to users</a></p>',
  }));
}

// ---------- helpers ----------
const {
  MONTHS, DAYS_OF_WEEK,
  esc, fmtMoney, fmtOutstanding, fmtDate, todayISO, initials,
  dobMonth, dobDay, fmtDobShort, parseDob, fmtPreachDate,
  isValidDate, isMoneyNonNeg, isMoneyPositive, isEmailish, isPhoneish,
  fmtBytes, isSqliteBuffer, looksLikeImage,
} = require('./lib/format');

const NAV = [
  ['/',                'Dashboard',      '▥'],
  ['/members',         'Members',        '👥'],
  ['/attendance',      'Attendance',     '✓'],
  ['/finance',         'Finance',        '₵'],
  ['/bible-classes',   'Bible Classes',  '📖'],
  ['/organizations',   'Organizations',  '♫'],
  ['/inventory',       'Inventory',      '📦'],
  ['/events',          'Events',         '📅'],
  ['/preaching',       'Preaching Plan', '🎤'],
  ['/communications',  'Communications', '✉'],
  ['/reports',         'Reports',        '📊'],
  ['/users',           'Users & Roles',  '🔑', 'admin'],
  ['/backups',         'Backups',        '💾', 'admin'],
  ['/settings',        'Settings',       '⚙'],
];

// ---------- Photo storage (member photos saved next to the DB) ----------
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(path.dirname(DB_PATH), 'photos');
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch (_) {}
const multer = require('multer');
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp|gif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('Only JPG / PNG / WebP / GIF images are allowed'), ok);
  },
});
const EXT_FROM_MIME = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/png':  'png', 'image/webp': 'webp', 'image/gif': 'gif',
};
// Uploader for restoring a database backup (.db file).
const dbUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
// ---------- SMS (Arkesel) + Email (SMTP) helpers ----------
const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const ARKESEL_SENDER  = process.env.ARKESEL_SENDER  || 'DUNWELL';
const ARKESEL_URL     = 'https://sms.arkesel.com/api/v2/sms/send';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `Church <${SMTP_USER}>` : '');

let mailTransporter = null;
function getMailer() {
  if (mailTransporter || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return mailTransporter;
  const nodemailer = require('nodemailer');
  mailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return mailTransporter;
}

// Normalize Ghana phone numbers to E.164 (+233XXXXXXXXX).
function normalizePhoneGH(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0') && s.length === 10) s = '+233' + s.slice(1);
  else if (/^\d{9}$/.test(s)) s = '+233' + s;
  else if (/^233\d{9}$/.test(s)) s = '+' + s;
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

async function sendSmsBatch(recipients, message) {
  if (!ARKESEL_API_KEY) return { ok: false, dryRun: true, message: 'ARKESEL_API_KEY not set; dry run.' };
  if (!recipients.length) return { ok: true, sent: 0 };
  const res = await fetch(ARKESEL_URL, {
    method: 'POST',
    headers: { 'api-key': ARKESEL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: ARKESEL_SENDER, message, recipients,
    }),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { ok: res.ok && data && data.code === 'ok',
           status: res.status, response: data, sent: recipients.length };
}

// ---------- Birthday automation ----------
const BIRTHDAY_HOUR = Number(process.env.BIRTHDAY_HOUR || 7); // 24h, Ghana time = UTC
const BIRTHDAY_TEMPLATE = process.env.BIRTHDAY_TEMPLATE ||
  'Happy birthday, {first_name}! May God bless your year ahead. — {church_name}';

function getState(key) {
  const row = db.prepare(`SELECT value FROM app_state WHERE key=?`).get(key);
  return row ? row.value : null;
}
function setState(key, value) {
  db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

function todaysBirthdayMembers() {
  // Members whose date_of_birth has today's month-day, active, contactable by SMS.
  return db.prepare(`
    SELECT member_id, first_name, last_name, mobile_phone, preferred_channel
    FROM members
    WHERE deleted_at IS NULL
      AND date_of_birth IS NOT NULL
      AND strftime('%m-%d', date_of_birth) = strftime('%m-%d', 'now')
      AND mobile_phone IS NOT NULL
      AND preferred_channel IN ('either', 'sms_only')
    ORDER BY last_name
  `).all();
}

function renderBirthdayMessage(m) {
  return BIRTHDAY_TEMPLATE
    .replace(/\{first_name\}/g, m.first_name || '')
    .replace(/\{last_name\}/g,  m.last_name  || '')
    .replace(/\{church_name\}/g, CHURCH_NAME);
}

async function sendBirthdayBatch({ manual = false, userId = null } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!manual && getState('last_birthday_send') === today) return { ok: true, skipped: 'already_ran_today' };

  const recipients = todaysBirthdayMembers();
  if (!recipients.length) {
    setState('last_birthday_send', today);
    return { ok: true, sent: 0, message: 'No birthdays today.' };
  }

  // Use the broadcast tables so it shows up in history alongside manual sends.
  const bres = db.prepare(`
    INSERT INTO broadcasts (channel, audience_label, subject, body, total_recipients, status, sent_by)
    VALUES ('sms', ?, NULL, ?, ?, 'sending', ?)`)
    .run(`Birthdays ${today}`, `[per-recipient template: "${BIRTHDAY_TEMPLATE}"]`, recipients.length, userId);
  const broadcastId = bres.lastInsertRowid;

  const insRecip = db.prepare(
    `INSERT INTO broadcast_recipients (broadcast_id, member_id, channel, destination, status, error, sent_at)
     VALUES (?, ?, 'sms', ?, ?, ?, ?)`
  );
  let sent = 0, failed = 0, skipped = 0;
  for (const m of recipients) {
    const phone = normalizePhoneGH(m.mobile_phone);
    if (!phone) { skipped++; insRecip.run(broadcastId, m.member_id, m.mobile_phone || '', 'skipped', 'invalid phone', null); continue; }
    const msg = renderBirthdayMessage(m);
    try {
      const r = await sendSmsBatch([phone], msg);
      if (r.dryRun) {
        insRecip.run(broadcastId, m.member_id, phone, 'pending', 'dry run', null);
      } else if (r.ok) {
        sent++;
        insRecip.run(broadcastId, m.member_id, phone, 'sent', null, new Date().toISOString());
      } else {
        failed++;
        insRecip.run(broadcastId, m.member_id, phone, 'failed', JSON.stringify(r.response || r), null);
      }
    } catch (e) {
      failed++;
      insRecip.run(broadcastId, m.member_id, phone, 'failed', e.message, null);
    }
  }
  const dryRun = !ARKESEL_API_KEY;
  const finalStatus = dryRun ? 'dry_run' : (sent === 0 && failed > 0 ? 'failed' : 'sent');
  db.prepare(`UPDATE broadcasts SET successful_sends=?, failed_sends=?, status=? WHERE broadcast_id=?`)
    .run(sent, failed, finalStatus, broadcastId);
  setState('last_birthday_send', today);
  logActivity('announcement',
    `Sent ${sent} birthday message(s) (${recipients.length} eligible)`,
    `/communications/broadcasts/${broadcastId}`, userId);
  return { ok: true, sent, failed, skipped, recipients: recipients.length, broadcastId };
}

// Schedule: check every 15 minutes; fire after BIRTHDAY_HOUR if not yet run today.
function tickBirthdayScheduler() {
  const now = new Date();
  if (now.getUTCHours() < BIRTHDAY_HOUR) return;
  const today = now.toISOString().slice(0, 10);
  if (getState('last_birthday_send') === today) return;
  sendBirthdayBatch({ manual: false }).catch((e) => console.error('birthday job failed:', e.message));
}
setInterval(tickBirthdayScheduler, 15 * 60 * 1000);
// Also run once at startup so the first deploy of the day doesn't miss it.
setTimeout(tickBirthdayScheduler, 30 * 1000);

// Send one personalized email per recipient. Each gets its own unsubscribe link.
async function sendEmailEach(recipients, subject, body, opts = {}) {
  const mailer = getMailer();
  if (!mailer) return { ok: false, dryRun: true, total: recipients.length };
  if (!recipients.length) return { ok: true, sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  const errors = [];
  for (const r of recipients) {
    const footer = (opts.withFooter !== false) && r.token
      ? (PUBLIC_URL
          ? `\n\n— ${CHURCH_NAME}\nTo stop receiving these messages, visit ${PUBLIC_URL}/u/${r.token}`
          : `\n\n— ${CHURCH_NAME}\nTo stop receiving messages, contact the church office.`)
      : '';
    try {
      await mailer.sendMail({
        from: SMTP_FROM, to: r.addr, subject, text: body + footer,
      });
      sent++;
    } catch (e) {
      failed++; errors.push(e.message);
    }
  }
  return { ok: failed === 0, sent, failed, errors };
}

// Resolve a preaching appointment's preacher contact: a linked member's details
// take precedence, otherwise the guest fields stored on the row.
function preacherContact(plan) {
  if (plan.member_id) {
    const m = db.prepare(
      `SELECT first_name, last_name, mobile_phone, email, unsubscribe_token
       FROM members WHERE member_id=? AND deleted_at IS NULL`
    ).get(plan.member_id);
    if (m) return {
      name: `${m.first_name} ${m.last_name}`.trim(),
      first: m.first_name || '',
      phone: m.mobile_phone, email: m.email, token: m.unsubscribe_token,
    };
  }
  const name = (plan.preacher_name || '').trim();
  return { name, first: name.split(/\s+/)[0] || name, phone: plan.preacher_phone, email: plan.preacher_email, token: null };
}

// Send a "you're preaching on X" reminder to the appointment's preacher via
// SMS (if a phone is on file) and/or email (if an address is on file).
async function sendPreachingReminder(plan, userId) {
  const c = preacherContact(plan);
  if (!c.name && !c.phone && !c.email) return { ok: false, reason: 'no_contact' };
  const when = fmtPreachDate(plan.preach_date);
  const where = plan.service_label ? ` (${plan.service_label})` : '';
  const topic = plan.topic ? ` Topic: ${plan.topic}.` : '';
  const msg = `Hello ${c.first || 'Preacher'}, a reminder that you are scheduled to preach on ${when}${where}.${topic} — ${CHURCH_NAME}`;

  const phone = normalizePhoneGH(c.phone);
  let sms = null, email = null;
  if (phone) {
    try { sms = await sendSmsBatch([phone], msg); }
    catch (e) { sms = { ok: false, error: e.message }; }
  }
  if (c.email) {
    try {
      email = await sendEmailEach(
        [{ addr: c.email, token: c.token }],
        `Preaching reminder — ${when}`, msg, { withFooter: false });
    } catch (e) { email = { ok: false, error: e.message }; }
  }
  db.prepare(`UPDATE preaching_plan SET reminder_sent_at=CURRENT_TIMESTAMP WHERE plan_id=?`).run(plan.plan_id);
  logActivity('preaching_reminder',
    `Sent preaching reminder to ${c.name || 'preacher'} for ${when}`,
    '/preaching', userId);
  const dryRun = (sms && sms.dryRun) || (email && email.dryRun);
  return {
    ok: true, name: c.name, hadPhone: !!phone, hadEmail: !!c.email,
    smsOk: sms ? (sms.ok || sms.dryRun) : null,
    emailOk: email ? (email.ok || email.dryRun) : null,
    dryRun,
  };
}


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

// ---------- shared view/component builders (see lib/views.js) ----------
const {
  flashHtml, pageHero, heroStat, statsRow, filterCard, listCard, table, pager,
} = require('./lib/views');

const { layout, authPage } = require('./lib/shell').createShell({
  CHURCH_NAME, NAV, esc, initials, flashHtml, scriptureOfDay, listBackups,
});


// ---------- routes: dashboard ----------
const { sparkline, miniSpark, donut, lastMonths, seriesOn } = require('./lib/charts');

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
    SELECT COALESCE((SELECT SUM(total_amount) FROM services
      WHERE deleted_at IS NULL AND substr(service_date,1,7)=strftime('%Y-%m','now')),0)
         + COALESCE((SELECT SUM(amount) FROM special_offerings
      WHERE deleted_at IS NULL AND substr(offering_date,1,7)=strftime('%Y-%m','now')),0) AS t
  `).get().t;
  const offeringsLastMonth = db.prepare(`
    SELECT COALESCE((SELECT SUM(total_amount) FROM services
      WHERE deleted_at IS NULL AND substr(service_date,1,7)=strftime('%Y-%m', date('now','start of month','-1 day'))),0)
         + COALESCE((SELECT SUM(amount) FROM special_offerings
      WHERE deleted_at IS NULL AND substr(offering_date,1,7)=strftime('%Y-%m', date('now','start of month','-1 day'))),0) AS t
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
    ORDER BY occurred_at DESC LIMIT 5
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
  const servicesMonth = db.prepare(
    `SELECT COALESCE(SUM(total_amount),0) t FROM services
       WHERE deleted_at IS NULL AND substr(service_date,1,7)=strftime('%Y-%m','now')`
  ).get().t;
  const harvestsMonth = db.prepare(
    `SELECT COALESCE(SUM(total_collected),0) t FROM harvests
       WHERE deleted_at IS NULL AND harvest_year=strftime('%Y','now')`
  ).get().t;
  const specialByCat = db.prepare(`
    SELECT sc.category_name AS name, COALESCE(SUM(sp.amount),0) t
    FROM special_categories sc
    LEFT JOIN special_offerings sp
      ON sp.special_cat_id=sc.special_cat_id
      AND sp.deleted_at IS NULL
      AND substr(sp.offering_date,1,7)=strftime('%Y-%m','now')
    GROUP BY sc.special_cat_id
    HAVING t > 0
    ORDER BY t DESC`).all();

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

  // ----- monthly series for stat-card sparklines + giving chart (last 6 months) -----
  const months = lastMonths(6);
  const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleString('en', { month: 'short' });
  const memberSeries = seriesOn(months, db.prepare(
    `SELECT substr(join_date,1,7) ym, COUNT(*) v FROM members
       WHERE join_date >= date('now','start of month','-5 months') GROUP BY ym`).all());
  const visitorSeries = seriesOn(months, db.prepare(
    `SELECT substr(join_date,1,7) ym, COUNT(*) v FROM members
       WHERE membership_status='visitor' AND join_date >= date('now','start of month','-5 months') GROUP BY ym`).all());
  const svcSeries = seriesOn(months, db.prepare(
    `SELECT substr(service_date,1,7) ym, SUM(total_amount) v FROM services
       WHERE deleted_at IS NULL AND service_date >= date('now','start of month','-5 months') GROUP BY ym`).all());
  const specSeries = seriesOn(months, db.prepare(
    `SELECT substr(offering_date,1,7) ym, SUM(amount) v FROM special_offerings
       WHERE deleted_at IS NULL AND offering_date >= date('now','start of month','-5 months') GROUP BY ym`).all());
  const givingSeries = months.map((_, i) => svcSeries[i] + specSeries[i]);
  const attendanceSpark = trendPts.map((p) => p.value);

  // ----- giving overview breakdown (this month) -----
  const specialTotal = specialByCat.reduce((s, x) => s + x.t, 0);
  const givingTotal = servicesMonth + harvestsMonth + specialTotal;
  const givingLegend = [
    { label: 'Service Offerings', value: servicesMonth, color: 'var(--gold)' },
    { label: 'Harvests', value: harvestsMonth, color: 'var(--purple)' },
    { label: 'Special Offerings', value: specialTotal, color: 'var(--green)' },
  ];

  // ----- attendance donut (by service type, last 30 days) -----
  const attByType = db.prepare(`
    SELECT e.event_type AS k, COUNT(a.member_id) AS v
    FROM events e JOIN attendance a USING(event_id)
    WHERE e.starts_at >= date('now','-30 days')
    GROUP BY e.event_type ORDER BY v DESC`).all();
  const typeNames = {
    service: 'Services', prayer: 'Prayer', bible_study: 'Bible Study', outreach: 'Outreach',
    youth: 'Youth', wedding: 'Weddings', funeral: 'Funerals', baptism: 'Baptisms', other: 'Other',
  };
  const donutColors = ['var(--purple)', 'var(--gold)', 'var(--green)', 'var(--blue)', 'var(--orange)', '#a78bfa', '#f472b6', '#94a3b8'];
  const attSegments = attByType.map((r, i) => ({ label: typeNames[r.k] || r.k, value: r.v, color: donutColors[i % donutColors.length] }));
  const attTotal = attSegments.reduce((s, x) => s + x.value, 0);
  const attAvg = attByType.length ? Math.round(attTotal / attByType.length) : 0;

  // ----- ministry overview tiles -----
  const ministryCount = db.prepare(`SELECT COUNT(*) c FROM ministries WHERE active=1`).get().c;
  const orgCount = db.prepare(`SELECT COUNT(*) c FROM organizations WHERE active=1`).get().c;
  const volunteerCount = db.prepare(
    `SELECT COUNT(DISTINCT member_id) c FROM ministry_memberships WHERE left_date IS NULL`).get().c;
  const peopleInvolved = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT member_id FROM ministry_memberships WHERE left_date IS NULL
      UNION SELECT member_id FROM organization_memberships)`).get().c;

  const trendDelta = (n) => n == null ? '' :
    `<div class="trend ${n < 0 ? 'down' : ''}">${n >= 0 ? '↑' : '↓'} ${Math.abs(n)}% from last period</div>`;

  const statCard = (cls, icon, label, value, trend, spark, color) => `
    <div class="stat">
      <div class="stat-top">
        <div class="ico ${cls}">${icon}</div>
        <div class="stat-body">
          <div class="label">${label}</div>
          <div class="value">${value}</div>
          ${trend}
        </div>
      </div>
      <div class="spark">${miniSpark(spark, color)}</div>
    </div>`;
  const cards = `
    <div class="stat-grid">
      ${statCard('purple', '👥', 'Total Members', totalMembers.toLocaleString(),
        `<div class="trend">↑ ${newMembersThisMonth} this month</div>`, memberSeries, 'var(--purple)')}
      ${statCard('green', '✓', 'Sunday Attendance', sundayAttendance,
        trendDelta(attendanceDelta), attendanceSpark, 'var(--green)')}
      ${statCard('amber', '₵', 'Offerings This Month', fmtMoney(offeringsThisMonth),
        trendDelta(offeringsDelta), givingSeries, 'var(--gold)')}
      ${statCard('blue', '🚶', 'Visitors This Month', visitorsThisMonth,
        `<div class="trend">↑ ${visitorsThisWeek} new this week</div>`, visitorSeries, 'var(--blue)')}
    </div>`;

  const isAdmin = res.locals.isAdmin;
  const qaLink = (href, icon, label) =>
    `<a class="qa" href="${href}"><span class="ico">${icon}</span> ${label}</a>`;
  const quick = isAdmin ? `
    <details class="quick-drop">
      <summary>⚡ Quick Actions <span class="caret">▾</span></summary>
      <div class="quick-menu">
        ${qaLink('/members/new',       '👤+', 'Add Member')}
        ${qaLink('/events',            '✓',   'Record Attendance')}
        ${qaLink('/finance/new',       '₵',   'Record Offering')}
        ${qaLink('/communications/new','✉',   'Post Announcement')}
        ${qaLink('/events/new',        '📅',  'Add Event')}
        ${qaLink('/reports',           '📊',  'Generate Report')}
      </div>
    </details>` : '';

  const activityIcons = {
    member_added: '👤', attendance_recorded: '✓', contribution_recorded: '₵',
    expense_recorded: '🧾', welfare_opened: '♥', announcement: '✉',
    event_created: '📅', user_added: '🔑',
  };
  const activityCard = `
    <div class="card">
      <details class="collapse-card" open>
        <summary class="card-head">
          <h2>Recent Activities <span class="card-count">${recentActivity.length}</span></h2>
          <span class="caret">▾</span>
        </summary>
        ${recentActivity.length ? `<ul class="list">${recentActivity.map((a) => `
          <li>
            <span class="ico">${activityIcons[a.kind] || '•'}</span>
            <span>${a.link ? `<a href="${esc(a.link)}">${esc(a.description)}</a>` : esc(a.description)}</span>
            <span class="when">${esc(a.occurred_at.slice(5, 16).replace('T', ' '))}</span>
          </li>`).join('')}</ul>
        <a class="view-all" href="/reports">View all →</a>` : '<p class="muted-text">No recent activity yet.</p>'}
      </details>
    </div>`;

  const givingPoints = months.map((ym, i) => ({ label: monthLabel(ym), value: givingSeries[i] }));
  const givingLegendRows = givingLegend.map((g) => {
    const pct = givingTotal > 0 ? Math.round((g.value / givingTotal) * 100) : 0;
    return `<div class="legend-row">
      <span class="legend-dot" style="background:${g.color}"></span>
      <span class="legend-label">${g.label}</span>
      <span class="legend-val">${fmtMoney(g.value)}</span>
      <span class="legend-pct">${pct}%</span>
    </div>`;
  }).join('');
  const givingCard = `
    <div class="card">
      <div class="card-head"><h2>Giving Overview</h2><span class="meta">This month</span></div>
      <div class="big-figure">${fmtMoney(givingTotal)}</div>
      <div class="big-sub">Total giving ${trendDelta(offeringsDelta) || '<span class="trend">this month</span>'}</div>
      ${sparkline(givingPoints)}
      <div class="legend">${givingLegendRows}</div>
    </div>`;

  const attLegendRows = attSegments.map((s) => {
    const pct = attTotal > 0 ? Math.round((s.value / attTotal) * 100) : 0;
    return `<div class="legend-row">
      <span class="legend-dot" style="background:${s.color}"></span>
      <span class="legend-label">${esc(s.label)}</span>
      <span class="legend-pct">${pct}%</span>
      <span class="legend-val">${s.value} ppl</span>
    </div>`;
  }).join('');
  const attendanceCard = `
    <div class="card">
      <div class="card-head"><h2>Attendance Overview</h2><span class="meta">Last 30 days</span></div>
      <div class="donut-wrap">
        ${donut(attSegments, 'Avg / type', attAvg)}
        <div class="legend">${attLegendRows || '<p class="muted-text">No attendance recorded yet.</p>'}</div>
      </div>
    </div>`;

  const ministryTile = (icon, cls, value, label) => `
    <div class="m-tile">
      <div class="ico ${cls}">${icon}</div>
      <div class="m-value">${value}</div>
      <div class="m-label">${label}</div>
    </div>`;
  const ministryCard = `
    <div class="card">
      <div class="card-head"><h2>Ministry Overview</h2><a href="/organizations">View all</a></div>
      <div class="m-grid">
        ${ministryTile('👥', 'purple', ministryCount, 'Ministries')}
        ${ministryTile('🙋', 'green', volunteerCount, 'Volunteers')}
        ${ministryTile('♫', 'amber', orgCount, 'Organizations')}
        ${ministryTile('❤', 'blue', peopleInvolved, 'People Involved')}
      </div>
    </div>`;

  const netBalance = offeringsThisMonth + harvestsMonth - monthExpenses;
  const specialRows = specialByCat.slice(0, 3).map((s) =>
    `<div class="fin-row"><span class="lbl"><span class="dot">✨</span> ${esc(s.name)}</span>
       <span class="val">${fmtMoney(s.t)}</span></div>`).join('');
  const financeCard = `
    <div class="card">
      <div class="card-head"><h2>Finance Summary</h2><span class="meta">This month</span></div>
      <div class="fin-row"><span class="lbl"><span class="dot">₵</span> Service Offerings</span>
        <span class="val">${fmtMoney(servicesMonth)}</span></div>
      <div class="fin-row"><span class="lbl"><span class="dot">🌾</span> Harvests</span>
        <span class="val">${fmtMoney(harvestsMonth)}</span></div>
      ${specialRows}
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
            <div><span class="evt-type">${esc(e.event_type)}</span></div>
            <div><a href="/events/${e.event_id}"><strong>${esc(e.title)}</strong></a></div>
            <div class="meta">${esc(when)} · ${esc(e.location || '')}</div>
          </div>
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
      ${upcomingCard}
      ${givingCard}
      ${activityCard}
      <div class="col-2">${ministryCard}</div>
      ${attendanceCard}
      ${financeCard}
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

function memberErrors(b) {
  if (!b.first_name || !b.first_name.trim()) return 'First name is required.';
  if (!b.last_name || !b.last_name.trim()) return 'Last name is required.';
  if (b.email && !isEmailish(b.email)) return 'Enter a valid email address, or leave it blank.';
  if (b.mobile_phone && !isPhoneish(b.mobile_phone)) return 'Enter a valid mobile number (at least 7 digits).';
  for (const f of ['join_date', 'baptism_date', 'confirmation_date']) {
    if (b[f] && !isValidDate(b[f])) return 'Dates must be in YYYY-MM-DD format.';
  }
  return null;
}

// ---------- members ----------
function memberWhere({ q, status, classId }) {
  const where = ['m.deleted_at IS NULL'];
  const params = {};
  if (q) {
    where.push(`(m.first_name LIKE @q OR m.last_name LIKE @q OR m.email LIKE @q
                 OR m.mobile_phone LIKE @q OR m.external_id LIKE @q)`);
    params.q = `%${q}%`;
  }
  if (status) { where.push(`m.membership_status = @status`); params.status = status; }
  if (classId) { where.push(`m.bible_class_id = @classId`); params.classId = Number(classId); }
  return { clause: where.join(' AND '), params };
}
function selectMembers(filters) {
  const { clause, params } = memberWhere(filters);
  let sql = `
    SELECT m.member_id, m.external_id, m.first_name, m.last_name, m.email, m.mobile_phone,
           m.membership_status, m.photo_filename, mn.name AS bible_class
    FROM members m LEFT JOIN ministries mn ON mn.ministry_id = m.bible_class_id
    WHERE ${clause}
    ORDER BY m.last_name, m.first_name`;
  if (filters.limit != null) {
    sql += ` LIMIT @limit OFFSET @offset`;
    params.limit = filters.limit;
    params.offset = filters.offset || 0;
  }
  return db.prepare(sql).all(params);
}
function countMembers(filters) {
  const { clause, params } = memberWhere(filters);
  return db.prepare(`SELECT COUNT(*) c FROM members m WHERE ${clause}`).get(params).c;
}

// Build Prev / page-of / Next controls preserving the current query string.
const MEMBER_STATUS_LABELS = {
  visitor: 'Visitor', regular: 'Regular', member: 'Member', inactive: 'Inactive',
  transferred: 'Transferred', deceased: 'Deceased', other: 'Other',
};
const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

function memberAvatar(m) {
  return m.photo_filename
    ? `<img class="m-avatar" src="/photos/${esc(m.photo_filename)}" alt="">`
    : `<span class="m-avatar m-avatar-fallback">${esc(initials(m.first_name + ' ' + m.last_name))}</span>`;
}

const MEMBERS_PER_PAGE = 25;
app.get('/members', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const classId = (req.query.class || '').trim();
  const matched = countMembers({ q, status, classId });
  const pages = Math.max(1, Math.ceil(matched / MEMBERS_PER_PAGE));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const rows = selectMembers({ q, status, classId, limit: MEMBERS_PER_PAGE, offset: (page - 1) * MEMBERS_PER_PAGE });
  const isAdmin = res.locals.isAdmin;

  const totalMembers = db.prepare(`SELECT COUNT(*) c FROM members WHERE deleted_at IS NULL`).get().c;
  const activeMembers = db.prepare(
    `SELECT COUNT(*) c FROM members WHERE deleted_at IS NULL AND membership_status IN ('member','regular')`).get().c;
  const newMembers = db.prepare(
    `SELECT COUNT(*) c FROM members WHERE deleted_at IS NULL AND join_date >= date('now','-30 days')`).get().c;

  const classes = loadBibleClasses();
  const classOpts = `<option value="">All Bible classes</option>` + classes.map((c) =>
    `<option value="${c.ministry_id}" ${String(c.ministry_id) === classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const statuses = ['', 'visitor', 'regular', 'member', 'inactive', 'transferred', 'deceased', 'other'];
  const statusOpts = statuses.map((s) =>
    `<option value="${s}" ${s === status ? 'selected' : ''}>${s ? MEMBER_STATUS_LABELS[s] : 'All statuses'}</option>`).join('');
  const exportQs = new URLSearchParams({ q, status, class: classId }).toString();

  const hero = pageHero('Members Directory',
    'Manage and view all church members in one place. Search, filter, and act on member records.');
  const stats = statsRow([
    { cls: 'gold', icon: '👥', value: totalMembers.toLocaleString(), label: 'Total Members' },
    { cls: 'green', icon: '✓', value: activeMembers.toLocaleString(), label: 'Active' },
    { cls: 'blue', icon: '＋', value: newMembers.toLocaleString(), label: 'New (30d)' },
  ], `${isAdmin ? `<a class="btn" href="/members/new">👤＋ Add New Member</a>` : ''}
      <a class="btn ghost" href="/bible-classes">📚 Bible Classes</a>`);
  const filters = filterCard({
    q, placeholder: 'Search members by name, ID, email or phone…',
    controls: `<select name="class" aria-label="Filter by Bible class">${classOpts}</select>
      <select name="status" aria-label="Filter by status">${statusOpts}</select>
      <details class="export">
        <summary>⋯ Export</summary>
        <a href="/members.csv?${exportQs}">Export CSV</a>
        <a href="javascript:window.print()">Print / PDF</a>
      </details>`,
  });

  const rowHtml = rows.map((r) => {
    const id = r.member_id;
    const phone = esc(r.mobile_phone);
    const email = esc(r.email);
    const actions = `
      <div class="row-actions">
        <a class="icon-btn view" href="/members/${id}" title="View" aria-label="View">${ICON_EYE}</a>
        ${isAdmin ? `<a class="icon-btn edit" href="/members/${id}#edit" title="Edit" aria-label="Edit">${ICON_PENCIL}</a>
        <form method="post" action="/members/${id}/delete" onsubmit="return confirm('Archive this member? They will be hidden but not permanently deleted.')">
          <button class="icon-btn del" type="submit" title="Archive" aria-label="Archive">${ICON_TRASH}</button>
        </form>` : ''}
      </div>`;
    return `<tr>
      ${isAdmin ? `<td class="bulk-cell"><input type="checkbox" class="bulk-box" value="${id}" aria-label="Select ${esc(r.first_name)} ${esc(r.last_name)}"></td>` : ''}
      <td data-label="Name">
        <div class="m-name-cell">
          ${memberAvatar(r)}
          <div>
            <a class="m-name" href="/members/${id}">${esc(r.first_name)} ${esc(r.last_name)}</a>
            <div class="m-sub">${esc(r.external_id) || '—'}</div>
          </div>
        </div>
      </td>
      <td data-label="Contact">
        <div class="m-contact">
          ${phone ? `<div><span class="ci">📞</span> <a href="tel:${phone}">${phone}</a></div>` : '<div class="muted-text">No phone</div>'}
          ${email ? `<div><span class="ci">✉</span> <a href="mailto:${email}">${email}</a></div>` : ''}
        </div>
      </td>
      <td data-label="Bible class">${esc(r.bible_class) || '—'}</td>
      <td data-label="Status"><span class="pill pill-${esc(r.membership_status)}">${esc(MEMBER_STATUS_LABELS[r.membership_status] || r.membership_status)}</span></td>
      <td data-label="Actions">${actions}</td>
    </tr>`;
  }).join('');

  const orgsForBulk = loadOrganizations();
  const bulkBar = isAdmin ? `
    <form class="bulk-bar" method="post" action="/members/bulk">
      <input type="hidden" name="member_ids" value="">
      <span class="bulk-summary"><strong class="bulk-count">0</strong> selected</span>
      <select name="action" aria-label="Bulk action">
        <option value="export">Export selected (CSV)</option>
        <option value="add_org">Add to organization…</option>
      </select>
      <select name="org_id" aria-label="Organization">
        ${orgsForBulk.map((o) => `<option value="${o.org_id}">${esc(o.name)}</option>`).join('')}
      </select>
      <button type="submit">Apply</button>
    </form>` : '';
  const list = listCard({
    title: '👥 Members List', count: matched, countLabel: 'members',
    note: 'Results update as you search and filter',
    inner: rows.length ? `${bulkBar}<table class="data-table members-table"${isAdmin ? ' data-bulk' : ''}>
        <thead><tr>${isAdmin ? '<th class="bulk-cell"><input type="checkbox" class="bulk-all" aria-label="Select all"></th>' : ''}<th>Name</th><th>Contact</th><th>Bible class</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
      ${pager('/members', { q, status, class: classId }, page, pages)}` : `<div class="empty-state">
        <div class="empty-ico">👥</div>
        <p>No members match your search.</p>
        ${isAdmin ? '<a class="btn" href="/members/new">👤＋ Add New Member</a>' : ''}
      </div>`,
  });

  res.page({
    title: 'Members',
    active: '/members',
    noHeader: true,
    body: `${hero}${stats}${filters}${list}`,
  });
});

function membersCsv(rows) {
  const headers = ['Member ID', 'First name', 'Last name', 'Bible class', 'Status', 'Email', 'Phone'];
  return [headers.join(',')].concat(
    rows.map((r) => [r.external_id, r.first_name, r.last_name, r.bible_class,
      r.membership_status, r.email, r.mobile_phone]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
  ).join('\n');
}
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(csv);
}

app.get('/members.csv', (req, res) => {
  sendCsv(res, 'members.csv', membersCsv(selectMembers({ q: req.query.q || '', status: req.query.status || '' })));
});

// Bulk actions on selected members: export to CSV or add to an organization.
app.post('/members/bulk', requireAdmin, (req, res) => {
  const ids = String(req.body.member_ids || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) { flash(req, 'Select at least one member first.'); return res.redirect('/members'); }
  const placeholders = ids.map(() => '?').join(',');
  if (req.body.action === 'export') {
    const rows = db.prepare(`
      SELECT m.external_id, m.first_name, m.last_name, m.membership_status, m.email, m.mobile_phone,
             mn.name AS bible_class
      FROM members m LEFT JOIN ministries mn ON mn.ministry_id = m.bible_class_id
      WHERE m.member_id IN (${placeholders}) AND m.deleted_at IS NULL
      ORDER BY m.last_name, m.first_name`).all(...ids);
    return sendCsv(res, 'members-selected.csv', membersCsv(rows));
  }
  if (req.body.action === 'add_org') {
    const orgId = Number(req.body.org_id);
    if (!orgId) { flash(req, 'Choose an organization.'); return res.redirect('/members'); }
    const org = db.prepare(`SELECT name FROM organizations WHERE org_id=? AND active=1`).get(orgId);
    if (!org) { flash(req, 'That organization no longer exists.'); return res.redirect('/members'); }
    const ins = db.prepare(`INSERT OR IGNORE INTO organization_memberships (org_id, member_id, role) VALUES (?, ?, 'member')`);
    const tx = db.transaction(() => { for (const id of ids) ins.run(orgId, id); });
    tx();
    flash(req, `Added ${ids.length} member${ids.length === 1 ? '' : 's'} to ${org.name}.`, 'success');
    return res.redirect('/members');
  }
  flash(req, 'Unknown bulk action.');
  res.redirect('/members');
});

function memberForm(member = {}, bibleClasses = [], organizations = [], memberOrgIds = [], action) {
  const bibleClassOpts = '<option value="">— none —</option>' +
    bibleClasses.map((b) =>
      `<option value="${b.ministry_id}" ${b.ministry_id === member.bible_class_id ? 'selected' : ''}>${esc(b.name)}</option>`
    ).join('');
  const statusOpts = ['visitor', 'member']
    .map((s) => `<option value="${s}" ${s === member.membership_status ? 'selected' : ''}>${s}</option>`).join('');
  const maritalOpts = ['', 'single', 'married', 'divorced', 'widowed', 'separated', 'other']
    .map((s) => `<option value="${s}" ${s === (member.marital_status || '') ? 'selected' : ''}>${s || '—'}</option>`).join('');
  const genderLabels = { '': '—', M: 'M', F: 'F', O: 'Other' };
  const genderOpts = ['', 'M', 'F', 'O']
    .map((s) => `<option value="${s}" ${s === (member.gender || '') ? 'selected' : ''}>${genderLabels[s]}</option>`).join('');
  const orgChecks = organizations.map((o) => `
      <label class="check"><input type="checkbox" name="org_ids" value="${o.org_id}"
        ${memberOrgIds.includes(o.org_id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('');
  const orgsOpen = memberOrgIds.length > 0;
  const orgsCount = memberOrgIds.length;
  const memberIdField = member.member_id
    ? `<label>Member ID<input name="external_id" value="${esc(member.external_id || '')}" readonly></label>`
    : `<label>Member ID<input name="external_id" value="(auto-generated on save)" readonly></label>`;
  return `
    <form method="post" action="${action}" class="form">
      ${memberIdField}
      <label>Status<select name="membership_status" required>${statusOpts}</select></label>
      <label>First name<input name="first_name" required value="${esc(member.first_name)}"></label>
      <label>Last name<input name="last_name" required value="${esc(member.last_name)}"></label>
      <label>Email<input type="email" name="email" value="${esc(member.email)}"></label>
      <label>Mobile<input name="mobile_phone" required value="${esc(member.mobile_phone)}"></label>
      <label>Date of birth (day &amp; month)
        <div class="dob-row">
          <select name="dob_month" aria-label="Month" required>
            <option value="">— month —</option>
            ${MONTHS.map((mn, i) => `<option value="${i + 1}" ${(i + 1) === dobMonth(member.date_of_birth) ? 'selected' : ''}>${mn}</option>`).join('')}
          </select>
          <select name="dob_day" aria-label="Day" required>
            <option value="">— day —</option>
            ${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${(i + 1) === dobDay(member.date_of_birth) ? 'selected' : ''}>${i + 1}</option>`).join('')}
          </select>
        </div>
      </label>
      <label>Day born<select name="day_born">
        <option value="">—</option>
        ${DAYS_OF_WEEK.map((d) => `<option value="${d}" ${d === (member.day_born || '') ? 'selected' : ''}>${d}</option>`).join('')}
      </select></label>
      <label>Gender<select name="gender" required>${genderOpts}</select></label>
      <label>Marital<select name="marital_status">${maritalOpts}</select></label>
      <label>Bible class<select name="bible_class_id">${bibleClassOpts}</select></label>
      <label>Communication preference
        <select name="preferred_channel" required>
          ${Object.entries(PREF_LABELS).map(([v, l]) =>
            `<option value="${v}" ${v === (member.preferred_channel || 'none') ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <span class="hint">New members default to <em>Do not contact</em>. Switch once the member consents to SMS / email.</span>
      </label>
      <label>Join date<input type="date" name="join_date" value="${fmtDate(member.join_date)}"></label>
      <label>Baptism date<input type="date" name="baptism_date" value="${fmtDate(member.baptism_date)}"></label>
      <label>Confirmation date<input type="date" name="confirmation_date" value="${fmtDate(member.confirmation_date)}"></label>
      <div class="wide-cell">
        <details class="form-toggle" ${orgsOpen ? 'open' : ''}>
          <summary><strong>Choose organizations</strong>
            <span class="muted-text">${orgsCount > 0 ? `(${orgsCount} selected)` : '(optional — click to expand)'}</span>
          </summary>
          <div class="check-grid" style="margin-top:0.5rem">${orgChecks || '<span class="muted-text">No organizations yet.</span>'}</div>
        </details>
      </div>
      <div class="wide-cell"><h3 class="form-section">Emergency contact</h3></div>
      <label>Contact name<input name="emergency_contact_name" value="${esc(member.emergency_contact_name)}"></label>
      <label>Contact phone<input name="emergency_contact_phone" value="${esc(member.emergency_contact_phone)}"></label>
      <label>Relationship<input name="emergency_contact_relation" placeholder="e.g. spouse, parent, sibling" value="${esc(member.emergency_contact_relation)}"></label>
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
  const err = memberErrors(b);
  if (err) { flash(req, err); return res.redirect('/members/new'); }
  const externalId = nextMemberId();
  const info = db.prepare(`
    INSERT INTO members (external_id, bible_class_id, first_name, last_name, email, mobile_phone,
      date_of_birth, day_born, gender, marital_status, membership_status,
      join_date, baptism_date, confirmation_date, notes,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
      preferred_channel, unsubscribe_token)
    VALUES (@external_id, @bible_class_id, @first_name, @last_name, @email, @mobile_phone,
      @date_of_birth, @day_born, @gender, @marital_status, @membership_status,
      @join_date, @baptism_date, @confirmation_date, @notes,
      @emergency_contact_name, @emergency_contact_phone, @emergency_contact_relation,
      @preferred_channel, lower(hex(randomblob(16))))
  `).run({
    external_id: externalId,
    bible_class_id: b.bible_class_id ? Number(b.bible_class_id) : null,
    first_name: b.first_name, last_name: b.last_name,
    email: b.email || null, mobile_phone: b.mobile_phone || null,
    date_of_birth: parseDob(b.dob_month, b.dob_day),
    day_born: DAYS_OF_WEEK.includes(b.day_born) ? b.day_born : null,
    gender: b.gender || null,
    preferred_channel: PREF_LABELS[b.preferred_channel] ? b.preferred_channel : 'none',
    marital_status: b.marital_status || null,
    membership_status: b.membership_status || 'visitor',
    join_date: b.join_date || null, baptism_date: b.baptism_date || null,
    confirmation_date: b.confirmation_date || null,
    notes: b.notes || null,
    emergency_contact_name: b.emergency_contact_name || null,
    emergency_contact_phone: b.emergency_contact_phone || null,
    emergency_contact_relation: b.emergency_contact_relation || null,
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
  const sacraments = db.prepare(`
    SELECT sacrament_type, occurred_on, location FROM sacraments
    WHERE member_id = ? OR spouse_id = ? ORDER BY occurred_on DESC`).all(id, id);
  const attendance = db.prepare(`
    SELECT e.title, e.starts_at FROM attendance a
    JOIN events e USING(event_id) WHERE a.member_id = ?
    ORDER BY e.starts_at DESC LIMIT 10`).all(id);

  const photoBlock = `
    <div class="member-photo">
      ${m.photo_filename
        ? `<img src="/photos/${esc(m.photo_filename)}" alt="Photo of ${esc(m.first_name)} ${esc(m.last_name)}">`
        : `<div class="avatar-lg">${esc(initials(m.first_name + ' ' + m.last_name))}</div>`}
      ${res.locals.isAdmin ? `
        <form method="post" action="/members/${id}/photo" enctype="multipart/form-data" class="photo-form">
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/gif" required>
          <button type="submit">Upload</button>
          ${m.photo_filename ? `
            <form method="post" action="/members/${id}/photo/delete" style="display:inline"
                  onsubmit="return confirm('Remove this photo?')">
              <button class="link" type="submit">Remove photo</button>
            </form>` : ''}
        </form>` : ''}
    </div>`;
  const editPanel = res.locals.isAdmin
    ? `${photoBlock}
       <h2>Edit</h2>
       ${memberForm(m, loadBibleClasses(), loadOrganizations(), memberOrgs, `/members/${id}`)}
       <form method="post" action="/members/${id}/delete" onsubmit="return confirm('Archive this member? They will be hidden but not permanently deleted.')">
         <button class="danger" type="submit">Archive member</button>
       </form>`
    : `${photoBlock}
       <h2>Profile</h2>
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

        <p><a class="btn ghost" href="/members/${id}/statement">🧾 Giving statement</a></p>

        <h3>🚨 Emergency contact</h3>
        ${(m.emergency_contact_name || m.emergency_contact_phone || m.emergency_contact_relation)
          ? `<dl class="stats emergency-box">
               <dt>Name</dt><dd>${esc(m.emergency_contact_name) || '—'}</dd>
               <dt>Phone</dt><dd>${m.emergency_contact_phone
                 ? `<a href="tel:${esc(m.emergency_contact_phone)}">${esc(m.emergency_contact_phone)}</a>` : '—'}</dd>
               <dt>Relationship</dt><dd>${esc(m.emergency_contact_relation) || '—'}</dd>
             </dl>`
          : '<p class="muted-text">No emergency contact on file.</p>'}

        <h3>Ministries</h3>
        ${ministries.length ? table(['Ministry', 'Role', 'Joined'],
          ministries.map((r) => [esc(r.name), esc(r.role), esc(r.joined_date)]))
          : '<p>Not in any ministry.</p>'}

        <h3>Sacraments</h3>
        ${sacraments.length ? table(['Type', 'Date', 'Location'],
          sacraments.map((r) => [esc(r.sacrament_type), esc(r.occurred_on), esc(r.location)]))
          : '<p>None recorded.</p>'}

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
  const err = memberErrors(b);
  if (err) { flash(req, err); return res.redirect(`/members/${id}`); }
  db.prepare(`
    UPDATE members SET bible_class_id=@bible_class_id, first_name=@first_name, last_name=@last_name,
      email=@email, mobile_phone=@mobile_phone, date_of_birth=@date_of_birth,
      day_born=@day_born, gender=@gender,
      marital_status=@marital_status, membership_status=@membership_status,
      join_date=@join_date, baptism_date=@baptism_date,
      confirmation_date=@confirmation_date, notes=@notes,
      emergency_contact_name=@emergency_contact_name,
      emergency_contact_phone=@emergency_contact_phone,
      emergency_contact_relation=@emergency_contact_relation,
      preferred_channel=@preferred_channel
    WHERE member_id=@id`).run({
    id,
    bible_class_id: b.bible_class_id ? Number(b.bible_class_id) : null,
    first_name: b.first_name, last_name: b.last_name,
    email: b.email || null, mobile_phone: b.mobile_phone || null,
    date_of_birth: parseDob(b.dob_month, b.dob_day),
    day_born: DAYS_OF_WEEK.includes(b.day_born) ? b.day_born : null,
    gender: b.gender || null,
    preferred_channel: PREF_LABELS[b.preferred_channel] ? b.preferred_channel : 'none',
    marital_status: b.marital_status || null,
    membership_status: b.membership_status || 'visitor',
    join_date: b.join_date || null, baptism_date: b.baptism_date || null,
    confirmation_date: b.confirmation_date || null,
    notes: b.notes || null,
    emergency_contact_name: b.emergency_contact_name || null,
    emergency_contact_phone: b.emergency_contact_phone || null,
    emergency_contact_relation: b.emergency_contact_relation || null,
  });
  saveMemberOrgs(id, parseOrgIds(b));
  res.redirect(`/members/${id}`);
});

app.post('/members/:id/photo', requireAdmin, photoUpload.single('photo'), (req, res) => {
  const id = Number(req.params.id);
  if (!csrfValid(req)) return res.status(403).send(layout({
    title: 'Security check failed', user: res.locals.user, active: null,
    body: '<p>This form was stale. Please go back and try again.</p>',
  }));
  if (!req.file) return res.redirect(`/members/${id}`);
  if (!looksLikeImage(req.file.buffer)) return res.status(400).send(layout({
    title: 'Invalid image', user: res.locals.user, active: null,
    body: `<p>That file does not look like a valid image. Upload a JPG, PNG, WebP or GIF.</p><p><a href="/members/${id}">Back</a></p>`,
  }));
  const ext = EXT_FROM_MIME[req.file.mimetype.toLowerCase()] || 'jpg';
  const filename = `${id}.${ext}`;
  try {
    fs.writeFileSync(path.join(PHOTO_DIR, filename), req.file.buffer);
    // Remove any stale photos with other extensions.
    for (const otherExt of Object.values(EXT_FROM_MIME)) {
      if (otherExt !== ext) {
        try { fs.unlinkSync(path.join(PHOTO_DIR, `${id}.${otherExt}`)); } catch (_) {}
      }
    }
    db.prepare(`UPDATE members SET photo_filename = ? WHERE member_id = ?`).run(filename, id);
  } catch (e) {
    console.error('photo upload failed:', e.message);
  }
  res.redirect(`/members/${id}`);
});

app.post('/members/:id/photo/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare(`SELECT photo_filename FROM members WHERE member_id=?`).get(id);
  if (m && m.photo_filename) {
    try { fs.unlinkSync(path.join(PHOTO_DIR, m.photo_filename)); } catch (_) {}
    db.prepare(`UPDATE members SET photo_filename = NULL WHERE member_id = ?`).run(id);
  }
  res.redirect(`/members/${id}`);
});

// Serve member photos. Auth-gated (the middleware above already required login).
app.get('/photos/:filename', (req, res) => {
  const safe = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const full = path.join(PHOTO_DIR, safe);
  if (!fs.existsSync(full)) return res.status(404).send('Not found');
  res.sendFile(full);
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
require('./routes/bible-classes').register(app, {
  db, esc, initials, pageHero, statsRow, filterCard, listCard, loadOrganizations, requireAdmin,
});

// ---------- events ----------
app.get('/events', (req, res) => {
  const q = (req.query.q || '').trim();
  const isAdmin = res.locals.isAdmin;
  const rows = db.prepare(`
    SELECT e.*, COUNT(a.member_id) attendees
    FROM events e LEFT JOIN attendance a USING(event_id)
    ${q ? 'WHERE e.title LIKE @q' : ''}
    GROUP BY e.event_id ORDER BY e.starts_at DESC`).all(q ? { q: `%${q}%` } : {});

  const totalEvents = db.prepare(`SELECT COUNT(*) c FROM events`).get().c;
  const upcoming = db.prepare(`SELECT COUNT(*) c FROM events WHERE starts_at >= datetime('now')`).get().c;
  const checkins = db.prepare(`SELECT COUNT(*) c FROM attendance`).get().c;

  const hero = pageHero('Events', 'Services, meetings and special events — schedule them and track attendance.');
  const stats = statsRow([
    { cls: 'gold', icon: '📅', value: totalEvents.toLocaleString(), label: 'Total Events' },
    { cls: 'green', icon: '⏭', value: upcoming.toLocaleString(), label: 'Upcoming' },
    { cls: 'blue', icon: '✓', value: checkins.toLocaleString(), label: 'Check-ins Recorded' },
  ], `<a class="btn ghost" href="/events/calendar">🗓 Calendar view</a>
      ${isAdmin ? `<a class="btn" href="/events/new">＋ New Event</a>` : ''}`);
  const filters = filterCard({ q, placeholder: 'Search events by title…' });

  const rowHtml = rows.map((r) => {
    const d = new Date(r.starts_at.replace(' ', 'T'));
    const when = Number.isNaN(d.getTime()) ? esc(r.starts_at)
      : d.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<tr>
      <td data-label="When">${when}</td>
      <td data-label="Event">
        <div><span class="evt-type">${esc(r.event_type)}</span></div>
        <a class="m-name" href="/events/${r.event_id}">${esc(r.title)}</a>
      </td>
      <td data-label="Location">${esc(r.location) || '<span class="muted-text">—</span>'}</td>
      <td data-label="Attendees"><span class="count-badge">${r.attendees}</span></td>
      <td data-label="Actions"><div class="row-actions">
        <a class="icon-btn view" href="/events/${r.event_id}" title="View" aria-label="View">${ICON_EYE}</a>
      </div></td>
    </tr>`;
  }).join('');

  const list = listCard({
    title: '📅 Events', count: rows.length, countLabel: 'events',
    inner: rows.length ? `<table class="data-table members-table">
        <thead><tr><th>When</th><th>Event</th><th>Location</th><th>Attendees</th><th>Actions</th></tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>` : `<div class="empty-state"><div class="empty-ico">📅</div><p>No events match your search.</p>
        ${isAdmin ? '<a class="btn" href="/events/new">＋ New Event</a>' : ''}</div>`,
  });

  res.page({ title: 'Events', active: '/events', noHeader: true, body: `${hero}${stats}${filters}${list}` });
});

app.get('/events/calendar', (req, res) => {
  const now = new Date();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [y, mo] = month.split('-').map(Number);
  const first = new Date(y, mo - 1, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, mo, 0).getDate();
  const prev = new Date(y, mo - 2, 1);
  const next = new Date(y, mo, 1);
  const fmtMonthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const events = db.prepare(`SELECT event_id, title, event_type, starts_at FROM events
    WHERE substr(starts_at,1,7)=? ORDER BY starts_at`).all(month);
  const byDay = {};
  for (const e of events) { const d = Number(String(e.starts_at).slice(8, 10)); (byDay[d] = byDay[d] || []).push(e); }

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push('<div class="cal-cell blank"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const dayKey = `${month}-${String(d).padStart(2, '0')}`;
    const evs = (byDay[d] || []).map((e) =>
      `<a class="cal-ev" href="/events/${e.event_id}" title="${esc(e.title)}">${esc(e.title)}</a>`).join('');
    cells.push(`<div class="cal-cell${dayKey === todayKey ? ' today' : ''}"><div class="cal-day">${d}</div>${evs}</div>`);
  }
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('');
  const monthLabel = first.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  const body = `
    ${pageHero('Events Calendar', 'A month-at-a-glance view of every scheduled event.')}
    ${statsRow([{ cls: 'gold', icon: '🗓', value: events.length.toLocaleString(), label: `Events in ${monthLabel}` }],
      `<a class="btn ghost" href="/events">📋 List view</a>`)}
    <div class="card">
      <div class="card-head cal-nav">
        <a class="btn ghost" href="/events/calendar?month=${fmtMonthKey(prev)}">← ${prev.toLocaleString('en-GB', { month: 'short' })}</a>
        <h2>${esc(monthLabel)}</h2>
        <a class="btn ghost" href="/events/calendar?month=${fmtMonthKey(next)}">${next.toLocaleString('en-GB', { month: 'short' })} →</a>
      </div>
      <div class="calendar">${dows}${cells.join('')}</div>
    </div>`;
  res.page({ title: 'Events Calendar', active: '/events', noHeader: true, body });
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
    INSERT INTO events (title, event_type, starts_at, ends_at, location, notes, checkin_token)
    VALUES (@title, @event_type, @starts_at, @ends_at, @location, @notes, lower(hex(randomblob(16))))
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

  const qrButton = res.locals.isAdmin
    ? `<p><a class="btn" href="/events/${id}/qr">📱 QR check-in page</a>
         <a class="btn ghost" href="/checkin/${esc(ev.checkin_token || '')}" target="_blank" rel="noopener">Preview self-check-in</a></p>`
    : '';

  // RSVPs
  const RSVP_LABELS = { going: 'Going', maybe: 'Maybe', no: "Can't" };
  const rsvps = db.prepare(`
    SELECT r.member_id, r.response, m.first_name || ' ' || m.last_name AS name
    FROM event_rsvps r JOIN members m USING(member_id)
    WHERE r.event_id=? AND m.deleted_at IS NULL
    ORDER BY r.response, m.last_name`).all(id);
  const rsvpCounts = { going: 0, maybe: 0, no: 0 };
  for (const r of rsvps) rsvpCounts[r.response] = (rsvpCounts[r.response] || 0) + 1;
  const rsvpPillClass = { going: 'pill-member', maybe: 'pill-visitor', no: 'pill-inactive' };
  const rsvpList = rsvps.length
    ? `<ul class="check-list">${rsvps.map((r) => `<li>
        <a href="/members/${r.member_id}">${esc(r.name)}</a>
        <span class="pill ${rsvpPillClass[r.response]}">${RSVP_LABELS[r.response]}</span>
        ${res.locals.isAdmin ? `<form method="post" action="/events/${id}/rsvp/remove">
          <input type="hidden" name="member_id" value="${r.member_id}">
          <button class="link" type="submit">remove</button></form>` : ''}
      </li>`).join('')}</ul>`
    : '<p class="muted-text">No responses yet.</p>';
  const rsvpAdmin = res.locals.isAdmin
    ? `<form method="post" action="/events/${id}/rsvp" class="filter-bar" style="margin-top:0.6rem">
         <select name="member_id" required style="flex:1;min-width:180px"><option value="">— pick a member —</option>${otherOpts}</select>
         <select name="response">${Object.entries(RSVP_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
         <button type="submit">Save RSVP</button>
       </form>` : '';
  const rsvpLink = `<p class="muted-text" style="margin-top:0.4rem">Public RSVP link:
    <a href="/rsvp/${esc(ev.checkin_token || '')}" target="_blank" rel="noopener">/rsvp/${esc(ev.checkin_token || '')}</a></p>`;

  const body = `
    <p><strong>${esc(ev.event_type)}</strong> · ${esc(ev.starts_at)} · ${esc(ev.location) || ''}</p>
    ${qrButton}
    <div class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>RSVPs</h2>
        <span class="meta">✅ ${rsvpCounts.going} going · 🤔 ${rsvpCounts.maybe} maybe · ✖ ${rsvpCounts.no} can't</span></div>
      ${rsvpList}
      ${rsvpAdmin}
      ${res.locals.isAdmin ? rsvpLink : ''}
    </div>
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

app.post('/events/:id/rsvp', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const memberId = Number(req.body.member_id);
  const response = ['going', 'maybe', 'no'].includes(req.body.response) ? req.body.response : 'going';
  if (memberId) {
    db.prepare(`INSERT INTO event_rsvps (event_id, member_id, response) VALUES (?, ?, ?)
      ON CONFLICT(event_id, member_id) DO UPDATE SET response=excluded.response, responded_at=CURRENT_TIMESTAMP`)
      .run(id, memberId, response);
  }
  res.redirect(`/events/${id}`);
});
app.post('/events/:id/rsvp/remove', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM event_rsvps WHERE event_id=? AND member_id=?`).run(id, Number(req.body.member_id));
  res.redirect(`/events/${id}`);
});

// Public self-service RSVP (no login), keyed by the event's token.
app.get('/rsvp/:token', (req, res) => {
  const ev = db.prepare(`SELECT * FROM events WHERE checkin_token=?`).get(req.params.token);
  if (!ev) return res.status(404).send(layout({ title: 'RSVP link not recognized', bare: true, body: '<p>This RSVP link is not valid.</p>' }));
  const members = db.prepare(`SELECT member_id, first_name || ' ' || last_name AS name FROM members
    WHERE membership_status IN ('member','regular','visitor') AND deleted_at IS NULL ORDER BY last_name`).all();
  const opts = members.map((m) => `<option value="${m.member_id}">${esc(m.name)}</option>`).join('');
  const done = req.query.ok === '1';
  res.send(layout({
    title: `RSVP · ${ev.title}`, bare: true,
    body: `<p class="muted">${esc(ev.event_type)} · ${esc(ev.starts_at)}${ev.location ? ` · ${esc(ev.location)}` : ''}</p>
      ${done ? '<div class="flash flash-success">Thank you — your response has been recorded.</div>' : ''}
      <form class="form auth-form" method="post" action="/rsvp/${esc(req.params.token)}">
        <label class="wide">Your name<select name="member_id" required><option value="">— find your name —</option>${opts}</select></label>
        <label class="wide">Will you attend?
          <select name="response"><option value="going">Yes, I'll be there</option><option value="maybe">Maybe</option><option value="no">Can't make it</option></select></label>
        <div class="actions"><button type="submit">Send RSVP</button></div>
      </form>`,
  }));
});
app.post('/rsvp/:token', (req, res) => {
  const ev = db.prepare(`SELECT event_id FROM events WHERE checkin_token=?`).get(req.params.token);
  if (!ev) return res.status(404).send('Not found');
  const memberId = Number(req.body.member_id);
  const response = ['going', 'maybe', 'no'].includes(req.body.response) ? req.body.response : 'going';
  if (memberId) {
    db.prepare(`INSERT INTO event_rsvps (event_id, member_id, response) VALUES (?, ?, ?)
      ON CONFLICT(event_id, member_id) DO UPDATE SET response=excluded.response, responded_at=CURRENT_TIMESTAMP`)
      .run(ev.event_id, memberId, response);
  }
  res.redirect(`/rsvp/${req.params.token}?ok=1`);
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

// ---------- QR check-in (admin display) ----------
app.get('/events/:id/qr', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const ev = db.prepare(`SELECT * FROM events WHERE event_id=?`).get(id);
  if (!ev) return res.status(404).send('Not found');
  if (!ev.checkin_token) {
    db.prepare(`UPDATE events SET checkin_token = lower(hex(randomblob(16))) WHERE event_id=?`).run(id);
    ev.checkin_token = db.prepare(`SELECT checkin_token FROM events WHERE event_id=?`).get(id).checkin_token;
  }
  const baseUrl = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/checkin/${ev.checkin_token}`;
  const QRCode = require('qrcode');
  let qrSvg;
  try {
    qrSvg = await QRCode.toString(url, { type: 'svg', width: 400, margin: 2, errorCorrectionLevel: 'M' });
  } catch (e) {
    return res.status(500).send('QR generation failed: ' + e.message);
  }
  const when = new Date(ev.starts_at);
  const dateStr = when.toLocaleString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const body = `
    <p><a href="/events/${id}">← Back to event</a></p>
    <div class="qr-page">
      <div class="qr-card">
        <div class="qr-meta">
          <h2>${esc(ev.title)}</h2>
          <p>${esc(dateStr)}</p>
          ${ev.location ? `<p class="muted-text">${esc(ev.location)}</p>` : ''}
        </div>
        <div class="qr-art">${qrSvg}</div>
        <p class="qr-instruct"><strong>Scan with your phone camera</strong> to check in.</p>
        <p class="qr-url muted-text">${esc(url)}</p>
      </div>
      <div class="qr-actions screen-only">
        <button onclick="window.print()">🖨 Print this QR sign</button>
        <a class="btn ghost" href="javascript:document.body.requestFullscreen ? document.body.requestFullscreen() : null">
          Full-screen (for display)
        </a>
      </div>
    </div>`;
  res.page({ title: `Check-in QR · ${ev.title}`, active: '/events', body });
});

// ---------- QR check-in (public) ----------
function findEventByToken(token) {
  return db.prepare(
    `SELECT event_id, title, starts_at, location, checkin_token
       FROM events WHERE checkin_token = ?`
  ).get(token);
}

app.get('/checkin/:token', (req, res) => {
  const ev = findEventByToken(req.params.token);
  if (!ev) {
    return res.status(404).send(layout({
      title: 'Check-in link not recognized', bare: true,
      body: '<p>This check-in QR is no longer valid. Please ask an usher for help.</p>',
    }));
  }
  const when = new Date(ev.starts_at).toLocaleString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  res.send(layout({
    title: `Check in · ${ev.title}`, bare: true,
    body: `
      <p class="muted-text">${esc(when)}${ev.location ? ' · ' + esc(ev.location) : ''}</p>
      <form method="post" action="/checkin/${esc(req.params.token)}" class="form auth-form">
        <label class="wide">Your name or Member ID
          <input name="q" required autofocus
                 placeholder="e.g. John Anderson or DMS-001">
        </label>
        <div class="actions"><button type="submit">Find me →</button></div>
      </form>`,
  }));
});

app.post('/checkin/:token', (req, res) => {
  const ev = findEventByToken(req.params.token);
  if (!ev) return res.status(404).send(layout({ title: 'Check-in link not recognized', bare: true,
    body: '<p>This check-in QR is no longer valid.</p>' }));

  // If the form posted a confirmed member_id, record attendance and finish.
  if (req.body.member_id) {
    const mid = Number(req.body.member_id);
    const m = db.prepare(
      `SELECT member_id, first_name, last_name FROM members WHERE member_id=? AND deleted_at IS NULL`
    ).get(mid);
    if (!m) return res.redirect(`/checkin/${req.params.token}`);
    db.prepare(`INSERT OR IGNORE INTO attendance (event_id, member_id) VALUES (?, ?)`).run(ev.event_id, mid);
    logActivity('attendance_recorded',
      `${m.first_name} ${m.last_name} self-checked in to ${ev.title}`,
      `/events/${ev.event_id}`, null);
    return res.send(layout({
      title: `✓ Checked in, ${m.first_name}`, bare: true,
      body: `
        <p style="font-size:1.1rem">Welcome, <strong>${esc(m.first_name)} ${esc(m.last_name)}</strong>.</p>
        <p>You're checked in to <strong>${esc(ev.title)}</strong>. Have a blessed time. 🙏</p>
        <p style="margin-top:1.25rem"><a href="/checkin/${esc(req.params.token)}">Check in another person</a></p>`,
    }));
  }

  // Otherwise, search by name or external_id.
  const q = (req.body.q || '').trim();
  if (!q) return res.redirect(`/checkin/${req.params.token}`);
  const like = `%${q}%`;
  const matches = db.prepare(`
    SELECT m.member_id, m.first_name, m.last_name, m.external_id,
           m.mobile_phone, m.bible_class_id,
           bc.name AS bible_class,
           (SELECT 1 FROM attendance a WHERE a.event_id=? AND a.member_id=m.member_id) AS already
    FROM members m
    LEFT JOIN ministries bc ON bc.ministry_id = m.bible_class_id
    WHERE m.deleted_at IS NULL
      AND (
        (m.first_name || ' ' || m.last_name) LIKE ?
        OR m.external_id = ?
        OR m.first_name LIKE ?
        OR m.last_name  LIKE ?
        OR m.mobile_phone LIKE ?
      )
    ORDER BY m.last_name LIMIT 12
  `).all(ev.event_id, like, q.toUpperCase(), like, like, like);

  if (matches.length === 0) {
    return res.send(layout({
      title: 'No match found', bare: true,
      body: `
        <p>No member found for <strong>"${esc(q)}"</strong>. Please ask an usher for help, or try a different spelling / your Member ID (e.g. DMS-007).</p>
        <p><a href="/checkin/${esc(req.params.token)}">← Try again</a></p>`,
    }));
  }

  if (matches.length === 1 && !matches[0].already) {
    // Auto-confirm the single match.
    db.prepare(`INSERT OR IGNORE INTO attendance (event_id, member_id) VALUES (?, ?)`).run(ev.event_id, matches[0].member_id);
    logActivity('attendance_recorded',
      `${matches[0].first_name} ${matches[0].last_name} self-checked in to ${ev.title}`,
      `/events/${ev.event_id}`, null);
    return res.send(layout({
      title: `✓ Checked in, ${matches[0].first_name}`, bare: true,
      body: `
        <p style="font-size:1.1rem">Welcome, <strong>${esc(matches[0].first_name)} ${esc(matches[0].last_name)}</strong>.</p>
        <p>You're checked in to <strong>${esc(ev.title)}</strong>. Have a blessed time. 🙏</p>
        <p style="margin-top:1.25rem"><a href="/checkin/${esc(req.params.token)}">Check in another person</a></p>`,
    }));
  }

  // Otherwise show a list to pick from.
  const list = matches.map((m) => `
    <form method="post" action="/checkin/${esc(req.params.token)}" class="checkin-pick">
      <input type="hidden" name="member_id" value="${m.member_id}">
      <button type="submit" ${m.already ? 'disabled' : ''}>
        <div class="who">
          <div class="name">${esc(m.first_name)} ${esc(m.last_name)}</div>
          <div class="meta">${esc(m.external_id) || ''}${m.bible_class ? ' · ' + esc(m.bible_class) : ''}</div>
        </div>
        <span class="pick-tag">${m.already ? '✓ already checked in' : 'Tap to check in'}</span>
      </button>
    </form>`).join('');

  res.send(layout({
    title: matches.length === 1 ? 'Already checked in' : 'Pick your name', bare: true,
    body: `
      <p class="muted-text">${matches.length} match${matches.length === 1 ? '' : 'es'} for "${esc(q)}":</p>
      ${list}
      <p style="margin-top:1rem"><a href="/checkin/${esc(req.params.token)}">← Search again</a></p>`,
  }));
});

// Keep old URLs working.
app.get('/contributions', (_, res) => res.redirect('/finance'));

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
    : `<div class="empty-state"><div class="empty-ico">🧾</div><p>No member giving recorded for ${year}.</p></div>`;

  res.page({
    title: 'Finance · Statements', active: '/finance', noHeader: true,
    body: `${pageHero('Giving Statements', 'Per-member annual contribution summaries for year-end records.')}
      ${financeTabs('/finance/statements')}
      ${statsRow([
        { cls: 'gold', icon: '🧾', value: rows.length.toLocaleString(), label: `Givers in ${year}` },
        { cls: 'green', icon: '₵', value: fmtMoney(totalGiving), label: `Attributed Giving ${year}` },
      ], yearSel)}
      ${listCard({ title: `🧾 Members with giving in ${year}`, count: rows.length, countLabel: 'members', inner })}`,
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

// ---------- reports: shared ----------
const REPORT_TABS = [
  ['/reports',          'Overview'],
  ['/reports/day-born', 'Day-Born'],
  ['/reports/collections','Collections'],
  ['/reports/harvests', 'Harvests'],
  ['/reports/special',  'Special Offerings'],
  ['/reports/expenses', 'Expenses'],
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
const DAY_ORDER_CASE = `CASE day_born
  WHEN 'Sunday' THEN 1 WHEN 'Monday' THEN 2 WHEN 'Tuesday' THEN 3
  WHEN 'Wednesday' THEN 4 WHEN 'Thursday' THEN 5 WHEN 'Friday' THEN 6
  WHEN 'Saturday' THEN 7 ELSE 8 END`;
const MONTH_NAMES = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

// ---------- reports: overview ----------
app.get('/reports', (req, res) => {
  const tiles = [
    ['/reports/day-born',     '📅', 'Day-Born',          'Sample-screen style: 4 summary cards, bar chart, crosstab.'],
    ['/reports/collections',  '₵',  'Collections',       'Daily, weekly, monthly, annual and year-over-year.'],
    ['/reports/harvests',     '🌾', 'Harvests',          'Status, rankings, pledge fulfillment, year comparison.'],
    ['/reports/special',      '✨', 'Special Offerings', 'By category, by donor, over time, receipts log.'],
    ['/reports/expenses',     '🧾', 'Expenses',          'Categories, monthly trend, payment methods, pending receipts.'],
    ['/reports/financial',    '📊', 'Financial Summary', 'Income vs expenses, cash flow, group contribution.'],
    ['/reports/members',      '👥', 'Members',           'Birthdays, missed Sundays, top givers, follow-ups.'],
  ];
  const body = `
    ${reportTabs('/reports')}
    <p class="muted-text">Pick a report category below. Each report supports a date-range filter and a Print/PDF export.</p>
    <div class="report-tiles">${tiles.map(([href, ico, name, desc]) =>
      `<a class="report-tile" href="${href}">
         <div class="ico">${ico}</div>
         <div><div class="name">${esc(name)}</div><div class="desc">${esc(desc)}</div></div>
       </a>`).join('')}</div>
    <h2>Print everything</h2>
    <p>Build a single printable document containing every report section for a date range. Use your browser's Print dialog → "Save as PDF" to keep a copy.</p>
    <form class="filters" method="get" action="/reports/print">
      <label>From <input type="date" name="start" value="${esc(new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10))}"></label>
      <label>To <input type="date" name="end" value="${esc(new Date().toISOString().slice(0, 10))}"></label>
      <button type="submit">🖨 Open print view</button>
    </form>`;
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
        WHERE deleted_at IS NULL AND offering_date BETWEEN @s AND @e) AS income,
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
        WHERE deleted_at IS NULL AND offering_date BETWEEN @s AND @e) AS income,
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
// ---------- organizations ----------
require('./routes/organizations').register(app, {
  db, esc, initials, pageHero, statsRow, filterCard, listCard,
  ICON_EYE, ICON_TRASH, memberAvatar, requireAdmin, flash,
});

// ---------- inventory (register of physical items the church owns) ----------
require('./routes/inventory').register(app, {
  db, esc, pageHero, statsRow, filterCard, requireAdmin, logActivity,
});

// ---------- preaching plan (who preaches when + reminders) ----------
function preachingMemberOptions(selectedId) {
  const members = db.prepare(
    `SELECT member_id, first_name || ' ' || last_name AS name
       FROM members WHERE deleted_at IS NULL ORDER BY last_name`
  ).all();
  return '<option value="">— guest / not a member —</option>' +
    members.map((m) =>
      `<option value="${m.member_id}" ${m.member_id === selectedId ? 'selected' : ''}>${esc(m.name)}</option>`
    ).join('');
}

function preachingForm(plan = {}, action) {
  return `
    <form class="form" method="post" action="${action}">
      <label>Date<input type="date" name="preach_date" required value="${esc(fmtDate(plan.preach_date))}"></label>
      <label>Service / occasion<input name="service_label" placeholder="e.g. Sunday 9:00 AM service" value="${esc(plan.service_label || '')}"></label>
      <label>Preacher (member)<select name="member_id">${preachingMemberOptions(plan.member_id)}</select></label>
      <div class="wide-cell"><span class="hint">If the preacher is a guest (not a member), leave the dropdown on
        <em>guest</em> and fill in their name and contact below so reminders can still reach them.</span></div>
      <label>Guest name<input name="preacher_name" value="${esc(plan.preacher_name || '')}"></label>
      <label>Guest phone<input name="preacher_phone" value="${esc(plan.preacher_phone || '')}"></label>
      <label>Guest email<input type="email" name="preacher_email" value="${esc(plan.preacher_email || '')}"></label>
      <label>Topic / theme<input name="topic" value="${esc(plan.topic || '')}"></label>
      <label>Scripture<input name="scripture" placeholder="e.g. John 3:16" value="${esc(plan.scripture || '')}"></label>
      <label class="wide-cell">Notes<textarea name="notes" rows="2">${esc(plan.notes || '')}</textarea></label>
      <div class="actions">
        <button type="submit">Save</button>
        <a href="/preaching" class="link">Cancel</a>
      </div>
    </form>`;
}

function preacherLabel(p) {
  if (p.member_id && p.member_name) return `<a href="/members/${p.member_id}">${esc(p.member_name)}</a>`;
  if (p.preacher_name) return `${esc(p.preacher_name)} <span class="muted-text">(guest)</span>`;
  return '<span class="muted-text">— unassigned —</span>';
}

function preachingHasContact(p) {
  if (p.member_id) return !!(p.member_phone || p.member_email);
  return !!(p.preacher_phone || p.preacher_email);
}

const PREACHING_SELECT = `
  SELECT pp.*, m.first_name || ' ' || m.last_name AS member_name,
         m.mobile_phone AS member_phone, m.email AS member_email
  FROM preaching_plan pp
  LEFT JOIN members m ON m.member_id = pp.member_id
  WHERE pp.deleted_at IS NULL`;

app.get('/preaching', (req, res) => {
  const upcoming = db.prepare(
    `${PREACHING_SELECT} AND date(pp.preach_date) >= date('now') ORDER BY pp.preach_date ASC`
  ).all();
  const past = db.prepare(
    `${PREACHING_SELECT} AND date(pp.preach_date) < date('now') ORDER BY pp.preach_date DESC LIMIT 20`
  ).all();

  const reminderFlash = {
    ok: 'Preaching reminder sent.',
    dry: 'Reminder logged as a dry run — SMS/email are not configured, so nothing was actually delivered.',
    nocontact: 'Could not send: that preacher has no phone or email on file.',
    fail: 'The reminder could not be sent. Check the SMS / email settings.',
  }[req.query.reminder];

  const next = upcoming[0];
  const nextCard = next
    ? `<section class="card" style="margin-bottom:1rem;border-left:4px solid var(--accent)">
         <div class="card-head"><h2>Next up</h2><span class="meta">${esc(fmtPreachDate(next.preach_date))}</span></div>
         <p style="font-size:1.05rem"><strong>${preacherLabel(next)}</strong>
           ${next.service_label ? ` · ${esc(next.service_label)}` : ''}</p>
         ${next.topic ? `<p>Topic: ${esc(next.topic)}${next.scripture ? ` · ${esc(next.scripture)}` : ''}</p>` : ''}
         ${next.reminder_sent_at ? `<p class="muted-text">Reminder last sent ${esc(String(next.reminder_sent_at).slice(0, 16))}.</p>` : ''}
         ${res.locals.isAdmin ? (preachingHasContact(next)
           ? `<form method="post" action="/preaching/${next.plan_id}/remind"
                    onsubmit="return confirm('Send an SMS / email reminder to this preacher?')">
                <button type="submit">📣 Send reminder to ${esc((preacherContact(next).first) || 'preacher')}</button>
              </form>`
           : '<p class="muted-text">Add a phone or email for this preacher to enable reminders.</p>') : ''}
       </section>`
    : '<p class="muted-text">No upcoming preaching appointments scheduled.</p>';

  const newForm = res.locals.isAdmin
    ? `<details class="form-toggle" style="margin-bottom:1rem">
         <summary><strong>+ Schedule a preaching appointment</strong></summary>
         <div style="margin-top:0.75rem">${preachingForm({}, '/preaching')}</div>
       </details>`
    : '';

  const renderRows = (list) => list.map((p) => `
    <tr>
      <td>${esc(fmtPreachDate(p.preach_date))}</td>
      <td>${preacherLabel(p)}</td>
      <td>${esc(p.service_label || '—')}</td>
      <td>${p.topic ? esc(p.topic) : '—'}</td>
      ${res.locals.isAdmin ? `<td style="white-space:nowrap">
        <a href="/preaching/${p.plan_id}/edit" class="link">Edit</a>
        ${preachingHasContact(p)
          ? `<form method="post" action="/preaching/${p.plan_id}/remind" class="inline"
                  onsubmit="return confirm('Send an SMS / email reminder to this preacher?')">
               <button type="submit" class="link">Remind</button>
             </form>` : ''}
        <form method="post" action="/preaching/${p.plan_id}/delete" class="inline"
              onsubmit="return confirm('Archive this appointment? It will be hidden but not permanently deleted.')">
          <button type="submit" class="link">Archive</button>
        </form>
      </td>` : ''}
    </tr>`).join('');

  const head = `<thead><tr><th>Date</th><th>Preacher</th><th>Service</th><th>Topic</th>${res.locals.isAdmin ? '<th></th>' : ''}</tr></thead>`;
  const upcomingTable = upcoming.length
    ? `<section class="card" style="margin-bottom:1rem"><h2>Upcoming</h2><table>${head}<tbody>${renderRows(upcoming)}</tbody></table></section>`
    : '';
  const pastTable = past.length
    ? `<section class="card"><h2>Recent (past)</h2><table>${head}<tbody>${renderRows(past)}</tbody></table></section>`
    : '';

  res.page({
    title: 'Preaching Plan',
    subtitle: 'Schedule of preaching appointments. Send a reminder to whoever is next.',
    active: '/preaching',
    flash: reminderFlash,
    body: `${nextCard}${newForm}${upcomingTable}${pastTable}`,
  });
});

function preachingBody(b) {
  return {
    preach_date: (b.preach_date || '').slice(0, 10),
    service_label: (b.service_label || '').trim() || null,
    member_id: b.member_id ? Number(b.member_id) : null,
    preacher_name: (b.preacher_name || '').trim() || null,
    preacher_phone: (b.preacher_phone || '').trim() || null,
    preacher_email: (b.preacher_email || '').trim() || null,
    topic: (b.topic || '').trim() || null,
    scripture: (b.scripture || '').trim() || null,
    notes: (b.notes || '').trim() || null,
  };
}

app.post('/preaching', requireAdmin, (req, res) => {
  const v = preachingBody(req.body);
  if (!v.preach_date) return res.redirect('/preaching');
  const info = db.prepare(`
    INSERT INTO preaching_plan
      (preach_date, service_label, member_id, preacher_name, preacher_phone, preacher_email, topic, scripture, notes)
    VALUES (@preach_date, @service_label, @member_id, @preacher_name, @preacher_phone, @preacher_email, @topic, @scripture, @notes)
  `).run(v);
  logActivity('preaching_scheduled',
    `Scheduled preaching for ${fmtPreachDate(v.preach_date)}`,
    '/preaching', res.locals.user.user_id);
  res.redirect('/preaching');
});

app.get('/preaching/:id/edit', requireAdmin, (req, res) => {
  const plan = db.prepare(`SELECT * FROM preaching_plan WHERE plan_id=? AND deleted_at IS NULL`)
    .get(Number(req.params.id));
  if (!plan) return res.status(404).send('Appointment not found');
  res.page({
    title: 'Edit Preaching Appointment', active: '/preaching',
    body: preachingForm(plan, `/preaching/${plan.plan_id}`),
  });
});

app.post('/preaching/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const v = preachingBody(req.body);
  if (!v.preach_date) return res.redirect(`/preaching/${id}/edit`);
  db.prepare(`
    UPDATE preaching_plan SET
      preach_date=@preach_date, service_label=@service_label, member_id=@member_id,
      preacher_name=@preacher_name, preacher_phone=@preacher_phone, preacher_email=@preacher_email,
      topic=@topic, scripture=@scripture, notes=@notes, updated_at=CURRENT_TIMESTAMP
    WHERE plan_id=@id AND deleted_at IS NULL
  `).run({ ...v, id });
  res.redirect('/preaching');
});

app.post('/preaching/:id/delete', requireAdmin, (req, res) => {
  db.prepare(`UPDATE preaching_plan SET deleted_at=CURRENT_TIMESTAMP WHERE plan_id=?`)
    .run(Number(req.params.id));
  res.redirect('/preaching');
});

app.post('/preaching/:id/remind', requireAdmin, async (req, res) => {
  const plan = db.prepare(`SELECT * FROM preaching_plan WHERE plan_id=? AND deleted_at IS NULL`)
    .get(Number(req.params.id));
  if (!plan) return res.redirect('/preaching');
  const r = await sendPreachingReminder(plan, res.locals.user.user_id);
  if (!r.ok) return res.redirect('/preaching?reminder=nocontact');
  if (!r.hadPhone && !r.hadEmail) return res.redirect('/preaching?reminder=nocontact');
  if (r.dryRun) return res.redirect('/preaching?reminder=dry');
  const delivered = (r.smsOk === true) || (r.emailOk === true);
  return res.redirect('/preaching?reminder=' + (delivered ? 'ok' : 'fail'));
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
  const broadcastCta = res.locals.isAdmin
    ? `<p style="margin-bottom:1rem">
         <a class="btn" href="/communications/broadcast">📣 Send SMS / email broadcast</a>
         <a class="btn ghost" href="/communications/broadcasts">View broadcast history</a>
       </p>` : '';
  res.page({
    title: 'Communications', active: '/communications',
    body: `${broadcastCta}${newForm}<h2>Recent announcements</h2>${list}`,
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

// ---------- communications: bulk SMS + email broadcasts ----------
function resolveAudience(orgIds) {
  // orgIds: array of org IDs, OR an empty array for "All members".
  if (!orgIds || orgIds.length === 0) {
    return db.prepare(
      `SELECT m.member_id, m.first_name||' '||m.last_name AS name,
              m.email, m.mobile_phone, m.preferred_channel, m.unsubscribe_token
       FROM members m
       WHERE m.deleted_at IS NULL
         AND m.membership_status IN ('member','regular','visitor')
       ORDER BY m.last_name`
    ).all();
  }
  const placeholders = orgIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT DISTINCT m.member_id, m.first_name||' '||m.last_name AS name,
            m.email, m.mobile_phone, m.preferred_channel, m.unsubscribe_token
     FROM organization_memberships om
     JOIN members m USING(member_id)
     WHERE om.org_id IN (${placeholders})
       AND m.deleted_at IS NULL
       AND m.membership_status IN ('member','regular','visitor')
     ORDER BY m.last_name`
  ).all(...orgIds);
}

// Decide whether a member can receive a given channel, respecting their preferred_channel.
function canReceive(member, channel) {
  const pref = (member.preferred_channel || 'none');
  if (pref === 'none') return false;
  if (channel === 'sms')   return pref !== 'email_only';
  if (channel === 'email') return pref !== 'sms_only';
  return true;
}

const PREF_LABELS = {
  either:     'Both',
  sms_only:   'SMS only',
  email_only: 'Email only',
  none:       'Do not contact',
};

function parseOrgChoice(b) {
  if (b.all_members === '1') return { allMembers: true, orgIds: [] };
  let raw = b.org_ids;
  if (!raw) return { allMembers: false, orgIds: [] };
  const ids = (Array.isArray(raw) ? raw : [raw]).map((x) => Number(x)).filter(Boolean);
  return { allMembers: false, orgIds: ids };
}

function audienceLabel(orgs, choice) {
  if (choice.allMembers) return 'All members';
  if (!choice.orgIds.length) return 'None';
  const names = orgs.filter((o) => choice.orgIds.includes(o.org_id)).map((o) => o.name);
  return names.length === 1 ? names[0] : names.join(' + ');
}

app.get('/communications/broadcast', requireAdmin, (req, res) => {
  const orgs = loadOrganizations();
  const choice = parseOrgChoice(req.query);
  const audienceChosen = choice.allMembers || choice.orgIds.length > 0;
  const recipients = audienceChosen ? resolveAudience(choice.allMembers ? [] : choice.orgIds) : [];

  // Channel breakdown — already respects preferred_channel.
  let bothCount = 0, smsOnlyCount = 0, emailOnlyCount = 0, noneCount = 0, excludedPref = 0;
  for (const r of recipients) {
    if ((r.preferred_channel || 'none') === 'none') { excludedPref++; continue; }
    const hasPhone = !!normalizePhoneGH(r.mobile_phone) && canReceive(r, 'sms');
    const hasEmail = !!r.email && canReceive(r, 'email');
    if (hasPhone && hasEmail) bothCount++;
    else if (hasPhone) smsOnlyCount++;
    else if (hasEmail) emailOnlyCount++;
    else noneCount++;
  }
  const reachableSms   = bothCount + smsOnlyCount;
  const reachableEmail = bothCount + emailOnlyCount;

  const smsReady    = !!ARKESEL_API_KEY;
  const emailReady  = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
  const statusBanner = (smsReady && emailReady) ? '' :
    `<div class="flash">
       ${smsReady ? '' : '<strong>SMS dry-run mode.</strong> ARKESEL_API_KEY is not set — messages will be logged but not actually sent. '}
       ${emailReady ? '' : '<strong>Email dry-run mode.</strong> SMTP env vars are not configured.'}
     </div>`;

  const audienceForm = `
    <form method="get" action="/communications/broadcast" class="card" style="margin-bottom:1rem">
      <h2 style="margin-top:0">Audience</h2>
      <label class="check" style="background:none;padding:0;margin-bottom:0.5rem">
        <input type="checkbox" name="all_members" value="1" ${choice.allMembers ? 'checked' : ''}>
        <strong>All members</strong> <span class="muted-text">(every active member)</span>
      </label>
      <div class="check-grid" style="opacity:${choice.allMembers ? '0.5' : '1'}">
        ${orgs.map((o) => `
          <label class="check">
            <input type="checkbox" name="org_ids" value="${o.org_id}"
              ${choice.orgIds.includes(o.org_id) ? 'checked' : ''}
              ${choice.allMembers ? 'disabled' : ''}>
            ${esc(o.name)}
          </label>`).join('')}
      </div>
      <div class="actions" style="margin-top:0.75rem"><button type="submit">Load audience</button></div>
    </form>`;

  const previewSection = audienceChosen ? `
    <h2>Audience preview · ${recipients.length} member${recipients.length === 1 ? '' : 's'}</h2>
    <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
      <div class="stat"><div class="ico green">✓</div><div>
        <div class="label">Reachable by SMS</div>
        <div class="value">${reachableSms}</div></div></div>
      <div class="stat"><div class="ico blue">✉</div><div>
        <div class="label">Reachable by email</div>
        <div class="value">${reachableEmail}</div></div></div>
      <div class="stat"><div class="ico purple">📲</div><div>
        <div class="label">Both</div>
        <div class="value">${bothCount}</div></div></div>
      <div class="stat"><div class="ico orange">⚠</div><div>
        <div class="label">No contact info</div>
        <div class="value">${noneCount}</div></div></div>
      <div class="stat"><div class="ico orange">🚫</div><div>
        <div class="label">Excluded (opted out)</div>
        <div class="value">${excludedPref}</div></div></div>
    </div>
    ${recipients.length ? `<details style="margin:0.75rem 0 1rem">
      <summary>Show recipient list</summary>
      ${table(['Name', 'Phone', 'Email', 'Preference'],
        recipients.map((r) => [esc(r.name),
          normalizePhoneGH(r.mobile_phone) || `<span class="muted-text">${esc(r.mobile_phone) || '—'}</span>`,
          esc(r.email) || '<span class="muted-text">—</span>',
          esc(PREF_LABELS[r.preferred_channel || 'none'] || 'Do not contact')]))}
    </details>` : ''}
  ` : '';

  // Hidden inputs to preserve audience selection in the compose form POST.
  const audienceHidden = (choice.allMembers
    ? `<input type="hidden" name="all_members" value="1">`
    : choice.orgIds.map((id) => `<input type="hidden" name="org_ids" value="${id}">`).join(''));

  const composeForm = audienceChosen && recipients.length ? `
    <h2>Compose message</h2>
    <form class="form" method="post" action="/communications/broadcast">
      ${audienceHidden}
      <label>Channel<select name="channel" required>
        <option value="sms">SMS only (${reachableSms})</option>
        <option value="email">Email only (${reachableEmail})</option>
        <option value="both" selected>Both (${reachableSms} SMS · ${reachableEmail} email)</option>
      </select></label>
      <label>Email subject<input name="subject" placeholder="(required for email)"></label>
      <label class="wide">Message body<textarea name="body" rows="5" required maxlength="900"
        placeholder="Keep it under 160 chars for a single SMS."></textarea></label>
      <p class="muted-text wide" style="margin:0">Members with only a phone receive just the SMS; members with only an email receive just the email. Members missing both are skipped.</p>

      <label class="wide check" style="background:var(--danger-soft);padding:0.5rem 0.75rem;border-radius:8px;margin-top:0.5rem">
        <input type="checkbox" name="ignore_prefs" value="1">
        <strong>Override member preferences (urgent only)</strong> — sends to opted-out members too.
        Use sparingly, e.g. funeral / safety notices.
      </label>

      <fieldset class="wide" style="margin-top:0.5rem">
        <legend>Test send (optional)</legend>
        <label class="check" style="background:none;padding:0">
          <input type="checkbox" name="test_only" value="1">
          <strong>Test only — send to the addresses below instead of the audience</strong>
        </label>
        <div class="day-born-grid" style="grid-template-columns:1fr 1fr;margin-top:0.5rem">
          <label>Test phone<input name="test_phone" placeholder="e.g. 0244555001"></label>
          <label>Test email<input name="test_email" type="email" placeholder="e.g. you@example.com"></label>
        </div>
        <p class="muted-text" style="margin:0.4rem 0 0">Once the test arrives correctly, untick the box and send again to deliver to the full audience.</p>
      </fieldset>

      <div class="actions">
        <button type="submit" onclick="return confirm('Send this broadcast?')">📣 Send broadcast</button>
      </div>
    </form>` : '';

  const body = `
    ${statusBanner}
    ${audienceForm}
    ${previewSection}
    ${composeForm}
    <p style="margin-top:1.5rem"><a href="/communications/broadcasts">View broadcast history →</a></p>
  `;
  res.page({ title: 'Send broadcast', active: '/communications', body });
});

app.post('/communications/broadcast', requireAdmin, async (req, res) => {
  const { channel, subject, body } = req.body;
  if (!body || !['sms', 'email', 'both'].includes(channel)) return res.redirect('/communications/broadcast');

  const orgs = loadOrganizations();
  const choice = parseOrgChoice(req.body);
  const testOnly = req.body.test_only === '1';

  // Build the actual audience to send to.
  let audience;
  let audienceLbl;
  let orgIdForRow;
  if (testOnly) {
    const phone = (req.body.test_phone || '').trim();
    const email = (req.body.test_email || '').trim();
    if (!phone && !email) return res.redirect('/communications/broadcast');
    audience = [{
      member_id: null,
      name: 'Test recipient',
      mobile_phone: phone || null,
      email: email || null,
    }];
    audienceLbl = `Test send (${[phone, email].filter(Boolean).join(' / ')})`;
    orgIdForRow = null;
  } else {
    if (!choice.allMembers && choice.orgIds.length === 0) {
      return res.redirect('/communications/broadcast');
    }
    audience = resolveAudience(choice.allMembers ? [] : choice.orgIds);
    if (!audience.length) return res.redirect('/communications/broadcast');
    audienceLbl = audienceLabel(orgs, choice);
    // Only set org_id when exactly one org is selected (schema is single-FK).
    orgIdForRow = (!choice.allMembers && choice.orgIds.length === 1) ? choice.orgIds[0] : null;
  }

  // Create the broadcast row.
  const bres = db.prepare(`
    INSERT INTO broadcasts (channel, audience_label, org_id, subject, body, total_recipients, status, sent_by)
    VALUES (?, ?, ?, ?, ?, ?, 'sending', ?)`).run(
    channel, audienceLbl, orgIdForRow, subject || null, body, audience.length, res.locals.user.user_id
  );
  const broadcastId = bres.lastInsertRowid;
  const orgName = audienceLbl;

  const insRecip = db.prepare(`
    INSERT INTO broadcast_recipients (broadcast_id, member_id, channel, destination, status)
    VALUES (?, ?, ?, ?, ?)`);

  // Build per-channel recipient lists. Respects preferred_channel unless override.
  const ignorePrefs = req.body.ignore_prefs === '1';
  const smsList = [];   // {member_id, phone}
  const emailList = []; // {member_id, addr, token}
  for (const m of audience) {
    const prefAllowsSms   = ignorePrefs || canReceive(m, 'sms');
    const prefAllowsEmail = ignorePrefs || canReceive(m, 'email');
    if (channel === 'sms' || channel === 'both') {
      if (!prefAllowsSms) {
        insRecip.run(broadcastId, m.member_id, 'sms', m.mobile_phone || '', 'skipped');
      } else {
        const phone = normalizePhoneGH(m.mobile_phone);
        if (phone) smsList.push({ member_id: m.member_id, phone });
        else insRecip.run(broadcastId, m.member_id, 'sms', m.mobile_phone || '', 'skipped');
      }
    }
    if (channel === 'email' || channel === 'both') {
      if (!prefAllowsEmail) {
        insRecip.run(broadcastId, m.member_id, 'email', m.email || '', 'skipped');
      } else if (m.email) {
        emailList.push({ member_id: m.member_id, addr: m.email, token: m.unsubscribe_token });
      } else {
        insRecip.run(broadcastId, m.member_id, 'email', m.email || '', 'skipped');
      }
    }
  }

  let smsRes = null, emailRes = null;
  if (smsList.length) {
    try {
      smsRes = await sendSmsBatch(smsList.map((s) => s.phone), body);
    } catch (e) { smsRes = { ok: false, error: e.message }; }
    const status = smsRes && smsRes.dryRun ? 'pending' : (smsRes && smsRes.ok ? 'sent' : 'failed');
    const errText = smsRes && smsRes.dryRun ? 'dry run' : (smsRes && smsRes.error) || null;
    const now = new Date().toISOString();
    for (const s of smsList) insRecip.run(broadcastId, s.member_id, 'sms', s.phone, status);
    if (status === 'sent' || status === 'pending') {
      db.prepare(`UPDATE broadcast_recipients SET sent_at=? WHERE broadcast_id=? AND channel='sms' AND status=?`)
        .run(now, broadcastId, status);
    }
    if (errText) {
      db.prepare(`UPDATE broadcast_recipients SET error=? WHERE broadcast_id=? AND channel='sms'`)
        .run(errText, broadcastId);
    }
  }

  if (emailList.length && (channel === 'email' || channel === 'both')) {
    const emailSubject = subject || (orgName ? `Message from ${CHURCH_NAME}` : `Message from ${CHURCH_NAME}`);
    try {
      emailRes = await sendEmailEach(emailList, emailSubject, body);
    } catch (e) { emailRes = { ok: false, error: e.message }; }
    const status = emailRes && emailRes.dryRun ? 'pending' : (emailRes && emailRes.ok ? 'sent' : 'failed');
    const errText = emailRes && emailRes.dryRun ? 'dry run' : (emailRes && emailRes.error) || null;
    const now = new Date().toISOString();
    for (const e of emailList) insRecip.run(broadcastId, e.member_id, 'email', e.addr, status);
    if (status === 'sent' || status === 'pending') {
      db.prepare(`UPDATE broadcast_recipients SET sent_at=? WHERE broadcast_id=? AND channel='email' AND status=?`)
        .run(now, broadcastId, status);
    }
    if (errText) {
      db.prepare(`UPDATE broadcast_recipients SET error=? WHERE broadcast_id=? AND channel='email'`)
        .run(errText, broadcastId);
    }
  }

  // Tally up.
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status='sent'    THEN 1 ELSE 0 END) AS s,
      SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS f,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS p
    FROM broadcast_recipients WHERE broadcast_id=?`).get(broadcastId);

  const dryRun = (smsRes && smsRes.dryRun) || (emailRes && emailRes.dryRun);
  const finalStatus = dryRun
    ? 'dry_run'
    : (counts.f > 0 && counts.s === 0 ? 'failed' : 'sent');

  db.prepare(`
    UPDATE broadcasts SET successful_sends=?, failed_sends=?, status=?
    WHERE broadcast_id=?`).run(counts.s || 0, counts.f || 0, finalStatus, broadcastId);

  logActivity('announcement',
    `Broadcast to ${orgName}: ${audience.length} recipient(s) [${finalStatus}]`,
    `/communications/broadcasts/${broadcastId}`, res.locals.user.user_id);
  res.redirect(`/communications/broadcasts/${broadcastId}`);
});

app.get('/communications/broadcasts', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, COALESCE(u.display_name, u.username) AS sender
    FROM broadcasts b LEFT JOIN users u ON u.user_id=b.sent_by
    ORDER BY b.sent_at DESC LIMIT 100`).all();
  const body = `
    <p><a class="btn" href="/communications/broadcast">📣 Compose new broadcast</a></p>
    ${rows.length ? table(['Sent', 'Channel', 'Audience', 'Recipients', '✓ sent', '✗ failed', 'Status', 'By'],
      rows.map((b) => [esc(b.sent_at.slice(0, 16).replace('T', ' ')),
        esc(b.channel),
        `<a href="/communications/broadcasts/${b.broadcast_id}">${esc(b.audience_label)}</a>`,
        b.total_recipients,
        b.successful_sends,
        b.failed_sends,
        `<span class="pill pill-${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span>`,
        esc(b.sender)]))
      : '<p class="muted-text">No broadcasts sent yet.</p>'}`;
  res.page({ title: 'Broadcast history', active: '/communications', body });
});

app.get('/communications/broadcasts/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare(`
    SELECT b.*, COALESCE(u.display_name, u.username) AS sender,
           o.name AS org_name
    FROM broadcasts b
    LEFT JOIN users u ON u.user_id=b.sent_by
    LEFT JOIN organizations o ON o.org_id=b.org_id
    WHERE b.broadcast_id=?`).get(id);
  if (!b) return res.status(404).send('Not found');
  const recipients = db.prepare(`
    SELECT r.*, m.first_name || ' ' || m.last_name AS name
    FROM broadcast_recipients r
    LEFT JOIN members m ON m.member_id=r.member_id
    WHERE r.broadcast_id=?
    ORDER BY r.status DESC, m.last_name`).all(id);
  const body = `
    <div class="card">
      <div class="card-head">
        <h2>${esc(b.audience_label)} · ${esc(b.channel)}</h2>
        <span class="meta">${esc(b.sent_at.slice(0, 16).replace('T', ' '))} · by ${esc(b.sender)}</span>
      </div>
      <dl class="stats">
        <dt>Status</dt><dd><span class="pill pill-${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></dd>
        <dt>Recipients</dt><dd>${b.total_recipients} (${b.successful_sends} sent, ${b.failed_sends} failed)</dd>
        ${b.subject ? `<dt>Subject</dt><dd>${esc(b.subject)}</dd>` : ''}
      </dl>
      <h3>Message</h3>
      <pre style="white-space:pre-wrap;background:var(--soft);padding:0.75rem;border-radius:8px">${esc(b.body)}</pre>
    </div>
    <h2>Per-recipient log</h2>
    ${table(['Name', 'Channel', 'Destination', 'Status', 'Error'],
      recipients.map((r) => [esc(r.name) || '—', esc(r.channel),
        esc(r.destination) || '<span class="muted-text">—</span>',
        `<span class="pill pill-${esc(r.status)}">${esc(r.status)}</span>`,
        esc(r.error) || '']))}`;
  res.page({ title: 'Broadcast detail', active: '/communications', body });
});

// ---------- public unsubscribe (no auth) ----------
app.get('/u/:token', (req, res) => {
  const m = db.prepare(
    `SELECT member_id, first_name, last_name, preferred_channel
       FROM members WHERE unsubscribe_token = ? AND deleted_at IS NULL`
  ).get(req.params.token);
  if (!m) {
    return res.status(404).send(layout({
      title: 'Link not recognized', bare: true,
      body: '<p>This unsubscribe link is invalid or has been revoked. If you continue to receive messages you do not want, please contact the church office.</p>',
    }));
  }
  const already = m.preferred_channel === 'none';
  res.send(layout({
    title: already ? 'You are already unsubscribed' : 'Confirm unsubscribe',
    bare: true,
    body: `
      <p>Hello ${esc(m.first_name)},</p>
      ${already
        ? '<p>You are already opted out of bulk SMS and email broadcasts from us.</p>'
        : `<p>Click the button below to stop receiving bulk SMS and email broadcasts from <strong>${esc(CHURCH_NAME)}</strong>. Your member record stays on file; we just stop messaging you.</p>
           <form method="post" action="/u/${esc(req.params.token)}">
             <button type="submit">Yes, unsubscribe me</button>
           </form>`}
      <p style="margin-top:1rem"><a href="${esc(PUBLIC_URL) || '/'}">Back to the website</a></p>
    `,
  }));
});

app.post('/u/:token', (req, res) => {
  const result = db.prepare(
    `UPDATE members SET preferred_channel = 'none'
       WHERE unsubscribe_token = ? AND deleted_at IS NULL`
  ).run(req.params.token);
  if (result.changes === 0) {
    return res.status(404).send(layout({ title: 'Link not recognized', bare: true,
      body: '<p>This unsubscribe link is invalid.</p>' }));
  }
  logActivity('announcement', 'A member unsubscribed via email link', null, null);
  res.send(layout({
    title: 'You have been unsubscribed', bare: true,
    body: `<p>You will no longer receive bulk SMS or email from <strong>${esc(CHURCH_NAME)}</strong>. If you change your mind, please contact the church office.</p>`,
  }));
});

// ---------- Arkesel inbound webhook (STOP keyword) ----------
app.use('/webhooks', express.json());
app.post('/webhooks/arkesel-inbound', (req, res) => {
  // Arkesel sends a JSON payload; the field names vary slightly between
  // 2-way SMS plans. We accept several shapes.
  const b = req.body || {};
  const from = b.from || b.sender || b.msisdn || b.phone || b.source || '';
  const text = (b.text || b.message || b.content || b.body || '').toString().trim();
  if (!from) return res.status(400).json({ ok: false, error: 'missing sender' });
  if (!/^stop$|^stop all$|^unsubscribe$|^cancel$/i.test(text)) {
    return res.json({ ok: true, action: 'ignored' });
  }
  const incoming = normalizePhoneGH(from);
  if (!incoming) return res.json({ ok: true, action: 'ignored', reason: 'unparseable phone' });
  // Compare normalized forms — stored phones may include dashes/spaces.
  const rows = db.prepare(
    `SELECT member_id, first_name, mobile_phone FROM members WHERE deleted_at IS NULL AND mobile_phone IS NOT NULL`
  ).all();
  const member = rows.find((r) => normalizePhoneGH(r.mobile_phone) === incoming);
  if (member) {
    db.prepare(`UPDATE members SET preferred_channel='none' WHERE member_id=?`).run(member.member_id);
    logActivity('announcement',
      `Member ${member.first_name} (#${member.member_id}) opted out via SMS STOP`,
      `/members/${member.member_id}`, null);
    return res.json({ ok: true, action: 'unsubscribed', member_id: member.member_id });
  }
  res.json({ ok: true, action: 'no_match', phone: incoming });
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
app.post('/settings/birthdays/run', requireOwner, async (req, res) => {
  try {
    const result = await sendBirthdayBatch({ manual: true, userId: res.locals.user.user_id });
    if (result.broadcastId) return res.redirect(`/communications/broadcasts/${result.broadcastId}`);
  } catch (e) { console.error('birthday manual run failed:', e.message); }
  res.redirect('/settings');
});

// ---------- backups & restore ----------
function backupName(req) {
  const name = String(req.params.name || '');
  if (!/^church-\d+\.db$/.test(name)) return null;
  return listBackups().some((b) => b.name === name) ? name : null;
}

app.get('/backups', requireOwner, (req, res) => {
  const backups = listBackups();
  const totalSize = backups.reduce((s, b) => s + b.size, 0);
  const latest = backups[0] ? backups[0].mtime.toLocaleString('en-GB') : 'never';
  const rows = backups.length
    ? `<table class="data-table members-table">
        <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${backups.map((b) => `<tr>
          <td data-label="Backup"><span class="m-name">${esc(b.name)}</span></td>
          <td data-label="Size">${fmtBytes(b.size)}</td>
          <td data-label="Created">${b.mtime.toLocaleString('en-GB')}</td>
          <td data-label="Actions"><div class="row-actions" style="gap:0.5rem">
            <a class="btn ghost" href="/backups/${encodeURIComponent(b.name)}/download">⬇ Download</a>
            <form method="post" action="/backups/${encodeURIComponent(b.name)}/restore"
                  onsubmit="return confirm('Restore from ${esc(b.name)}? The current database is copied aside and replaced when the app next restarts. This cannot be undone.')">
              <button class="btn" type="submit">♻ Restore</button></form>
            <form method="post" action="/backups/${encodeURIComponent(b.name)}/delete"
                  onsubmit="return confirm('Delete ${esc(b.name)}?')">
              <button class="icon-btn del" type="submit" title="Delete" aria-label="Delete">${ICON_TRASH}</button></form>
          </div></td>
        </tr>`).join('')}</tbody>
      </table>`
    : '<div class="empty-state"><div class="empty-ico">💾</div><p>No backups yet. Create one below.</p></div>';

  const tools = `
    <div class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Create &amp; restore</h2></div>
      <div class="filter-bar">
        <form method="post" action="/backups/create"><button type="submit">＋ Create backup now</button></form>
        <form method="post" action="/backups/restore-upload" enctype="multipart/form-data" class="filter-bar" style="margin:0"
              onsubmit="return confirm('Restore from the uploaded file on next restart? The current database is copied aside first.')">
          <input type="file" name="backup" accept=".db,.sqlite,application/octet-stream" required>
          <button class="ghost" type="submit">Upload &amp; stage restore</button>
        </form>
      </div>
      <p class="muted-text" style="margin:0.6rem 0 0">Restores are applied safely on the next app restart. Keep downloaded copies off-site.</p>
    </div>`;

  res.page({
    title: 'Backups', active: '/backups', noHeader: true,
    body: `${pageHero('Backups & Restore', 'Snapshots of the church database. Download copies for safe-keeping, or restore from one.')}
      ${statsRow([
        { cls: 'gold', icon: '💾', value: backups.length.toLocaleString(), label: 'Backups Kept' },
        { cls: 'green', icon: '🕒', value: latest, label: 'Latest Backup' },
        { cls: 'blue', icon: '#', value: fmtBytes(totalSize), label: 'Total Size' },
      ])}
      ${tools}
      ${listCard({ title: '💾 Available Backups', count: backups.length, countLabel: 'files', inner: rows })}`,
  });
});

app.post('/backups/create', requireOwner, async (req, res) => {
  try { const name = await createBackup(); flash(req, `Backup created: ${name}`, 'success'); }
  catch (e) { flash(req, `Backup failed: ${e.message}`); }
  res.redirect('/backups');
});

app.get('/backups/:name/download', requireOwner, (req, res) => {
  const name = backupName(req);
  if (!name) return res.status(404).send('Backup not found');
  res.download(path.join(BACKUP_DIR, name), name);
});

app.post('/backups/:name/delete', requireOwner, (req, res) => {
  const name = backupName(req);
  if (!name) { flash(req, 'Backup not found.'); return res.redirect('/backups'); }
  try { fs.unlinkSync(path.join(BACKUP_DIR, name)); flash(req, `Deleted ${name}.`, 'success'); }
  catch (e) { flash(req, `Could not delete: ${e.message}`); }
  res.redirect('/backups');
});

app.post('/backups/:name/restore', requireOwner, (req, res) => {
  const name = backupName(req);
  if (!name) { flash(req, 'Backup not found.'); return res.redirect('/backups'); }
  try {
    fs.copyFileSync(path.join(BACKUP_DIR, name), RESTORE_PENDING);
    flash(req, `Restore from ${name} is staged. Restart the app to apply it.`, 'info');
  } catch (e) { flash(req, `Could not stage restore: ${e.message}`); }
  res.redirect('/backups');
});

app.post('/backups/restore-upload', requireOwner, dbUpload.single('backup'), (req, res) => {
  if (!csrfValid(req)) return res.status(403).send(layout({ title: 'Security check failed', user: res.locals.user, active: null, body: '<p>Stale form. Go back and try again.</p>' }));
  if (!req.file || !isSqliteBuffer(req.file.buffer)) { flash(req, 'That file is not a valid SQLite database.'); return res.redirect('/backups'); }
  try {
    fs.writeFileSync(RESTORE_PENDING, req.file.buffer);
    flash(req, 'Uploaded database is staged for restore. Restart the app to apply it.', 'info');
  } catch (e) { flash(req, `Could not stage restore: ${e.message}`); }
  res.redirect('/backups');
});

app.get('/settings', requireOwner, (req, res) => {
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
      <h2>Maintenance</h2>
      <p>Snapshots and restore on the <a href="/backups">Backups</a> page · recent server errors in the <a href="/errors">Error Log</a>.</p>
    </div>
    <div class="card">
      <h2>SMS &amp; Email</h2>
      <dl class="stats">
        <dt>SMS provider</dt><dd>Arkesel — <span class="pill pill-${ARKESEL_API_KEY ? 'sent' : 'dry_run'}">${ARKESEL_API_KEY ? 'configured' : 'dry-run'}</span></dd>
        <dt>SMS sender ID</dt><dd><code>${esc(ARKESEL_SENDER)}</code></dd>
        <dt>SMTP host</dt><dd>${SMTP_HOST ? `<code>${esc(SMTP_HOST)}:${SMTP_PORT}</code> <span class="pill pill-${SMTP_USER && SMTP_PASS ? 'sent' : 'dry_run'}">${SMTP_USER && SMTP_PASS ? 'configured' : 'dry-run'}</span>` : '<span class="pill pill-dry_run">not configured</span>'}</dd>
        <dt>From address</dt><dd>${esc(SMTP_FROM) || '<span class="muted-text">unset</span>'}</dd>
      </dl>
      <h3>Configure on Fly</h3>
      <pre>flyctl secrets set \\
  ARKESEL_API_KEY="your-arkesel-api-key" \\
  ARKESEL_SENDER="DUNWELL" \\
  SMTP_HOST="smtp.gmail.com" \\
  SMTP_PORT="465" \\
  SMTP_USER="your.address@gmail.com" \\
  SMTP_PASS="your-16-char-app-password" \\
  SMTP_FROM="Dunwell Methodist &lt;your.address@gmail.com&gt;"</pre>
      <p class="muted-text">For Gmail, generate an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">App Password</a> — your normal password will not work.</p>
    </div>
    <div class="card">
      <h2>Birthday automation</h2>
      <dl class="stats">
        <dt>Daily run time</dt><dd>${BIRTHDAY_HOUR}:00 (server time)</dd>
        <dt>Last run</dt><dd>${esc(getState('last_birthday_send') || '—')}</dd>
        <dt>Today's eligible</dt><dd>${todaysBirthdayMembers().length} member(s)</dd>
        <dt>Template</dt><dd><code>${esc(BIRTHDAY_TEMPLATE)}</code></dd>
      </dl>
      <p>The system sends a personalized SMS to every member whose birthday matches today's date, has a phone, and hasn't opted out. To customize the message, set the <code>BIRTHDAY_TEMPLATE</code> env var. Tokens: <code>{first_name}</code>, <code>{last_name}</code>, <code>{church_name}</code>.</p>
      <form method="post" action="/settings/birthdays/run">
        <button type="submit">🎂 Send today's birthday messages now</button>
      </form>
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
app.get('/users', requireOwner, (req, res) => {
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
         <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin (full access)</option>
         <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>editor (manage records)</option>
         <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>viewer (read-only)</option>
       </select>
       <button type="submit">Save</button>
     </form>
     ${res.locals.isUserManager
       ? `<form method="post" action="/users/${u.user_id}/reset" class="inline">
            <input type="password" name="password" placeholder="new password" minlength="8" required>
            <button type="submit">Reset</button>
          </form>`
       : ''}
     ${(res.locals.isUserManager && u.user_id !== res.locals.user.user_id)
       ? `<form method="post" action="/users/${u.user_id}/delete" class="inline"
            onsubmit="return confirm('Delete ${esc(u.username)}?')">
            <button class="danger" type="submit">Delete</button>
          </form>`
       : ''}`,
  ]);
  const body = `
    <p class="muted-text">Any administrator can set a user's access level (read/write jurisdiction):
      <strong>Admin</strong> = full read &amp; write; <strong>Viewer</strong> = read-only.
      Only the main administrator (<strong>dunwelladmin</strong>) can add or delete user accounts and reset passwords.</p>
    ${res.locals.isUserManager ? '<p><a class="btn" href="/users/new">+ New user</a></p>' : ''}
    ${table(['Username', 'Display name', 'Role', 'Created', 'Actions'], rows)}`;
  res.page({ title: 'Users', body });
});

app.get('/users/new', requireUserManager, (req, res) => {
  const body = `
    <form class="form" method="post" action="/users">
      <label>Username<input name="username" required></label>
      <label>Display name<input name="display_name"></label>
      <label>Password<input type="password" name="password" required minlength="8"></label>
      <label>Role<select name="role">
        <option value="admin">admin (full access)</option>
        <option value="editor">editor (manage records)</option>
        <option value="viewer" selected>viewer (read-only)</option>
      </select>
      <span class="hint">Admins manage everything incl. users, backups &amp; settings. Editors manage records but not those admin areas. Viewers are read-only.</span></label>
      <div class="actions"><button type="submit">Create user</button></div>
    </form>`;
  res.page({ title: 'New user', body });
});

app.post('/users', requireUserManager, (req, res) => {
  const { username, display_name, password, role } = req.body;
  if (!username || !password || password.length < 8) return res.redirect('/users/new');
  const r = ['admin', 'editor', 'viewer'].includes(role) ? role : 'viewer';
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

app.post('/users/:id/role', requireOwner, (req, res) => {
  const id = Number(req.params.id);
  const r = ['admin', 'editor', 'viewer'].includes(req.body.role) ? req.body.role : 'viewer';
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

app.post('/users/:id/reset', requireUserManager, (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body;
  if (!password || password.length < 8) return res.redirect('/users');
  db.prepare(`UPDATE users SET password_hash=? WHERE user_id=?`)
    .run(bcrypt.hashSync(password, 12), id);
  res.redirect('/users');
});

app.post('/users/:id/delete', requireUserManager, (req, res) => {
  const id = Number(req.params.id);
  if (id === res.locals.user.user_id) return res.redirect('/users');
  const admins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin'`).get().c;
  const target = db.prepare(`SELECT role FROM users WHERE user_id=?`).get(id);
  if (target && target.role === 'admin' && admins <= 1) return res.redirect('/users');
  db.prepare(`UPDATE users SET deleted_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(id);
  res.redirect('/users');
});

// ---------- auth pages ----------

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

// In-memory login throttle: max attempts per IP within a rolling window.
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginHits = new Map();
function loginBlocked(ip) {
  const e = loginHits.get(ip);
  return !!e && (Date.now() - e.first) < LOGIN_WINDOW_MS && e.count >= LOGIN_MAX;
}
function noteLoginFail(ip) {
  const now = Date.now();
  const e = loginHits.get(ip);
  if (!e || now - e.first >= LOGIN_WINDOW_MS) loginHits.set(ip, { count: 1, first: now });
  else e.count += 1;
}

app.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) {
    return res.status(429).send(authPage('Too many attempts',
      '<p class="error">Too many sign-in attempts. Please wait a few minutes and try again.</p>'
      + '<p><a href="/login">Back to sign in</a></p>'));
  }
  const { username, password } = req.body;
  const user = db.prepare(
    `SELECT user_id, password_hash FROM users WHERE username = ? AND deleted_at IS NULL`
  ).get((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    noteLoginFail(ip);
    return res.redirect('/login?e=1');
  }
  loginHits.delete(ip);
  req.session.userId = user.user_id;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- error tracking ----------
app.get('/errors', requireOwner, (req, res) => {
  const rows = db.prepare(`SELECT error_id, occurred_at, method, path, message
    FROM error_log ORDER BY error_id DESC LIMIT 100`).all();
  const inner = rows.length
    ? `<table class="data-table">
        <thead><tr><th>When</th><th>Request</th><th>Message</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td data-label="When">${esc(r.occurred_at)}</td>
          <td data-label="Request"><code>${esc(r.method || '')} ${esc(r.path || '')}</code></td>
          <td data-label="Message">${esc(r.message || '')}</td>
        </tr>`).join('')}</tbody></table>`
    : '<div class="empty-state"><div class="empty-ico">✓</div><p>No errors logged. All clear.</p></div>';
  res.page({
    title: 'Error Log', active: null, noHeader: true,
    body: `${pageHero('Error Log', 'The 100 most recent server errors captured by the app.')}
      ${listCard({ title: '⚠ Recent Errors', count: rows.length, countLabel: 'logged', inner })}`,
  });
});
app.post('/errors/clear', requireOwner, (req, res) => {
  db.prepare(`DELETE FROM error_log`).run();
  flash(req, 'Error log cleared.', 'success');
  res.redirect('/errors');
});

// Test-only route to exercise the global error handler (never registered in prod).
if (process.env.NODE_ENV === 'test') {
  app.get('/__throw', () => { throw new Error('boom for tests'); });
}

// 404 for unmatched routes.
app.use((req, res) => {
  res.status(404).send(layout({
    title: 'Page not found', user: res.locals.user, active: null,
    body: '<p>That page does not exist.</p><p><a href="/">Back to dashboard</a></p>',
  }));
});

// Global error handler: log to console + error_log, show a friendly page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', req.method, req.path, '-', err && err.message);
  try {
    db.prepare(`INSERT INTO error_log (method, path, message, stack, user_id) VALUES (?, ?, ?, ?, ?)`)
      .run(req.method, req.path, String(err && err.message || err).slice(0, 500),
           String(err && err.stack || '').slice(0, 4000),
           res.locals.user ? res.locals.user.user_id : null);
  } catch (_) { /* never let logging throw */ }
  if (res.headersSent) return;
  res.status(500).send(layout({
    title: 'Something went wrong', user: res.locals.user, active: null,
    body: '<p>An unexpected error occurred and has been logged. Please try again.</p>'
        + '<p><a href="/">Back to dashboard</a></p>',
  }));
});

// ---------- start ----------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Church Manager running at http://localhost:${PORT}`);
  });
}

module.exports = app;
