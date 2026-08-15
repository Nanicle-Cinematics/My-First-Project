'use strict';
// Phase 8e: HTML port of routes/finance.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/finance.js (JSON at /api/finance/..., this
// is the bare-path HTML surface).
//
// SCOPE matches routes-pg/finance.js: chart of accounts (read-only), funds
// CRUD, generic income record + reversal, expense record (submitted, then
// approved-and-paid by a fund manager other than the recorder), journal
// entry detail + manual reversal, financial period lock/unlock (unlock is
// admin-only, with a mandatory reason), (Phase 9d) tithes/special
// offerings/standalone day-born collections with CSV exports (a NEW
// convention — no CSV export existed anywhere in the new stack before
// this; see the small csvEscape/sendCsv helpers below, copied from the
// original's routes/finance.js:318-326 pattern since nothing shared exists
// to import), (Phase 9e) services/harvests with the shared DayBornSplit
// table, and (Phase 9f) pledges/pledge-payments/printable receipts/giving
// statements — pledge creation/edit never touch the ledger (only payments
// do), pledge payments get their OWN independent receipt-number scheme
// (RCT-##### off the payment id, stored on PledgePayment.receiptNumber),
// separate from the FinanceReceipt-based scheme used by generic income/
// day-borns — matches the original's real (slightly inconsistent) design,
// not a cleaned-up version. STILL DEFERRED: vouchers/budgets/projects/
// settings UI.

const asyncHandler = require('../lib/async-handler');
const { esc, fmtMoney, fmtOutstanding, todayISO, isMoneyPositive, isMoneyNonNeg, isValidDate, DAYS_OF_WEEK } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const ledger = require('../lib/ledger-pg');
const { sendSmsBatch, sendEmailEach, normalizePhoneGH } = require('../lib/delivery');
const { amountInWords } = require('../lib/money');
const { icon } = require('../lib/icons');

function requireFinanceWrite(req, res, next) {
  const u = res.locals.user;
  if (u && (u.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(u.financeRole))) return next();
  return res.status(403).send('Forbidden');
}
function requireFundManager(req, res, next) {
  const u = res.locals.user;
  if (u && (u.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(u.financeRole))) return next();
  return res.status(403).send('Forbidden');
}
function requireFinanceReportAccess(req, res, next) {
  const u = res.locals.user;
  if (!u) return res.redirect('/login');
  if (u && (u.role === 'ADMIN' || (u.financeRole && u.financeRole !== 'NONE'))) return next();
  return res.status(403).send('Finance access required');
}
// Reopening a closed accounting period is more sensitive than closing one —
// it allows backdated postings into a period that was already reviewed and
// signed off. Deliberately narrower than requireFundManager (which TREASURER
// also passes): only the church owner should be able to do this.
function requirePeriodReopenAccess(req, res, next) {
  const u = res.locals.user;
  if (u && u.role === 'ADMIN') return next();
  return res.status(403).send('Only an admin can reopen a closed period');
}

const INCOME_CATEGORIES = [
  ['donation', 'Donation'], ['event', 'Event income'], ['rent', 'Facility rental'],
  ['bookshop', 'Bookshop / materials'], ['welfare_refund', 'Welfare refund'], ['other', 'Other income'],
];
function incomeCategoryOptions(selected) {
  return INCOME_CATEGORIES.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');
}
function incomeCategoryLabel(value) {
  const found = INCOME_CATEGORIES.find((r) => r[0] === value);
  return found ? found[1] : String(value || 'Other income');
}
const PAYMENT_METHODS = ['Cash', 'Mobile Money', 'Bank Transfer', 'Cheque', 'Card', 'Other'];
function paymentMethodOptions(selected) {
  return PAYMENT_METHODS.map((m) => `<option ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('');
}
const FUND_TYPES = ['GENERAL', 'BUILDING', 'WELFARE', 'MISSION', 'HARVEST', 'ANNIVERSARY', 'YOUTH', 'MUSIC', 'CHILDREN', 'PROJECT', 'RESTRICTED_DONATION'];
function fundTypeOptions(selected) {
  return FUND_TYPES.map((t) => `<option value="${t}" ${t === selected ? 'selected' : ''}>${esc(t.replace(/_/g, ' '))}</option>`).join('');
}

async function defaultFundId(db) {
  const fund = await db.fund.findFirst({ where: { active: true }, orderBy: { id: 'asc' } });
  return fund ? fund.id : null;
}

// tenantDb's Prisma extension only stamps churchId onto a create's own row —
// it never validates a client-supplied foreign-key id (fundId, memberId,
// harvestId, projectId, ...) embedded in that row's data. Every such id must
// be checked explicitly through the scoped client first, or a cross-tenant
// id in the request body would silently attach this church's records to
// another church's fund/member/harvest/project.
async function checkFundId(db, bodyFundId) {
  if (!bodyFundId) return { ok: true, fundId: null };
  const fund = await db.fund.findUnique({ where: { id: Number(bodyFundId) } });
  return fund ? { ok: true, fundId: fund.id } : { ok: false, fundId: null };
}

/** Same tenant-validation as checkFundId, for the Expense.projectId reference. */
async function checkProjectId(db, bodyProjectId) {
  if (!bodyProjectId) return { ok: true, projectId: null };
  const project = await db.financeProject.findUnique({ where: { id: Number(bodyProjectId) } });
  return project ? { ok: true, projectId: project.id } : { ok: false, projectId: null };
}

/** Same tenant-validation as checkFundId, for Pledge.memberId/harvestId (both required, not optional). */
async function checkPledgeRefs(db, bodyMemberId, bodyHarvestId) {
  const [member, harvest] = await Promise.all([
    db.member.findUnique({ where: { id: Number(bodyMemberId) } }),
    db.harvest.findUnique({ where: { id: Number(bodyHarvestId) } }),
  ]);
  return { ok: Boolean(member && harvest) };
}

/** Same tenant-validation as checkFundId, for SpecialOffering.donorId. */
async function checkDonorId(db, bodyDonorId) {
  if (!bodyDonorId) return { ok: true, donorId: null };
  const member = await db.member.findUnique({ where: { id: Number(bodyDonorId) } });
  return member ? { ok: true, donorId: member.id } : { ok: false, donorId: null };
}

/** Same tenant-validation as checkFundId, for Service.serviceTypeId (required, not optional). */
async function checkServiceTypeId(db, bodyServiceTypeId) {
  const serviceType = await db.serviceType.findUnique({ where: { id: Number(bodyServiceTypeId) } });
  return serviceType ? { ok: true, serviceTypeId: serviceType.id } : { ok: false, serviceTypeId: null };
}

/** Same tenant-validation as checkFundId, for Harvest.orgId. */
async function checkOrgId(db, bodyOrgId) {
  if (!bodyOrgId) return { ok: true, orgId: null };
  const org = await db.organization.findUnique({ where: { id: Number(bodyOrgId) } });
  return org ? { ok: true, orgId: org.id } : { ok: false, orgId: null };
}

/** Same tenant-validation as checkFundId, for FinanceBudgetLine.accountId. */
async function checkAccountId(db, bodyAccountId) {
  if (!bodyAccountId) return { ok: true, accountId: null };
  const account = await db.account.findUnique({ where: { id: Number(bodyAccountId) } });
  return account ? { ok: true, accountId: account.id } : { ok: false, accountId: null };
}

async function fundOptions(db, selected, includeBlank = true) {
  const funds = await db.fund.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  const options = includeBlank ? ['<option value="">General fund</option>'] : [];
  for (const f of funds) {
    const label = `${f.code ? f.code + ' · ' : ''}${f.name}`;
    options.push(`<option value="${f.id}" ${Number(selected) === f.id ? 'selected' : ''}>${esc(label)}</option>`);
  }
  return options.join('');
}
async function memberOptions(db) {
  const members = await db.member.findMany({ where: { deletedAt: null }, orderBy: { lastName: 'asc' }, select: { id: true, firstName: true, lastName: true, externalId: true } });
  return '<option value="">Non-member / anonymous</option>' +
    members.map((m) => `<option value="${m.id}">${esc(m.firstName + ' ' + m.lastName)}${m.externalId ? ' · ' + esc(m.externalId) : ''}</option>`).join('');
}

async function nextReceiptNo(db, dateStr) {
  const settings = await db.financeSetting.findFirst();
  const prefix = (settings && settings.receiptPrefix) || 'RCT';
  const year = String(dateStr || new Date().toISOString()).slice(0, 4);
  const base = `${prefix}-${year}-`;
  const last = await db.financeReceipt.findFirst({ where: { receiptNumber: { startsWith: base } }, orderBy: { receiptNumber: 'desc' } });
  const next = last ? Number(String(last.receiptNumber).slice(base.length)) + 1 : 1;
  return `${base}${String(next).padStart(5, '0')}`;
}

// Same shape as nextReceiptNo, but 4-digit padding and its own prefix
// (FinanceSetting.voucherPrefix, default 'PV') — a completely independent
// numbering scheme from receipts, matching the original.
async function nextVoucherNo(db, dateStr) {
  const settings = await db.financeSetting.findFirst();
  const prefix = (settings && settings.voucherPrefix) || 'PV';
  const year = String(dateStr || new Date().toISOString()).slice(0, 4);
  const base = `${prefix}-${year}-`;
  const last = await db.paymentVoucher.findFirst({ where: { voucherNo: { startsWith: base } }, orderBy: { voucherNo: 'desc' } });
  const next = last ? Number(String(last.voucherNo).slice(base.length)) + 1 : 1;
  return `${base}${String(next).padStart(4, '0')}`;
}

// Vouchers are 100% derived from expenses — never independently created.
// Direct port of the original's syncExpenseVoucher(): find-or-create,
// re-deriving fields from the (already-updated) expense row every time.
async function syncExpenseVoucher(db, expense, userId) {
  const existing = await db.paymentVoucher.findFirst({ where: { expenseId: expense.id } });
  const fields = {
    voucherDate: expense.spentOn, amountInWords: amountInWords(expense.amount), supportingDocRef: expense.referenceNumber || null,
    approvedBy: expense.approvedBy || null, paidBy: userId, receivedBy: expense.paidTo || null, notes: expense.description || null,
  };
  if (existing) {
    await db.paymentVoucher.update({ where: { id: existing.id }, data: fields });
  } else {
    await db.paymentVoucher.create({ data: { ...fields, voucherNo: await nextVoucherNo(db, expense.spentOn.toISOString().slice(0, 10)), expenseId: expense.id, preparedBy: userId } });
  }
}

// ---------- Finance projects ----------
const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
const PROJECT_STATUS_LABELS = { PLANNING: 'Planning', ACTIVE: 'Active', ON_HOLD: 'On hold', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
function projectStatusOptions(selected) {
  return PROJECT_STATUSES.map((s) => `<option value="${s}" ${s === selected ? 'selected' : ''}>${esc(PROJECT_STATUS_LABELS[s])}</option>`).join('');
}
// Only PLANNING/ACTIVE/ON_HOLD projects are offered on expense/income forms
// — matches the original's projectOptions(), which excludes
// COMPLETED/CANCELLED from the picker.
async function projectOptions(db, selected) {
  const projects = await db.financeProject.findMany({ where: { status: { in: ['PLANNING', 'ACTIVE', 'ON_HOLD'] } }, orderBy: { name: 'asc' } });
  return '<option value="">— no project —</option>' + projects.map((p) => `<option value="${p.id}" ${Number(selected) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}
async function projectFinanceRow(db, churchId, project) {
  let raised = 0, spent = 0;
  if (project.fundId) {
    const rs = await ledger.fundRaisedSpent(db, churchId, project.fundId);
    raised = rs.raised; spent = rs.spent;
  } else {
    const agg = await db.expense.aggregate({ where: { projectId: project.id, approvalStatus: 'PAID' }, _sum: { amount: true } });
    spent = agg._sum.amount || 0;
  }
  const pct = project.targetAmount > 0 ? Math.min(100, Math.round((raised / project.targetAmount) * 100)) : 0;
  return { raised, spent, balance: raised - spent, pct };
}

// ---------- Finance budgets ----------
const BUDGET_LINE_TYPES = ['INCOME', 'EXPENSE'];
async function accountOptionsForBudget(db, accountType, selected) {
  const accounts = await db.account.findMany({ where: { active: true, accountType }, orderBy: { code: 'asc' } });
  return '<option value="">— all accounts —</option>' + accounts.map((a) => `<option value="${a.id}" ${Number(selected) === a.id ? 'selected' : ''}>${esc(a.code + ' · ' + a.name)}</option>`).join('');
}

const DAY_BORN_VALUES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
function dayBornLabel(v) { return String(v || '').charAt(0) + String(v || '').slice(1).toLowerCase(); }

// Required-member picker (no "anonymous" option) — tithes always belong to
// a specific member, unlike generic income's optional memberOptions().
async function requiredMemberOptions(db, selected) {
  const members = await db.member.findMany({ where: { deletedAt: null }, orderBy: { lastName: 'asc' }, select: { id: true, firstName: true, lastName: true, externalId: true } });
  return members.map((m) => `<option value="${m.id}" ${Number(selected) === m.id ? 'selected' : ''}>${esc(m.firstName + ' ' + m.lastName)}${m.externalId ? ' · ' + esc(m.externalId) : ''}</option>`).join('');
}
async function specialCategoryOptions(db, selected) {
  const cats = await db.specialCategory.findMany({ where: { isActive: true }, orderBy: { categoryName: 'asc' } });
  return cats.map((c) => `<option value="${c.id}" ${Number(selected) === c.id ? 'selected' : ''}>${esc(c.categoryName)}</option>`).join('');
}
async function serviceTypeOptions(db, selected) {
  const types = await db.serviceType.findMany({ where: { isActive: true }, orderBy: { typeName: 'asc' } });
  return types.map((t) => `<option value="${t.id}" ${Number(selected) === t.id ? 'selected' : ''}>${esc(t.typeName)}</option>`).join('');
}
async function orgOptions(db, selected) {
  const orgs = await db.organization.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  return '<option value="">— church-wide —</option>' +
    orgs.map((o) => `<option value="${o.id}" ${Number(selected) === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
}

const HARVEST_TYPES = ['ORGANIZATIONAL', 'END_OF_YEAR', 'OTHER'];
const HARVEST_TYPE_LABELS = { ORGANIZATIONAL: 'Organizational', END_OF_YEAR: 'End-of-Year', OTHER: 'Other' };
function harvestTypeOptions(selected) {
  return HARVEST_TYPES.map((t) => `<option value="${t}" ${t === selected ? 'selected' : ''}>${esc(HARVEST_TYPE_LABELS[t])}</option>`).join('');
}

// Shared day-born-split grid, used by both Services and Harvests — direct
// port of the original's parseDayBornInputs()/dayBornFormInputs(). Splits
// are purely descriptive (never separately posted to the ledger, never
// validated against the parent record's total — confirmed against the
// original; the single postCashIncome call for the record's own total is
// the only ledger interaction). DayBornSplit has no DB-level constraint
// enforcing "exactly one of serviceId/harvestId" (unlike the original's
// SQLite CHECK, not carried into schema.prisma) — callers here always
// pass exactly one and never both.
function parseDayBornSplitInputs(b) {
  return DAY_BORN_VALUES
    .map((day) => ({ dayBorn: day, amount: Number(b[`day_${day}_amount`] || 0), headCount: Number(b[`day_${day}_heads`] || 0) }))
    .filter((r) => r.amount > 0 || r.headCount > 0);
}
function dayBornSplitFormInputs(splitsByDay) {
  return `<div class="day-born-grid">${DAY_BORN_VALUES.map((day) => `
    <div class="db-cell">
      <div class="db-day">${esc(dayBornLabel(day))}</div>
      <label>Amount<input type="number" step="0.01" min="0" name="day_${day}_amount" value="${(splitsByDay[day] && splitsByDay[day].amount) || ''}"></label>
      <label>Heads<input type="number" min="0" name="day_${day}_heads" value="${(splitsByDay[day] && splitsByDay[day].headCount) || ''}"></label>
    </div>`).join('')}</div>`;
}

// ---------- Pledges / receipts / statements (Phase 9f) ----------
async function harvestSelectOptions(db, selected) {
  const harvests = await db.harvest.findMany({ where: { deletedAt: null }, orderBy: { harvestYear: 'desc' } });
  return harvests.map((h) => `<option value="${h.id}" ${Number(selected) === h.id ? 'selected' : ''}>${esc(h.harvestName)}</option>`).join('');
}
function pledgeStatusFor(pledged, paid) {
  return paid <= 0 ? 'PENDING' : paid >= pledged ? 'FULFILLED' : 'PARTIAL';
}
// Pledge payments get their own independent receipt-number scheme
// (RCT-##### off the payment's own id) — NOT the same as nextReceiptNo()/
// FinanceReceipt used by generic income and day-borns. Matches the
// original exactly (see routes-pg-html/finance.js module header note).
function pledgePaymentReceiptNo(paymentId) {
  return 'RCT-' + String(paymentId).padStart(5, '0');
}
// Records a payment toward a pledge: a new PledgePayment row with its own
// receipt number, bumps the pledge's paidAmount/status, posts to the
// ledger. Sequential awaits, not a hard $transaction wrapper — matches
// this file's established convention for other multi-step postCashIncome
// flows (postCashIncome already wraps its own posting in a transaction).
async function recordPledgePayment(db, churchId, pledgeId, amount, paidOn, userId) {
  const pledge = await db.pledge.findFirst({ where: { id: pledgeId }, include: { harvest: { select: { harvestName: true } } } });
  if (!pledge) return null;
  const payment = await db.pledgePayment.create({ data: { pledgeId, amount, paidOn: new Date(paidOn), receiptNumber: '', recordedBy: userId } });
  const receiptNumber = pledgePaymentReceiptNo(payment.id);
  await db.pledgePayment.update({ where: { id: payment.id }, data: { receiptNumber } });
  const newPaid = Number(pledge.paidAmount) + amount;
  const status = newPaid >= Number(pledge.pledgedAmount) ? 'FULFILLED' : 'PARTIAL';
  await db.pledge.update({ where: { id: pledgeId }, data: { paidAmount: newPaid, status } });
  const entryId = await ledger.postCashIncome(db, churchId, {
    date: paidOn, amount, incomeAccount: ledger.ACC.PLEDGES, fundId: await defaultFundId(db),
    sourceType: 'PLEDGE_PAYMENT', sourceId: payment.id, createdBy: userId,
    memo: `${(pledge.harvest && pledge.harvest.harvestName) || 'Harvest'} pledge payment ${receiptNumber}`,
  });
  await db.pledgePayment.update({ where: { id: payment.id }, data: { journalEntryId: entryId } });
  return { paymentId: payment.id, receiptNumber };
}
// One payment receipt, with the running balance as of that payment so
// reprints stay stable even after later payments.
async function loadPaymentReceipt(db, paymentId) {
  const pay = await db.pledgePayment.findFirst({
    where: { id: paymentId },
    include: { pledge: { include: { member: true, harvest: { select: { harvestName: true, harvestYear: true } } } } },
  });
  if (!pay) return null;
  const priorSum = await db.pledgePayment.aggregate({ where: { pledgeId: pay.pledgeId, id: { lte: pay.id } }, _sum: { amount: true } });
  const recorder = pay.recordedBy ? await db.user.findFirst({ where: { id: pay.recordedBy }, select: { displayName: true } }) : null;
  return { ...pay, paidToDate: priorSum._sum.amount || 0, recordedByName: (recorder && recorder.displayName) || '—' };
}
// Members who still owe on at least one (non-cancelled) pledge.
async function membersWithOutstanding(db) {
  const pledges = await db.pledge.findMany({ where: { status: { not: 'CANCELLED' } }, include: { member: { select: { id: true, firstName: true, lastName: true, deletedAt: true } } } });
  const byMember = new Map();
  for (const p of pledges) {
    if (p.member.deletedAt) continue;
    const outstanding = Number(p.pledgedAmount) - Number(p.paidAmount);
    if (outstanding <= 0.005) continue;
    const cur = byMember.get(p.memberId) || { memberId: p.memberId, name: `${p.member.firstName} ${p.member.lastName}`, pledged: 0, paid: 0, outstanding: 0, pledgeCount: 0 };
    cur.pledged += Number(p.pledgedAmount); cur.paid += Number(p.paidAmount); cur.outstanding += outstanding; cur.pledgeCount++;
    byMember.set(p.memberId, cur);
  }
  return [...byMember.values()].sort((a, b) => b.outstanding - a.outstanding);
}
// A member's still-outstanding pledges, for the statement.
async function memberOutstandingDetail(db, memberId) {
  const member = await db.member.findFirst({ where: { id: memberId, deletedAt: null } });
  if (!member) return null;
  const allPledges = await db.pledge.findMany({ where: { memberId, status: { not: 'CANCELLED' } }, include: { harvest: { select: { harvestName: true, harvestYear: true } } }, orderBy: { pledgeDate: 'asc' } });
  const pledges = allPledges.filter((p) => Number(p.pledgedAmount) - Number(p.paidAmount) > 0.005);
  return { member, pledges };
}
// Sends a message to a member over the channel(s) their preference allows —
// direct port of the original's sendMemberMessage(), using Phase 9a's
// lib/delivery.js instead of the old SQLite-era sendSmsBatch/sendEmailEach.
async function sendMemberMessage(db, member, churchName, smsText, emailSubject, emailText) {
  const pref = member.preferredChannel || 'NONE';
  if (pref === 'NONE') return { ok: false, reason: 'do_not_contact' };
  const phone = (pref === 'EITHER' || pref === 'SMS_ONLY') ? normalizePhoneGH(member.mobilePhone) : null;
  const email = (pref === 'EITHER' || pref === 'EMAIL_ONLY') ? (member.email || null) : null;
  if (!phone && !email) return { ok: false, reason: 'no_contact' };
  let sms = null, mail = null;
  if (phone) { try { sms = await sendSmsBatch([phone], smsText); } catch (e) { sms = { ok: false, error: e.message }; } }
  if (email) { try { mail = await sendEmailEach(db, [{ addr: email, token: member.unsubscribeToken }], emailSubject, emailText, { churchName }); } catch (e) { mail = { ok: false, error: e.message }; } }
  const channels = [];
  if (phone) channels.push('SMS');
  if (email) channels.push('email');
  return {
    ok: true, dryRun: (sms && sms.dryRun) || (mail && mail.dryRun), channels: channels.join(' + '),
    smsOk: sms ? (sms.ok || sms.dryRun) : null, emailOk: mail ? (mail.ok || mail.dryRun) : null,
  };
}

const RECEIPT_FLASH = {
  new: 'Payment recorded. Here is the receipt — print it or send it to the member.',
  sent: 'Receipt sent to the member.',
  dry: 'Receipt logged as a dry run — SMS/email are not configured, so nothing was actually delivered.',
  nocontact: "Could not send: the member has no phone or email matching their contact preference.",
  donotcontact: 'Could not send: this member is set to "Do not contact". Update their preference first.',
};

// ---------- Annual giving statements ----------
function givingYears() {
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now; y >= now - 6; y--) years.push(y);
  return years;
}
function safeYear(v) {
  const y = String(v || '').replace(/[^0-9]/g, '');
  return /^\d{4}$/.test(y) ? y : String(new Date().getFullYear());
}
// A member's giving for one calendar year, unioned across tithes, special
// offerings (as donor), legacy contributions, and pledge payments —
// direct port of lib/finance.js's memberGivingForYear().
async function memberGivingForYear(db, memberId, year) {
  const start = new Date(`${year}-01-01`);
  const end = new Date(`${Number(year) + 1}-01-01`);
  const [tithes, specials, contributions, pledgePayments] = await Promise.all([
    db.tithe.findMany({ where: { memberId, deletedAt: null, titheDate: { gte: start, lt: end } } }),
    db.specialOffering.findMany({ where: { donorId: memberId, deletedAt: null, offeringDate: { gte: start, lt: end } }, include: { specialCategory: { select: { categoryName: true } } } }),
    db.contribution.findMany({ where: { memberId, contributedOn: { gte: start, lt: end } }, include: { fund: { select: { name: true } } } }),
    db.pledgePayment.findMany({ where: { paidOn: { gte: start, lt: end }, pledge: { memberId } }, include: { pledge: { include: { harvest: { select: { harvestName: true } } } } } }),
  ]);
  const lines = [];
  const byGroup = {};
  const add = (dt, group, category, detail, amount) => {
    lines.push({ dt, group, category, detail, amount });
    byGroup[group] = (byGroup[group] || 0) + Number(amount);
  };
  for (const t of tithes) add(t.titheDate.toISOString().slice(0, 10), 'Tithes', 'Tithe', [t.method, t.reference].filter(Boolean).join(' · '), t.amount);
  for (const s of specials) add(s.offeringDate.toISOString().slice(0, 10), 'Special Offerings', s.specialCategory.categoryName, [s.purpose, s.receiptNumber].filter(Boolean).join(' · '), s.amount);
  for (const c of contributions) add(c.contributedOn.toISOString().slice(0, 10), 'Contributions', (c.fund && c.fund.name) || 'Fund', [c.method, c.reference].filter(Boolean).join(' · '), c.amount);
  for (const p of pledgePayments) add(p.paidOn.toISOString().slice(0, 10), 'Pledge Redemptions', (p.pledge.harvest && p.pledge.harvest.harvestName) || 'Harvest', p.receiptNumber, p.amount);
  lines.sort((a, b) => a.dt.localeCompare(b.dt));
  const total = lines.reduce((s, l) => s + Number(l.amount), 0);
  return { lines, byGroup, total };
}
// Every member with any giving in a year, for the /finance/statements index.
async function givingByMember(db, year) {
  const start = new Date(`${year}-01-01`);
  const end = new Date(`${Number(year) + 1}-01-01`);
  const [tithes, specials, contributions, pledgePayments] = await Promise.all([
    db.tithe.findMany({ where: { deletedAt: null, titheDate: { gte: start, lt: end } }, select: { memberId: true, amount: true } }),
    db.specialOffering.findMany({ where: { deletedAt: null, donorId: { not: null }, offeringDate: { gte: start, lt: end } }, select: { donorId: true, amount: true } }),
    db.contribution.findMany({ where: { memberId: { not: null }, contributedOn: { gte: start, lt: end } }, select: { memberId: true, amount: true } }),
    db.pledgePayment.findMany({ where: { paidOn: { gte: start, lt: end } }, select: { amount: true, pledge: { select: { memberId: true } } } }),
  ]);
  const byMember = new Map();
  const bump = (memberId, amount) => {
    if (!memberId) return;
    const cur = byMember.get(memberId) || { memberId, gifts: 0, total: 0 };
    cur.gifts++; cur.total += Number(amount);
    byMember.set(memberId, cur);
  };
  for (const t of tithes) bump(t.memberId, t.amount);
  for (const s of specials) bump(s.donorId, s.amount);
  for (const c of contributions) bump(c.memberId, c.amount);
  for (const p of pledgePayments) bump(p.pledge.memberId, p.amount);
  if (byMember.size === 0) return [];
  const members = await db.member.findMany({ where: { id: { in: [...byMember.keys()] } }, select: { id: true, firstName: true, lastName: true, externalId: true } });
  return [...byMember.values()]
    .map((r) => { const m = members.find((x) => x.id === r.memberId); return { ...r, name: m ? `${m.firstName} ${m.lastName}` : '—', externalId: m ? m.externalId : null }; })
    .sort((a, b) => b.total - a.total);
}

// Small CSV helpers — no shared lib/ convention exists yet for this (see
// module header); copied near-verbatim from the original's
// routes/finance.js:318-326 sendFinanceCsv/csvEscape pair.
function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, filename, header, rows) {
  const lines = [header.map(csvEscape).join(',')].concat(rows.map((r) => r.map(csvEscape).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\r\n'));
}

const FINANCE_REPORTS = [
  ['overview', 'Financial Overview'],
  ['income-expense', 'Income & Expenses'],
  ['budget', 'Budget Performance'],
  ['funds', 'Fund Report'],
  ['giving', 'Giving by Category'],
  ['pledges', 'Outstanding Pledges'],
  ['expenses', 'Expense Analysis'],
  ['cash-flow', 'Cash-Flow Summary'],
  ['statements', 'Member Giving'],
  ['treasurer', 'Treasurer’s Report'],
  ['year-end', 'Year-End Summary'],
];
function financeReportName(type) {
  return (FINANCE_REPORTS.find(([key]) => key === type) || FINANCE_REPORTS[0])[1];
}
function validReportDate(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : fallback;
}
function financeReportRange(req) {
  const now = new Date();
  const end = validReportDate(req.query.end, now.toISOString().slice(0, 10));
  const start = validReportDate(req.query.start, `${now.getFullYear()}-01-01`);
  return start <= end ? { start, end } : { start: end, end: start };
}
function reportQuery(params, overrides = {}) {
  const q = new URLSearchParams({ ...params, ...overrides });
  for (const [key, value] of [...q.entries()]) if (!value) q.delete(key);
  return q.toString();
}
function financeReportTabs(active, query) {
  return `<div class="finance-report-tabs">${FINANCE_REPORTS.map(([key, label]) =>
    `<a class="${key === active ? 'active' : ''}" href="/finance/reports/${key}?${query}">${esc(label)}</a>`).join('')}</div>`;
}
function reportGroup(rows, key, amountKey = 'amount') {
  const grouped = new Map();
  for (const row of rows) {
    const label = String(row[key] || 'Uncategorised');
    grouped.set(label, (grouped.get(label) || 0) + Number(row[amountKey] || 0));
  }
  return [...grouped.entries()].map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
}
function financeBars(rows, total) {
  if (!rows.length) return '<p class="muted-text">No activity for this selection.</p>';
  const max = Math.max(...rows.map((row) => Math.abs(row.amount)), 1);
  return `<div class="finance-report-bars">${rows.slice(0, 12).map((row) => `<div class="finance-report-bar">
    <span>${esc(row.label)}</span><div><i style="width:${Math.max(2, Math.abs(row.amount) / max * 100)}%"></i></div>
    <strong>${fmtMoney(row.amount)}</strong><small>${total ? Math.round(row.amount / total * 100) : 0}%</small>
  </div>`).join('')}</div>`;
}
function reportSection(title, content, meta = '') {
  return `<section class="card finance-report-section"><div class="card-head"><h2>${esc(title)}</h2>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</div>${content}</section>`;
}

function register(app) {
  app.get('/finance', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const to = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;

    const [funds, monthIncome, monthExpenses, pledges, currentPeriod, budget, recentEntries] = await Promise.all([
      db.fund.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      ledger.budgetActual(db, churchId, { lineType: 'INCOME', from, to }),
      ledger.budgetActual(db, churchId, { lineType: 'EXPENSE', from, to }),
      db.pledge.aggregate({ where: { status: { in: ['PENDING', 'PARTIAL'] } }, _sum: { pledgedAmount: true, paidAmount: true }, _count: true }),
      db.financialPeriod.findUnique({ where: { churchId_year_month: { churchId, year, month } } }),
      db.financeBudget.findFirst({
        where: { year, status: 'APPROVED', OR: [{ scope: 'ANNUAL' }, { scope: 'MONTHLY', month }] },
        include: { lines: true },
        orderBy: [{ scope: 'desc' }, { id: 'desc' }], // MONTHLY sorts after ANNUAL, so the more specific plan wins.
      }),
      db.journalEntry.findMany({
        where: { status: { in: ['POSTED', 'REVERSED'] } },
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        take: 6,
        include: { lines: { select: { debit: true, credit: true } } },
      }),
    ]);

    const fundBalances = await Promise.all(funds.map((fund) => ledger.fundBalance(db, churchId, fund.id)));
    const cashPosition = fundBalances.reduce((sum, value) => sum + Number(value || 0), 0);
    const outstandingPledges = Math.max(0, Number(pledges._sum.pledgedAmount || 0) - Number(pledges._sum.paidAmount || 0));
    const budgetLines = budget ? budget.lines.map((line) => ({ ...line, budget })) : [];
    const expenseBudgetLines = budgetLines.filter((line) => line.lineType === 'EXPENSE');
    const expenseBudget = expenseBudgetLines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
    const expenseActuals = await Promise.all(expenseBudgetLines.map((line) => {
      const window = ledger.budgetWindow(line.budget);
      return ledger.budgetActual(db, churchId, { ...line, ...window });
    }));
    const budgetSpent = expenseActuals.reduce((sum, value) => sum + Number(value || 0), 0);
    const budgetUsage = expenseBudget > 0 ? Math.round((budgetSpent / expenseBudget) * 100) : null;
    const budgetTone = budgetUsage === null ? 'neutral' : budgetUsage > 100 ? 'danger' : budgetUsage >= 85 ? 'warning' : 'positive';
    const monthNet = monthIncome - monthExpenses;

    const alerts = [];
    if (!funds.length) alerts.push(['warning', 'No funds configured', 'Create a fund before recording restricted or designated money.', '/finance/funds']);
    if (!budget) alerts.push(['neutral', 'No approved budget for this period', 'Approve a budget to track spending against plan.', '/finance/budgets']);
    if (budgetUsage !== null && budgetUsage > 100) alerts.push(['danger', 'Approved expense budget exceeded', `Actual spending is ${budgetUsage}% of budget.`, '/finance/budgets']);
    else if (budgetUsage !== null && budgetUsage >= 85) alerts.push(['warning', 'Expense budget is nearing its limit', `Actual spending is ${budgetUsage}% of budget.`, '/finance/budgets']);
    if (outstandingPledges > 0) alerts.push(['neutral', `${fmtMoney(outstandingPledges)} in outstanding pledges`, `${pledges._count} pledge${pledges._count === 1 ? '' : 's'} still require follow-up.`, '/finance/pledges']);
    if (!currentPeriod || currentPeriod.status === 'OPEN') alerts.push(['neutral', 'Current financial period is open', 'Lock it after reconciliation and month-end review.', '/finance/periods']);

    const groups = [
      ['Money in', [
        ['/finance/income', '↗', 'General income'], ['/finance/tithes', '✚', 'Tithes'],
        ['/finance/special', '★', 'Special offerings'], ['/finance/day-borns', '☀', 'Day-born collections'],
        ['/finance/services', '✝', 'Services'], ['/finance/harvests', '🌾', 'Harvests'], ['/finance/pledges', '◇', 'Pledges'],
      ]],
      ['Money out & controls', [
        ['/finance/expenses', '↘', 'Expenses'], ['/finance/vouchers', '▣', 'Payment vouchers'],
        ['/finance/funds', '◎', 'Funds'], ['/finance/projects', '◆', 'Projects'], ['/finance/budgets', '▥', 'Budgets'],
        ['/finance/periods', '◷', 'Financial periods'],
      ]],
      ['Reports & records', [
        ['/finance/reports', '◫', 'Finance reports'], ['/finance/receipts', '▤', 'Receipts'],
        ['/finance/statements', '▧', 'Giving statements'],
      ]],
    ];
    const recentRows = recentEntries.map((entry) => {
      const amount = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
      const source = String(entry.sourceType || 'OTHER').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      return `<a class="finance-activity" href="/finance/journal/${entry.id}">
        <span class="finance-activity-icon">${entry.status === 'REVERSED' ? '↶' : '✓'}</span>
        <span><strong>${esc(entry.memo || source)}</strong><small>${esc(entry.entryDate.toISOString().slice(0, 10))} · ${esc(entry.entryNo)} · ${esc(source)}</small></span>
        <strong class="finance-activity-amount">${fmtMoney(amount)}</strong>
      </a>`;
    }).join('');

    const body = `${pageHero('Finance', 'A clear view of your church’s financial position and next actions.')}
      <div class="finance-command">
        <section class="finance-kpi-grid" aria-label="Financial overview">
          <a class="finance-kpi" href="/finance/funds"><span>Fund balances</span><strong>${fmtMoney(cashPosition)}</strong><small>Across ${funds.length} active fund${funds.length === 1 ? '' : 's'}</small></a>
          <a class="finance-kpi positive" href="/finance/income"><span>Income this month</span><strong>${fmtMoney(monthIncome)}</strong><small>${esc(from)} to ${esc(to)}</small></a>
          <a class="finance-kpi ${monthNet < 0 ? 'danger' : 'positive'}" href="/finance/expenses"><span>Net movement</span><strong>${fmtMoney(monthNet)}</strong><small>${fmtMoney(monthExpenses)} spent this month</small></a>
          <a class="finance-kpi ${budgetTone}" href="/finance/budgets"><span>Expense budget used</span><strong>${budgetUsage === null ? 'Not set' : `${budgetUsage}%`}</strong><small>${budgetUsage === null ? 'No approved budget' : `${fmtMoney(budgetSpent)} of ${fmtMoney(expenseBudget)}`}</small></a>
          <a class="finance-kpi ${outstandingPledges > 0 ? 'warning' : 'positive'}" href="/finance/pledges"><span>Outstanding pledges</span><strong>${fmtMoney(outstandingPledges)}</strong><small>${pledges._count} open pledge${pledges._count === 1 ? '' : 's'}</small></a>
        </section>

        ${canWrite ? `<section class="finance-quick-actions" aria-label="Quick actions">
          <div><p class="eyebrow">Quick actions</p><h2>Record today’s activity</h2></div>
          <div class="finance-action-buttons">
            <a class="btn" href="/finance/income">+ Record income</a>
            <a class="btn secondary" href="/finance/expenses">+ Record expense</a>
            <a class="btn ghost" href="/finance/pledges">Record pledge payment</a>
          </div>
        </section>` : ''}

        <div class="finance-dashboard-grid">
          <section class="card finance-attention">
            <div class="card-head"><div><p class="eyebrow">Attention</p><h2>Financial checks</h2></div><span class="meta">${alerts.length} item${alerts.length === 1 ? '' : 's'}</span></div>
            ${alerts.length ? `<div class="finance-alert-list">${alerts.map(([tone, title, detail, href]) =>
              `<a class="finance-alert ${tone}" href="${href}"><span class="finance-alert-dot"></span><span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span><span aria-hidden="true">→</span></a>`).join('')}</div>`
              : '<div class="finance-all-clear"><span>✓</span><div><strong>Everything looks in order</strong><small>No immediate finance checks need attention.</small></div></div>'}
          </section>
          <section class="card finance-recent">
            <div class="card-head"><div><p class="eyebrow">Ledger</p><h2>Recent activity</h2></div></div>
            ${recentRows || '<div class="finance-empty"><strong>No ledger activity yet</strong><span>Recorded income and expenses will appear here.</span></div>'}
          </section>
        </div>

        <section class="finance-module-directory">
          <div class="finance-section-heading"><div><p class="eyebrow">Workspace</p><h2>Finance tools</h2></div><p>Open the detailed registers, controls, and reports.</p></div>
          <div class="finance-module-groups">${groups.map(([label, items], index) => `<details ${index === 0 ? 'open' : ''}>
            <summary><span>${esc(label)}</span><small>${items.length} tools</small></summary>
            <div class="finance-module-links">${items.map(([href, icon, name]) =>
              `<a href="${href}"><span class="finance-module-icon">${icon}</span><strong>${esc(name)}</strong><span aria-hidden="true">→</span></a>`).join('')}</div>
          </details>`).join('')}</div>
        </section>
      </div>`;
    res.page({ title: 'Finance', active: '/finance', noHeader: true, body });
  }));

  app.get('/finance/reports', requireFinanceReportAccess, (req, res) => {
    res.redirect(`/finance/reports/overview?${reportQuery(req.query)}`);
  });

  app.get('/finance/reports/:type([a-z-]+)', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const type = FINANCE_REPORTS.some(([key]) => key === req.params.type) ? req.params.type : 'overview';
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const { start, end } = financeReportRange(req);
    const fundId = Number(req.query.fundId) || null;
    const accountId = Number(req.query.accountId) || null;
    const projectId = Number(req.query.projectId) || null;
    const startDate = new Date(start);
    const endDate = new Date(end);
    const days = Math.max(1, Math.round((endDate - startDate) / 86400000) + 1);
    const priorEndDate = new Date(startDate.getTime() - 86400000);
    const priorStartDate = new Date(priorEndDate.getTime() - (days - 1) * 86400000);
    const priorStart = priorStartDate.toISOString().slice(0, 10);
    const priorEnd = priorEndDate.toISOString().slice(0, 10);

    const [funds, accounts, projects, lines, expenses, pledges, tithes, special, pledgePayments] = await Promise.all([
      db.fund.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      db.account.findMany({ where: { active: true, accountType: { in: ['INCOME', 'EXPENSE'] } }, orderBy: { code: 'asc' } }),
      db.financeProject.findMany({ where: { status: { in: ['PLANNING', 'ACTIVE', 'ON_HOLD'] } }, orderBy: { name: 'asc' } }),
      db.journalLine.findMany({
        where: {
          ...(fundId ? { fundId } : {}), ...(accountId ? { accountId } : {}),
          account: { accountType: { in: ['INCOME', 'EXPENSE'] } },
          entry: { entryDate: { gte: startDate, lte: endDate }, status: { in: ['POSTED', 'REVERSED'] } },
        },
        include: { account: true, fund: true, entry: true },
        orderBy: { entry: { entryDate: 'asc' } },
      }),
      db.expense.findMany({
        where: { spentOn: { gte: startDate, lte: endDate }, approvalStatus: 'PAID', ...(fundId ? { fundId } : {}), ...(projectId ? { projectId } : {}) },
        include: { fund: true, project: true, expenseCategory: true },
        orderBy: { spentOn: 'desc' },
      }),
      db.pledge.findMany({
        where: { status: { in: ['PENDING', 'PARTIAL'] } },
        include: { member: true, harvest: true },
        orderBy: { pledgeDate: 'desc' },
      }),
      db.tithe.findMany({ where: { deletedAt: null, titheDate: { gte: startDate, lte: endDate } }, include: { member: true } }),
      db.specialOffering.findMany({ where: { deletedAt: null, offeringDate: { gte: startDate, lte: endDate } }, include: { donor: true, specialCategory: true } }),
      db.pledgePayment.findMany({
        where: { paidOn: { gte: startDate, lte: endDate } },
        include: { pledge: { include: { member: true, harvest: true } } },
      }),
    ]);

    let ledgerRows = lines.map((line) => {
      const isIncome = line.account.accountType === 'INCOME';
      return {
        id: line.entryId, date: line.entry.entryDate.toISOString().slice(0, 10),
        month: line.entry.entryDate.toLocaleString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
        kind: isIncome ? 'Income' : 'Expense', category: line.account.name,
        fund: line.fund ? line.fund.name : 'General', source: String(line.entry.sourceType || 'Other').replace(/_/g, ' '),
        memo: line.memo || line.entry.memo || '', amount: isIncome ? Number(line.credit) - Number(line.debit) : Number(line.debit) - Number(line.credit),
      };
    });
    if (projectId) {
      const projectExpenseIds = new Set(expenses.map((row) => String(row.id)));
      const projectIncomeIds = new Set((await db.incomeRecord.findMany({ where: { projectId, deletedAt: null }, select: { id: true } })).map((row) => String(row.id)));
      ledgerRows = ledgerRows.filter((row) =>
        (row.source.toUpperCase() === 'EXPENSE' && projectExpenseIds.has(String(lines.find((line) => line.entryId === row.id)?.entry.sourceId))) ||
        (row.source.toUpperCase() === 'INCOME' && projectIncomeIds.has(String(lines.find((line) => line.entryId === row.id)?.entry.sourceId))));
    }
    const incomeRows = ledgerRows.filter((row) => row.kind === 'Income');
    const expenseRows = ledgerRows.filter((row) => row.kind === 'Expense');
    const income = incomeRows.reduce((sum, row) => sum + row.amount, 0);
    const spent = expenseRows.reduce((sum, row) => sum + row.amount, 0);
    const net = income - spent;
    const [priorIncome, priorExpense] = await Promise.all([
      ledger.budgetActual(db, churchId, { lineType: 'INCOME', fundId, accountId: accountId && accounts.find((a) => a.id === accountId && a.accountType === 'INCOME') ? accountId : null, from: priorStart, to: priorEnd }),
      ledger.budgetActual(db, churchId, { lineType: 'EXPENSE', fundId, accountId: accountId && accounts.find((a) => a.id === accountId && a.accountType === 'EXPENSE') ? accountId : null, from: priorStart, to: priorEnd }),
    ]);
    const compare = (current, previous) => previous ? `${current >= previous ? '+' : ''}${Math.round((current - previous) / Math.abs(previous) * 100)}% vs prior period` : 'No prior-period activity';
    const outstanding = pledges.reduce((sum, row) => sum + Math.max(0, Number(row.pledgedAmount) - Number(row.paidAmount)), 0);
    const queryParams = { start, end, fundId: fundId || '', accountId: accountId || '', projectId: projectId || '' };
    const query = reportQuery(queryParams);
    const filters = `<form class="finance-report-filters" method="get">
      <label>From<input type="date" name="start" value="${esc(start)}"></label>
      <label>To<input type="date" name="end" value="${esc(end)}"></label>
      <label>Fund<select name="fundId"><option value="">All funds</option>${funds.map((f) => `<option value="${f.id}" ${f.id === fundId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <label>Account<select name="accountId"><option value="">All accounts</option>${accounts.map((a) => `<option value="${a.id}" ${a.id === accountId ? 'selected' : ''}>${esc(a.code)} · ${esc(a.name)}</option>`).join('')}</select></label>
      <label>Project<select name="projectId"><option value="">All projects</option>${projects.map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <button type="submit">Apply filters</button>
    </form>`;
    const actions = `<div class="finance-report-actions">
      <a class="btn ghost" href="/finance/reports/${type}.csv?${query}">Export CSV</a>
      <button class="btn" type="button" onclick="window.print()">Print / save PDF</button>
    </div>`;
    const summary = statsRow([
      { cls: 'green', icon: icon('trend'), value: fmtMoney(income), label: `Income · ${compare(income, priorIncome)}` },
      { cls: 'orange', icon: icon('trendDown'), value: fmtMoney(spent), label: `Expenses · ${compare(spent, priorExpense)}` },
      { cls: net >= 0 ? 'blue' : 'red', icon: icon('finance'), value: fmtMoney(net), label: 'Net movement' },
      { cls: 'purple', icon: icon('diamond'), value: fmtMoney(outstanding), label: 'Outstanding pledges' },
    ]);

    const monthlyIncome = reportGroup(incomeRows, 'month');
    const monthlyExpense = reportGroup(expenseRows, 'month');
    const incomeCats = reportGroup(incomeRows, 'category');
    const expenseCats = reportGroup(expenseRows, 'category');
    const fundRows = await Promise.all(funds.filter((f) => !fundId || f.id === fundId).map(async (fund) => {
      const [balance, movement] = await Promise.all([ledger.fundBalance(db, churchId, fund.id), ledger.fundRaisedSpent(db, churchId, fund.id)]);
      return [esc(fund.name), fund.restricted ? 'Restricted' : 'Unrestricted', fmtMoney(movement.raised), fmtMoney(movement.spent), `<strong>${fmtMoney(balance)}</strong>`];
    }));
    const givingRows = [
      ...tithes.map((r) => ({ member: `${r.member.firstName} ${r.member.lastName}`, category: 'Tithes', amount: r.amount })),
      ...special.map((r) => ({ member: r.donor ? `${r.donor.firstName} ${r.donor.lastName}` : (r.donorNameManual || 'Anonymous'), category: r.specialCategory.categoryName, amount: r.amount })),
      ...pledgePayments.map((r) => ({ member: `${r.pledge.member.firstName} ${r.pledge.member.lastName}`, category: `Pledge · ${r.pledge.harvest.harvestName}`, amount: r.amount })),
    ];
    const givingByCategory = reportGroup(givingRows, 'category');
    const givingByMember = reportGroup(givingRows, 'member');
    const expenseAnalysisRows = expenses.map((row) => [
      row.spentOn.toISOString().slice(0, 10), esc(row.expenseCategory?.categoryName || row.category), esc(row.description || '—'),
      esc(row.paidTo || '—'), esc(row.fund?.name || 'General'), esc(row.project?.name || '—'), fmtMoney(row.amount),
    ]);

    let content = '';
    if (type === 'overview') {
      content = summary + reportSection('Income by category', financeBars(incomeCats, income)) +
        reportSection('Expenses by category', financeBars(expenseCats, spent)) +
        reportSection('Recent ledger entries', table(['Date', 'Type', 'Account', 'Fund', 'Memo', 'Amount'], ledgerRows.slice().reverse().slice(0, 30).map((r) =>
          [r.date, r.kind, esc(r.category), esc(r.fund), esc(r.memo || '—'), fmtMoney(r.amount)])));
    } else if (type === 'income-expense') {
      const months = [...new Set([...monthlyIncome.map((r) => r.label), ...monthlyExpense.map((r) => r.label)])];
      content = summary + reportSection('Monthly performance', table(['Month', 'Income', 'Expenses', 'Net'], months.map((m) => {
        const inc = monthlyIncome.find((r) => r.label === m)?.amount || 0; const exp = monthlyExpense.find((r) => r.label === m)?.amount || 0;
        return [esc(m), fmtMoney(inc), fmtMoney(exp), `<strong>${fmtMoney(inc - exp)}</strong>`];
      }))) + reportSection('Account detail', table(['Date', 'Type', 'Account', 'Fund', 'Source', 'Amount'], ledgerRows.map((r) => [r.date, r.kind, esc(r.category), esc(r.fund), esc(r.source), fmtMoney(r.amount)])));
    } else if (type === 'funds') {
      content = summary + reportSection('Fund balances and activity', table(['Fund', 'Restriction', 'Raised', 'Spent', 'Balance'], fundRows));
    } else if (type === 'giving') {
      content = summary + reportSection('Giving categories', financeBars(givingByCategory, givingRows.reduce((s, r) => s + Number(r.amount), 0))) +
        reportSection('Top givers', table(['Member / donor', 'Amount'], givingByMember.slice(0, 50).map((r) => [esc(r.label), fmtMoney(r.amount)])));
    } else if (type === 'pledges') {
      content = summary + reportSection('Outstanding pledges', pledges.length ? table(['Member', 'Harvest', 'Pledged', 'Paid', 'Outstanding', 'Status'], pledges.map((p) =>
        [esc(`${p.member.firstName} ${p.member.lastName}`), esc(p.harvest.harvestName), fmtMoney(p.pledgedAmount), fmtMoney(p.paidAmount), `<strong>${fmtMoney(p.pledgedAmount - p.paidAmount)}</strong>`, esc(p.status)])) : '<p class="muted-text">No outstanding pledges.</p>');
    } else if (type === 'expenses') {
      content = summary + reportSection('Expense categories', financeBars(reportGroup(expenses.map((r) => ({ category: r.expenseCategory?.categoryName || r.category, amount: r.amount })), 'category'), spent)) +
        reportSection('Expense register', expenseAnalysisRows.length ? table(['Date', 'Category', 'Description', 'Payee', 'Fund', 'Project', 'Amount'], expenseAnalysisRows) : '<p class="muted-text">No expenses for this selection.</p>');
    } else if (type === 'cash-flow') {
      const months = [...new Set([...monthlyIncome.map((r) => r.label), ...monthlyExpense.map((r) => r.label)])];
      content = summary + reportSection('Cash movement by month', table(['Month', 'Cash in', 'Cash out', 'Net cash movement'], months.map((m) => {
        const cashIn = monthlyIncome.find((r) => r.label === m)?.amount || 0; const cashOut = monthlyExpense.find((r) => r.label === m)?.amount || 0;
        return [esc(m), fmtMoney(cashIn), fmtMoney(cashOut), `<strong>${fmtMoney(cashIn - cashOut)}</strong>`];
      })));
    } else if (type === 'statements') {
      content = summary + reportSection('Giving by member', givingByMember.length ? table(['Member / donor', 'Total giving', 'Statement'], givingByMember.map((r) =>
        [esc(r.label), fmtMoney(r.amount), '<a href="/finance/statements">Open annual statements →</a>'])) : '<p class="muted-text">No member giving for this selection.</p>');
    } else if (type === 'budget') {
      const budgets = await db.financeBudget.findMany({ where: { year: startDate.getUTCFullYear(), status: { in: ['APPROVED', 'CLOSED'] } }, include: { lines: { include: { fund: true } } }, orderBy: { id: 'desc' } });
      const budgetRows = [];
      for (const budget of budgets) for (const line of budget.lines) {
        const window = ledger.budgetWindow(budget);
        const actual = await ledger.budgetActual(db, churchId, { ...line, ...window });
        const variance = line.lineType === 'INCOME' ? actual - line.amount : line.amount - actual;
        budgetRows.push([esc(budget.name), esc(line.lineType), esc(line.category), esc(line.fund?.name || 'All funds'), fmtMoney(line.amount), fmtMoney(actual), `<strong>${fmtMoney(variance)}</strong>`]);
      }
      content = summary + reportSection('Approved budget vs actual', budgetRows.length ? table(['Budget', 'Type', 'Category', 'Fund', 'Budget', 'Actual', 'Variance'], budgetRows) : '<p class="muted-text">No approved budget for this year.</p>');
    } else {
      const title = type === 'treasurer' ? 'Treasurer’s management report' : 'Year-end financial summary';
      content = summary + reportSection(title, `<div class="finance-report-narrative">
        <p>For <strong>${esc(start)} to ${esc(end)}</strong>, total income was <strong>${fmtMoney(income)}</strong> and total expenditure was <strong>${fmtMoney(spent)}</strong>, producing net movement of <strong>${fmtMoney(net)}</strong>.</p>
        <p>The church has ${funds.length} active funds and ${pledges.length} open pledges with ${fmtMoney(outstanding)} outstanding.</p>
      </div>`) + reportSection('Income composition', financeBars(incomeCats, income)) +
        reportSection('Expense composition', financeBars(expenseCats, spent)) +
        reportSection('Fund position', table(['Fund', 'Restriction', 'Raised', 'Spent', 'Balance'], fundRows));
    }

    const church = res.locals.user.church;
    const body = `${pageHero(financeReportName(type), `Decision-ready finance reporting for ${esc(church?.name || 'your church')}.`)}
      ${financeReportTabs(type, query)}${filters}${actions}
      <div class="finance-report-document">
        <header class="finance-print-header"><h1>${esc(church?.name || 'Church')}</h1><p>${esc(financeReportName(type))} · ${esc(start)} to ${esc(end)}</p></header>
        ${content}
        <footer class="finance-report-footer">Prepared ${new Date().toISOString().slice(0, 10)} · As of ${esc(end)} · ${esc(res.locals.user.displayName || res.locals.user.username || res.locals.user.email || '')}</footer>
      </div>`;
    res.page({ title: `Finance · ${financeReportName(type)}`, active: '/finance', noHeader: true, body });
  }));

  app.get('/finance/reports/:type.csv', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    const type = FINANCE_REPORTS.some(([key]) => key === req.params.type) ? req.params.type : 'overview';
    const { start, end } = financeReportRange(req);
    const fundId = Number(req.query.fundId) || null;
    const accountId = Number(req.query.accountId) || null;
    const lines = await res.locals.db.journalLine.findMany({
      where: {
        ...(fundId ? { fundId } : {}), ...(accountId ? { accountId } : {}),
        account: { accountType: { in: ['INCOME', 'EXPENSE'] } },
        entry: { entryDate: { gte: new Date(start), lte: new Date(end) }, status: { in: ['POSTED', 'REVERSED'] } },
      },
      include: { account: true, fund: true, entry: true },
      orderBy: { entry: { entryDate: 'asc' } },
    });
    sendCsv(res, `${type}-${start}-${end}.csv`, ['Date', 'Type', 'Account', 'Fund', 'Source', 'Memo', 'Debit', 'Credit'],
      lines.map((line) => [line.entry.entryDate.toISOString().slice(0, 10), line.account.accountType, line.account.name,
        line.fund?.name || 'General', line.entry.sourceType, line.memo || line.entry.memo || '', line.debit, line.credit]));
  }));

  // --- Funds ---
  app.get('/finance/funds', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const funds = await db.fund.findMany({ where: { active: true }, orderBy: [{ fundType: 'asc' }, { name: 'asc' }] });
    const enriched = await Promise.all(funds.map(async (f) => {
      const [balance, raisedSpent] = await Promise.all([ledger.fundBalance(db, churchId, f.id), ledger.fundRaisedSpent(db, churchId, f.id)]);
      return { ...f, balance, ...raisedSpent };
    }));
    const totalBalance = enriched.reduce((s, f) => s + Number(f.balance || 0), 0);
    const restrictedTotal = enriched.filter((f) => f.restricted).reduce((s, f) => s + Number(f.balance || 0), 0);

    const addForm = canManage
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Add a fund</strong></summary>
           <form class="form" method="post" action="/finance/funds" style="margin-top:0.75rem">
             <label>Code<input name="code" maxlength="16" placeholder="GEN"></label>
             <label>Fund name<input name="name" required></label>
             <label>Type<select name="fundType">${fundTypeOptions('GENERAL')}</select></label>
             <label>Opening balance (GH₵)<input type="number" step="0.01" min="0" name="openingBalance" value="0"></label>
             <label>Responsible officer<input name="responsibleOfficer"></label>
             <label><span>&nbsp;</span><label class="check" style="background:none;padding:0"><input type="checkbox" name="restricted" value="1"> Restricted fund</label></label>
             <label class="wide">Notes<input name="notes"></label>
             <div class="actions"><button type="submit">Save fund</button></div>
           </form>
         </details>` : '';
    const tableRows = enriched.map((f) => [
      esc(f.code) || '—', esc(f.name), esc((f.fundType || 'GENERAL').replace(/_/g, ' ')),
      f.restricted ? '<span class="pill pill-pending">Restricted</span>' : '<span class="pill pill-fulfilled">Unrestricted</span>',
      esc(f.responsibleOfficer || '—'), fmtMoney(f.raised), fmtMoney(f.spent), `<strong>${fmtMoney(f.balance)}</strong>`,
    ]);
    const body = `
      ${statsRow([
        { cls: 'blue', icon: icon('finance'), value: fmtMoney(totalBalance), label: 'Total fund balances' },
        { cls: 'orange', icon: icon('lock'), value: fmtMoney(restrictedTotal), label: 'Restricted balances' },
        { cls: 'green', icon: icon('hash'), value: enriched.length, label: 'Active funds' },
      ])}
      ${addForm}
      <section class="card">
        <div class="card-head"><h2>Funds</h2><span class="meta">Restricted and unrestricted church money</span></div>
        ${tableRows.length ? table(['Code', 'Fund', 'Type', 'Restriction', 'Officer', 'Raised', 'Spent', 'Balance'], tableRows) : '<p class="muted-text">No funds configured yet.</p>'}
      </section>`;
    res.page({ title: 'Finance · Funds', active: '/finance', noHeader: true, body: `${pageHero('Funds', '')}${body}` });
  }));

  app.post('/finance/funds', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) { flash(req, 'Enter a fund name.'); return res.redirect('/finance/funds'); }
    if (!isMoneyNonNeg(b.openingBalance || 0)) { flash(req, 'Opening balance must be 0 or more.'); return res.redirect('/finance/funds'); }
    try {
      const fund = await db.fund.create({
        data: {
          name, code: String(b.code || '').trim().toUpperCase() || null,
          fundType: FUND_TYPES.includes(b.fundType) ? b.fundType : 'GENERAL',
          restricted: !!b.restricted, openingBalance: Number(b.openingBalance) || 0,
          responsibleOfficer: b.responsibleOfficer || null, notes: b.notes || null,
        },
      });
      await logActivity(db, 'fund_created', `Created finance fund ${fund.name}`, '/finance/funds', res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      flash(req, 'A fund with that name or code already exists.');
    }
    res.redirect('/finance/funds');
  }));

  // --- Generic income ---
  app.get('/finance/income', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const rows = await db.incomeRecord.findMany({
      where: { deletedAt: null }, orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }], take: 100,
      include: { member: { select: { firstName: true, lastName: true } }, fund: { select: { name: true } } },
    });
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const addForm = canWrite
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Record generic income</strong></summary>
           <form class="form" method="post" action="/finance/income" style="margin-top:0.75rem">
             <label>Date<input type="date" name="transactionDate" required value="${todayISO()}"></label>
             <label>Category<select name="category" required>${incomeCategoryOptions('other')}</select></label>
             <label>Subcategory<input name="subcategory" placeholder="e.g. Thanksgiving, hall rental"></label>
             <label>Member<select name="memberId">${await memberOptions(db)}</select></label>
             <label>Received from<input name="receivedFrom" placeholder="if not a member"></label>
             <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
             <label>Payment method<select name="paymentMethod">${paymentMethodOptions('Cash')}</select></label>
             <label>Fund<select name="fundId">${await fundOptions(db, '', true)}</select></label>
             <label>Reference<input name="referenceNumber"></label>
             <label class="wide">Description<input name="description"></label>
             <div class="actions"><button type="submit">Save and issue receipt</button></div>
           </form>
         </details>` : '';
    const body = `
      ${statsRow([
        { cls: 'green', icon: icon('finance'), value: fmtMoney(total), label: 'Recent generic income' },
        { cls: 'blue', icon: icon('hash'), value: rows.length, label: 'Records shown' },
      ])}
      ${addForm}
      ${rows.length ? table(['Date', 'Category', 'Received from', 'Amount', 'Method', 'Fund', 'Receipt', ''],
        rows.map((r) => [
          esc(r.transactionDate.toISOString().slice(0, 10)),
          `${esc(incomeCategoryLabel(r.category))}${r.subcategory ? '<br><span class="muted-text">' + esc(r.subcategory) + '</span>' : ''}`,
          r.memberId ? `<a href="/members/${r.memberId}">${esc(r.member.firstName + ' ' + r.member.lastName)}</a>` : esc(r.receivedFrom || 'Anonymous'),
          fmtMoney(r.amount), esc(r.paymentMethod || 'Cash'), esc((r.fund && r.fund.name) || 'General fund'), esc(r.receiptNumber || '—'),
          canWrite ? `<form method="post" action="/finance/income/${r.id}/delete" onsubmit="return confirm('Reverse and archive this income record?')"><button class="link" type="submit">Reverse</button></form>` : '',
        ])) : '<p class="muted-text">No generic income recorded yet.</p>'}`;
    res.page({ title: 'Finance · Generic Income', active: '/finance', noHeader: true, body: `${pageHero('Generic Income', '')}${body}` });
  }));

  app.post('/finance/income', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    if (!isValidDate(b.transactionDate)) { flash(req, 'Enter a valid income date.'); return res.redirect('/finance/income'); }
    if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/income'); }

    const member = b.memberId ? await db.member.findUnique({ where: { id: Number(b.memberId) } }) : null;
    const receivedFrom = (member && `${member.firstName} ${member.lastName}`) || String(b.receivedFrom || '').trim() || 'Anonymous';
    const category = b.category || 'other';
    const label = incomeCategoryLabel(category);
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) { flash(req, 'Fund not found.'); return res.redirect('/finance/income'); }
    const fundId = fundCheck.fundId ?? await defaultFundId(db);

    const income = await db.incomeRecord.create({
      data: {
        transactionDate: new Date(b.transactionDate), category, subcategory: b.subcategory || null,
        receivedFrom, memberId: member ? member.id : null, amount: Number(b.amount),
        paymentMethod: b.paymentMethod || 'Cash', fundId, referenceNumber: b.referenceNumber || null,
        description: b.description || null, recordedBy: res.locals.user.id,
      },
    });
    const entryId = await ledger.postCashIncome(db, churchId, {
      date: b.transactionDate, amount: Number(b.amount), incomeAccount: ledger.incomeAccountFor(label),
      fundId, sourceType: 'GENERIC_INCOME', sourceId: income.id, createdBy: res.locals.user.id,
      memo: b.description || `${label} from ${receivedFrom}`,
    });
    const receiptNo = await nextReceiptNo(db, b.transactionDate);
    await Promise.all([
      db.incomeRecord.update({ where: { id: income.id }, data: { journalEntryId: entryId, receiptNumber: receiptNo } }),
      db.financeReceipt.create({
        data: {
          receiptNumber: receiptNo, sourceType: 'GENERIC_INCOME', sourceId: income.id, receiptDate: new Date(b.transactionDate),
          receivedFrom, amount: Number(b.amount), description: b.description || label, createdBy: res.locals.user.id,
        },
      }),
    ]);
    await logActivity(db, 'income_recorded', `Generic income ${receiptNo} recorded`, '/finance/income', res.locals.user.id);
    flash(req, `Income recorded — receipt ${receiptNo}.`, 'success');
    res.redirect('/finance/income');
  }));

  app.post('/finance/income/:id/delete', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const income = await db.incomeRecord.findUnique({ where: { id } });
    if (!income) return res.status(404).send('Not found');
    if (income.journalEntryId) await ledger.reverseJournal(db, churchId, income.journalEntryId, 'Generic income archived', res.locals.user.id);
    await db.incomeRecord.update({ where: { id }, data: { deletedAt: new Date() } });
    await db.financeReceipt.updateMany({ where: { sourceType: 'GENERIC_INCOME', sourceId: id }, data: { voidedAt: new Date(), voidReason: 'Generic income archived' } });
    await logActivity(db, 'finance_reversal', `Generic income #${id} archived and journal reversed`, '/finance/income', res.locals.user.id);
    flash(req, 'Income reversed and archived.', 'success');
    res.redirect('/finance/income');
  }));

  // --- Standalone day-born collections ---
  app.get('/finance/day-borns', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const rows = await db.dayBornCollection.findMany({
      where: { deletedAt: null }, orderBy: [{ collectionDate: 'desc' }, { id: 'desc' }], take: 120,
      include: { fund: { select: { name: true } } },
    });
    const byDay = {};
    for (const d of DAY_BORN_VALUES) byDay[d] = { records: 0, heads: 0, total: 0 };
    for (const r of rows) { byDay[r.dayBorn].records++; byDay[r.dayBorn].heads += r.headCount || 0; byDay[r.dayBorn].total += Number(r.amount || 0); }
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);

    const addForm = canWrite
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Record day-born collection</strong></summary>
           <form class="form" method="post" action="/finance/day-borns" style="margin-top:0.75rem">
             <label>Date<input type="date" name="collectionDate" required value="${todayISO()}"></label>
             <label>Day-born<select name="dayBorn" required>${DAYS_OF_WEEK.map((d) => `<option value="${d.toUpperCase()}">${esc(d)}</option>`).join('')}</select></label>
             <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
             <label>Heads<input type="number" min="0" name="headCount" value="0"></label>
             <label>Payment method<select name="paymentMethod">${paymentMethodOptions('Cash')}</select></label>
             <label>Fund<select name="fundId">${await fundOptions(db, '', true)}</select></label>
             <label>Reference<input name="referenceNumber"></label>
             <label class="wide">Notes<input name="notes"></label>
             <div class="actions"><button type="submit">Save and issue receipt</button></div>
           </form>
         </details>` : '';
    const body = `
      ${statsRow([
        { cls: 'green', icon: icon('finance'), value: fmtMoney(total), label: 'Recent standalone collections' },
        { cls: 'purple', icon: icon('hash'), value: rows.length, label: 'Records shown' },
      ])}
      ${addForm}
      <p><a class="btn ghost" href="/finance/day-borns.csv">⬇ Export CSV</a></p>
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Summary by day-born</h2><span class="meta">Standalone records only</span></div>
        ${table(['Day-born', 'Records', 'Heads', 'Total'],
          DAY_BORN_VALUES.map((d) => [esc(dayBornLabel(d)), byDay[d].records, byDay[d].heads, fmtMoney(byDay[d].total)]))}
      </section>
      <section class="card">
        <div class="card-head"><h2>Recent day-born collections</h2><span class="meta">Receipted entries</span></div>
        ${rows.length ? table(['Date', 'Day-born', 'Amount', 'Heads', 'Method', 'Fund', 'Receipt', ''],
          rows.map((r) => [
            esc(r.collectionDate.toISOString().slice(0, 10)), esc(dayBornLabel(r.dayBorn)), fmtMoney(r.amount), r.headCount || 0,
            esc(r.paymentMethod || 'Cash'), esc((r.fund && r.fund.name) || 'General fund'), esc(r.receiptNumber || '—'),
            canWrite ? `<form method="post" action="/finance/day-borns/${r.id}/delete" onsubmit="return confirm('Reverse and archive this collection?')"><button class="link" type="submit">Reverse</button></form>` : '',
          ])) : '<p class="muted-text">No standalone day-born collections recorded yet.</p>'}
      </section>`;
    res.page({ title: 'Finance · Day-Borns', active: '/finance', noHeader: true, body: `${pageHero('Day-Born Collections', '')}${body}` });
  }));

  app.get('/finance/day-borns.csv', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const rows = await res.locals.db.dayBornCollection.findMany({
      where: { deletedAt: null }, orderBy: [{ collectionDate: 'desc' }, { id: 'desc' }],
      include: { fund: { select: { name: true } } },
    });
    sendCsv(res, 'day-born-collections.csv', ['Date', 'Day-born', 'Amount', 'Heads', 'Method', 'Fund', 'Receipt', 'Reference', 'Notes'],
      rows.map((r) => [r.collectionDate.toISOString().slice(0, 10), dayBornLabel(r.dayBorn), r.amount, r.headCount || 0,
        r.paymentMethod || 'Cash', (r.fund && r.fund.name) || 'General fund', r.receiptNumber || '', r.referenceNumber || '', r.notes || '']));
  }));

  app.post('/finance/day-borns', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    if (!isValidDate(b.collectionDate)) { flash(req, 'Enter a valid collection date.'); return res.redirect('/finance/day-borns'); }
    const dayBorn = String(b.dayBorn || '').toUpperCase();
    if (!DAY_BORN_VALUES.includes(dayBorn)) { flash(req, 'Pick a valid day-born.'); return res.redirect('/finance/day-borns'); }
    if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/day-borns'); }

    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) { flash(req, 'Fund not found.'); return res.redirect('/finance/day-borns'); }
    const fundId = fundCheck.fundId ?? await defaultFundId(db);
    const receiptNo = await nextReceiptNo(db, b.collectionDate);
    const row = await db.dayBornCollection.create({
      data: {
        collectionDate: new Date(b.collectionDate), dayBorn, amount: Number(b.amount),
        headCount: Number(b.headCount) || 0, paymentMethod: b.paymentMethod || 'Cash', fundId,
        referenceNumber: b.referenceNumber || null, receiptNumber: receiptNo, notes: b.notes || null,
        recordedBy: res.locals.user.id,
      },
    });
    const entryId = await ledger.postCashIncome(db, churchId, {
      date: b.collectionDate, amount: Number(b.amount), incomeAccount: ledger.ACC.DAYBORNS,
      fundId, sourceType: 'DAY_BORN_COLLECTION', sourceId: row.id, createdBy: res.locals.user.id,
      memo: `${dayBornLabel(dayBorn)} day-born collection`,
    });
    await Promise.all([
      db.dayBornCollection.update({ where: { id: row.id }, data: { journalEntryId: entryId } }),
      db.financeReceipt.create({
        data: {
          receiptNumber: receiptNo, sourceType: 'DAY_BORN_COLLECTION', sourceId: row.id, receiptDate: new Date(b.collectionDate),
          receivedFrom: `${dayBornLabel(dayBorn)} day-born group`, amount: Number(b.amount),
          description: `${dayBornLabel(dayBorn)} day-born collection`, createdBy: res.locals.user.id,
        },
      }),
    ]);
    await logActivity(db, 'income_recorded', `Day-born collection ${receiptNo} recorded`, '/finance/day-borns', res.locals.user.id);
    flash(req, `Collection recorded — receipt ${receiptNo}.`, 'success');
    res.redirect('/finance/day-borns');
  }));

  app.post('/finance/day-borns/:id/delete', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const row = await db.dayBornCollection.findUnique({ where: { id } });
    if (!row) return res.status(404).send('Not found');
    if (row.journalEntryId) await ledger.reverseJournal(db, churchId, row.journalEntryId, 'Day-born collection archived', res.locals.user.id);
    await db.dayBornCollection.update({ where: { id }, data: { deletedAt: new Date() } });
    await db.financeReceipt.updateMany({ where: { sourceType: 'DAY_BORN_COLLECTION', sourceId: id }, data: { voidedAt: new Date(), voidReason: 'Day-born collection archived' } });
    await logActivity(db, 'finance_reversal', `Day-born collection #${id} archived and journal reversed`, '/finance/day-borns', res.locals.user.id);
    flash(req, 'Collection reversed and archived.', 'success');
    res.redirect('/finance/day-borns');
  }));

  // --- Special offerings (no receipt, no delete route — matches the original) ---
  app.get('/finance/special', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const rows = await db.specialOffering.findMany({
      where: { deletedAt: null }, orderBy: [{ offeringDate: 'desc' }, { id: 'desc' }], take: 100,
      include: { specialCategory: { select: { categoryName: true } }, donor: { select: { id: true, firstName: true, lastName: true } } },
    });
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);

    const addForm = canWrite
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Record special offering</strong></summary>
           <form class="form" method="post" action="/finance/special" style="margin-top:0.75rem">
             <label>Date<input type="date" name="offeringDate" required value="${todayISO()}"></label>
             <label>Category<select name="specialCatId" required>${await specialCategoryOptions(db, '')}</select></label>
             <label>Donor (member)<select name="donorId"><option value="">— not a member —</option>${await memberOptions(db)}</select></label>
             <label>Donor name (if not a member)<input name="donorNameManual"></label>
             <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
             <label>Receipt #<input name="receiptNumber" placeholder="optional"></label>
             <label>Purpose<input name="purpose"></label>
             <label class="wide">Notes<input name="notes"></label>
             <div class="actions"><button type="submit">Save</button></div>
           </form>
         </details>` : '';
    const body = `
      ${statsRow([
        { cls: 'green', icon: icon('finance'), value: fmtMoney(total), label: 'Recent special offerings' },
        { cls: 'purple', icon: icon('hash'), value: rows.length, label: 'Records shown' },
      ])}
      ${addForm}
      <p><a class="btn ghost" href="/finance/special.csv">⬇ Export CSV</a></p>
      <section class="card">
        <div class="card-head"><h2>Recent special offerings</h2><span class="meta">Building fund, missions, thanksgiving, etc.</span></div>
        ${rows.length ? table(['Date', 'Donor', 'Category', 'Amount', 'Receipt', 'Purpose'],
          rows.map((r) => [
            esc(r.offeringDate.toISOString().slice(0, 10)),
            r.donorId ? `<a href="/members/${r.donor.id}">${esc(r.donor.firstName + ' ' + r.donor.lastName)}</a>` : esc(r.donorNameManual || '(anonymous)'),
            esc(r.specialCategory.categoryName), fmtMoney(r.amount), esc(r.receiptNumber || '—'), esc(r.purpose || '—'),
          ])) : '<p class="muted-text">No special offerings recorded yet.</p>'}
      </section>`;
    res.page({ title: 'Finance · Special Offerings', active: '/finance', noHeader: true, body: `${pageHero('Special Offerings', '')}${body}` });
  }));

  app.get('/finance/special.csv', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const rows = await res.locals.db.specialOffering.findMany({
      where: { deletedAt: null }, orderBy: [{ offeringDate: 'desc' }, { id: 'desc' }],
      include: { specialCategory: { select: { categoryName: true } }, donor: { select: { firstName: true, lastName: true } } },
    });
    sendCsv(res, 'special-offerings.csv', ['Date', 'Donor', 'Category', 'Amount', 'Receipt', 'Purpose', 'Notes'],
      rows.map((r) => [r.offeringDate.toISOString().slice(0, 10),
        r.donorId ? `${r.donor.firstName} ${r.donor.lastName}` : (r.donorNameManual || 'Anonymous'),
        r.specialCategory.categoryName, r.amount, r.receiptNumber || '', r.purpose || '', r.notes || '']));
  }));

  app.post('/finance/special', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    const specialCatId = Number(b.specialCatId);
    if (!specialCatId) { flash(req, 'Pick a special offering category.'); return res.redirect('/finance/special'); }
    if (!isValidDate(b.offeringDate)) { flash(req, 'Enter a valid offering date.'); return res.redirect('/finance/special'); }
    if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/special'); }

    const cat = await db.specialCategory.findUnique({ where: { id: specialCatId } });
    if (!cat) { flash(req, 'Special category not found.'); return res.redirect('/finance/special'); }
    const donorCheck = await checkDonorId(db, b.donorId);
    if (!donorCheck.ok) { flash(req, 'Donor not found.'); return res.redirect('/finance/special'); }
    const donorId = donorCheck.donorId;
    const fundId = await defaultFundId(db);

    const row = await db.specialOffering.create({
      data: {
        specialCatId, offeringDate: new Date(b.offeringDate), donorId, donorNameManual: b.donorNameManual || null,
        amount: Number(b.amount), purpose: b.purpose || null, receiptNumber: b.receiptNumber || null,
        notes: b.notes || null, recordedBy: res.locals.user.id,
      },
    });
    const entryId = await ledger.postCashIncome(db, churchId, {
      date: b.offeringDate, amount: Number(b.amount), incomeAccount: ledger.incomeAccountFor(cat.categoryName),
      fundId, sourceType: 'SPECIAL_OFFERING', sourceId: row.id, createdBy: res.locals.user.id,
      memo: b.purpose || cat.categoryName,
    });
    await db.specialOffering.update({ where: { id: row.id }, data: { journalEntryId: entryId } });
    await logActivity(db, 'contribution_recorded', `Special offering of ${fmtMoney(b.amount)} recorded`, '/finance/special', res.locals.user.id);
    flash(req, 'Special offering recorded.', 'success');
    res.redirect('/finance/special');
  }));

  // --- Tithes (no receipt, no delete route — matches the original) ---
  app.get('/finance/tithes', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const memberId = req.query.memberId ? Number(req.query.memberId) : null;
    const rows = await db.tithe.findMany({
      where: { deletedAt: null, ...(memberId ? { memberId } : {}) }, orderBy: [{ titheDate: 'desc' }, { id: 'desc' }], take: 200,
      include: { member: { select: { id: true, firstName: true, lastName: true, externalId: true } } },
    });
    // Tithe.recordedBy is a plain scalar (no Prisma relation declared on
    // this model), so recorder names are batch-fetched separately and
    // mapped client-side — same pattern used for Announcement.postedBy /
    // Broadcast.sentBy in routes-pg-html/communications.js.
    const recorderIds = [...new Set(rows.map((r) => r.recordedBy).filter(Boolean))];
    const recorders = recorderIds.length ? await db.user.findMany({ where: { id: { in: recorderIds } }, select: { id: true, displayName: true } }) : [];
    const recorderName = (id) => (recorders.find((u) => u.id === id) || {}).displayName || '—';

    const now = new Date();
    const ytdStart = `${now.getFullYear()}-01-01`;
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const [ytdAgg, monthAgg, topTithers] = await Promise.all([
      db.tithe.aggregate({ where: { deletedAt: null, titheDate: { gte: new Date(ytdStart) }, ...(memberId ? { memberId } : {}) }, _sum: { amount: true } }),
      db.tithe.aggregate({ where: { deletedAt: null, titheDate: { gte: new Date(monthStart) }, ...(memberId ? { memberId } : {}) }, _sum: { amount: true } }),
      memberId ? Promise.resolve([]) : db.tithe.groupBy({ by: ['memberId'], where: { deletedAt: null, titheDate: { gte: new Date(ytdStart) } }, _sum: { amount: true }, orderBy: { _sum: { amount: 'desc' } }, take: 10 }),
    ]);
    const topTitherMembers = topTithers.length
      ? await db.member.findMany({ where: { id: { in: topTithers.map((t) => t.memberId) } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const topTitherRows = topTithers.map((t) => {
      const m = topTitherMembers.find((x) => x.id === t.memberId);
      return [m ? `<a href="/members/${m.id}">${esc(m.firstName + ' ' + m.lastName)}</a>` : '—', fmtMoney(t._sum.amount || 0)];
    });

    const addForm = canWrite
      ? `<details class="form-toggle" style="margin-bottom:1rem" ${memberId ? 'open' : ''}>
           <summary><strong>+ Record a tithe</strong></summary>
           <form class="form" method="post" action="/finance/tithes" style="margin-top:0.75rem">
             <label>Member<select name="memberId" required>${memberId ? '' : '<option value="">— pick a member —</option>'}${await requiredMemberOptions(db, memberId)}</select></label>
             <label>Date<input type="date" name="titheDate" required value="${todayISO()}"></label>
             <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
             <label>Method<select name="method">${['cash', 'check', 'card', 'online', 'mobile_money', 'transfer', 'other'].map((m) => `<option value="${m}">${esc(m)}</option>`).join('')}</select></label>
             <label>Reference<input name="reference"></label>
             <label class="wide">Notes<input name="notes"></label>
             <div class="actions"><button type="submit">Save</button></div>
           </form>
         </details>` : '';
    const body = `
      ${statsRow([
        { cls: 'green', icon: icon('finance'), value: fmtMoney(ytdAgg._sum.amount || 0), label: 'YTD tithes' },
        { cls: 'blue', icon: icon('finance'), value: fmtMoney(monthAgg._sum.amount || 0), label: 'This month' },
        { cls: 'purple', icon: icon('hash'), value: rows.length, label: 'Records shown' },
      ])}
      ${memberId ? `<p><a href="/finance/tithes">← All members</a></p>` : ''}
      ${addForm}
      <p><a class="btn ghost" href="/finance/tithes.csv${memberId ? `?memberId=${memberId}` : ''}">⬇ Export CSV</a></p>
      ${!memberId && topTitherRows.length ? `<section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Top tithers (YTD)</h2></div>
        ${table(['Member', 'YTD total'], topTitherRows)}
      </section>` : ''}
      <section class="card">
        <div class="card-head"><h2>${memberId ? 'Tithes for this member' : 'Recent tithes'}</h2></div>
        ${rows.length ? table(['Date', 'Member', 'External ID', 'Amount', 'Method', 'Reference', 'Recorded by'],
          rows.map((r) => [
            esc(r.titheDate.toISOString().slice(0, 10)), `<a href="/members/${r.member.id}">${esc(r.member.firstName + ' ' + r.member.lastName)}</a>`,
            esc(r.member.externalId || '—'), fmtMoney(r.amount), esc(r.method || '—'), esc(r.reference || '—'), esc(recorderName(r.recordedBy)),
          ])) : '<p class="muted-text">No tithes recorded yet.</p>'}
      </section>`;
    res.page({ title: 'Finance · Tithes', active: '/finance', noHeader: true, body: `${pageHero('Tithes', '')}${body}` });
  }));

  app.get('/finance/tithes.csv', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const memberId = req.query.memberId ? Number(req.query.memberId) : null;
    const rows = await res.locals.db.tithe.findMany({
      where: { deletedAt: null, ...(memberId ? { memberId } : {}) }, orderBy: [{ titheDate: 'desc' }, { id: 'desc' }],
      include: { member: { select: { firstName: true, lastName: true, externalId: true } } },
    });
    sendCsv(res, 'tithes.csv', ['Date', 'Member', 'External ID', 'Amount', 'Method', 'Reference', 'Notes'],
      rows.map((r) => [r.titheDate.toISOString().slice(0, 10), `${r.member.firstName} ${r.member.lastName}`,
        r.member.externalId || '', r.amount, r.method || '', r.reference || '', r.notes || '']));
  }));

  app.post('/finance/tithes', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    const memberId = Number(b.memberId);
    // Matches the original exactly: looser validation than day-borns/special
    // (no isValidDate/isMoneyPositive calls there either, silent redirect).
    if (!memberId || !b.amount || !b.titheDate) return res.redirect('/finance/tithes');

    const member = await db.member.findUnique({ where: { id: memberId } });
    if (!member) return res.redirect('/finance/tithes');
    const fundId = await defaultFundId(db);

    const row = await db.tithe.create({
      data: {
        memberId, amount: Number(b.amount), titheDate: new Date(b.titheDate),
        method: b.method || null, reference: b.reference || null, notes: b.notes || null, recordedBy: res.locals.user.id,
      },
    });
    const entryId = await ledger.postCashIncome(db, churchId, {
      date: b.titheDate, amount: Number(b.amount), incomeAccount: ledger.ACC.TITHES,
      fundId, sourceType: 'TITHE', sourceId: row.id, createdBy: res.locals.user.id,
      memo: `Tithe from ${member.firstName} ${member.lastName}`,
    });
    await db.tithe.update({ where: { id: row.id }, data: { journalEntryId: entryId } });
    await logActivity(db, 'contribution_recorded', `Tithe of ${fmtMoney(b.amount)} from ${member.firstName} ${member.lastName}`, '/finance/tithes', res.locals.user.id);
    flash(req, 'Tithe recorded.', 'success');
    res.redirect(`/finance/tithes?memberId=${memberId}`);
  }));

  // --- Services (weekly/service collections, with optional day-born splits) ---
  // No receipt, no payment-method/fund picker — matches the original exactly
  // (services/harvests always post to defaultFundId(), unlike day-borns).
  app.get('/finance/services', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const rows = await db.service.findMany({
      where: { deletedAt: null }, orderBy: [{ serviceDate: 'desc' }, { id: 'desc' }], take: 50,
      include: { serviceType: { select: { typeName: true } } },
    });
    const total = rows.reduce((s, r) => s + Number(r.totalAmount || 0), 0);

    const addForm = canWrite
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Record a service</strong></summary>
           <form class="form" method="post" action="/finance/services" style="margin-top:0.75rem">
             <label>Date<input type="date" name="serviceDate" required value="${todayISO()}"></label>
             <label>Service type<select name="serviceTypeId" required>${await serviceTypeOptions(db, '')}</select></label>
             <label>Total amount (GH₵)<input type="number" step="0.01" min="0" name="totalAmount" value="0" required></label>
             <label class="wide">Notes<input name="notes"></label>
             <fieldset><legend>Day-born breakdown (optional)</legend>${dayBornSplitFormInputs({})}</fieldset>
             <div class="actions"><button type="submit">Save</button></div>
           </form>
         </details>` : '';
    const body = `
      ${statsRow([
        { cls: 'green', icon: icon('finance'), value: fmtMoney(total), label: 'Recent service collections' },
        { cls: 'purple', icon: icon('hash'), value: rows.length, label: 'Records shown' },
      ])}
      ${addForm}
      <section class="card">
        <div class="card-head"><h2>Recent services</h2></div>
        ${rows.length ? table(['Date', 'Type', 'Total', 'Notes', ''],
          rows.map((r) => [
            esc(r.serviceDate.toISOString().slice(0, 10)), esc(r.serviceType.typeName), fmtMoney(r.totalAmount), esc(r.notes || '—'),
            `<a class="link" href="/finance/services/${r.id}">View / edit breakdown</a>`,
          ])) : '<p class="muted-text">No services recorded yet.</p>'}
      </section>`;
    res.page({ title: 'Finance · Services', active: '/finance', noHeader: true, body: `${pageHero('Services', '')}${body}` });
  }));

  app.post('/finance/services', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    if (!Number(b.serviceTypeId)) { flash(req, 'Pick a service type.'); return res.redirect('/finance/services'); }
    if (!isValidDate(b.serviceDate)) { flash(req, 'Enter a valid service date.'); return res.redirect('/finance/services'); }
    if (!isMoneyNonNeg(b.totalAmount)) { flash(req, 'Total amount must be 0 or more.'); return res.redirect('/finance/services'); }
    const serviceTypeCheck = await checkServiceTypeId(db, b.serviceTypeId);
    if (!serviceTypeCheck.ok) { flash(req, 'Service type not found.'); return res.redirect('/finance/services'); }
    const serviceTypeId = serviceTypeCheck.serviceTypeId;

    const service = await db.service.create({
      data: { serviceTypeId, serviceDate: new Date(b.serviceDate), totalAmount: Number(b.totalAmount) || 0, notes: b.notes || null, recordedBy: res.locals.user.id },
    });
    const splits = parseDayBornSplitInputs(b);
    if (splits.length) {
      await db.dayBornSplit.createMany({ data: splits.map((s) => ({ serviceId: service.id, dayBorn: s.dayBorn, amount: s.amount, headCount: s.headCount })) });
    }
    if (Number(b.totalAmount) > 0) {
      const fundId = await defaultFundId(db);
      const entryId = await ledger.postCashIncome(db, churchId, {
        date: b.serviceDate, amount: Number(b.totalAmount), incomeAccount: ledger.ACC.OFFERTORY,
        fundId, sourceType: 'SERVICE', sourceId: service.id, createdBy: res.locals.user.id, memo: 'Service offering',
      });
      await db.service.update({ where: { id: service.id }, data: { journalEntryId: entryId } });
    }
    await logActivity(db, 'income_recorded', `Service recorded: ${fmtMoney(b.totalAmount)}`, `/finance/services/${service.id}`, res.locals.user.id);
    flash(req, 'Service recorded.', 'success');
    res.redirect(`/finance/services/${service.id}`);
  }));

  app.get('/finance/services/:id', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const id = Number(req.params.id);
    const service = await db.service.findFirst({ where: { id, deletedAt: null }, include: { serviceType: { select: { typeName: true } } } });
    if (!service) return res.status(404).send('Not found');
    const splits = await db.dayBornSplit.findMany({ where: { serviceId: id } });
    const splitsByDay = {};
    for (const s of splits) splitsByDay[s.dayBorn] = s;
    const splitTotal = splits.reduce((s, r) => s + Number(r.amount || 0), 0);
    const headTotal = splits.reduce((s, r) => s + (r.headCount || 0), 0);

    const body = `
      <p><a href="/finance/services">← All services</a></p>
      <dl class="stats">
        <dt>Type</dt><dd>${esc(service.serviceType.typeName)}</dd>
        <dt>Date</dt><dd>${esc(service.serviceDate.toISOString().slice(0, 10))}</dd>
        <dt>Total</dt><dd>${fmtMoney(service.totalAmount)}</dd>
        <dt>Notes</dt><dd>${esc(service.notes) || '—'}</dd>
      </dl>
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Day-born breakdown</h2><span class="meta">${fmtMoney(splitTotal)} across ${headTotal} heads</span></div>
        ${table(['Day-born', 'Amount', 'Heads'], DAY_BORN_VALUES.map((d) => [esc(dayBornLabel(d)), fmtMoney((splitsByDay[d] && splitsByDay[d].amount) || 0), (splitsByDay[d] && splitsByDay[d].headCount) || 0]))}
        ${canWrite ? `<form class="form" method="post" action="/finance/services/${id}/splits" style="margin-top:0.75rem">
          ${dayBornSplitFormInputs(splitsByDay)}
          <div class="actions"><button type="submit">Save breakdown</button></div>
        </form>` : ''}
      </section>
      ${canWrite ? `<form method="post" action="/finance/services/${id}/delete" onsubmit="return confirm('Archive this service and reverse its journal entry?')">
        <button class="danger" type="submit">Archive service</button>
      </form>` : ''}`;
    res.page({ title: `Service · ${service.serviceType.typeName}`, active: '/finance', noHeader: true, body: `${pageHero(`Service · ${esc(service.serviceType.typeName)}`, '')}${body}` });
  }));

  app.post('/finance/services/:id/splits', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const service = await db.service.findFirst({ where: { id, deletedAt: null } });
    if (!service) return res.status(404).send('Not found');
    const splits = parseDayBornSplitInputs(req.body || {});
    await db.dayBornSplit.deleteMany({ where: { serviceId: id } });
    if (splits.length) {
      await db.dayBornSplit.createMany({ data: splits.map((s) => ({ serviceId: id, dayBorn: s.dayBorn, amount: s.amount, headCount: s.headCount })) });
    }
    // Splits are a wholesale delete-and-replace, so the previous breakdown is
    // gone with no ledger movement to trace it — log that it changed.
    await logActivity(db, 'finance_splits_updated',
      `Day-born breakdown saved for service #${id} (${splits.length} ${splits.length === 1 ? 'row' : 'rows'})`,
      `/finance/services/${id}`, res.locals.user.id);
    flash(req, 'Breakdown saved.', 'success');
    res.redirect(`/finance/services/${id}`);
  }));

  app.post('/finance/services/:id/delete', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const service = await db.service.findUnique({ where: { id } });
    if (!service) return res.status(404).send('Not found');
    if (service.journalEntryId) await ledger.reverseJournal(db, churchId, service.journalEntryId, 'Service archived', res.locals.user.id);
    await db.service.update({ where: { id }, data: { deletedAt: new Date() } });
    await logActivity(db, 'finance_reversal', `Service #${id} archived and journal reversed`, '/finance/services', res.locals.user.id);
    flash(req, 'Service archived.', 'success');
    res.redirect('/finance/services');
  }));

  // --- Harvests (annual/organizational fundraisers, with day-born splits + read-only pledges) ---
  app.get('/finance/harvests', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const rows = await db.harvest.findMany({
      where: { deletedAt: null }, orderBy: [{ harvestYear: 'desc' }, { id: 'desc' }], take: 50,
      include: { organization: { select: { name: true } } },
    });
    const total = rows.reduce((s, r) => s + Number(r.totalCollected || 0), 0);
    const now = new Date();

    const addForm = canWrite
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Record a harvest</strong></summary>
           <form class="form" method="post" action="/finance/harvests" style="margin-top:0.75rem">
             <label>Type<select name="harvestType" required>${harvestTypeOptions('END_OF_YEAR')}</select></label>
             <label>Year<input type="number" name="harvestYear" required value="${now.getFullYear()}"></label>
             <label class="wide">Name<input name="harvestName" required placeholder="e.g. End of Year Harvest 2026"></label>
             <label>Date<input type="date" name="harvestDate" value="${todayISO()}"></label>
             <label>Organization<select name="orgId">${await orgOptions(db, '')}</select></label>
             <label>Theme<input name="theme"></label>
             <label>Total collected (GH₵)<input type="number" step="0.01" min="0" name="totalCollected" value="0"></label>
             <label class="wide">Notes<input name="notes"></label>
             <div class="actions"><button type="submit">Save</button></div>
           </form>
         </details>` : '';
    const body = `
      ${statsRow([
        { cls: 'green', icon: icon('finance'), value: fmtMoney(total), label: 'Recent harvest totals' },
        { cls: 'purple', icon: icon('hash'), value: rows.length, label: 'Records shown' },
      ])}
      ${addForm}
      <section class="card">
        <div class="card-head"><h2>Recent harvests</h2></div>
        ${rows.length ? table(['Year', 'Name', 'Type', 'Organization', 'Collected', ''],
          rows.map((r) => [
            r.harvestYear, esc(r.harvestName), esc(HARVEST_TYPE_LABELS[r.harvestType] || r.harvestType), esc((r.organization && r.organization.name) || 'Church-wide'),
            fmtMoney(r.totalCollected), `<a class="link" href="/finance/harvests/${r.id}">View / edit</a>`,
          ])) : '<p class="muted-text">No harvests recorded yet.</p>'}
      </section>`;
    res.page({ title: 'Finance · Harvests', active: '/finance', noHeader: true, body: `${pageHero('Harvests', '')}${body}` });
  }));

  app.post('/finance/harvests', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const b = req.body || {};
    // The original had NO server-side validation on harvests at all (relied
    // on now-absent-in-Postgres DB constraints) — deliberately NOT matching
    // that gap: an invalid HarvestType enum value would otherwise throw an
    // unhandled Prisma error instead of a friendly flash message.
    const harvestType = HARVEST_TYPES.includes(b.harvestType) ? b.harvestType : null;
    const harvestYear = Number(b.harvestYear);
    if (!harvestType) { flash(req, 'Pick a valid harvest type.'); return res.redirect('/finance/harvests'); }
    if (!Number.isInteger(harvestYear) || harvestYear < 1900) { flash(req, 'Enter a valid harvest year.'); return res.redirect('/finance/harvests'); }
    if (!b.harvestName || !String(b.harvestName).trim()) { flash(req, 'Enter a harvest name.'); return res.redirect('/finance/harvests'); }
    if (b.harvestDate && !isValidDate(b.harvestDate)) { flash(req, 'Enter a valid harvest date.'); return res.redirect('/finance/harvests'); }
    if (!isMoneyNonNeg(b.totalCollected || 0)) { flash(req, 'Total collected must be 0 or more.'); return res.redirect('/finance/harvests'); }
    const orgCheck = await checkOrgId(db, b.orgId);
    if (!orgCheck.ok) { flash(req, 'Organization not found.'); return res.redirect('/finance/harvests'); }

    const harvest = await db.harvest.create({
      data: {
        harvestType, harvestYear, harvestName: String(b.harvestName).trim(),
        harvestDate: b.harvestDate ? new Date(b.harvestDate) : null,
        orgId: orgCheck.orgId, theme: b.theme || null,
        totalCollected: Number(b.totalCollected) || 0, notes: b.notes || null, recordedBy: res.locals.user.id,
      },
    });
    if (Number(b.totalCollected) > 0) {
      const fundId = await defaultFundId(db);
      const postDate = b.harvestDate || `${harvestYear}-01-01`;
      const entryId = await ledger.postCashIncome(db, churchId, {
        date: postDate, amount: Number(b.totalCollected), incomeAccount: ledger.ACC.HARVEST,
        fundId, sourceType: 'HARVEST', sourceId: harvest.id, createdBy: res.locals.user.id, memo: harvest.harvestName,
      });
      await db.harvest.update({ where: { id: harvest.id }, data: { journalEntryId: entryId } });
    }
    await logActivity(db, 'income_recorded', `Harvest recorded: ${harvest.harvestName} (${fmtMoney(b.totalCollected)})`, `/finance/harvests/${harvest.id}`, res.locals.user.id);
    flash(req, 'Harvest recorded.', 'success');
    res.redirect(`/finance/harvests/${harvest.id}`);
  }));

  app.get('/finance/harvests/:id', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const id = Number(req.params.id);
    const harvest = await db.harvest.findFirst({ where: { id, deletedAt: null }, include: { organization: { select: { name: true } } } });
    if (!harvest) return res.status(404).send('Not found');
    const [splits, pledges] = await Promise.all([
      db.dayBornSplit.findMany({ where: { harvestId: id } }),
      db.pledge.findMany({ where: { harvestId: id }, include: { member: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { pledgeDate: 'desc' } }),
    ]);
    const splitsByDay = {};
    for (const s of splits) splitsByDay[s.dayBorn] = s;
    const splitTotal = splits.reduce((s, r) => s + Number(r.amount || 0), 0);
    const headTotal = splits.reduce((s, r) => s + (r.headCount || 0), 0);
    const totalPledged = pledges.reduce((s, p) => s + Number(p.pledgedAmount || 0), 0);
    const totalPaid = pledges.reduce((s, p) => s + Number(p.paidAmount || 0), 0);

    // Pledges are Phase 9f — this section is deliberately read-only (no
    // create/edit/pay UI here), same as the original's harvest detail page,
    // which only ever displayed pledges and linked out to a separate route.
    const pledgesSection = pledges.length
      ? `<section class="card" style="margin-bottom:1rem">
           <div class="card-head"><h2>Pledges</h2><span class="meta">${fmtMoney(totalPledged)} pledged · ${fmtMoney(totalPaid)} paid</span></div>
           ${table(['Date', 'Member', 'Pledged', 'Paid', 'Status'],
             pledges.map((p) => [esc(p.pledgeDate.toISOString().slice(0, 10)), `<a href="/members/${p.member.id}">${esc(p.member.firstName + ' ' + p.member.lastName)}</a>`,
               fmtMoney(p.pledgedAmount), fmtMoney(p.paidAmount), esc(p.status)]))}
           <p class="muted-text" style="margin-top:0.5rem"><a href="/finance/pledges">Manage pledges →</a></p>
         </section>`
      : `<section class="card" style="margin-bottom:1rem">
           <div class="card-head"><h2>Pledges</h2></div>
           <p class="muted-text">No pledges yet. <a href="/finance/pledges">Add them from the Pledges page</a>.</p>
         </section>`;

    const body = `
      <p><a href="/finance/harvests">← All harvests</a></p>
      <dl class="stats">
        <dt>Name</dt><dd>${esc(harvest.harvestName)}</dd>
        <dt>Type</dt><dd>${esc(HARVEST_TYPE_LABELS[harvest.harvestType] || harvest.harvestType)}</dd>
        <dt>Year</dt><dd>${harvest.harvestYear}</dd>
        <dt>Date</dt><dd>${harvest.harvestDate ? esc(harvest.harvestDate.toISOString().slice(0, 10)) : '—'}</dd>
        <dt>Organization</dt><dd>${esc((harvest.organization && harvest.organization.name) || 'Church-wide')}</dd>
        <dt>Theme</dt><dd>${esc(harvest.theme) || '—'}</dd>
        <dt>Total collected</dt><dd>${fmtMoney(harvest.totalCollected)}</dd>
        <dt>Notes</dt><dd>${esc(harvest.notes) || '—'}</dd>
      </dl>
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Day-born breakdown</h2><span class="meta">${fmtMoney(splitTotal)} across ${headTotal} heads</span></div>
        ${table(['Day-born', 'Amount', 'Heads'], DAY_BORN_VALUES.map((d) => [esc(dayBornLabel(d)), fmtMoney((splitsByDay[d] && splitsByDay[d].amount) || 0), (splitsByDay[d] && splitsByDay[d].headCount) || 0]))}
        ${canWrite ? `<form class="form" method="post" action="/finance/harvests/${id}/splits" style="margin-top:0.75rem">
          ${dayBornSplitFormInputs(splitsByDay)}
          <div class="actions"><button type="submit">Save breakdown</button></div>
        </form>` : ''}
      </section>
      ${pledgesSection}
      ${canWrite ? `<form method="post" action="/finance/harvests/${id}/delete" onsubmit="return confirm('Archive this harvest and reverse its journal entry?')">
        <button class="danger" type="submit">Archive harvest</button>
      </form>` : ''}`;
    res.page({ title: `Harvest · ${harvest.harvestName}`, active: '/finance', noHeader: true, body: `${pageHero(`Harvest · ${esc(harvest.harvestName)}`, '')}${body}` });
  }));

  app.post('/finance/harvests/:id/splits', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const harvest = await db.harvest.findFirst({ where: { id, deletedAt: null } });
    if (!harvest) return res.status(404).send('Not found');
    const splits = parseDayBornSplitInputs(req.body || {});
    await db.dayBornSplit.deleteMany({ where: { harvestId: id } });
    if (splits.length) {
      await db.dayBornSplit.createMany({ data: splits.map((s) => ({ harvestId: id, dayBorn: s.dayBorn, amount: s.amount, headCount: s.headCount })) });
    }
    await logActivity(db, 'finance_splits_updated',
      `Day-born breakdown saved for harvest #${id} (${splits.length} ${splits.length === 1 ? 'row' : 'rows'})`,
      `/finance/harvests/${id}`, res.locals.user.id);
    flash(req, 'Breakdown saved.', 'success');
    res.redirect(`/finance/harvests/${id}`);
  }));

  app.post('/finance/harvests/:id/delete', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const harvest = await db.harvest.findUnique({ where: { id } });
    if (!harvest) return res.status(404).send('Not found');
    if (harvest.journalEntryId) await ledger.reverseJournal(db, churchId, harvest.journalEntryId, 'Harvest archived', res.locals.user.id);
    await db.harvest.update({ where: { id }, data: { deletedAt: new Date() } });
    await logActivity(db, 'finance_reversal', `Harvest #${id} archived and journal reversed`, '/finance/harvests', res.locals.user.id);
    flash(req, 'Harvest archived.', 'success');
    res.redirect('/finance/harvests');
  }));

  // --- Pledges (creation/edit never touch the ledger — only payments do, matching the original) ---
  app.get('/finance/pledges', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const harvestCount = await db.harvest.count({ where: { deletedAt: null } });
    const rows = await db.pledge.findMany({
      where: { member: { deletedAt: null } }, orderBy: [{ pledgeDate: 'desc' }, { id: 'desc' }], take: 100,
      include: { member: { select: { id: true, firstName: true, lastName: true } }, harvest: { select: { harvestName: true } } },
    });

    const addForm = canWrite && harvestCount
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Record a pledge</strong></summary>
           <form class="form" method="post" action="/finance/pledges" style="margin-top:0.75rem">
             <label>Member<select name="memberId" required>${await requiredMemberOptions(db, '')}</select></label>
             <label>Harvest<select name="harvestId" required>${await harvestSelectOptions(db, '')}</select></label>
             <label>Pledged amount<input type="number" step="0.01" min="0.01" name="pledgedAmount" required></label>
             <label>Paid amount<input type="number" step="0.01" min="0" name="paidAmount" value="0"></label>
             <label>Pledge date<input type="date" name="pledgeDate" required value="${todayISO()}"></label>
             <label class="wide">Notes<input name="notes"></label>
             <div class="actions"><button type="submit">Save</button></div>
           </form>
         </details>`
      : (canWrite ? '<p class="muted-text">Add a harvest first on the Harvests page.</p>' : '');
    const tbl = rows.length
      ? table(['Date', 'Member', 'Harvest', 'Pledged', 'Paid', 'Outstanding', 'Status', ''],
          rows.map((p) => [
            esc(p.pledgeDate.toISOString().slice(0, 10)), `<a href="/members/${p.member.id}">${esc(p.member.firstName + ' ' + p.member.lastName)}</a>`,
            esc(p.harvest.harvestName), fmtMoney(p.pledgedAmount), fmtMoney(p.paidAmount), fmtOutstanding(p.pledgedAmount - p.paidAmount),
            `<span class="pill pill-${esc(p.status.toLowerCase())}">${esc(p.status)}</span>`,
            canWrite
              ? `<form method="post" action="/finance/pledges/${p.id}/pay" class="inline">
                   <input type="number" step="0.01" min="0" name="add" placeholder="add">
                   <button type="submit">Record</button>
                 </form>
                 <a class="btn-link" href="/finance/pledges/${p.id}/edit" style="margin-left:0.5rem">Edit</a>` : '',
          ])) : '<p class="muted-text">No pledges recorded yet.</p>';
    const body = `${addForm}${tbl}`;
    res.page({ title: 'Finance · Pledges', active: '/finance', noHeader: true, body: `${pageHero('Pledges', '')}${body}` });
  }));

  app.post('/finance/pledges', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const memberId = Number(b.memberId);
    const harvestId = Number(b.harvestId);
    const pledged = Number(b.pledgedAmount);
    const paid = Number(b.paidAmount || 0);
    if (!memberId || !harvestId || !isMoneyPositive(pledged) || !isValidDate(b.pledgeDate)) {
      flash(req, 'Pick a member, harvest, a valid pledge date, and a pledged amount greater than 0.');
      return res.redirect('/finance/pledges');
    }
    if (!(await checkPledgeRefs(db, memberId, harvestId)).ok) {
      flash(req, 'Member or harvest not found.');
      return res.redirect('/finance/pledges');
    }
    const pledge = await db.pledge.create({
      data: { memberId, harvestId, pledgedAmount: pledged, paidAmount: paid, pledgeDate: new Date(b.pledgeDate), status: pledgeStatusFor(pledged, paid), notes: b.notes || null },
    });
    // Creating a pledge never touches the ledger (only payments do), so this
    // entry is the only record that it happened at all.
    await logActivity(db, 'pledge_created',
      `Pledge recorded: ${fmtMoney(pledged)}`, `/finance/pledges/${pledge.id}/edit`, res.locals.user.id);
    flash(req, 'Pledge recorded.', 'success');
    res.redirect('/finance/pledges');
  }));

  app.post('/finance/pledges/:id/pay', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const add = Number(req.body.add || 0);
    if (add <= 0) return res.redirect('/finance/pledges');
    const receipt = await recordPledgePayment(db, churchId, id, add, todayISO(), res.locals.user.id);
    if (!receipt) return res.redirect('/finance/pledges');
    await logActivity(db, 'pledge_payment', `Recorded ${fmtMoney(add)} pledge payment · receipt ${receipt.receiptNumber}`, `/finance/pledges/payments/${receipt.paymentId}/receipt`, res.locals.user.id);
    res.redirect(`/finance/pledges/payments/${receipt.paymentId}/receipt?new=1`);
  }));

  app.get('/finance/pledges/:id/edit', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const p = await db.pledge.findUnique({ where: { id } });
    if (!p) return res.redirect('/finance/pledges');
    const body = `
      <p><a href="/finance/pledges">← Back to pledges</a></p>
      <form class="form" method="post" action="/finance/pledges/${id}/edit">
        <label>Member<select name="memberId" required>${await requiredMemberOptions(db, p.memberId)}</select></label>
        <label>Harvest<select name="harvestId" required>${await harvestSelectOptions(db, p.harvestId)}</select></label>
        <label>Pledged amount<input type="number" step="0.01" min="0.01" name="pledgedAmount" required value="${p.pledgedAmount}"></label>
        <label>Paid amount<input type="number" step="0.01" min="0" name="paidAmount" value="${p.paidAmount}"></label>
        <label>Pledge date<input type="date" name="pledgeDate" required value="${p.pledgeDate.toISOString().slice(0, 10)}"></label>
        <label class="wide">Notes<input name="notes" value="${esc(p.notes || '')}"></label>
        <div class="actions"><button type="submit">Save changes</button></div>
      </form>`;
    res.page({ title: 'Edit pledge', active: '/finance', noHeader: true, body: `${pageHero('Edit pledge', '')}${body}` });
  }));

  app.post('/finance/pledges/:id/edit', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = req.body || {};
    const pledged = Number(b.pledgedAmount);
    const paid = Number(b.paidAmount || 0);
    if (!(await checkPledgeRefs(db, b.memberId, b.harvestId)).ok) {
      flash(req, 'Member or harvest not found.');
      return res.redirect('/finance/pledges');
    }
    try {
      await db.pledge.update({
        where: { id },
        data: { memberId: Number(b.memberId), harvestId: Number(b.harvestId), pledgedAmount: pledged, paidAmount: paid, pledgeDate: new Date(b.pledgeDate), status: pledgeStatusFor(pledged, paid), notes: b.notes || null },
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    await logActivity(db, 'pledge_edited', `Pledge #${id} edited`, '/finance/pledges', res.locals.user.id);
    flash(req, 'Pledge updated.', 'success');
    res.redirect('/finance/pledges');
  }));

  // --- Pledge payment receipts + outstanding-balance statements ---
  app.get('/finance/pledges/payments/:id/receipt', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const r = await loadPaymentReceipt(db, Number(req.params.id));
    if (!r) return res.status(404).send('Receipt not found');
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const member = r.pledge.member;
    const memberName = `${member.firstName} ${member.lastName}`.trim();
    const outstanding = Number(r.pledge.pledgedAmount) - Number(r.paidToDate);
    const sendForm = canWrite
      ? `<form method="post" action="/finance/pledges/payments/${r.id}/send" onsubmit="return confirm('Send this receipt to ${esc(memberName)} via their preferred channel?')">
           <button type="submit">📤 Send receipt to ${esc(member.firstName)}</button>
         </form>` : '';
    const body = `
      <div class="screen-only receipt-actions">
        <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
        ${sendForm}
        <a class="btn-link" href="/finance/receipts">← Back to receipts</a>
      </div>
      <div class="print-doc receipt-doc">
        <div class="rc-head">
          <div><div class="rc-church">⛪ ${esc(church.name)}</div><div class="muted-text">Pledge Payment Receipt</div></div>
          <div class="rc-no"><strong>${esc(r.receiptNumber)}</strong><br><span class="muted-text">${esc(r.paidOn.toISOString().slice(0, 10))}</span></div>
        </div>
        <div class="rc-line"><span>Received from</span><strong>${esc(memberName)}</strong></div>
        <div class="rc-line"><span>For</span><span>${esc(r.pledge.harvest.harvestName)}${r.pledge.harvest.harvestYear ? ' ' + esc(String(r.pledge.harvest.harvestYear)) : ''} pledge</span></div>
        <div class="rc-line"><span>Amount received</span><strong>${fmtMoney(r.amount)}</strong></div>
        <div class="rc-line"><span>Total pledged</span><span>${fmtMoney(r.pledge.pledgedAmount)}</span></div>
        <div class="rc-line"><span>Paid to date</span><span>${fmtMoney(r.paidToDate)}</span></div>
        <div class="rc-line rc-total"><span>Outstanding balance</span><span>${fmtMoney(outstanding)}</span></div>
        <div class="rc-line"><span>Recorded by</span><span>${esc(r.recordedByName)}</span></div>
        ${r.sentAt ? `<p class="muted-text" style="margin-top:1rem">Sent to member on ${esc(r.sentAt.toISOString().slice(0, 16).replace('T', ' '))}${r.sentChannel ? ` via ${esc(r.sentChannel)}` : ''}.</p>` : ''}
        <p class="rc-foot">${outstanding > 0.005 ? `Thank you. A balance of <strong>${fmtMoney(outstanding)}</strong> remains on this pledge.` : 'This pledge is now fully paid. Thank you!'}</p>
      </div>`;
    res.page({ title: `Receipt ${r.receiptNumber}`, active: '/finance', noHeader: true, flash: RECEIPT_FLASH[req.query.sent] || RECEIPT_FLASH[req.query.new ? 'new' : ''], body });
  }));

  app.post('/finance/pledges/payments/:id/send', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const r = await loadPaymentReceipt(db, Number(req.params.id));
    if (!r) return res.redirect('/finance/receipts');
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const member = r.pledge.member;
    const memberName = `${member.firstName} ${member.lastName}`.trim();
    const outstanding = Number(r.pledge.pledgedAmount) - Number(r.paidToDate);
    const balanceLine = outstanding > 0.005 ? `Outstanding balance: ${fmtMoney(outstanding)}.` : 'This pledge is now fully paid.';
    const when = r.paidOn.toISOString().slice(0, 10);
    const sms = `Receipt ${r.receiptNumber}: Dear ${member.firstName}, we received ${fmtMoney(r.amount)} toward your ${r.pledge.harvest.harvestName} pledge on ${when}. ${balanceLine} Thank you. — ${church.name}`;
    const emailBody = `Dear ${memberName},\n\nThank you for your payment. This is your official receipt.\n\n` +
      `Receipt no:   ${r.receiptNumber}\nDate:         ${when}\nPledge:       ${r.pledge.harvest.harvestName}${r.pledge.harvest.harvestYear ? ' ' + r.pledge.harvest.harvestYear : ''}\n` +
      `Amount paid:  ${fmtMoney(r.amount)}\nTotal pledged:${fmtMoney(r.pledge.pledgedAmount)}\nPaid to date: ${fmtMoney(r.paidToDate)}\n${balanceLine}\n\nGod bless you.\n${church.name}`;
    const result = await sendMemberMessage(db, member, church.name, sms, `Payment receipt ${r.receiptNumber} — ${church.name}`, emailBody);
    if (!result.ok) return res.redirect(`/finance/pledges/payments/${r.id}/receipt?sent=${result.reason === 'do_not_contact' ? 'donotcontact' : 'nocontact'}`);
    await db.pledgePayment.update({ where: { id: r.id }, data: { sentAt: new Date(), sentChannel: result.channels } });
    await logActivity(db, 'receipt_sent', `Sent receipt ${r.receiptNumber} to ${memberName}`, `/finance/pledges/payments/${r.id}/receipt`, res.locals.user.id);
    res.redirect(`/finance/pledges/payments/${r.id}/receipt?sent=${result.dryRun ? 'dry' : 'sent'}`);
  }));

  app.get('/finance/pledges/statement/:memberId', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const data = await memberOutstandingDetail(db, Number(req.params.memberId));
    if (!data) return res.status(404).send('Member not found');
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const { member, pledges } = data;
    const memberName = `${member.firstName} ${member.lastName}`.trim();
    const totalOutstanding = pledges.reduce((a, p) => a + (Number(p.pledgedAmount) - Number(p.paidAmount)), 0);
    const sendForm = canWrite && pledges.length
      ? `<form method="post" action="/finance/pledges/statement/${member.id}/send" onsubmit="return confirm('Send this outstanding-balance statement to ${esc(memberName)}?')">
           <button type="submit">📤 Send statement to ${esc(member.firstName)}</button>
         </form>` : '';
    const rowsHtml = pledges.length
      ? table(['Date', 'Harvest', 'Pledged', 'Paid', 'Outstanding'],
          pledges.map((p) => [esc(p.pledgeDate.toISOString().slice(0, 10)), esc(p.harvest.harvestName), fmtMoney(p.pledgedAmount), fmtMoney(p.paidAmount), fmtOutstanding(p.pledgedAmount - p.paidAmount)]))
      : '<p class="muted-text">This member has no outstanding pledges. 🎉</p>';
    const body = `
      <div class="screen-only receipt-actions">
        <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
        ${sendForm}
        <a class="btn-link" href="/finance/receipts">← Back to receipts</a>
      </div>
      <div class="print-doc receipt-doc">
        <div class="rc-head">
          <div><div class="rc-church">⛪ ${esc(church.name)}</div><div class="muted-text">Outstanding Pledge Statement</div></div>
          <div class="rc-no"><strong>${esc(memberName)}</strong><br><span class="muted-text">As of ${todayISO()}</span></div>
        </div>
        ${rowsHtml}
        ${pledges.length ? `<div class="rc-line rc-total" style="margin-top:0.75rem"><span>Total outstanding</span><span>${fmtMoney(totalOutstanding)}</span></div>
          <p class="rc-foot">Kindly redeem your outstanding pledge${pledges.length > 1 ? 's' : ''} at your earliest convenience. Thank you.</p>` : ''}
      </div>`;
    res.page({ title: `Statement — ${memberName}`, active: '/finance', noHeader: true, flash: RECEIPT_FLASH[req.query.sent], body });
  }));

  app.post('/finance/pledges/statement/:memberId/send', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const data = await memberOutstandingDetail(db, Number(req.params.memberId));
    if (!data) return res.redirect('/finance/receipts');
    const { member, pledges } = data;
    if (!pledges.length) return res.redirect(`/finance/pledges/statement/${member.id}`);
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const memberName = `${member.firstName} ${member.lastName}`.trim();
    const total = pledges.reduce((a, p) => a + (Number(p.pledgedAmount) - Number(p.paidAmount)), 0);
    const lines = pledges.map((p) => `  • ${p.harvest.harvestName}: ${fmtMoney(p.pledgedAmount - p.paidAmount)} outstanding`).join('\n');
    const sms = `Dear ${member.firstName}, our records show a total outstanding pledge balance of ${fmtMoney(total)} across ${pledges.length} pledge(s). Kindly redeem it when you can. Thank you. — ${church.name}`;
    const emailBody = `Dear ${memberName},\n\nThis is a friendly statement of your outstanding pledge balance.\n\n${lines}\n\nTotal outstanding: ${fmtMoney(total)}\n\nKindly redeem your pledge(s) at your earliest convenience.\n\nGod bless you.\n${church.name}`;
    const result = await sendMemberMessage(db, member, church.name, sms, `Your pledge statement — ${church.name}`, emailBody);
    if (!result.ok) return res.redirect(`/finance/pledges/statement/${member.id}?sent=${result.reason === 'do_not_contact' ? 'donotcontact' : 'nocontact'}`);
    await logActivity(db, 'statement_sent', `Sent outstanding-pledge statement to ${memberName}`, `/finance/pledges/statement/${member.id}`, res.locals.user.id);
    res.redirect(`/finance/pledges/statement/${member.id}?sent=${result.dryRun ? 'dry' : 'sent'}`);
  }));

  // --- Unified receipts index + printable income receipts ---
  app.get('/finance/receipts', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const [outstanding, unified, recent] = await Promise.all([
      membersWithOutstanding(db),
      db.financeReceipt.findMany({ orderBy: [{ receiptDate: 'desc' }, { id: 'desc' }], take: 80 }),
      db.pledgePayment.findMany({
        where: { pledge: { member: { deletedAt: null } } }, orderBy: { id: 'desc' }, take: 50,
        include: { pledge: { include: { member: { select: { id: true, firstName: true, lastName: true } }, harvest: { select: { harvestName: true } } } } },
      }),
    ]);
    const totalOutstanding = outstanding.reduce((a, r) => a + r.outstanding, 0);
    const outstandingTbl = outstanding.length
      ? table(['Member', 'Pledges', 'Pledged', 'Paid', 'Outstanding', ''],
          outstanding.map((r) => [`<a href="/members/${r.memberId}">${esc(r.name)}</a>`, r.pledgeCount, fmtMoney(r.pledged), fmtMoney(r.paid), fmtOutstanding(r.outstanding),
            `<a class="btn-link" href="/finance/pledges/statement/${r.memberId}">Statement</a>`]))
      : '<p class="muted-text">No members have outstanding pledges. 🎉</p>';
    const unifiedTbl = unified.length
      ? table(['Receipt', 'Date', 'Received from', 'Type', 'Amount', 'Status', ''],
          unified.map((r) => [esc(r.receiptNumber), esc(r.receiptDate.toISOString().slice(0, 10)), esc(r.receivedFrom || '—'), esc(String(r.sourceType || '').replace(/_/g, ' ')),
            fmtMoney(r.amount), r.voidedAt ? '<span class="pill pill-cancelled">Voided</span>' : '<span class="pill pill-fulfilled">Issued</span>',
            `<a class="btn-link" href="/finance/receipts/${encodeURIComponent(r.receiptNumber)}/print">Print</a>`]))
      : '<p class="muted-text">No all-purpose receipts yet. Record generic income or a day-born collection to issue one.</p>';
    const recentTbl = recent.length
      ? table(['Receipt', 'Date', 'Member', 'Harvest', 'Amount', 'Delivered', ''],
          recent.map((r) => [esc(r.receiptNumber), esc(r.paidOn.toISOString().slice(0, 10)), `<a href="/members/${r.pledge.member.id}">${esc(r.pledge.member.firstName + ' ' + r.pledge.member.lastName)}</a>`,
            esc(r.pledge.harvest.harvestName), fmtMoney(r.amount), r.sentAt ? `<span class="pill pill-fulfilled">${esc(r.sentChannel || 'sent')}</span>` : '<span class="muted-text">not sent</span>',
            `<a class="btn-link" href="/finance/pledges/payments/${r.id}/receipt">View</a>`]))
      : '<p class="muted-text">No payment receipts yet. Record a payment on the Pledges page to issue one.</p>';
    const body = `
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Members with outstanding pledges</h2><span class="meta">Total outstanding: <strong>${fmtMoney(totalOutstanding)}</strong></span></div>
        ${outstandingTbl}
      </section>
      <section class="card" style="margin-bottom:1rem"><h2>Printable income receipts</h2>${unifiedTbl}</section>
      <section class="card"><h2>Recent pledge payment receipts</h2>${recentTbl}</section>`;
    res.page({ title: 'Finance · Receipts', active: '/finance', noHeader: true, body: `${pageHero('Receipts', '')}${body}` });
  }));

  app.get('/finance/receipts/:receiptNo/print', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const receiptNo = decodeURIComponent(req.params.receiptNo);
    const r = await db.financeReceipt.findFirst({ where: { receiptNumber: receiptNo } });
    if (!r) return res.status(404).send('Receipt not found');
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const creator = r.createdBy ? await db.user.findFirst({ where: { id: r.createdBy }, select: { displayName: true } }) : null;
    const createdByName = (creator && creator.displayName) || '—';
    const body = `
      <div class="screen-only receipt-actions">
        <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
        <a class="btn-link" href="/finance/receipts">← Back to receipts</a>
      </div>
      <div class="print-doc receipt-doc">
        <div class="rc-head">
          <div><div class="rc-church">⛪ ${esc(church.name)}</div><div class="muted-text">Official Income Receipt</div></div>
          <div class="rc-no"><strong>${esc(r.receiptNumber)}</strong><br><span class="muted-text">${esc(r.receiptDate.toISOString().slice(0, 10))}</span></div>
        </div>
        ${r.voidedAt ? `<p class="pill pill-cancelled">Voided ${esc(r.voidedAt.toISOString().slice(0, 16).replace('T', ' '))}${r.voidReason ? ': ' + esc(r.voidReason) : ''}</p>` : ''}
        <div class="rc-line"><span>Received from</span><strong>${esc(r.receivedFrom || '—')}</strong></div>
        <div class="rc-line"><span>For</span><span>${esc(r.description || String(r.sourceType || '').replace(/_/g, ' '))}</span></div>
        <div class="rc-line"><span>Receipt type</span><span>${esc(String(r.sourceType || '').replace(/_/g, ' '))}</span></div>
        <div class="rc-line rc-total"><span>Amount received</span><strong>${fmtMoney(r.amount)}</strong></div>
        <div class="rc-line"><span>Recorded by</span><span>${esc(createdByName)}</span></div>
        <p class="rc-foot">Thank you for your support of ${esc(church.name)}.</p>
      </div>`;
    res.page({ title: `Receipt ${r.receiptNumber}`, active: '/finance', noHeader: true, flash: req.query.new ? 'Receipt issued. Print it or save it as PDF.' : null, body });
  }));

  // --- Annual giving statements ---
  app.get('/finance/statements', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const year = safeYear(req.query.year);
    const rows = await givingByMember(db, year);
    const totalGiving = rows.reduce((s, r) => s + r.total, 0);
    const yearSel = `<form method="get" class="filter-bar" style="margin:0">
        <label class="muted-text" style="display:flex;align-items:center;gap:0.4rem">Year
          <select name="year" onchange="this.form.submit()">${givingYears().map((y) => `<option ${String(y) === year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      </form>`;
    const inner = rows.length
      ? table(['Member', 'Gifts', `Total ${year}`, 'Statement'],
          rows.map((r) => [`<a href="/members/${r.memberId}">${esc(r.name)}</a>${r.externalId ? `<div class="muted-text">${esc(r.externalId)}</div>` : ''}`, r.gifts, fmtMoney(r.total),
            `<a class="btn ghost" href="/members/${r.memberId}/statement?year=${year}">View →</a>`]))
      : `<div class="empty-state"><div class="empty-ico" aria-hidden="true">🧾</div><h3>No giving recorded for ${esc(year)}</h3><p>Once contributions are linked to members, you'll see them here. Try a different year.</p></div>`;
    const body = `${pageHero('Giving Statements', 'Per-member annual contribution summaries for year-end records.')}
      ${statsRow([
        { cls: 'gold', icon: icon('receipt'), value: rows.length.toLocaleString(), label: `Givers in ${year}` },
        { cls: 'green', icon: icon('finance'), value: fmtMoney(totalGiving), label: `Attributed Giving ${year}` },
      ], yearSel)}
      ${listCard({ title: `Members with giving in ${year}`, count: rows.length, countLabel: 'members', inner })}`;
    res.page({ title: 'Finance · Statements', active: '/finance', noHeader: true, body });
  }));

  app.get('/members/:id/statement', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const id = Number(req.params.id);
    const m = await db.member.findFirst({ where: { id, deletedAt: null } });
    if (!m) return res.status(404).send('Member not found');
    const year = safeYear(req.query.year);
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const { lines, byGroup, total } = await memberGivingForYear(db, id, year);
    const name = `${m.firstName} ${m.lastName}`.trim();
    const yearSel = `<form method="get" class="screen-only" style="display:inline">
        <label>Year <select name="year" onchange="this.form.submit()">${givingYears().map((y) => `<option ${String(y) === year ? 'selected' : ''}>${y}</option>`).join('')}</select></label></form>`;
    const rowsHtml = lines.length
      ? table(['Date', 'Category', 'Details', 'Amount'], lines.map((l) => [esc(l.dt), esc(l.category), esc(l.detail) || '—', fmtMoney(l.amount)]))
      : `<p class="muted-text">No giving was recorded for ${esc(name)} in ${year}.</p>`;
    const subtotals = Object.entries(byGroup).map(([g, a]) => `<div class="rc-line"><span>${esc(g)}</span><span>${fmtMoney(a)}</span></div>`).join('');
    const body = `
      <div class="screen-only receipt-actions">
        <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
        ${yearSel}
        <a class="btn-link" href="/finance/statements?year=${year}">← Back to statements</a>
      </div>
      <div class="print-doc receipt-doc">
        <div class="rc-head">
          <div><div class="rc-church">⛪ ${esc(church.name)}</div><div class="muted-text">Annual Giving Statement · ${year}</div></div>
          <div class="rc-no"><strong>${esc(name)}</strong><br><span class="muted-text">${esc(m.externalId || '')}</span></div>
        </div>
        ${rowsHtml}
        ${lines.length ? `<div style="margin-top:0.75rem">${subtotals}<div class="rc-line rc-total"><span>Total giving ${year}</span><span>${fmtMoney(total)}</span></div></div>
          <p class="rc-foot">Thank you for your faithful giving. This statement summarises contributions recorded for the ${year} calendar year and is provided for your records. Please retain it for your reference.</p>` : ''}
      </div>`;
    res.page({ title: `Giving Statement — ${name}`, active: '/finance', noHeader: true, body });
  }));

  // --- Payment vouchers (list + print — never independently created) ---
  app.get('/finance/vouchers', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const rows = await db.paymentVoucher.findMany({
      orderBy: [{ voucherDate: 'desc' }, { id: 'desc' }], take: 100,
      include: { expense: { select: { category: true, amount: true, description: true } } },
    });
    const body = `
      <p><a class="btn ghost" href="/finance/vouchers.csv">⬇ Export CSV</a></p>
      <section class="card">
        <div class="card-head"><h2>Payment vouchers</h2><span class="meta">Auto-issued for every expense</span></div>
        ${rows.length ? table(['Voucher #', 'Date', 'Category', 'Description', 'Amount', ''],
          rows.map((v) => [esc(v.voucherNo), esc(v.voucherDate.toISOString().slice(0, 10)), esc(v.expense.category), esc(v.expense.description || '—'),
            fmtMoney(v.expense.amount), `<a class="btn-link" href="/finance/vouchers/${v.id}/print">Print</a>`]))
          : '<p class="muted-text">No vouchers yet. Record an expense to issue one.</p>'}
      </section>`;
    res.page({ title: 'Finance · Vouchers', active: '/finance', noHeader: true, body: `${pageHero('Payment Vouchers', '')}${body}` });
  }));

  app.get('/finance/vouchers.csv', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const rows = await res.locals.db.paymentVoucher.findMany({
      orderBy: [{ voucherDate: 'desc' }, { id: 'desc' }],
      include: { expense: { select: { category: true, amount: true, description: true, paidTo: true } } },
    });
    sendCsv(res, 'payment-vouchers.csv', ['Voucher #', 'Date', 'Category', 'Description', 'Paid to', 'Amount'],
      rows.map((v) => [v.voucherNo, v.voucherDate.toISOString().slice(0, 10), v.expense.category, v.expense.description || '', v.expense.paidTo || '', v.expense.amount]));
  }));

  app.get('/finance/vouchers/:id/print', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const v = await db.paymentVoucher.findFirst({ where: { id: Number(req.params.id) }, include: { expense: true } });
    if (!v) return res.status(404).send('Voucher not found');
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const [preparer, approver, payer] = await Promise.all([
      v.preparedBy ? db.user.findFirst({ where: { id: v.preparedBy }, select: { displayName: true } }) : null,
      v.approvedBy ? db.user.findFirst({ where: { id: v.approvedBy }, select: { displayName: true } }) : null,
      v.paidBy ? db.user.findFirst({ where: { id: v.paidBy }, select: { displayName: true } }) : null,
    ]);
    const body = `
      <div class="screen-only receipt-actions">
        <a class="btn" href="javascript:window.print()">🖨 Print / save as PDF</a>
        <a class="btn-link" href="/finance/vouchers">← Back to vouchers</a>
      </div>
      <div class="print-doc receipt-doc">
        <div class="rc-head">
          <div><div class="rc-church">⛪ ${esc(church.name)}</div><div class="muted-text">Payment Voucher</div></div>
          <div class="rc-no"><strong>${esc(v.voucherNo)}</strong><br><span class="muted-text">${esc(v.voucherDate.toISOString().slice(0, 10))}</span></div>
        </div>
        <div class="rc-line"><span>Paid to</span><strong>${esc(v.expense.paidTo || v.receivedBy || '—')}</strong></div>
        <div class="rc-line"><span>For</span><span>${esc(v.expense.description || v.expense.category)}</span></div>
        <div class="rc-line"><span>Category</span><span>${esc(v.expense.category)}</span></div>
        <div class="rc-line rc-total"><span>Amount</span><strong>${fmtMoney(v.expense.amount)}</strong></div>
        <div class="rc-line"><span>Amount in words</span><span>${esc(v.amountInWords)}</span></div>
        ${v.supportingDocRef ? `<div class="rc-line"><span>Supporting doc ref</span><span>${esc(v.supportingDocRef)}</span></div>` : ''}
        <div class="rc-line"><span>Prepared by</span><span>${esc((preparer && preparer.displayName) || '—')}</span></div>
        <div class="rc-line"><span>Checked by</span><span>${esc(v.checkedBy || '—')}</span></div>
        <div class="rc-line"><span>Approved by</span><span>${esc((approver && approver.displayName) || '—')}</span></div>
        <div class="rc-line"><span>Paid by</span><span>${esc((payer && payer.displayName) || '—')}</span></div>
        <div class="rc-line"><span>Received by</span><span>${esc(v.receivedBy || '—')}</span></div>
        <p class="rc-foot">This voucher was automatically issued when the underlying expense was recorded.</p>
      </div>`;
    res.page({ title: `Voucher ${v.voucherNo}`, active: '/finance', noHeader: true, body });
  }));

  // --- Finance projects ---
  app.get('/finance/projects', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const projects = await db.financeProject.findMany({ orderBy: { name: 'asc' }, include: { fund: { select: { name: true } } } });
    const enriched = await Promise.all(projects.map(async (p) => ({ ...p, ...(await projectFinanceRow(db, churchId, p)) })));

    const addForm = canManage
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Add a project</strong></summary>
           <form class="form" method="post" action="/finance/projects" style="margin-top:0.75rem">
             <label class="wide">Name<input name="name" required></label>
             <label class="wide">Description<input name="description"></label>
             <label>Linked fund<select name="fundId">${await fundOptions(db, '', true)}</select></label>
             <label>Target amount (GH₵)<input type="number" step="0.01" min="0" name="targetAmount" value="0"></label>
             <label>Responsible officer<input name="responsibleOfficer"></label>
             <label>Start date<input type="date" name="startDate"></label>
             <label>End date<input type="date" name="endDate"></label>
             <label>Status<select name="status">${projectStatusOptions('ACTIVE')}</select></label>
             <div class="actions"><button type="submit">Save project</button></div>
           </form>
         </details>` : '';
    const rows = enriched.map((p) => [
      `<a href="/finance/projects/${p.id}">${esc(p.name)}</a>`, esc((p.fund && p.fund.name) || '—'),
      `<span class="pill pill-${esc(p.status.toLowerCase())}">${esc(PROJECT_STATUS_LABELS[p.status])}</span>`,
      fmtMoney(p.targetAmount), fmtMoney(p.raised), fmtMoney(p.spent), `${p.pct}%`,
    ]);
    const body = `${addForm}
      <p><a class="btn ghost" href="/finance/projects.csv">⬇ Export CSV</a></p>
      <section class="card">
        <div class="card-head"><h2>Projects</h2></div>
        ${rows.length ? table(['Name', 'Fund', 'Status', 'Target', 'Raised', 'Spent', '% of target'], rows) : '<p class="muted-text">No projects yet.</p>'}
      </section>`;
    res.page({ title: 'Finance · Projects', active: '/finance', noHeader: true, body: `${pageHero('Finance Projects', '')}${body}` });
  }));

  app.get('/finance/projects.csv', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const projects = await db.financeProject.findMany({ orderBy: { name: 'asc' }, include: { fund: { select: { name: true } } } });
    const enriched = await Promise.all(projects.map(async (p) => ({ ...p, ...(await projectFinanceRow(db, churchId, p)) })));
    sendCsv(res, 'finance-projects.csv', ['Name', 'Fund', 'Status', 'Target', 'Raised', 'Spent', 'Balance'],
      enriched.map((p) => [p.name, (p.fund && p.fund.name) || '', p.status, p.targetAmount, p.raised, p.spent, p.balance]));
  }));

  app.post('/finance/projects', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) { flash(req, 'Enter a project name.'); return res.redirect('/finance/projects'); }
    if (!isMoneyNonNeg(b.targetAmount || 0)) { flash(req, 'Target amount must be 0 or more.'); return res.redirect('/finance/projects'); }
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) { flash(req, 'Fund not found.'); return res.redirect('/finance/projects'); }
    try {
      await db.financeProject.create({
        data: {
          name, description: b.description || null, fundId: fundCheck.fundId,
          targetAmount: Number(b.targetAmount) || 0, responsibleOfficer: b.responsibleOfficer || null,
          startDate: b.startDate ? new Date(b.startDate) : null, endDate: b.endDate ? new Date(b.endDate) : null,
          status: PROJECT_STATUSES.includes(b.status) ? b.status : 'ACTIVE',
        },
      });
      await logActivity(db, 'project_created', `Created finance project ${name}`, '/finance/projects', res.locals.user.id);
      flash(req, 'Project created.', 'success');
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      flash(req, 'A project with that name already exists.');
    }
    res.redirect('/finance/projects');
  }));

  app.get('/finance/projects/:id', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const id = Number(req.params.id);
    const project = await db.financeProject.findUnique({ where: { id }, include: { fund: { select: { name: true } } } });
    if (!project) return res.status(404).send('Not found');
    const { raised, spent, balance, pct } = await projectFinanceRow(db, churchId, project);
    const expenses = await db.expense.findMany({ where: { projectId: id }, orderBy: { spentOn: 'desc' }, take: 50 });
    const body = `
      <p><a href="/finance/projects">← All projects</a></p>
      <dl class="stats">
        <dt>Name</dt><dd>${esc(project.name)}</dd>
        <dt>Status</dt><dd><span class="pill pill-${esc(project.status.toLowerCase())}">${esc(PROJECT_STATUS_LABELS[project.status])}</span></dd>
        <dt>Fund</dt><dd>${esc((project.fund && project.fund.name) || '—')}</dd>
        <dt>Responsible officer</dt><dd>${esc(project.responsibleOfficer) || '—'}</dd>
        <dt>Target</dt><dd>${fmtMoney(project.targetAmount)}</dd>
        <dt>Raised</dt><dd>${fmtMoney(raised)}</dd>
        <dt>Spent</dt><dd>${fmtMoney(spent)}</dd>
        <dt>Balance</dt><dd>${fmtMoney(balance)}</dd>
        <dt>Progress</dt><dd>${pct}%</dd>
        <dt>Description</dt><dd>${esc(project.description) || '—'}</dd>
      </dl>
      ${canManage ? `<p><a class="btn ghost" href="/finance/projects/${id}/edit">Edit project</a></p>` : ''}
      <section class="card">
        <div class="card-head"><h2>Expenses tagged to this project</h2></div>
        <p class="muted-text">Only PAID expenses count toward "Spent" above — SUBMITTED ones are still awaiting a fund manager's approval.</p>
        ${expenses.length ? table(['Date', 'Amount', 'Status', 'Category', 'Description'], expenses.map((e) => [esc(e.spentOn.toISOString().slice(0, 10)), fmtMoney(e.amount), `<span class="pill pill-${esc(e.approvalStatus.toLowerCase())}">${esc(e.approvalStatus)}</span>`, esc(e.category), esc(e.description || '—')]), { keyCols: 3 })
          : '<p class="muted-text">No expenses tagged to this project yet.</p>'}
      </section>`;
    res.page({ title: `Project · ${project.name}`, active: '/finance', noHeader: true, body: `${pageHero(`Project · ${esc(project.name)}`, '')}${body}` });
  }));

  app.get('/finance/projects/:id/edit', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const p = await db.financeProject.findUnique({ where: { id } });
    if (!p) return res.status(404).send('Not found');
    const body = `
      <p><a href="/finance/projects/${id}">← Back to project</a></p>
      <form class="form" method="post" action="/finance/projects/${id}/edit">
        <label class="wide">Name<input name="name" required value="${esc(p.name)}"></label>
        <label class="wide">Description<input name="description" value="${esc(p.description || '')}"></label>
        <label>Linked fund<select name="fundId">${await fundOptions(db, p.fundId, true)}</select></label>
        <label>Target amount (GH₵)<input type="number" step="0.01" min="0" name="targetAmount" value="${p.targetAmount}"></label>
        <label>Responsible officer<input name="responsibleOfficer" value="${esc(p.responsibleOfficer || '')}"></label>
        <label>Start date<input type="date" name="startDate" value="${p.startDate ? p.startDate.toISOString().slice(0, 10) : ''}"></label>
        <label>End date<input type="date" name="endDate" value="${p.endDate ? p.endDate.toISOString().slice(0, 10) : ''}"></label>
        <label>Status<select name="status">${projectStatusOptions(p.status)}</select></label>
        <div class="actions"><button type="submit">Save changes</button></div>
      </form>`;
    res.page({ title: 'Edit project', active: '/finance', noHeader: true, body: `${pageHero('Edit project', '')}${body}` });
  }));

  app.post('/finance/projects/:id/edit', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) { flash(req, 'Enter a project name.'); return res.redirect(`/finance/projects/${id}/edit`); }
    if (!isMoneyNonNeg(b.targetAmount || 0)) { flash(req, 'Target amount must be 0 or more.'); return res.redirect(`/finance/projects/${id}/edit`); }
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) { flash(req, 'Fund not found.'); return res.redirect(`/finance/projects/${id}/edit`); }
    try {
      await db.financeProject.update({
        where: { id },
        data: {
          name, description: b.description || null, fundId: fundCheck.fundId,
          targetAmount: Number(b.targetAmount) || 0, responsibleOfficer: b.responsibleOfficer || null,
          startDate: b.startDate ? new Date(b.startDate) : null, endDate: b.endDate ? new Date(b.endDate) : null,
          status: PROJECT_STATUSES.includes(b.status) ? b.status : 'ACTIVE',
        },
      });
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).send('Not found');
      if (e.code !== 'P2002') throw e;
      flash(req, 'A project with that name already exists.');
      return res.redirect(`/finance/projects/${id}/edit`);
    }
    await logActivity(db, 'project_edited', `Project #${id} edited`, `/finance/projects/${id}`, res.locals.user.id);
    flash(req, 'Project updated.', 'success');
    res.redirect(`/finance/projects/${id}`);
  }));

  // --- Finance budgets ---
  app.get('/finance/budgets', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const budgets = await db.financeBudget.findMany({ orderBy: [{ year: 'desc' }, { id: 'desc' }] });
    const now = new Date();
    const addForm = canManage
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Create a budget</strong></summary>
           <form class="form" method="post" action="/finance/budgets" style="margin-top:0.75rem">
             <label class="wide">Name<input name="name" required placeholder="e.g. ${now.getFullYear()} Annual Budget"></label>
             <label>Year<input type="number" name="year" required value="${now.getFullYear()}"></label>
             <label>Scope<select name="scope" onchange="this.form.month.disabled = this.value !== 'MONTHLY'">
               <option value="ANNUAL">Annual</option><option value="MONTHLY">Monthly</option></select></label>
             <label>Month (if monthly)<input type="number" name="month" min="1" max="12" disabled></label>
             <label class="wide">Notes<input name="notes"></label>
             <div class="actions"><button type="submit">Create</button></div>
           </form>
         </details>` : '';
    const body = `${addForm}
      <section class="card">
        <div class="card-head"><h2>Budgets</h2></div>
        ${budgets.length ? table(['Name', 'Year', 'Scope', 'Status', ''],
          budgets.map((b) => [`<a href="/finance/budgets/${b.id}">${esc(b.name)}</a>`, b.year, b.scope === 'MONTHLY' ? `Monthly (${b.month})` : 'Annual',
            `<span class="pill pill-${esc(b.status.toLowerCase())}">${esc(b.status)}</span>`, '']))
          : '<p class="muted-text">No budgets yet.</p>'}
      </section>`;
    res.page({ title: 'Finance · Budgets', active: '/finance', noHeader: true, body: `${pageHero('Finance Budgets', '')}${body}` });
  }));

  app.post('/finance/budgets', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const year = Number(b.year);
    const name = String(b.name || '').trim();
    if (!name) { flash(req, 'Enter a budget name.'); return res.redirect('/finance/budgets'); }
    if (!Number.isInteger(year)) { flash(req, 'Enter a valid year.'); return res.redirect('/finance/budgets'); }
    const scope = b.scope === 'MONTHLY' ? 'MONTHLY' : 'ANNUAL';
    const month = scope === 'MONTHLY' ? Number(b.month) : null;
    if (scope === 'MONTHLY' && !(month >= 1 && month <= 12)) { flash(req, 'Pick a month (1-12) for a monthly budget.'); return res.redirect('/finance/budgets'); }
    const budget = await db.financeBudget.create({ data: { name, year, month, scope, notes: b.notes || null } });
    await logActivity(db, 'budget_created',
      `Budget created: ${budget.name} (${scope === 'MONTHLY' ? `${year}-${String(month).padStart(2, '0')}` : year})`,
      `/finance/budgets/${budget.id}`, res.locals.user.id);
    flash(req, 'Budget created.', 'success');
    res.redirect(`/finance/budgets/${budget.id}`);
  }));

  app.get('/finance/budgets/:id', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const id = Number(req.params.id);
    const budget = await db.financeBudget.findUnique({ where: { id }, include: { lines: { include: { fund: { select: { name: true } } } } } });
    if (!budget) return res.status(404).send('Not found');
    const win = ledger.budgetWindow(budget);
    const accountIds = [...new Set(budget.lines.map((l) => l.accountId).filter(Boolean))];
    const accounts = accountIds.length ? await db.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true, code: true } }) : [];
    const lines = await Promise.all(budget.lines.map(async (l) => {
      const actual = await ledger.budgetActual(db, churchId, { lineType: l.lineType, accountId: l.accountId, fundId: l.fundId, from: win.from, to: win.to });
      return { ...l, accountLabel: (() => { const a = accounts.find((x) => x.id === l.accountId); return a ? `${a.code} · ${a.name}` : 'All accounts'; })(), actual, variance: Number(l.amount) - actual };
    }));
    const totalBudgeted = lines.reduce((s, l) => s + Number(l.amount), 0);
    const totalActual = lines.reduce((s, l) => s + l.actual, 0);
    const canEditLines = canManage && budget.status !== 'CLOSED';

    const addLineForm = canEditLines
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Add a budget line</strong></summary>
           <form class="form" method="post" action="/finance/budgets/${id}/lines" style="margin-top:0.75rem">
             <label>Type<select name="lineType"><option value="INCOME">Income</option><option value="EXPENSE">Expense</option></select></label>
             <label class="wide">Category label<input name="category" required placeholder="e.g. Tithes, Utilities"></label>
             <label>Account (optional)<select name="accountId">${await accountOptionsForBudget(db, 'INCOME', '')}</select></label>
             <label>Fund (optional)<select name="fundId">${await fundOptions(db, '', true)}</select></label>
             <label>Budgeted amount (GH₵)<input type="number" step="0.01" min="0" name="amount" required></label>
             <label class="wide">Notes<input name="notes"></label>
             <div class="actions"><button type="submit">Add line</button></div>
           </form>
         </details>` : '';
    const statusForm = canManage
      ? `<form method="post" action="/finance/budgets/${id}/status" class="filter-bar" style="margin-bottom:1rem">
           <select name="status">${['DRAFT', 'APPROVED', 'CLOSED'].map((s) => `<option value="${s}" ${s === budget.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
           <button type="submit">Update status</button>
         </form>` : '';
    const body = `
      <p><a href="/finance/budgets">← All budgets</a></p>
      <dl class="stats">
        <dt>Name</dt><dd>${esc(budget.name)}</dd>
        <dt>Period</dt><dd>${budget.scope === 'MONTHLY' ? `Monthly — ${win.from} to ${win.to}` : `Annual — ${budget.year}`}</dd>
        <dt>Status</dt><dd><span class="pill pill-${esc(budget.status.toLowerCase())}">${esc(budget.status)}</span></dd>
        <dt>Notes</dt><dd>${esc(budget.notes) || '—'}</dd>
      </dl>
      ${statusForm}
      <p><a class="btn ghost" href="/finance/budgets/${id}.csv">⬇ Export CSV</a></p>
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Budget vs. actual</h2><span class="meta">Budgeted ${fmtMoney(totalBudgeted)} · Actual ${fmtMoney(totalActual)}</span></div>
        ${lines.length ? table(['Type', 'Category', 'Account', 'Fund', 'Budgeted', 'Actual', 'Variance', canEditLines ? '' : null].filter(Boolean),
          lines.map((l) => [l.lineType, esc(l.category), esc(l.accountLabel), esc((l.fund && l.fund.name) || 'All funds'), fmtMoney(l.amount), fmtMoney(l.actual),
            fmtOutstanding(-l.variance),
            ...(canEditLines ? [`<form method="post" action="/finance/budgets/${id}/lines/${l.id}/delete" onsubmit="return confirm('Remove this budget line?')"><button class="link" type="submit">Remove</button></form>`] : [])]))
          : '<p class="muted-text">No budget lines yet.</p>'}
      </section>
      ${addLineForm}`;
    res.page({ title: `Budget · ${budget.name}`, active: '/finance', noHeader: true, body: `${pageHero(`Budget · ${esc(budget.name)}`, '')}${body}` });
  }));

  app.get('/finance/budgets/:id.csv', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const budget = await db.financeBudget.findUnique({ where: { id }, include: { lines: { include: { fund: { select: { name: true } } } } } });
    if (!budget) return res.status(404).send('Not found');
    const win = ledger.budgetWindow(budget);
    const lines = await Promise.all(budget.lines.map(async (l) => ({ ...l, actual: await ledger.budgetActual(db, churchId, { lineType: l.lineType, accountId: l.accountId, fundId: l.fundId, from: win.from, to: win.to }) })));
    sendCsv(res, `budget-${id}.csv`, ['Type', 'Category', 'Fund', 'Budgeted', 'Actual', 'Variance'],
      lines.map((l) => [l.lineType, l.category, (l.fund && l.fund.name) || 'All funds', l.amount, l.actual, Number(l.amount) - l.actual]));
  }));

  app.post('/finance/budgets/:id/lines', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = req.body || {};
    const budget = await db.financeBudget.findUnique({ where: { id } });
    if (!budget) return res.status(404).send('Not found');
    if (budget.status === 'CLOSED') { flash(req, 'This budget is closed; lines are immutable.'); return res.redirect(`/finance/budgets/${id}`); }
    if (!BUDGET_LINE_TYPES.includes(b.lineType) || !b.category || !String(b.category).trim() || !isMoneyNonNeg(b.amount)) {
      flash(req, 'Pick a type, enter a category label, and a budgeted amount of 0 or more.');
      return res.redirect(`/finance/budgets/${id}`);
    }
    const accountCheck = await checkAccountId(db, b.accountId);
    const fundCheck = await checkFundId(db, b.fundId);
    if (!accountCheck.ok || !fundCheck.ok) { flash(req, 'Account or fund not found.'); return res.redirect(`/finance/budgets/${id}`); }
    const line = await db.financeBudgetLine.create({
      data: { budgetId: id, lineType: b.lineType, category: String(b.category).trim(), accountId: accountCheck.accountId, fundId: fundCheck.fundId, amount: Number(b.amount), notes: b.notes || null },
    });
    await logActivity(db, 'budget_line_added',
      `Budget line added to "${budget.name}": ${line.category} ${fmtMoney(line.amount)}`, `/finance/budgets/${id}`, res.locals.user.id);
    flash(req, 'Budget line added.', 'success');
    res.redirect(`/finance/budgets/${id}`);
  }));

  app.post('/finance/budgets/:id/lines/:lineId/delete', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const budget = await db.financeBudget.findUnique({ where: { id } });
    if (!budget) return res.status(404).send('Not found');
    if (budget.status === 'CLOSED') { flash(req, 'This budget is closed; lines are immutable.'); return res.redirect(`/finance/budgets/${id}`); }
    try {
      const line = await db.financeBudgetLine.delete({ where: { id: Number(req.params.lineId) } });
      await logActivity(db, 'budget_line_removed',
        `Budget line removed from "${budget.name}": ${line.category} ${fmtMoney(line.amount)}`, `/finance/budgets/${id}`, res.locals.user.id);
      flash(req, 'Budget line removed.', 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect(`/finance/budgets/${id}`);
  }));

  app.post('/finance/budgets/:id/status', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const status = req.body && req.body.status;
    if (!['DRAFT', 'APPROVED', 'CLOSED'].includes(status)) { flash(req, 'Pick a valid status.'); return res.redirect(`/finance/budgets/${id}`); }
    try {
      const budget = await db.financeBudget.update({ where: { id }, data: { status } });
      await logActivity(db, 'budget_status_changed',
        `Budget "${budget.name}" set to ${status}`, `/finance/budgets/${id}`, res.locals.user.id);
      flash(req, `Budget status set to ${status}.`, 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    res.redirect(`/finance/budgets/${id}`);
  }));

  // --- Expenses: SUBMITTED on creation, posted to the ledger only once a
  // fund manager other than the recorder approves (maker-checker). ---
  app.get('/finance/expenses', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canWrite = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER', 'CASHIER'].includes(res.locals.user.financeRole);
    const canApprove = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const [cats, rows] = await Promise.all([
      db.expenseCategory.findMany({ where: { isActive: true }, orderBy: { categoryName: 'asc' } }),
      db.expense.findMany({ where: {}, orderBy: [{ spentOn: 'desc' }, { id: 'desc' }], take: 100, include: { expenseCategory: { select: { categoryName: true } }, fund: { select: { name: true } }, project: { select: { name: true } }, paymentVoucher: { select: { id: true, voucherNo: true } } } }),
    ]);
    const catOpts = cats.map((c) => `<option value="${c.id}">${esc(c.categoryName)}</option>`).join('');
    const addForm = canWrite
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Record an expense</strong></summary>
           <form class="form" method="post" action="/finance/expenses" style="margin-top:0.75rem">
             <label>Date<input type="date" name="spentOn" required value="${todayISO()}"></label>
             <label>Category<select name="expenseCatId" required>${catOpts}</select></label>
             <label>Amount (GH₵)<input type="number" step="0.01" min="0.01" name="amount" required></label>
             <label>Payment method<select name="paymentMethod">${['Cash', 'Bank Transfer', 'Cheque', 'Mobile Money', 'Other'].map((m) => `<option>${m}</option>`).join('')}</select></label>
             <label>Fund<select name="fundId">${await fundOptions(db, await defaultFundId(db), false)}</select></label>
             <label>Project<select name="projectId">${await projectOptions(db, '')}</select></label>
             <label class="wide">Description<input name="description" required></label>
             <label>Paid to<input name="paidTo"></label>
             <label>Reference #<input name="referenceNumber"></label>
             <div class="actions"><button type="submit">Save</button></div>
           </form>
         </details>` : '';
    const body = `${addForm}
      ${rows.length ? table(['Date', 'Amount', 'Status', 'Category', 'Description', 'Fund', 'Project', 'Paid to', 'Method', 'Voucher', ...(canApprove ? ['Approval'] : [])],
        rows.map((e) => [esc(e.spentOn.toISOString().slice(0, 10)),
          fmtMoney(e.amount), `<span class="pill pill-${esc(e.approvalStatus.toLowerCase())}">${esc(e.approvalStatus)}</span>`,
          esc((e.expenseCategory && e.expenseCategory.categoryName) || e.category),
          esc(e.description), esc((e.fund && e.fund.name) || '—'), esc((e.project && e.project.name) || '—'), esc(e.paidTo) || '—', esc(e.paymentMethod) || '—',
          e.paymentVoucher ? `<a class="btn-link" href="/finance/vouchers/${e.paymentVoucher.id}/print">${esc(e.paymentVoucher.voucherNo)}</a>` : '—',
          ...(canApprove ? [
            e.approvalStatus === 'SUBMITTED'
              ? (e.recordedBy === res.locals.user.id
                ? '<span class="muted-text">Awaiting another fund manager</span>'
                : `<form method="post" action="/finance/expenses/${e.id}/approve" style="display:inline" onsubmit="return confirm('Approve and pay this expense?')"><button type="submit" class="btn-link">Approve</button></form>
                   <form method="post" action="/finance/expenses/${e.id}/reject" style="display:inline" onsubmit="return confirm('Reject this expense?')"><button type="submit" class="btn-link">Reject</button></form>`)
              : '—',
          ] : [])]), { keyCols: 3 })
        : '<p class="muted-text">No expenses recorded yet.</p>'}`;
    res.page({ title: 'Finance · Expenses', active: '/finance', noHeader: true, body: `${pageHero('Expenses', '')}${body}` });
  }));

  app.post('/finance/expenses', requireFinanceWrite, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    if (!isValidDate(b.spentOn)) { flash(req, 'Enter a valid date.'); return res.redirect('/finance/expenses'); }
    if (!isMoneyPositive(b.amount)) { flash(req, 'Amount must be greater than 0.'); return res.redirect('/finance/expenses'); }
    const cat = b.expenseCatId ? await db.expenseCategory.findUnique({ where: { id: Number(b.expenseCatId) } }) : null;
    const categoryName = (cat && cat.categoryName) || b.category || 'Other';
    const fundCheck = await checkFundId(db, b.fundId);
    if (!fundCheck.ok) { flash(req, 'Fund not found.'); return res.redirect('/finance/expenses'); }
    const fundId = fundCheck.fundId ?? await defaultFundId(db);
    const projectCheck = await checkProjectId(db, b.projectId);
    if (!projectCheck.ok) { flash(req, 'Project not found.'); return res.redirect('/finance/expenses'); }

    // Not posted to the ledger and not paid yet — a fund manager other than
    // the person who recorded this must approve it first (see
    // /finance/expenses/:id/approve below). This is the maker-checker gate:
    // whoever can record an expense should not also be the one who releases
    // the payment for it.
    await db.expense.create({
      data: {
        expenseCatId: cat ? cat.id : null, category: categoryName, amount: Number(b.amount), spentOn: new Date(b.spentOn),
        description: b.description || null, paidTo: b.paidTo || null, paymentMethod: b.paymentMethod || null,
        referenceNumber: b.referenceNumber || null, fundId, projectId: projectCheck.projectId,
        approvalStatus: 'SUBMITTED', submittedAt: new Date(), recordedBy: res.locals.user.id,
      },
    });
    await logActivity(db, 'expense_submitted', `Expense submitted for approval: ${categoryName} (${fmtMoney(b.amount)})`, '/finance/expenses', res.locals.user.id);
    flash(req, 'Expense submitted — a fund manager needs to approve it before it is paid.', 'success');
    res.redirect('/finance/expenses');
  }));

  app.post('/finance/expenses/:id/approve', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const churchId = res.locals.churchId;
    const id = Number(req.params.id);
    const expense = await db.expense.findUnique({ where: { id } });
    if (!expense) return res.status(404).send('Not found');
    if (expense.approvalStatus !== 'SUBMITTED') { flash(req, 'This expense is not awaiting approval.'); return res.redirect('/finance/expenses'); }
    if (expense.recordedBy === res.locals.user.id) { flash(req, 'You cannot approve an expense you recorded yourself — ask another fund manager.'); return res.redirect('/finance/expenses'); }

    const entryId = await ledger.postExpensePayment(db, churchId, {
      date: expense.spentOn.toISOString().slice(0, 10), amount: Number(expense.amount), expenseAccount: ledger.expenseAccountFor(expense.category),
      category: expense.category, fundId: expense.fundId, sourceId: expense.id, createdBy: res.locals.user.id, memo: expense.description || expense.category,
    });
    const updated = await db.expense.update({
      where: { id },
      data: { approvalStatus: 'PAID', approvedBy: res.locals.user.id, approvedAt: new Date(), paidAt: new Date(), journalEntryId: entryId },
    });
    await syncExpenseVoucher(db, updated, res.locals.user.id);
    await logActivity(db, 'expense_approved', `Expense approved and paid: ${expense.category} (${fmtMoney(expense.amount)})`, '/finance/expenses', res.locals.user.id);
    flash(req, 'Expense approved — a payment voucher was issued.', 'success');
    res.redirect('/finance/expenses');
  }));

  app.post('/finance/expenses/:id/reject', requireFundManager, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const expense = await db.expense.findUnique({ where: { id } });
    if (!expense) return res.status(404).send('Not found');
    if (expense.approvalStatus !== 'SUBMITTED') { flash(req, 'This expense is not awaiting approval.'); return res.redirect('/finance/expenses'); }

    await db.expense.update({
      where: { id },
      data: { approvalStatus: 'REJECTED', rejectedAt: new Date(), approvalNote: req.body.note || null },
    });
    await logActivity(db, 'expense_rejected', `Expense rejected: ${expense.category} (${fmtMoney(expense.amount)})`, '/finance/expenses', res.locals.user.id);
    flash(req, 'Expense rejected.', 'success');
    res.redirect('/finance/expenses');
  }));

  // --- Journal entries ---
  app.get('/finance/journal/:id', requireFinanceReportAccess, asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const entry = await db.journalEntry.findUnique({ where: { id: Number(req.params.id) }, include: { lines: { include: { account: true, fund: true } } } });
    if (!entry) return res.status(404).send('Not found');
    const body = `
      <dl class="stats">
        <dt>Entry No</dt><dd>${esc(entry.entryNo)}</dd>
        <dt>Date</dt><dd>${esc(entry.entryDate.toISOString().slice(0, 10))}</dd>
        <dt>Status</dt><dd><span class="pill pill-${esc(entry.status.toLowerCase())}">${esc(entry.status)}</span></dd>
        <dt>Memo</dt><dd>${esc(entry.memo) || '—'}</dd>
      </dl>
      ${table(['Account', 'Fund', 'Debit', 'Credit', 'Memo'],
        entry.lines.map((l) => [esc(l.account.name), esc((l.fund && l.fund.name) || '—'), fmtMoney(l.debit), fmtMoney(l.credit), esc(l.memo) || '—']))}
      ${canManage && entry.status !== 'REVERSED' && !entry.reversesId ? `
        <form method="post" action="/finance/journal/${entry.id}/reverse" onsubmit="return confirm('Reverse this journal entry?')" style="margin-top:1rem">
          <label>Reason<input name="reason" placeholder="Why is this being reversed?"></label>
          <div class="actions"><button class="danger" type="submit">Reverse entry</button></div>
        </form>` : ''}`;
    res.page({ title: `Journal · ${entry.entryNo}`, active: '/finance', noHeader: true, body: `${pageHero(`Journal · ${entry.entryNo}`, '')}${body}` });
  }));

  app.post('/finance/journal/:id/reverse', requireFundManager, asyncHandler(async (req, res) => {
    try {
      await ledger.reverseJournal(res.locals.db, res.locals.churchId, Number(req.params.id), req.body?.reason, res.locals.user.id);
      await logActivity(res.locals.db, 'journal_reversed',
        `Journal entry #${Number(req.params.id)} reversed${req.body?.reason ? `: ${String(req.body.reason).slice(0, 120)}` : ''}`,
        `/finance/journal/${req.params.id}`, res.locals.user.id);
      flash(req, 'Journal entry reversed.', 'success');
    } catch (e) {
      if (!/not found|already reversed/i.test(e.message)) throw e;
      flash(req, e.message);
    }
    res.redirect(`/finance/journal/${req.params.id}`);
  }));

  // --- Financial periods ---
  app.get('/finance/periods', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const canManage = res.locals.user.role === 'ADMIN' || ['FINANCE_ADMIN', 'TREASURER'].includes(res.locals.user.financeRole);
    const canReopen = res.locals.user.role === 'ADMIN';
    const periods = await res.locals.db.financialPeriod.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });
    const now = new Date();
    const lockForm = canManage
      ? `<form class="form" method="post" action="/finance/periods/lock" style="margin-bottom:1rem">
           <label>Year<input type="number" name="year" required value="${now.getFullYear()}"></label>
           <label>Month<input type="number" name="month" min="1" max="12" required value="${now.getMonth() + 1}"></label>
           <div class="actions"><button type="submit">Lock period</button></div>
         </form>` : '';
    const body = `${lockForm}
      ${periods.length ? table(['Year', 'Month', 'Status', 'Closed at', 'Actions'],
        periods.map((p) => [p.year, p.month ?? '—', `<span class="pill pill-${esc(p.status.toLowerCase())}">${esc(p.status)}</span>`,
          p.closedAt ? esc(p.closedAt.toISOString().slice(0, 10)) : '—',
          canReopen && p.status === 'LOCKED' ? `<form method="post" action="/finance/periods/unlock" class="form" style="display:flex;gap:0.5rem;align-items:center" onsubmit="return confirm('Reopen this period for backdated postings?')">
            <input type="hidden" name="year" value="${p.year}"><input type="hidden" name="month" value="${p.month}">
            <input type="text" name="reason" placeholder="Reason for reopening (required)" required style="width:14rem">
            <button class="link" type="submit">Unlock</button></form>` : '']))
        : '<p class="muted-text">No periods locked yet.</p>'}`;
    res.page({ title: 'Finance · Periods', active: '/finance', noHeader: true, body: `${pageHero('Financial Periods', '')}${body}` });
  }));

  app.post('/finance/periods/lock', requireFundManager, asyncHandler(async (req, res) => {
    const year = Number(req.body.year);
    const month = Number(req.body.month);
    if (!Number.isInteger(year) || !Number.isInteger(month)) { flash(req, 'Year and month are required.'); return res.redirect('/finance/periods'); }
    await res.locals.db.financialPeriod.upsert({
      where: { churchId_year_month: { churchId: res.locals.churchId, year, month } },
      update: { status: 'LOCKED', closedAt: new Date(), closedBy: res.locals.user.id },
      create: { year, month, status: 'LOCKED', closedAt: new Date(), closedBy: res.locals.user.id },
    });
    await logActivity(res.locals.db, 'period_locked', `Financial period ${year}-${month} locked`, '/finance/periods', res.locals.user.id);
    flash(req, `Period ${year}-${month} locked.`, 'success');
    res.redirect('/finance/periods');
  }));

  // Reopening a closed period is more sensitive than closing one — it allows
  // backdated postings into a period that was already reviewed and signed
  // off, so this requires admin (requirePeriodReopenAccess, not
  // requireFundManager), a mandatory reason, and its own audit-log entry.
  app.post('/finance/periods/unlock', requirePeriodReopenAccess, asyncHandler(async (req, res) => {
    const year = Number(req.body.year);
    const month = Number(req.body.month);
    const reason = (req.body.reason || '').trim();
    if (!reason) { flash(req, 'Enter a reason for reopening this period.'); return res.redirect('/finance/periods'); }
    try {
      await res.locals.db.financialPeriod.update({
        where: { churchId_year_month: { churchId: res.locals.churchId, year, month } },
        data: { status: 'OPEN', reopenReason: reason, reopenedAt: new Date(), reopenedBy: res.locals.user.id },
      });
      await logActivity(res.locals.db, 'period_reopened', `Financial period ${year}-${month} reopened: ${reason}`, '/finance/periods', res.locals.user.id);
      flash(req, `Period ${year}-${month} unlocked.`, 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      flash(req, 'Period not found.');
    }
    res.redirect('/finance/periods');
  }));
}

module.exports = { register };
