-- Sample data for the church management database.

INSERT INTO households (household_id, family_name, address_line1, city, state, postal_code, home_phone) VALUES
 (1, 'Anderson', '12 Oak Lane',    'Springfield', 'IL', '62701', '217-555-0101'),
 (2, 'Brown',    '88 Maple Ave',   'Springfield', 'IL', '62702', '217-555-0102'),
 (3, 'Chen',     '5 Pine Court',   'Springfield', 'IL', '62703', '217-555-0103'),
 (4, 'Davis',    '301 Elm Street', 'Springfield', 'IL', '62704', '217-555-0104');

INSERT INTO members (member_id, household_id, first_name, last_name, gender, date_of_birth,
                     email, mobile_phone, marital_status, membership_status, join_date, baptism_date) VALUES
 (1, 1, 'John',    'Anderson', 'M', '1975-03-12', 'john.anderson@example.com',  '217-555-1001', 'married',  'member',  '2005-06-01', '1990-04-15'),
 (2, 1, 'Mary',    'Anderson', 'F', '1977-07-22', 'mary.anderson@example.com',  '217-555-1002', 'married',  'member',  '2005-06-01', '1992-05-10'),
 (3, 1, 'Ethan',   'Anderson', 'M', '2010-11-03', NULL,                          NULL,           NULL,       'regular', '2010-11-03', NULL),
 (4, 2, 'Robert',  'Brown',    'M', '1968-01-18', 'rob.brown@example.com',       '217-555-1003', 'married',  'member',  '2001-09-15', '1985-08-20'),
 (5, 2, 'Linda',   'Brown',    'F', '1970-09-09', 'linda.brown@example.com',     '217-555-1004', 'married',  'member',  '2001-09-15', '1988-06-12'),
 (6, 3, 'Wei',     'Chen',     'M', '1982-05-30', 'wei.chen@example.com',        '217-555-1005', 'married',  'member',  '2018-02-04', '2018-04-01'),
 (7, 3, 'Mei',     'Chen',     'F', '1984-12-14', 'mei.chen@example.com',        '217-555-1006', 'married',  'member',  '2018-02-04', '2018-04-01'),
 (8, 4, 'Sarah',   'Davis',    'F', '1995-04-20', 'sarah.davis@example.com',     '217-555-1007', 'single',   'regular', '2022-01-10', NULL),
 (9, NULL,'Pastor James','Whitfield','M','1960-02-02','pastor@example.com',      '217-555-9999', 'married',  'member',  '1995-01-01', '1980-03-01');

INSERT INTO ministries (ministry_id, name, description, leader_id, meets_on) VALUES
 (1, 'Choir',       'Sunday worship choir',     2, 'Thursday 7pm'),
 (2, 'Youth Group', 'Teens grades 6-12',        8, 'Friday 6pm'),
 (3, 'Ushers',      'Sunday service ushers',    4, 'Sunday 9am'),
 (4, 'Prayer Team', 'Intercessory prayer team', 5, 'Tuesday 6am');

INSERT INTO ministry_memberships (ministry_id, member_id, role, joined_date) VALUES
 (1, 2, 'leader', '2020-01-15'),
 (1, 5, 'member', '2020-02-01'),
 (1, 7, 'member', '2021-09-01'),
 (2, 8, 'leader', '2022-03-01'),
 (2, 3, 'member', '2023-09-01'),
 (3, 4, 'leader', '2019-01-01'),
 (3, 1, 'member', '2019-01-01'),
 (3, 6, 'member', '2018-03-01'),
 (4, 5, 'leader', '2018-06-01'),
 (4, 7, 'member', '2020-01-01');

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

INSERT INTO contributions (member_id, fund_id, amount, contributed_on, method, reference) VALUES
 (1, 1, 250.00, '2026-05-03', 'check',  '1042'),
 (2, 1, 100.00, '2026-05-03', 'cash',   NULL),
 (4, 1, 500.00, '2026-05-03', 'online', 'TXN-77001'),
 (4, 2, 100.00, '2026-05-03', 'online', 'TXN-77002'),
 (6, 1, 300.00, '2026-05-03', 'card',   'TXN-77010'),
 (NULL,1, 45.00,'2026-05-03', 'cash',   NULL),
 (1, 1, 250.00, '2026-05-10', 'check',  '1051'),
 (5, 3,  75.00, '2026-05-10', 'online', 'TXN-77100'),
 (6, 1, 300.00, '2026-05-10', 'card',   'TXN-77105'),
 (8, 1,  40.00, '2026-05-10', 'online', 'TXN-77110'),
 (1, 1, 250.00, '2026-05-17', 'check',  '1059'),
 (4, 1, 500.00, '2026-05-17', 'online', 'TXN-77200'),
 (4, 4, 200.00, '2026-05-17', 'online', 'TXN-77201'),
 (7, 3, 150.00, '2026-05-17', 'card',   'TXN-77210');

INSERT INTO sacraments (sacrament_type, member_id, spouse_id, officiant_id, occurred_on, location) VALUES
 ('baptism',  3, NULL, 9, '2024-04-07', 'Main Sanctuary'),
 ('marriage', 6, 7,    9, '2010-07-17', 'Springfield Chapel'),
 ('dedication', 3, NULL, 9, '2011-01-09', 'Main Sanctuary');

INSERT INTO pastoral_notes (member_id, recorded_by, occurred_on, category, summary) VALUES
 (5, 9, '2026-05-05', 'visit',          'Hospital visit after surgery; recovering well.'),
 (8, 9, '2026-05-09', 'counseling',     'Career discernment conversation.'),
 (4, 9, '2026-05-12', 'prayer_request', 'Requesting prayer for elderly mother.');
