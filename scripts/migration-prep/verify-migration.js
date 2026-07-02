'use strict';
// Phase 7 PREP: verifies a migration run against the staging branch —
// row counts match the SQLite source, circular-FK backfills landed
// correctly, original PKs were preserved, and Postgres sequences were reset
// so a fresh insert after migration doesn't collide with a migrated id.
const path = require('path');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'synthetic-church.db');
const CHURCH_SLUG = process.env.MIGRATE_CHURCH_SLUG || 'dunwell-methodist';

async function main() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const prisma = new PrismaClient();

  const church = await prisma.church.findUnique({ where: { slug: CHURCH_SLUG } });
  assert.ok(church, `Church with slug ${CHURCH_SLUG} not found — did migration run?`);
  const churchId = church.id;
  console.log(`Verifying Church ${churchId} (${CHURCH_SLUG})`);

  const checks = [
    ['users', 'user'], ['members', 'member'], ['ministries', 'ministry'],
    ['organizations', 'organization'], ['organization_memberships', 'organizationMembership'],
    ['events', 'event'], ['attendance', 'attendance'], ['funds', 'fund'],
    ['accounts', 'account'], ['financial_periods', 'financialPeriod'],
    ['journal_entries', 'journalEntry'], ['journal_lines', 'journalLine'],
    ['income_records', 'incomeRecord'],
    ['ministry_memberships', 'ministryMembership'], ['event_rsvps', 'eventRsvp'],
    ['sacraments', 'sacrament'], ['pastoral_notes', 'pastoralNote'], ['welfare_cases', 'welfareCase'],
    ['contributions', 'contribution'], ['announcements', 'announcement'], ['broadcasts', 'broadcast'],
    ['broadcast_recipients', 'broadcastRecipient'], ['activity_log', 'activityLog'],
    ['security_audit_log', 'securityAuditLog'], ['error_log', 'errorLog'], ['app_state', 'appState'],
    ['email_settings', 'emailSetting'], ['email_logs', 'emailLog'], ['password_reset_tokens', 'passwordResetToken'],
    ['preaching_plan', 'preachingPlan'], ['inventory_items', 'inventoryItem'], ['inventory_categories', 'inventoryCategory'],
    ['finance_settings', 'financeSetting'], ['expense_categories', 'expenseCategory'],
    ['finance_projects', 'financeProject'], ['expenses', 'expense'], ['payment_vouchers', 'paymentVoucher'],
    ['finance_budgets', 'financeBudget'], ['finance_budget_lines', 'financeBudgetLine'],
    ['day_born_collections', 'dayBornCollection'], ['finance_receipts', 'financeReceipt'], ['tithes', 'tithe'],
    ['service_types', 'serviceType'], ['services', 'service'], ['harvests', 'harvest'],
    ['day_born_splits', 'dayBornSplit'], ['special_categories', 'specialCategory'],
    ['special_offerings', 'specialOffering'], ['pledges', 'pledge'], ['pledge_payments', 'pledgePayment'],
  ];
  let allMatch = true;
  for (const [sqliteTable, prismaModel] of checks) {
    const sourceCount = sqlite.prepare(`SELECT COUNT(*) c FROM ${sqliteTable}`).get().c;
    const destCount = await prisma[prismaModel].count({ where: { churchId } });
    const ok = sourceCount === destCount;
    if (!ok) allMatch = false;
    console.log(`  ${sqliteTable}: source=${sourceCount} dest=${destCount} ${ok ? 'OK' : 'MISMATCH'}`);
  }
  assert.ok(allMatch, 'row count mismatch somewhere — see above');

  // Circular-FK backfills.
  const sourceMembers = sqlite.prepare(`SELECT member_id, bible_class_id FROM members WHERE bible_class_id IS NOT NULL`).all();
  for (const m of sourceMembers) {
    const destMember = await prisma.member.findFirst({ where: { churchId, id: m.member_id } });
    assert.strictEqual(destMember.bibleClassId, m.bible_class_id, `member ${m.member_id} bibleClassId not backfilled`);
  }
  console.log(`  members.bibleClassId backfill: OK (${sourceMembers.length} checked)`);

  const sourceMinistries = sqlite.prepare(`SELECT ministry_id, org_id FROM ministries WHERE org_id IS NOT NULL`).all();
  for (const mn of sourceMinistries) {
    const destMinistry = await prisma.ministry.findFirst({ where: { churchId, id: mn.ministry_id } });
    assert.strictEqual(destMinistry.orgId, mn.org_id, `ministry ${mn.ministry_id} orgId not backfilled`);
  }
  console.log(`  ministries.orgId backfill: OK (${sourceMinistries.length} checked)`);

  // Ledger integrity: every migrated journal entry's lines must still balance.
  const entries = await prisma.journalEntry.findMany({ where: { churchId }, include: { lines: true } });
  for (const e of entries) {
    const debit = e.lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = e.lines.reduce((s, l) => s + Number(l.credit), 0);
    assert.strictEqual(Math.round(debit * 100), Math.round(credit * 100), `journal entry ${e.id} (${e.entryNo}) is unbalanced after migration`);
  }
  console.log(`  journal entry balance integrity: OK (${entries.length} entries checked)`);

  // Fund balance sanity: opening balance + net of migrated journal lines.
  const funds = await prisma.fund.findMany({ where: { churchId } });
  for (const f of funds) {
    const lines = await prisma.journalLine.findMany({ where: { churchId, fundId: f.id }, include: { account: true } });
    let balance = Number(f.openingBalance);
    for (const l of lines) {
      if (l.account.accountType === 'INCOME') balance += Number(l.credit) - Number(l.debit);
      if (l.account.accountType === 'EXPENSE') balance -= Number(l.debit) - Number(l.credit);
    }
    console.log(`  fund "${f.name}" balance after migration: ${balance.toFixed(2)}`);
  }

  // Sequence reset: a NEW member created after migration must get a fresh id,
  // not collide with (or predate) the highest migrated member id.
  const maxMigratedMemberId = Math.max(...sqlite.prepare(`SELECT member_id FROM members`).all().map((r) => r.member_id));
  const fresh = await prisma.member.create({ data: { churchId, firstName: 'Fresh', lastName: 'Insert' } });
  assert.ok(fresh.id > maxMigratedMemberId, `new member id ${fresh.id} did not advance past migrated max ${maxMigratedMemberId} — sequence reset failed`);
  console.log(`  sequence reset: OK (new member id ${fresh.id} > migrated max ${maxMigratedMemberId})`);
  await prisma.member.delete({ where: { id: fresh.id } }); // clean up the probe row

  console.log('\nAll checks passed.');
  sqlite.close();
  await prisma.$disconnect();
}

main().catch((e) => { console.error('VERIFICATION FAILED:', e.message); process.exit(1); });
