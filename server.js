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
const { ensureLedgerSchema } = require('./lib/ledger');

const PORT = process.env.PORT || 3000;
const CHURCH_NAME = process.env.CHURCH_NAME || 'Dunwell Methodist';
const PUBLIC_URL  = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const TRIAL_LENGTH_DAYS = Number(process.env.TRIAL_LENGTH_DAYS || 7);
const PREF_LABELS = { either: 'Both', sms_only: 'SMS only', email_only: 'Email only', none: 'Do not contact' };
const FINANCE_ROLE_LABELS = {
  none: 'No finance access',
  cashier: 'Cashier',
  treasurer: 'Steward / Treasurer',
  auditor: 'Auditor',
  finance_admin: 'Finance admin',
};
const PLAN_LIMITS = {
  starter: { label: 'Starter', members: 150, users: 3, branches: 1, support: 'Standard support' },
  pro: { label: 'Pro', members: 800, users: 10, branches: 1, support: 'Priority support' },
  enterprise: { label: 'Enterprise', members: 5000, users: 50, branches: 10, support: 'Dedicated onboarding' },
};
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@churchmanager.local';
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || '';

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
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
  const name = `church-${stamp}.db`;
  const full = path.join(BACKUP_DIR, name);
  await db.backup(full);
  verifyBackupFile(full);
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
    finance_role  TEXT    NOT NULL DEFAULT 'none',
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
addColumnIfMissing('users',   'finance_role',      `finance_role TEXT NOT NULL DEFAULT 'none'`);
addColumnIfMissing('ministries', 'org_id',         `org_id INTEGER REFERENCES organizations(org_id)`);
addColumnIfMissing('expenses', 'paid_to',          `paid_to TEXT`);
addColumnIfMissing('expenses', 'payment_method',   `payment_method TEXT`);
addColumnIfMissing('expenses', 'approved_by',      `approved_by INTEGER REFERENCES users(user_id)`);
addColumnIfMissing('expenses', 'receipt_attached', `receipt_attached INTEGER NOT NULL DEFAULT 0`);
addColumnIfMissing('expenses', 'reference_number', `reference_number TEXT`);
addColumnIfMissing('expenses', 'expense_cat_id',   `expense_cat_id INTEGER REFERENCES expense_categories(expense_cat_id)`);
addColumnIfMissing('expenses', 'notes',            `notes TEXT`);
addColumnIfMissing('expenses', 'journal_entry_id', `journal_entry_id INTEGER`);
addColumnIfMissing('expenses', 'approval_status',  `approval_status TEXT NOT NULL DEFAULT 'PAID'`);
addColumnIfMissing('expenses', 'submitted_at',     `submitted_at TEXT`);
addColumnIfMissing('expenses', 'approved_at',      `approved_at TEXT`);
addColumnIfMissing('expenses', 'paid_at',          `paid_at TEXT`);
addColumnIfMissing('expenses', 'rejected_at',      `rejected_at TEXT`);
addColumnIfMissing('expenses', 'approval_note',    `approval_note TEXT`);
addColumnIfMissing('services', 'journal_entry_id', `journal_entry_id INTEGER`);
addColumnIfMissing('harvests', 'journal_entry_id', `journal_entry_id INTEGER`);
addColumnIfMissing('special_offerings', 'journal_entry_id', `journal_entry_id INTEGER`);
addColumnIfMissing('pledge_payments', 'journal_entry_id', `journal_entry_id INTEGER`);
addColumnIfMissing('inventory_items', 'acquired_on',`acquired_on TEXT`);
addColumnIfMissing('members', 'preferred_channel',`preferred_channel TEXT NOT NULL DEFAULT 'none'`);
addColumnIfMissing('members', 'unsubscribe_token',`unsubscribe_token TEXT`);
addColumnIfMissing('events',  'checkin_token',    `checkin_token TEXT`);
addColumnIfMissing('members', 'photo_filename',   `photo_filename TEXT`);
addColumnIfMissing('members', 'emergency_contact_name',     `emergency_contact_name TEXT`);
addColumnIfMissing('members', 'emergency_contact_phone',    `emergency_contact_phone TEXT`);
addColumnIfMissing('members', 'emergency_contact_relation', `emergency_contact_relation TEXT`);
ensureLedgerSchema(db);
db.exec(`CREATE TABLE IF NOT EXISTS payment_vouchers (
  voucher_id         INTEGER PRIMARY KEY,
  voucher_no         TEXT NOT NULL UNIQUE,
  expense_id         INTEGER NOT NULL UNIQUE REFERENCES expenses(expense_id) ON DELETE CASCADE,
  voucher_date       TEXT NOT NULL,
  amount_in_words    TEXT NOT NULL,
  supporting_doc_ref TEXT,
  prepared_by        INTEGER REFERENCES users(user_id),
  checked_by         TEXT,
  approved_by        INTEGER REFERENCES users(user_id),
  paid_by            INTEGER REFERENCES users(user_id),
  received_by        TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_date ON payment_vouchers(voucher_date);`);

db.exec(`
CREATE TABLE IF NOT EXISTS finance_settings (
  setting_id         INTEGER PRIMARY KEY CHECK (setting_id = 1),
  receipt_prefix     TEXT NOT NULL DEFAULT 'DMC-RCT',
  voucher_prefix     TEXT NOT NULL DEFAULT 'DMC-PV',
  small_expense_max  REAL NOT NULL DEFAULT 500 CHECK (small_expense_max >= 0),
  medium_expense_max REAL NOT NULL DEFAULT 5000 CHECK (medium_expense_max >= 0),
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO finance_settings (setting_id) VALUES (1);

CREATE TABLE IF NOT EXISTS income_records (
  income_id        INTEGER PRIMARY KEY,
  transaction_date TEXT NOT NULL,
  category         TEXT NOT NULL,
  subcategory      TEXT,
  received_from    TEXT,
  member_id        INTEGER REFERENCES members(member_id),
  amount           REAL NOT NULL CHECK (amount > 0),
  payment_method   TEXT NOT NULL DEFAULT 'Cash',
  fund_id          INTEGER REFERENCES funds(fund_id),
  project_id       INTEGER REFERENCES finance_projects(project_id),
  reference_number TEXT,
  description      TEXT,
  receipt_number   TEXT UNIQUE,
  recorded_by      INTEGER REFERENCES users(user_id),
  journal_entry_id INTEGER REFERENCES journal_entries(entry_id),
  deleted_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_income_records_date ON income_records(transaction_date);
CREATE INDEX IF NOT EXISTS idx_income_records_category ON income_records(category);

CREATE TABLE IF NOT EXISTS day_born_collections (
  collection_id    INTEGER PRIMARY KEY,
  collection_date  TEXT NOT NULL,
  day_born         TEXT NOT NULL CHECK (day_born IN ('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')),
  amount           REAL NOT NULL CHECK (amount > 0),
  head_count       INTEGER NOT NULL DEFAULT 0 CHECK (head_count >= 0),
  payment_method   TEXT NOT NULL DEFAULT 'Cash',
  fund_id          INTEGER REFERENCES funds(fund_id),
  reference_number TEXT,
  receipt_number   TEXT UNIQUE,
  recorded_by      INTEGER REFERENCES users(user_id),
  journal_entry_id INTEGER REFERENCES journal_entries(entry_id),
  notes            TEXT,
  deleted_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_day_born_collections_date ON day_born_collections(collection_date);
CREATE INDEX IF NOT EXISTS idx_day_born_collections_day ON day_born_collections(day_born);

CREATE TABLE IF NOT EXISTS finance_receipts (
  receipt_id     INTEGER PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  source_type    TEXT NOT NULL,
  source_id      INTEGER NOT NULL,
  receipt_date   TEXT NOT NULL,
  received_from  TEXT,
  amount         REAL NOT NULL CHECK (amount > 0),
  description    TEXT,
  created_by     INTEGER REFERENCES users(user_id),
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_at      TEXT,
  void_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_finance_receipts_date ON finance_receipts(receipt_date);
CREATE INDEX IF NOT EXISTS idx_finance_receipts_source ON finance_receipts(source_type, source_id);
`);

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
db.exec(`CREATE TABLE IF NOT EXISTS trial_signups (
  signup_id    INTEGER PRIMARY KEY,
  church_name  TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  role         TEXT,
  phone        TEXT NOT NULL,
  email        TEXT,
  plan         TEXT NOT NULL DEFAULT 'pro'
               CHECK (plan IN ('starter','pro','enterprise')),
  member_count TEXT,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
addColumnIfMissing('trial_signups', 'activation_token', `activation_token TEXT`);
addColumnIfMissing('trial_signups', 'activation_sent_at', `activation_sent_at TEXT`);
addColumnIfMissing('trial_signups', 'activation_expires_at', `activation_expires_at TEXT`);
addColumnIfMissing('trial_signups', 'activated_at', `activated_at TEXT`);
addColumnIfMissing('trial_signups', 'activated_user_id', `activated_user_id INTEGER`);
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_signups_activation_token ON trial_signups(activation_token) WHERE activation_token IS NOT NULL`); } catch (_) {}

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
addColumnIfMissing('tithes', 'journal_entry_id', `journal_entry_id INTEGER`);

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

// Expand event_type CHECK to include 'confirmation' and add attendance count
// columns (men / women / children / total). SQLite can't ALTER a CHECK
// constraint in place, so we rebuild the events table.
runOnce('events_add_confirmation_and_attendance_counts_v1', () => {
  // Skip if the table already has both the new columns AND 'confirmation'
  // in the event_type CHECK — i.e. a fresh DB created from the new schema.sql.
  const hasNewCols = ['attendance_men', 'attendance_women', 'attendance_children', 'attendance_total']
    .every((c) => db.prepare(`SELECT 1 FROM pragma_table_info('events') WHERE name=?`).get(c));
  const tableSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='events'`).get() || {}).sql || '';
  const hasConfirmation = /'confirmation'/.test(tableSql);
  if (hasNewCols && hasConfirmation) return; // nothing to do

  // Detect which legacy columns the existing table has, so we can copy them
  // over without losing data from older deployments.
  const existing = db.prepare(`SELECT name FROM pragma_table_info('events')`).all().map((r) => r.name);
  const copyCols = ['event_id', 'title', 'event_type', 'starts_at', 'ends_at',
    'location', 'ministry_id', 'notes', 'checkin_token',
    'attendance_men', 'attendance_women', 'attendance_children', 'attendance_total']
    .filter((c) => existing.includes(c));
  const colList = copyCols.join(', ');

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`DROP VIEW IF EXISTS v_event_attendance_counts;`);
      db.exec(`
        CREATE TABLE events_new (
          event_id     INTEGER PRIMARY KEY,
          title        TEXT    NOT NULL,
          event_type   TEXT    NOT NULL DEFAULT 'service'
                          CHECK (event_type IN
                          ('service','prayer','bible_study','outreach','youth','wedding','funeral','baptism','confirmation','other')),
          starts_at    TEXT    NOT NULL,
          ends_at      TEXT,
          location     TEXT,
          ministry_id  INTEGER REFERENCES ministries(ministry_id) ON DELETE SET NULL,
          notes        TEXT,
          checkin_token TEXT,
          attendance_men      INTEGER,
          attendance_women    INTEGER,
          attendance_children INTEGER,
          attendance_total    INTEGER
        );
      `);
      db.exec(`INSERT INTO events_new (${colList}) SELECT ${colList} FROM events;`);
      db.exec(`
        DROP TABLE events;
        ALTER TABLE events_new RENAME TO events;
        CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_events_checkin ON events(checkin_token) WHERE checkin_token IS NOT NULL;
        CREATE VIEW IF NOT EXISTS v_event_attendance_counts AS
          SELECT e.event_id, e.title, e.starts_at, COUNT(a.member_id) AS attendee_count
          FROM events e LEFT JOIN attendance a USING (event_id)
          GROUP BY e.event_id;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

// Defensive: ensure the four attendance columns exist on events even if the
// migration above never committed (e.g. due to a transient view dependency on
// an older DB). On a fresh schema the columns are already present and these
// are no-ops; on a partially-migrated DB they add what's missing.
addColumnIfMissing('events', 'attendance_men',      `attendance_men INTEGER`);
addColumnIfMissing('events', 'attendance_women',    `attendance_women INTEGER`);
addColumnIfMissing('events', 'attendance_children', `attendance_children INTEGER`);
addColumnIfMissing('events', 'attendance_total',    `attendance_total INTEGER`);

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
addColumnIfMissing('users', 'finance_role', `finance_role TEXT NOT NULL DEFAULT 'none'`);

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
  if (req.path.startsWith('/activate')) return next();  // public signup activation
  if (req.path.startsWith('/billing')) return next();
  if (['/privacy', '/terms', '/support'].includes(req.path)) return next();
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    if (req.path === '/setup') return next();
    return res.redirect('/setup');
  }
  if (req.path === '/login' || req.path === '/logout' || req.path === '/forgot') return next();
  if ((req.path === '/' || req.path === '/signup' || req.path === '/trial-signup') && !req.session.userId) return next();
  if (!req.session.userId) return res.redirect('/login');
  res.locals.user = db.prepare(
    'SELECT user_id, username, display_name, role, finance_role FROM users WHERE user_id=? AND deleted_at IS NULL'
  ).get(req.session.userId);
  if (!res.locals.user) { req.session.destroy(() => {}); return res.redirect('/login'); }
  const forceTrialExpired = process.env.NODE_ENV === 'test' && String(req.query.__trial || '') === 'expired';
  const trial = ensureTrialWindow();
  res.locals.trial = trial;
  res.locals.trialExpired = forceTrialExpired || trialHasExpired();
  if (res.locals.trialExpired && req.path !== '/logout' && !req.path.startsWith('/activate')) return res.redirect('/billing');
  res.locals.role = res.locals.user.role;
  res.locals.isOwner = res.locals.user.role === 'admin';
  // isAdmin here means "can create/edit content" — admins and editors. Owner-only
  // areas (users, roles, backups, settings) use requireOwner instead.
  res.locals.isAdmin = res.locals.user.role === 'admin' || res.locals.user.role === 'editor';
  res.locals.financeRole = res.locals.user.finance_role || 'none';
  res.locals.canFinanceWrite = res.locals.isOwner
    || ['finance_admin', 'treasurer', 'cashier'].includes(res.locals.financeRole);
  res.locals.canFinanceAccounting = res.locals.isOwner
    || ['finance_admin', 'treasurer', 'auditor'].includes(res.locals.financeRole);
  res.locals.canFinanceManageFunds = res.locals.isOwner
    || ['finance_admin', 'treasurer'].includes(res.locals.financeRole);
  res.locals.canPermanentDeleteAll = res.locals.isOwner
    || res.locals.financeRole === 'treasurer'
    || String(res.locals.user.username || '').toLowerCase().includes('steward');
  res.locals.user.canPermanentDeleteAll = res.locals.canPermanentDeleteAll;
  // Adding/deleting accounts and resetting passwords is reserved for the main administrator.
  res.locals.isUserManager = res.locals.isOwner
    && String(res.locals.user.username || '').toLowerCase() === 'dunwelladmin';
  next();
});

// Standardized "Access Denied" dialog used by every role gate. Whenever a
// viewer / editor hits a route they aren't allowed to use, we render the same
// modal-styled card: title, body, and a Back action — instead of a bare 403.
function denyAccess(req, res, opts) {
  const back = (typeof req.get === 'function' && req.get('referer')) || opts.back || '/';
  const safeBack = /^\/[^\s]*$/.test(back) ? back : (opts.back || '/');
  const userName = (res.locals.user && (res.locals.user.display_name || res.locals.user.username)) || '';
  res.status(403).send(layout({
    title: 'Access Denied or Permission Required',
    user: res.locals.user,
    active: null,
    body: `
      <div class="access-denied-shell" role="alertdialog" aria-modal="true"
           aria-labelledby="ad-title" aria-describedby="ad-body">
        <div class="access-denied-card">
          <div class="access-denied-icon" aria-hidden="true">🔒</div>
          <h1 id="ad-title" class="access-denied-title">Access Denied or Permission Required</h1>
          <p id="ad-body" class="access-denied-body">
            You don't have permission to view or edit this field. Please contact your system administrator.
          </p>
          ${opts.detail ? `<p class="access-denied-meta">${esc(opts.detail)}</p>` : ''}
          ${userName ? `<p class="access-denied-meta">Signed in as <strong>${esc(userName)}</strong>${res.locals.user && res.locals.user.role ? ` (${esc(res.locals.user.role)})` : ''}</p>` : ''}
          <div class="access-denied-actions">
            <a class="btn ghost" href="${esc(safeBack)}">← Back</a>
            <a class="btn primary" href="/">Go to dashboard</a>
          </div>
        </div>
      </div>`,
  }));
}

function requireOwner(req, res, next) {
  if (res.locals.isOwner) return next();
  return denyAccess(req, res, {
    detail: 'This area is reserved for administrators. Editors can manage records but not users, backups or settings.',
    back: '/',
  });
}

function requireAdmin(req, res, next) {
  if (res.locals.isAdmin) return next();
  return denyAccess(req, res, {
    detail: 'Your account has read-only access. Ask an admin to make this change.',
    back: '/',
  });
}

function requireFinanceWrite(req, res, next) {
  if (res.locals.canFinanceWrite) return next();
  return denyAccess(req, res, {
    detail: 'Finance recording is limited to finance admins, treasurers and cashiers.',
    back: '/finance',
  });
}

function requireFinanceAccounting(req, res, next) {
  if (res.locals.canFinanceAccounting) return next();
  return denyAccess(req, res, {
    detail: 'Accounting reports are limited to finance admins, treasurers and auditors.',
    back: '/finance',
  });
}

function requireUserManager(req, res, next) {
  if (res.locals.isUserManager) return next();
  return denyAccess(req, res, {
    detail: 'Only the main administrator (dunwelladmin) can add or delete user accounts and reset passwords.',
    back: '/users',
  });
}

function requirePermanentDeleteAll(req, res, next) {
  if (res.locals.canPermanentDeleteAll) return next();
  return denyAccess(req, res, {
    detail: 'Permanent delete-all actions are limited to Administrators and Steward / Treasurer accounts.',
    back: '/',
  });
}

function tableExists(name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function tableCount(name) {
  if (!tableExists(name)) return 0;
  return db.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c;
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function databaseTableNames() {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`).all().map((row) => row.name);
}

function clearReferencesToTable(parentTable, skippedTables = []) {
  const skipped = new Set(skippedTables);
  for (const tableName of databaseTableNames()) {
    if (tableName === parentTable || skipped.has(tableName)) continue;
    const quotedTable = quoteIdentifier(tableName);
    const fks = db.prepare(`PRAGMA foreign_key_list(${quotedTable})`).all()
      .filter((fk) => fk.table === parentTable);
    if (!fks.length) continue;
    const columns = new Map(db.prepare(`PRAGMA table_info(${quotedTable})`).all()
      .map((column) => [column.name, column]));
    for (const fk of fks) {
      const column = columns.get(fk.from);
      if (!column) continue;
      const quotedColumn = quoteIdentifier(fk.from);
      if (column.notnull || column.pk) db.prepare(`DELETE FROM ${quotedTable}`).run();
      else db.prepare(`UPDATE ${quotedTable} SET ${quotedColumn}=NULL`).run();
    }
  }
}

function deleteAllPreview(scope) {
  return (scope.tables || []).filter(tableExists).map((name) => ({
    name,
    count: tableCount(name),
  }));
}

function resetSequences(names) {
  if (!tableExists('sqlite_sequence')) return;
  const del = db.prepare(`DELETE FROM sqlite_sequence WHERE name=?`);
  for (const name of names) {
    if (tableExists(name)) del.run(name);
  }
}

function performPermanentDelete(scopeKey, actorId) {
  const scope = DELETE_ALL_SCOPES[scopeKey];
  if (!scope) throw new Error('Unknown delete scope.');
  const rows = deleteAllPreview(scope);
  const sequenceNames = new Set(scope.tables || []);
  const result = db.transaction(() => {
    if (typeof scope.beforeDelete === 'function') scope.beforeDelete();
    for (const tableName of scope.tables || []) {
      if (tableExists(tableName)) db.prepare(`DELETE FROM ${tableName}`).run();
    }
    if (typeof scope.afterDelete === 'function') scope.afterDelete();
    for (const name of scope.resetTables || []) sequenceNames.add(name);
    resetSequences(Array.from(sequenceNames));
    return rows;
  })();
  db.prepare(`
    INSERT INTO activity_log (user_id, kind, description, link)
    VALUES (?, 'permanent_delete_all', ?, ?)`).run(
    actorId || null,
    `Permanent delete-all executed for ${scope.label}`,
    `/delete-all/${scopeKey}`
  );
  return result;
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
  ['/finance',          'Finance',        '₵'],
  ['/bible-classes',   'Bible Classes',  '📖'],
  ['/organizations',   'Organizations',  '♫'],
  ['/inventory',       'Inventory',      '📦'],
  ['/events',          'Events',         '📅'],
  ['/preaching',       'Preaching Plan', '🎤'],
  ['/communications',  'Communications', '✉'],
  ['/reports',         'Reports',        '📊'],
  ['/help',            'Help',           '?'],
  ['/operations',      'Operations',     '◎', 'admin'],
  ['/tenant',          'Tenant',         '▣', 'admin'],
  ['/users',           'Users & Roles',  '🔑', 'admin'],
  ['/security/audit',  'Security Audit', '🛡', 'admin'],
  ['/backups',         'Backups',        '💾', 'admin'],
  ['/errors',          'Error Log',      '⚠', 'admin'],
  ['/settings',        'Settings',       '⚙'],
];

const DELETE_ALL_SCOPES = {
  members: {
    label: 'Members',
    active: ['/members'],
    phrase: 'DELETE ALL MEMBERS',
    description: 'Permanently deletes every member profile and member-linked records such as attendance links, member tithes, pledges, notes, welfare cases, sacraments and group memberships.',
    tables: [
      'broadcast_recipients',
      'event_rsvps',
      'attendance',
      'organization_memberships',
      'ministry_memberships',
      'pastoral_notes',
      'welfare_cases',
      'sacraments',
      'contributions',
      'tithes',
      'pledge_payments',
      'pledges',
      'income_records',
    ],
    beforeDelete: () => {
      clearReferencesToTable('members', [
        'broadcast_recipients',
        'event_rsvps',
        'attendance',
        'organization_memberships',
        'ministry_memberships',
        'pastoral_notes',
        'welfare_cases',
        'sacraments',
        'contributions',
        'tithes',
        'pledges',
      ]);
      db.prepare(`UPDATE organizations SET leader_id=NULL`).run();
      db.prepare(`UPDATE ministries SET leader_id=NULL`).run();
      db.prepare(`UPDATE members SET bible_class_id=NULL`).run();
      db.prepare(`UPDATE special_offerings SET donor_id=NULL`).run();
      db.prepare(`UPDATE pastoral_notes SET recorded_by=NULL`).run();
    },
    afterDelete: () => {
      const members = db.prepare(`SELECT photo_filename FROM members WHERE photo_filename IS NOT NULL`).all();
      db.prepare(`DELETE FROM members`).run();
      for (const m of members) {
        const file = path.basename(String(m.photo_filename || ''));
        if (file) { try { fs.unlinkSync(path.join(PHOTO_DIR, file)); } catch (_) {} }
      }
    },
    resetTables: ['members'],
  },
  attendance: {
    label: 'Attendance',
    active: ['/attendance'],
    phrase: 'DELETE ALL ATTENDANCE',
    description: 'Permanently deletes all attendance check-in rows. Events and members stay in place.',
    tables: ['attendance'],
  },
  finance: {
    label: 'Finance',
    active: ['/finance'],
    phrase: 'DELETE ALL FINANCE',
    description: 'Permanently deletes finance transaction data including income, tithes, services, harvests, pledges, receipts, expenses, vouchers, projects, budgets, funds and journal entries. Finance settings and lookup categories remain.',
    tables: [
      'payment_vouchers',
      'finance_receipts',
      'finance_budget_lines',
      'finance_budgets',
      'expenses',
      'income_records',
      'day_born_collections',
      'pledge_payments',
      'pledges',
      'day_born_splits',
      'special_offerings',
      'harvests',
      'services',
      'tithes',
      'contributions',
      'journal_lines',
      'journal_entries',
      'financial_periods',
      'finance_projects',
      'funds',
    ],
  },
  bible_classes: {
    label: 'Bible Classes',
    active: ['/bible-classes'],
    phrase: 'DELETE ALL BIBLE CLASSES',
    description: 'Permanently deletes all Bible classes and their membership links.',
    tables: ['ministry_memberships'],
    beforeDelete: () => db.prepare(`UPDATE members SET bible_class_id=NULL`).run(),
    afterDelete: () => db.prepare(`DELETE FROM ministries`).run(),
    resetTables: ['ministries'],
  },
  organizations: {
    label: 'Organizations',
    active: ['/organizations'],
    phrase: 'DELETE ALL ORGANIZATIONS',
    description: 'Permanently deletes all organizations and organization membership links. Related finance/broadcast records keep their money and message history but lose the organization link.',
    tables: ['organization_memberships'],
    beforeDelete: () => {
      db.prepare(`UPDATE harvests SET org_id=NULL`).run();
      db.prepare(`UPDATE broadcasts SET org_id=NULL`).run();
    },
    afterDelete: () => db.prepare(`DELETE FROM organizations`).run(),
    resetTables: ['organizations'],
  },
  inventory: {
    label: 'Inventory',
    active: ['/inventory'],
    phrase: 'DELETE ALL INVENTORY',
    description: 'Permanently deletes all inventory items and categories.',
    tables: ['inventory_items', 'inventory_categories'],
  },
  events: {
    label: 'Events',
    active: ['/events'],
    phrase: 'DELETE ALL EVENTS',
    description: 'Permanently deletes all events, RSVPs and event attendance rows.',
    tables: ['event_rsvps', 'attendance', 'events'],
  },
  preaching: {
    label: 'Preaching Plan',
    active: ['/preaching'],
    phrase: 'DELETE ALL PREACHING',
    description: 'Permanently deletes the preaching plan.',
    tables: ['preaching_plan'],
  },
  communications: {
    label: 'Communications',
    active: ['/communications'],
    phrase: 'DELETE ALL COMMUNICATIONS',
    description: 'Permanently deletes announcements, broadcast history, broadcast recipients and email send logs. Email/SMS settings stay in place.',
    tables: ['broadcast_recipients', 'broadcasts', 'announcements', 'email_logs'],
  },
  activity: {
    label: 'Activity History',
    active: ['/operations'],
    phrase: 'DELETE ALL ACTIVITY',
    description: 'Permanently deletes operational activity history. It does not delete church records.',
    tables: ['activity_log'],
  },
  security_audit: {
    label: 'Security Audit',
    active: ['/security/audit'],
    phrase: 'DELETE ALL SECURITY AUDIT',
    description: 'Permanently deletes security audit events.',
    tables: ['security_audit_log'],
  },
  errors: {
    label: 'Error Log',
    active: ['/errors'],
    phrase: 'DELETE ALL ERRORS',
    description: 'Permanently deletes captured server error records.',
    tables: ['error_log'],
  },
};

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

// Uploader for CSV imports (members list).
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB — covers ~50k member rows
  fileFilter: (req, file, cb) => {
    const ok = /^(text\/csv|application\/vnd\.ms-excel|text\/plain|application\/octet-stream)$/i.test(file.mimetype)
      || /\.csv$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Only .csv files are accepted'), ok);
  },
});
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
function currentPlanKey() {
  const raw = String(getState('current_plan') || getState('subscription_plan') || 'pro').toLowerCase();
  return Object.hasOwn(PLAN_LIMITS, raw) ? raw : 'pro';
}
function currentPlan() {
  return PLAN_LIMITS[currentPlanKey()];
}
function tenantUsage() {
  const scalar = (sql) => {
    try { return db.prepare(sql).get().c || 0; } catch (_) { return 0; }
  };
  return {
    members: scalar(`SELECT COUNT(*) c FROM members WHERE deleted_at IS NULL`),
    users: scalar(`SELECT COUNT(*) c FROM users WHERE deleted_at IS NULL`),
    branches: 1,
  };
}

function ensureTrialWindow() {
  let started = getState('trial_started_at');
  let expires = getState('trial_expires_at');
  let status = getState('subscription_status');
  if (!started || !expires || !status) {
    if (process.env.NODE_ENV === 'test') {
      return { started: started || null, expires: expires || null, status: status || 'trial' };
    }
    const firstUser = db.prepare(`SELECT MIN(created_at) AS started FROM users WHERE deleted_at IS NULL`).get();
    started = (firstUser && firstUser.started) || db.prepare(`SELECT datetime('now') AS now`).get().now;
    setState('trial_started_at', started);
    if (!expires) {
      expires = db.prepare(`SELECT datetime(?, '+${TRIAL_LENGTH_DAYS} days') AS expires`).get(started).expires;
      setState('trial_expires_at', expires);
    }
    if (!status) {
      status = 'trial';
      setState('subscription_status', status);
    }
    return { started, expires, status };
  }
  return { started, expires, status };
}

function trialHasExpired() {
  const trial = ensureTrialWindow();
  if (trial.status === 'active') return false;
  if (!trial.expires) return false;
  return !!db.prepare(`SELECT datetime('now') >= datetime(?) AS expired`).get(trial.expires).expired;
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
        if (opts.html) payload.html = opts.html + (footer ? `<p style="margin-top:16px;color:#6b7280;font-size:12px">${esc(footer).replace(/\n/g, '<br>')}</p>` : '');
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
          html: opts.html ? opts.html + (footer ? `<p style="margin-top:16px;color:#6b7280;font-size:12px">${esc(footer).replace(/\n/g, '<br>')}</p>` : '') : undefined,
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

function publicBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : '';
}

function createSignupActivationToken() {
  return crypto.randomBytes(24).toString('hex');
}

function signupActivationUrl(req, token) {
  const base = publicBaseUrl(req);
  return base ? `${base}/activate/${encodeURIComponent(token)}` : `/activate/${encodeURIComponent(token)}`;
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
  deleteAllScopes: DELETE_ALL_SCOPES,
});


// ---------- routes: dashboard ----------
const { sparkline, miniSpark, donut, lastMonths, seriesOn } = require('./lib/charts');

function publicLandingPage(req, opts = {}) {
  const selectedPlan = ['starter', 'pro', 'enterprise'].includes(String(req.query.plan || opts.plan || '').toLowerCase())
    ? String(req.query.plan || opts.plan).toLowerCase()
    : 'pro';
  const selectedBilling = ['monthly', 'yearly'].includes(String(req.query.billing || opts.billing || '').toLowerCase())
    ? String(req.query.billing || opts.billing).toLowerCase()
    : 'monthly';
  const planOption = (value, label) => `<option value="${value}"${selectedPlan === value ? ' selected' : ''}>${label}</option>`;
  const received = req.query.trial === 'received' || opts.received;
  const error = opts.error || '';
  const topCta = req.session.userId
    ? { href: '/', label: 'Go to dashboard' }
    : { href: '/login', label: 'Sign in' };
  const price = (monthly, yearly) => selectedBilling === 'yearly' ? yearly : monthly;
  const billingLabel = selectedBilling === 'yearly' ? '/ year' : '/ month';
  const billingBadge = selectedBilling === 'yearly' ? 'Save 17%' : 'Monthly';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>7-day trial · Church Manager</title>
<meta name="description" content="Start a 7-day trial of Church Manager for members, attendance, finance, harvests, reports and church communication.">
<script>(function(){try{var mq=window.matchMedia&&matchMedia('(prefers-color-scheme:dark)');function apply(){document.documentElement.setAttribute('data-theme',mq&&mq.matches?'dark':'light');}try{localStorage.removeItem('theme');}catch(e){}apply();if(mq){if(mq.addEventListener)mq.addEventListener('change',apply);else if(mq.addListener)mq.addListener(apply);}}catch(e){}})();</script>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body class="public-landing">
  <header class="public-nav">
    <a class="public-brand" href="/">
      <img src="/static/logo.png" alt="">
      <span>Church Manager</span>
    </a>
    <nav>
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="/support">Support</a>
      <a href="#signup">Start trial</a>
      <a class="public-login" href="${topCta.href}">${topCta.label}</a>
    </nav>
  </header>

  <main>
    <section class="landing-hero">
      <div class="landing-kicker">For church admin teams</div>
      <h1>Run your church like a pro</h1>
      <p>Keep members, attendance, finance, communications and reports in one clean workspace built for pastors, secretaries and treasurers.</p>
      <div class="landing-actions">
        <a class="btn primary" href="#signup">Start free</a>
        <a class="btn ghost" href="#pricing">View pricing</a>
      </div>
      <div class="landing-chips" aria-label="Platform highlights">
        <span>7-day free trial</span>
        <span>Members & attendance</span>
        <span>Finance & reports</span>
        <span>Private church setup</span>
      </div>
    </section>

    <section id="features" class="public-section">
      <div class="section-head">
        <span>Platform</span>
        <h2>Everything your office needs in one place.</h2>
      </div>
      <div class="public-feature-grid">
        <article><span>01</span><h3>Members</h3><p>Profiles, contacts, Bible classes, organizations and member import.</p></article>
        <article><span>02</span><h3>Attendance</h3><p>Track services, events and weekly trends from one view.</p></article>
        <article><span>03</span><h3>Finance</h3><p>Record offerings, expenses, pledges and fund balances cleanly.</p></article>
        <article><span>04</span><h3>Reports</h3><p>Export CSV reports and review everything without hunting through menus.</p></article>
      </div>
    </section>

    <section id="pricing" class="public-section pricing-section">
      <div class="section-head">
        <span>Pricing</span>
        <h2>Simple pricing that keeps the 7-day trial front and center.</h2>
      </div>
      <div class="pricing-switch" role="tablist" aria-label="Billing cycle">
        <a class="${selectedBilling === 'monthly' ? 'active' : ''}" href="/?billing=monthly#pricing">Monthly</a>
        <a class="${selectedBilling === 'yearly' ? 'active' : ''}" href="/?billing=yearly#pricing">Yearly</a>
        <span>${billingBadge}</span>
      </div>
      <div class="public-plan-grid">
        <article class="public-plan">
          <div class="plan-top"><span>Free</span><small>7 days</small></div>
          <div class="public-price">GH₵ 0</div>
          <p>Try the system with your church data and see the interface before paying.</p>
          <ul><li>7-day free trial</li><li>Members & attendance</li><li>Basic reports</li></ul>
          <a class="btn ghost" href="/signup?plan=starter#signup">Start free</a>
        </article>
        <article class="public-plan featured">
          <div class="plan-badge">Recommended</div>
          <h3>Pro</h3>
          <p>For active churches that need stronger controls, finance and reporting.</p>
          <div class="public-price">${price('GH₵ 300', 'GH₵ 2,988')} <small>${billingLabel}</small></div>
          <ul><li>Finance workflows</li><li>Harvests and pledges</li><li>Priority support</li></ul>
          <a class="btn primary" href="/signup?plan=pro#signup">Select Pro</a>
        </article>
        <article class="public-plan">
          <h3>Enterprise</h3>
          <p>For larger parishes, circuits and multi-branch operations.</p>
          <div class="public-price">${price('GH₵ 600', 'GH₵ 5,976')} <small>${billingLabel}</small></div>
          <ul><li>Multi-branch admin</li><li>Custom reporting</li><li>Dedicated onboarding</li></ul>
          <a class="btn ghost" href="/signup?plan=enterprise#signup">Select Enterprise</a>
        </article>
      </div>
    </section>

    <section id="signup" class="public-section signup-section">
      <div class="signup-copy">
        <span>Start your trial</span>
        <h2>Request a private workspace for your church.</h2>
        <p>Tell us your church name, contact person and preferred plan. We will confirm the next steps by email and phone.</p>
      </div>
      <form class="trial-form" method="post" action="/trial-signup">
        ${received ? '<p class="success">Trial request received. We will contact you shortly.</p>' : ''}
        ${error ? `<p class="error">${esc(error)}</p>` : ''}
        <label>Church name<input name="church_name" required value="${esc(opts.values && opts.values.church_name)}"></label>
        <label>Your name<input name="contact_name" required value="${esc(opts.values && opts.values.contact_name)}"></label>
        <label>Role<input name="role" placeholder="Pastor / Secretary / Treasurer" value="${esc(opts.values && opts.values.role)}"></label>
        <label>Phone / WhatsApp<input name="phone" required placeholder="+233 24 000 0000" value="${esc(opts.values && opts.values.phone)}"></label>
        <label>Email<input type="email" name="email" required value="${esc(opts.values && opts.values.email)}"></label>
        <label>Plan<select name="plan">${planOption('starter', 'Starter - GH₵ 150/month')}${planOption('pro', 'Pro - GH₵ 300/month')}${planOption('enterprise', 'Enterprise - GH₵ 600/month')}</select></label>
        <label>Approximate members<select name="member_count">
          <option${opts.values && opts.values.member_count === 'Under 100' ? ' selected' : ''}>Under 100</option>
          <option${opts.values && opts.values.member_count === '100 - 300' ? ' selected' : ''}>100 - 300</option>
          <option${opts.values && opts.values.member_count === '300 - 1000' ? ' selected' : ''}>300 - 1000</option>
          <option${opts.values && opts.values.member_count === 'Over 1000' ? ' selected' : ''}>Over 1000</option>
        </select></label>
        <label class="wide">Notes<textarea name="notes" rows="3" placeholder="Tell us about data import, branches, or finance needs.">${esc(opts.values && opts.values.notes)}</textarea></label>
        <button type="submit">Start free trial</button>
        <p class="form-note">No payment is collected here. Use a real email address so we can send the verification link.</p>
      </form>
    </section>
  </main>
  <footer class="public-footer">
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="/support">Support</a>
  </footer>
</body>
</html>`;
}

function publicInfoPage(title, kicker, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Church Manager</title>
<meta name="description" content="${esc(title)} for Church Manager.">
<link rel="stylesheet" href="/static/styles.css">
</head>
<body class="public-landing">
  <header class="public-nav">
    <a class="public-brand" href="/"><img src="/static/logo.png" alt=""><span>Church Manager</span></a>
    <nav>
      <a href="/">Home</a>
      <a href="/support">Support</a>
      <a class="public-login" href="/login">Sign in</a>
    </nav>
  </header>
  <main>
    <section class="landing-hero legal-hero">
      <div class="landing-kicker">${esc(kicker)}</div>
      <h1>${esc(title)}</h1>
      <p>Operational SaaS information for churches evaluating or using Church Manager.</p>
    </section>
    <section class="public-section legal-section">${body}</section>
  </main>
  <footer class="public-footer">
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="/support">Support</a>
  </footer>
</body>
</html>`;
}

function privacyPage() {
  return publicInfoPage('Privacy Policy', 'Data protection', `
    <div class="legal-copy">
      <p><strong>Draft policy:</strong> review this with legal counsel before broad public sale.</p>
      <h2>Data we handle</h2>
      <p>Church Manager stores member profiles, attendance, finance entries, communications metadata, user accounts, audit logs and uploaded member photos when a church chooses to enter them.</p>
      <h2>How data is used</h2>
      <p>Data is used to operate the church workspace, generate reports, send approved communications, secure accounts and support administrators.</p>
      <h2>Access and security</h2>
      <p>Access is role-based. Administrators control staff accounts. Sensitive actions are logged in audit records. Backups are retained according to the configured backup policy.</p>
      <h2>Support</h2>
      <p>For privacy or data requests, contact <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>.</p>
    </div>`);
}

function termsPage() {
  return publicInfoPage('Terms of Service', 'Service terms', `
    <div class="legal-copy">
      <p><strong>Draft terms:</strong> confirm final commercial terms with legal counsel before public sale.</p>
      <h2>Use of the service</h2>
      <p>Church Manager is provided for church administration: members, attendance, finance, communications and reporting. Each church is responsible for entering accurate data and assigning trusted administrators.</p>
      <h2>Subscriptions and trials</h2>
      <p>Trial and subscription access may be limited by plan, support package and agreed onboarding scope. Payment terms should be confirmed in the church's signed order or invoice.</p>
      <h2>Backups and exports</h2>
      <p>Administrators should maintain downloaded or off-site backups. The system includes backup tools, but churches remain responsible for retention obligations specific to their organization.</p>
      <h2>Support</h2>
      <p>Support requests can be sent to <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>.</p>
    </div>`);
}

function supportPage() {
  return publicInfoPage('Support', 'Help desk', `
    <div class="legal-copy">
      <h2>Contact</h2>
      <p>Email <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a> with the church name, user role, page URL and a short description of the issue.</p>
      <h2>Priority issues</h2>
      <p>Report login lockouts, failed backups, finance posting errors, missing data, SMS/email failures and unexpected error pages immediately.</p>
      <h2>Before reporting</h2>
      <p>Check the Operations page, Error Log, Security Audit and Backups page if you are an administrator. Include screenshots when possible.</p>
      <h2>Training</h2>
      <p>Recommended onboarding includes one session for administrators, one for finance users and one for secretaries or data-entry users.</p>
    </div>`);
}

function billingExpiredPage(req) {
  const trial = ensureTrialWindow();
  const started = trial.started ? String(trial.started).slice(0, 10) : '—';
  const expires = trial.expires ? String(trial.expires).slice(0, 10) : '—';
  const signedIn = !!req.session.userId;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trial expired · Church Manager</title>
<meta name="description" content="Your 7-day trial has ended. Choose a subscription to restore access.">
<link rel="stylesheet" href="/static/styles.css">
</head>
<body class="public-landing">
  <header class="public-nav">
    <a class="public-brand" href="/">
      <img src="/static/logo.png" alt="">
      <span>Church Manager</span>
    </a>
    <nav>
      ${signedIn ? '<a href="/logout">Sign out</a>' : '<a href="/login">Sign in</a>'}
    </nav>
  </header>
  <main>
    <section class="landing-hero billing-hero">
      <div class="landing-kicker warning">Subscription required</div>
      <h1>Your 7-day trial has expired.</h1>
      <p>Access is paused until a plan is activated. Trial access started on ${started} and ended on ${expires}.</p>
      <div class="landing-actions">
        <a class="btn primary" href="/signup?plan=pro#signup">Request Pro access</a>
        <a class="btn ghost" href="/signup?plan=enterprise#signup">Request Enterprise access</a>
      </div>
      <div class="landing-chips">
        <span>Data remains protected</span>
        <span>Sign out available</span>
        <span>Activate to restore access</span>
      </div>
    </section>

    <section class="public-section pricing-section">
      <div class="section-head">
        <span>Subscription plans</span>
        <h2>Pick the plan to restore access.</h2>
      </div>
      <div class="pricing-switch" role="tablist" aria-label="Billing cycle">
        <a class="active" href="/billing?billing=monthly">Monthly</a>
        <a href="/billing?billing=yearly">Yearly</a>
        <span>Restart access</span>
      </div>
      <div class="public-plan-grid">
        <article class="public-plan">
          <div class="plan-top"><span>Free</span><small>7 days</small></div>
          <div class="public-price">GH₵ 0</div>
          <p>Open the app, explore the interface and test the workflow before purchase.</p>
          <a class="btn ghost" href="/signup?plan=starter#signup">Start free</a>
        </article>
        <article class="public-plan featured">
          <div class="plan-badge">Recommended</div>
          <h3>Pro</h3>
          <p>For active churches that need stronger controls and reporting.</p>
          <div class="public-price">GH₵ 300 <small>/ month</small></div>
          <a class="btn primary" href="/signup?plan=pro#signup">Select Pro</a>
        </article>
        <article class="public-plan">
          <h3>Enterprise</h3>
          <p>For large churches, circuits and multi-branch operations.</p>
          <div class="public-price">GH₵ 600 <small>/ month</small></div>
          <a class="btn ghost" href="/signup?plan=enterprise#signup">Select Enterprise</a>
        </article>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function activationPage(req, signup, opts = {}) {
  const token = signup.activation_token || opts.token || '';
  const planLabel = signup.plan ? signup.plan.charAt(0).toUpperCase() + signup.plan.slice(1) : 'Pro';
  const expiresAt = signup.activation_expires_at ? String(signup.activation_expires_at).slice(0, 10) : '—';
  const email = signup.email || opts.email || '';
  const activated = !!signup.activated_at;
  const body = activated
    ? `
      <p class="muted">This activation link was already used for <strong>${esc(signup.church_name)}</strong>.</p>
      <p class="muted">You can sign in with the account that was created, or reset the password from the login page if needed.</p>
      <div class="actions"><a class="btn" href="/login">Go to sign in</a></div>
    `
    : `
      <p class="muted">Finish setting up <strong>${esc(signup.church_name)}</strong> on the <strong>${esc(planLabel)}</strong> plan.</p>
      <ul class="forgot-steps">
        <li>Confirm the email address: <strong>${esc(email || '—')}</strong></li>
        <li>Choose a username and password for sign in.</li>
        <li>Activate the workspace to enter the system immediately.</li>
      </ul>
      <p class="muted">This activation link expires on <strong>${esc(expiresAt)}</strong>.</p>
      <form class="form auth-form" method="post" action="/activate/${esc(token)}">
        ${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ''}
        <label class="wide">Email<input type="email" value="${esc(email)}" readonly></label>
        <label class="wide">Username<input name="username" required minlength="3" value="${esc(opts.values && opts.values.username)}"></label>
        <label class="wide">Display name<input name="display_name" value="${esc(opts.values && opts.values.display_name || signup.contact_name || '')}"></label>
        <label class="wide">Password<input type="password" name="password" required minlength="8"></label>
        <label class="wide">Confirm password<input type="password" name="password2" required minlength="8"></label>
        <div class="actions"><button type="submit">Activate account</button></div>
      </form>
    `;
  return authPage('Verify your account', body);
}

app.get('/signup', (req, res) => {
  const plan = ['starter', 'pro', 'enterprise'].includes(String(req.query.plan || '').toLowerCase())
    ? String(req.query.plan).toLowerCase()
    : 'pro';
  res.redirect(`/?plan=${encodeURIComponent(plan)}#signup`);
});

app.get('/activate/:token', (req, res) => {
  const signup = db.prepare(`
    SELECT signup_id, church_name, contact_name, role, phone, email, plan, member_count, notes,
           status, activation_token, activation_expires_at, activated_at, activated_user_id
    FROM trial_signups
    WHERE activation_token = ?
  `).get(String(req.params.token || '').trim());
  if (!signup) return res.status(404).send(authPage('Verify your account', '<p class="error">Verification link not found.</p><p><a href="/">Back to the website</a></p>'));
  if (signup.activated_at) return res.send(activationPage(req, signup));
  if (signup.activation_expires_at && db.prepare(`SELECT datetime('now') > datetime(?) AS expired`).get(signup.activation_expires_at).expired) {
    return res.status(410).send(authPage('Verify your account', '<p class="error">This verification link has expired. Please request a new signup.</p><p><a href="/?signup=1#signup">Back to sign up</a></p>'));
  }
  res.send(activationPage(req, signup, { token: req.params.token }));
});

app.post('/activate/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();
  const signup = db.prepare(`
    SELECT signup_id, church_name, contact_name, role, phone, email, plan, member_count, notes,
           status, activation_token, activation_expires_at, activated_at, activated_user_id
    FROM trial_signups
    WHERE activation_token = ?
  `).get(token);
  if (!signup) {
    return res.status(404).send(authPage('Verify your account', '<p class="error">Verification link not found.</p><p><a href="/">Back to the website</a></p>'));
  }
  if (signup.activated_at) {
    if (signup.activated_user_id) req.session.userId = signup.activated_user_id;
    return res.redirect('/');
  }
  if (signup.activation_expires_at && db.prepare(`SELECT datetime('now') > datetime(?) AS expired`).get(signup.activation_expires_at).expired) {
    return res.status(410).send(authPage('Verify your account', '<p class="error">This verification link has expired. Please request a new signup.</p><p><a href="/?signup=1#signup">Back to sign up</a></p>'));
  }
  const values = {
    username: String(req.body.username || '').trim(),
    display_name: String(req.body.display_name || '').trim(),
    password: String(req.body.password || ''),
    password2: String(req.body.password2 || ''),
  };
  if (!values.username || values.password.length < 8 || values.password !== values.password2) {
    return res.status(400).send(activationPage(req, signup, {
      token,
      error: 'Choose a username and matching password of at least 8 characters.',
      values,
    }));
  }
  const existing = db.prepare(`SELECT 1 FROM users WHERE username = ? AND deleted_at IS NULL`).get(values.username);
  if (existing) {
    return res.status(400).send(activationPage(req, signup, {
      token,
      error: 'That username is already in use.',
      values,
    }));
  }
  const hash = bcrypt.hashSync(values.password, 12);
  const displayName = values.display_name || signup.contact_name || signup.church_name || null;
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, role, finance_role)
    VALUES (?, ?, ?, 'admin', 'none')
  `).run(values.username, hash, displayName);
  db.prepare(`
    UPDATE trial_signups
    SET status='activated',
        activated_at=CURRENT_TIMESTAMP,
        activated_user_id=?,
        activation_token=NULL
    WHERE signup_id=?
  `).run(info.lastInsertRowid, signup.signup_id);
  setState('subscription_status', 'active');
  setState('current_plan', signup.plan || 'pro');
  if (!getState('trial_started_at')) setState('trial_started_at', db.prepare(`SELECT datetime('now') AS now`).get().now);
  if (!getState('trial_expires_at')) setState('trial_expires_at', db.prepare(`SELECT datetime('now', '+7 days') AS expires`).get().expires);
  logSecurityEvent(req, 'signup_activated', `signup_id:${signup.signup_id};user_id:${info.lastInsertRowid};plan:${signup.plan}`, info.lastInsertRowid);
  req.session.userId = info.lastInsertRowid;
  res.redirect('/');
});

app.get('/billing', (req, res) => {
  res.send(billingExpiredPage(req));
});

app.get('/privacy', (req, res) => res.send(privacyPage()));
app.get('/terms', (req, res) => res.send(termsPage()));
app.get('/support', (req, res) => res.send(supportPage()));

app.post('/trial-signup', async (req, res) => {
  const values = {
    church_name: String(req.body.church_name || '').trim(),
    contact_name: String(req.body.contact_name || '').trim(),
    role: String(req.body.role || '').trim(),
    phone: String(req.body.phone || '').trim(),
    email: String(req.body.email || '').trim(),
    plan: String(req.body.plan || 'pro').trim().toLowerCase(),
    member_count: String(req.body.member_count || '').trim(),
    notes: String(req.body.notes || '').trim(),
  };
  if (!values.church_name || !values.contact_name || !values.phone) {
    return res.status(400).send(publicLandingPage(req, { values, plan: values.plan, error: 'Church name, your name and phone number are required.' }));
  }
  if (!['starter', 'pro', 'enterprise'].includes(values.plan)) values.plan = 'pro';
  if (!values.email) {
    return res.status(400).send(publicLandingPage(req, { values, plan: values.plan, error: 'Email is required so we can send your verification link.' }));
  }
  if (!isEmailish(values.email)) {
    return res.status(400).send(publicLandingPage(req, { values, plan: values.plan, error: 'Enter a valid email address.' }));
  }
  const activationToken = createSignupActivationToken();
  const activationExpiresAt = db.prepare(`SELECT datetime('now', '+7 days') AS expires`).get().expires;
  db.prepare(`
    INSERT INTO trial_signups (
      church_name, contact_name, role, phone, email, plan, member_count, notes,
      status, activation_token, activation_sent_at, activation_expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invited', ?, CURRENT_TIMESTAMP, ?)
  `).run(values.church_name, values.contact_name, values.role || null, values.phone, values.email,
    values.plan, values.member_count || null, values.notes || null, activationToken, activationExpiresAt);
  const planLabel = values.plan.charAt(0).toUpperCase() + values.plan.slice(1);
  const activationUrl = signupActivationUrl(req, activationToken);
  const subject = `Verify your ${planLabel} access`;
  const body = [
    `Hello ${values.contact_name},`,
    '',
    `Thanks for signing up for ${values.church_name} on the ${planLabel} plan.`,
    `Verify your account here: ${activationUrl}`,
    '',
    `This link expires on ${String(activationExpiresAt).slice(0, 10)}.`,
    `Requested plan: ${planLabel}`,
    `Church: ${values.church_name}`,
    '',
    `Dunwell Methodist Management System`,
  ].join('\n');
  const html = `
    <p>Hello ${esc(values.contact_name)},</p>
    <p>Thanks for signing up for ${esc(values.church_name)} on the ${esc(planLabel)} plan.</p>
    <p><a href="${esc(activationUrl)}" style="display:inline-block;background:#166534;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Verify your account</a></p>
    <p>If the button does not open, copy this link into your browser:</p>
    <p><a href="${esc(activationUrl)}">${esc(activationUrl)}</a></p>
    <p style="color:#6b7280;font-size:12px">This link expires on ${esc(String(activationExpiresAt).slice(0, 10))}.</p>
    <p style="color:#6b7280;font-size:12px">Requested plan: ${esc(planLabel)}<br>Church: ${esc(values.church_name)}</p>
  `;
  try {
    await sendEmailEach([{ addr: values.email }], subject, body, { withFooter: false, html });
  } catch (e) {
    console.error('trial signup activation email failed:', e.message);
  }
  res.redirect('/?trial=received#signup');
});

app.get('/', (req, res) => {
  if (!res.locals.user) return res.send(publicLandingPage(req));
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

  // Birthdays in the next 7 days (today inclusive). Uses a day-of-year window
  // that wraps year-end so late-December queries still surface early-January.
  const birthdaysThisWeek = db.prepare(`
    SELECT COUNT(*) c FROM members
    WHERE deleted_at IS NULL AND date_of_birth IS NOT NULL
      AND (
        strftime('%j', date_of_birth) BETWEEN strftime('%j','now') AND strftime('%j', date('now','+7 days'))
        OR (
          strftime('%j','now') > strftime('%j', date('now','+7 days'))
          AND (
            strftime('%j', date_of_birth) >= strftime('%j','now')
            OR strftime('%j', date_of_birth) <= strftime('%j', date('now','+7 days'))
          )
        )
      )
  `).get().c;
  const birthdaysToday = db.prepare(`
    SELECT COUNT(*) c FROM members
    WHERE deleted_at IS NULL AND date_of_birth IS NOT NULL
      AND strftime('%m-%d', date_of_birth) = strftime('%m-%d','now')
  `).get().c;
  // Per-day birthday counts across the next 7 days, used to draw a sparkline
  // for the Birthdays KPI card.
  const birthdaysWeekSpark = (() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const counts = [];
    const stmt = db.prepare(`SELECT COUNT(*) c FROM members
      WHERE deleted_at IS NULL AND date_of_birth IS NOT NULL
        AND strftime('%m-%d', date_of_birth) = ?`);
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() + i * 86400000);
      const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      counts.push(stmt.get(md).c);
    }
    return counts;
  })();

  const recentMembers = db.prepare(`
    SELECT m.member_id, m.first_name, m.last_name, m.email, m.join_date,
           m.photo_filename, m.membership_status, m.baptism_date, m.confirmation_date,
           (SELECT o.name FROM organization_memberships om
              JOIN organizations o USING(org_id)
              WHERE om.member_id = m.member_id
              ORDER BY (om.role='leader') DESC LIMIT 1) AS org
    FROM members m
    WHERE m.deleted_at IS NULL
      AND m.join_date IS NOT NULL
      AND m.join_date >= date('now','-14 days')
    ORDER BY m.join_date DESC, m.member_id DESC
    LIMIT 5
  `).all();

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
      AND strftime('%m', date_of_birth) = strftime('%m','now')
      AND deleted_at IS NULL
    ORDER BY strftime('%d', date_of_birth) LIMIT 10
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
  // Mockup-style KPI card: label top-left, icon top-right, big value, trend chip + comparison, sparkline at bottom.
  const trendChip = (delta, suffix) => {
    if (delta == null) return `<span class="trend-chip neutral">—</span> <span class="trend-meta">${esc(suffix)}</span>`;
    const up = delta >= 0;
    return `<span class="trend-chip ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(delta)}%</span> <span class="trend-meta">${esc(suffix)}</span>`;
  };
  const trendCount = (n, suffix) => {
    const up = n > 0;
    return `<span class="trend-chip ${up ? 'up' : 'neutral'}">${up ? '▲' : '⚬'} ${n}</span> <span class="trend-meta">${esc(suffix)}</span>`;
  };
  const mockupStat = (accent, icon, label, value, trendHtml, spark, color, href) => `
    <div class="stat mockup-stat dashboard-clickable" style="--stat-accent:${color}" ${cardAttrs(href, label)}>
      <div class="stat-header">
        <div class="stat-label">${label}</div>
        <div class="stat-ico ${accent}">${icon}</div>
      </div>
      <div class="stat-value">${value}</div>
      <div class="stat-trend">${trendHtml}</div>
      <div class="stat-spark">${miniSpark(spark, color)}</div>
    </div>`;
  const monthLabelNow = new Date().toLocaleString('en-GB', { month: 'long', timeZone: 'Africa/Accra' });
  const cards = `
    <div class="stat-grid mockup-kpis">
      ${mockupStat('amber', '👤', 'Total Members', totalMembers.toLocaleString(),
        trendCount(newMembersThisMonth, 'new this month'), memberSeries, 'var(--gold)', '/members')}
      ${mockupStat('purple', '◷', 'Attendance · This Week', sundayAttendance.toLocaleString(),
        trendChip(attendanceDelta, 'vs. last week'), attendanceSpark, 'var(--purple)', '/attendance')}
      ${mockupStat('blue', '₵', `Offering · ${monthLabelNow}`, fmtMoney(offeringsThisMonth),
        trendChip(offeringsDelta, 'vs. last month'), givingSeries, 'var(--blue)', '/reports/financial')}
      ${mockupStat('green', '🎂', 'Birthdays · This Week', birthdaysThisWeek.toLocaleString(),
        birthdaysToday > 0
          ? `<span class="trend-chip up">🎂 ${birthdaysToday}</span> <span class="trend-meta">${birthdaysToday === 1 ? 'birthday today' : 'birthdays today'}</span>`
          : `<span class="trend-chip neutral">—</span> <span class="trend-meta">next 7 days</span>`,
        birthdaysWeekSpark, 'var(--green)', '/members?birthday=week')}
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
          return `<div class="day-card" data-card-href="/members?day_born=${encodeURIComponent(day)}" title="Akan Names: ${esc(info.names)}" aria-label="${esc(day)} day-born members">
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
    <div class="card dashboard-clickable" ${cardAttrs('/members?birthday=month', 'Birthdays This Month')}>
      <div class="card-head"><h2>Birthdays This Month</h2><a href="/members?birthday=month">View all</a></div>
      ${birthdays.length ? birthdays.map((b) => {
        const day = new Date(b.date_of_birth);
        const when = day.toLocaleString('en', { month: 'short', day: '2-digit' });
        return `<div class="bd-row">
          <div class="av">${esc(initials(b.name))}</div>
          <div><a href="/members/${b.member_id}">${esc(b.name)}</a></div>
          <div class="when">${esc(when)}</div>
        </div>`;
      }).join('') : '<p class="muted-text">No birthdays this month.</p>'}
    </div>`;

  const followupsCard = `
    <div class="card dashboard-clickable" ${cardAttrs('/activity', 'Pending Follow-ups')}>
      <div class="card-head"><h2>Pending Follow-ups</h2><a href="/activity">View all</a></div>
      <div class="fu-row"><div class="lbl"><div class="ico">🚶</div> Visitors to follow up</div><div class="count">${followups.visitors}</div></div>
      <div class="fu-row"><div class="lbl"><div class="ico">⚠</div> Members absent &gt; 3 weeks</div><div class="count">${followups.absentees}</div></div>
      <div class="fu-row"><div class="lbl"><div class="ico">📖</div> Members without a Bible class</div><div class="count">${followups.noClass}</div></div>
      <div class="fu-row"><div class="lbl"><div class="ico">✓</div> Pending membership approvals</div><div class="count">${followups.pending}</div></div>
    </div>`;

  // Mockup-style Attendance Trend chart: dual area (this year + last year dashed), tab strip 1W·1M·3M·1Y.
  const trendValues = trendPts.length ? trendPts.map((p) => p.value) : [0];
  const trendMax = Math.max(...trendValues, 1);
  const trendMin = Math.min(...trendValues, 0);
  const trendRange = Math.max(trendMax - trendMin, 1);
  const chartW = 760, chartH = 240, padL = 40, padR = 20, padT = 28, padB = 36;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;
  const trendPath = trendPts.length
    ? trendPts.map((p, i) => {
        const x = padL + (trendPts.length === 1 ? innerW / 2 : (i / (trendPts.length - 1)) * innerW);
        const y = padT + innerH - ((p.value - trendMin) / trendRange) * innerH;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ')
    : '';
  const trendAreaPath = trendPts.length
    ? `${trendPath} L${(padL + innerW).toFixed(1)},${(padT + innerH).toFixed(1)} L${padL.toFixed(1)},${(padT + innerH).toFixed(1)} Z`
    : '';
  const trendXLabels = trendPts.length
    ? trendPts.map((p, i) => {
        if (trendPts.length > 6 && i % 2 !== 0 && i !== trendPts.length - 1) return '';
        const x = padL + (trendPts.length === 1 ? innerW / 2 : (i / (trendPts.length - 1)) * innerW);
        const d = trend[i] ? trend[i].dt.slice(5) : '';
        return `<text x="${x.toFixed(1)}" y="${(chartH - 10).toFixed(1)}" font-size="11" fill="#9aa0b3" text-anchor="middle" font-family="Inter">${esc(d)}</text>`;
      }).join('')
    : '';
  const trendCard = `
    <div class="card dashboard-clickable trend-card" ${cardAttrs('/attendance', 'Attendance Trend')}>
      <div class="card-head trend-head">
        <div>
          <h2>Attendance trend</h2>
          <div class="meta">Last ${trendPts.length} service${trendPts.length === 1 ? '' : 's'}</div>
        </div>
        <div class="trend-tabs" role="tablist" aria-label="Attendance window">
          <button class="trend-tab" type="button">1W</button>
          <button class="trend-tab active" type="button">1M</button>
          <button class="trend-tab" type="button">3M</button>
          <button class="trend-tab" type="button">1Y</button>
        </div>
      </div>
      ${trendPts.length ? `<svg class="trend-chart" viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="none" role="img" aria-label="Attendance trend for the last ${trendPts.length} services">
        <defs>
          <linearGradient id="trendArea" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#7c5cfc" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="#7c5cfc" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <g stroke="#eceef4" stroke-width="1">
          <line x1="${padL}" y1="${padT}" x2="${padL + innerW}" y2="${padT}"/>
          <line x1="${padL}" y1="${padT + innerH / 2}" x2="${padL + innerW}" y2="${padT + innerH / 2}"/>
          <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}"/>
        </g>
        <g fill="#9aa0b3" font-size="11" font-family="Inter" text-anchor="end">
          <text x="${padL - 6}" y="${padT + 4}">${trendMax.toLocaleString()}</text>
          <text x="${padL - 6}" y="${(padT + innerH / 2 + 4).toFixed(1)}">${Math.round((trendMax + trendMin) / 2).toLocaleString()}</text>
          <text x="${padL - 6}" y="${(padT + innerH + 4).toFixed(1)}">${trendMin.toLocaleString()}</text>
        </g>
        <path d="${trendAreaPath}" fill="url(#trendArea)"/>
        <path d="${trendPath}" fill="none" stroke="#7c5cfc" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${trendPts.map((p, i) => {
          const x = padL + (trendPts.length === 1 ? innerW / 2 : (i / (trendPts.length - 1)) * innerW);
          const y = padT + innerH - ((p.value - trendMin) / trendRange) * innerH;
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#7c5cfc"/>`;
        }).join('')}
        ${trendXLabels}
      </svg>` : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">📈</div>
        <h3>No attendance recorded yet</h3>
        <p>Track attendance on a service event and the trend will start populating here.</p>
      </div>`}
    </div>`;

  // Refined upcoming card with month/day tiles.
  const monthAbbr = (d) => d.toLocaleString('en-GB', { month: 'short' }).toUpperCase();
  const upcomingMockup = `
    <div class="card dashboard-clickable upcoming-card" ${cardAttrs('/events', 'Upcoming Events')}>
      <div class="card-head">
        <div>
          <h2>Upcoming</h2>
          <div class="meta">Next 7 days</div>
        </div>
        <a class="view-all" href="/events">View all →</a>
      </div>
      ${upcoming.length ? upcoming.map((e) => {
        const d = new Date(String(e.starts_at).replace(' ', 'T'));
        const m = Number.isNaN(d.getTime()) ? '' : monthAbbr(d);
        const day = Number.isNaN(d.getTime()) ? '' : String(d.getDate()).padStart(2, '0');
        const when = Number.isNaN(d.getTime()) ? '' :
          d.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `<a class="upcoming-row" href="/events/${e.event_id}">
          <div class="date-tile"><div class="m">${m}</div><div class="d">${day}</div></div>
          <div class="upcoming-body">
            <div class="evt-type">${esc(e.event_type || '')}</div>
            <div class="evt-title">${esc(e.title)}</div>
            <div class="evt-meta">${esc(when)}${e.location ? ' · ' + esc(e.location) : ''}</div>
          </div>
        </a>`;
      }).join('') : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">📅</div>
        <h3>Nothing scheduled</h3>
        <p>Add an event and it will surface here once it's within the next 7 days.</p>
      </div>`}
    </div>`;

  // Recent Members card (last 14 days) matching the mockup table.
  const sacramentLabel = (m) => {
    if (m.baptism_date && m.confirmation_date) return { cls: 'ok', text: 'Baptized · Confirmed' };
    if (m.baptism_date) return { cls: 'warn', text: 'Baptism only' };
    if (m.confirmation_date) return { cls: 'warn', text: 'Confirmation only' };
    return { cls: 'warn', text: 'Confirmation pending' };
  };
  const statusLabel = (m) => {
    if (m.membership_status === 'visitor') return { cls: 'new', text: 'New' };
    if (m.membership_status === 'regular') return { cls: 'new', text: 'Regular' };
    return { cls: 'ok', text: 'Active' };
  };
  const recentMembersRows = recentMembers.map((m) => {
    const name = `${m.first_name || ''} ${m.last_name || ''}`.trim();
    const sac = sacramentLabel(m);
    const st = statusLabel(m);
    const joined = new Date(m.join_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    return `<tr>
      <td data-label="Member"><div class="m-name-cell">
        ${memberAvatar(m)}
        <div>
          <a class="m-name" href="/members/${m.member_id}">${esc(name)}</a>
          <div class="m-sub">${esc(m.email || '')}</div>
        </div>
      </div></td>
      <td data-label="Organization">${esc(m.org || '—')}</td>
      <td data-label="Joined">${esc(joined)}</td>
      <td data-label="Sacraments"><span class="pill pill-${sac.cls}">${esc(sac.text)}</span></td>
      <td data-label="Status"><span class="pill pill-${st.cls}">${esc(st.text)}</span></td>
      <td data-label="Actions" class="row-actions"><a class="icon-btn" href="/members/${m.member_id}" aria-label="View">⋯</a></td>
    </tr>`;
  }).join('');
  const recentMembersCard = `
    <div class="card recent-members-card">
      <div class="card-head">
        <div>
          <h2>Recent Members</h2>
          <div class="meta">Registered in the last 14 days</div>
        </div>
        <div class="hero-actions">
          <a class="btn ghost" href="/members">Filter</a>
          ${isAdmin ? '<a class="btn purple" href="/members/new">＋ Add Member</a>' : ''}
        </div>
      </div>
      ${recentMembers.length ? `<table class="data-table members-table">
        <thead><tr>
          <th>Member</th><th>Organization</th><th>Joined</th><th>Sacraments</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${recentMembersRows}</tbody>
      </table>` : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">👤</div>
        <h3>No new members in the last 14 days</h3>
        <p>${isAdmin ? 'Use the Add Member button to register a new member.' : 'New members will appear here once an admin registers them.'}</p>
        ${isAdmin ? '<a class="btn primary" href="/members/new">＋ Add Member</a>' : ''}
      </div>`}
    </div>`;

  const grid = `
    <div class="dash-grid mockup-grid">
      <div class="trend-col">${trendCard}</div>
      <div class="upcoming-col">${upcomingMockup}</div>
      <div class="col-3">${dayBornCard}</div>
      <div class="col-3">${recentMembersCard}</div>
    </div>`;
  const dashboardDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Africa/Accra',
  });
  const dashboardUser = res.locals.user.display_name || res.locals.user.username;
  const firstName = (dashboardUser || '').trim().split(/\s+/)[0] || dashboardUser || 'there';
  const welcome = `
    <div class="dash-welcome dash-welcome-plain">
      <div class="dash-welcome-text">
        <div class="dash-welcome-kicker">Today · ${esc(dashboardDate)}</div>
        <h1 class="dash-h1">Welcome back, ${esc(firstName)}</h1>
        <p class="dash-sub">Here's what's happening at <strong>${esc(CHURCH_NAME)}</strong>.</p>
      </div>
      <div class="dash-welcome-actions">
        <a class="btn ghost" href="/reports">⇩ Export</a>
        ${isAdmin ? '<a class="btn purple" href="/events/new">＋ New Event</a>' : ''}
        ${isAdmin ? '<a class="btn primary" href="/finance/services">⊕ Record Service</a>' : ''}
      </div>
    </div>`;

  res.page({
    title: 'Dashboard',
    active: '/',
    noHeader: true,
    body: `<section class="dash-shell command-center mockup-dash" data-command-center="true">${welcome}${cards}${quick}${grid}</section>`,
  });
});

app.get('/delete-all/:scope', requirePermanentDeleteAll, (req, res) => {
  const scopeKey = String(req.params.scope || '');
  const scope = DELETE_ALL_SCOPES[scopeKey];
  if (!scope) return res.status(404).send(layout({
    title: 'Delete scope not found', active: null, user: res.locals.user,
    body: '<p>This delete-all tool does not exist.</p><p><a href="/">Back to dashboard</a></p>',
  }));
  const rows = deleteAllPreview(scope);
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const body = `
    ${pageHero(`Delete all ${esc(scope.label)}`, 'Permanent deletion tool for administrators and steward accounts.')}
    <section class="card danger-zone-card">
      <div class="card-head"><h2>Permanent delete warning</h2><span class="meta">${total.toLocaleString()} rows currently in scope</span></div>
      <p class="muted-text">${esc(scope.description)}</p>
      <p><strong>This does not archive records. It removes the matching rows from the database.</strong></p>
      <p class="muted-text">A verified database backup is created automatically before this delete runs. If backup creation fails, deletion is stopped.</p>
      ${rows.length ? table(['Table', 'Rows now'],
        rows.map((row) => [esc(row.name), Number(row.count || 0).toLocaleString()]))
        : '<p class="muted-text">No database tables are currently available for this scope.</p>'}
      <form class="form delete-all-form" method="post" action="/delete-all/${esc(scopeKey)}">
        <label class="wide">Type this exact phrase to confirm
          <input name="confirm_phrase" autocomplete="off" required value="" placeholder="${esc(scope.phrase)}">
        </label>
        <label class="wide">Reason / note
          <input name="reason" placeholder="Optional note for the audit log">
        </label>
        <div class="actions">
          <a class="btn ghost" href="${esc((scope.active && scope.active[0]) || '/')}">Cancel</a>
          <button class="danger" type="submit">Delete all ${esc(scope.label)} permanently</button>
        </div>
      </form>
    </section>`;
  res.page({ title: `Delete all ${scope.label}`, active: (scope.active && scope.active[0]) || null, body });
});

app.post('/delete-all/:scope', requirePermanentDeleteAll, async (req, res) => {
  const scopeKey = String(req.params.scope || '');
  const scope = DELETE_ALL_SCOPES[scopeKey];
  if (!scope) return res.status(404).send('Delete scope not found');
  const phrase = String(req.body.confirm_phrase || '').trim();
  if (phrase !== scope.phrase) {
    flash(req, `Confirmation phrase did not match. Type: ${scope.phrase}`);
    return res.redirect(`/delete-all/${encodeURIComponent(scopeKey)}`);
  }
  let backupNameBeforeDelete = '';
  try {
    backupNameBeforeDelete = await createBackup();
    logSecurityEvent(req, 'pre_delete_backup_created',
      `scope:${scopeKey};backup:${backupNameBeforeDelete}`, res.locals.user.user_id);
  } catch (e) {
    logSecurityEvent(req, 'pre_delete_backup_failed',
      `scope:${scopeKey};error:${e.message}`, res.locals.user.user_id);
    flash(req, `Delete stopped because the pre-delete backup failed: ${e.message}`);
    return res.redirect(`/delete-all/${encodeURIComponent(scopeKey)}`);
  }
  const beforeRows = performPermanentDelete(scopeKey, res.locals.user.user_id);
  const total = beforeRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const note = String(req.body.reason || '').trim();
  logSecurityEvent(req, 'permanent_delete_all',
    `scope:${scopeKey};rows:${total};backup:${backupNameBeforeDelete}${note ? ';note:' + note.slice(0, 160) : ''}`,
    res.locals.user.user_id);
  flash(req, `Backup ${backupNameBeforeDelete} created, then deleted all ${scope.label} data permanently (${total.toLocaleString()} rows removed).`, 'success');
  res.redirect((scope.active && scope.active[0]) || '/');
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
  requireAdmin, logActivity, layout, flash, PUBLIC_URL, ICON_EYE, ICON_PENCIL,
});

// ---------- finance (record-only ledger) ----------
require('./routes/finance').register(app, {
  db, requireAdmin, requireFinanceWrite, requireFinanceAccounting,
  logActivity, flash, CHURCH_NAME, sendSmsBatch, sendEmailEach, loadOrganizations,
});

// ---------- reports ----------
require('./routes/reports').register(app, { db, CHURCH_NAME });

// ---------- attendance (cross-event view) ----------
// ---------- attendance ----------
require('./routes/attendance').register(app, {
  db, esc, sparkline, table, pageHero, statsRow, listCard,
  requireAdmin, logActivity, flash,
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
  photoUpload, csvUpload, EXT_FROM_MIME, PHOTO_DIR, PREF_LABELS, nextMemberId,
  loadBibleClasses, loadOrganizations, sendSmsBatch, sendEmailEach, CHURCH_NAME,
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

// ---------- help ----------
app.get('/help', (req, res) => {
  const helpSection = (id, icon, title, summary, steps) => `
    <div class="card help-card" id="${id}">
      <div class="card-head"><h2>${icon} ${esc(title)}</h2></div>
      <p>${summary}</p>
      ${steps ? `<ol class="help-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : ''}
    </div>`;
  const body = `
    ${pageHero('Help & Guide', 'How to use the Dunwell Methodist church management system, page by page.')}
    <div class="card help-toc">
      <div class="card-head"><h2>On this page</h2><span class="meta">Jump to a section</span></div>
      <ul class="help-toc-list">
        <li><a href="#help-overview">Overview</a></li>
        <li><a href="#help-dashboard">Dashboard</a></li>
        <li><a href="#help-members">Members</a></li>
        <li><a href="#help-attendance">Attendance</a></li>
        <li><a href="#help-events">Events</a></li>
        <li><a href="#help-finance">Finance</a></li>
        <li><a href="#help-communications">Communications</a></li>
        <li><a href="#help-bible-classes">Bible Classes &amp; Organizations</a></li>
        <li><a href="#help-preaching">Preaching Plan</a></li>
        <li><a href="#help-reports">Reports &amp; Operations</a></li>
        <li><a href="#help-admin">Admin · Users · Backups</a></li>
        <li><a href="#help-tips">Daily &amp; weekly tips</a></li>
      </ul>
    </div>

    ${helpSection('help-overview', '📖', 'Overview',
      `<strong>Dunwell Methodist Management System</strong> is one place for every operational job in the parish: keep the member directory, run check-ins, record giving, plan services, send broadcasts, and review reports. The left sidebar groups every page; the top bar has the global search, theme toggle, and your profile menu.`,
      [
        'Use the <strong>search bar</strong> at the top of any page to jump straight to a member by name, phone, or email.',
        'Click the <strong>🌙 / ☀</strong> button to flip between light and dark mode — your choice persists per device.',
        'Your role (Administrator · Editor · Viewer) controls what you can edit. Viewers can browse everything; editors can manage records; administrators can run the whole system.',
      ])}

    ${helpSection('help-dashboard', '▥', 'Dashboard',
      `The dashboard is your daily snapshot: a welcome banner with today's date and quick actions, four KPI cards (Total Members · Attendance·This Week · Offering·<Month> · Birthdays·This Week), an attendance trend chart, upcoming events for the next 7 days, the Akan day-born groups, and the most recently registered members.`,
      [
        'Click any KPI card to drill into the relevant page (e.g. Total Members → Members directory).',
        '<strong>＋ New Event</strong> or <strong>⊕ Record Service</strong> in the welcome banner are the fastest way to start a common task.',
        'The Day-born Groups card shows the Akan fellowship grouping with member counts per day. Use it to coordinate small-group leaders.',
      ])}

    ${helpSection('help-members', '👥', 'Members',
      `The Members directory holds every person in the parish. Filter by Bible class, status (Member · Regular · Visitor · Inactive), search by phone or email, and act in bulk.`,
      [
        '<strong>＋ Add New Member</strong> opens a form for identity, contact, sacraments and emergency contact.',
        "Click a row to open the member's full profile: photo, sacraments timeline, organizations, giving history, attendance heat-map.",
        'Admins can <strong>archive</strong> a member with the trash icon — the record stays for audit but hides from the directory.',
        'The <strong>MoMo ready</strong> badge means the member has a phone on file, so SMS broadcasts can reach them.',
      ])}

    ${helpSection('help-attendance', '✓', 'Attendance',
      `Attendance records who showed up to each service. Now you can also log the head-count broken down by Men, Women, Children, and a Total.`,
      [
        'Open a service event under <strong>Events</strong>, then enter the per-segment count (Men · Women · Children). The Total updates automatically.',
        'Counts are <strong>editable</strong> — open the same service later, change a number, and save. The trend chart on the dashboard updates immediately.',
        'For per-person check-ins, use the QR check-in page (admin-only).',
        'Last 3 service averages and a sparkline trend live at the top of the Attendance page.',
      ])}

    ${helpSection('help-events', '📅', 'Events',
      `Schedule services, rehearsals, weddings, confirmations and other parish events. Each event has a type, date/time, location, and an editable record.`,
      [
        '<strong>＋ New Event</strong> creates a fresh event. Pick a type — <em>service · prayer · bible_study · outreach · youth · wedding · funeral · baptism · confirmation · other</em>.',
        'Open an event and click <strong>✎ Edit event</strong> to change any field after the fact.',
        "The calendar view (top-right toggle) shows a month-at-a-glance grid; click any day to see what's on.",
        "RSVPs collect responses (Going / Maybe / Can't) and the public RSVP link can be shared by SMS or email broadcast.",
      ])}

    ${helpSection('help-finance', '₵', 'Finance',
      `Track giving across services, tithes, harvests, special offerings, pledges, statements and expenses. Sub-tabs across the top of the Finance page navigate between them.`,
      [
        '<strong>＋ Record Service</strong> on the Finance overview captures a service offering total plus the day-born breakdown.',
        'Tithes are linked to specific members so per-member statements work; harvests run as multi-week campaigns.',
        'Special Offerings track named campaigns (e.g. Building Fund). Expenses log outgoings.',
        'Generate <strong>statements</strong> per member or pull a <strong>print view</strong> of every report from the Reports page.',
      ])}

    ${helpSection('help-communications', '✉', 'Communications',
      `Post announcements to the website, broadcast SMS / email to members, and review delivery logs.`,
      [
        'Use <strong>＋ Send SMS/email broadcast</strong> to message a group — filter by Bible class, status, or specific organizations.',
        'Configure your SMS sender (Arkesel) and SMTP from <a href="/settings">Settings</a>. Until configured, broadcasts run in dry-run mode and nothing is actually sent.',
        'The broadcasts log shows delivery state per recipient: Sent · Failed · Pending · Skipped.',
      ])}

    ${helpSection('help-bible-classes', '📖', 'Bible Classes & Organizations',
      `Bible Classes are small groups led by a teacher; Organizations are bigger ministries (Choir, Boys' Brigade, Women's Fellowship, etc.).`,
      [
        "Edit a Bible class's leader and parent organization inline from the list.",
        'Open an organization to manage its roster, leader and meeting time.',
        'Both pages support search and quick add (admins only).',
      ])}

    ${helpSection('help-preaching', '🎤', 'Preaching Plan',
      `Schedule who preaches when. The "Next up" callout at the top of the page highlights the next assignment.`,
      [
        '<strong>＋ Send reminder</strong> on the Next up callout sends an SMS / email to the preacher (requires phone or email).',
        'Past assignments are kept for record-keeping — search the table to find a sermon topic or scripture reference.',
      ])}

    ${helpSection('help-reports', '📊', 'Reports & Operations',
      `Reports compiles every analytical view (Day-born totals, Collections, Harvests, Special, Expenses, Financial Summary, Members) with a date-range filter. Operations is owner-only and shows production-readiness checks.`,
      [
        'On each report, set a From / To date range and click Apply.',
        'Print or save as PDF from the browser dialog — every report has print-optimized styles.',
        '<strong>Operations</strong> aggregates: database readiness, backup freshness, audit signal, error volume in the last 24 hours, and integration configuration.',
      ])}

    ${helpSection('help-admin', '🔑', 'Admin · Users · Backups',
      `Owner-only pages for setting up the system and keeping it safe.`,
      [
        '<strong>Users & Roles</strong>: add staff, set roles, reset passwords. Only the main administrator can add or delete accounts.',
        '<strong>Backups</strong>: take an immediate snapshot, verify integrity, restore from a previous one. Always keep at least one off-site copy.',
        '<strong>Security Audit</strong>: review every login, password change, and role update.',
        '<strong>Error Log</strong>: server-side errors land here with the request URL and stack — share with support when reporting an issue.',
      ])}

    ${helpSection('help-tips', '✨', 'Daily & weekly tips', `A few habits that keep the data clean.`,
      [
        '<strong>Daily</strong>: glance at the dashboard for Pending Follow-ups (drilling into Reports).',
        '<strong>Sunday</strong>: enter the Men / Women / Children counts for the service while the data is fresh, and check in any visitors on the spot.',
        '<strong>Weekly</strong>: review the Birthdays card; the system can also auto-send personalized birthday SMS at a daily run time (Settings → Birthday automation).',
        '<strong>Monthly</strong>: open Reports and confirm Finance totals match the bank reconciliation.',
        '<strong>Anytime</strong>: if anything looks off, the Error Log captures the most recent server-side errors.',
      ])}`;
  res.page({ title: 'Help & Guide', active: '/help', noHeader: true, body });
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
    : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">💾</div>
        <h3>No backups yet</h3>
        <p>Create your first snapshot of the church database below. Keep at least one off-site copy.</p>
      </div>`;

  const tools = `
    <div class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Create &amp; restore</h2></div>
      <div class="filter-bar">
        <form method="post" action="/backups/create"><button class="btn primary" type="submit">＋ Create backup now</button></form>
        <form method="post" action="/backups/restore-upload" enctype="multipart/form-data" class="filter-bar" style="margin:0"
              onsubmit="return confirm('Restore from the uploaded file on next restart? The current database is copied aside first.')">
          <input type="file" name="backup" accept=".db,.sqlite,application/octet-stream" required>
          <button class="btn ghost" type="submit">Upload &amp; stage restore</button>
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
      ${listCard({ title: 'Available Backups', count: backups.length, countLabel: 'files', inner: rows })}`,
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
      <div class="card-head"><h2>Application</h2><span class="meta">Runtime configuration</span></div>
      <dl class="stats">
        <dt>Church name</dt><dd>${esc(CHURCH_NAME)} <span class="muted-text">(set via the CHURCH_NAME env var)</span></dd>
        <dt>Database</dt><dd><code>${esc(DB_PATH)}</code></dd>
        <dt>Currency</dt><dd>Ghanaian cedi (GH₵)</dd>
      </dl>
    </div>
    <div class="card">
      <div class="card-head"><h2>Roles &amp; access</h2><span class="meta">Who can do what</span></div>
      <p>Manage user accounts and permissions on the <a href="/users">Users &amp; Roles</a> page.</p>
    </div>
    <div class="card">
      <div class="card-head"><h2>Maintenance</h2><span class="meta">Backups &amp; errors</span></div>
      <p>Snapshots and restore on the <a href="/backups">Backups</a> page · recent server errors in the <a href="/errors">Error Log</a>.</p>
    </div>
    <div class="card">
      <div class="card-head"><h2>SMS &amp; Email</h2><span class="meta">Outbound providers</span></div>
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
      <div class="card-head"><h2>Send a test message</h2><span class="meta">Dry-run if provider unset</span></div>
      <p class="muted-text">Verify your settings by sending yourself a test. If a service isn't configured, you'll get a dry-run notice instead of a real send.</p>
      <form method="post" action="/settings/test-sms" class="filter-bar" data-no-confirm="1" style="margin-bottom:0.6rem">
        <input type="tel" name="to" placeholder="Phone, e.g. 0244123456" required style="flex:1;min-width:200px">
        <button class="btn primary" type="submit">＋ Send test SMS</button>
      </form>
      <form method="post" action="/settings/test-email" class="filter-bar" data-no-confirm="1">
        <input type="email" name="to" placeholder="you@example.com" required style="flex:1;min-width:200px">
        <button class="btn primary" type="submit">＋ Send test email</button>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h2>Birthday automation</h2><span class="meta">Daily SMS run</span></div>
      <dl class="stats">
        <dt>Daily run time</dt><dd>${BIRTHDAY_HOUR}:00 (server time)</dd>
        <dt>Last run</dt><dd>${esc(getState('last_birthday_send') || '—')}</dd>
        <dt>Today's eligible</dt><dd>${todaysBirthdayMembers().length} member(s)</dd>
        <dt>Template</dt><dd><code>${esc(BIRTHDAY_TEMPLATE)}</code></dd>
      </dl>
      <p>The system sends a personalized SMS to every member whose birthday matches today's date, has a phone, and hasn't opted out. To customize the message, set the <code>BIRTHDAY_TEMPLATE</code> env var. Tokens: <code>{first_name}</code>, <code>{last_name}</code>, <code>{church_name}</code>.</p>
      <form method="post" action="/settings/birthdays/run">
        <button class="btn primary" type="submit">＋ Send today's birthday messages now</button>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><h2>Backup</h2><span class="meta">Fly SSH snapshot</span></div>
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
  const roleLabel = ({ admin: 'Administrator', editor: 'Editor', viewer: 'Viewer' }[u.role] || u.role);
  const financeRoleLabel = FINANCE_ROLE_LABELS[u.finance_role || 'none'] || u.finance_role || 'No finance access';
  const body = `
    ${pageHero('Profile', 'Account controls for your signed-in user.')}
    <div class="card" style="margin-bottom:1rem">
      <div class="card-head"><h2>Account</h2><span class="meta">Signed-in user</span></div>
      <dl class="stats">
        <dt>Username</dt><dd><strong>${esc(u.username)}</strong></dd>
        <dt>Display name</dt><dd>${esc(u.display_name || '—')}</dd>
        <dt>Role</dt><dd><span class="pill pill-${esc(u.role)}">${esc(roleLabel)}</span></dd>
        <dt>Finance role</dt><dd><span class="pill">${esc(financeRoleLabel)}</span></dd>
      </dl>
    </div>
    <div class="card">
      <div class="card-head"><h2>Change password</h2><span class="meta">Min 8 characters</span></div>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <form class="form" method="post" action="/profile/password" style="box-shadow:none;border:0;padding:0">
        <label class="wide">Current password<input type="password" name="current" required></label>
        <label class="wide">New password<input type="password" name="next" required minlength="8"></label>
        <label class="wide">Confirm new password<input type="password" name="next2" required></label>
        <div class="actions form-actions">
          <a class="btn ghost" href="/">Done</a>
          <button type="submit">Update password</button>
        </div>
      </form>
    </div>`;
  res.page({ title: 'Profile', active: '/profile', noHeader: true, body, flash });
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
    `SELECT user_id, username, display_name, role, finance_role, created_at FROM users
     WHERE deleted_at IS NULL ORDER BY username`
  ).all();
  const rows = users.map((u) => [
    esc(u.username),
    esc(u.display_name) || '—',
    `<span class="role-badge role-${esc(u.role)}">${esc(u.role)}</span>`,
    esc(FINANCE_ROLE_LABELS[u.finance_role || 'none'] || u.finance_role || 'none'),
    esc(u.created_at).slice(0, 10),
    `<form method="post" action="/users/${u.user_id}/role" class="inline">
       <select name="role">
         <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin (full access)</option>
         <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>editor (manage records)</option>
         <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>viewer (read-only)</option>
       </select>
       <select name="finance_role">
         ${Object.entries(FINANCE_ROLE_LABELS).map(([value, label]) =>
           `<option value="${esc(value)}" ${(u.finance_role || 'none') === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
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
    <p class="muted-text">Finance roles are separate: <strong>Cashiers</strong> record income/expenses,
      <strong>Treasurers</strong> record and review accounting, <strong>Auditors</strong> review accounting only,
      and <strong>Finance admins</strong> can do both.</p>
    ${res.locals.isUserManager ? '<div class="page-actions"><a class="btn primary" href="/users/new">＋ New user</a></div>' : ''}
    ${table(['Username', 'Display name', 'Role', 'Finance role', 'Created', 'Actions'], rows)}`;
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
      <label>Finance role<select name="finance_role">
        ${Object.entries(FINANCE_ROLE_LABELS).map(([value, label]) =>
          `<option value="${esc(value)}"${value === 'none' ? ' selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <span class="hint">Finance roles control recording and accounting access inside the Finance module.</span></label>
      <div class="actions form-actions">
        <a class="btn ghost" href="/users">Cancel</a>
        <button type="submit">Create user</button>
      </div>
    </form>`;
  res.page({ title: 'New user', active: '/users', body });
});

app.post('/users', requireUserManager, (req, res) => {
  const { username, display_name, password, role, finance_role } = req.body;
  if (!username || !password || password.length < 8) return res.redirect('/users/new');
  const r = ['admin', 'editor', 'viewer'].includes(role) ? role : 'viewer';
  const fr = Object.hasOwn(FINANCE_ROLE_LABELS, finance_role) ? finance_role : 'none';
  try {
    const info = db.prepare(
      `INSERT INTO users (username, password_hash, display_name, role, finance_role) VALUES (?, ?, ?, ?, ?)`
    ).run(username.trim(), bcrypt.hashSync(password, 12), (display_name || '').trim() || null, r, fr);
    logSecurityEvent(req, 'user_created', `user_id:${info.lastInsertRowid};role:${r};finance_role:${fr}`, res.locals.user.user_id);
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
  const fr = Object.hasOwn(FINANCE_ROLE_LABELS, req.body.finance_role) ? req.body.finance_role : 'none';
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
  db.prepare(`UPDATE users SET role=?, finance_role=? WHERE user_id=?`).run(r, fr, id);
  logSecurityEvent(req, 'user_role_changed', `user_id:${id};role:${r};finance_role:${fr}`, res.locals.user.user_id);
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
  const inner = rows.length
    ? table(['When', 'Event', 'Actor', 'Subject', 'IP'], rows.map((r) => [
        esc(r.occurred_at),
        esc(r.event),
        esc(r.actor || 'system/anonymous'),
        esc(r.subject || '—'),
        esc(r.ip || '—'),
      ]))
    : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">🔒</div>
        <h3>No audit events yet</h3>
        <p>Logins, password changes, role updates and other security-sensitive actions will be logged here. Use this after deploys and account changes.</p>
      </div>`;
  const body = `
    ${pageHero('Security Audit', 'Owner-only review of login, password and role events.')}
    ${listCard({ title: 'Recent security events', count: rows.length, countLabel: 'events', note: 'Most recent first · max 100', inner })}`;
  res.page({ title: 'Security Audit', active: '/security/audit', noHeader: true, body });
});

app.get('/activity', requireOwner, (req, res) => {
  const kind = String(req.query.kind || '').trim();
  const link = String(req.query.link || '').trim();
  const kinds = db.prepare(`
    SELECT kind, COUNT(*) count
    FROM activity_log
    GROUP BY kind
    ORDER BY count DESC, kind`).all();
  const params = {};
  let where = '';
  if (kind) {
    where = 'WHERE al.kind = @kind';
    params.kind = kind;
  }
  if (link) {
    where = where ? `${where} AND al.link = @link` : 'WHERE al.link = @link';
    params.link = link;
  }
  const rows = db.prepare(`
    SELECT al.occurred_at, al.kind, al.description, al.link,
           u.username, u.display_name
    FROM activity_log al
    LEFT JOIN users u ON u.user_id=al.user_id
    ${where}
    ORDER BY al.activity_id DESC
    LIMIT 200`).all(params);
  const kindOptions = `<option value="">All activity</option>` + kinds.map((row) =>
    `<option value="${esc(row.kind)}" ${row.kind === kind ? 'selected' : ''}>${esc(row.kind)} (${row.count})</option>`
  ).join('');
  const filters = `<form class="filters" method="get" action="/activity">
    <label>Type <select name="kind">${kindOptions}</select></label>
    <label>Record link <input name="link" value="${esc(link)}" placeholder="/members/1"></label>
    <button type="submit">Apply</button>
    <a class="btn ghost" href="/activity">Clear</a>
  </form>`;
  const inner = rows.length
    ? table(['When', 'Type', 'User', 'Description', 'Link'], rows.map((row) => [
      esc(row.occurred_at),
      esc(row.kind),
      esc(row.display_name || row.username || 'system'),
      esc(row.description),
      row.link ? `<a href="${esc(row.link)}">Open</a>` : '—',
    ]))
    : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">•</div>
        <h3>No activity found</h3>
        <p>Operational changes will appear here as users work in the system.</p>
      </div>`;
  res.page({
    title: 'Activity Audit',
    active: '/activity',
    noHeader: true,
    body: `${pageHero('Activity Audit', 'Owner-only review of operational changes across the church system.')}
      ${filters}
      ${listCard({ title: 'Recent Activity', count: rows.length, countLabel: 'events', note: 'Most recent first · max 200', inner })}`,
  });
});

app.get('/operations/health-report.txt', requireOwner, (req, res) => {
  const lines = [];
  const add = (label, value) => lines.push(`${label}: ${value}`);
  const backups = listBackups();
  const recentErrors = db.prepare(`
    SELECT COUNT(*) AS c FROM error_log
    WHERE occurred_at >= datetime('now','-24 hours')`).get().c;
  const activeUsers = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL`).get().c;
  const ledgerIssues = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT je.entry_id
      FROM journal_entries je JOIN journal_lines jl USING(entry_id)
      GROUP BY je.entry_id
      HAVING ROUND(SUM(jl.debit), 2) != ROUND(SUM(jl.credit), 2)
    )`).get().c;
  add('Generated', new Date().toISOString());
  add('Database', 'ready');
  add('Active users', activeUsers);
  add('Backups retained', backups.length);
  add('Latest backup', backups[0] ? `${backups[0].name} (${fmtBytes(backups[0].size)})` : 'none');
  add('Errors in last 24h', recentErrors);
  add('Unbalanced journals', ledgerIssues);
  add('SMS provider', ARKESEL_API_KEY ? 'configured' : 'dry-run');
  add('Email provider', SMTP_HOST && SMTP_USER && SMTP_PASS ? 'configured' : 'dry-run');
  add('Off-site backup upload', process.env.BACKUP_UPLOAD_URL ? 'configured' : 'not configured');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="operations-health-report.txt"');
  res.send(lines.join('\n') + '\n');
});

function usageStatus(value, limit) {
  if (!limit) return 'available';
  const ratio = Number(value || 0) / Number(limit || 1);
  if (ratio >= 1) return 'attention';
  if (ratio >= 0.85) return 'pending';
  return 'ready';
}

function alertReadinessRows() {
  const backups = listBackups();
  const latestBackup = backups[0] || null;
  const recentErrors = db.prepare(`
    SELECT COUNT(*) AS c
    FROM error_log
    WHERE occurred_at >= datetime('now','-24 hours')`).get().c;
  const unbalanced = db.prepare(`
    SELECT COUNT(*) c
    FROM journal_entries je
    LEFT JOIN (
      SELECT entry_id, ROUND(SUM(debit),2) debit, ROUND(SUM(credit),2) credit
      FROM journal_lines GROUP BY entry_id
    ) totals USING(entry_id)
    WHERE je.status='POSTED' AND ROUND(COALESCE(totals.debit,0)-COALESCE(totals.credit,0),2) != 0
  `).get().c;
  const alerts = [];
  if (!latestBackup) alerts.push({ severity: 'critical', message: 'No retained database backup found.', link: '/backups' });
  if (!process.env.BACKUP_UPLOAD_URL) alerts.push({ severity: 'warning', message: 'Off-site backup upload is not configured.', link: '/backups' });
  if (!ALERT_WEBHOOK_URL && !ALERT_EMAIL) alerts.push({ severity: 'warning', message: 'Alert routing is not configured.', link: '/operations' });
  if (recentErrors > 0) alerts.push({ severity: 'warning', message: `${recentErrors} server error${recentErrors === 1 ? '' : 's'} in the last 24 hours.`, link: '/errors' });
  if (unbalanced > 0) alerts.push({ severity: 'critical', message: `${unbalanced} unbalanced posted journal entr${unbalanced === 1 ? 'y' : 'ies'} found.`, link: '/finance/accounting' });
  return alerts;
}

app.get('/operations/alerts.json', requireOwner, (req, res) => {
  const alerts = alertReadinessRows();
  res.json({
    ok: alerts.every((alert) => alert.severity !== 'critical'),
    alert_routing: ALERT_WEBHOOK_URL || ALERT_EMAIL ? 'configured' : 'not_configured',
    alerts,
  });
});

app.get('/tenant', requireOwner, (req, res) => {
  const planKey = currentPlanKey();
  const plan = currentPlan();
  const usage = tenantUsage();
  const subscriptionStatus = getState('subscription_status') || 'trial';
  const signup = db.prepare(`
    SELECT church_name, contact_name, email, plan, member_count, status, activated_at
    FROM trial_signups
    ORDER BY signup_id DESC LIMIT 1`).get();
  const usageRows = [
    ['Members', usage.members, plan.members],
    ['Users', usage.users, plan.users],
    ['Branches', usage.branches, plan.branches],
  ].map(([label, value, limit]) => [
    esc(label),
    Number(value).toLocaleString(),
    Number(limit).toLocaleString(),
    `<span class="pill pill-${usageStatus(value, limit)}">${esc(usageStatus(value, limit))}</span>`,
  ]);
  const planOptions = Object.entries(PLAN_LIMITS)
    .map(([key, p]) => `<option value="${esc(key)}" ${key === planKey ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  const statusOptions = ['trial', 'active', 'past_due', 'suspended']
    .map((status) => `<option value="${status}" ${status === subscriptionStatus ? 'selected' : ''}>${status}</option>`).join('');
  const onboardingRows = [
    ['Tenant isolation model', 'private deployment per church', 'Documented in docs/SAAS_TENANCY_REVIEW.md'],
    ['Current plan', plan.label, plan.support],
    ['Latest signup', signup ? `${signup.church_name} · ${signup.email}` : 'none', signup ? `${signup.status || 'pending'} · ${signup.plan || 'pro'}` : 'No signup record'],
    ['Off-site backups', process.env.BACKUP_UPLOAD_URL ? 'configured' : 'not configured', process.env.BACKUP_UPLOAD_URL ? 'BACKUP_UPLOAD_URL is set' : 'Set BACKUP_UPLOAD_URL before public SaaS launch'],
    ['Alert routing', ALERT_WEBHOOK_URL || ALERT_EMAIL ? 'configured' : 'not configured', ALERT_WEBHOOK_URL ? 'Webhook configured' : (ALERT_EMAIL ? `Email: ${ALERT_EMAIL}` : 'Set ALERT_WEBHOOK_URL or ALERT_EMAIL')],
  ];
  res.page({
    title: 'Tenant',
    active: '/tenant',
    noHeader: true,
    body: `${pageHero('Tenant Admin', 'Owner controls for SaaS plan, usage limits and onboarding readiness.')}
      ${statsRow([
        { cls: 'blue', icon: '▣', value: esc(plan.label), label: 'Plan' },
        { cls: subscriptionStatus === 'active' ? 'green' : 'orange', icon: '✓', value: esc(subscriptionStatus), label: 'Subscription' },
        { cls: usageStatus(usage.members, plan.members) === 'ready' ? 'green' : 'orange', icon: '👥', value: `${usage.members}/${plan.members}`, label: 'Members' },
        { cls: usageStatus(usage.users, plan.users) === 'ready' ? 'green' : 'orange', icon: '🔑', value: `${usage.users}/${plan.users}`, label: 'Users' },
      ])}
      <section class="card">
        <div class="card-head"><h2>Plan Controls</h2><span class="meta">Manual until billing automation is connected</span></div>
        <form class="form" method="post" action="/tenant">
          <label>Plan<select name="plan">${planOptions}</select></label>
          <label>Status<select name="status">${statusOptions}</select></label>
          <div class="actions"><button type="submit">Save tenant settings</button></div>
        </form>
      </section>
      ${listCard({ title: 'Usage Against Limits', count: usageRows.length, countLabel: 'limits', inner: table(['Metric', 'Current', 'Limit', 'Status'], usageRows) })}
      ${listCard({ title: 'SaaS Readiness', count: onboardingRows.length, countLabel: 'checks', inner: table(['Area', 'Status', 'Detail'], onboardingRows.map((row) => row.map(esc))) })}`,
  });
});

app.post('/tenant', requireOwner, (req, res) => {
  const plan = Object.hasOwn(PLAN_LIMITS, req.body.plan) ? req.body.plan : 'pro';
  const status = ['trial', 'active', 'past_due', 'suspended'].includes(req.body.status) ? req.body.status : 'trial';
  setState('current_plan', plan);
  setState('subscription_status', status);
  logSecurityEvent(req, 'tenant_settings_changed', `plan:${plan};status:${status}`, res.locals.user.user_id);
  flash(req, 'Tenant settings updated.', 'success');
  res.redirect('/tenant');
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
  const authMetrics = db.prepare(`
    SELECT
      SUM(CASE WHEN event='login_failed'  AND occurred_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS fails_24h,
      SUM(CASE WHEN event='login_failed'  AND occurred_at >= datetime('now','-7 days')   THEN 1 ELSE 0 END) AS fails_7d,
      SUM(CASE WHEN event='login_success' AND occurred_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS logins_24h
    FROM security_audit_log`).get();
  const notifMetrics = db.prepare(`
    SELECT
      COALESCE(SUM(successful_sends), 0) AS total_sent,
      COALESCE(SUM(failed_sends),     0) AS total_failed,
      COUNT(*) AS total_broadcasts
    FROM broadcasts
    WHERE sent_at >= datetime('now','-30 days')`).get();
  const plan = currentPlan();
  const usage = tenantUsage();
  const alertRows = alertReadinessRows();

  let dbStatus = 'ready';
  try { db.prepare('SELECT 1').get(); } catch (_) { dbStatus = 'not ready'; }

  const checks = [
    ['Database readiness', dbStatus, dbStatus === 'ready' ? 'SELECT 1 succeeded' : 'Database query failed', '/readyz'],
    ['Tenant plan limits', usageStatus(usage.members, plan.members), `${plan.label}: ${usage.members}/${plan.members} members, ${usage.users}/${plan.users} users`, '/tenant'],
    ['Latest backup', latestBackup ? 'available' : 'missing', latestBackup ? `${latestBackup.name} · ${fmtBytes(latestBackup.size)}` : 'No backup files are retained', '/backups'],
    ['Backup verification', backupVerified ? 'verified' : 'pending', backupVerified ? `${backupVerified.occurred_at} · ${backupVerified.subject}` : 'Verify the latest backup from Backups', '/backups'],
    ['Error log', recentErrors ? 'attention' : 'clear', `${recentErrors} error${recentErrors === 1 ? '' : 's'} in the last 24 hours`, '/errors'],
    ['Security audit', lastAudit ? 'active' : 'empty', lastAudit ? `${lastAudit.occurred_at} · ${lastAudit.event}` : 'No audit events yet', '/security/audit'],
    ['Activity audit', 'active', 'Review member, finance, attendance and communication changes', '/activity'],
    ['Alert routing', ALERT_WEBHOOK_URL || ALERT_EMAIL ? 'configured' : 'not configured',
      ALERT_WEBHOOK_URL ? 'Webhook configured' : (ALERT_EMAIL ? `Email: ${ALERT_EMAIL}` : `${alertRows.length} current alert${alertRows.length === 1 ? '' : 's'}; set ALERT_WEBHOOK_URL or ALERT_EMAIL`), '/operations/alerts.json'],
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
      <section class="card" style="margin-top:1rem">
        <div class="card-head"><h2>Operational Metrics</h2><span class="meta">Auth, errors, notifications</span></div>
        ${table(['Metric', 'Value', 'Notes'], [
          ['Login failures (24h)',  String(authMetrics.fails_24h  || 0),
            authMetrics.fails_24h > 10 ? '⚠ Elevated — review /security/audit' : 'Normal'],
          ['Login failures (7d)',   String(authMetrics.fails_7d   || 0),
            authMetrics.fails_7d  > 50 ? '⚠ Elevated — review /security/audit' : 'Normal'],
          ['Successful logins (24h)', String(authMetrics.logins_24h || 0), 'Distinct login events'],
          ['App errors (24h)',      String(recentErrors || 0),
            recentErrors > 0 ? '⚠ See /errors for details' : 'No unhandled errors'],
          ['Broadcasts (30d)',      String(notifMetrics.total_broadcasts || 0),
            `${notifMetrics.total_sent || 0} sent · ${notifMetrics.total_failed || 0} failed`],
        ])}
      </section>
      <div class="card" style="margin-top:1rem">
        <div class="card-head"><h2>Runbook</h2><a href="/operations/health-report.txt">Download health report</a></div>
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
  ensureTrialWindow();
  logSecurityEvent(req, 'first_admin_created', `user_id:${info.lastInsertRowid}`, info.lastInsertRowid);
  req.session.userId = info.lastInsertRowid;
  res.redirect('/');
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect(trialHasExpired() ? '/billing' : '/');
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
  res.redirect(trialHasExpired() ? '/billing' : '/');
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
    : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">✓</div>
        <h3>All clear</h3>
        <p>No errors have been logged. If something does go wrong, the request and stack trace will land here.</p>
      </div>`;
  res.page({
    title: 'Error Log', active: null, noHeader: true,
    body: `${pageHero('Error Log', 'The 100 most recent server errors captured by the app.')}
      ${listCard({ title: 'Recent Errors', count: rows.length, countLabel: 'logged', inner })}`,
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
