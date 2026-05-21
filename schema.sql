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
    country        TEXT    DEFAULT 'USA',
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
    email            TEXT,
    mobile_phone     TEXT,
    marital_status   TEXT    CHECK (marital_status IN
                          ('single','married','divorced','widowed','separated')
                          OR marital_status IS NULL),
    membership_status TEXT   NOT NULL DEFAULT 'visitor'
                          CHECK (membership_status IN
                          ('visitor','regular','member','inactive','transferred','deceased')),
    join_date         TEXT,
    baptism_date      TEXT,
    baptism_location  TEXT,
    confirmation_date TEXT,
    notes            TEXT,
    preferred_channel TEXT   NOT NULL DEFAULT 'either'
                          CHECK (preferred_channel IN ('either','sms_only','email_only','none')),
    unsubscribe_token TEXT  UNIQUE,
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
                    ('service','prayer','bible_study','outreach','youth','wedding','funeral','baptism','other')),
    starts_at    TEXT    NOT NULL,  -- ISO8601 datetime
    ends_at      TEXT,
    location     TEXT,
    ministry_id  INTEGER REFERENCES ministries(ministry_id) ON DELETE SET NULL,
    notes        TEXT
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
    name      TEXT    NOT NULL UNIQUE,
    active    INTEGER NOT NULL DEFAULT 1
);

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
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_expenses_date ON expenses(spent_on);

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

-- Login accounts. role is 'admin' (full access) or 'viewer' (read-only).
CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    display_name  TEXT,
    role          TEXT    NOT NULL DEFAULT 'admin'
                  CHECK (role IN ('admin','viewer')),
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
    notes           TEXT,
    deleted_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE harvests (
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

CREATE TABLE expense_categories (
    expense_cat_id INTEGER PRIMARY KEY,
    category_name  TEXT NOT NULL UNIQUE,
    description    TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1
);

INSERT INTO service_types (type_name, description) VALUES
 ('Sunday Service',    'Regular Sunday worship service'),
 ('Wednesday Service', 'Midweek service'),
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
