'use strict';
// Phase 8f: the authenticated dashboard (GET / when logged in).
//
// NOT a full port of the original's dashboard — that one is an elaborate
// mockup-style page (sparklines, donut charts, month-over-month giving
// series broken down by harvest/special-offering/service type, Akan
// day-born distribution) built on finance sub-features (harvests, special
// offerings, service-level offerings) that were never ported to this stack
// (see the Phase 8e "Finance scope" decision — deferred, needs new backend
// work, not just HTML). This dashboard aggregates only what the ALREADY-
// PORTED modules track: members, attendance/events, generic income, and
// recent activity — bounded the same way every other Phase 8 module is.

const { esc, fmtMoney } = require('./format');
const { statsRow, listCard, table } = require('./views');

// Individual giving/expense entries (fund names, donor names, amounts) are
// only for roles with finance access — the same check routes-pg-html/
// finance.js's requireFinanceReportAccess uses. Mirrors every "kind" logged
// via logActivity() in finance.js's routes.
const FINANCE_ACTIVITY_KINDS = new Set([
  'contribution_recorded', 'expense_recorded', 'finance_reversal', 'fund_created',
  'income_recorded', 'pledge_edited', 'pledge_payment', 'project_created',
  'project_edited', 'receipt_sent', 'statement_sent',
]);

function canSeeFinance(user) {
  return Boolean(user && (user.role === 'ADMIN' || (user.financeRole && user.financeRole !== 'NONE')));
}

async function renderDashboard(db, user) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const canMoney = canSeeFinance(user);

  const [
    totalMembers, newMembersThisMonth, upcomingEvents, recentAttendance,
    incomeThisMonth, fundCount, ministryCount, orgCount, recentActivityRows,
  ] = await Promise.all([
    db.member.count({ where: { deletedAt: null, membershipStatus: { in: ['MEMBER', 'REGULAR', 'VISITOR'] } } }),
    db.member.count({ where: { deletedAt: null, joinDate: { gte: monthStart } } }),
    db.event.findMany({ where: { startsAt: { gte: now } }, orderBy: { startsAt: 'asc' }, take: 5 }),
    db.attendance.count({ where: { checkedInAt: { gte: weekAgo } } }),
    canMoney ? db.incomeRecord.aggregate({ where: { deletedAt: null, transactionDate: { gte: monthStart } }, _sum: { amount: true } }) : Promise.resolve(null),
    db.fund.count({ where: { active: true } }),
    db.ministry.count(),
    db.organization.count({ where: { active: true } }),
    // Fetch extra rows when finance kinds must be filtered out, so the visible
    // list still fills up to 8 entries rather than being thinned by the filter.
    db.activityLog.findMany({ orderBy: { occurredAt: 'desc' }, take: canMoney ? 8 : 30 }),
  ]);
  const recentActivity = (canMoney ? recentActivityRows : recentActivityRows.filter((a) => !FINANCE_ACTIVITY_KINDS.has(a.kind))).slice(0, 8);

  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const hero = `<section class="dashboard-welcome">
    <div>
      <span class="welcome-eyebrow">${greeting} · ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      <h1>Your ministry at a glance.</h1>
      <p>Stay close to your people, your services and the work that needs attention.</p>
    </div>
    <div class="welcome-actions">
      <a class="btn ghost" href="/events">View calendar</a>
      <a class="btn primary" href="/members/new">Add member <span>＋</span></a>
    </div>
  </section>`;
  const stats = statsRow([
    { cls: 'gold', icon: '👥', value: totalMembers.toLocaleString(), label: 'Members' },
    { cls: 'green', icon: '＋', value: newMembersThisMonth.toLocaleString(), label: 'New this month' },
    { cls: 'blue', icon: '✓', value: recentAttendance.toLocaleString(), label: 'Check-ins (7d)' },
    canMoney
      ? { cls: 'purple', icon: '₵', value: fmtMoney(incomeThisMonth._sum.amount || 0), label: 'Income this month' }
      : { cls: 'purple', icon: '₵', value: '—', label: 'Finance details restricted' },
  ]);

  const quickLinks = `
    <section class="dashboard-section">
      <div class="dashboard-section-head"><div><span>Workspace</span><h2>Quick access</h2></div><a href="/help">Need help? →</a></div>
      <div class="report-tiles dashboard-quick-links">
      <a class="report-tile" href="/members"><div class="ico">👥</div><div><div class="name">Members</div><div class="desc">${totalMembers} total</div></div></a>
      <a class="report-tile" href="/events"><div class="ico">📅</div><div><div class="name">Events</div><div class="desc">${upcomingEvents.length} upcoming</div></div></a>
      <a class="report-tile" href="/finance"><div class="ico">₵</div><div><div class="name">Finance</div><div class="desc">${fundCount} funds</div></div></a>
      <a class="report-tile" href="/bible-classes"><div class="ico">📖</div><div><div class="name">Bible Classes</div><div class="desc">${ministryCount} classes</div></div></a>
      <a class="report-tile" href="/organizations"><div class="ico">♫</div><div><div class="name">Organizations</div><div class="desc">${orgCount} groups</div></div></a>
      <a class="report-tile" href="/reports"><div class="ico">📊</div><div><div class="name">Reports</div><div class="desc">Day-born, income, members</div></div></a>
    </div></section>`;

  const upcomingCard = listCard({
    title: 'Upcoming events', count: upcomingEvents.length, countLabel: 'events',
    inner: upcomingEvents.length
      ? table(['When', 'Title', 'Type'], upcomingEvents.map((e) => [esc(e.startsAt.toISOString().slice(0, 16).replace('T', ' ')), `<a href="/events/${e.id}">${esc(e.title)}</a>`, esc(e.eventType)]))
      : '<div class="empty-state"><div class="empty-ico">◇</div><h3>Your calendar is clear</h3><p>No upcoming events scheduled.</p><a class="btn ghost" href="/events/new">Schedule an event</a></div>',
  });

  const activityCard = listCard({
    title: 'Recent activity', count: recentActivity.length, countLabel: 'events',
    inner: recentActivity.length
      ? `<ul class="check-list">${recentActivity.map((a) => `<li>${a.link ? `<a href="${esc(a.link)}">${esc(a.description)}</a>` : esc(a.description)} <span class="muted-text">· ${esc(a.occurredAt.toISOString().slice(0, 16).replace('T', ' '))}</span></li>`).join('')}</ul>`
      : '<div class="empty-state"><div class="empty-ico">↻</div><h3>Activity will appear here</h3><p>Updates from your team will form a helpful timeline.</p></div>',
  });

  return `<div class="dashboard-v10">${hero}${stats}${quickLinks}<div class="dashboard-feed-grid">${upcomingCard}${activityCard}</div></div>`;
}

module.exports = { renderDashboard };
