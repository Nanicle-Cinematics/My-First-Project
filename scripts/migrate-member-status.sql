-- Migration: collapse the member status taxonomy down to just visitor + member.
-- Any status that isn't already 'visitor' becomes 'member'. The CHECK
-- constraint on the column already allows both values, so no table rebuild
-- is required — just an UPDATE.
--
-- Run with:  sqlite3 church.db < scripts/migrate-member-status.sql
-- Idempotent: re-running it does nothing on the second pass.

.bail on
BEGIN TRANSACTION;

-- Show what we're about to change
SELECT 'before:' AS phase, membership_status, COUNT(*) AS rows
FROM members GROUP BY membership_status ORDER BY rows DESC;

UPDATE members
   SET membership_status = 'member'
 WHERE membership_status IS NOT NULL
   AND membership_status NOT IN ('visitor', 'member');

-- Confirm the new distribution
SELECT 'after:' AS phase, membership_status, COUNT(*) AS rows
FROM members GROUP BY membership_status ORDER BY rows DESC;

COMMIT;
