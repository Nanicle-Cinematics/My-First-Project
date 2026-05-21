-- Sample data for the church management database.

INSERT INTO households (household_id, family_name, address_line1, city, state, postal_code, home_phone) VALUES
 (1, 'Anderson', '12 Oak Lane',    'Springfield', 'IL', '62701', '217-555-0101'),
 (2, 'Brown',    '88 Maple Ave',   'Springfield', 'IL', '62702', '217-555-0102'),
 (3, 'Chen',     '5 Pine Court',   'Springfield', 'IL', '62703', '217-555-0103'),
 (4, 'Davis',    '301 Elm Street', 'Springfield', 'IL', '62704', '217-555-0104');

INSERT INTO organizations (org_id, name) VALUES
 (1, 'Church Choir'),
 (2, 'Gospel Band'),
 (3, "Men's Fellowship"),
 (4, "Women's Fellowship"),
 (5, 'Sunday School');

INSERT INTO members (member_id, external_id, first_name, last_name, gender, date_of_birth,
                     email, mobile_phone, marital_status, membership_status, join_date, baptism_date, confirmation_date) VALUES
 (1, 'DMS-001', 'John',    'Anderson', 'M', '1975-03-12', 'john.anderson@example.com',  '0244-555-001', 'married', 'member',  '2005-06-01', '1990-04-15', '1992-05-15'),
 (2, 'DMS-002', 'Mary',    'Anderson', 'F', '1977-07-22', 'mary.anderson@example.com',  '0244-555-002', 'married', 'member',  '2005-06-01', '1992-05-10', '1994-04-10'),
 (3, 'DMS-003', 'Ethan',   'Anderson', 'M', '2010-11-03', NULL,                          NULL,           NULL,      'regular', '2010-11-03', NULL,         NULL),
 (4, 'DMS-004', 'Robert',  'Brown',    'M', '1968-01-18', 'rob.brown@example.com',       '0244-555-003', 'married', 'member',  '2001-09-15', '1985-08-20', '1987-06-14'),
 (5, 'DMS-005', 'Linda',   'Brown',    'F', '1970-09-09', 'linda.brown@example.com',     '0244-555-004', 'married', 'member',  '2001-09-15', '1988-06-12', '1990-05-20'),
 (6, 'DMS-006', 'Wei',     'Chen',     'M', '1982-05-30', 'wei.chen@example.com',        '0244-555-005', 'married', 'member',  '2018-02-04', '2018-04-01', '2019-04-21'),
 (7, 'DMS-007', 'Mei',     'Chen',     'F', '1984-12-14', 'mei.chen@example.com',        '0244-555-006', 'married', 'member',  '2018-02-04', '2018-04-01', '2019-04-21'),
 (8, 'DMS-008', 'Sarah',   'Davis',    'F', '1995-04-20', 'sarah.davis@example.com',     '0244-555-007', 'single',  'regular', '2022-01-10', NULL,         NULL),
 (9, 'DMS-009', 'Pastor James', 'Whitfield','M','1960-02-02','pastor@example.com',       '0244-555-999', 'married', 'member',  '1995-01-01', '1980-03-01', '1982-04-11');

INSERT INTO organization_memberships (org_id, member_id, role) VALUES
 (1, 2, 'leader'), (1, 5, 'member'), (1, 7, 'member'),
 (3, 1, 'member'), (3, 4, 'leader'), (3, 6, 'member'),
 (4, 2, 'member'), (4, 5, 'leader'), (4, 7, 'member'),
 (5, 8, 'leader'), (5, 3, 'member');

-- Ministries used as "Bible Classes" in the UI.
INSERT INTO ministries (ministry_id, name, description, leader_id, org_id, meets_on) VALUES
 (1, 'Class Daniel',  'Adult Bible class — book of Daniel',  4, NULL, 'Sunday 8am'),
 (2, 'Class Esther',  'Women adult Bible class',             5, 4,    'Sunday 8am'),
 (3, 'Class Joshua',  'Men adult Bible class',               1, 3,    'Sunday 8am'),
 (4, 'Sunday School', 'Children & youth Sunday School',      8, 5,    'Sunday 9am');

UPDATE members SET bible_class_id = 1 WHERE member_id = 9;
UPDATE members SET bible_class_id = 2 WHERE member_id IN (2, 5, 7);
UPDATE members SET bible_class_id = 3 WHERE member_id IN (1, 4, 6);
UPDATE members SET bible_class_id = 4 WHERE member_id IN (3, 8);

INSERT INTO events (event_id, title, event_type, starts_at, ends_at, location) VALUES
 (1, 'Sunday Service',  'service',     '2026-05-03 10:00', '2026-05-03 11:30', 'Main Sanctuary'),
 (2, 'Sunday Service',  'service',     '2026-05-10 10:00', '2026-05-10 11:30', 'Main Sanctuary'),
 (3, 'Sunday Service',  'service',     '2026-05-17 10:00', '2026-05-17 11:30', 'Main Sanctuary'),
 (4, 'Wednesday Bible Study', 'bible_study', '2026-05-13 19:00', '2026-05-13 20:30', 'Fellowship Hall'),
 (5, 'Community Outreach',    'outreach',    '2026-05-16 09:00', '2026-05-16 13:00', 'Downtown Park');

INSERT INTO attendance (event_id, member_id) VALUES
 (1,1),(1,2),(1,3),(1,4),(1,5),(1,6),(1,7),(1,9),
 (2,1),(2,2),(2,3),(2,4),(2,5),(2,8),(2,9),
 (3,1),(3,2),(3,3),(3,4),(3,5),(3,6),(3,7),(3,8),(3,9),
 (4,1),(4,5),(4,7),(4,9),
 (5,4),(5,6),(5,8);

INSERT INTO funds (fund_id, name) VALUES
 (1, 'General'),
 (2, 'Building'),
 (3, 'Missions'),
 (4, 'Benevolence');

-- Sample service offerings + day-born splits (Sundays in May 2026).
INSERT INTO services (service_id, service_type_id, service_date, total_amount, notes) VALUES
 (1, 1, '2026-05-03', 1500.00, 'Sunday service'),
 (2, 1, '2026-05-10', 1700.00, 'Mothers Day service'),
 (3, 1, '2026-05-17', 1850.00, 'Sunday service');

INSERT INTO day_born_splits (service_id, day_born, amount, head_count) VALUES
 (1, 'Sunday',   400.00, 60),  (1, 'Monday',  150.00, 20), (1, 'Tuesday',  100.00, 12),
 (1, 'Wednesday',180.00, 22),  (1, 'Thursday',170.00, 21), (1, 'Friday',   250.00, 30),
 (1, 'Saturday', 250.00, 28),
 (2, 'Sunday',   450.00, 65),  (2, 'Wednesday',250.00, 30), (2, 'Friday',   300.00, 35),
 (3, 'Sunday',   500.00, 70),  (3, 'Wednesday',300.00, 32), (3, 'Friday',   350.00, 38);

INSERT INTO harvests (harvest_id, harvest_type, harvest_name, harvest_year, harvest_date, theme, total_collected) VALUES
 (1, 'Organizational', 'Choir Harvest 2026',     2026, '2026-04-12', NULL,                3200.00),
 (2, 'End-of-Year',    '2026 End-of-Year Harvest', 2026, NULL,         'Year of Faithfulness', 0.00);

INSERT INTO special_offerings (special_cat_id, offering_date, donor_id, amount, purpose) VALUES
 (1, '2026-05-03', 4, 500.00, 'Roof fund'),
 (1, '2026-05-10', 6, 300.00, 'Roof fund'),
 (2, '2026-05-17', 1, 250.00, 'Outreach to Akropong'),
 (3, '2026-05-03', 2, 100.00, 'Thanksgiving for new baby');

INSERT INTO pledges (member_id, harvest_id, pledged_amount, paid_amount, pledge_date, status) VALUES
 (1, 2, 1000.00, 200.00, '2026-04-10', 'Partial'),
 (4, 2, 2000.00,   0.00, '2026-04-10', 'Pending'),
 (5, 2,  500.00, 500.00, '2026-04-15', 'Fulfilled');

INSERT INTO sacraments (sacrament_type, member_id, spouse_id, officiant_id, occurred_on, location) VALUES
 ('baptism',  3, NULL, 9, '2024-04-07', 'Main Sanctuary'),
 ('marriage', 6, 7,    9, '2010-07-17', 'Springfield Chapel'),
 ('dedication', 3, NULL, 9, '2011-01-09', 'Main Sanctuary');

INSERT INTO pastoral_notes (member_id, recorded_by, occurred_on, category, summary) VALUES
 (5, 9, '2026-05-05', 'visit',          'Hospital visit after surgery; recovering well.'),
 (8, 9, '2026-05-09', 'counseling',     'Career discernment conversation.'),
 (4, 9, '2026-05-12', 'prayer_request', 'Requesting prayer for elderly mother.');

INSERT INTO expenses (category, amount, spent_on, description, fund_id) VALUES
 ('utilities',  340.00, '2026-05-04', 'Electricity bill',         1),
 ('salaries', 3500.00, '2026-05-01', 'Pastoral staff May',        1),
 ('building',  900.00, '2026-05-09', 'Roof leak repair',          2),
 ('missions',  500.00, '2026-05-12', 'Outreach materials',        3);

INSERT INTO welfare_cases (member_id, category, status, amount_disbursed, opened_on, summary) VALUES
 (8, 'medical',     'open',        0,    '2026-05-08', 'Support requested for medical bills.'),
 (3, 'food',        'in_progress', 80.00,'2026-05-10', 'Weekly food package.'),
 (5, 'bereavement', 'closed',      200.00,'2026-04-15','Funeral assistance.');

INSERT INTO announcements (title, body, audience, posted_by) VALUES
 ('Youth Service this Sunday',     'Youth Service will be held this Sunday at 6pm in the main hall. Everyone is welcome.', 'all', 1),
 ('Building Fund update',          'We are 70% of the way to our roof-repair goal. Thank you for your generous giving.', 'members', 1),
 ('Choir rehearsal moved',         'This week''s choir rehearsal is moved to Friday 7pm.', 'all', 1);

INSERT INTO activity_log (kind, description, link, occurred_at) VALUES
 ('member_added',         'New member added: Sarah Davis',          '/members/8', datetime('now','-1 day')),
 ('attendance_recorded',  'Attendance recorded for Sunday Service', '/events/3',  datetime('now','-1 day','-1 hour')),
 ('contribution_recorded','Offering of GH₵ 500.00 recorded',        '/finance',   datetime('now','-2 days')),
 ('welfare_opened',       'Welfare case submitted for Sarah Davis', '/welfare',   datetime('now','-2 days')),
 ('announcement',         'New announcement posted: Youth Service', '/communications', datetime('now','-3 days'));
