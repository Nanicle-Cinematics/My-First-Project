'use strict';
// New-church signup: creates a Church (tenant) + its first ADMIN user + seeds
// that church's chart of accounts, atomically. Replaces the old single-tenant
// "/setup" first-boot wizard, which assumed "zero users exist" meant "fresh
// install" — that stops being true once many churches share one deployment.
// Mirrors poultry-manager's src/actions/auth.ts signup() (slugify-and-uniquify
// loop) plus a per-church port of lib/ledger.js's seedDefaultAccounts (which
// was previously a single once-at-boot global seed).

const bcrypt = require('bcryptjs');
const { db } = require('./tenant');

// [code, name, accountType, normalBalance, isSystem] — same accounts as
// lib/ledger.js's DEFAULT_ACCOUNTS, ported to run per-church at signup
// instead of once globally at process boot.
const DEFAULT_ACCOUNTS = [
  ['1000', 'Cash in hand', 'ASSET', 'DEBIT', true],
  ['1010', 'Bank deposit clearing', 'ASSET', 'DEBIT', true],
  ['1100', 'Receivables', 'ASSET', 'DEBIT', true],
  ['3000', 'Fund balances', 'FUND_EQUITY', 'CREDIT', true],
  ['4000', 'Tithes', 'INCOME', 'CREDIT', true],
  ['4010', 'Offertory / service collections', 'INCOME', 'CREDIT', true],
  ['4020', 'Day-born offerings', 'INCOME', 'CREDIT', true],
  ['4030', 'Harvest', 'INCOME', 'CREDIT', true],
  ['4040', 'Special offerings', 'INCOME', 'CREDIT', true],
  ['4050', 'Donations', 'INCOME', 'CREDIT', true],
  ['4060', 'Pledges received', 'INCOME', 'CREDIT', true],
  ['4070', 'Event income', 'INCOME', 'CREDIT', false],
  ['4900', 'Other income', 'INCOME', 'CREDIT', false],
  ['5000', 'Utilities', 'EXPENSE', 'DEBIT', false],
  ['5010', 'Administration', 'EXPENSE', 'DEBIT', false],
  ['5020', 'Ministerial support', 'EXPENSE', 'DEBIT', false],
  ['5030', 'Welfare / benevolence', 'EXPENSE', 'DEBIT', false],
  ['5040', 'Repairs and maintenance', 'EXPENSE', 'DEBIT', false],
  ['5050', 'Events and anniversaries', 'EXPENSE', 'DEBIT', false],
  ['5060', 'Music and choir', 'EXPENSE', 'DEBIT', false],
  ['5070', 'Mission and evangelism', 'EXPENSE', 'DEBIT', false],
  ['5080', 'Youth ministry', 'EXPENSE', 'DEBIT', false],
  ['5090', 'Children ministry', 'EXPENSE', 'DEBIT', false],
  ['5100', 'Bank charges', 'EXPENSE', 'DEBIT', false],
  ['5110', 'Equipment', 'EXPENSE', 'DEBIT', false],
  ['5120', 'Stationery and printing', 'EXPENSE', 'DEBIT', false],
  ['5130', 'Transport', 'EXPENSE', 'DEBIT', false],
  ['5140', 'Refreshment', 'EXPENSE', 'DEBIT', false],
  ['5900', 'Other expenses', 'EXPENSE', 'DEBIT', false],
];

// [categoryName, description] — the original seeded these once globally at
// process boot (schema.sql / server.js's insertSpecialCat loop); ported to
// run per-church at signup instead, same as DEFAULT_ACCOUNTS above. Without
// this, a new church's special-offerings form has no categories to pick
// from (there's no category-management UI in the original either).
const DEFAULT_SPECIAL_CATEGORIES = [
  ['Building Fund', 'Church construction / renovation'],
  ['Mission / Outreach', 'Evangelism and outreach work'],
  ['Thanksgiving', 'Thanksgiving offerings'],
  ["Pastor's Appreciation", 'Pastor appreciation offering'],
  ['Welfare / Benevolence', 'Support for members in need'],
  ['Convention / Camp', 'Conventions, camps, conferences'],
  ['Vow / Pledge', 'Personal vows and pledges'],
];

// [typeName] — schema.sql seeded these 5 once globally too (there is no
// service-type management UI in the original either, same "static/seeded
// only" situation as special categories). Ported per-church at signup.
const DEFAULT_SERVICE_TYPES = ['Sunday Service', 'Wednesday Service', 'Friday Service', 'Wedding Service', 'Funeral Service'];

// [categoryName, description] — same "static/seeded only, no management UI"
// situation as special categories/service types above (schema.sql:670-677
// seeded these once globally). Ported per-church at signup for Phase 9g's
// expense/voucher work.
const DEFAULT_EXPENSE_CATEGORIES = [
  ['Utilities', 'Electricity, water, internet'],
  ['Salaries', 'Pastor and staff salaries'],
  ['Maintenance', 'Building and equipment upkeep'],
  ['Office Supplies', 'Stationery, printing'],
  ['Outreach', 'Mission and outreach expenses'],
  ['Welfare', 'Support to members'],
  ['Events', 'Convention, camp, special events'],
];

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'church';
}

class SignupError extends Error {}

/**
 * Create a new church + its first admin user + default chart of accounts.
 * @returns {Promise<{church: object, user: object}>}
 */
async function signupChurch({ churchName, name, email, password }) {
  const cleanEmail = String(email || '').toLowerCase().trim();
  if (!churchName || !String(churchName).trim()) throw new SignupError('Church name is required');
  if (!name || !String(name).trim()) throw new SignupError('Your name is required');
  if (!cleanEmail || !/^\S+@\S+\.\S+$/.test(cleanEmail)) throw new SignupError('Enter a valid email');
  if (!password || String(password).length < 8) throw new SignupError('Password must be at least 8 characters');

  const existing = await db.user.findUnique({ where: { email: cleanEmail } });
  if (existing) throw new SignupError('An account with that email already exists');

  const base = slugify(churchName);
  let slug = base;
  for (let i = 1; await db.church.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;

  const passwordHash = await bcrypt.hash(password, 10);

  // Prisma executes nested relation writes atomically in one database
  // transaction. Keeping provisioning in one request avoids holding an
  // interactive transaction open across several high-latency Neon round
  // trips while preserving all-or-nothing church creation.
  const churchWithUsers = await db.church.create({
    data: {
      name: churchName,
      slug,
      users: { create: {
        username: slugify(name).slice(0, 30) || 'admin',
        email: cleanEmail,
        passwordHash,
        displayName: name,
        role: 'ADMIN',
        financeRole: 'FINANCE_ADMIN',
      } },
      accounts: { createMany: {
        data: DEFAULT_ACCOUNTS.map(([code, accName, accountType, normalBalance, isSystem]) => ({
          code,
          name: accName,
          accountType,
          normalBalance,
          isSystem,
        })),
      } },
      specialCategories: { createMany: {
        data: DEFAULT_SPECIAL_CATEGORIES.map(([categoryName, description]) => ({ categoryName, description })),
      } },
      serviceTypes: { createMany: {
        data: DEFAULT_SERVICE_TYPES.map((typeName) => ({ typeName })),
      } },
      expenseCategories: { createMany: {
        data: DEFAULT_EXPENSE_CATEGORIES.map(([categoryName, description]) => ({ categoryName, description })),
      } },
    },
    include: { users: true },
  });
  const [user] = churchWithUsers.users;
  const { users, ...church } = churchWithUsers;
  return { church, user };
}

module.exports = { signupChurch, SignupError, DEFAULT_ACCOUNTS, DEFAULT_SPECIAL_CATEGORIES, DEFAULT_SERVICE_TYPES, DEFAULT_EXPENSE_CATEGORIES, slugify };
