'use strict';
// Phase 7 PREP (not production): migrates a SQLite church database into
// Postgres as a single new Church (tenant). Run against the synthetic test
// database by default; point SQLITE_PATH at a real copy of production data
// for an actual staging rehearsal (never at the live production Fly volume
// directly — always a COPY).
//
// Preserves original integer PKs (per the schema design decision — see
// prisma/schema.prisma's header comment) so this is a straight row-copy
// plus one new churchId column, not an ID-remap. Postgres's own serial
// sequences are reset to continue after the highest migrated ID once done,
// so future inserts (new records created after cutover) don't collide with
// migrated historical IDs.
//
// SCOPE: covers ALL ~44 real tables (the schema.sql set, plus the extras
// server.js bootstraps that schema.sql never had — see schema.prisma's own
// header comment) in FK-safe order. `households` and `app_migrations` are
// deliberately skipped, matching schema.prisma's decision to drop them
// (households is dead/wiped-every-boot in the live app; app_migrations is
// SQLite-migration bookkeeping superseded by Prisma).
//
// Handles the two genuine circular FKs in this schema:
//   - members.bible_class_id <-> ministries.leader_id
//   - ministries.org_id -> organizations.leader_id -> members (chained,
//     not itself circular, but organizations must exist before ministries'
//     org_id backfill and members must exist before organizations' leaderId)
// Both via two-pass insert-then-backfill, same technique.
//
// TrialSignup is migrated separately (migrateTrialSignups, called once,
// NOT per-church) since it's genuinely global/pre-tenant data, not owned by
// any one church.

const path = require('path');
const Database = require('better-sqlite3');
const { PrismaClient } = require('@prisma/client');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'synthetic-church.db');
const CHURCH_NAME = process.env.MIGRATE_CHURCH_NAME || 'Dunwell Methodist Church';
const CHURCH_SLUG = process.env.MIGRATE_CHURCH_SLUG || 'dunwell-methodist';

function toBool(v) { return !!v; }
function toDate(v) { return v ? new Date(String(v).replace(' ', 'T')) : null; }
function upper(v) { return v == null ? null : String(v).toUpperCase(); }

async function main() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const prisma = new PrismaClient();
  const counts = {};

  console.log(`Migrating ${SQLITE_PATH} -> Postgres as a new Church...`);

  const church = await prisma.church.create({ data: { name: CHURCH_NAME, slug: CHURCH_SLUG } });
  const churchId = church.id;
  console.log(`Created Church ${churchId} (${CHURCH_SLUG})`);

  // --- users ---
  const users = sqlite.prepare(`SELECT * FROM users`).all();
  for (const u of users) {
    await prisma.user.create({
      data: {
        id: u.user_id, churchId, username: u.username, email: u.email || null,
        passwordHash: u.password_hash, displayName: u.display_name,
        role: upper(u.role), financeRole: upper(u.finance_role || 'none'),
        totpEnabled: toBool(u.totp_enabled), createdAt: toDate(u.created_at) || new Date(),
        deletedAt: toDate(u.deleted_at),
      },
    });
  }
  counts.users = users.length;

  // --- members (pass 1: bibleClassId left null to break the circular FK) ---
  const members = sqlite.prepare(`SELECT * FROM members`).all();
  for (const m of members) {
    await prisma.member.create({
      data: {
        id: m.member_id, churchId, externalId: m.external_id, bibleClassId: null,
        firstName: m.first_name, lastName: m.last_name, email: m.email, mobilePhone: m.mobile_phone,
        dateOfBirth: toDate(m.date_of_birth), dayBorn: upper(m.day_born),
        gender: m.gender || null, maritalStatus: upper(m.marital_status),
        membershipStatus: upper(m.membership_status) || 'VISITOR',
        joinDate: toDate(m.join_date), notes: m.notes,
        preferredChannel: upper(m.preferred_channel) || 'NONE',
        unsubscribeToken: m.unsubscribe_token, createdAt: toDate(m.created_at) || new Date(),
        deletedAt: toDate(m.deleted_at),
      },
    });
  }
  counts.members = members.length;

  // --- ministries (leader_id can reference members, already inserted) ---
  const ministries = sqlite.prepare(`SELECT * FROM ministries`).all();
  for (const mn of ministries) {
    await prisma.ministry.create({
      data: {
        id: mn.ministry_id, churchId, name: mn.name, description: mn.description,
        leaderId: mn.leader_id, orgId: null, // orgId backfilled after organizations, same reasoning
        meetsOn: mn.meets_on, active: toBool(mn.active),
      },
    });
  }
  counts.ministries = ministries.length;

  // --- members pass 2: backfill bibleClassId now that ministries exist ---
  for (const m of members) {
    if (m.bible_class_id) {
      await prisma.member.update({ where: { id: m.member_id }, data: { bibleClassId: m.bible_class_id } });
    }
  }

  // --- organizations ---
  const organizations = sqlite.prepare(`SELECT * FROM organizations`).all();
  for (const o of organizations) {
    await prisma.organization.create({
      data: {
        id: o.org_id, churchId, name: o.name, description: o.description,
        leaderId: o.leader_id, meetsOn: o.meets_on, active: toBool(o.active),
      },
    });
  }
  counts.organizations = organizations.length;

  // --- ministries pass 2: backfill orgId now that organizations exist ---
  for (const mn of ministries) {
    if (mn.org_id) {
      await prisma.ministry.update({ where: { id: mn.ministry_id }, data: { orgId: mn.org_id } });
    }
  }

  // --- organization_memberships ---
  const orgMemberships = sqlite.prepare(`SELECT * FROM organization_memberships`).all();
  for (const om of orgMemberships) {
    await prisma.organizationMembership.create({
      data: { churchId, orgId: om.org_id, memberId: om.member_id, role: om.role, joinedDate: toDate(om.joined_date) || new Date() },
    });
  }
  counts.organization_memberships = orgMemberships.length;

  // --- events ---
  const events = sqlite.prepare(`SELECT * FROM events`).all();
  for (const e of events) {
    await prisma.event.create({
      data: {
        id: e.event_id, churchId, title: e.title, eventType: upper(e.event_type) || 'SERVICE',
        startsAt: toDate(e.starts_at), endsAt: toDate(e.ends_at), location: e.location,
        ministryId: e.ministry_id, notes: e.notes, checkinToken: e.checkin_token,
        attendanceMen: e.attendance_men, attendanceWomen: e.attendance_women,
        attendanceChildren: e.attendance_children, attendanceTotal: e.attendance_total,
      },
    });
  }
  counts.events = events.length;

  // --- attendance ---
  const attendance = sqlite.prepare(`SELECT * FROM attendance`).all();
  for (const a of attendance) {
    await prisma.attendance.create({
      data: { churchId, eventId: a.event_id, memberId: a.member_id, checkedInAt: toDate(a.checked_in_at) || new Date() },
    });
  }
  counts.attendance = attendance.length;

  // --- funds ---
  const funds = sqlite.prepare(`SELECT * FROM funds`).all();
  for (const f of funds) {
    await prisma.fund.create({
      data: {
        id: f.fund_id, churchId, code: f.code, name: f.name, fundType: upper(f.fund_type) || 'GENERAL',
        restricted: toBool(f.restricted), openingBalance: f.opening_balance, active: toBool(f.active),
      },
    });
  }
  counts.funds = funds.length;

  // --- accounts (self-referencing parent_id — insert in ID order so a
  //     parent whose id is numerically smaller than its child is always
  //     already present; the synthetic/real data doesn't use parent_id yet). ---
  const accounts = sqlite.prepare(`SELECT * FROM accounts ORDER BY account_id ASC`).all();
  for (const a of accounts) {
    await prisma.account.create({
      data: {
        id: a.account_id, churchId, code: a.code, name: a.name, accountType: upper(a.account_type),
        normalBalance: upper(a.normal_balance), isSystem: toBool(a.is_system),
        parentId: a.parent_id, active: toBool(a.active),
      },
    });
  }
  counts.accounts = accounts.length;

  // --- financial_periods ---
  const periods = sqlite.prepare(`SELECT * FROM financial_periods`).all();
  for (const p of periods) {
    await prisma.financialPeriod.create({
      data: {
        id: p.period_id, churchId, year: p.year, month: p.month, status: upper(p.status) || 'OPEN',
        closedAt: toDate(p.closed_at), closedBy: p.closed_by, reopenReason: p.reopen_reason,
        createdAt: toDate(p.created_at) || new Date(),
      },
    });
  }
  counts.financial_periods = periods.length;

  // --- journal_entries (reversesId backfilled in a second pass, same
  //     circular-reference reasoning as ministries/organizations above) ---
  const journalEntries = sqlite.prepare(`SELECT * FROM journal_entries`).all();
  for (const je of journalEntries) {
    await prisma.journalEntry.create({
      data: {
        id: je.entry_id, churchId, entryNo: je.entry_no, entryDate: toDate(je.entry_date),
        memo: je.memo, status: upper(je.status) || 'POSTED', sourceType: je.source_type || 'OTHER',
        sourceId: je.source_id, periodId: je.period_id, createdBy: je.created_by,
        createdAt: toDate(je.created_at) || new Date(),
      },
    });
  }
  for (const je of journalEntries) {
    if (je.reverses_id) await prisma.journalEntry.update({ where: { id: je.entry_id }, data: { reversesId: je.reverses_id } });
  }
  counts.journal_entries = journalEntries.length;

  // --- journal_lines ---
  const journalLines = sqlite.prepare(`SELECT * FROM journal_lines`).all();
  for (const jl of journalLines) {
    await prisma.journalLine.create({
      data: {
        id: jl.line_id, churchId, entryId: jl.entry_id, accountId: jl.account_id,
        fundId: jl.fund_id, debit: jl.debit, credit: jl.credit, memo: jl.memo,
      },
    });
  }
  counts.journal_lines = journalLines.length;

  // --- income_records ---
  const incomeRecords = sqlite.prepare(`SELECT * FROM income_records`).all();
  for (const ir of incomeRecords) {
    await prisma.incomeRecord.create({
      data: {
        id: ir.income_id, churchId, transactionDate: toDate(ir.transaction_date), category: ir.category,
        subcategory: ir.subcategory, receivedFrom: ir.received_from, memberId: ir.member_id,
        amount: ir.amount, paymentMethod: ir.payment_method || 'Cash', fundId: ir.fund_id,
        projectId: ir.project_id, referenceNumber: ir.reference_number, description: ir.description,
        receiptNumber: ir.receipt_number, recordedBy: ir.recorded_by, journalEntryId: ir.journal_entry_id,
        deletedAt: toDate(ir.deleted_at), createdAt: toDate(ir.created_at) || new Date(),
      },
    });
  }
  counts.income_records = incomeRecords.length;

  // --- ministry_memberships ---
  const ministryMemberships = sqlite.prepare(`SELECT * FROM ministry_memberships`).all();
  for (const mm of ministryMemberships) {
    await prisma.ministryMembership.create({
      data: {
        churchId, ministryId: mm.ministry_id, memberId: mm.member_id, role: mm.role,
        joinedDate: toDate(mm.joined_date) || new Date(), leftDate: toDate(mm.left_date),
      },
    });
  }
  counts.ministry_memberships = ministryMemberships.length;

  // --- event_rsvps ---
  const eventRsvps = sqlite.prepare(`SELECT * FROM event_rsvps`).all();
  for (const r of eventRsvps) {
    await prisma.eventRsvp.create({
      data: { churchId, eventId: r.event_id, memberId: r.member_id, response: upper(r.response) || 'GOING', respondedAt: toDate(r.responded_at) || new Date() },
    });
  }
  counts.event_rsvps = eventRsvps.length;

  // --- sacraments (spouseId/officiantId are plain scalars, no FK to satisfy) ---
  const sacraments = sqlite.prepare(`SELECT * FROM sacraments`).all();
  for (const s of sacraments) {
    await prisma.sacrament.create({
      data: {
        id: s.sacrament_id, churchId, sacramentType: upper(s.sacrament_type), memberId: s.member_id,
        spouseId: s.spouse_id, officiantId: s.officiant_id, occurredOn: toDate(s.occurred_on),
        location: s.location, notes: s.notes,
      },
    });
  }
  counts.sacraments = sacraments.length;

  // --- pastoral_notes ---
  const pastoralNotes = sqlite.prepare(`SELECT * FROM pastoral_notes`).all();
  for (const p of pastoralNotes) {
    await prisma.pastoralNote.create({
      data: {
        id: p.note_id, churchId, memberId: p.member_id, recordedBy: p.recorded_by,
        occurredOn: toDate(p.occurred_on) || new Date(), category: upper(p.category),
        summary: p.summary, confidential: toBool(p.confidential),
      },
    });
  }
  counts.pastoral_notes = pastoralNotes.length;

  // --- welfare_cases ---
  const welfareCases = sqlite.prepare(`SELECT * FROM welfare_cases`).all();
  for (const w of welfareCases) {
    await prisma.welfareCase.create({
      data: {
        id: w.case_id, churchId, memberId: w.member_id, category: upper(w.category),
        status: upper(w.status) || 'OPEN', amountDisbursed: w.amount_disbursed || 0,
        openedOn: toDate(w.opened_on) || new Date(), closedOn: toDate(w.closed_on),
        summary: w.summary, notes: w.notes,
      },
    });
  }
  counts.welfare_cases = welfareCases.length;

  // --- contributions (legacy giving table; requires fundId, which already exists) ---
  const contributions = sqlite.prepare(`SELECT * FROM contributions`).all();
  for (const c of contributions) {
    await prisma.contribution.create({
      data: {
        id: c.contribution_id, churchId, memberId: c.member_id, fundId: c.fund_id, amount: c.amount,
        contributedOn: toDate(c.contributed_on), method: c.method ? upper(c.method) : null,
        reference: c.reference, notes: c.notes, createdAt: toDate(c.created_at) || new Date(),
      },
    });
  }
  counts.contributions = contributions.length;

  // --- announcements ---
  const announcements = sqlite.prepare(`SELECT * FROM announcements`).all();
  for (const a of announcements) {
    await prisma.announcement.create({
      data: {
        id: a.announcement_id, churchId, title: a.title, body: a.body, audience: a.audience || 'all',
        postedBy: a.posted_by, postedAt: toDate(a.posted_at) || new Date(),
      },
    });
  }
  counts.announcements = announcements.length;

  // --- broadcasts ---
  const broadcasts = sqlite.prepare(`SELECT * FROM broadcasts`).all();
  for (const b of broadcasts) {
    await prisma.broadcast.create({
      data: {
        id: b.broadcast_id, churchId, channel: upper(b.channel), audienceLabel: b.audience_label,
        orgId: b.org_id, subject: b.subject, body: b.body, totalRecipients: b.total_recipients || 0,
        successfulSends: b.successful_sends || 0, failedSends: b.failed_sends || 0,
        status: upper(b.status) || 'PENDING', sentBy: b.sent_by, sentAt: toDate(b.sent_at) || new Date(),
      },
    });
  }
  counts.broadcasts = broadcasts.length;

  // --- broadcast_recipients ---
  const broadcastRecipients = sqlite.prepare(`SELECT * FROM broadcast_recipients`).all();
  for (const r of broadcastRecipients) {
    await prisma.broadcastRecipient.create({
      data: {
        id: r.recipient_id, churchId, broadcastId: r.broadcast_id, memberId: r.member_id,
        channel: r.channel, destination: r.destination, status: upper(r.status) || 'PENDING',
        error: r.error, sentAt: toDate(r.sent_at),
      },
    });
  }
  counts.broadcast_recipients = broadcastRecipients.length;

  // --- activity_log ---
  const activityLog = sqlite.prepare(`SELECT * FROM activity_log`).all();
  for (const a of activityLog) {
    await prisma.activityLog.create({
      data: {
        id: a.activity_id, churchId, occurredAt: toDate(a.occurred_at) || new Date(),
        userId: a.user_id, kind: a.kind, description: a.description, link: a.link,
      },
    });
  }
  counts.activity_log = activityLog.length;

  // --- security_audit_log ---
  const securityAuditLog = sqlite.prepare(`SELECT * FROM security_audit_log`).all();
  for (const a of securityAuditLog) {
    await prisma.securityAuditLog.create({
      data: {
        id: a.audit_id, churchId, occurredAt: toDate(a.occurred_at) || new Date(), actorId: a.actor_id,
        event: a.event, subject: a.subject, ip: a.ip, userAgent: a.user_agent,
      },
    });
  }
  counts.security_audit_log = securityAuditLog.length;

  // --- error_log (churchId is nullable on this model, but every historical
  //     row happened in the context of this one deployment/church, so it's
  //     stamped the same as everything else here) ---
  const errorLog = sqlite.prepare(`SELECT * FROM error_log`).all();
  for (const e of errorLog) {
    await prisma.errorLog.create({
      data: {
        id: e.error_id, churchId, occurredAt: toDate(e.occurred_at) || new Date(),
        method: e.method, path: e.path, message: e.message, stack: e.stack, userId: e.user_id,
      },
    });
  }
  counts.error_log = errorLog.length;

  // --- app_state (was a global singleton keyed by `key`; composite-keyed by
  //     church now — createMany since (churchId, key) can't collide within
  //     one migration run) ---
  const appState = sqlite.prepare(`SELECT * FROM app_state`).all();
  if (appState.length) {
    await prisma.appState.createMany({ data: appState.map((s) => ({ churchId, key: s.key, value: s.value })) });
  }
  counts.app_state = appState.length;

  // --- email_settings (was a global singleton with setting_id=1; at most one row) ---
  const emailSettings = sqlite.prepare(`SELECT * FROM email_settings LIMIT 1`).get();
  if (emailSettings) {
    await prisma.emailSetting.create({
      data: {
        churchId, provider: upper(emailSettings.provider) || 'SMTP', senderName: emailSettings.sender_name || '',
        senderEmail: emailSettings.sender_email || '', replyToEmail: emailSettings.reply_to_email || '',
        testRecipientEmail: emailSettings.test_recipient_email || '',
        createdAt: toDate(emailSettings.created_at) || new Date(),
      },
    });
  }
  counts.email_settings = emailSettings ? 1 : 0;

  // --- email_logs ---
  const emailLogs = sqlite.prepare(`SELECT * FROM email_logs`).all();
  for (const e of emailLogs) {
    await prisma.emailLog.create({
      data: {
        id: e.email_log_id, churchId, occurredAt: toDate(e.occurred_at) || new Date(), recipient: e.recipient,
        subject: e.subject, status: e.status, sentAt: toDate(e.sent_at) || new Date(),
        errorMessage: e.error_message, provider: e.provider, senderName: e.sender_name,
        senderEmail: e.sender_email, replyToEmail: e.reply_to_email,
      },
    });
  }
  counts.email_logs = emailLogs.length;

  // --- password_reset_tokens ---
  const passwordResetTokens = sqlite.prepare(`SELECT * FROM password_reset_tokens`).all();
  for (const t of passwordResetTokens) {
    await prisma.passwordResetToken.create({
      data: {
        id: t.token_id, churchId, userId: t.user_id, token: t.token, expiresAt: toDate(t.expires_at),
        usedAt: toDate(t.used_at), createdAt: toDate(t.created_at) || new Date(),
      },
    });
  }
  counts.password_reset_tokens = passwordResetTokens.length;

  // --- preaching_plan ---
  const preachingPlan = sqlite.prepare(`SELECT * FROM preaching_plan`).all();
  for (const p of preachingPlan) {
    await prisma.preachingPlan.create({
      data: {
        id: p.plan_id, churchId, preachDate: toDate(p.preach_date), serviceLabel: p.service_label,
        memberId: p.member_id, preacherName: p.preacher_name, preacherPhone: p.preacher_phone,
        preacherEmail: p.preacher_email, topic: p.topic, scripture: p.scripture, notes: p.notes,
        reminderSentAt: toDate(p.reminder_sent_at), createdAt: toDate(p.created_at) || new Date(),
        updatedAt: toDate(p.updated_at), deletedAt: toDate(p.deleted_at),
      },
    });
  }
  counts.preaching_plan = preachingPlan.length;

  // --- inventory_items ---
  const inventoryItems = sqlite.prepare(`SELECT * FROM inventory_items`).all();
  for (const i of inventoryItems) {
    await prisma.inventoryItem.create({
      data: {
        id: i.item_id, churchId, name: i.name, quantity: i.quantity || 0, category: i.category,
        acquiredOn: toDate(i.acquired_on), notes: i.notes, createdAt: toDate(i.created_at) || new Date(),
        updatedAt: toDate(i.updated_at), deletedAt: toDate(i.deleted_at),
      },
    });
  }
  counts.inventory_items = inventoryItems.length;

  // --- inventory_categories ---
  const inventoryCategories = sqlite.prepare(`SELECT * FROM inventory_categories`).all();
  for (const c of inventoryCategories) {
    await prisma.inventoryCategory.create({
      data: { id: c.category_id, churchId, name: c.name, createdAt: toDate(c.created_at) || new Date(), deletedAt: toDate(c.deleted_at) },
    });
  }
  counts.inventory_categories = inventoryCategories.length;

  // --- finance_settings (was a global singleton with setting_id=1) ---
  const financeSettings = sqlite.prepare(`SELECT * FROM finance_settings LIMIT 1`).get();
  if (financeSettings) {
    await prisma.financeSetting.create({
      data: {
        churchId, receiptPrefix: financeSettings.receipt_prefix || 'RCT', voucherPrefix: financeSettings.voucher_prefix || 'PV',
        smallExpenseMax: financeSettings.small_expense_max ?? 500, mediumExpenseMax: financeSettings.medium_expense_max ?? 5000,
      },
    });
  }
  counts.finance_settings = financeSettings ? 1 : 0;

  // --- expense_categories (must precede expenses) ---
  const expenseCategories = sqlite.prepare(`SELECT * FROM expense_categories`).all();
  for (const c of expenseCategories) {
    await prisma.expenseCategory.create({
      data: { id: c.expense_cat_id, churchId, categoryName: c.category_name, description: c.description, isActive: toBool(c.is_active ?? 1) },
    });
  }
  counts.expense_categories = expenseCategories.length;

  // --- finance_projects ---
  const financeProjects = sqlite.prepare(`SELECT * FROM finance_projects`).all();
  for (const p of financeProjects) {
    await prisma.financeProject.create({
      data: {
        id: p.project_id, churchId, name: p.name, description: p.description, fundId: p.fund_id,
        targetAmount: p.target_amount || 0, responsibleOfficer: p.responsible_officer,
        startDate: toDate(p.start_date), endDate: toDate(p.end_date), status: upper(p.status) || 'ACTIVE',
        createdAt: toDate(p.created_at) || new Date(),
      },
    });
  }
  counts.finance_projects = financeProjects.length;

  // --- expenses ---
  const expenses = sqlite.prepare(`SELECT * FROM expenses`).all();
  for (const e of expenses) {
    await prisma.expense.create({
      data: {
        id: e.expense_id, churchId, expenseCatId: e.expense_cat_id, category: e.category, amount: e.amount,
        spentOn: toDate(e.spent_on), description: e.description, paidTo: e.paid_to, paymentMethod: e.payment_method,
        referenceNumber: e.reference_number, approvedBy: e.approved_by, receiptAttached: toBool(e.receipt_attached),
        fundId: e.fund_id, projectId: e.project_id, journalEntryId: e.journal_entry_id,
        approvalStatus: upper(e.approval_status) || 'PAID', submittedAt: toDate(e.submitted_at),
        approvedAt: toDate(e.approved_at), paidAt: toDate(e.paid_at), rejectedAt: toDate(e.rejected_at),
        approvalNote: e.approval_note, createdAt: toDate(e.created_at) || new Date(),
      },
    });
  }
  counts.expenses = expenses.length;

  // --- payment_vouchers (1:1 with expenses) ---
  const paymentVouchers = sqlite.prepare(`SELECT * FROM payment_vouchers`).all();
  for (const v of paymentVouchers) {
    await prisma.paymentVoucher.create({
      data: {
        id: v.voucher_id, churchId, voucherNo: v.voucher_no, expenseId: v.expense_id, voucherDate: toDate(v.voucher_date),
        amountInWords: v.amount_in_words, supportingDocRef: v.supporting_doc_ref, preparedBy: v.prepared_by,
        checkedBy: v.checked_by, approvedBy: v.approved_by, paidBy: v.paid_by, receivedBy: v.received_by,
        notes: v.notes, createdAt: toDate(v.created_at) || new Date(),
      },
    });
  }
  counts.payment_vouchers = paymentVouchers.length;

  // --- finance_budgets ---
  const financeBudgets = sqlite.prepare(`SELECT * FROM finance_budgets`).all();
  for (const b of financeBudgets) {
    await prisma.financeBudget.create({
      data: {
        id: b.budget_id, churchId, name: b.name, year: b.year, month: b.month, scope: upper(b.scope) || 'ANNUAL',
        status: upper(b.status) || 'DRAFT', notes: b.notes, createdAt: toDate(b.created_at) || new Date(),
      },
    });
  }
  counts.finance_budgets = financeBudgets.length;

  // --- finance_budget_lines ---
  const financeBudgetLines = sqlite.prepare(`SELECT * FROM finance_budget_lines`).all();
  for (const l of financeBudgetLines) {
    await prisma.financeBudgetLine.create({
      data: {
        id: l.line_id, churchId, budgetId: l.budget_id, lineType: l.line_type, category: l.category,
        accountId: l.account_id, fundId: l.fund_id, amount: l.amount, notes: l.notes,
      },
    });
  }
  counts.finance_budget_lines = financeBudgetLines.length;

  // --- day_born_collections ---
  const dayBornCollections = sqlite.prepare(`SELECT * FROM day_born_collections`).all();
  for (const c of dayBornCollections) {
    await prisma.dayBornCollection.create({
      data: {
        id: c.collection_id, churchId, collectionDate: toDate(c.collection_date), dayBorn: upper(c.day_born),
        amount: c.amount, headCount: c.head_count || 0, paymentMethod: c.payment_method || 'Cash', fundId: c.fund_id,
        referenceNumber: c.reference_number, receiptNumber: c.receipt_number, recordedBy: c.recorded_by,
        journalEntryId: c.journal_entry_id, notes: c.notes, deletedAt: toDate(c.deleted_at),
        createdAt: toDate(c.created_at) || new Date(),
      },
    });
  }
  counts.day_born_collections = dayBornCollections.length;

  // --- finance_receipts ---
  const financeReceipts = sqlite.prepare(`SELECT * FROM finance_receipts`).all();
  for (const r of financeReceipts) {
    await prisma.financeReceipt.create({
      data: {
        id: r.receipt_id, churchId, receiptNumber: r.receipt_number, sourceType: r.source_type, sourceId: r.source_id,
        receiptDate: toDate(r.receipt_date), receivedFrom: r.received_from, amount: r.amount, description: r.description,
        createdBy: r.created_by, createdAt: toDate(r.created_at) || new Date(), voidedAt: toDate(r.voided_at), voidReason: r.void_reason,
      },
    });
  }
  counts.finance_receipts = financeReceipts.length;

  // --- tithes ---
  const tithes = sqlite.prepare(`SELECT * FROM tithes`).all();
  for (const t of tithes) {
    await prisma.tithe.create({
      data: {
        id: t.tithe_id, churchId, memberId: t.member_id, amount: t.amount, titheDate: toDate(t.tithe_date),
        method: t.method, reference: t.reference, notes: t.notes, recordedBy: t.recorded_by,
        journalEntryId: t.journal_entry_id, deletedAt: toDate(t.deleted_at), createdAt: toDate(t.created_at) || new Date(),
      },
    });
  }
  counts.tithes = tithes.length;

  // --- service_types (must precede services) ---
  const serviceTypes = sqlite.prepare(`SELECT * FROM service_types`).all();
  for (const st of serviceTypes) {
    await prisma.serviceType.create({
      data: { id: st.service_type_id, churchId, typeName: st.type_name, description: st.description, isActive: toBool(st.is_active ?? 1), createdAt: toDate(st.created_at) || new Date() },
    });
  }
  counts.service_types = serviceTypes.length;

  // --- services ---
  const services = sqlite.prepare(`SELECT * FROM services`).all();
  for (const s of services) {
    await prisma.service.create({
      data: {
        id: s.service_id, churchId, serviceTypeId: s.service_type_id, serviceDate: toDate(s.service_date),
        totalAmount: s.total_amount || 0, recordedBy: s.recorded_by, journalEntryId: s.journal_entry_id,
        notes: s.notes, deletedAt: toDate(s.deleted_at), createdAt: toDate(s.created_at) || new Date(),
      },
    });
  }
  counts.services = services.length;

  // --- harvests ---
  const harvests = sqlite.prepare(`SELECT * FROM harvests`).all();
  for (const h of harvests) {
    await prisma.harvest.create({
      data: {
        id: h.harvest_id, churchId, harvestType: upper(h.harvest_type), harvestName: h.harvest_name,
        harvestYear: h.harvest_year, harvestDate: toDate(h.harvest_date), theme: h.theme, orgId: h.org_id,
        totalCollected: h.total_collected || 0, recordedBy: h.recorded_by, journalEntryId: h.journal_entry_id,
        notes: h.notes, deletedAt: toDate(h.deleted_at), createdAt: toDate(h.created_at) || new Date(),
      },
    });
  }
  counts.harvests = harvests.length;

  // --- day_born_splits (needs services and/or harvests, both already migrated) ---
  const dayBornSplits = sqlite.prepare(`SELECT * FROM day_born_splits`).all();
  for (const s of dayBornSplits) {
    await prisma.dayBornSplit.create({
      data: {
        id: s.split_id, churchId, serviceId: s.service_id, harvestId: s.harvest_id, dayBorn: upper(s.day_born),
        amount: s.amount || 0, headCount: s.head_count || 0, createdAt: toDate(s.created_at) || new Date(),
      },
    });
  }
  counts.day_born_splits = dayBornSplits.length;

  // --- special_categories (must precede special_offerings) ---
  const specialCategories = sqlite.prepare(`SELECT * FROM special_categories`).all();
  for (const c of specialCategories) {
    await prisma.specialCategory.create({
      data: { id: c.special_cat_id, churchId, categoryName: c.category_name, description: c.description, isActive: toBool(c.is_active ?? 1), createdAt: toDate(c.created_at) || new Date() },
    });
  }
  counts.special_categories = specialCategories.length;

  // --- special_offerings ---
  const specialOfferings = sqlite.prepare(`SELECT * FROM special_offerings`).all();
  for (const o of specialOfferings) {
    await prisma.specialOffering.create({
      data: {
        id: o.special_id, churchId, specialCatId: o.special_cat_id, offeringDate: toDate(o.offering_date),
        donorId: o.donor_id, donorNameManual: o.donor_name_manual, amount: o.amount, purpose: o.purpose,
        receiptNumber: o.receipt_number, recordedBy: o.recorded_by, journalEntryId: o.journal_entry_id,
        notes: o.notes, deletedAt: toDate(o.deleted_at), createdAt: toDate(o.created_at) || new Date(),
      },
    });
  }
  counts.special_offerings = specialOfferings.length;

  // --- pledges (needs members + harvests, both already migrated) ---
  const pledges = sqlite.prepare(`SELECT * FROM pledges`).all();
  for (const p of pledges) {
    await prisma.pledge.create({
      data: {
        id: p.pledge_id, churchId, memberId: p.member_id, harvestId: p.harvest_id, pledgedAmount: p.pledged_amount,
        paidAmount: p.paid_amount || 0, pledgeDate: toDate(p.pledge_date), status: upper(p.status) || 'PENDING',
        notes: p.notes, createdAt: toDate(p.created_at) || new Date(),
      },
    });
  }
  counts.pledges = pledges.length;

  // --- pledge_payments ---
  const pledgePayments = sqlite.prepare(`SELECT * FROM pledge_payments`).all();
  for (const p of pledgePayments) {
    await prisma.pledgePayment.create({
      data: {
        id: p.payment_id, churchId, pledgeId: p.pledge_id, amount: p.amount, paidOn: toDate(p.paid_on),
        receiptNumber: p.receipt_number, recordedBy: p.recorded_by, journalEntryId: p.journal_entry_id,
        sentAt: toDate(p.sent_at), sentChannel: p.sent_channel, notes: p.notes, createdAt: toDate(p.created_at) || new Date(),
      },
    });
  }
  counts.pledge_payments = pledgePayments.length;

  // --- reset Postgres sequences so future auto-increments continue past the migrated max id ---
  const sequenceTargets = [
    ['users', 'user_id'], ['members', 'member_id'], ['ministries', 'ministry_id'],
    ['organizations', 'org_id'], ['events', 'event_id'], ['funds', 'fund_id'],
    ['accounts', 'account_id'], ['financial_periods', 'period_id'],
    ['journal_entries', 'entry_id'], ['journal_lines', 'line_id'], ['income_records', 'income_id'],
    ['sacraments', 'sacrament_id'], ['pastoral_notes', 'note_id'], ['welfare_cases', 'case_id'],
    ['contributions', 'contribution_id'], ['announcements', 'announcement_id'], ['broadcasts', 'broadcast_id'],
    ['broadcast_recipients', 'recipient_id'], ['activity_log', 'activity_id'], ['security_audit_log', 'audit_id'],
    ['error_log', 'error_id'], ['email_logs', 'email_log_id'], ['password_reset_tokens', 'token_id'],
    ['preaching_plan', 'plan_id'], ['inventory_items', 'item_id'], ['inventory_categories', 'category_id'],
    ['expense_categories', 'expense_cat_id'], ['finance_projects', 'project_id'], ['expenses', 'expense_id'],
    ['payment_vouchers', 'voucher_id'], ['finance_budgets', 'budget_id'], ['finance_budget_lines', 'line_id'],
    ['day_born_collections', 'collection_id'], ['finance_receipts', 'receipt_id'], ['tithes', 'tithe_id'],
    ['service_types', 'service_type_id'], ['services', 'service_id'], ['harvests', 'harvest_id'],
    ['day_born_splits', 'split_id'], ['special_categories', 'special_cat_id'], ['special_offerings', 'special_id'],
    ['pledges', 'pledge_id'], ['pledge_payments', 'payment_id'],
  ];
  for (const [table, column] of sequenceTargets) {
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', '${column}'), COALESCE((SELECT MAX("${column}") FROM "${table}"), 1), true)`
    );
  }

  console.log('Row counts migrated:', counts);

  sqlite.close();
  await prisma.$disconnect();
  return { churchId, counts };
}

/**
 * Migrates `trial_signups` — genuinely global, pre-tenant marketing-funnel
 * data, not owned by any one church (see schema.prisma: TrialSignup is a
 * GLOBAL_MODEL in lib/tenant.js). Run once, separately from the per-church
 * main() migration, not per new church.
 */
async function migrateTrialSignups(sqlitePathOverride) {
  const sqlite = new Database(sqlitePathOverride || SQLITE_PATH, { readonly: true });
  const prisma = new PrismaClient();
  const rows = sqlite.prepare(`SELECT * FROM trial_signups`).all();
  for (const s of rows) {
    await prisma.trialSignup.create({
      data: {
        id: s.signup_id, churchName: s.church_name, contactName: s.contact_name, role: s.role,
        phone: s.phone, email: s.email, plan: upper(s.plan) || 'PRO', memberCount: s.member_count,
        notes: s.notes, status: s.status || 'new', activationToken: s.activation_token,
        activationSentAt: toDate(s.activation_sent_at), activationExpiresAt: toDate(s.activation_expires_at),
        activatedAt: toDate(s.activated_at), activatedUserId: s.activated_user_id,
        createdAt: toDate(s.created_at) || new Date(),
      },
    });
  }
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('"trial_signups"', 'signup_id'), COALESCE((SELECT MAX("signup_id") FROM "trial_signups"), 1), true)`
  );
  console.log(`Migrated ${rows.length} trial_signups (global, not church-scoped).`);
  sqlite.close();
  await prisma.$disconnect();
  return rows.length;
}

if (require.main === module) {
  main().catch((e) => { console.error('MIGRATION FAILED:', e); process.exit(1); });
}

module.exports = { main, migrateTrialSignups };
