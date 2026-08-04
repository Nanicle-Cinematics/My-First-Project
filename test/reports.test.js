'use strict';
// Phase 4: routes-pg/reports.js. These endpoints use raw $queryRaw (not the
// tenantDb extension), so — unlike every other routes-pg/*.js test file so
// far — there is NO structural safety net protecting tenant isolation here.
// Cross-tenant assertions in this file are the actual proof that the manual
// churchId-binding in every raw SQL block (enforced by
// scripts/check-raw-sql-tenant-scoping.js) works correctly, not a formality.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const createdChurchIds = [];

let server, base;
test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  if (createdChurchIds.length) {
    const where = { churchId: { in: createdChurchIds } };
    await db.dayBornSplit.deleteMany({ where });
    await db.service.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.pledgePayment.deleteMany({ where });
    await db.pledge.deleteMany({ where });
    await db.specialOffering.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.dayBornCollection.deleteMany({ where });
    await db.harvest.deleteMany({ where });
    await db.incomeRecord.deleteMany({ where });
    await db.tithe.deleteMany({ where });
    await db.attendance.deleteMany({ where });
    await db.event.deleteMany({ where });
    await db.member.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
  await pool.end();
});

function cookieClient() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  const send = async (method, p) => {
    const res = await fetch(base + p, { method, headers: cookie ? { cookie } : {} });
    remember(res);
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  };
  return { get: (p) => send('GET', p), post: (p) => send('POST', p) };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function signupChurch(tag) {
  const email = uniqueEmail(tag);
  const res = await fetch(`${base}/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ churchName: `${tag} Church`, name: 'Owner', email, password: 'password123' }),
  });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = set.find((c) => c.startsWith('connect.sid='))?.split(';')[0];
  const body = await res.json();
  createdChurchIds.push(body.church.id);
  return {
    churchId: body.church.id,
    client: {
      get: async (p) => {
        const r = await fetch(base + p, { headers: { cookie } });
        const text = await r.text();
        let b; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
        return { status: r.status, body: b };
      },
    },
  };
}

test('day-born: crosstab and bars are computed only from this church\'s data', async () => {
  const a = await signupChurch('rep-dayborn-a');
  const b = await signupChurch('rep-dayborn-b');

  // 'Sunday Service' is already seeded per-church at signup (Phase 9e) — look it up rather than re-create it.
  const st = await db.serviceType.findFirst({ where: { churchId: a.churchId, typeName: 'Sunday Service' } });
  const svc1 = await db.service.create({ data: { churchId: a.churchId, serviceTypeId: st.id, serviceDate: new Date('2026-06-07'), totalAmount: 500 } });
  const svc2 = await db.service.create({ data: { churchId: a.churchId, serviceTypeId: st.id, serviceDate: new Date('2026-06-14'), totalAmount: 300 } });
  await db.dayBornSplit.create({ data: { churchId: a.churchId, serviceId: svc1.id, dayBorn: 'SUNDAY', amount: 500 } });
  await db.dayBornSplit.create({ data: { churchId: a.churchId, serviceId: svc2.id, dayBorn: 'MONDAY', amount: 300 } });

  const res = await a.client.get('/api/reports/day-born?start=2026-06-01&end=2026-06-30');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.bars.length, 2);
  const sunday = res.body.crosstab.find((r) => r.day_born === 'SUNDAY');
  assert.strictEqual(sunday.sunday_svc, 500);
  assert.strictEqual(sunday.day_total, 500);

  const bRes = await b.client.get('/api/reports/day-born?start=2026-06-01&end=2026-06-30');
  assert.strictEqual(bRes.body.bars.length, 0, 'church B must see none of church A\'s day-born data');
});

test('income detail: aggregates across tithes/income-records/harvests/etc, scoped per church', async () => {
  const a = await signupChurch('rep-income-a');
  const b = await signupChurch('rep-income-b');

  const member = await db.member.create({ data: { churchId: a.churchId, firstName: 'Kofi', lastName: 'Mensah' } });
  await db.tithe.create({ data: { churchId: a.churchId, memberId: member.id, amount: 100, titheDate: new Date('2026-06-10') } });
  await db.incomeRecord.create({ data: { churchId: a.churchId, transactionDate: new Date('2026-06-11'), category: 'Donation', amount: 50 } });
  await db.harvest.create({ data: { churchId: a.churchId, harvestType: 'ORGANIZATIONAL', harvestName: 'Building Fund Drive', harvestYear: 2026, harvestDate: new Date('2026-06-12'), totalCollected: 200 } });

  const res = await a.client.get('/api/reports/income?start=2026-06-01&end=2026-06-30');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.rows.length, 3);
  const total = res.body.rows.reduce((s, r) => s + r.amount, 0);
  assert.strictEqual(total, 350);
  assert.ok(res.body.byCategory.some((c) => c.category === 'Tithe'));

  const bRes = await b.client.get('/api/reports/income?start=2026-06-01&end=2026-06-30');
  assert.strictEqual(bRes.body.rows.length, 0, 'church B must see none of church A\'s income');
});

test('members/missing: flags members who did not attend the last 3 services, scoped per church', async () => {
  const a = await signupChurch('rep-missing-a');
  const b = await signupChurch('rep-missing-b');

  const faithful = await db.member.create({ data: { churchId: a.churchId, firstName: 'Faithful', lastName: 'Attender', membershipStatus: 'MEMBER' } });
  const absent = await db.member.create({ data: { churchId: a.churchId, firstName: 'Absent', lastName: 'Member', membershipStatus: 'MEMBER' } });
  for (let i = 0; i < 3; i++) {
    const ev = await db.event.create({ data: { churchId: a.churchId, title: `Service ${i}`, eventType: 'SERVICE', startsAt: new Date(`2026-06-0${i + 1}T09:00`) } });
    await db.attendance.create({ data: { churchId: a.churchId, eventId: ev.id, memberId: faithful.id } });
  }

  const res = await a.client.get('/api/reports/members/missing');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.some((m) => m.member_id === absent.id));
  assert.ok(!res.body.some((m) => m.member_id === faithful.id));

  const bRes = await b.client.get('/api/reports/members/missing');
  assert.strictEqual(bRes.body.length, 0, 'church B has no members at all, so none can appear here');
});

test('members/status-summary: pure-Prisma groupBy, scoped per church', async () => {
  const a = await signupChurch('rep-status-a');
  const b = await signupChurch('rep-status-b');
  await db.member.create({ data: { churchId: a.churchId, firstName: 'X', lastName: 'Y', membershipStatus: 'MEMBER' } });
  await db.member.create({ data: { churchId: a.churchId, firstName: 'Z', lastName: 'W', membershipStatus: 'MEMBER' } });
  await db.member.create({ data: { churchId: a.churchId, firstName: 'Q', lastName: 'R', membershipStatus: 'VISITOR' } });

  const res = await a.client.get('/api/reports/members/status-summary');
  assert.strictEqual(res.status, 200);
  const memberRow = res.body.find((r) => r.status === 'MEMBER');
  const visitorRow = res.body.find((r) => r.status === 'VISITOR');
  assert.strictEqual(memberRow.count, 2);
  assert.strictEqual(visitorRow.count, 1);

  const bRes = await b.client.get('/api/reports/members/status-summary');
  assert.strictEqual(bRes.body.length, 0, 'church B has no members, so no status groups at all');
});
