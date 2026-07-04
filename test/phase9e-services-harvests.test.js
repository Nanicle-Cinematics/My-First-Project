'use strict';
// Phase 9e verification: service types (seeded at signup), services, and
// harvests — including the shared DayBornSplit table pattern.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');
const ledger = require('../lib/ledger-pg');

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
    await db.activityLog.deleteMany({ where });
    await db.pledge.deleteMany({ where });
    await db.dayBornSplit.deleteMany({ where });
    await db.service.deleteMany({ where });
    await db.harvest.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.fund.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.member.deleteMany({ where });
    await db.organization.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
  await pool.end();
});

function client() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async postJson(p, jsonBody) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(jsonBody) });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async getHtml(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, text: res.status < 300 ? await res.text() : '' };
    },
    async postForm(p, form) {
      const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(form).toString(), redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}
function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}
async function signedInChurch(tag) {
  const c = client();
  const signup = await c.postJson('/signup', { churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'password123' });
  assert.strictEqual(signup.status, 201);
  createdChurchIds.push(signup.body.church.id);
  return { client: c, churchId: signup.body.church.id };
}
function csrfOf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  return m ? m[1] : null;
}

test('signup seeds default service types', async () => {
  const { churchId } = await signedInChurch('svctypes-seed');
  const types = await db.serviceType.findMany({ where: { churchId } });
  assert.strictEqual(types.length, 5);
  assert.ok(types.some((t) => t.typeName === 'Sunday Service'));
});

test('service: posts to the ledger, day-born splits are saved and editable, splits never touch the ledger, archive reverses', async () => {
  const { client: c, churchId } = await signedInChurch('serviceflow');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const svcType = await db.serviceType.findFirst({ where: { churchId, typeName: 'Sunday Service' } });
  const balanceBefore = await ledger.fundBalance(db, churchId, fund.id);

  const page = await c.getHtml('/finance/services');
  const csrf = csrfOf(page.text);
  const created = await c.postForm('/finance/services', {
    serviceDate: '2026-06-14', serviceTypeId: String(svcType.id), totalAmount: '500',
    day_SUNDAY_amount: '300', day_SUNDAY_heads: '40', day_MONDAY_amount: '200', day_MONDAY_heads: '10',
    _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);
  const serviceId = created.location.match(/\/finance\/services\/(\d+)/)[1];

  const service = await db.service.findUnique({ where: { id: Number(serviceId) } });
  assert.ok(service.journalEntryId);
  const balanceAfter = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfter) - Number(balanceBefore), 500);

  const splits = await db.dayBornSplit.findMany({ where: { serviceId: Number(serviceId) } });
  assert.strictEqual(splits.length, 2);
  assert.ok(splits.every((s) => s.serviceId === Number(serviceId) && s.harvestId === null));

  // Splits sum (500) happens to equal the total here, but replacing them
  // with a DIFFERENT sum must not touch the already-posted journal at all.
  const detail = await c.getHtml(`/finance/services/${serviceId}`);
  const csrf2 = csrfOf(detail.text);
  await c.postForm(`/finance/services/${serviceId}/splits`, {
    day_SUNDAY_amount: '999', day_SUNDAY_heads: '5', _csrf: csrf2,
  });
  const balanceAfterSplitEdit = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfterSplitEdit), Number(balanceAfter), 'editing splits must never touch the ledger');
  const newSplits = await db.dayBornSplit.findMany({ where: { serviceId: Number(serviceId) } });
  assert.strictEqual(newSplits.length, 1, 'splits update is a wholesale replace, not a merge');
  assert.strictEqual(Number(newSplits[0].amount), 999);

  const detail2 = await c.getHtml(`/finance/services/${serviceId}`);
  const csrf3 = csrfOf(detail2.text);
  const archived = await c.postForm(`/finance/services/${serviceId}/delete`, { _csrf: csrf3 });
  assert.strictEqual(archived.status, 302);
  const balanceAfterArchive = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfterArchive), Number(balanceBefore));
});

test('harvest: posts to the ledger with the year-fallback date, day-born splits work the same as services, read-only pledges section renders', async () => {
  const { client: c, churchId } = await signedInChurch('harvestflow');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-801', firstName: 'Nana', lastName: 'Adjei', membershipStatus: 'MEMBER' } });
  const balanceBefore = await ledger.fundBalance(db, churchId, fund.id);

  const page = await c.getHtml('/finance/harvests');
  const csrf = csrfOf(page.text);
  const created = await c.postForm('/finance/harvests', {
    harvestType: 'END_OF_YEAR', harvestYear: '2026', harvestName: 'End of Year Harvest 2026',
    harvestDate: '2026-12-20', totalCollected: '1200', theme: 'New Beginnings', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);
  const harvestId = created.location.match(/\/finance\/harvests\/(\d+)/)[1];

  const harvest = await db.harvest.findUnique({ where: { id: Number(harvestId) } });
  assert.ok(harvest.journalEntryId);
  const balanceAfter = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfter) - Number(balanceBefore), 1200);

  const detail = await c.getHtml(`/finance/harvests/${harvestId}`);
  const csrf2 = csrfOf(detail.text);
  await c.postForm(`/finance/harvests/${harvestId}/splits`, { day_FRIDAY_amount: '400', day_FRIDAY_heads: '20', _csrf: csrf2 });
  const splits = await db.dayBornSplit.findMany({ where: { harvestId: Number(harvestId) } });
  assert.strictEqual(splits.length, 1);
  assert.ok(splits[0].harvestId === Number(harvestId) && splits[0].serviceId === null);

  // Read-only pledge display — create a Pledge directly (Phase 9f UI doesn't exist yet)
  // and confirm the harvest detail page surfaces it without any create/pay UI of its own.
  await db.pledge.create({ data: { churchId, memberId: member.id, harvestId: Number(harvestId), pledgedAmount: 300, paidAmount: 100, pledgeDate: new Date('2026-06-01') } });
  const detailWithPledge = await c.getHtml(`/finance/harvests/${harvestId}`);
  assert.match(detailWithPledge.text, /Nana Adjei/);
  assert.doesNotMatch(detailWithPledge.text, /action="\/finance\/pledges"/);
});

test('harvest: invalid harvestType is rejected with a friendly flash, not a raw 500', async () => {
  const { client: c } = await signedInChurch('harvest-badtype');
  const page = await c.getHtml('/finance/harvests');
  const csrf = csrfOf(page.text);
  const res = await c.postForm('/finance/harvests', { harvestType: 'NOT_A_REAL_TYPE', harvestYear: '2026', harvestName: 'Bad Type Test', _csrf: csrf });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.location, '/finance/harvests');
});

test('cross-tenant: church B cannot see church A\'s services or harvests', async () => {
  const { client: cA, churchId: churchA } = await signedInChurch('svc-cross-a');
  const { client: cB } = await signedInChurch('svc-cross-b');
  const svcType = await db.serviceType.findFirst({ where: { churchId: churchA } });

  const svcPage = await cA.getHtml('/finance/services');
  const csrf = csrfOf(svcPage.text);
  await cA.postForm('/finance/services', { serviceDate: '2026-06-01', serviceTypeId: String(svcType.id), totalAmount: '123', _csrf: csrf });

  const harvestPage = await cA.getHtml('/finance/harvests');
  const csrf2 = csrfOf(harvestPage.text);
  await cA.postForm('/finance/harvests', { harvestType: 'OTHER', harvestYear: '2026', harvestName: 'Church A Only Harvest', totalCollected: '0', _csrf: csrf2 });

  const svcB = await cB.getHtml('/finance/services');
  assert.doesNotMatch(svcB.text, /123\.00/);
  const harvestB = await cB.getHtml('/finance/harvests');
  assert.doesNotMatch(harvestB.text, /Church A Only Harvest/);
});
