'use strict';
// Phase 8b: HTML port of routes/organizations.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/organizations.js (JSON at /api/organizations,
// this is the bare-path HTML surface) — see the Phase 8 plan's recipe.
// Role model: admin-only writes, matching routes-pg/organizations.js. Also
// reuses that module's cross-tenant-reference check on /add (see its comment).

const asyncHandler = require('../lib/async-handler');
const { esc, initials } = require('../lib/format');
const { pageHero, statsRow, filterCard, listCard, ICON_EYE, ICON_TRASH, memberAvatar } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

// lib/views.js's memberAvatar() expects the OLD snake_case member shape
// (photo_filename/first_name/last_name) — shim rather than touch the shared helper.
function avatarShim(m) {
  return memberAvatar({ photo_filename: m.photoFilename, first_name: m.firstName, last_name: m.lastName });
}

async function orgMemberOptions(db, selected) {
  const all = await db.member.findMany({ where: { deletedAt: null }, orderBy: { lastName: 'asc' }, select: { id: true, firstName: true, lastName: true } });
  return '<option value="">— none —</option>' +
    all.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.firstName + ' ' + m.lastName)}</option>`).join('');
}

function register(app) {
  app.get('/organizations', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const q = (req.query.q || '').trim();
    const sort = (req.query.sort || '').trim();

    const rows = await db.organization.findMany({
      where: { active: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
      include: {
        leader: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { memberships: true } },
      },
      orderBy: sort === 'members' ? undefined : { name: 'asc' },
    });
    const orgs = rows.map((o) => ({
      id: o.id, name: o.name, description: o.description, meetsOn: o.meetsOn,
      leaderId: o.leaderId, leaderName: o.leader ? `${o.leader.firstName} ${o.leader.lastName}` : null,
      memberCount: o._count.memberships,
    }));
    if (sort === 'members') orgs.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));

    const orgCount = orgs.length;
    const enrolled = await db.organizationMembership.findMany({
      where: { organization: { active: true } }, select: { memberId: true }, distinct: ['memberId'],
    }).then((r) => r.length);
    const leaders = orgs.filter((o) => o.leaderId).length;

    const hero = pageHero('Organizations',
      'Choirs, bands, fellowships and brigades. Browse every group, see its leader and membership, and manage rosters.');
    const stats = statsRow([
      { cls: 'gold', icon: '♫', value: orgCount.toLocaleString(), label: 'Organizations' },
      { cls: 'green', icon: '👥', value: enrolled.toLocaleString(), label: 'Members Enrolled' },
      { cls: 'blue', icon: '★', value: leaders.toLocaleString(), label: 'Groups with a Leader' },
    ], `${isAdmin ? `<a class="btn primary" href="/organizations/new">＋ Add Organization</a>` : ''}
        <a class="btn ghost" href="/members">View Members</a>`);
    const sortOpts = [['', 'Sort: A–Z'], ['members', 'Sort: Most members']]
      .map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('');
    const filters = filterCard({
      q, placeholder: 'Search organizations by name…',
      controls: `<select name="sort" aria-label="Sort organizations">${sortOpts}</select>`,
    });

    const rowHtml = orgs.map((o) => {
      const sub = o.meetsOn ? `Meets ${esc(o.meetsOn)}` : (o.description ? esc(o.description) : '—');
      const actions = `
        <div class="row-actions">
          <a class="icon-btn view" href="/organizations/${o.id}" title="Manage" aria-label="Manage">${ICON_EYE}</a>
          ${isAdmin ? `<form method="post" action="/organizations/${o.id}/archive" onsubmit="return confirm('Archive this organization? It will be hidden from the list.')">
            <button class="icon-btn del" type="submit" title="Archive" aria-label="Archive">${ICON_TRASH}</button>
          </form>` : ''}
        </div>`;
      return `<tr>
        <td data-label="Organization">
          <div class="m-name-cell">
            <span class="org-badge">${esc(initials(o.name))}</span>
            <div>
              <a class="m-name" href="/organizations/${o.id}">${esc(o.name)}</a>
              <div class="m-sub">${sub}</div>
            </div>
          </div>
        </td>
        <td data-label="Leader">${o.leaderId ? `<a href="/members/${o.leaderId}">${esc(o.leaderName)}</a>` : '<span class="muted-text">—</span>'}</td>
        <td data-label="Members"><span class="count-badge">${o.memberCount}</span></td>
        <td data-label="Actions">${actions}</td>
      </tr>`;
    }).join('');

    const list = listCard({
      title: 'Organizations', count: orgs.length, countLabel: 'groups',
      note: 'Results update as you search and filter',
      inner: orgs.length ? `<table class="data-table members-table">
          <thead><tr><th>Organization</th><th>Leader</th><th>Members</th><th>Actions</th></tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>` : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">♫</div>
          <h3>${q ? `No organizations match "${esc(q)}"` : 'No organizations yet'}</h3>
          <p>${q ? 'Try a different search term, or add a new group.' : 'Add your first choir, fellowship or band to get started.'}</p>
          ${isAdmin ? '<a class="btn primary" href="/organizations/new">＋ Add Organization</a>' : ''}
          ${q ? '<div style="margin-top:0.6rem"><a class="link" href="/organizations">Clear search →</a></div>' : ''}
        </div>`,
    });

    res.page({
      title: 'Organizations', active: '/organizations', noHeader: true,
      body: `${hero}${stats}${filters}${list}`,
    });
  }));

  app.get('/organizations/new', requireAdmin, asyncHandler(async (req, res) => {
    const options = await orgMemberOptions(res.locals.db);
    const body = `
      <form class="form" method="post" action="/organizations">
        <label class="wide">Name<input name="name" required></label>
        <label>Meets<input name="meetsOn" placeholder="e.g. Saturday 5pm"></label>
        <label>Leader<select name="leaderId">${options}</select></label>
        <label class="wide">Description<input name="description"></label>
        <div class="actions form-actions">
          <a class="btn ghost" href="/organizations">Cancel</a>
          <button type="submit">Add organization</button>
        </div>
      </form>`;
    res.page({ title: 'New organization', active: '/organizations', noHeader: true, body: `${pageHero('New organization', '')}${body}` });
  }));

  app.get('/organizations/:id', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const id = Number(req.params.id);
    const o = await db.organization.findFirst({
      where: { id, active: true },
      include: { leader: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!o) return res.status(404).send('Not found');
    const memberships = await db.organizationMembership.findMany({
      where: { orgId: id },
      include: { member: { select: { id: true, externalId: true, firstName: true, lastName: true, photoFilename: true } } },
      orderBy: [{ role: 'desc' }, { member: { lastName: 'asc' } }],
    });

    const roster = memberships.length
      ? `<table class="data-table members-table">
           <thead><tr><th>Member</th><th>Role</th>${isAdmin ? '<th>Actions</th>' : ''}</tr></thead>
           <tbody>${memberships.map((mm) => { const m = mm.member; return `<tr>
             <td data-label="Member">
               <div class="m-name-cell">
                 ${avatarShim(m)}
                 <div>
                   <a class="m-name" href="/members/${m.id}">${esc(m.firstName)} ${esc(m.lastName)}</a>
                   <div class="m-sub">${esc(m.externalId) || '—'}</div>
                 </div>
               </div>
             </td>
             <td data-label="Role"><span class="pill ${mm.role === 'leader' ? 'pill-member' : 'pill-regular'}">${esc(mm.role)}</span></td>
             ${isAdmin ? `<td data-label="Actions">
               <form method="post" action="/organizations/${id}/remove" onsubmit="return confirm('Remove this member from ${esc(o.name).replace(/'/g, "\\'")}?')">
                 <input type="hidden" name="memberId" value="${m.id}">
                 <button class="icon-btn del" type="submit" title="Remove" aria-label="Remove">${ICON_TRASH}</button>
               </form></td>` : ''}
           </tr>`; }).join('')}</tbody>
         </table>`
      : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">👥</div>
          <h3>No members in this group yet</h3>
          <p>${isAdmin ? 'Use the form below to add the first member.' : 'Ask an admin to add members to this organization.'}</p>
        </div>`;

    const manage = isAdmin
      ? `<div class="card" style="margin-top:1rem">
           <div class="card-head"><h2>Manage</h2></div>
           <form method="post" action="/organizations/${id}/add" class="filter-bar" style="margin-bottom:0.8rem">
             <select name="memberId" required style="flex:1;min-width:200px">${await orgMemberOptions(db)}</select>
             <select name="role"><option value="member">member</option><option value="leader">leader</option></select>
             <button type="submit">＋ Add member</button>
           </form>
           <form method="post" action="/organizations/${id}/leader" class="filter-bar">
             <select name="leaderId" style="flex:1;min-width:200px">${await orgMemberOptions(db, o.leaderId)}</select>
             <button type="submit">Set leader</button>
           </form>
         </div>`
      : '';

    const body = `
      <p><a href="/organizations">← Back to organizations</a></p>
      ${pageHero(o.name, o.description || 'Group roster and membership.')}
      ${statsRow([
        { cls: 'gold', icon: '👥', value: memberships.length, label: 'Members' },
        { cls: 'green', icon: '★', value: o.leader ? esc(`${o.leader.firstName} ${o.leader.lastName}`) : '—', label: 'Leader' },
        { cls: 'blue', icon: '📅', value: o.meetsOn ? esc(o.meetsOn) : '—', label: 'Meets' },
      ])}
      ${listCard({ title: 'Roster', count: memberships.length, countLabel: 'members', inner: roster })}
      ${manage}`;
    res.page({ title: o.name, active: '/organizations', noHeader: true, body });
  }));

  app.post('/organizations', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    if (!b.name || !b.name.trim()) { flash(req, 'Organization name is required.'); return res.redirect('/organizations/new'); }
    // create() only stamps churchId on the NEW row — verify the leader
    // belongs to this tenant explicitly, matching /organizations/:id/leader.
    const leader = b.leaderId ? await db.member.findUnique({ where: { id: Number(b.leaderId) } }) : null;
    if (b.leaderId && !leader) { flash(req, 'Leader not found.'); return res.redirect('/organizations/new'); }
    try {
      const created = await db.organization.create({
        data: {
          name: b.name.trim(), description: b.description || null, meetsOn: b.meetsOn || null,
          leaderId: leader ? leader.id : null,
        },
      });
      await logActivity(db, 'organization_added', `Organization created: ${created.name}`, `/organizations/${created.id}`, res.locals.user.id);
      flash(req, `Added "${b.name.trim()}".`, 'success');
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      flash(req, 'An organization with that name already exists.');
      return res.redirect('/organizations/new');
    }
    res.redirect('/organizations');
  }));

  app.post('/organizations/:id/add', requireAdmin, asyncHandler(async (req, res) => {
    const oid = Number(req.params.id);
    const mid = Number(req.body.memberId);
    if (!mid) { flash(req, 'Choose a member to add.'); return res.redirect(`/organizations/${oid}`); }
    const db = res.locals.db;
    // create() only stamps churchId on the NEW row — verify org/member belong
    // to this tenant explicitly, matching routes-pg/organizations.js's fix.
    const [org, member] = await Promise.all([
      db.organization.findUnique({ where: { id: oid } }),
      db.member.findUnique({ where: { id: mid } }),
    ]);
    if (!org || !member) { flash(req, 'Organization or member not found.'); return res.redirect(`/organizations/${oid}`); }
    try {
      await db.organizationMembership.create({ data: { orgId: oid, memberId: mid, role: req.body.role === 'leader' ? 'leader' : 'member' } });
      await logActivity(db, 'organization_member_added',
        `${member.firstName} ${member.lastName} joined ${org.name}`, `/organizations/${oid}`, res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      flash(req, 'That member is already in this group.', 'info');
    }
    res.redirect(`/organizations/${oid}`);
  }));

  app.post('/organizations/:id/remove', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const oid = Number(req.params.id);
    const mid = Number(req.body.memberId);
    try {
      await db.organizationMembership.delete({ where: { orgId_memberId: { orgId: oid, memberId: mid } } });
      // Names are only worth fetching once the delete has actually happened —
      // a P2025 below means there was nothing to log in the first place.
      const [org, member] = await Promise.all([
        db.organization.findUnique({ where: { id: oid } }),
        db.member.findUnique({ where: { id: mid } }),
      ]);
      await logActivity(db, 'organization_member_removed',
        `${member ? `${member.firstName} ${member.lastName}` : `Member #${mid}`} removed from ${org ? org.name : `organization #${oid}`}`,
        `/organizations/${oid}`, res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect(`/organizations/${oid}`);
  }));

  app.post('/organizations/:id/leader', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const oid = Number(req.params.id);
    const leader = req.body.leaderId ? await db.member.findUnique({ where: { id: Number(req.body.leaderId) } }) : null;
    if (req.body.leaderId && !leader) { flash(req, 'Leader not found.'); return res.redirect(`/organizations/${oid}`); }
    try {
      const org = await db.organization.update({
        where: { id: oid },
        data: { leaderId: leader ? leader.id : null },
      });
      await logActivity(db, 'organization_leader_changed',
        leader ? `${leader.firstName} ${leader.lastName} set as leader of ${org.name}` : `Leader cleared for ${org.name}`,
        `/organizations/${oid}`, res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect(`/organizations/${oid}`);
  }));

  app.post('/organizations/:id/archive', requireAdmin, asyncHandler(async (req, res) => {
    try {
      const org = await res.locals.db.organization.update({ where: { id: Number(req.params.id) }, data: { active: false } });
      await logActivity(res.locals.db, 'organization_archived', `Organization archived: ${org.name}`, '/organizations', res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect('/organizations');
  }));
}

module.exports = { register };
