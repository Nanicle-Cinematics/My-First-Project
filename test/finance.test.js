'use strict';
// Unit tests for the finance aggregations (lib/finance) against an in-memory
// SQLite DB seeded with edge cases — year boundaries, soft-deletes, anonymous
// gifts, multiple sources, and empty results.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { financeYtd, memberGivingForYear, givingByMember } = require('../lib/finance');

// Build a throwaway DB with the schema + the runtime `tithes` table.
function freshDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  db.exec(`CREATE TABLE IF NOT EXISTS tithes (
    tithe_id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL, amount REAL NOT NULL,
    tithe_date TEXT NOT NULL, method TEXT, reference TEXT, notes TEXT,
    recorded_by INTEGER, deleted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.pragma('foreign_keys = ON');
  return db;
}
function seedCommon(db) {
  // service_types / special_categories are pre-seeded by schema.sql (id 1 exists);
  // funds are not seeded, so create one. Members are ours.
  db.prepare(`INSERT INTO members (member_id, first_name, last_name, membership_status) VALUES (?,?,?,?)`)
    .run(1, 'Esi', 'Mensah', 'member');
  db.prepare(`INSERT INTO members (member_id, first_name, last_name, membership_status) VALUES (?,?,?,?)`)
    .run(2, 'Kwame', 'Owusu', 'member');
  db.prepare(`INSERT INTO funds (fund_id, name) VALUES (1,'General')`).run();
}

test('financeYtd sums only the target year and excludes soft-deleted rows', () => {
  const db = freshDb(); seedCommon(db);
  const svc = db.prepare(`INSERT INTO services (service_type_id, service_date, total_amount, deleted_at) VALUES (1,?,?,?)`);
  svc.run('2025-02-01', 1000, null);          // in year
  svc.run('2025-11-30', 500, null);           // in year
  svc.run('2024-12-31', 9999, null);          // prior year — excluded
  svc.run('2025-06-01', 777, '2025-06-02');   // soft-deleted — excluded
  db.prepare(`INSERT INTO special_offerings (special_cat_id, offering_date, amount, deleted_at) VALUES (1,?,?,?)`).run('2025-03-01', 250, null);
  db.prepare(`INSERT INTO tithes (member_id, amount, tithe_date) VALUES (1,?,?)`).run(300, '2025-04-01');
  db.prepare(`INSERT INTO harvests (harvest_type, harvest_name, harvest_year, total_collected) VALUES ('Other','Harvest 2025',2025,400)`).run();
  db.prepare(`INSERT INTO harvests (harvest_type, harvest_name, harvest_year, total_collected) VALUES ('Other','Harvest 2024',2024,8888)`).run();
  db.prepare(`INSERT INTO expenses (category, amount, spent_on) VALUES ('rent',200,'2025-05-01')`).run();

  const r = financeYtd(db, 2025);
  assert.strictEqual(r.services, 1500);            // 1000+500, excludes prior-year + deleted
  assert.strictEqual(r.special, 250);
  assert.strictEqual(r.tithes, 300);
  assert.strictEqual(r.harvests, 400);             // only 2025 harvest
  assert.strictEqual(r.expenses, 200);
  assert.strictEqual(r.offerings, 2050);           // 1500+250+300
  assert.strictEqual(r.net, 2250);                 // 2050 + 400 - 200
});

test('financeYtd returns zeros for an empty year', () => {
  const db = freshDb(); seedCommon(db);
  const r = financeYtd(db, 2099);
  assert.deepStrictEqual(r, { services: 0, harvests: 0, special: 0, tithes: 0, expenses: 0, offerings: 0, net: 0 });
});

test('memberGivingForYear merges sources, sorts by date, subtotals, excludes others', () => {
  const db = freshDb(); seedCommon(db);
  db.prepare(`INSERT INTO tithes (member_id, amount, tithe_date, method) VALUES (1,?,?,?)`).run(300, '2025-03-10', 'cash');
  db.prepare(`INSERT INTO tithes (member_id, amount, tithe_date) VALUES (1,?,?)`).run(200, '2025-01-05');
  db.prepare(`INSERT INTO tithes (member_id, amount, tithe_date, deleted_at) VALUES (1,?,?,?)`).run(999, '2025-02-02', '2025-02-03'); // deleted
  db.prepare(`INSERT INTO tithes (member_id, amount, tithe_date) VALUES (1,?,?)`).run(50, '2024-12-31'); // prior year
  db.prepare(`INSERT INTO special_offerings (special_cat_id, offering_date, donor_id, amount) VALUES (1,?,?,?)`).run('2025-04-01', 1, 250);
  db.prepare(`INSERT INTO special_offerings (special_cat_id, offering_date, donor_id, amount) VALUES (1,?,?,?)`).run('2025-05-01', 2, 999); // other member
  db.prepare(`INSERT INTO contributions (member_id, fund_id, amount, contributed_on) VALUES (1,1,?,?)`).run(75, '2025-02-15');

  const r = memberGivingForYear(db, 1, 2025);
  assert.strictEqual(r.total, 825);                       // 200+300+250+75
  assert.strictEqual(r.lines.length, 4);
  assert.deepStrictEqual(r.lines.map((l) => l.dt), ['2025-01-05', '2025-02-15', '2025-03-10', '2025-04-01']); // sorted
  assert.strictEqual(r.byGroup.Tithes, 500);
  assert.strictEqual(r.byGroup['Special Offerings'], 250);
  assert.strictEqual(r.byGroup.Contributions, 75);
});

test('memberGivingForYear is empty for a member with no giving', () => {
  const db = freshDb(); seedCommon(db);
  const r = memberGivingForYear(db, 2, 2025);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.lines.length, 0);
  assert.deepStrictEqual(r.byGroup, {});
});

test('givingByMember excludes anonymous + deleted, ranks by total', () => {
  const db = freshDb(); seedCommon(db);
  db.prepare(`INSERT INTO tithes (member_id, amount, tithe_date) VALUES (1,?,?)`).run(500, '2025-01-01');
  db.prepare(`INSERT INTO special_offerings (special_cat_id, offering_date, donor_id, amount) VALUES (1,?,?,?)`).run('2025-02-01', 2, 900);
  db.prepare(`INSERT INTO special_offerings (special_cat_id, offering_date, donor_id, amount) VALUES (1,?,?,?)`).run('2025-03-01', null, 1000); // anonymous — excluded
  db.prepare(`INSERT INTO tithes (member_id, amount, tithe_date, deleted_at) VALUES (1,?,?,?)`).run(777, '2025-04-01', '2025-04-02'); // deleted

  const rows = givingByMember(db, 2025);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].member_id, 2);  // 900 ranks first
  assert.strictEqual(rows[0].total, 900);
  assert.strictEqual(rows[1].member_id, 1);  // 500 (deleted tithe excluded)
  assert.strictEqual(rows[1].total, 500);
});
