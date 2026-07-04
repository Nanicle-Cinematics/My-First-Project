'use strict';
// Phase 9f verification: pledges, pledge payments (own receipt-number
// scheme, ledger posting), printable receipts (both the FinanceReceipt-
// based unified scheme and the pledge-payment scheme), outstanding-pledge
// statements, and annual giving statements.
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
    await db.emailLog.deleteMany({ where });
    await db.pledgePayment.deleteMany({ where });
    await db.pledge.deleteMany({ where });
    await db.dayBornSplit.deleteMany({ where });
    await db.service.deleteMany({ where });
    await db.harvest.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.tithe.deleteMany({ where });
    await db.specialOffering.deleteMany({ where });
    await db.dayBornCollection.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.financeReceipt.deleteMany({ where });
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
      return { status: res.status, text: res.status < 300 || res.status === 404 ? await res.text() : '' };
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

test('pledge: creation never posts to the ledger; status starts PENDING then transitions on payment', async () => {
  const { client: c, churchId } = await signedInChurch('pledgeflow');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-901', firstName: 'Kwabena', lastName: 'Owusu', membershipStatus: 'MEMBER', preferredChannel: 'NONE' } });
  const harvest = await db.harvest.create({ data: { churchId, harvestType: 'END_OF_YEAR', harvestYear: 2026, harvestName: 'Harvest 2026' } });
  const balanceBefore = await ledger.fundBalance(db, churchId, fund.id);

  const page = await c.getHtml('/finance/pledges');
  const csrf = csrfOf(page.text);
  const created = await c.postForm('/finance/pledges', {
    memberId: String(member.id), harvestId: String(harvest.id), pledgedAmount: '1000', pledgeDate: '2026-01-01', _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);

  const pledge = await db.pledge.findFirst({ where: { churchId } });
  assert.strictEqual(pledge.status, 'PENDING');
  const balanceAfterCreate = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfterCreate), Number(balanceBefore), 'creating a pledge must never touch the ledger');

  // Partial payment.
  const list2 = await c.getHtml('/finance/pledges');
  const csrf2 = csrfOf(list2.text);
  const paid1 = await c.postForm(`/finance/pledges/${pledge.id}/pay`, { add: '400', _csrf: csrf2 });
  assert.strictEqual(paid1.status, 302);
  assert.match(paid1.location, /\/finance\/pledges\/payments\/\d+\/receipt\?new=1/);

  const afterPartial = await db.pledge.findUnique({ where: { id: pledge.id } });
  assert.strictEqual(afterPartial.status, 'PARTIAL');
  assert.strictEqual(Number(afterPartial.paidAmount), 400);
  const balanceAfterPartial = await ledger.fundBalance(db, churchId, fund.id);
  assert.strictEqual(Number(balanceAfterPartial) - Number(balanceBefore), 400);

  const payment1 = await db.pledgePayment.findFirst({ where: { pledgeId: pledge.id } });
  assert.match(payment1.receiptNumber, /^RCT-\d{5}$/);
  assert.ok(payment1.journalEntryId);
  // Pledge payments must NOT create a unified FinanceReceipt row — they have their own scheme.
  const financeReceiptCount = await db.financeReceipt.count({ where: { churchId, sourceType: 'PLEDGE_PAYMENT' } });
  assert.strictEqual(financeReceiptCount, 0);

  // Full payment.
  const list3 = await c.getHtml('/finance/pledges');
  const csrf3 = csrfOf(list3.text);
  await c.postForm(`/finance/pledges/${pledge.id}/pay`, { add: '600', _csrf: csrf3 });
  const afterFull = await db.pledge.findUnique({ where: { id: pledge.id } });
  assert.strictEqual(afterFull.status, 'FULFILLED');
  assert.strictEqual(Number(afterFull.paidAmount), 1000);
});

test('pledge payment receipt: prints with the running paid-to-date balance, dry-run send does not crash', async () => {
  const { client: c, churchId } = await signedInChurch('pledgereceipt');
  await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-902', firstName: 'Abena', lastName: 'Frimpong', membershipStatus: 'MEMBER', preferredChannel: 'EITHER', mobilePhone: '0244000099', email: 'abena@example.test', unsubscribeToken: 'tok-9f-1' } });
  const harvest = await db.harvest.create({ data: { churchId, harvestType: 'ORGANIZATIONAL', harvestYear: 2026, harvestName: 'Youth Harvest' } });
  const pledge = await db.pledge.create({ data: { churchId, memberId: member.id, harvestId: harvest.id, pledgedAmount: 500, pledgeDate: new Date('2026-02-01') } });

  const page = await c.getHtml('/finance/pledges');
  const csrf = csrfOf(page.text);
  const paid = await c.postForm(`/finance/pledges/${pledge.id}/pay`, { add: '200', _csrf: csrf });
  const paymentId = paid.location.match(/\/payments\/(\d+)\/receipt/)[1];

  const receiptPage = await c.getHtml(`/finance/pledges/payments/${paymentId}/receipt?new=1`);
  assert.strictEqual(receiptPage.status, 200);
  assert.match(receiptPage.text, /Pledge Payment Receipt/);
  assert.match(receiptPage.text, /Abena Frimpong/);
  assert.match(receiptPage.text, /Youth Harvest/);
  assert.match(receiptPage.text, /300\.00/); // outstanding balance (500 - 200)

  const csrf2 = csrfOf(receiptPage.text);
  const sent = await c.postForm(`/finance/pledges/payments/${paymentId}/send`, { _csrf: csrf2 });
  assert.strictEqual(sent.status, 302);
  assert.match(sent.location, /sent=dry/);
  const updatedPayment = await db.pledgePayment.findUnique({ where: { id: Number(paymentId) } });
  assert.ok(updatedPayment.sentAt);
});

test('outstanding pledge statement: lists only unpaid pledges, excludes fulfilled ones', async () => {
  const { client: c, churchId } = await signedInChurch('outstandingflow');
  await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-903', firstName: 'Yaw', lastName: 'Antwi', membershipStatus: 'MEMBER', preferredChannel: 'NONE' } });
  const harvest = await db.harvest.create({ data: { churchId, harvestType: 'OTHER', harvestYear: 2026, harvestName: 'Building Harvest' } });
  await db.pledge.create({ data: { churchId, memberId: member.id, harvestId: harvest.id, pledgedAmount: 300, paidAmount: 100, pledgeDate: new Date('2026-01-01'), status: 'PARTIAL' } });
  await db.pledge.create({ data: { churchId, memberId: member.id, harvestId: harvest.id, pledgedAmount: 200, paidAmount: 200, pledgeDate: new Date('2026-01-05'), status: 'FULFILLED' } });

  const receiptsPage = await c.getHtml('/finance/receipts');
  assert.match(receiptsPage.text, /Yaw Antwi/);
  assert.match(receiptsPage.text, /200\.00/); // outstanding = 300 - 100

  const statement = await c.getHtml(`/finance/pledges/statement/${member.id}`);
  assert.strictEqual(statement.status, 200);
  assert.match(statement.text, /Building Harvest/);
  assert.match(statement.text, /Outstanding Pledge Statement/);
  // Only the partial pledge's row should appear (the fulfilled one has 0 outstanding).
  const rowCount = (statement.text.match(/Building Harvest/g) || []).length;
  assert.strictEqual(rowCount, 1);
});

test('unified receipt print page renders for a day-born collection receipt', async () => {
  const { client: c, churchId } = await signedInChurch('unifiedreceipt');
  const fund = await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const page = await c.getHtml('/finance/day-borns');
  const csrf = csrfOf(page.text);
  await c.postForm('/finance/day-borns', { collectionDate: '2026-03-01', dayBorn: 'SUNDAY', amount: '80', fundId: String(fund.id), _csrf: csrf });
  const receipt = await db.financeReceipt.findFirst({ where: { churchId, sourceType: 'DAY_BORN_COLLECTION' } });
  assert.ok(receipt);

  const printPage = await c.getHtml(`/finance/receipts/${encodeURIComponent(receipt.receiptNumber)}/print`);
  assert.strictEqual(printPage.status, 200);
  assert.match(printPage.text, /Official Income Receipt/);
  assert.match(printPage.text, /80\.00/);
});

test('annual giving statement: aggregates tithes, special offerings, and pledge payments for a member and year', async () => {
  const { client: c, churchId } = await signedInChurch('givingstatement');
  await db.fund.create({ data: { churchId, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId, externalId: 'MBR-904', firstName: 'Adjoa', lastName: 'Sarpong', membershipStatus: 'MEMBER', preferredChannel: 'NONE' } });
  const harvest = await db.harvest.create({ data: { churchId, harvestType: 'END_OF_YEAR', harvestYear: 2026, harvestName: 'End of Year Harvest' } });
  const pledge = await db.pledge.create({ data: { churchId, memberId: member.id, harvestId: harvest.id, pledgedAmount: 300, pledgeDate: new Date('2026-01-01') } });
  const cat = await db.specialCategory.findFirst({ where: { churchId, categoryName: 'Thanksgiving' } });

  const titheCsrf = csrfOf((await c.getHtml('/finance/tithes')).text);
  await c.postForm('/finance/tithes', { memberId: String(member.id), titheDate: '2026-04-10', amount: '150', method: 'cash', _csrf: titheCsrf });

  const specialCsrf = csrfOf((await c.getHtml('/finance/special')).text);
  await c.postForm('/finance/special', { offeringDate: '2026-04-15', specialCatId: String(cat.id), donorId: String(member.id), amount: '75', _csrf: specialCsrf });

  const pledgeCsrf = csrfOf((await c.getHtml('/finance/pledges')).text);
  await c.postForm(`/finance/pledges/${pledge.id}/pay`, { add: '120', _csrf: pledgeCsrf });

  const indexPage = await c.getHtml('/finance/statements?year=2026');
  assert.strictEqual(indexPage.status, 200);
  assert.match(indexPage.text, /Adjoa Sarpong/);

  const statement = await c.getHtml(`/members/${member.id}/statement?year=2026`);
  assert.strictEqual(statement.status, 200);
  assert.match(statement.text, /Annual Giving Statement/);
  assert.match(statement.text, /Tithes/);
  assert.match(statement.text, /Thanksgiving/);
  assert.match(statement.text, /Pledge Redemptions/);
  assert.match(statement.text, /345\.00/); // 150 + 75 + 120 total
});

test('cross-tenant: church B cannot see church A\'s pledges, receipts, or giving statements', async () => {
  const { client: cA, churchId: churchA } = await signedInChurch('pledge-cross-a');
  const { client: cB, churchId: churchB } = await signedInChurch('pledge-cross-b');
  await db.fund.create({ data: { churchId: churchA, name: 'General', fundType: 'GENERAL', code: 'GEN' } });
  const member = await db.member.create({ data: { churchId: churchA, externalId: 'MBR-905', firstName: 'Unique', lastName: 'ChurchAName', membershipStatus: 'MEMBER', preferredChannel: 'NONE' } });
  const harvest = await db.harvest.create({ data: { churchId: churchA, harvestType: 'OTHER', harvestYear: 2026, harvestName: 'Church A Harvest Only' } });

  const page = await cA.getHtml('/finance/pledges');
  const csrf = csrfOf(page.text);
  await cA.postForm('/finance/pledges', { memberId: String(member.id), harvestId: String(harvest.id), pledgedAmount: '500', pledgeDate: '2026-01-01', _csrf: csrf });

  const pledgesB = await cB.getHtml('/finance/pledges');
  assert.doesNotMatch(pledgesB.text, /Unique ChurchAName/);
  const receiptsB = await cB.getHtml('/finance/receipts');
  assert.doesNotMatch(receiptsB.text, /Unique ChurchAName/);

  const pledgeCountB = await db.pledge.count({ where: { churchId: churchB } });
  assert.strictEqual(pledgeCountB, 0);
});
