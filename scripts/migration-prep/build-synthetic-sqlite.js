'use strict';
// Phase 7 PREP (not production): builds a synthetic SQLite database, shaped
// like the real production church.db, with representative sample data
// across the tables scripts/migration-prep/migrate-sqlite-to-postgres.js
// covers. This lets the migration script be built and verified end-to-end
// WITHOUT touching the live Fly app or real production data — that step
// (pulling an actual copy of prod) is deliberately deferred until the user
// explicitly wants to run a real staging rehearsal.
//
// Deliberately covers a circular-FK case (members.bible_class_id <->
// ministries.leader_id) since that's the trickiest part of the real schema
// to migrate correctly.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const OUT_PATH = path.join(__dirname, 'synthetic-church.db');
try { fs.unlinkSync(OUT_PATH); } catch (_) {}

const db = new Database(OUT_PATH);
db.pragma('foreign_keys = OFF'); // matches how the real schema.sql seeds itself (deferred FK checking)

db.exec(`
  CREATE TABLE users (
    user_id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    display_name TEXT, role TEXT NOT NULL DEFAULT 'admin', finance_role TEXT NOT NULL DEFAULT 'none',
    email TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
  );
  CREATE TABLE members (
    member_id INTEGER PRIMARY KEY, external_id TEXT UNIQUE, bible_class_id INTEGER,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, mobile_phone TEXT,
    date_of_birth TEXT, day_born TEXT, gender TEXT, marital_status TEXT,
    membership_status TEXT NOT NULL DEFAULT 'visitor', join_date TEXT, notes TEXT,
    preferred_channel TEXT NOT NULL DEFAULT 'none', unsubscribe_token TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
  );
  CREATE TABLE ministries (
    ministry_id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
    leader_id INTEGER, org_id INTEGER, meets_on TEXT, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE organizations (
    org_id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
    leader_id INTEGER, meets_on TEXT, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE organization_memberships (
    org_id INTEGER NOT NULL, member_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    joined_date TEXT NOT NULL DEFAULT CURRENT_DATE, PRIMARY KEY (org_id, member_id)
  );
  CREATE TABLE events (
    event_id INTEGER PRIMARY KEY, title TEXT NOT NULL, event_type TEXT NOT NULL DEFAULT 'service',
    starts_at TEXT NOT NULL, ends_at TEXT, location TEXT, ministry_id INTEGER, notes TEXT,
    checkin_token TEXT, attendance_men INTEGER, attendance_women INTEGER,
    attendance_children INTEGER, attendance_total INTEGER
  );
  CREATE TABLE attendance (
    event_id INTEGER NOT NULL, member_id INTEGER NOT NULL, checked_in_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, member_id)
  );
  CREATE TABLE funds (
    fund_id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL UNIQUE,
    fund_type TEXT NOT NULL DEFAULT 'GENERAL', restricted INTEGER NOT NULL DEFAULT 0,
    opening_balance REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE accounts (
    account_id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    account_type TEXT NOT NULL, normal_balance TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE financial_periods (
    period_id INTEGER PRIMARY KEY, year INTEGER NOT NULL, month INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN', closed_at TEXT, closed_by INTEGER,
    reopen_reason TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE journal_entries (
    entry_id INTEGER PRIMARY KEY, entry_no TEXT NOT NULL UNIQUE, entry_date TEXT NOT NULL,
    memo TEXT, status TEXT NOT NULL DEFAULT 'POSTED', source_type TEXT NOT NULL DEFAULT 'OTHER',
    source_id TEXT, period_id INTEGER, reverses_id INTEGER, created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE journal_lines (
    line_id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
    fund_id INTEGER, debit REAL NOT NULL DEFAULT 0, credit REAL NOT NULL DEFAULT 0, memo TEXT
  );
  CREATE TABLE income_records (
    income_id INTEGER PRIMARY KEY, transaction_date TEXT NOT NULL, category TEXT NOT NULL,
    subcategory TEXT, received_from TEXT, member_id INTEGER, amount REAL NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'Cash', fund_id INTEGER, project_id INTEGER,
    reference_number TEXT, description TEXT, receipt_number TEXT UNIQUE, recorded_by INTEGER,
    journal_entry_id INTEGER, deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE ministry_memberships (
    ministry_id INTEGER NOT NULL, member_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    joined_date TEXT NOT NULL DEFAULT CURRENT_DATE, left_date TEXT, PRIMARY KEY (ministry_id, member_id)
  );
  CREATE TABLE event_rsvps (
    event_id INTEGER NOT NULL, member_id INTEGER NOT NULL, response TEXT NOT NULL DEFAULT 'going',
    responded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (event_id, member_id)
  );
  CREATE TABLE sacraments (
    sacrament_id INTEGER PRIMARY KEY, sacrament_type TEXT NOT NULL, member_id INTEGER,
    spouse_id INTEGER, officiant_id INTEGER, occurred_on TEXT NOT NULL, location TEXT, notes TEXT
  );
  CREATE TABLE pastoral_notes (
    note_id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL, recorded_by INTEGER,
    occurred_on TEXT NOT NULL DEFAULT CURRENT_DATE, category TEXT NOT NULL, summary TEXT NOT NULL,
    confidential INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE welfare_cases (
    case_id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL, category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', amount_disbursed REAL NOT NULL DEFAULT 0,
    opened_on TEXT NOT NULL DEFAULT CURRENT_DATE, closed_on TEXT, summary TEXT NOT NULL, notes TEXT
  );
  CREATE TABLE contributions (
    contribution_id INTEGER PRIMARY KEY, member_id INTEGER, fund_id INTEGER NOT NULL, amount REAL NOT NULL,
    contributed_on TEXT NOT NULL, method TEXT, reference TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE announcements (
    announcement_id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'all', posted_by INTEGER, posted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE broadcasts (
    broadcast_id INTEGER PRIMARY KEY, channel TEXT NOT NULL, audience_label TEXT NOT NULL,
    org_id INTEGER, subject TEXT, body TEXT NOT NULL, total_recipients INTEGER NOT NULL DEFAULT 0,
    successful_sends INTEGER NOT NULL DEFAULT 0, failed_sends INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', sent_by INTEGER, sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE broadcast_recipients (
    recipient_id INTEGER PRIMARY KEY, broadcast_id INTEGER NOT NULL, member_id INTEGER,
    channel TEXT NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    error TEXT, sent_at TEXT
  );
  CREATE TABLE activity_log (
    activity_id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER, kind TEXT NOT NULL, description TEXT NOT NULL, link TEXT
  );
  CREATE TABLE security_audit_log (
    audit_id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_id INTEGER, event TEXT NOT NULL, subject TEXT, ip TEXT, user_agent TEXT
  );
  CREATE TABLE error_log (
    error_id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    method TEXT, path TEXT, message TEXT, stack TEXT, user_id INTEGER
  );
  CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE email_settings (
    setting_id INTEGER PRIMARY KEY CHECK (setting_id = 1), provider TEXT NOT NULL DEFAULT 'smtp',
    sender_name TEXT NOT NULL DEFAULT '', sender_email TEXT NOT NULL DEFAULT '',
    reply_to_email TEXT NOT NULL DEFAULT '', test_recipient_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE email_logs (
    email_log_id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recipient TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, error_message TEXT, provider TEXT,
    sender_name TEXT, sender_email TEXT, reply_to_email TEXT
  );
  CREATE TABLE password_reset_tokens (
    token_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE preaching_plan (
    plan_id INTEGER PRIMARY KEY, preach_date TEXT NOT NULL, service_label TEXT, member_id INTEGER,
    preacher_name TEXT, preacher_phone TEXT, preacher_email TEXT, topic TEXT, scripture TEXT, notes TEXT,
    reminder_sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT, deleted_at TEXT
  );
  CREATE TABLE inventory_items (
    item_id INTEGER PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0, category TEXT,
    acquired_on TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT, deleted_at TEXT
  );
  CREATE TABLE inventory_categories (
    category_id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
  );
  CREATE TABLE finance_settings (
    setting_id INTEGER PRIMARY KEY CHECK (setting_id = 1), receipt_prefix TEXT NOT NULL DEFAULT 'DMC-RCT',
    voucher_prefix TEXT NOT NULL DEFAULT 'DMC-PV', small_expense_max REAL NOT NULL DEFAULT 500,
    medium_expense_max REAL NOT NULL DEFAULT 5000, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE expense_categories (
    expense_cat_id INTEGER PRIMARY KEY, category_name TEXT NOT NULL UNIQUE, description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE finance_projects (
    project_id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, fund_id INTEGER,
    target_amount REAL NOT NULL DEFAULT 0, responsible_officer TEXT, start_date TEXT, end_date TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE expenses (
    expense_id INTEGER PRIMARY KEY, expense_cat_id INTEGER, category TEXT NOT NULL, amount REAL NOT NULL,
    spent_on TEXT NOT NULL, description TEXT, paid_to TEXT, payment_method TEXT, reference_number TEXT,
    approved_by INTEGER, receipt_attached INTEGER NOT NULL DEFAULT 0, fund_id INTEGER, project_id INTEGER,
    journal_entry_id INTEGER, approval_status TEXT NOT NULL DEFAULT 'PAID', submitted_at TEXT,
    approved_at TEXT, paid_at TEXT, rejected_at TEXT, approval_note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE payment_vouchers (
    voucher_id INTEGER PRIMARY KEY, voucher_no TEXT NOT NULL UNIQUE, expense_id INTEGER NOT NULL UNIQUE,
    voucher_date TEXT NOT NULL, amount_in_words TEXT NOT NULL, supporting_doc_ref TEXT, prepared_by INTEGER,
    checked_by TEXT, approved_by INTEGER, paid_by INTEGER, received_by TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE finance_budgets (
    budget_id INTEGER PRIMARY KEY, name TEXT NOT NULL, year INTEGER NOT NULL, month INTEGER,
    scope TEXT NOT NULL DEFAULT 'ANNUAL', status TEXT NOT NULL DEFAULT 'DRAFT', notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE finance_budget_lines (
    line_id INTEGER PRIMARY KEY, budget_id INTEGER NOT NULL, line_type TEXT NOT NULL, category TEXT NOT NULL,
    account_id INTEGER, fund_id INTEGER, amount REAL NOT NULL, notes TEXT
  );
  CREATE TABLE day_born_collections (
    collection_id INTEGER PRIMARY KEY, collection_date TEXT NOT NULL, day_born TEXT NOT NULL,
    amount REAL NOT NULL, head_count INTEGER NOT NULL DEFAULT 0, payment_method TEXT NOT NULL DEFAULT 'Cash',
    fund_id INTEGER, reference_number TEXT, receipt_number TEXT UNIQUE, recorded_by INTEGER,
    journal_entry_id INTEGER, notes TEXT, deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE finance_receipts (
    receipt_id INTEGER PRIMARY KEY, receipt_number TEXT NOT NULL UNIQUE, source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL, receipt_date TEXT NOT NULL, received_from TEXT, amount REAL NOT NULL,
    description TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_at TEXT, void_reason TEXT
  );
  CREATE TABLE tithes (
    tithe_id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL, amount REAL NOT NULL, tithe_date TEXT NOT NULL,
    method TEXT, reference TEXT, notes TEXT, recorded_by INTEGER, journal_entry_id INTEGER,
    deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE service_types (
    service_type_id INTEGER PRIMARY KEY, type_name TEXT NOT NULL UNIQUE, description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE services (
    service_id INTEGER PRIMARY KEY, service_type_id INTEGER NOT NULL, service_date TEXT NOT NULL,
    total_amount REAL NOT NULL DEFAULT 0, recorded_by INTEGER, journal_entry_id INTEGER, notes TEXT,
    deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE harvests (
    harvest_id INTEGER PRIMARY KEY, harvest_type TEXT NOT NULL, harvest_name TEXT NOT NULL,
    harvest_year INTEGER NOT NULL, harvest_date TEXT, theme TEXT, org_id INTEGER,
    total_collected REAL NOT NULL DEFAULT 0, recorded_by INTEGER, journal_entry_id INTEGER, notes TEXT,
    deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE day_born_splits (
    split_id INTEGER PRIMARY KEY, service_id INTEGER, harvest_id INTEGER, day_born TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0, head_count INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE special_categories (
    special_cat_id INTEGER PRIMARY KEY, category_name TEXT NOT NULL UNIQUE, description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE special_offerings (
    special_id INTEGER PRIMARY KEY, special_cat_id INTEGER NOT NULL, offering_date TEXT NOT NULL,
    donor_id INTEGER, donor_name_manual TEXT, amount REAL NOT NULL, purpose TEXT, receipt_number TEXT,
    recorded_by INTEGER, journal_entry_id INTEGER, notes TEXT, deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE pledges (
    pledge_id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL, harvest_id INTEGER NOT NULL,
    pledged_amount REAL NOT NULL, paid_amount REAL NOT NULL DEFAULT 0, pledge_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending', notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE pledge_payments (
    payment_id INTEGER PRIMARY KEY, pledge_id INTEGER NOT NULL, amount REAL NOT NULL, paid_on TEXT NOT NULL,
    receipt_number TEXT NOT NULL UNIQUE, recorded_by INTEGER, journal_entry_id INTEGER, sent_at TEXT,
    sent_channel TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE trial_signups (
    signup_id INTEGER PRIMARY KEY, church_name TEXT NOT NULL, contact_name TEXT NOT NULL, role TEXT,
    phone TEXT NOT NULL, email TEXT, plan TEXT NOT NULL DEFAULT 'pro', member_count TEXT, notes TEXT,
    status TEXT NOT NULL DEFAULT 'new', activation_token TEXT, activation_sent_at TEXT,
    activation_expires_at TEXT, activated_at TEXT, activated_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Seed representative rows ---
db.prepare(`INSERT INTO users (username, password_hash, display_name, role, finance_role, email) VALUES (?,?,?,?,?,?)`)
  .run('dunwelladmin', '$2a$10$fakehashfakehashfakehashfakeha', 'Church Admin', 'admin', 'finance_admin', 'admin@dunwell.test');
db.prepare(`INSERT INTO users (username, password_hash, display_name, role, finance_role, email) VALUES (?,?,?,?,?,?)`)
  .run('treasurer1', '$2a$10$fakehashfakehashfakehashfakeha', 'Ama Treasurer', 'editor', 'treasurer', 'treasurer@dunwell.test');

// Circular FK: insert members first (bible_class_id left null), then
// ministries (leader_id pointing at an already-inserted member), then
// backfill members.bible_class_id.
const m1 = db.prepare(`INSERT INTO members (external_id, first_name, last_name, email, mobile_phone, date_of_birth, day_born, gender, membership_status, join_date, preferred_channel, unsubscribe_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('DMS-001', 'Kofi', 'Mensah', 'kofi@test.com', '0244000001', '1990-05-12', 'Monday', 'M', 'member', '2020-01-01', 'either', 'tok-1').lastInsertRowid;
const m2 = db.prepare(`INSERT INTO members (external_id, first_name, last_name, email, mobile_phone, date_of_birth, day_born, gender, membership_status, join_date, preferred_channel, unsubscribe_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('DMS-002', 'Ama', 'Boateng', 'ama@test.com', '0244000002', '1985-11-03', 'Wednesday', 'F', 'regular', '2019-06-15', 'sms_only', 'tok-2').lastInsertRowid;
const m3 = db.prepare(`INSERT INTO members (external_id, first_name, last_name, membership_status, join_date, preferred_channel, unsubscribe_token) VALUES (?,?,?,?,?,?,?)`)
  .run('DMS-003', 'Yaw', 'Owusu', 'visitor', '2026-01-10', 'none', 'tok-3').lastInsertRowid;

const org1 = db.prepare(`INSERT INTO organizations (name, description, leader_id, meets_on) VALUES (?,?,?,?)`)
  .run('Church Choir', 'Main choir', m1, 'Saturday 5pm').lastInsertRowid;
db.prepare(`INSERT INTO organization_memberships (org_id, member_id, role) VALUES (?,?,?)`).run(org1, m1, 'leader');
db.prepare(`INSERT INTO organization_memberships (org_id, member_id, role) VALUES (?,?,?)`).run(org1, m2, 'member');

const ministry1 = db.prepare(`INSERT INTO ministries (name, description, leader_id, org_id, meets_on) VALUES (?,?,?,?,?)`)
  .run('Young Adults', 'Bible class', m2, org1, 'Sunday 8am').lastInsertRowid;
db.prepare(`UPDATE members SET bible_class_id=? WHERE member_id=?`).run(ministry1, m1);
db.prepare(`UPDATE members SET bible_class_id=? WHERE member_id=?`).run(ministry1, m3);

const ev1 = db.prepare(`INSERT INTO events (title, event_type, starts_at, location, ministry_id, checkin_token, attendance_men, attendance_women, attendance_children, attendance_total) VALUES (?,?,?,?,?,?,?,?,?,?)`)
  .run('Sunday Worship', 'service', '2026-06-07 09:00', 'Main Auditorium', ministry1, 'chk-1', 40, 55, 20, 115).lastInsertRowid;
db.prepare(`INSERT INTO attendance (event_id, member_id) VALUES (?,?)`).run(ev1, m1);
db.prepare(`INSERT INTO attendance (event_id, member_id) VALUES (?,?)`).run(ev1, m2);

const fund1 = db.prepare(`INSERT INTO funds (code, name, fund_type, restricted, opening_balance) VALUES (?,?,?,?,?)`)
  .run('GEN', 'General Fund', 'GENERAL', 0, 500).lastInsertRowid;

const acc1000 = db.prepare(`INSERT INTO accounts (code, name, account_type, normal_balance, is_system) VALUES (?,?,?,?,?)`).run('1000', 'Cash in hand', 'ASSET', 'DEBIT', 1).lastInsertRowid;
const acc4000 = db.prepare(`INSERT INTO accounts (code, name, account_type, normal_balance, is_system) VALUES (?,?,?,?,?)`).run('4000', 'Tithes', 'INCOME', 'CREDIT', 1).lastInsertRowid;

const period1 = db.prepare(`INSERT INTO financial_periods (year, month, status) VALUES (?,?,?)`).run(2026, 6, 'OPEN').lastInsertRowid;
const entry1 = db.prepare(`INSERT INTO journal_entries (entry_no, entry_date, memo, source_type, source_id, period_id) VALUES (?,?,?,?,?,?)`)
  .run('JV-2026-000001', '2026-06-10', 'Tithe from Kofi Mensah', 'GENERIC_INCOME', '1', period1).lastInsertRowid;
db.prepare(`INSERT INTO journal_lines (entry_id, account_id, fund_id, debit, credit) VALUES (?,?,?,?,?)`).run(entry1, acc1000, fund1, 250, 0);
db.prepare(`INSERT INTO journal_lines (entry_id, account_id, fund_id, debit, credit) VALUES (?,?,?,?,?)`).run(entry1, acc4000, fund1, 0, 250);

db.prepare(`INSERT INTO income_records (transaction_date, category, received_from, member_id, amount, fund_id, receipt_number, journal_entry_id) VALUES (?,?,?,?,?,?,?,?)`)
  .run('2026-06-10', 'Tithe', 'Kofi Mensah', m1, 250, fund1, 'RCT-2026-00001', entry1);

// users 1 and 2 are 'dunwelladmin'/'treasurer1' inserted first above (fresh table -> ids 1,2).
const u1 = 1, u2 = 2;

db.prepare(`INSERT INTO ministry_memberships (ministry_id, member_id, role) VALUES (?,?,?)`).run(ministry1, m2, 'leader');
db.prepare(`INSERT INTO event_rsvps (event_id, member_id, response) VALUES (?,?,?)`).run(ev1, m1, 'going');
db.prepare(`INSERT INTO sacraments (sacrament_type, member_id, occurred_on, location) VALUES (?,?,?,?)`).run('baptism', m1, '2015-04-12', 'Main Auditorium');
db.prepare(`INSERT INTO pastoral_notes (member_id, recorded_by, category, summary) VALUES (?,?,?,?)`).run(m2, u1, 'visit', 'Hospital visit follow-up');
db.prepare(`INSERT INTO welfare_cases (member_id, category, summary) VALUES (?,?,?)`).run(m3, 'financial', 'Requested support with rent');
db.prepare(`INSERT INTO contributions (member_id, fund_id, amount, contributed_on, method) VALUES (?,?,?,?,?)`).run(m1, fund1, 50, '2026-01-05', 'cash');
db.prepare(`INSERT INTO announcements (title, body, posted_by) VALUES (?,?,?)`).run('Welcome', 'Service starts at 9am', u1);
const bc1 = db.prepare(`INSERT INTO broadcasts (channel, audience_label, org_id, body, total_recipients, sent_by) VALUES (?,?,?,?,?,?)`)
  .run('sms', 'Choir', org1, 'Rehearsal moved to Friday', 1, u1).lastInsertRowid;
db.prepare(`INSERT INTO broadcast_recipients (broadcast_id, member_id, channel, destination, status) VALUES (?,?,?,?,?)`)
  .run(bc1, m1, 'sms', '0244000001', 'sent');
db.prepare(`INSERT INTO activity_log (user_id, kind, description) VALUES (?,?,?)`).run(u1, 'member_added', 'New member added: Kofi Mensah');
db.prepare(`INSERT INTO security_audit_log (actor_id, event, subject) VALUES (?,?,?)`).run(u1, 'login', 'dunwelladmin');
db.prepare(`INSERT INTO error_log (method, path, message) VALUES (?,?,?)`).run('GET', '/members/999', 'Not found');
db.prepare(`INSERT INTO app_state (key, value) VALUES (?,?)`).run('last_birthday_run', '2026-06-01');
db.prepare(`INSERT INTO email_settings (setting_id, provider, sender_name, sender_email) VALUES (1,?,?,?)`).run('smtp', 'Dunwell Methodist', 'noreply@dunwell.test');
db.prepare(`INSERT INTO email_logs (recipient, subject, status) VALUES (?,?,?)`).run('kofi@test.com', 'Welcome', 'sent');
db.prepare(`INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)`).run(u2, 'tok-reset-1', '2026-07-01 00:00:00');
db.prepare(`INSERT INTO preaching_plan (preach_date, service_label, member_id, topic) VALUES (?,?,?,?)`).run('2026-06-14', 'Sunday 9am', m1, 'Faith');
db.prepare(`INSERT INTO inventory_categories (name) VALUES (?)`).run('Sound Equipment');
db.prepare(`INSERT INTO inventory_items (name, quantity, category) VALUES (?,?,?)`).run('Microphone', 4, 'Sound Equipment');
db.prepare(`INSERT INTO finance_settings (setting_id, receipt_prefix, voucher_prefix) VALUES (1,?,?)`).run('RCT', 'PV');
const expCat1 = db.prepare(`INSERT INTO expense_categories (category_name) VALUES (?)`).run('Utilities').lastInsertRowid;
const proj1 = db.prepare(`INSERT INTO finance_projects (name, fund_id, target_amount) VALUES (?,?,?)`).run('Roof Repair', fund1, 5000).lastInsertRowid;
const exp1 = db.prepare(`INSERT INTO expenses (expense_cat_id, category, amount, spent_on, fund_id, project_id, approval_status) VALUES (?,?,?,?,?,?,?)`)
  .run(expCat1, 'Utilities', 120, '2026-06-05', fund1, proj1, 'PAID').lastInsertRowid;
db.prepare(`INSERT INTO payment_vouchers (voucher_no, expense_id, voucher_date, amount_in_words) VALUES (?,?,?,?)`)
  .run('PV-2026-00001', exp1, '2026-06-05', 'One hundred twenty cedis only');
const budget1 = db.prepare(`INSERT INTO finance_budgets (name, year, scope) VALUES (?,?,?)`).run('2026 Annual Budget', 2026, 'ANNUAL').lastInsertRowid;
db.prepare(`INSERT INTO finance_budget_lines (budget_id, line_type, category, fund_id, amount) VALUES (?,?,?,?,?)`).run(budget1, 'EXPENSE', 'Utilities', fund1, 6000);
db.prepare(`INSERT INTO day_born_collections (collection_date, day_born, amount, fund_id, receipt_number) VALUES (?,?,?,?,?)`).run('2026-06-07', 'Monday', 80, fund1, 'DB-2026-00001');
db.prepare(`INSERT INTO finance_receipts (receipt_number, source_type, source_id, receipt_date, amount) VALUES (?,?,?,?,?)`).run('RCT-2026-00002', 'GENERIC_INCOME', 1, '2026-06-10', 250);
db.prepare(`INSERT INTO tithes (member_id, amount, tithe_date) VALUES (?,?,?)`).run(m1, 100, '2026-06-01');
const svcType1 = db.prepare(`INSERT INTO service_types (type_name) VALUES (?)`).run('Sunday Service').lastInsertRowid;
const svc1 = db.prepare(`INSERT INTO services (service_type_id, service_date, total_amount) VALUES (?,?,?)`).run(svcType1, '2026-06-07', 500).lastInsertRowid;
const harvest1 = db.prepare(`INSERT INTO harvests (harvest_type, harvest_name, harvest_year, org_id, total_collected) VALUES (?,?,?,?,?)`)
  .run('Organizational', 'Choir Harvest', 2026, org1, 1200).lastInsertRowid;
db.prepare(`INSERT INTO day_born_splits (service_id, day_born, amount) VALUES (?,?,?)`).run(svc1, 'Monday', 80);
db.prepare(`INSERT INTO day_born_splits (harvest_id, day_born, amount) VALUES (?,?,?)`).run(harvest1, 'Wednesday', 120);
const specCat1 = db.prepare(`INSERT INTO special_categories (category_name) VALUES (?)`).run('Building Fund').lastInsertRowid;
db.prepare(`INSERT INTO special_offerings (special_cat_id, offering_date, donor_id, amount) VALUES (?,?,?,?)`).run(specCat1, '2026-06-07', m2, 300);
const pledge1 = db.prepare(`INSERT INTO pledges (member_id, harvest_id, pledged_amount, pledge_date) VALUES (?,?,?,?)`).run(m2, harvest1, 500, '2026-01-01').lastInsertRowid;
db.prepare(`INSERT INTO pledge_payments (pledge_id, amount, paid_on, receipt_number) VALUES (?,?,?,?)`).run(pledge1, 100, '2026-03-01', 'PP-2026-00001');
db.prepare(`INSERT INTO trial_signups (church_name, contact_name, phone, email, plan) VALUES (?,?,?,?,?)`).run('New Test Church', 'Test Contact', '0244999999', 'lead@test.com', 'pro');

db.close();
console.log(`Synthetic SQLite database written: ${OUT_PATH}`);
