'use strict';
// Phase 9d verification: tithes, special offerings, and standalone
// day-born collections — the first tranche of Finance parity work.
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
    await db.financeReceipt.deleteMany({ where });
    await db.tithe.deleteMany({ where });
    await db.specialOffering.deleteMany({ where });
    await db.dayBornCollection.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.journalLine.deleteMany({ where });
    await db.journalEntry.deleteMany({ where });
    await db.financialPeriod.deleteMany({ where });
    await db.fund.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.member.deleteMany({ where });
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
    async getCsv(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {} });
      remember(res);
      return { status: res.status, contentType: res.headers.get('content-type'), text: await res.text() };
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

test('signup seeds default special offering categories', async () => {
  const { churchId } = await signedInChurch('special-cats-seed');
  const cats = await db.specialCategory.findMany({ where: { churchId } });
  assert.ok(cats.length >= 7);
  assert.ok(cats.some((c) => c.categoryName === 'Building Fund'));
});

test('day-born collection: posts a balanced journal, issues a receipt, appears on the page, exports to CSV', async () => {
  const { client: c, churchId } = await signedInChurch('daybornsflow');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const balanceBefore = await ledger.fundBalance(db, churchId, fund.id);

  const page = await c.getHtml('/finance/day-borns');
  const csrf = csrfOf(page.text);
  const created = await c.postForm('/finance/day-borns', {
    collectionDate: '2026-06-07', dayBorn: 'MONDAY', amount: '150.50', headCount: '12', fundId: String(fund.id), _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);

  const row = await db.dayBornCollection.findFirst({ where: { churchId } });
  assert.ok(row);
  assert.strictEqual(row.dayBorn, 'MONDAY');
  assert.ok(row.receiptNumber);
  assert.ok(row.journalEntryId);

  const receipt = await db.financeReceipt.findFirst({ where: { churchId, sourceType: 'DAY_BORN_COLLECTION', sourceId: row.id } });
  assert.ok(receipt, 'expected a FinanceReceipt row for a day-born collection');

  const balanceAfter = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfter) - Number(balanceBefore), 150.5);

  const listPage = await c.getHtml('/finance/day-borns');
  assert.match(listPage.text, /Monday/);
  assert.match(listPage.text, /150\.50/);

  const csv = await c.getCsv('/finance/day-borns.csv');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.contentType, /text\/csv/);
  assert.match(csv.text, /Monday/);

  // Reverse/archive: journal should net back to zero and the row should soft-delete.
  const csrf2 = csrfOf(listPage.text);
  const deleted = await c.postForm(`/finance/day-borns/${row.id}/delete`, { _csrf: csrf2 });
  assert.strictEqual(deleted.status, 302);
  const balanceAfterReversal = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfterReversal), Number(balanceBefore));
  const reloadedRow = await db.dayBornCollection.findUnique({ where: { id: row.id } });
  assert.ok(reloadedRow.deletedAt);
});

test('special offering: member donor posts to the ledger, no receipt is created (matches original), CSV export works', async () => {
  const { client: c, churchId } = await signedInChurch('specialflow');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-501', firstName: 'Efua', lastName: 'Ansah', membershipStatus: 'MEMBER' } });
  const cat = await db.specialCategory.findFirst({ where: { churchId, categoryName: 'Building Fund' } });
  const balanceBefore = await ledger.fundBalance(db, churchId, fund.id);

  const page = await c.getHtml('/finance/special');
  const csrf = csrfOf(page.text);
  const created = await c.postForm('/finance/special', {
    offeringDate: '2026-06-10', specialCatId: String(cat.id), donorId: String(member.id), amount: '75', purpose: 'Roof repair', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);

  const row = await db.specialOffering.findFirst({ where: { churchId } });
  assert.ok(row);
  assert.ok(row.journalEntryId);
  const receiptCount = await db.financeReceipt.count({ where: { churchId, sourceType: 'SPECIAL_OFFERING', sourceId: row.id } });
  assert.strictEqual(receiptCount, 0, 'special offerings must not create a FinanceReceipt, matching the original');

  const balanceAfter = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfter) - Number(balanceBefore), 75);

  const listPage = await c.getHtml('/finance/special');
  assert.match(listPage.text, /Efua Ansah/);
  assert.match(listPage.text, /Building Fund/);

  const csv = await c.getCsv('/finance/special.csv');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.text, /Efua Ansah/);
});

test('special offering: manual (non-member) donor name is recorded and displayed', async () => {
  const { client: c, churchId } = await signedInChurch('specialmanual');
  await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const cat = await db.specialCategory.findFirst({ where: { churchId, categoryName: 'Thanksgiving' } });

  const page = await c.getHtml('/finance/special');
  const csrf = csrfOf(page.text);
  await c.postForm('/finance/special', {
    offeringDate: '2026-06-11', specialCatId: String(cat.id), donorNameManual: 'Visiting Pastor Mensah', amount: '40', _csrf: csrf,
  });

  const listPage = await c.getHtml('/finance/special');
  assert.match(listPage.text, /Visiting Pastor Mensah/);
});

test('tithe: posts to the ledger, no receipt, filters by member, appears in top tithers, CSV export works', async () => {
  const { client: c, churchId } = await signedInChurch('titheflow');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-601', firstName: 'Kojo', lastName: 'Boadi', membershipStatus: 'MEMBER' } });
  const thisYear = new Date().getFullYear();
  const balanceBefore = await ledger.fundBalance(db, churchId, fund.id);

  const page = await c.getHtml('/finance/tithes');
  const csrf = csrfOf(page.text);
  const created = await c.postForm('/finance/tithes', {
    memberId: String(member.id), titheDate: `${thisYear}-03-15`, amount: '200', method: 'cash', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);

  const row = await db.tithe.findFirst({ where: { churchId } });
  assert.ok(row);
  assert.ok(row.journalEntryId);
  const receiptCount = await db.financeReceipt.count({ where: { churchId, sourceType: 'TITHE', sourceId: row.id } });
  assert.strictEqual(receiptCount, 0, 'tithes must not create a FinanceReceipt, matching the original');

  const balanceAfter = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfter) - Number(balanceBefore), 200);

  const filtered = await c.getHtml(`/finance/tithes?memberId=${member.id}`);
  assert.strictEqual(filtered.status, 200);
  assert.match(filtered.text, /Kojo Boadi/);

  const allPage = await c.getHtml('/finance/tithes');
  assert.match(allPage.text, /Kojo Boadi/); // top tithers YTD table

  const csv = await c.getCsv('/finance/tithes.csv');
  assert.strictEqual(csv.status, 200);
  assert.match(csv.text, /Kojo Boadi/);
});

test('cross-tenant: church B cannot see church A\'s tithes, special offerings, or day-born collections', async () => {
  const { client: cA, churchId: churchA } = await signedInChurch('finance-cross-a');
  const { client: cB, churchId: churchB } = await signedInChurch('finance-cross-b');
  const fundA = await db.fund.create({ data: { churchId: churchA, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const memberA = await db.member.create({ data: { churchId: churchA, externalId: 'MBR-701', firstName: 'Ama', lastName: 'Darko', membershipStatus: 'MEMBER' } });
  const catA = await db.specialCategory.findFirst({ where: { churchId: churchA, categoryName: 'Building Fund' } });

  const pageA = await cA.getHtml('/finance/tithes');
  const csrfA = csrfOf(pageA.text);
  await cA.postForm('/finance/tithes', { memberId: String(memberA.id), titheDate: '2026-06-01', amount: '99', _csrf: csrfA });

  const specialPageA = await cA.getHtml('/finance/special');
  const csrfA2 = csrfOf(specialPageA.text);
  await cA.postForm('/finance/special', { offeringDate: '2026-06-01', specialCatId: String(catA.id), donorNameManual: 'Ama Darko', amount: '55', _csrf: csrfA2 });

  const dbPageA = await cA.getHtml('/finance/day-borns');
  const csrfA3 = csrfOf(dbPageA.text);
  await cA.postForm('/finance/day-borns', { collectionDate: '2026-06-01', dayBorn: 'FRIDAY', amount: '30', fundId: String(fundA.id), _csrf: csrfA3 });

  const tithesB = await cB.getHtml('/finance/tithes');
  assert.doesNotMatch(tithesB.text, /Ama Darko/);
  const specialB = await cB.getHtml('/finance/special');
  assert.doesNotMatch(specialB.text, /Ama Darko/);
  const dayBornsB = await cB.getHtml('/finance/day-borns');
  assert.doesNotMatch(dayBornsB.text, /30\.00/);

  const titheCountB = await db.tithe.count({ where: { churchId: churchB } });
  const specialCountB = await db.specialOffering.count({ where: { churchId: churchB } });
  const dayBornCountB = await db.dayBornCollection.count({ where: { churchId: churchB } });
  assert.strictEqual(titheCountB, 0);
  assert.strictEqual(specialCountB, 0);
  assert.strictEqual(dayBornCountB, 0);
});
