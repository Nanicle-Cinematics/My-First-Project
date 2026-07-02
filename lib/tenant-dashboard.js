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
const { pageHero, statsRow, listCard, table } = require('./views');

async function renderDashboard(db) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekAgo = new Date(Date.now() - 7 * 86400000);

  const [
    totalMembers, newMembersThisMonth, upcomingEvents, recentAttendance,
    incomeThisMonth, fundCount, ministryCount, orgCount, recentActivity,
  ] = await Promise.all([
    db.member.count({ where: { deletedAt: null, membershipStatus: { in: ['MEMBER', 'REGULAR', 'VISITOR'] } } }),
    db.member.count({ where: { deletedAt: null, joinDate: { gte: monthStart } } }),
    db.event.findMany({ where: { startsAt: { gte: now } }, orderBy: { startsAt: 'asc' }, take: 5 }),
    db.attendance.count({ where: { checkedInAt: { gte: weekAgo } } }),
    db.incomeRecord.aggregate({ where: { deletedAt: null, transactionDate: { gte: monthStart } }, _sum: { amount: true } }),
    db.fund.count({ where: { active: true } }),
    db.ministry.count(),
    db.organization.count({ where: { active: true } }),
    db.activityLog.findMany({ orderBy: { occurredAt: 'desc' }, take: 8 }),
  ]);

  const hero = pageHero('Dashboard', 'A snapshot of your church — members, attendance, income and what needs attention.');
  const stats = statsRow([
    { cls: 'gold', icon: '👥', value: totalMembers.toLocaleString(), label: 'Members' },
    { cls: 'green', icon: '＋', value: newMembersThisMonth.toLocaleString(), label: 'New this month' },
    { cls: 'blue', icon: '✓', value: recentAttendance.toLocaleString(), label: 'Check-ins (7d)' },
    { cls: 'purple', icon: '₵', value: fmtMoney(incomeThisMonth._sum.amount || 0), label: 'Income this month' },
  ]);

  const quickLinks = `
    <div class="report-tiles">
      <a class="report-tile" href="/members"><div class="ico">👥</div><div><div class="name">Members</div><div class="desc">${totalMembers} total</div></div></a>
      <a class="report-tile" href="/events"><div class="ico">📅</div><div><div class="name">Events</div><div class="desc">${upcomingEvents.length} upcoming</div></div></a>
      <a class="report-tile" href="/finance"><div class="ico">₵</div><div><div class="name">Finance</div><div class="desc">${fundCount} funds</div></div></a>
      <a class="report-tile" href="/bible-classes"><div class="ico">📖</div><div><div class="name">Bible Classes</div><div class="desc">${ministryCount} classes</div></div></a>
      <a class="report-tile" href="/organizations"><div class="ico">♫</div><div><div class="name">Organizations</div><div class="desc">${orgCount} groups</div></div></a>
      <a class="report-tile" href="/reports"><div class="ico">📊</div><div><div class="name">Reports</div><div class="desc">Day-born, income, members</div></div></a>
    </div>`;

  const upcomingCard = listCard({
    title: 'Upcoming events', count: upcomingEvents.length, countLabel: 'events',
    inner: upcomingEvents.length
      ? table(['When', 'Title', 'Type'], upcomingEvents.map((e) => [esc(e.startsAt.toISOString().slice(0, 16).replace('T', ' ')), `<a href="/events/${e.id}">${esc(e.title)}</a>`, esc(e.eventType)]))
      : '<p class="muted-text">No upcoming events scheduled.</p>',
  });

  const activityCard = listCard({
    title: 'Recent activity', count: recentActivity.length, countLabel: 'events',
    inner: recentActivity.length
      ? `<ul class="check-list">${recentActivity.map((a) => `<li>${a.link ? `<a href="${esc(a.link)}">${esc(a.description)}</a>` : esc(a.description)} <span class="muted-text">· ${esc(a.occurredAt.toISOString().slice(0, 16).replace('T', ' '))}</span></li>`).join('')}</ul>`
      : '<p class="muted-text">No activity recorded yet.</p>',
  });

  return `${hero}${stats}${quickLinks}${upcomingCard}${activityCard}`;
}

module.exports = { renderDashboard };
