'use strict';
// Cross-tenant SaaS-owner portal. This is the one intentionally unscoped
// HTML surface in the app; every handler is gated before touching rawDb.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { db: rawDb } = require('../lib/tenant');
const { isPro } = require('../routes-pg/settings');
const { requestIp, requestUserAgent } = require('../lib/security-audit');

function platformAdminEmails() {
  return String(process.env.PLATFORM_ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function requirePlatformAdmin(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  const email = String(res.locals.user.email || '').toLowerCase();
  if (platformAdminEmails().includes(email)) return next();
  return res.status(403).send('Platform admin only');
}

function isoDate(value) {
  return value ? value.toISOString().slice(0, 10) : '—';
}

function dateTime(value) {
  return value ? value.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '—';
}

function accessState(church) {
  if (church.deletedAt) return 'deleted';
  if (church.suspendedAt) return 'suspended';
  return 'active';
}

function planPill(church) {
  return isPro(church)
    ? '<span class="pill pill-fulfilled">Pro</span>'
    : '<span class="pill pill-pending">Free</span>';
}

function accessPill(church) {
  const state = accessState(church);
  if (state === 'deleted') return '<span class="pill pill-overdue">Deleted</span>';
  if (state === 'suspended') return '<span class="pill pill-overdue">Suspended</span>';
  return '<span class="pill pill-fulfilled">Active</span>';
}

function platformReturn(req, fallback = '/platform') {
  const ref = String(req.get('referer') || '');
  try {
    const url = new URL(ref);
    const host = String(req.get('host') || '');
    if (url.host === host && (url.pathname === '/platform' || url.pathname.startsWith('/platform/'))) {
      return `${url.pathname}${url.search}`;
    }
  } catch (_) {}
  return fallback;
}

function buildChurchWhere(query) {
  const q = String(query.q || '').trim();
  const plan = String(query.plan || 'all');
  const status = String(query.status || 'all');
  const where = {};
  const and = [];

  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
      ],
    });
  }
  if (plan === 'free' || plan === 'pro') and.push({ plan });
  if (status === 'active') and.push({ suspendedAt: null, deletedAt: null });
  if (status === 'suspended') and.push({ suspendedAt: { not: null }, deletedAt: null });
  if (status === 'deleted') and.push({ deletedAt: { not: null } });
  if (and.length) where.AND = and;
  return where;
}

function portalFilters(query) {
  const q = esc(query.q || '');
  const plan = String(query.plan || 'all');
  const status = String(query.status || 'all');
  const selected = (value, current) => value === current ? 'selected' : '';
  return `<div class="card platform-filters">
    <div class="card-head"><h2>Find churches</h2><span class="meta">Search tenants, plans and access states</span></div>
    <form method="get" action="/platform" class="filter-bar">
      <div class="search-field"><span aria-hidden="true">🔎</span>
        <input type="search" name="q" value="${q}" placeholder="Search church name or slug">
      </div>
      <select name="plan" aria-label="Plan">
        <option value="all" ${selected('all', plan)}>All plans</option>
        <option value="free" ${selected('free', plan)}>Free</option>
        <option value="pro" ${selected('pro', plan)}>Pro</option>
      </select>
      <select name="status" aria-label="Access status">
        <option value="all" ${selected('all', status)}>All statuses</option>
        <option value="active" ${selected('active', status)}>Active</option>
        <option value="suspended" ${selected('suspended', status)}>Suspended</option>
        <option value="deleted" ${selected('deleted', status)}>Deleted</option>
      </select>
      <button type="submit">Apply</button>
      <a class="btn ghost" href="/platform">Reset</a>
    </form>
  </div>`;
}

function quickControls(church, compact = false) {
  const months = `<input type="number" name="months" placeholder="months" min="1" ${compact ? '' : 'style="width:88px"'}>`;
  const planForm = `<form method="post" action="/platform/churches/${church.id}/plan" class="inline platform-inline-form">
    <select name="plan">
      <option value="free" ${church.plan === 'free' ? 'selected' : ''}>free</option>
      <option value="pro" ${church.plan === 'pro' ? 'selected' : ''}>pro</option>
    </select>
    ${months}
    <button type="submit">${church.plan === 'pro' ? 'Update plan' : 'Upgrade'}</button>
  </form>`;

  if (church.deletedAt) {
    return `${planForm}<form method="post" action="/platform/churches/${church.id}/access" class="inline platform-inline-form">
      <input type="hidden" name="action" value="restore">
      <button type="submit">Restore church</button>
    </form>`;
  }
  if (church.suspendedAt) {
    return `${planForm}<form method="post" action="/platform/churches/${church.id}/access" class="inline platform-inline-form">
      <input type="hidden" name="action" value="reactivate">
      <button type="submit">Reactivate</button>
    </form>`;
  }
  return `${planForm}<form method="post" action="/platform/churches/${church.id}/access" class="inline platform-inline-form"
      onsubmit="return confirm('Suspend access for this church? Its users will be blocked immediately.')">
      <input type="hidden" name="action" value="suspend">
      <input name="reason" required maxlength="500" placeholder="Suspension reason">
      <button type="submit" class="danger">Suspend</button>
    </form>
    <form method="post" action="/platform/churches/${church.id}/access" class="inline platform-inline-form"
      onsubmit="return confirm('Delete this church? Access will be blocked immediately, but the platform owner can restore it.')">
      <input type="hidden" name="action" value="delete">
      <input name="confirmSlug" required placeholder="Type ${esc(church.slug)}">
      <input name="reason" required maxlength="500" placeholder="Deletion reason">
      <button type="submit" class="danger">Delete</button>
    </form>`;
}

async function platformStats() {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    churchCount, userCount, memberCount, proCount, suspendedCount, deletedCount,
    recentChurches, trialCount, openErrors,
  ] = await Promise.all([
    rawDb.church.count(),
    rawDb.user.count({ where: { deletedAt: null } }),
    rawDb.member.count({ where: { deletedAt: null } }),
    rawDb.church.count({ where: { plan: 'pro' } }),
    rawDb.church.count({ where: { suspendedAt: { not: null }, deletedAt: null } }),
    rawDb.church.count({ where: { deletedAt: { not: null } } }),
    rawDb.church.count({ where: { createdAt: { gte: since30 } } }),
    rawDb.trialSignup.count().catch(() => 0),
    rawDb.errorLog.count({ where: { occurredAt: { gte: since30 } } }).catch(() => 0),
  ]);
  return {
    churchCount, userCount, memberCount, proCount, suspendedCount, deletedCount,
    activeCount: Math.max(0, churchCount - suspendedCount - deletedCount),
    recentChurches, trialCount, openErrors,
  };
}

function ownerSummaryCards(stats) {
  return `${statsRow([
    { cls: 'gold', icon: '▣', value: stats.churchCount.toLocaleString(), label: 'Churches onboarded' },
    { cls: 'green', icon: '✓', value: stats.activeCount.toLocaleString(), label: 'Active churches' },
    { cls: 'blue', icon: '★', value: stats.proCount.toLocaleString(), label: 'Pro churches' },
    { cls: 'purple', icon: '👥', value: stats.memberCount.toLocaleString(), label: 'Members managed' },
  ])}
  <div class="platform-mini-grid">
    <div><strong>${stats.userCount.toLocaleString()}</strong><span>Total staff users</span></div>
    <div><strong>${stats.recentChurches.toLocaleString()}</strong><span>New churches in 30 days</span></div>
    <div><strong>${stats.suspendedCount.toLocaleString()}</strong><span>Suspended churches</span></div>
    <div><strong>${stats.deletedCount.toLocaleString()}</strong><span>Deleted churches</span></div>
    <div><strong>${stats.trialCount.toLocaleString()}</strong><span>Trial enquiries</span></div>
    <div><strong>${stats.openErrors.toLocaleString()}</strong><span>Errors in 30 days</span></div>
  </div>`;
}

async function renderPlatformIndex(req, res) {
  const where = buildChurchWhere(req.query || {});
  const [stats, churches, recentAudit, recentErrors] = await Promise.all([
    platformStats(),
    rawDb.church.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 250,
      include: { _count: { select: { users: true, members: true, events: true, broadcasts: true } } },
    }),
    rawDb.securityAuditLog.findMany({
      orderBy: { occurredAt: 'desc' },
      take: 8,
      include: { church: { select: { name: true, slug: true } } },
    }),
    rawDb.errorLog.findMany({
      orderBy: { occurredAt: 'desc' },
      take: 6,
      include: { church: { select: { name: true, slug: true } } },
    }).catch(() => []),
  ]);

  const rows = churches.map((c) => [
    `<a class="platform-church-link" href="/platform/churches/${c.id}"><strong>${esc(c.name)}</strong><small>${esc(c.slug)}</small></a>`,
    `${planPill(c)}${c.proUntil ? `<small>Until ${isoDate(c.proUntil)}</small>` : ''}`,
    `${accessPill(c)}${c.suspensionReason ? `<small>${esc(c.suspensionReason)}</small>` : ''}${c.deletionReason ? `<small>${esc(c.deletionReason)}</small>` : ''}`,
    `<span class="platform-usage"><strong>${c._count.users}</strong> users</span><span class="platform-usage"><strong>${c._count.members}</strong> members</span>`,
    `<span class="platform-usage"><strong>${c._count.events}</strong> events</span><span class="platform-usage"><strong>${c._count.broadcasts}</strong> broadcasts</span>`,
    esc(isoDate(c.createdAt)),
    `<div class="platform-actions"><a class="btn ghost" href="/platform/churches/${c.id}">Manage</a></div>`,
  ]);

  const auditRows = recentAudit.map((a) => [
    esc(dateTime(a.occurredAt)),
    a.church ? `<a href="/platform/churches/${a.churchId}">${esc(a.church.name)}</a><small>${esc(a.church.slug)}</small>` : '—',
    esc(a.event),
    esc(a.subject || '—'),
  ]);

  const errorRows = recentErrors.map((e) => [
    esc(dateTime(e.occurredAt)),
    e.church ? `<a href="/platform/churches/${e.churchId}">${esc(e.church.name)}</a><small>${esc(e.church.slug)}</small>` : 'Platform',
    esc(e.path || '—'),
    esc(e.message || '—'),
  ]);

  const body = `
    ${pageHero('SaaS Owner Portal', 'Manage every church, plan, access state, user footprint and operational signal across the platform.')}
    ${ownerSummaryCards(stats)}
    ${portalFilters(req.query || {})}
    ${listCard({
      title: 'Churches onboarded', count: churches.length, countLabel: churches.length === 1 ? 'church' : 'churches',
      note: churches.length >= 250 ? 'Showing latest 250 matches' : '',
      inner: churches.length ? table(['Church', 'Plan', 'Access', 'People', 'Activity', 'Signed up', ''], rows, { keyCols: 3 }) : '<div class="empty-state"><div class="empty-ico">▣</div><h3>No churches match these filters</h3><p>Try clearing search or status filters.</p></div>',
    })}
    <div class="platform-two-col">
      ${listCard({
        title: 'Recent platform audit', count: recentAudit.length, countLabel: 'events',
        inner: auditRows.length ? table(['When', 'Church', 'Event', 'Subject'], auditRows, { keyCols: 2 }) : '<p class="muted-text">No audit events yet.</p>',
      })}
      ${listCard({
        title: 'Recent errors', count: recentErrors.length, countLabel: 'errors',
        inner: errorRows.length ? table(['When', 'Church', 'Path', 'Message'], errorRows, { keyCols: 2 }) : '<p class="muted-text">No recent errors.</p>',
      })}
    </div>`;
  res.page({ title: 'SaaS Owner Portal', active: '/platform', noHeader: true, body });
}

async function renderChurchDetail(req, res) {
  const id = req.params.id;
  const church = await rawDb.church.findUnique({
    where: { id },
    include: { _count: { select: {
      users: true, members: true, events: true, attendance: true, broadcasts: true,
      incomeRecords: true, expenses: true, funds: true, journalEntries: true,
      securityAuditLogs: true, errorLogs: true,
    } } },
  });
  if (!church) return res.status(404).send('Church not found');

  const [users, recentAudit, recentActivity, recentBroadcasts, recentErrors, lastEmail] = await Promise.all([
    rawDb.user.findMany({
      where: { churchId: id, deletedAt: null },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      take: 50,
      select: { id: true, username: true, email: true, displayName: true, role: true, financeRole: true, createdAt: true, totpEnabled: true },
    }),
    rawDb.securityAuditLog.findMany({ where: { churchId: id }, orderBy: { occurredAt: 'desc' }, take: 12 }),
    rawDb.activityLog.findMany({ where: { churchId: id }, orderBy: { occurredAt: 'desc' }, take: 10 }),
    rawDb.broadcast.findMany({ where: { churchId: id }, orderBy: { sentAt: 'desc' }, take: 8 }),
    rawDb.errorLog.findMany({ where: { churchId: id }, orderBy: { occurredAt: 'desc' }, take: 8 }).catch(() => []),
    rawDb.emailLog.findFirst({ where: { churchId: id }, orderBy: { occurredAt: 'desc' } }).catch(() => null),
  ]);

  const userRows = users.map((u) => [
    `<strong>${esc(u.displayName || u.username)}</strong><small>${esc(u.username)}</small>`,
    esc(u.email || '—'),
    `<span class="pill">${esc(u.role)}</span>`,
    esc(u.financeRole),
    u.totpEnabled ? '<span class="pill pill-fulfilled">2FA</span>' : '<span class="muted-text">—</span>',
    esc(isoDate(u.createdAt)),
  ]);

  const auditRows = recentAudit.map((a) => [
    esc(dateTime(a.occurredAt)), esc(a.event), esc(a.subject || '—'), esc(a.ip || '—'),
  ]);
  const activityRows = recentActivity.map((a) => [
    esc(dateTime(a.occurredAt)), esc(a.kind), a.link ? `<a href="${esc(a.link)}">${esc(a.description)}</a>` : esc(a.description),
  ]);
  const broadcastRows = recentBroadcasts.map((b) => [
    esc(dateTime(b.sentAt)), esc(b.channel), esc(b.audienceLabel),
    `<span class="pill">${esc(b.status)}</span>`,
    `${b.successfulSends}/${b.totalRecipients}`,
  ]);
  const errorRows = recentErrors.map((e) => [
    esc(dateTime(e.occurredAt)), esc(e.method || '—'), esc(e.path || '—'), esc(e.message || '—'),
  ]);

  const accessNote = church.deletedAt
    ? `<p class="error">Deleted: ${esc(church.deletionReason || 'No reason recorded')}. Purge eligible ${isoDate(church.deletionPurgeAfter)}.</p>`
    : church.suspendedAt
      ? `<p class="error">Suspended: ${esc(church.suspensionReason || 'No reason recorded')}.</p>`
      : '<p class="success">This church currently has active access.</p>';

  const body = `
    <div class="platform-detail-top">
      <a class="btn ghost" href="/platform">← All churches</a>
    </div>
    ${pageHero(church.name, `${church.slug} · Signed up ${isoDate(church.createdAt)}`)}
    <div class="platform-detail-grid">
      <div class="card platform-status-card">
        <div class="card-head"><h2>Account state</h2><span class="meta">${accessPill(church)} ${planPill(church)}</span></div>
        ${accessNote}
        <dl class="platform-dl">
          <dt>Plan</dt><dd>${esc(church.plan)}${church.proUntil ? ` until ${isoDate(church.proUntil)}` : ''}</dd>
          <dt>Created</dt><dd>${esc(dateTime(church.createdAt))}</dd>
          <dt>Updated</dt><dd>${esc(dateTime(church.updatedAt))}</dd>
          <dt>Last email</dt><dd>${lastEmail ? `${esc(lastEmail.status)} · ${esc(dateTime(lastEmail.occurredAt))}` : '—'}</dd>
        </dl>
      </div>
      <div class="card platform-control-card">
        <div class="card-head"><h2>Owner controls</h2><span class="meta">Plan and access</span></div>
        <div class="platform-control-stack">${quickControls(church, true)}</div>
      </div>
    </div>
    ${statsRow([
      { cls: 'gold', icon: '🔑', value: church._count.users.toLocaleString(), label: 'Users' },
      { cls: 'green', icon: '👥', value: church._count.members.toLocaleString(), label: 'Members' },
      { cls: 'blue', icon: '📅', value: church._count.events.toLocaleString(), label: 'Events' },
      { cls: 'purple', icon: '✉', value: church._count.broadcasts.toLocaleString(), label: 'Broadcasts' },
      { cls: 'orange', icon: '₵', value: church._count.journalEntries.toLocaleString(), label: 'Journal entries' },
    ])}
    <div class="platform-mini-grid">
      <div><strong>${church._count.attendance.toLocaleString()}</strong><span>Attendance rows</span></div>
      <div><strong>${church._count.incomeRecords.toLocaleString()}</strong><span>Income records</span></div>
      <div><strong>${church._count.expenses.toLocaleString()}</strong><span>Expenses</span></div>
      <div><strong>${church._count.funds.toLocaleString()}</strong><span>Funds</span></div>
      <div><strong>${church._count.securityAuditLogs.toLocaleString()}</strong><span>Audit events</span></div>
      <div><strong>${church._count.errorLogs.toLocaleString()}</strong><span>Error logs</span></div>
    </div>
    ${listCard({
      title: 'Users and roles', count: users.length, countLabel: 'users',
      inner: userRows.length ? table(['Name', 'Email', 'Role', 'Finance', 'Security', 'Created'], userRows, { keyCols: 2 }) : '<p class="muted-text">No active users.</p>',
    })}
    <div class="platform-two-col">
      ${listCard({
        title: 'Recent audit', count: recentAudit.length, countLabel: 'events',
        inner: auditRows.length ? table(['When', 'Event', 'Subject', 'IP'], auditRows, { keyCols: 2 }) : '<p class="muted-text">No audit events.</p>',
      })}
      ${listCard({
        title: 'Recent activity', count: recentActivity.length, countLabel: 'events',
        inner: activityRows.length ? table(['When', 'Kind', 'Description'], activityRows, { keyCols: 2 }) : '<p class="muted-text">No activity yet.</p>',
      })}
    </div>
    <div class="platform-two-col">
      ${listCard({
        title: 'Broadcasts', count: recentBroadcasts.length, countLabel: 'broadcasts',
        inner: broadcastRows.length ? table(['When', 'Channel', 'Audience', 'Status', 'Sent'], broadcastRows, { keyCols: 2 }) : '<p class="muted-text">No broadcasts yet.</p>',
      })}
      ${listCard({
        title: 'Errors', count: recentErrors.length, countLabel: 'errors',
        inner: errorRows.length ? table(['When', 'Method', 'Path', 'Message'], errorRows, { keyCols: 2 }) : '<p class="muted-text">No errors logged.</p>',
      })}
    </div>`;
  return res.page({ title: `${church.name} · Platform`, active: '/platform', noHeader: true, body });
}

function register(app) {
  app.get('/platform', requirePlatformAdmin, asyncHandler(renderPlatformIndex));
  app.get('/platform/churches/:id', requirePlatformAdmin, asyncHandler(renderChurchDetail));

  app.post('/platform/churches/:id/plan', requirePlatformAdmin, asyncHandler(async (req, res) => {
    const { plan, months } = req.body || {};
    if (!['free', 'pro'].includes(plan)) { flash(req, 'Plan must be "free" or "pro".'); return res.redirect(platformReturn(req)); }
    const data = { plan };
    if (plan === 'pro') {
      data.proSince = new Date();
      data.proUntil = months ? new Date(Date.now() + Number(months) * 30 * 24 * 60 * 60 * 1000) : null;
    } else {
      data.proSince = null;
      data.proUntil = null;
    }
    try {
      const church = await rawDb.church.update({ where: { id: req.params.id }, data });
      await rawDb.securityAuditLog.create({ data: {
        churchId: church.id, actorId: res.locals.user.id,
        event: plan === 'pro' ? 'platform.plan_upgraded' : 'platform.plan_downgraded',
        subject: `${church.name} (${church.slug}) -> ${plan}`,
        ip: requestIp(req), userAgent: requestUserAgent(req),
      } });
      flash(req, plan === 'pro' ? 'Church upgraded to Pro.' : 'Church downgraded to Free.', 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      flash(req, 'Church not found.');
    }
    res.redirect(platformReturn(req));
  }));

  app.post('/platform/churches/:id/access', requirePlatformAdmin, asyncHandler(async (req, res) => {
    const action = String(req.body?.action || '');
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!['suspend', 'reactivate', 'delete', 'restore'].includes(action)) {
      flash(req, 'Invalid access action.');
      return res.redirect(platformReturn(req));
    }
    if (['suspend', 'delete'].includes(action) && !reason) {
      flash(req, 'A reason is required.');
      return res.redirect(platformReturn(req));
    }
    try {
      const existing = await rawDb.church.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        flash(req, 'Church not found.');
        return res.redirect(platformReturn(req));
      }
      if (action === 'delete' && String(req.body?.confirmSlug || '') !== existing.slug) {
        flash(req, `Type ${existing.slug} exactly to confirm deletion.`);
        return res.redirect(platformReturn(req));
      }
      const data = action === 'suspend'
        ? { suspendedAt: new Date(), suspensionReason: reason }
        : action === 'reactivate'
          ? { suspendedAt: null, suspensionReason: null }
          : action === 'delete'
            ? {
              deletedAt: new Date(), deletionReason: reason,
              deletionPurgeAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            }
            : { deletedAt: null, deletionReason: null, deletionPurgeAfter: null };
      const church = await rawDb.church.update({ where: { id: req.params.id }, data });
      const events = {
        suspend: 'platform.church_suspended', reactivate: 'platform.church_reactivated',
        delete: 'platform.church_deleted', restore: 'platform.church_restored',
      };
      await rawDb.securityAuditLog.create({ data: {
        churchId: church.id, actorId: res.locals.user.id,
        event: events[action],
        subject: ['suspend', 'delete'].includes(action) ? reason : `${church.name} ${action}d`,
        ip: requestIp(req), userAgent: requestUserAgent(req),
      } });
      const messages = {
        suspend: 'Church access suspended.', reactivate: 'Church access reactivated.',
        delete: 'Church deleted. Its data remains recoverable.', restore: 'Church restored.',
      };
      flash(req, messages[action], 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      flash(req, 'Church not found.');
    }
    return res.redirect(platformReturn(req));
  }));
}

module.exports = { register };
