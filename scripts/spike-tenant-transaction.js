// Throwaway spike (Phase 0): does a Prisma $transaction opened from an
// EXTENDED (tenant-scoped) client still apply the churchId filter inside
// the transaction callback? This is load-bearing for the finance/ledger
// module later, so it must be proven before relying on it with real money.
const { db, tenantDb } = require('../lib/tenant');

async function main() {
  const churchA = await db.church.create({ data: { name: 'Spike Church A', slug: `spike-a-${Date.now()}` } });
  const churchB = await db.church.create({ data: { name: 'Spike Church B', slug: `spike-b-${Date.now()}` } });

  const dbA = tenantDb(churchA.id);
  const dbB = tenantDb(churchB.id);

  // 1. Does create() inside $transaction still get churchId injected?
  const created = await dbA.$transaction(async (tx) => {
    const fund = await tx.fund.create({ data: { name: 'General Fund', fundType: 'GENERAL' } });
    // 2. Does a read INSIDE the same transaction see the scoping (i.e. can
    //    it find its own just-created row without churchId being passed
    //    explicitly)?
    const seenInTx = await tx.fund.findUnique({ where: { id: fund.id } });
    return { fund, seenInTx };
  });

  console.log('Created fund churchId:', created.fund.churchId, '=== churchA.id?', created.fund.churchId === churchA.id);
  console.log('Seen inside tx:', !!created.seenInTx);

  // 3. Cross-tenant isolation: church B's scoped client must NOT see it.
  const fromB = await dbB.fund.findUnique({ where: { id: created.fund.id } });
  console.log('Cross-tenant read from B (should be null):', fromB);

  // 4. Church A's scoped client (fresh, outside the original transaction) must see it.
  const fromA = await dbA.fund.findUnique({ where: { id: created.fund.id } });
  console.log('Same-tenant read from A (should be the fund):', !!fromA);

  // 5. Rollback semantics: throwing inside $transaction should roll back the create.
  let rolledBack = false;
  try {
    await dbA.$transaction(async (tx) => {
      await tx.fund.create({ data: { name: 'Should Not Persist', fundType: 'GENERAL' } });
      throw new Error('force rollback');
    });
  } catch (e) {
    rolledBack = e.message === 'force rollback';
  }
  const shouldBeGone = await dbA.fund.findFirst({ where: { name: 'Should Not Persist' } });
  console.log('Threw to trigger rollback:', rolledBack, '| row absent after rollback:', shouldBeGone === null);

  // Cleanup
  await db.fund.deleteMany({ where: { churchId: { in: [churchA.id, churchB.id] } } });
  await db.church.deleteMany({ where: { id: { in: [churchA.id, churchB.id] } } });
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('SPIKE FAILED:', e);
  await db.$disconnect();
  process.exit(1);
});
