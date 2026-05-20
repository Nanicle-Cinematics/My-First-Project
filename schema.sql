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
    household_id     INTEGER REFERENCES households(household_id) ON DELETE SET NULL,
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
    join_date        TEXT,
    baptism_date     TEXT,
    baptism_location TEXT,
    notes            TEXT,
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_members_household ON members(household_id);
CREATE INDEX idx_members_status    ON members(membership_status);
CREATE INDEX idx_members_lastname  ON members(last_name);

-- Ministries / small groups / teams (e.g., Choir, Youth, Ushers).
CREATE TABLE ministries (
    ministry_id   INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL UNIQUE,
    description   TEXT,
    leader_id     INTEGER REFERENCES members(member_id) ON DELETE SET NULL,
    meets_on      TEXT,   -- e.g., 'Wednesday 7pm'
    active        INTEGER NOT NULL DEFAULT 1
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
