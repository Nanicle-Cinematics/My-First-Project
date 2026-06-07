const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
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
const PREF_LABELS = { either: 'Both', sms_only: 'SMS only', email_only: 'Email only', none: 'Do not contact' };

function validateEnvironment(env) {
  const required = ['SESSION_SECRET'];
  const missing = required.filter((name) => !env[name] || !String(env[name]).trim());
  if (missing.length && env.NODE_ENV !== 'test') {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
validateEnvironment(process.env);

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
  CREATE TABLE IF NOT EXISTS security_audit_log (
    audit_id    INTEGER PRIMARY KEY,
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_id    INTEGER REFERENCES users(user_id),
    event       TEXT NOT NULL,
    subject     TEXT,
    ip          TEXT,
    user_agent  TEXT
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
addColumnIfMissing('inventory_items', 'acquired_on',`acquired_on TEXT`);
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

db.exec(`CREATE TABLE IF NOT EXISTS email_settings (
  setting_id          INTEGER PRIMARY KEY CHECK (setting_id = 1),
  provider            TEXT NOT NULL DEFAULT 'smtp' CHECK (provider IN ('smtp', 'resend')),
  sender_name         TEXT NOT NULL DEFAULT '',
  sender_email        TEXT NOT NULL DEFAULT '',
  reply_to_email      TEXT NOT NULL DEFAULT '',
  test_recipient_email TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
db.exec(`CREATE TABLE IF NOT EXISTS email_logs (
  email_log_id   INTEGER PRIMARY KEY,
  occurred_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recipient      TEXT NOT NULL,
  subject        TEXT NOT NULL,
  status         TEXT NOT NULL,
  sent_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error_message  TEXT,
  provider       TEXT,
  sender_name    TEXT,
  sender_email   TEXT,
  reply_to_email TEXT
);`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_email_logs_recent ON email_logs(occurred_at DESC)`); } catch (_) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status)`); } catch (_) {}
db.prepare(`
  INSERT OR IGNORE INTO email_settings
    (setting_id, provider, sender_name, sender_email, reply_to_email, test_recipient_email)
  VALUES (1, 'smtp', ?, ?, ?, ?)
`).run(CHURCH_NAME, process.env.SMTP_USER || '', process.env.SMTP_USER || '', '');

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
  acquired_on TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_inventory_active ON inventory_items(deleted_at);`);
// Inventory categories — startup self-heal guard.
db.exec(`CREATE TABLE IF NOT EXISTS inventory_categories (
  category_id  INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_inventory_categories_active ON inventory_categories(deleted_at);`);

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
  ['Friday Service',    'Friday evening service'],
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
  "Girl's Fellowship",
  "Ushers",
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
app.use((req, res, next) => {
  const started = Date.now();
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => {
    const entry = {
      ts: new Date().toISOString(),
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - started,
      user_id: res.locals && res.locals.user ? res.locals.user.user_id : null,
    };
    console.log(JSON.stringify(entry));
  });
  next();
});

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

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.get('/readyz', (req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.status(200).json({ status: 'ready', db: 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'not-ready', db: 'error', error: 'database unavailable' });
  }
});

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
  if (req.path === '/login' || req.path === '/logout' || req.path === '/forgot') return next();
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
  ['/sacraments',      'Sacraments',     '⛪'],
  ['/communications',  'Communications', '✉'],
  ['/reports',         'Reports',        '📊'],
  ['/operations',      'Operations',     '◎', 'admin'],
  ['/users',           'Users & Roles',  '🔑', 'admin'],
  ['/security/audit',  'Security Audit', '🛡', 'admin'],
  ['/backups',         'Backups',        '💾', 'admin'],
  ['/errors',          'Error Log',      '⚠', 'admin'],
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
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_API_URL = 'https://api.resend.com/emails';

let smtpTransporter = null;
function getMailer() {
  if (smtpTransporter || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return smtpTransporter;
  const nodemailer = require('nodemailer');
  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return smtpTransporter;
}

function loadEmailSettings() {
  const row = db.prepare(`SELECT * FROM email_settings WHERE setting_id=1`).get();
  return row || {
    setting_id: 1,
    provider: 'smtp',
    sender_name: CHURCH_NAME,
    sender_email: SMTP_USER || '',
    reply_to_email: SMTP_USER || '',
    test_recipient_email: '',
  };
}

function emailSenderHeader(settings) {
  const senderName = (settings && settings.sender_name ? String(settings.sender_name) : CHURCH_NAME).trim() || CHURCH_NAME;
  const senderEmail = (settings && settings.sender_email ? String(settings.sender_email) : SMTP_USER).trim();
  return senderEmail ? `${senderName} <${senderEmail}>` : senderName;
}

function emailDeliveryInfo(settings = loadEmailSettings()) {
  const provider = String((settings && settings.provider) || 'smtp').toLowerCase();
  if (provider === 'resend') {
    return {
      provider: 'resend',
      ready: !!RESEND_API_KEY,
      secretLabel: 'RESEND_API_KEY',
      senderHeader: emailSenderHeader(settings),
      senderName: (settings && settings.sender_name ? String(settings.sender_name) : CHURCH_NAME).trim() || CHURCH_NAME,
      senderEmail: (settings && settings.sender_email ? String(settings.sender_email) : SMTP_USER).trim(),
      replyToEmail: (settings && settings.reply_to_email ? String(settings.reply_to_email) : SMTP_USER).trim(),
    };
  }
  return {
    provider: 'smtp',
    ready: !!(SMTP_HOST && SMTP_USER && SMTP_PASS),
    secretLabel: 'SMTP_HOST / SMTP_USER / SMTP_PASS',
    senderHeader: emailSenderHeader(settings),
    senderName: (settings && settings.sender_name ? String(settings.sender_name) : CHURCH_NAME).trim() || CHURCH_NAME,
    senderEmail: (settings && settings.sender_email ? String(settings.sender_email) : SMTP_USER).trim(),
    replyToEmail: (settings && settings.reply_to_email ? String(settings.reply_to_email) : SMTP_USER).trim(),
  };
}

function logEmailAttempt({ recipient, subject, status, sentAt, errorMessage, provider, senderName, senderEmail, replyToEmail }) {
  try {
    db.prepare(`
      INSERT INTO email_logs
        (recipient, subject, status, sent_at, error_message, provider, sender_name, sender_email, reply_to_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recipient || '',
      subject || '',
      status || 'failed',
      sentAt || new Date().toISOString(),
      errorMessage || null,
      provider || null,
      senderName || null,
      senderEmail || null,
      replyToEmail || null
    );
  } catch (_) {}
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
  const settings = opts.settings || loadEmailSettings();
  const delivery = emailDeliveryInfo(settings);
  const senderHeader = opts.from || delivery.senderHeader || SMTP_FROM;
  const replyTo = opts.replyTo || delivery.replyToEmail || '';
  const now = new Date().toISOString();
  if (!delivery.ready) {
    for (const r of recipients) {
      logEmailAttempt({
        recipient: r.addr,
        subject,
        status: 'dry_run',
        sentAt: now,
        errorMessage: `Email provider not configured (${delivery.secretLabel})`,
        provider: delivery.provider,
        senderName: delivery.senderName,
        senderEmail: delivery.senderEmail,
        replyToEmail: replyTo || null,
      });
    }
    return { ok: false, dryRun: true, total: recipients.length, provider: delivery.provider };
  }
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
      if (delivery.provider === 'resend') {
        const payload = {
          from: senderHeader,
          to: r.addr,
          subject,
          text: body + footer,
        };
        if (replyTo) payload.reply_to = replyTo;
        const res = await fetch(RESEND_API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        const raw = await res.text();
        if (!res.ok) throw new Error(raw || `HTTP ${res.status}`);
      } else {
        const mailer = getMailer();
        if (!mailer) throw new Error('SMTP transporter unavailable');
        await mailer.sendMail({
          from: senderHeader,
          to: r.addr,
          subject,
          text: body + footer,
          replyTo: replyTo || undefined,
        });
      }
      sent++;
      logEmailAttempt({
        recipient: r.addr,
        subject,
        status: 'sent',
        sentAt: new Date().toISOString(),
        provider: delivery.provider,
        senderName: delivery.senderName,
        senderEmail: delivery.senderEmail,
        replyToEmail: replyTo || null,
      });
    } catch (e) {
      failed++; errors.push(e.message);
      logEmailAttempt({
        recipient: r.addr,
        subject,
        status: 'failed',
        sentAt: new Date().toISOString(),
        errorMessage: e.message,
        provider: delivery.provider,
        senderName: delivery.senderName,
        senderEmail: delivery.senderEmail,
        replyToEmail: replyTo || null,
      });
    }
  }
  return { ok: failed === 0, sent, failed, errors, provider: delivery.provider };
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

function logSecurityEvent(req, event, subject, actorId) {
  try {
    db.prepare(
      `INSERT INTO security_audit_log (actor_id, event, subject, ip, user_agent)
       VALUES (?, ?, ?, ?, ?)`
    ).run(actorId || null, event, subject || null, req.ip || null, req.headers['user-agent'] || null);
  } catch (_) { /* table may not exist on very old DBs */ }
}

// ---------- shared view/component builders (see lib/views.js) ----------
const {
  flashHtml, pageHero, heroStat, statsRow, filterCard, listCard, table, pager,
  ICON_EYE, ICON_PENCIL, ICON_TRASH, memberAvatar,
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

  const akanByDay = {
    Monday: { names: 'Adwoa / Kwadwo', leader: 'Group steward pending' },
    Tuesday: { names: 'Abena / Kwabena', leader: 'Group steward pending' },
    Wednesday: { names: 'Akua / Kwaku', leader: 'Group steward pending' },
    Thursday: { names: 'Yaa / Yaw', leader: 'Group steward pending' },
    Friday: { names: 'Afia / Kofi', leader: 'Group steward pending' },
    Saturday: { names: 'Ama / Kwame', leader: 'Group steward pending' },
    Sunday: { names: 'Akosua / Kwasi', leader: 'Group steward pending' },
  };
  const dayCounts = new Map(db.prepare(`
    SELECT day_born, COUNT(*) c
    FROM members
    WHERE deleted_at IS NULL AND day_born IS NOT NULL AND day_born <> ''
    GROUP BY day_born`).all().map((r) => [r.day_born, r.c]));

  const trendDelta = (n) => n == null ? '' :
    `<div class="trend ${n < 0 ? 'down' : ''}">${n >= 0 ? '↑' : '↓'} ${Math.abs(n)}% from last period</div>`;

  const cardAttrs = (href, label) =>
    `data-card-href="${esc(href)}" aria-label="${esc(label)}"`;
  const statCard = (cls, icon, label, value, trend, spark, color, href) => `
    <div class="stat dashboard-clickable" ${cardAttrs(href, label)}>
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
        `<div class="trend">↑ ${newMembersThisMonth} this month</div>`, memberSeries, 'var(--purple)', '/members')}
      ${statCard('green', '✓', 'Sunday Attendance', sundayAttendance,
        trendDelta(attendanceDelta), attendanceSpark, 'var(--green)', '/attendance')}
      ${statCard('amber', '₵', 'Offerings This Month', fmtMoney(offeringsThisMonth),
        trendDelta(offeringsDelta), givingSeries, 'var(--gold)', '/finance')}
      ${statCard('blue', '🚶', 'Visitors This Month', visitorsThisMonth,
        `<div class="trend">↑ ${visitorsThisWeek} new this week</div>`, visitorSeries, 'var(--blue)', '/members?status=visitor')}
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
    <div class="card landscape-card activity-card dashboard-clickable" ${cardAttrs('/reports', 'Recent Activities')}>
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
    <div class="card landscape-card giving-overview-card dashboard-clickable" ${cardAttrs('/finance', 'Giving Overview')}>
      <div class="card-head"><h2>Giving Overview</h2><span class="meta">This month</span></div>
      <div class="giving-landscape">
        <div class="giving-primary">
          <div class="big-figure">${fmtMoney(givingTotal)}</div>
          <div class="big-sub">Total giving ${trendDelta(offeringsDelta) || '<span class="trend">this month</span>'}</div>
        </div>
        <div class="giving-chart">${sparkline(givingPoints)}</div>
        <div class="legend">${givingLegendRows}</div>
      </div>
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
    <div class="card dashboard-clickable" ${cardAttrs('/attendance', 'Attendance Overview')}>
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
    <div class="card dashboard-clickable" ${cardAttrs('/organizations', 'Ministry Overview')}>
      <div class="card-head"><h2>Ministry Overview</h2><a href="/organizations">View all</a></div>
      <div class="m-grid">
        ${ministryTile('👥', 'purple', ministryCount, 'Ministries')}
        ${ministryTile('🙋', 'green', volunteerCount, 'Volunteers')}
        ${ministryTile('♫', 'amber', orgCount, 'Organizations')}
        ${ministryTile('❤', 'blue', peopleInvolved, 'People Involved')}
      </div>
    </div>`;

  const dayBornCard = `
    <div class="card dashboard-clickable" ${cardAttrs('/members', 'Day-born Groups')}>
      <div class="card-head"><h2>Day-born Groups</h2><span class="meta">Akan fellowship view</span></div>
      <div class="day-born-grid">
        ${Object.keys(akanByDay).map((day) => {
          const info = akanByDay[day];
          const count = dayCounts.get(day) || 0;
          return `<div class="day-card" data-card-href="/members" title="Akan Names: ${esc(info.names)}" aria-label="${esc(day)} day-born members">
            <div class="day-card-head">
              <strong>${esc(day)}</strong>
              <span>${esc(info.names)}</span>
            </div>
            <div class="day-card-body">
              <div class="day-count">${count.toLocaleString()}</div>
              <div class="day-meta">Members</div>
              <div class="day-meta">Leader: ${esc(info.leader)}</div>
              <div class="day-meta">Last meeting: Not recorded</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  const netBalance = offeringsThisMonth + harvestsMonth - monthExpenses;
  const specialRows = specialByCat.slice(0, 3).map((s) =>
    `<div class="fin-row"><span class="lbl"><span class="dot">✨</span> ${esc(s.name)}</span>
       <span class="val">${fmtMoney(s.t)}</span></div>`).join('');
  const financeCard = `
    <div class="card dashboard-clickable" ${cardAttrs('/finance', 'Finance Summary')}>
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
    <div class="card dashboard-clickable" ${cardAttrs('/events', 'Upcoming Events')}>
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
    <div class="card dashboard-clickable" ${cardAttrs('/members', 'Birthdays This Week')}>
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
    <div class="card dashboard-clickable" ${cardAttrs('/reports', 'Pending Follow-ups')}>
      <div class="card-head"><h2>Pending Follow-ups</h2><a href="/reports">View all</a></div>
      <div class="fu-row"><div class="lbl"><div class="ico">🚶</div> Visitors to follow up</div><div class="count">${followups.visitors}</div></div>
      <div class="fu-row"><div class="lbl"><div class="ico">⚠</div> Members absent &gt; 3 weeks</div><div class="count">${followups.absentees}</div></div>
      <div class="fu-row"><div class="lbl"><div class="ico">📖</div> Members without a Bible class</div><div class="count">${followups.noClass}</div></div>
      <div class="fu-row"><div class="lbl"><div class="ico">✓</div> Pending membership approvals</div><div class="count">${followups.pending}</div></div>
    </div>`;

  const grid = `
    <div class="dash-grid">
      <div class="col-2">${givingCard}</div>
      ${upcomingCard}
      <div class="col-3">${dayBornCard}</div>
      ${ministryCard}
      ${financeCard}
      ${attendanceCard}
      ${birthdaysCard}
      ${activityCard}
      ${followupsCard}
    </div>`;
  const dashboardDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Africa/Accra',
  });
  const dashboardUser = res.locals.user.display_name || res.locals.user.username;

  res.page({
    title: 'Dashboard',
    subtitleHtml: `<span>Welcome back, ${esc(dashboardUser)}</span><span class="page-date">${esc(dashboardDate)}</span>`,
    active: '/',
    body: `<section class="dash-shell command-center" data-command-center="true">${cards}${quick}${grid}</section>`,
  });
});

// ---------- members lookups (shared) ----------
function loadBibleClasses() {
  return db.prepare(`SELECT ministry_id, name FROM ministries WHERE active=1 ORDER BY name`).all();
}
function loadOrganizations() {
  return db.prepare(`SELECT org_id, name FROM organizations WHERE active=1 ORDER BY name`).all();
}
// (members routes are registered lower down, after PREF_LABELS is defined)

require('./routes/bible-classes').register(app, {
  db, esc, initials, pageHero, statsRow, filterCard, listCard, loadOrganizations, requireAdmin,
});

// ---------- events ----------
require('./routes/events').register(app, {
  db, esc, pageHero, statsRow, filterCard, listCard, table,
  requireAdmin, logActivity, layout, flash, PUBLIC_URL, ICON_EYE,
});

// ---------- finance (record-only ledger) ----------
require('./routes/finance').register(app, {
  db, requireAdmin, logActivity, flash, CHURCH_NAME, sendSmsBatch, sendEmailEach, loadOrganizations,
});

// ---------- reports ----------
require('./routes/reports').register(app, { db, CHURCH_NAME });

// ---------- attendance (cross-event view) ----------
// ---------- attendance ----------
require('./routes/attendance').register(app, { db, esc, sparkline, table });

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
// ---------- preaching plan ----------
require('./routes/preaching').register(app, {
  db, esc, fmtDate, fmtPreachDate, pageHero, statsRow,
  requireAdmin, logActivity, preacherContact, sendPreachingReminder,
});

// ---------- communications ----------
require('./routes/communications').register(app, {
  db, requireAdmin, logActivity, flash, csrfValid, CHURCH_NAME, PREF_LABELS,
  pageHero, statsRow,
  loadBibleClasses, loadOrganizations, sendSmsBatch, sendEmailEach, normalizePhoneGH,
  ARKESEL_API_KEY, SMTP_HOST, SMTP_USER, SMTP_PASS, isEmailish,
});

// ---------- members ----------
require('./routes/members').register(app, {
  db, requireAdmin, logActivity, flash, csrfValid, looksLikeImage,
  photoUpload, EXT_FROM_MIME, PHOTO_DIR, PREF_LABELS, nextMemberId,
  loadBibleClasses, loadOrganizations,
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
  const typeChips = [
    ['baptism', 'Baptisms'],
    ['dedication', 'Dedications'],
    ['confirmation', 'Confirmations'],
    ['marriage', 'Marriages'],
    ['funeral', 'Funerals'],
  ].map(([value, label]) => {
    const row = counts.find((c) => c.t === value);
    const style = value === 'funeral'
      ? 'background:var(--danger-soft);color:var(--danger);'
      : value === 'marriage'
        ? 'background:var(--purple-soft);color:var(--purple-dark);'
        : 'background:var(--gold-soft);color:var(--gold-dark);';
    return `<span class="chip" style="display:inline-flex;align-items:center;padding:0.35rem 0.7rem;${style}">${esc(label)} · ${row ? row.c : 0}</span>`;
  }).join('');
  const body = `
    ${pageHero('Sacraments', 'Reference register for baptisms, confirmations, marriages, funerals and dedications.')}
    <div class="dashboard-row dashboard-row-split" style="margin-bottom:1rem">
      <div class="card">
        <div class="card-head"><h2>Register summary</h2><span class="meta">Current records</span></div>
        <dl class="stats">
          <dt>Total recorded</dt><dd><strong>${total}</strong></dd>
          <dt>Most recent type</dt><dd>${rows[0] ? esc(rows[0].sacrament_type) : '—'}</dd>
          <dt>Latest date</dt><dd>${rows[0] ? esc(rows[0].occurred_on) : '—'}</dd>
        </dl>
      </div>
      <div class="card">
        <div class="card-head"><h2>Sacrament guide</h2><span class="meta">Quick reference</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:0.5rem">${typeChips}</div>
        <p class="muted-text" style="margin-top:0.75rem">Use this register for life events that need an official church record. The list below is sorted with the newest entry first.</p>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Records</h2><span class="meta">${rows.length} entries shown</span></div>
      ${table(['Type', 'Date', 'Member', 'Spouse', 'Location'],
        rows.map((r) => [esc(r.sacrament_type), esc(r.occurred_on),
          r.member_id ? `<a href="/members/${r.member_id}">${esc(r.member)}</a>` : '—',
          r.spouse_id ? `<a href="/members/${r.spouse_id}">${esc(r.spouse)}</a>` : '—',
          esc(r.location)]))}
    </div>`;
  res.page({ title: 'Sacraments', active: '/sacraments', noHeader: true, body });
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

function verifyBackupFile(filePath) {
  const backupDb = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = backupDb.prepare(`PRAGMA integrity_check`).get();
    const result = integrity && Object.values(integrity)[0];
    if (result !== 'ok') throw new Error(`SQLite integrity_check returned: ${result || 'unknown'}`);
    const required = ['members', 'users', 'events', 'inventory_items'];
    const found = new Set(backupDb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(() => '?').join(',')})`
    ).all(...required).map((r) => r.name));
    const missing = required.filter((name) => !found.has(name));
    if (missing.length) throw new Error(`Missing expected table(s): ${missing.join(', ')}`);
    return { ok: true, tables: backupDb.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'`).get().c };
  } finally {
    backupDb.close();
  }
}

app.get('/backups', requireOwner, (req, res) => {
  const backups = listBackups();
  const totalSize = backups.reduce((s, b) => s + b.size, 0);
  const latest = backups[0] ? backups[0].mtime.toLocaleString('en-GB') : 'never';
  const offsite = process.env.BACKUP_UPLOAD_URL ? 'configured' : 'not configured';
  const rows = backups.length
    ? `<table class="data-table members-table">
        <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${backups.map((b) => `<tr>
          <td data-label="Backup"><span class="m-name">${esc(b.name)}</span></td>
          <td data-label="Size">${fmtBytes(b.size)}</td>
          <td data-label="Created">${b.mtime.toLocaleString('en-GB')}</td>
          <td data-label="Actions"><div class="row-actions" style="gap:0.5rem">
            <a class="btn ghost" href="/backups/${encodeURIComponent(b.name)}/download">⬇ Download</a>
            <form method="post" action="/backups/${encodeURIComponent(b.name)}/verify">
              <button class="btn ghost" type="submit">Verify</button></form>
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
        { cls: process.env.BACKUP_UPLOAD_URL ? 'green' : 'orange', icon: '↗', value: offsite, label: 'Off-site Upload' },
      ])}
      ${tools}
      ${listCard({ title: '💾 Available Backups', count: backups.length, countLabel: 'files', inner: rows })}`,
  });
});

app.post('/backups/create', requireOwner, async (req, res) => {
  try {
    const name = await createBackup();
    logSecurityEvent(req, 'backup_created', name, res.locals.user.user_id);
    flash(req, `Backup created: ${name}`, 'success');
  }
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
  try {
    fs.unlinkSync(path.join(BACKUP_DIR, name));
    logSecurityEvent(req, 'backup_deleted', name, res.locals.user.user_id);
    flash(req, `Deleted ${name}.`, 'success');
  }
  catch (e) { flash(req, `Could not delete: ${e.message}`); }
  res.redirect('/backups');
});

app.post('/backups/:name/verify', requireOwner, (req, res) => {
  const name = backupName(req);
  if (!name) { flash(req, 'Backup not found.'); return res.redirect('/backups'); }
  try {
    const result = verifyBackupFile(path.join(BACKUP_DIR, name));
    logSecurityEvent(req, 'backup_verified', `${name};tables:${result.tables}`, res.locals.user.user_id);
    flash(req, `Backup verified: ${name} (${result.tables} tables, integrity ok).`, 'success');
  } catch (e) {
    logSecurityEvent(req, 'backup_verify_failed', `${name};${e.message}`, res.locals.user.user_id);
    flash(req, `Backup verification failed: ${e.message}`);
  }
  res.redirect('/backups');
});

app.post('/backups/:name/restore', requireOwner, (req, res) => {
  const name = backupName(req);
  if (!name) { flash(req, 'Backup not found.'); return res.redirect('/backups'); }
  try {
    verifyBackupFile(path.join(BACKUP_DIR, name));
    fs.copyFileSync(path.join(BACKUP_DIR, name), RESTORE_PENDING);
    logSecurityEvent(req, 'backup_restore_staged', name, res.locals.user.user_id);
    flash(req, `Restore from ${name} is staged. Restart the app to apply it.`, 'info');
  } catch (e) { flash(req, `Could not stage restore: ${e.message}`); }
  res.redirect('/backups');
});

app.post('/backups/restore-upload', requireOwner, dbUpload.single('backup'), (req, res) => {
  if (!csrfValid(req)) return res.status(403).send(layout({ title: 'Security check failed', user: res.locals.user, active: null, body: '<p>Stale form. Go back and try again.</p>' }));
  if (!req.file || !isSqliteBuffer(req.file.buffer)) { flash(req, 'That file is not a valid SQLite database.'); return res.redirect('/backups'); }
  try {
    fs.writeFileSync(RESTORE_PENDING, req.file.buffer);
    verifyBackupFile(RESTORE_PENDING);
    logSecurityEvent(req, 'backup_upload_restore_staged', req.file.originalname || 'uploaded backup', res.locals.user.user_id);
    flash(req, 'Uploaded database is staged for restore. Restart the app to apply it.', 'info');
  } catch (e) {
    try { fs.unlinkSync(RESTORE_PENDING); } catch (_) {}
    flash(req, `Could not stage restore: ${e.message}`);
  }
  res.redirect('/backups');
});

app.get('/settings', requireOwner, (req, res) => {
  const body = `
    ${pageHero('Settings', 'Owner-only controls for integrations, automation and runtime configuration.')}
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
      <p class="muted-text">Manage sender identity, provider choice and email logs on <a href="/communications/email-settings">Communications &rarr; Email Settings</a>.</p>
      <h3>Configure on Fly</h3>
      <pre>flyctl secrets set \\
  ARKESEL_API_KEY="your-arkesel-api-key" \\
  ARKESEL_SENDER="DUNWELL" \\
  SMTP_HOST="smtp.gmail.com" \\
  SMTP_PORT="465" \\
  SMTP_USER="your.address@gmail.com" \\
  SMTP_PASS="your-16-char-app-password" \\
  SMTP_FROM="Dunwell Methodist &lt;your.address@gmail.com&gt;"</pre>
      <p class="muted-text">For Gmail, generate an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">App Password</a> — your normal password will not work. Set <code>PUBLIC_URL</code> too so unsubscribe links work.</p>
    </div>
    <div class="card">
      <h2>Send a test message</h2>
      <p class="muted-text">Verify your settings by sending yourself a test. If a service isn't configured, you'll get a dry-run notice instead of a real send.</p>
      <form method="post" action="/settings/test-sms" class="filter-bar" data-no-confirm="1" style="margin-bottom:0.6rem">
        <input type="tel" name="to" placeholder="Phone, e.g. 0244123456" required style="flex:1;min-width:200px">
        <button type="submit">📱 Send test SMS</button>
      </form>
      <form method="post" action="/settings/test-email" class="filter-bar" data-no-confirm="1">
        <input type="email" name="to" placeholder="you@example.com" required style="flex:1;min-width:200px">
        <button type="submit">✉ Send test email</button>
      </form>
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
  res.page({ title: 'Settings', active: '/settings', noHeader: true, body });
});

app.post('/settings/test-sms', requireOwner, async (req, res) => {
  const raw = (req.body.to || '').trim();
  const phone = normalizePhoneGH(raw);
  if (!phone) { flash(req, `“${raw}” is not a valid phone number.`); return res.redirect('/settings'); }
  try {
    const r = await sendSmsBatch([phone], `Test message from ${CHURCH_NAME} — your SMS setup is working. 🎉`);
    if (r.dryRun) flash(req, 'SMS is in dry-run mode (ARKESEL_API_KEY not set) — nothing was actually sent.', 'info');
    else if (r.ok) flash(req, `Test SMS sent to ${phone}.`, 'success');
    else flash(req, `SMS send failed (HTTP ${r.status || '?'}): ${JSON.stringify(r.response || '')}`.slice(0, 300));
  } catch (e) { flash(req, `SMS error: ${e.message}`); }
  res.redirect('/settings');
});

app.post('/settings/test-email', requireOwner, async (req, res) => {
  const to = (req.body.to || '').trim();
  if (!isEmailish(to)) { flash(req, `“${to}” is not a valid email address.`); return res.redirect('/settings'); }
  try {
    const r = await sendEmailEach([{ addr: to, token: null }],
      `Test email — ${CHURCH_NAME}`,
      `This is a test email from ${CHURCH_NAME}. If you received it, your email setup is working.`,
      { withFooter: false });
    if (r.dryRun) flash(req, 'Email is in dry-run mode (SMTP not configured) — nothing was actually sent.', 'info');
    else if (r.ok) flash(req, `Test email sent to ${to}.`, 'success');
    else flash(req, `Email send failed: ${(r.errors && r.errors[0]) || 'unknown error'}`.slice(0, 300));
  } catch (e) { flash(req, `Email error: ${e.message}`); }
  res.redirect('/settings');
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
    ${pageHero('Profile', 'Account controls for your signed-in user.')}
    <p>Signed in as <strong>${esc(u.username)}</strong> (${esc(u.role)}).</p>
    <h2>Change password</h2>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <form class="form" method="post" action="/profile/password">
      <label class="wide">Current password<input type="password" name="current" required></label>
      <label class="wide">New password<input type="password" name="next" required minlength="8"></label>
      <label class="wide">Confirm new password<input type="password" name="next2" required></label>
      <div class="actions"><button type="submit">Update password</button></div>
    </form>`;
  res.page({ title: 'Profile', noHeader: true, body, flash });
});

app.post('/profile/password', (req, res) => {
  const { current, next: np, next2 } = req.body;
  const u = db.prepare('SELECT password_hash FROM users WHERE user_id=?').get(res.locals.user.user_id);
  if (!bcrypt.compareSync(current || '', u.password_hash)) return res.redirect('/profile?e=bad');
  if (!np || np.length < 8) return res.redirect('/profile?e=short');
  if (np !== next2) return res.redirect('/profile?e=mismatch');
  db.prepare('UPDATE users SET password_hash=? WHERE user_id=?')
    .run(bcrypt.hashSync(np, 12), res.locals.user.user_id);
  logSecurityEvent(req, 'own_password_changed', `user_id:${res.locals.user.user_id}`, res.locals.user.user_id);
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
    ${pageHero('Users & Roles', 'Owner-only access control for staff and ministry administrators.')}
    <p class="muted-text">Any administrator can set a user's access level (read/write jurisdiction):
      <strong>Admin</strong> = full read &amp; write; <strong>Viewer</strong> = read-only.
      Only the main administrator (<strong>dunwelladmin</strong>) can add or delete user accounts and reset passwords.</p>
    ${res.locals.isUserManager ? '<p><a class="btn" href="/users/new">+ New user</a></p>' : ''}
    ${table(['Username', 'Display name', 'Role', 'Created', 'Actions'], rows)}`;
  res.page({ title: 'Users', active: '/users', noHeader: true, body });
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
    const info = db.prepare(
      `INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)`
    ).run(username.trim(), bcrypt.hashSync(password, 12), (display_name || '').trim() || null, r);
    logSecurityEvent(req, 'user_created', `user_id:${info.lastInsertRowid};role:${r}`, res.locals.user.user_id);
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
  logSecurityEvent(req, 'user_role_changed', `user_id:${id};role:${r}`, res.locals.user.user_id);
  res.redirect('/users');
});

app.post('/users/:id/reset', requireUserManager, (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body;
  if (!password || password.length < 8) return res.redirect('/users');
  db.prepare(`UPDATE users SET password_hash=? WHERE user_id=?`)
    .run(bcrypt.hashSync(password, 12), id);
  logSecurityEvent(req, 'user_password_reset', `user_id:${id}`, res.locals.user.user_id);
  res.redirect('/users');
});

app.post('/users/:id/delete', requireUserManager, (req, res) => {
  const id = Number(req.params.id);
  if (id === res.locals.user.user_id) return res.redirect('/users');
  const admins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin'`).get().c;
  const target = db.prepare(`SELECT role FROM users WHERE user_id=?`).get(id);
  if (target && target.role === 'admin' && admins <= 1) return res.redirect('/users');
  db.prepare(`UPDATE users SET deleted_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(id);
  logSecurityEvent(req, 'user_deleted', `user_id:${id}`, res.locals.user.user_id);
  res.redirect('/users');
});

app.get('/security/audit', requireOwner, (req, res) => {
  const rows = db.prepare(`
    SELECT sal.occurred_at, sal.event, sal.subject, sal.ip, sal.user_agent,
           u.username AS actor
      FROM security_audit_log sal
      LEFT JOIN users u ON u.user_id=sal.actor_id
     ORDER BY sal.audit_id DESC LIMIT 100`).all();
  const body = `
    ${pageHero('Security Audit', 'Owner-only review of login, password and role events.')}
    <p class="muted-text">Most recent security-sensitive events. Use this after deploys and account changes.</p>
    ${table(['When', 'Event', 'Actor', 'Subject', 'IP'], rows.map((r) => [
      esc(r.occurred_at),
      esc(r.event),
      esc(r.actor || 'system/anonymous'),
      esc(r.subject || '—'),
      esc(r.ip || '—'),
    ]))}`;
  res.page({ title: 'Security Audit', active: '/security/audit', noHeader: true, body });
});

app.get('/operations', requireOwner, (req, res) => {
  const backups = listBackups();
  const latestBackup = backups[0] || null;
  const backupVerified = db.prepare(`
    SELECT occurred_at, subject
    FROM security_audit_log
    WHERE event='backup_verified'
    ORDER BY audit_id DESC LIMIT 1`).get();
  const recentErrors = db.prepare(`
    SELECT COUNT(*) AS c
    FROM error_log
    WHERE occurred_at >= datetime('now','-24 hours')`).get().c;
  const lastAudit = db.prepare(`
    SELECT occurred_at, event
    FROM security_audit_log
    ORDER BY audit_id DESC LIMIT 1`).get();
  const activeUsers = db.prepare(`
    SELECT COUNT(*) AS c
    FROM users
    WHERE deleted_at IS NULL`).get().c;

  let dbStatus = 'ready';
  try { db.prepare('SELECT 1').get(); } catch (_) { dbStatus = 'not ready'; }

  const checks = [
    ['Database readiness', dbStatus, dbStatus === 'ready' ? 'SELECT 1 succeeded' : 'Database query failed', '/readyz'],
    ['Latest backup', latestBackup ? 'available' : 'missing', latestBackup ? `${latestBackup.name} · ${fmtBytes(latestBackup.size)}` : 'No backup files are retained', '/backups'],
    ['Backup verification', backupVerified ? 'verified' : 'pending', backupVerified ? `${backupVerified.occurred_at} · ${backupVerified.subject}` : 'Verify the latest backup from Backups', '/backups'],
    ['Error log', recentErrors ? 'attention' : 'clear', `${recentErrors} error${recentErrors === 1 ? '' : 's'} in the last 24 hours`, '/errors'],
    ['Security audit', lastAudit ? 'active' : 'empty', lastAudit ? `${lastAudit.occurred_at} · ${lastAudit.event}` : 'No audit events yet', '/security/audit'],
    ['Off-site backup upload', process.env.BACKUP_UPLOAD_URL ? 'configured' : 'not configured',
      process.env.BACKUP_UPLOAD_URL ? 'BACKUP_UPLOAD_URL is set' : 'Set BACKUP_UPLOAD_URL for off-site copies', '/settings'],
    ['SMS provider', ARKESEL_API_KEY ? 'configured' : 'dry-run', ARKESEL_API_KEY ? 'Arkesel key is set' : 'ARKESEL_API_KEY is not set', '/settings'],
    ['Email provider', SMTP_HOST && SMTP_USER && SMTP_PASS ? 'configured' : 'dry-run',
      SMTP_HOST && SMTP_USER && SMTP_PASS ? `${SMTP_HOST}:${SMTP_PORT}` : 'SMTP settings are incomplete', '/settings'],
  ];

  const pillClass = (status) => {
    if (['ready', 'available', 'verified', 'clear', 'active', 'configured'].includes(status)) return 'sent';
    if (['pending', 'dry-run', 'not configured'].includes(status)) return 'dry_run';
    return 'failed';
  };
  const rows = checks.map(([name, status, detail, href]) => [
    esc(name),
    `<span class="pill pill-${pillClass(status)}">${esc(status)}</span>`,
    esc(detail),
    `<a href="${esc(href)}">Open</a>`,
  ]);

  res.page({
    title: 'Operations',
    active: '/operations',
    noHeader: true,
    body: `${pageHero('Operations', 'Owner command center for production health, backups, audit and integration readiness.')}
      ${statsRow([
        { cls: dbStatus === 'ready' ? 'green' : 'orange', icon: '✓', value: esc(dbStatus), label: 'Database' },
        { cls: latestBackup ? 'gold' : 'orange', icon: '💾', value: latestBackup ? latestBackup.mtime.toLocaleString('en-GB') : 'none', label: 'Latest Backup' },
        { cls: recentErrors ? 'orange' : 'green', icon: '⚠', value: Number(recentErrors).toLocaleString(), label: 'Errors (24h)' },
        { cls: 'blue', icon: '🔑', value: Number(activeUsers).toLocaleString(), label: 'Active Users' },
      ])}
      ${listCard({ title: 'Operational Checks', count: checks.length, countLabel: 'checks', inner: table(['Check', 'Status', 'Detail', 'Link'], rows) })}
      <div class="card">
        <div class="card-head"><h2>Runbook</h2></div>
        <p>Use <code>docs/OPERATIONS_RUNBOOK.md</code> for deploy checks, monthly restore drills and rollback steps.</p>
      </div>`,
  });
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
  logSecurityEvent(req, 'first_admin_created', `user_id:${info.lastInsertRowid}`, info.lastInsertRowid);
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
      <p class="auth-aux"><a href="/forgot">Forgot password?</a></p>
    </form>
  `));
});

// Forgot-password guidance. Login accounts are managed by the church admin, who
// resets passwords from Users & Roles — so this points the user there rather
// than emailing a link (accounts have no email on file).
app.get('/forgot', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  const admin = db.prepare(
    `SELECT display_name, username FROM users
       WHERE role='admin' AND deleted_at IS NULL ORDER BY user_id LIMIT 1`).get();
  const who = admin ? esc(admin.display_name || admin.username) : 'your church administrator';
  res.send(authPage('Reset your password', `
    <p class="muted">Passwords for ${esc(CHURCH_NAME)} accounts are reset by your church
      administrator${admin ? ` (<strong>${who}</strong>)` : ''}.</p>
    <ol class="forgot-steps">
      <li>Ask your administrator to open <strong>Users &amp; Roles</strong>.</li>
      <li>They click <strong>Reset</strong> next to your account and set a new password.</li>
      <li>Sign in with the new password, then change it from your <strong>Profile</strong>.</li>
    </ol>
    <p class="muted">If <em>you</em> are the main administrator and are locked out, restore access
      from the server (or a database backup) — contact whoever maintains the deployment.</p>
    <div class="actions"><a class="btn" href="/login">← Back to sign in</a></div>
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
    logSecurityEvent(req, 'login_blocked', 'ip-throttle', null);
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
    logSecurityEvent(req, 'login_failed', (username || '').trim() || 'unknown', null);
    return res.redirect('/login?e=1');
  }
  loginHits.delete(ip);
  req.session.userId = user.user_id;
  logSecurityEvent(req, 'login_success', `user_id:${user.user_id}`, user.user_id);
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

// Safety net: log unhandled async rejections to the error log instead of
// letting them crash the whole process (Express 4 doesn't auto-catch them).
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.message) || String(reason);
  console.error('Unhandled promise rejection:', msg);
  try {
    db.prepare(`INSERT INTO error_log (method, path, message, stack) VALUES ('', '(unhandledRejection)', ?, ?)`)
      .run(String(msg).slice(0, 500), String((reason && reason.stack) || '').slice(0, 4000));
  } catch (_) { /* never let logging throw */ }
});

// ---------- start ----------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Church Manager running at http://localhost:${PORT}`);
  });
}

module.exports = app;
