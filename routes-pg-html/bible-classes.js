'use strict';
// Phase 8b: HTML port of routes/bible-classes.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/bible-classes.js (JSON at /api/bible-classes,
// this is the bare-path HTML surface) — see the Phase 8 plan's recipe.
// Role model: admin-only writes, matching routes-pg/bible-classes.js.

const asyncHandler = require('../lib/async-handler');
const { esc, initials } = require('../lib/format');
const { pageHero, statsRow, filterCard, listCard } = require('../lib/views');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

async function loadOrganizations(db) {
  return db.organization.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
}

function register(app) {
  app.get('/bible-classes', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const q = (req.query.q || '').trim();

    const [rows, orgs, allMembers, totalClasses, enrolled, withLeader] = await Promise.all([
      db.ministry.findMany({
        where: q ? { name: { contains: q, mode: 'insensitive' } } : {},
        orderBy: { name: 'asc' },
        include: {
          leader: { select: { id: true, firstName: true, lastName: true } },
          organization: { select: { id: true, name: true } },
          _count: { select: { bibleClassMembers: true } },
        },
      }),
      loadOrganizations(db),
      db.member.findMany({ where: { deletedAt: null }, orderBy: { lastName: 'asc' }, select: { id: true, firstName: true, lastName: true } }),
      db.ministry.count(),
      db.member.count({ where: { bibleClassId: { not: null }, deletedAt: null } }),
      db.ministry.count({ where: { leaderId: { not: null } } }),
    ]);

    const orgOpts = (selected) => '<option value="">— none —</option>' +
      orgs.map((o) => `<option value="${o.id}" ${o.id === selected ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
    const memberOpts = (selected) => '<option value="">— none —</option>' +
      allMembers.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.firstName + ' ' + m.lastName)}</option>`).join('');

    const hero = pageHero('Bible Classes', 'Small groups and classes — their leaders, organizations and membership.');
    const stats = statsRow([
      { cls: 'gold', icon: '📖', value: totalClasses.toLocaleString(), label: 'Bible Classes' },
      { cls: 'green', icon: '👥', value: enrolled.toLocaleString(), label: 'Members Enrolled' },
      { cls: 'blue', icon: '★', value: withLeader.toLocaleString(), label: 'Classes with a Leader' },
    ], isAdmin ? `<a class="btn primary" href="#add-class">＋ Add Bible Class</a>` : '');
    const filters = filterCard({ q, placeholder: 'Search Bible classes by name…' });

    const rowHtml = rows.map((r) => `<tr>
      <td data-label="Bible class">
        <div class="m-name-cell">
          <span class="org-badge">${esc(initials(r.name))}</span>
          <div>
            <div class="m-name">${esc(r.name)}</div>
            <div class="m-sub">${r.description ? esc(r.description) : (r.meetsOn ? `Meets ${esc(r.meetsOn)}` : '—')}</div>
          </div>
        </div>
      </td>
      <td data-label="Leader">${r.leader ? `<a href="/members/${r.leader.id}">${esc(r.leader.firstName + ' ' + r.leader.lastName)}</a>` : '<span class="muted-text">—</span>'}</td>
      <td data-label="Organization">${r.organization ? esc(r.organization.name) : '<span class="muted-text">—</span>'}</td>
      <td data-label="Members"><a class="count-badge" href="/members?class=${r.id}">${r._count.bibleClassMembers}</a></td>
      ${isAdmin ? `<td data-label="Edit">
        <form method="post" action="/bible-classes/${r.id}" class="filter-bar" style="gap:0.4rem;margin:0">
          <select name="leaderId" aria-label="Leader">${memberOpts(r.leaderId)}</select>
          <select name="orgId" aria-label="Organization">${orgOpts(r.orgId)}</select>
          <button type="submit">Save</button>
        </form></td>` : ''}
    </tr>`).join('');

    const list = listCard({
      title: 'All Bible Classes', count: rows.length, countLabel: 'classes',
      inner: rows.length ? `<table class="data-table members-table">
          <thead><tr><th>Bible class</th><th>Leader</th><th>Organization</th><th>Members</th>${isAdmin ? '<th>Edit</th>' : ''}</tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>` : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">📖</div>
          <h3>${q ? `No Bible classes match "${esc(q)}"` : 'No Bible classes yet'}</h3>
          <p>${q ? 'Try a different search term, or add a new class below.' : 'Add your first Bible class using the form below.'}</p>
          ${isAdmin ? '<a class="btn primary" href="#add-class">＋ Add Bible Class</a>' : ''}
          ${q ? '<div style="margin-top:0.6rem"><a class="link" href="/bible-classes">Clear search →</a></div>' : ''}
        </div>`,
    });

    const newForm = isAdmin
      ? `<details class="form-toggle" id="add-class" style="margin-top:1rem">
           <summary><strong>＋ Add a Bible class</strong></summary>
           <form class="form" method="post" action="/bible-classes" style="margin-top:0.75rem">
             <label>Bible class<input name="name" required></label>
             <label>Leader<select name="leaderId">${memberOpts()}</select></label>
             <label>Organization<select name="orgId">${orgOpts()}</select></label>
             <label>Meets<input name="meetsOn" placeholder="e.g. Sunday 8am"></label>
             <label class="wide">Description<input name="description"></label>
             <div class="actions"><button type="submit">Add</button></div>
           </form>
         </details>` : '';

    res.page({
      title: 'Bible Classes', active: '/bible-classes', noHeader: true,
      body: `${hero}${stats}${filters}${list}${newForm}`,
    });
  }));

  app.post('/bible-classes', requireAdmin, asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.redirect('/bible-classes');
    try {
      await res.locals.db.ministry.create({
        data: {
          name: String(b.name).trim(),
          description: b.description || null,
          leaderId: b.leaderId ? Number(b.leaderId) : null,
          orgId: b.orgId ? Number(b.orgId) : null,
          meetsOn: b.meetsOn || null,
        },
      });
    } catch (e) {
      if (e.code !== 'P2002') throw e; // duplicate name — silently ignored, matching the original's scope
    }
    res.redirect('/bible-classes');
  }));

  app.post('/bible-classes/:id', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    try {
      await res.locals.db.ministry.update({
        where: { id },
        data: {
          leaderId: b.leaderId ? Number(b.leaderId) : null,
          orgId: b.orgId ? Number(b.orgId) : null,
        },
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect('/bible-classes');
  }));
}

module.exports = { register };
