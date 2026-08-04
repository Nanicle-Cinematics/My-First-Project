-- Church Management Database Schema (SQLite)

PRAGMA foreign_keys = ON;

-- A household groups members who live together (a family).
CREATE TABLE households (
    household_id   INTEGER PRIMARY KEY,
    family_name    TEXT    NOT NULL,
    address_line1  TEXT,
    address_line2  TEXT,
    city           TEXT,
    state          TEXT,
    postal_code    TEXT,
    country        TEXT    DEFAULT 'Ghana',
    home_phone     TEXT,
    created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A member is any individual associated with the church.
CREATE TABLE members (
    member_id        INTEGER PRIMARY KEY,
    external_id      TEXT    UNIQUE,                -- e.g. DMS-001
    household_id     INTEGER REFERENCES households(household_id) ON DELETE SET NULL,
    bible_class_id   INTEGER REFERENCES ministries(ministry_id) ON DELETE SET NULL,
    first_name       TEXT    NOT NULL,
    last_name        TEXT    NOT NULL,
    preferred_name   TEXT,
    gender           TEXT    CHECK (gender IN ('M','F','O') OR gender IS NULL),
    date_of_birth    TEXT,
    day_born         TEXT,
    email            TEXT,
    mobile_phone     TEXT,
    marital_status   TEXT    CHECK (marital_status IN
                          ('single','married','divorced','widowed','separated','other')
                          OR marital_status IS NULL),
    membership_status TEXT   NOT NULL DEFAULT 'visitor'
                          CHECK (membership_status IN
                          ('visitor','regular','member','inactive','transferred','deceased','other')),
    join_date         TEXT,
    baptism_date      TEXT,
    baptism_location  TEXT,
    confirmation_date TEXT,
    notes            TEXT,
    preferred_channel TEXT   NOT NULL DEFAULT 'none'
                          CHECK (preferred_channel IN ('either','sms_only','email_only','none')),
    unsubscribe_token TEXT  UNIQUE,
    emergency_contact_name     TEXT,
    emergency_contact_phone    TEXT,
    emergency_contact_relation TEXT,
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at       TEXT
);

CREATE INDEX idx_members_household ON members(household_id);
CREATE INDEX idx_members_status    ON members(membership_status);
CREATE INDEX idx_members_lastname  ON members(last_name);

-- Ministries / small groups (used as "Bible classes" in the UI).
CREATE TABLE ministries (
    ministry_id   INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL UNIQUE,
    description   TEXT,
    leader_id     INTEGER REFERENCES members(member_id) ON DELETE SET NULL,
    org_id        INTEGER,   -- FK added later (after organizations table is created)
    meets_on      TEXT,
    active        INTEGER NOT NULL DEFAULT 1
);

-- Top-level church organizations (Choir, Gospel Band, Fellowships, Sunday School…).
CREATE TABLE organizations (
    org_id      INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT,
    leader_id   INTEGER REFERENCES members(member_id) ON DELETE SET NULL,
    meets_on    TEXT,
    active      INTEGER NOT NULL DEFAULT 1
);

INSERT INTO organizations (name) VALUES
 ('Church Choir'),
 ('Singing Band'),
 ('Gospel Band'),
 ('Guild'),
 ('Boy''s Brigade'),
 ('Girl''s Brigade'),
 ('Men''s Fellowship'),
 ('Women''s Fellowship'),
 ('Girl''s Fellowship'),
 ('Ushers'),
 ('Sunday School'),
 ('Youth Ministry');

CREATE TABLE organization_memberships (
    org_id      INTEGER NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    member_id   INTEGER NOT NULL REFERENCES members(member_id)    ON DELETE CASCADE,
    role        TEXT    NOT NULL DEFAULT 'member',
    joined_date TEXT    NOT NULL DEFAULT CURRENT_DATE,
    PRIMARY KEY (org_id, member_id)
);

CREATE TABLE ministry_memberships (
    ministry_id  INTEGER NOT NULL REFERENCES ministries(ministry_id) ON DELETE CASCADE,
    member_id    INTEGER NOT NULL REFERENCES members(member_id)     ON DELETE CASCADE,
    role         TEXT    NOT NULL DEFAULT 'member',
    joined_date  TEXT    NOT NULL DEFAULT CURRENT_DATE,
    left_date    TEXT,
    PRIMARY KEY (ministry_id, member_id)
);

-- Events: services, meetings, classes, special events.
CREATE TABLE events (
    event_id     INTEGER PRIMARY KEY,
    title        TEXT    NOT NULL,
    event_type   TEXT    NOT NULL DEFAULT 'service'
                    CHECK (event_type IN
                    ('service','prayer','bible_study','outreach','youth','wedding','funeral','baptism','confirmation','other')),
    starts_at    TEXT    NOT NULL,  -- ISO8601 datetime
    ends_at      TEXT,
    location     TEXT,
    ministry_id  INTEGER REFERENCES ministries(ministry_id) ON DELETE SET NULL,
    notes        TEXT,
    attendance_men      INTEGER,
    attendance_women    INTEGER,
    attendance_children INTEGER,
    attendance_total    INTEGER
);

CREATE INDEX idx_events_starts ON events(starts_at);

-- Attendance for an event.
CREATE TABLE attendance (
    event_id   INTEGER NOT NULL REFERENCES events(event_id)   ON DELETE CASCADE,
    member_id  INTEGER NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
    checked_in_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, member_id)
);

-- Funds (general, building, missions, benevolence, ...).
CREATE TABLE funds (
    fund_id   INTEGER PRIMARY KEY,
    code      TEXT UNIQUE,
    name      TEXT    NOT NULL UNIQUE,
    fund_type TEXT    NOT NULL DEFAULT 'GENERAL'
              CHECK (fund_type IN ('GENERAL','BUILDING','WELFARE','MISSION','HARVEST','ANNIVERSARY','YOUTH','MUSIC','CHILDREN','PROJECT','RESTRICTED_DONATION')),
    restricted INTEGER NOT NULL DEFAULT 0,
    opening_balance REAL NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
    responsible_officer TEXT,
    notes     TEXT,
    active    INTEGER NOT NULL DEFAULT 1
);

-- Double-entry accounting backbone. Finance screens can stay simple, while
-- verified income and paid expenses post balanced journals behind the scenes.
CREATE TABLE accounts (
    account_id     INTEGER PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    account_type   TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','FUND_EQUITY','INCOME','EXPENSE')),
    normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
    is_system      INTEGER NOT NULL DEFAULT 0,
    parent_id      INTEGER REFERENCES accounts(account_id),
    active         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_accounts_type ON accounts(account_type);

CREATE TABLE financial_periods (
    period_id     INTEGER PRIMARY KEY,
    year          INTEGER NOT NULL,
    month         INTEGER,
    status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','LOCKED')),
    closed_at     TEXT,
    closed_by     INTEGER REFERENCES users(user_id),
    reopen_reason TEXT,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(year, month)
);

CREATE TABLE journal_entries (
    entry_id     INTEGER PRIMARY KEY,
    entry_no     TEXT NOT NULL UNIQUE,
    entry_date   TEXT NOT NULL,
    memo         TEXT,
    status       TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT','POSTED','REVERSED')),
    source_type  TEXT NOT NULL DEFAULT 'OTHER',
    source_id    TEXT,
    period_id    INTEGER REFERENCES financial_periods(period_id),
    reverses_id  INTEGER UNIQUE REFERENCES journal_entries(entry_id),
    created_by   INTEGER REFERENCES users(user_id),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_journal_entries_source ON journal_entries(source_type, source_id);
CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date);

CREATE TABLE journal_lines (
    line_id    INTEGER PRIMARY KEY,
    entry_id   INTEGER NOT NULL REFERENCES journal_entries(entry_id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(account_id),
    fund_id    INTEGER REFERENCES funds(fund_id),
    debit      REAL NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit     REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
    memo       TEXT,
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX idx_journal_lines_fund ON journal_lines(fund_id);

-- Contributions / tithes / offerings.
CREATE TABLE contributions (
    contribution_id INTEGER PRIMARY KEY,
    member_id       INTEGER REFERENCES members(member_id) ON DELETE SET NULL, -- NULL = anonymous
    fund_id         INTEGER NOT NULL REFERENCES funds(fund_id),
    amount          REAL    NOT NULL CHECK (amount > 0),
    contributed_on  TEXT    NOT NULL,
    method          TEXT    CHECK (method IN ('cash','check','card','online','transfer','other')),
    reference       TEXT,   -- check #, transaction id, etc.
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contrib_member ON contributions(member_id);
CREATE INDEX idx_contrib_date   ON contributions(contributed_on);
CREATE INDEX idx_contrib_fund   ON contributions(fund_id);

-- Sacraments / life events (baptism, marriage, dedication, etc.).
CREATE TABLE sacraments (
    sacrament_id   INTEGER PRIMARY KEY,
    sacrament_type TEXT    NOT NULL CHECK (sacrament_type IN
                       ('baptism','dedication','confirmation','marriage','funeral')),
    member_id      INTEGER REFERENCES members(member_id) ON DELETE SET NULL,
    spouse_id      INTEGER REFERENCES members(member_id) ON DELETE SET NULL, -- for marriages
    officiant_id   INTEGER REFERENCES members(member_id) ON DELETE SET NULL,
    occurred_on    TEXT    NOT NULL,
    location       TEXT,
    notes          TEXT
);

-- Pastoral care: visits, calls, prayer requests, counseling.
CREATE TABLE pastoral_notes (
    note_id      INTEGER PRIMARY KEY,
    member_id    INTEGER NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
    recorded_by  INTEGER REFERENCES members(member_id) ON DELETE SET NULL,
    occurred_on  TEXT    NOT NULL DEFAULT CURRENT_DATE,
    category     TEXT    NOT NULL CHECK (category IN
                     ('visit','call','prayer_request','counseling','other')),
    summary      TEXT    NOT NULL,
    confidential INTEGER NOT NULL DEFAULT 0
);

-- Expenses (the other side of contributions, for finance summary).
CREATE TABLE expenses (
    expense_id       INTEGER PRIMARY KEY,
    expense_cat_id   INTEGER REFERENCES expense_categories(expense_cat_id),
    category         TEXT    NOT NULL,
    amount           REAL    NOT NULL CHECK (amount > 0),
    spent_on         TEXT    NOT NULL,
    description      TEXT,
    paid_to          TEXT,
    payment_method   TEXT,
    reference_number TEXT,
    approved_by      INTEGER REFERENCES users(user_id),
    receipt_attached INTEGER NOT NULL DEFAULT 0,
    fund_id          INTEGER REFERENCES funds(fund_id),
    project_id       INTEGER REFERENCES finance_projects(project_id),
    journal_entry_id INTEGER REFERENCES journal_entries(entry_id),
    approval_status  TEXT    NOT NULL DEFAULT 'PAID'
                     CHECK (approval_status IN ('DRAFT','SUBMITTED','APPROVED','PAID','REJECTED')),
    submitted_at     TEXT,
    approved_at      TEXT,
    paid_at          TEXT,
    rejected_at      TEXT,
    approval_note    TEXT,
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_expenses_date ON expenses(spent_on);

CREATE TABLE finance_projects (
    project_id          INTEGER PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,
    description         TEXT,
    fund_id             INTEGER REFERENCES funds(fund_id),
    target_amount       REAL NOT NULL DEFAULT 0 CHECK (target_amount >= 0),
    responsible_officer TEXT,
    start_date          TEXT,
    end_date            TEXT,
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('PLANNING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_finance_projects_status ON finance_projects(status);
CREATE INDEX idx_finance_projects_fund ON finance_projects(fund_id);

CREATE TABLE finance_budgets (
    budget_id   INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    year        INTEGER NOT NULL,
    month       INTEGER,
    scope       TEXT NOT NULL DEFAULT 'ANNUAL' CHECK (scope IN ('ANNUAL','MONTHLY')),
    status      TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','CLOSED')),
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (month IS NULL OR (month BETWEEN 1 AND 12))
);
CREATE INDEX idx_finance_budgets_year ON finance_budgets(year, month);

CREATE TABLE finance_budget_lines (
    line_id     INTEGER PRIMARY KEY,
    budget_id   INTEGER NOT NULL REFERENCES finance_budgets(budget_id) ON DELETE CASCADE,
    line_type   TEXT NOT NULL CHECK (line_type IN ('INCOME','EXPENSE')),
    category    TEXT NOT NULL,
    account_id  INTEGER REFERENCES accounts(account_id),
    fund_id     INTEGER REFERENCES funds(fund_id),
    amount      REAL NOT NULL CHECK (amount >= 0),
    notes       TEXT
);
CREATE INDEX idx_finance_budget_lines_budget ON finance_budget_lines(budget_id);

CREATE TABLE payment_vouchers (
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
CREATE INDEX idx_payment_vouchers_date ON payment_vouchers(voucher_date);

CREATE TABLE finance_settings (
    setting_id         INTEGER PRIMARY KEY CHECK (setting_id = 1),
    receipt_prefix     TEXT NOT NULL DEFAULT 'DMC-RCT',
    voucher_prefix     TEXT NOT NULL DEFAULT 'DMC-PV',
    small_expense_max  REAL NOT NULL DEFAULT 500 CHECK (small_expense_max >= 0),
    medium_expense_max REAL NOT NULL DEFAULT 5000 CHECK (medium_expense_max >= 0),
    updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE income_records (
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
CREATE INDEX idx_income_records_date ON income_records(transaction_date);
CREATE INDEX idx_income_records_category ON income_records(category);

CREATE TABLE day_born_collections (
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
CREATE INDEX idx_day_born_collections_date ON day_born_collections(collection_date);
CREATE INDEX idx_day_born_collections_day ON day_born_collections(day_born);

CREATE TABLE finance_receipts (
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
CREATE INDEX idx_finance_receipts_date ON finance_receipts(receipt_date);
CREATE INDEX idx_finance_receipts_source ON finance_receipts(source_type, source_id);

-- Welfare cases tracked by the church.
CREATE TABLE welfare_cases (
    case_id           INTEGER PRIMARY KEY,
    member_id         INTEGER NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
    category          TEXT    NOT NULL CHECK (category IN
                          ('medical','financial','bereavement','marital','food','other')),
    status            TEXT    NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','in_progress','closed')),
    amount_disbursed  REAL    NOT NULL DEFAULT 0,
    opened_on         TEXT    NOT NULL DEFAULT CURRENT_DATE,
    closed_on         TEXT,
    summary           TEXT    NOT NULL,
    notes             TEXT
);
CREATE INDEX idx_welfare_status ON welfare_cases(status);

-- Announcements / communications.
CREATE TABLE announcements (
    announcement_id INTEGER PRIMARY KEY,
    title           TEXT    NOT NULL,
    body            TEXT    NOT NULL,
    audience        TEXT    NOT NULL DEFAULT 'all',
    posted_by       INTEGER REFERENCES users(user_id),
    posted_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_announcements_posted ON announcements(posted_at);

-- Activity log for the dashboard's "Recent Activities" widget.
CREATE TABLE activity_log (
    activity_id  INTEGER PRIMARY KEY,
    occurred_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_id      INTEGER REFERENCES users(user_id),
    kind         TEXT NOT NULL,
    description  TEXT NOT NULL,
    link         TEXT
);
CREATE INDEX idx_activity_recent ON activity_log(occurred_at DESC);

-- Security-sensitive action log for owner review.
CREATE TABLE security_audit_log (
    audit_id    INTEGER PRIMARY KEY,
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_id    INTEGER REFERENCES users(user_id),
    event       TEXT NOT NULL,
    subject     TEXT,
    ip          TEXT,
    user_agent  TEXT
);
CREATE INDEX idx_security_audit_recent ON security_audit_log(occurred_at DESC);

CREATE TABLE IF NOT EXISTS email_settings (
    setting_id           INTEGER PRIMARY KEY CHECK (setting_id = 1),
    provider             TEXT NOT NULL DEFAULT 'smtp' CHECK (provider IN ('smtp', 'resend')),
    sender_name          TEXT NOT NULL DEFAULT '',
    sender_email         TEXT NOT NULL DEFAULT '',
    reply_to_email       TEXT NOT NULL DEFAULT '',
    test_recipient_email TEXT NOT NULL DEFAULT '',
    created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_logs (
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
);
CREATE INDEX idx_email_logs_recent ON email_logs(occurred_at DESC);
CREATE INDEX idx_email_logs_status ON email_logs(status);

-- Login accounts. role is 'admin' (full access) or 'viewer' (read-only).
CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    display_name  TEXT,
    role          TEXT    NOT NULL DEFAULT 'admin'
                  CHECK (role IN ('admin','editor','viewer')),
    finance_role  TEXT    NOT NULL DEFAULT 'none',
    created_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at    TEXT
);

-- ---------- Finance: services, harvests, day-born splits ----------------

CREATE TABLE service_types (
    service_type_id INTEGER PRIMARY KEY,
    type_name       TEXT NOT NULL UNIQUE,
    description     TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE services (
    service_id      INTEGER PRIMARY KEY,
    service_type_id INTEGER NOT NULL REFERENCES service_types(service_type_id),
    service_date    TEXT NOT NULL,
    total_amount    REAL NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    recorded_by     INTEGER REFERENCES users(user_id),
    journal_entry_id INTEGER REFERENCES journal_entries(entry_id),
    notes           TEXT,
    deleted_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE harvests (
    harvest_id      INTEGER PRIMARY KEY,
    harvest_type    TEXT NOT NULL CHECK (harvest_type IN ('Organizational','End-of-Year','Other')),
    harvest_name    TEXT NOT NULL,
    harvest_year    INTEGER NOT NULL,
    harvest_date    TEXT,
    theme           TEXT,
    org_id          INTEGER REFERENCES organizations(org_id),
    total_collected REAL NOT NULL DEFAULT 0 CHECK (total_collected >= 0),
    recorded_by     INTEGER REFERENCES users(user_id),
    journal_entry_id INTEGER REFERENCES journal_entries(entry_id),
    notes           TEXT,
    deleted_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE day_born_splits (
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

CREATE TABLE special_categories (
    special_cat_id INTEGER PRIMARY KEY,
    category_name  TEXT NOT NULL UNIQUE,
    description    TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE special_offerings (
    special_id        INTEGER PRIMARY KEY,
    special_cat_id    INTEGER NOT NULL REFERENCES special_categories(special_cat_id),
    offering_date     TEXT NOT NULL,
    donor_id          INTEGER REFERENCES members(member_id),
    donor_name_manual TEXT,
    amount            REAL NOT NULL CHECK (amount > 0),
    purpose           TEXT,
    receipt_number    TEXT,
    recorded_by       INTEGER REFERENCES users(user_id),
    journal_entry_id  INTEGER REFERENCES journal_entries(entry_id),
    notes             TEXT,
    deleted_at        TEXT,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pledges (
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

CREATE TABLE pledge_payments (
    payment_id     INTEGER PRIMARY KEY,
    pledge_id      INTEGER NOT NULL REFERENCES pledges(pledge_id) ON DELETE CASCADE,
    amount         REAL NOT NULL CHECK (amount > 0),
    paid_on        TEXT NOT NULL,
    receipt_number TEXT NOT NULL UNIQUE,
    recorded_by    INTEGER REFERENCES users(user_id),
    journal_entry_id INTEGER REFERENCES journal_entries(entry_id),
    sent_at        TEXT,
    sent_channel   TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_pledge_payments_pledge ON pledge_payments(pledge_id);

CREATE TABLE expense_categories (
    expense_cat_id INTEGER PRIMARY KEY,
    category_name  TEXT NOT NULL UNIQUE,
    description    TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE inventory_items (
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
CREATE INDEX idx_inventory_active ON inventory_items(deleted_at);

CREATE TABLE inventory_categories (
    category_id  INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at   TEXT
);
CREATE INDEX idx_inventory_categories_active ON inventory_categories(deleted_at);

CREATE TABLE preaching_plan (
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
CREATE INDEX idx_preaching_date ON preaching_plan(preach_date);

CREATE TABLE trial_signups (
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
);

INSERT INTO service_types (type_name, description) VALUES
 ('Sunday Service',    'Regular Sunday worship service'),
 ('Wednesday Service', 'Midweek service'),
 ('Friday Service',    'Friday evening service'),
 ('Wedding Service',   'Wedding ceremony offering'),
 ('Funeral Service',   'Funeral / memorial service offering');

INSERT INTO special_categories (category_name, description) VALUES
 ('Building Fund',         'Church construction / renovation'),
 ('Mission / Outreach',    'Evangelism and outreach work'),
 ('Thanksgiving',          'Thanksgiving offerings'),
 ('Pastor''s Appreciation','Pastor appreciation offering'),
 ('Welfare / Benevolence', 'Support for members in need'),
 ('Convention / Camp',     'Conventions, camps, conferences'),
 ('Vow / Pledge',          'Personal vows and pledges');

INSERT INTO expense_categories (category_name, description) VALUES
 ('Utilities',       'Electricity, water, internet'),
 ('Salaries',        'Pastor and staff salaries'),
 ('Maintenance',     'Building and equipment upkeep'),
 ('Office Supplies', 'Stationery, printing'),
 ('Outreach',        'Mission and outreach expenses'),
 ('Welfare',         'Support to members'),
 ('Events',          'Convention, camp, special events');

-- Helpful views ---------------------------------------------------------

CREATE VIEW v_active_members AS
SELECT m.*, h.family_name, h.city
FROM   members m
LEFT   JOIN households h USING (household_id)
WHERE  m.membership_status IN ('member','regular');

CREATE VIEW v_giving_by_member_year AS
SELECT  c.member_id,
        m.first_name || ' ' || m.last_name AS member_name,
        substr(c.contributed_on, 1, 4)     AS year,
        ROUND(SUM(c.amount), 2)            AS total_given
FROM    contributions c
LEFT    JOIN members m ON m.member_id = c.member_id
GROUP BY c.member_id, year;

CREATE VIEW v_event_attendance_counts AS
SELECT  e.event_id,
        e.title,
        e.starts_at,
        COUNT(a.member_id) AS attendee_count
FROM    events e
LEFT    JOIN attendance a USING (event_id)
GROUP BY e.event_id;
