-- Migration: relax CHECK constraints so 'Other' is a valid value for
-- membership_status, marital_status, and harvest_type.
--
-- SQLite can't ALTER a CHECK in place — we rebuild the table.
-- Run with:  sqlite3 church.db < scripts/migrate-allow-other.sql
-- Safe to re-run.

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- ---- Drop views that reference members (they'll be recreated below) ----
DROP VIEW IF EXISTS v_active_members;
DROP VIEW IF EXISTS v_giving_by_member_year;

-- ---- members: relax membership_status and marital_status ----
CREATE TABLE IF NOT EXISTS members__new (
    member_id        INTEGER PRIMARY KEY,
    external_id      TEXT    UNIQUE,
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
    created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at       TEXT
);

INSERT INTO members__new SELECT
    member_id, external_id, household_id, bible_class_id, first_name, last_name,
    preferred_name, gender, date_of_birth, email, mobile_phone,
    marital_status, membership_status,
    join_date, baptism_date, baptism_location, confirmation_date,
    notes, preferred_channel, unsubscribe_token, created_at, deleted_at
FROM members;

DROP TABLE members;
ALTER TABLE members__new RENAME TO members;

-- ---- harvests: relax harvest_type ----
CREATE TABLE IF NOT EXISTS harvests__new (
    harvest_id      INTEGER PRIMARY KEY,
    harvest_type    TEXT NOT NULL CHECK (harvest_type IN ('Organizational','End-of-Year','Other')),
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

INSERT INTO harvests__new SELECT
    harvest_id, harvest_type, harvest_name, harvest_year, harvest_date, theme,
    org_id, total_collected, recorded_by, notes, deleted_at, created_at
FROM harvests;

DROP TABLE harvests;
ALTER TABLE harvests__new RENAME TO harvests;

-- ---- Recreate the dropped views ----
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

COMMIT;
PRAGMA foreign_keys = ON;

-- Sanity: count rows survived
SELECT 'members='||COUNT(*) FROM members;
SELECT 'harvests='||COUNT(*) FROM harvests;
