-- Common reports for day-to-day church administration.
-- Run any block individually, e.g.: sqlite3 church.db < queries.sql

-- 1. Member directory by household
SELECT  h.family_name,
        m.first_name || ' ' || m.last_name AS name,
        m.email,
        m.mobile_phone,
        m.membership_status
FROM    members m
LEFT    JOIN households h USING (household_id)
ORDER BY h.family_name, m.date_of_birth;

-- 2. Upcoming events in the next 30 days
SELECT  event_id, title, event_type, starts_at, location
FROM    events
WHERE   starts_at >= date('now')
  AND   starts_at <  date('now','+30 days')
ORDER BY starts_at;

-- 3. Attendance per Sunday service
SELECT  e.starts_at, e.title, COUNT(a.member_id) AS attendees
FROM    events e
LEFT    JOIN attendance a USING (event_id)
WHERE   e.event_type = 'service'
GROUP BY e.event_id
ORDER BY e.starts_at;

-- 4. Members who missed the last 3 Sunday services
WITH last_services AS (
  SELECT event_id FROM events
  WHERE  event_type = 'service'
  ORDER BY starts_at DESC LIMIT 3
)
SELECT  m.member_id, m.first_name || ' ' || m.last_name AS name, m.email
FROM    members m
WHERE   m.membership_status IN ('member','regular')
  AND   NOT EXISTS (
          SELECT 1 FROM attendance a
          WHERE  a.member_id = m.member_id
            AND  a.event_id IN (SELECT event_id FROM last_services)
        );

-- 5. Giving by fund for a year
SELECT  f.name AS fund,
        ROUND(SUM(c.amount), 2) AS total
FROM    contributions c
JOIN    funds f USING (fund_id)
WHERE   substr(c.contributed_on,1,4) = strftime('%Y','now')
GROUP BY f.fund_id
ORDER BY total DESC;

-- 6. Giving statement for a single member (parameterize :member_id)
-- SELECT contributed_on, f.name AS fund, amount, method, reference
-- FROM   contributions c JOIN funds f USING (fund_id)
-- WHERE  c.member_id = :member_id
-- ORDER BY contributed_on;

-- 7. Top givers this year (excluding anonymous)
SELECT  m.first_name || ' ' || m.last_name AS name,
        ROUND(SUM(c.amount), 2) AS total
FROM    contributions c
JOIN    members m USING (member_id)
WHERE   substr(c.contributed_on,1,4) = strftime('%Y','now')
GROUP BY m.member_id
ORDER BY total DESC
LIMIT 10;

-- 8. Birthdays this month
SELECT  first_name || ' ' || last_name AS name,
        date_of_birth,
        strftime('%m-%d', date_of_birth) AS bday
FROM    members
WHERE   strftime('%m', date_of_birth) = strftime('%m','now')
ORDER BY strftime('%d', date_of_birth);

-- 9. Baptism anniversaries this month
SELECT  first_name || ' ' || last_name AS name, baptism_date
FROM    members
WHERE   baptism_date IS NOT NULL
  AND   strftime('%m', baptism_date) = strftime('%m','now')
ORDER BY strftime('%d', baptism_date);

-- 10. Ministry roster
SELECT  mn.name AS ministry,
        m.first_name || ' ' || m.last_name AS member,
        mm.role
FROM    ministry_memberships mm
JOIN    ministries mn USING (ministry_id)
JOIN    members     m  USING (member_id)
WHERE   mm.left_date IS NULL
ORDER BY mn.name, mm.role DESC, m.last_name;

-- 11. Visitors / regulars who could be invited to membership
SELECT  m.first_name || ' ' || m.last_name AS name, m.email, m.join_date
FROM    members m
WHERE   m.membership_status IN ('visitor','regular')
  AND   m.join_date <= date('now','-90 days')
ORDER BY m.join_date;

-- 12. Outstanding pastoral follow-ups in the last 30 days
SELECT  pn.occurred_on,
        m.first_name || ' ' || m.last_name AS member,
        pn.category, pn.summary
FROM    pastoral_notes pn
JOIN    members m USING (member_id)
WHERE   pn.occurred_on >= date('now','-30 days')
ORDER BY pn.occurred_on DESC;
