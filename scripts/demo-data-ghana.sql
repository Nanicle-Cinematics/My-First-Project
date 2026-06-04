-- Demo data for marketing screenshots — Grace Methodist Church (fictional).
-- Use with scripts/build-demo.sh to produce demo.db, then point the server at
-- it via CHURCH_DB=demo.db npm start. Do NOT load this into church.db (real
-- data) — it assumes an empty schema and uses fixed IDs.

PRAGMA foreign_keys = OFF;

----------------------------------------------------------------
-- Households (Ghanaian family names, realistic addresses)
----------------------------------------------------------------
INSERT INTO households (household_id, family_name, address_line1, city, state, postal_code, home_phone) VALUES
 (1,  'Mensah',     'House No. 12, Adabraka',        'Accra',     'Greater Accra', 'GA-123-4567', '030-256-0101'),
 (2,  'Asante',     '7 Oxford Street, Osu',          'Accra',     'Greater Accra', 'GA-124-7791', '030-256-0102'),
 (3,  'Boateng',    'Plot 34, East Legon',           'Accra',     'Greater Accra', 'GA-101-1212', '030-256-0103'),
 (4,  'Adjei',      'Kasoa High Street',             'Kasoa',     'Central',       'CK-512-1188', '030-256-0104'),
 (5,  'Owusu',      'KNUST Campus, Kotei',           'Kumasi',    'Ashanti',       'AK-039-9911', '032-256-0105'),
 (6,  'Darko',      'Adum Avenue 18',                'Kumasi',    'Ashanti',       'AK-040-7714', '032-256-0106'),
 (7,  'Acheampong', 'Manse, Methodist Church Road',  'Koforidua', 'Eastern',       'EK-204-1100', '034-256-0107'),
 (8,  'Sarpong',    'Old Tafo Lane',                 'Kumasi',    'Ashanti',       'AK-038-1199', '032-256-0108'),
 (9,  'Antwi',      'Spintex Road, North',           'Accra',     'Greater Accra', 'GA-220-3344', '030-256-0109'),
 (10, 'Ofori',      'Madina Estates Block C',        'Accra',     'Greater Accra', 'GA-188-2200', '030-256-0110'),
 (11, 'Yeboah',     'Suame Roundabout 3',            'Kumasi',    'Ashanti',       'AK-041-5532', '032-256-0111'),
 (12, 'Nyarko',     'Tema Community 9',              'Tema',      'Greater Accra', 'GT-077-2244', '030-256-0112');

----------------------------------------------------------------
-- Organizations (Methodist-style)
----------------------------------------------------------------
INSERT INTO organizations (org_id, name) VALUES
 (1, 'Church Choir'),
 (2, 'Singing Band'),
 (3, "Men's Fellowship"),
 (4, "Women's Fellowship"),
 (5, 'Sunday School'),
 (6, 'Youth Ministry'),
 (7, 'Boys'' Brigade'),
 (8, 'Girls'' Fellowship');

----------------------------------------------------------------
-- Members (realistic Ghanaian names — first names follow Akan
-- day-born conventions, so reports demonstrate the feature well)
----------------------------------------------------------------
INSERT INTO members (member_id, external_id, household_id, first_name, last_name, gender, date_of_birth,
                     email, mobile_phone, marital_status, membership_status,
                     join_date, baptism_date, confirmation_date, preferred_channel) VALUES
 ( 1, 'GMC-001',  1, 'Nana Yaw',  'Mensah',     'M', '1962-04-12', 'nyaw.mensah@example.gh',    '024-301-7720', 'married',  'member',  '1985-09-01', '1962-06-10', '1979-04-22', 'either'),
 ( 2, 'GMC-002',  1, 'Akua',      'Mensah',     'F', '1965-08-22', 'akua.mensah@example.gh',    '024-301-7721', 'married',  'member',  '1990-02-14', '1965-10-15', '1981-04-19', 'either'),
 ( 3, 'GMC-003',  1, 'Kojo',      'Mensah',     'M', '2008-11-04', NULL,                         NULL,            NULL,       'regular', '2008-12-07', '2009-02-08', NULL,         'none'),
 ( 4, 'GMC-004',  2, 'Kwame',     'Asante',     'M', '1978-03-19', 'kwame.asante@example.gh',   '055-188-2030', 'married',  'member',  '2002-06-30', '1979-05-12', '1995-04-16', 'either'),
 ( 5, 'GMC-005',  2, 'Ama',       'Asante',     'F', '1980-12-06', 'ama.asante@example.gh',     '055-188-2031', 'married',  'member',  '2002-06-30', '1981-02-08', '1996-04-07', 'either'),
 ( 6, 'GMC-006',  3, 'Kofi',      'Boateng',    'M', '1985-07-25', 'kofi.boateng@example.gh',   '024-555-9911', 'married',  'member',  '2010-10-03', '1985-09-22', '2001-04-15', 'sms_only'),
 ( 7, 'GMC-007',  3, 'Abena',     'Boateng',    'F', '1988-02-14', 'abena.boateng@example.gh',  '024-555-9912', 'married',  'member',  '2010-10-03', '1988-04-03', '2003-04-20', 'either'),
 ( 8, 'GMC-008',  4, 'Kwaku',     'Adjei',      'M', '1972-09-10', 'kwaku.adjei@example.gh',    '020-401-7755', 'married',  'member',  '1996-08-04', '1973-01-07', '1989-04-23', 'either'),
 ( 9, 'GMC-009',  4, 'Akosua',    'Adjei',      'F', '1975-11-23', 'akosua.adjei@example.gh',   '020-401-7756', 'married',  'member',  '1996-08-04', '1976-03-14', '1991-04-07', 'either'),
 (10, 'GMC-010',  5, 'Yaa',       'Owusu',      'F', '1990-05-31', 'yaa.owusu@example.gh',      '026-220-4488', 'single',   'member',  '2015-04-12', '1991-08-18', '2006-04-16', 'sms_only'),
 (11, 'GMC-011',  6, 'Kojo',      'Darko',      'M', '1992-04-08', 'kojo.darko@example.gh',     '054-188-9923', 'single',   'member',  '2017-11-19', '1992-06-21', '2008-04-20', 'either'),
 (12, 'GMC-012',  7, 'Samuel',    'Acheampong', 'M', '1955-01-15', 'rev.acheampong@example.gh', '024-999-0001', 'married',  'member',  '1978-09-01', '1955-04-10', '1972-04-02', 'either'),
 (13, 'GMC-013',  7, 'Joyce',     'Acheampong', 'F', '1958-06-22', 'joyce.acheampong@example.gh','024-999-0002','married',  'member',  '1980-12-20', '1958-09-14', '1975-04-13', 'either'),
 (14, 'GMC-014',  8, 'Nana Adwoa','Sarpong',    'F', '1968-10-13', 'adwoa.sarpong@example.gh',  '024-700-1144', 'widowed',  'member',  '1993-03-21', '1969-01-19', '1985-04-07', 'either'),
 (15, 'GMC-015',  9, 'Kwesi',     'Antwi',      'M', '1982-12-30', 'kwesi.antwi@example.gh',    '050-300-8822', 'married',  'member',  '2008-05-25', '1983-03-06', '1999-04-04', 'sms_only'),
 (16, 'GMC-016',  9, 'Adwoa',     'Antwi',      'F', '1984-08-17', 'adwoa.antwi@example.gh',    '050-300-8823', 'married',  'member',  '2008-05-25', '1985-01-12', '2000-04-23', 'either'),
 (17, 'GMC-017', 10, 'Yaw',       'Ofori',      'M', '1979-11-08', 'yaw.ofori@example.gh',      '024-411-5566', 'married',  'member',  '2004-07-18', '1980-02-17', '1996-04-07', 'either'),
 (18, 'GMC-018', 10, 'Afua',      'Ofori',      'F', '1982-02-26', 'afua.ofori@example.gh',     '024-411-5567', 'married',  'member',  '2004-07-18', '1982-05-09', '1998-04-12', 'either'),
 (19, 'GMC-019', 11, 'Kwabena',   'Yeboah',     'M', '1996-06-04', 'kwabena.yeboah@example.gh', '055-722-3399', 'single',   'member',  '2018-03-25', '1996-09-08', '2012-04-08', 'sms_only'),
 (20, 'GMC-020', 11, 'Akua',      'Yeboah',     'F', '2010-09-29', NULL,                         NULL,            NULL,       'regular', '2010-11-21', '2011-01-23', NULL,         'none'),
 (21, 'GMC-021', 12, 'Esi',       'Nyarko',     'F', '1995-03-17', 'esi.nyarko@example.gh',     '026-505-1100', 'single',   'member',  '2019-10-06', '1995-06-04', '2011-04-24', 'either'),
 (22, 'GMC-022', 12, 'Akwasi',    'Nyarko',     'M', '1993-10-26', 'akwasi.nyarko@example.gh',  '026-505-1101', 'single',   'regular', '2020-02-09', '1993-12-19', '2009-04-12', 'either');

----------------------------------------------------------------
-- Organization memberships
----------------------------------------------------------------
INSERT INTO organization_memberships (org_id, member_id, role) VALUES
 (1,  5, 'leader'),  (1,  7, 'member'), (1, 16, 'member'), (1, 18, 'member'),  (1, 13, 'member'),
 (2,  4, 'leader'),  (2, 11, 'member'), (2, 19, 'member'), (2, 17, 'member'),
 (3,  1, 'leader'),  (3,  4, 'member'), (3,  6, 'member'), (3,  8, 'member'),  (3, 15, 'member'), (3, 17, 'member'),
 (4,  2, 'leader'),  (4,  5, 'member'), (4,  7, 'member'), (4,  9, 'member'),  (4, 13, 'member'), (4, 14, 'member'), (4, 16, 'member'), (4, 18, 'member'),
 (5, 14, 'leader'),  (5, 21, 'leader'), (5,  3, 'member'), (5, 20, 'member'),
 (6, 21, 'leader'),  (6, 10, 'member'), (6, 11, 'member'), (6, 19, 'member'),  (6, 22, 'member'),
 (7,  6, 'leader'),  (7, 19, 'member'),
 (8, 18, 'leader'),  (8, 10, 'member'), (8, 16, 'member');

----------------------------------------------------------------
-- Bible classes (Methodist-style)
----------------------------------------------------------------
INSERT INTO ministries (ministry_id, name, description, leader_id, org_id, meets_on) VALUES
 (1, 'Class Daniel',  'Senior adults — book of Daniel',         1,    NULL, 'Sunday 8:00am'),
 (2, 'Class Esther',  "Women's adult Bible class",              2,    4,    'Sunday 8:00am'),
 (3, 'Class Joshua',  "Men's adult Bible class",                4,    3,    'Sunday 8:00am'),
 (4, 'Class Ruth',    'Young adults Bible class',              16,    NULL, 'Sunday 8:00am'),
 (5, 'Sunday School', 'Children & youth Sunday School',        14,    5,    'Sunday 9:00am');

UPDATE members SET bible_class_id = 1 WHERE member_id IN (1, 12, 13, 14);
UPDATE members SET bible_class_id = 2 WHERE member_id IN (2, 5, 7, 9, 16, 18);
UPDATE members SET bible_class_id = 3 WHERE member_id IN (4, 6, 8, 15, 17);
UPDATE members SET bible_class_id = 4 WHERE member_id IN (10, 11, 19, 21, 22);
UPDATE members SET bible_class_id = 5 WHERE member_id IN (3, 20);

----------------------------------------------------------------
-- Funds: schema.sql already creates these with these IDs, skip.
--   1=General Offering  2=Tithe  3=Building Fund
--   4=Mission Fund      5=Welfare Fund  6=Thanksgiving
----------------------------------------------------------------

----------------------------------------------------------------
-- Events (Sundays for the past 4 weeks + a midweek service)
----------------------------------------------------------------
INSERT INTO events (event_id, title, event_type, starts_at, ends_at, location) VALUES
 (1, 'Sunday Worship Service', 'service',     '2026-04-26 09:00', '2026-04-26 11:30', 'Main Sanctuary'),
 (2, 'Sunday Worship Service', 'service',     '2026-05-03 09:00', '2026-05-03 11:30', 'Main Sanctuary'),
 (3, 'Sunday Worship Service', 'service',     '2026-05-10 09:00', '2026-05-10 11:30', 'Main Sanctuary'),
 (4, 'Sunday Worship Service', 'service',     '2026-05-17 09:00', '2026-05-17 11:30', 'Main Sanctuary'),
 (5, 'Wednesday Bible Study',  'bible_study', '2026-05-13 18:30', '2026-05-13 20:00', 'Fellowship Hall'),
 (6, 'Easter Sunday Service',  'service',     '2026-04-05 08:00', '2026-04-05 12:00', 'Main Sanctuary');

----------------------------------------------------------------
-- Attendance (realistic — most regulars on Sundays, mid-week smaller)
----------------------------------------------------------------
INSERT INTO attendance (event_id, member_id) VALUES
 (1, 1),(1, 2),(1, 4),(1, 5),(1, 6),(1, 7),(1, 8),(1, 9),(1,12),(1,13),(1,14),(1,15),(1,16),(1,17),(1,18),(1,21),
 (2, 1),(2, 2),(2, 3),(2, 4),(2, 5),(2, 6),(2, 7),(2, 8),(2, 9),(2,10),(2,11),(2,12),(2,13),(2,14),(2,16),(2,17),(2,18),(2,19),(2,21),
 (3, 1),(3, 2),(3, 4),(3, 5),(3, 7),(3, 8),(3, 9),(3,12),(3,13),(3,14),(3,15),(3,17),(3,18),(3,21),
 (4, 1),(4, 2),(4, 3),(4, 4),(4, 5),(4, 6),(4, 7),(4, 8),(4, 9),(4,10),(4,11),(4,12),(4,13),(4,14),(4,15),(4,16),(4,17),(4,18),(4,19),(4,20),(4,21),(4,22),
 (5, 1),(5, 4),(5, 8),(5,12),(5,14),(5,15),
 (6, 1),(6, 2),(6, 3),(6, 4),(6, 5),(6, 6),(6, 7),(6, 8),(6, 9),(6,10),(6,11),(6,12),(6,13),(6,14),(6,15),(6,16),(6,17),(6,18),(6,19),(6,20),(6,21),(6,22);

----------------------------------------------------------------
-- Contributions (tithes + offerings + building fund — last 4 weeks)
----------------------------------------------------------------
INSERT INTO contributions (member_id, fund_id, amount, contributed_on, method) VALUES
 -- Apr 26 service
 ( 1, 2,  500.00, '2026-04-26', 'cash'),
 ( 4, 2,  350.00, '2026-04-26', 'transfer'),
 ( 6, 2,  200.00, '2026-04-26', 'cash'),
 ( 8, 2,  400.00, '2026-04-26', 'cash'),
 (12, 2,  700.00, '2026-04-26', 'transfer'),
 (15, 2,  250.00, '2026-04-26', 'cash'),
 (17, 2,  300.00, '2026-04-26', 'cash'),
 ( 1, 1,   50.00, '2026-04-26', 'cash'),
 ( 2, 1,   30.00, '2026-04-26', 'cash'),
 ( 5, 1,   40.00, '2026-04-26', 'cash'),
 (10, 1,   20.00, '2026-04-26', 'cash'),
 (14, 1,   25.00, '2026-04-26', 'cash'),

 -- May 3 service
 ( 1, 2,  500.00, '2026-05-03', 'cash'),
 ( 4, 2,  350.00, '2026-05-03', 'transfer'),
 ( 6, 2,  200.00, '2026-05-03', 'cash'),
 ( 8, 2,  400.00, '2026-05-03', 'cash'),
 (12, 2,  700.00, '2026-05-03', 'transfer'),
 (15, 2,  250.00, '2026-05-03', 'cash'),
 (17, 2,  300.00, '2026-05-03', 'cash'),
 ( 9, 2,  150.00, '2026-05-03', 'cash'),
 ( 1, 3,  200.00, '2026-05-03', 'transfer'),
 ( 4, 3,  150.00, '2026-05-03', 'transfer'),
 (12, 3,  300.00, '2026-05-03', 'transfer'),

 -- May 10 service (Mother's Day — bigger Welfare)
 ( 1, 2,  500.00, '2026-05-10', 'cash'),
 ( 4, 2,  350.00, '2026-05-10', 'transfer'),
 ( 8, 2,  400.00, '2026-05-10', 'cash'),
 (12, 2,  700.00, '2026-05-10', 'transfer'),
 (17, 2,  300.00, '2026-05-10', 'cash'),
 ( 2, 5,  100.00, '2026-05-10', 'cash'),
 ( 5, 5,   80.00, '2026-05-10', 'cash'),
 ( 9, 5,   80.00, '2026-05-10', 'cash'),
 (13, 5,  150.00, '2026-05-10', 'cash'),
 (14, 5,   60.00, '2026-05-10', 'cash'),
 (16, 5,   80.00, '2026-05-10', 'cash'),
 (18, 5,   80.00, '2026-05-10', 'cash'),

 -- May 17 service
 ( 1, 2,  500.00, '2026-05-17', 'cash'),
 ( 4, 2,  350.00, '2026-05-17', 'transfer'),
 ( 6, 2,  200.00, '2026-05-17', 'cash'),
 ( 8, 2,  400.00, '2026-05-17', 'cash'),
 (12, 2,  700.00, '2026-05-17', 'transfer'),
 (15, 2,  250.00, '2026-05-17', 'cash'),
 (17, 2,  300.00, '2026-05-17', 'cash'),
 (10, 2,  150.00, '2026-05-17', 'transfer'),
 (11, 1,   30.00, '2026-05-17', 'cash'),
 (19, 1,   25.00, '2026-05-17', 'cash'),
 (21, 1,   35.00, '2026-05-17', 'cash');

----------------------------------------------------------------
-- Expenses (this month). Categories come pre-populated by schema:
--   1=Utilities  2=Salaries  3=Maintenance  4=Office Supplies
--   5=Outreach   6=Welfare   7=Events
----------------------------------------------------------------
INSERT INTO expenses (expense_cat_id, category, amount, spent_on, description, paid_to, payment_method) VALUES
 (1, 'Utilities',       420.00, '2026-05-02', 'ECG electricity bill — April',     'Electricity Company of Ghana', 'transfer'),
 (1, 'Utilities',       180.00, '2026-05-02', 'Ghana Water Co. — April',          'GWCL',                          'transfer'),
 (3, 'Maintenance',     350.00, '2026-05-05', 'Roof repair — vestry',             'Yaw Construction Works',        'cash'),
 (2, 'Salaries',        800.00, '2026-05-01', 'Caretaker allowance — May',        'Mr. Asare',                     'cash'),
 (4, 'Office Supplies', 240.00, '2026-05-09', 'Communion elements & cups',        'Melcom Supermarket',            'cash'),
 (5, 'Outreach',        500.00, '2026-05-16', 'Outreach to Pokuase orphanage',    'Methodist Welfare Office',      'transfer'),
 (7, 'Events',          120.00, '2026-05-13', 'Pastor''s circuit transport',     'Cab fare',                       'cash');

----------------------------------------------------------------
-- Harvest + pledges (End-of-Year 2025)
----------------------------------------------------------------
INSERT INTO harvests (harvest_id, harvest_type, harvest_name, harvest_year, harvest_date, theme, total_collected) VALUES
 (1, 'End-of-Year', 'End-of-Year Harvest 2025', 2025, '2025-12-14', 'Bringing in the Sheaves — Psalm 126:6', 18400.00),
 (2, 'Organizational', "Men's Fellowship Harvest 2026", 2026, '2026-03-22', 'Men of Valour — 1 Chronicles 12:8', 4600.00);

INSERT INTO pledges (pledge_id, member_id, harvest_id, pledged_amount, paid_amount, pledge_date, status) VALUES
 ( 1,  1, 1, 2000.00, 2000.00, '2025-11-09', 'Fulfilled'),
 ( 2,  2, 1,  800.00,  800.00, '2025-11-09', 'Fulfilled'),
 ( 3,  4, 1, 1500.00, 1500.00, '2025-11-09', 'Fulfilled'),
 ( 4,  5, 1,  600.00,  600.00, '2025-11-09', 'Fulfilled'),
 ( 5,  6, 1, 1000.00,  500.00, '2025-11-09', 'Partial'),
 ( 6,  7, 1,  400.00,  400.00, '2025-11-09', 'Fulfilled'),
 ( 7,  8, 1, 1200.00, 1200.00, '2025-11-09', 'Fulfilled'),
 ( 8,  9, 1,  500.00,  500.00, '2025-11-09', 'Fulfilled'),
 ( 9, 12, 1, 3000.00, 3000.00, '2025-11-09', 'Fulfilled'),
 (10, 13, 1, 1000.00, 1000.00, '2025-11-09', 'Fulfilled'),
 (11, 14, 1,  600.00,  600.00, '2025-11-09', 'Fulfilled'),
 (12, 15, 1,  800.00,  600.00, '2025-11-09', 'Partial'),
 (13, 16, 1,  400.00,  400.00, '2025-11-09', 'Fulfilled'),
 (14, 17, 1, 1000.00, 1000.00, '2025-11-09', 'Fulfilled'),
 (15, 18, 1,  400.00,  400.00, '2025-11-09', 'Fulfilled'),
 (16, 10, 1,  300.00,  300.00, '2025-11-09', 'Fulfilled'),
 (17, 21, 1,  300.00,  100.00, '2025-11-09', 'Partial'),
 (18, 11, 1,  300.00,    0.00, '2025-11-09', 'Pending'),
 -- Men's Fellowship Harvest 2026 pledges
 (19,  1, 2,  800.00,  800.00, '2026-02-15', 'Fulfilled'),
 (20,  4, 2,  600.00,  600.00, '2026-02-15', 'Fulfilled'),
 (21,  6, 2,  500.00,  400.00, '2026-02-15', 'Partial'),
 (22,  8, 2,  700.00,  700.00, '2026-02-15', 'Fulfilled'),
 (23, 15, 2,  500.00,  500.00, '2026-02-15', 'Fulfilled'),
 (24, 17, 2,  600.00,  600.00, '2026-02-15', 'Fulfilled'),
 (25, 19, 2,  300.00,  200.00, '2026-02-15', 'Partial'),
 (26, 11, 2,  300.00,    0.00, '2026-02-15', 'Pending');

PRAGMA foreign_keys = ON;

-- Done. Sample-data totals:
--   22 members across 12 households
--   8 organizations, 5 Bible classes
--   6 services + 1 Bible study with attendance
--   45+ contributions (tithes, offerings, building, welfare)
--   7 expenses across 6 categories
--   2 harvests with 26 pledges
