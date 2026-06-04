'use strict';
// Organizations routes (directory, detail/roster, CRUD). register(app, ctx).
module.exports.register = function register(app, ctx) {
  const { db, esc, initials, pageHero, statsRow, filterCard, listCard,
    ICON_EYE, ICON_TRASH, memberAvatar, requireAdmin, flash } = ctx;

  function selectOrganizations({ q, sort }) {
    const where = ['o.active=1'];
    const params = {};
    if (q) { where.push(`o.name LIKE @q`); params.q = `%${q}%`; }
    const order = sort === 'members' ? 'member_count DESC, o.name' : 'o.name';
    return db.prepare(`
      SELECT o.org_id, o.name, o.description, o.meets_on, o.leader_id,
             ml.first_name || ' ' || ml.last_name AS leader_name,
             (SELECT COUNT(*) FROM organization_memberships om WHERE om.org_id=o.org_id) AS member_count
      FROM organizations o
      LEFT JOIN members ml ON ml.member_id = o.leader_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}`).all(params);
  }
  function orgMemberOptions(selected) {
    const all = db.prepare(
      `SELECT member_id, first_name || ' ' || last_name AS name FROM members
         WHERE deleted_at IS NULL ORDER BY last_name`).all();
    return '<option value="">— none —</option>' +
      all.map((m) => `<option value="${m.member_id}" ${m.member_id === selected ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  }

  app.get('/organizations', (req, res) => {
    const q = (req.query.q || '').trim();
    const sort = (req.query.sort || '').trim();
    const orgs = selectOrganizations({ q, sort });
    const isAdmin = res.locals.isAdmin;

    const orgCount = db.prepare(`SELECT COUNT(*) c FROM organizations WHERE active=1`).get().c;
    const enrolled = db.prepare(
      `SELECT COUNT(DISTINCT om.member_id) c FROM organization_memberships om
         JOIN organizations o USING(org_id) WHERE o.active=1`).get().c;
    const leaders = db.prepare(
      `SELECT COUNT(*) c FROM organizations WHERE active=1 AND leader_id IS NOT NULL`).get().c;

    const hero = pageHero('Organizations',
      'Choirs, bands, fellowships and brigades. Browse every group, see its leader and membership, and manage rosters.');
    const stats = statsRow([
      { cls: 'gold', icon: '♫', value: orgCount.toLocaleString(), label: 'Organizations' },
      { cls: 'green', icon: '👥', value: enrolled.toLocaleString(), label: 'Members Enrolled' },
      { cls: 'blue', icon: '★', value: leaders.toLocaleString(), label: 'Groups with a Leader' },
    ], `${isAdmin ? `<a class="btn" href="/organizations/new">＋ Add Organization</a>` : ''}
        <a class="btn ghost" href="/members">👥 View Members</a>`);
    const sortOpts = [['', 'Sort: A–Z'], ['members', 'Sort: Most members']]
      .map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('');
    const filters = filterCard({
      q, placeholder: 'Search organizations by name…',
      controls: `<select name="sort" aria-label="Sort organizations">${sortOpts}</select>`,
    });

    const rowHtml = orgs.map((o) => {
      const sub = o.meets_on ? `Meets ${esc(o.meets_on)}` : (o.description ? esc(o.description) : '—');
      const actions = `
        <div class="row-actions">
          <a class="icon-btn view" href="/organizations/${o.org_id}" title="Manage" aria-label="Manage">${ICON_EYE}</a>
          ${isAdmin ? `<form method="post" action="/organizations/${o.org_id}/archive" onsubmit="return confirm('Archive this organization? It will be hidden from the list.')">
            <button class="icon-btn del" type="submit" title="Archive" aria-label="Archive">${ICON_TRASH}</button>
          </form>` : ''}
        </div>`;
      return `<tr>
        <td data-label="Organization">
          <div class="m-name-cell">
            <span class="org-badge">${esc(initials(o.name))}</span>
            <div>
              <a class="m-name" href="/organizations/${o.org_id}">${esc(o.name)}</a>
              <div class="m-sub">${sub}</div>
            </div>
          </div>
        </td>
        <td data-label="Leader">${o.leader_id ? `<a href="/members/${o.leader_id}">${esc(o.leader_name)}</a>` : '<span class="muted-text">—</span>'}</td>
        <td data-label="Members"><span class="count-badge">${o.member_count}</span></td>
        <td data-label="Actions">${actions}</td>
      </tr>`;
    }).join('');

    const list = listCard({
      title: '♫ Organizations List', count: orgs.length, countLabel: 'groups',
      note: 'Results update as you search and filter',
      inner: orgs.length ? `<table class="data-table members-table">
          <thead><tr><th>Organization</th><th>Leader</th><th>Members</th><th>Actions</th></tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>` : `<div class="empty-state">
          <div class="empty-ico">♫</div>
          <p>No organizations match your search.</p>
          ${isAdmin ? '<a class="btn" href="/organizations/new">＋ Add Organization</a>' : ''}
        </div>`,
    });

    res.page({
      title: 'Organizations', active: '/organizations', noHeader: true,
      body: `${hero}${stats}${filters}${list}`,
    });
  });

  app.get('/organizations/new', requireAdmin, (req, res) => {
    const body = `
      <p><a href="/organizations">← Back to organizations</a></p>
      <form class="form" method="post" action="/organizations">
        <label class="wide">Name<input name="name" required></label>
        <label>Meets<input name="meets_on" placeholder="e.g. Saturday 5pm"></label>
        <label>Leader<select name="leader_id">${orgMemberOptions()}</select></label>
        <label class="wide">Description<input name="description"></label>
        <div class="actions"><button type="submit">Add organization</button></div>
      </form>`;
    res.page({ title: 'New organization', active: '/organizations', body });
  });

  app.get('/organizations/:id', (req, res) => {
    const id = Number(req.params.id);
    const o = db.prepare(`
      SELECT o.*, ml.first_name || ' ' || ml.last_name AS leader_name
      FROM organizations o LEFT JOIN members ml ON ml.member_id = o.leader_id
      WHERE o.org_id = ? AND o.active = 1`).get(id);
    if (!o) return res.status(404).send('Not found');
    const isAdmin = res.locals.isAdmin;
    const members = db.prepare(`
      SELECT m.member_id, m.external_id, m.first_name, m.last_name, m.photo_filename, om.role
      FROM organization_memberships om JOIN members m USING(member_id)
      WHERE om.org_id = ? AND m.deleted_at IS NULL
      ORDER BY (om.role='leader') DESC, m.last_name, m.first_name`).all(id);

    const roster = members.length
      ? `<table class="data-table members-table">
           <thead><tr><th>Member</th><th>Role</th>${isAdmin ? '<th>Actions</th>' : ''}</tr></thead>
           <tbody>${members.map((m) => `<tr>
             <td data-label="Member">
               <div class="m-name-cell">
                 ${memberAvatar(m)}
                 <div>
                   <a class="m-name" href="/members/${m.member_id}">${esc(m.first_name)} ${esc(m.last_name)}</a>
                   <div class="m-sub">${esc(m.external_id) || '—'}</div>
                 </div>
               </div>
             </td>
             <td data-label="Role"><span class="pill ${m.role === 'leader' ? 'pill-member' : 'pill-regular'}">${esc(m.role)}</span></td>
             ${isAdmin ? `<td data-label="Actions">
               <form method="post" action="/organizations/${id}/remove" onsubmit="return confirm('Remove this member from ${esc(o.name).replace(/'/g, "\\'")}?')">
                 <input type="hidden" name="member_id" value="${m.member_id}">
                 <button class="icon-btn del" type="submit" title="Remove" aria-label="Remove">${ICON_TRASH}</button>
               </form></td>` : ''}
           </tr>`).join('')}</tbody>
         </table>`
      : '<div class="empty-state"><div class="empty-ico">👥</div><p>No members assigned yet.</p></div>';

    const manage = isAdmin
      ? `<div class="card" style="margin-top:1rem">
           <div class="card-head"><h2>Manage</h2></div>
           <form method="post" action="/organizations/${id}/add" class="filter-bar" style="margin-bottom:0.8rem">
             <select name="member_id" required style="flex:1;min-width:200px">${orgMemberOptions()}</select>
             <select name="role"><option value="member">member</option><option value="leader">leader</option></select>
             <button type="submit">＋ Add member</button>
           </form>
           <form method="post" action="/organizations/${id}/leader" class="filter-bar">
             <select name="leader_id" style="flex:1;min-width:200px">${orgMemberOptions(o.leader_id)}</select>
             <button type="submit">Set leader</button>
           </form>
         </div>`
      : '';

    const body = `
      <p><a href="/organizations">← Back to organizations</a></p>
      ${pageHero(o.name, o.description || 'Group roster and membership.')}
      ${statsRow([
        { cls: 'gold', icon: '👥', value: members.length, label: 'Members' },
        { cls: 'green', icon: '★', value: o.leader_id ? esc(o.leader_name) : '—', label: 'Leader' },
        { cls: 'blue', icon: '📅', value: o.meets_on ? esc(o.meets_on) : '—', label: 'Meets' },
      ])}
      ${listCard({ title: '👥 Roster', count: members.length, countLabel: 'members', inner: roster })}
      ${manage}`;
    res.page({ title: o.name, active: '/organizations', noHeader: true, body });
  });

  app.post('/organizations', requireAdmin, (req, res) => {
    const b = req.body;
    if (!b.name || !b.name.trim()) { flash(req, 'Organization name is required.'); return res.redirect('/organizations/new'); }
    try {
      db.prepare(`INSERT INTO organizations (name, description, meets_on, leader_id) VALUES (?, ?, ?, ?)`)
        .run(b.name.trim(), b.description || null, b.meets_on || null,
             b.leader_id ? Number(b.leader_id) : null);
      flash(req, `Added “${b.name.trim()}”.`, 'success');
    } catch (e) {
      flash(req, 'An organization with that name already exists.');
      return res.redirect('/organizations/new');
    }
    res.redirect('/organizations');
  });

  app.post('/organizations/:id/add', requireAdmin, (req, res) => {
    const oid = Number(req.params.id);
    const mid = Number(req.body.member_id);
    if (!mid) { flash(req, 'Choose a member to add.'); return res.redirect(`/organizations/${oid}`); }
    try {
      db.prepare(`INSERT INTO organization_memberships (org_id, member_id, role) VALUES (?, ?, ?)`)
        .run(oid, mid, req.body.role === 'leader' ? 'leader' : 'member');
    } catch (e) {
      flash(req, 'That member is already in this group.', 'info');
    }
    res.redirect(`/organizations/${oid}`);
  });

  app.post('/organizations/:id/remove', requireAdmin, (req, res) => {
    const oid = Number(req.params.id);
    const mid = Number(req.body.member_id);
    db.prepare(`DELETE FROM organization_memberships WHERE org_id=? AND member_id=?`).run(oid, mid);
    res.redirect(`/organizations/${oid}`);
  });

  app.post('/organizations/:id/leader', requireAdmin, (req, res) => {
    const oid = Number(req.params.id);
    const lid = req.body.leader_id ? Number(req.body.leader_id) : null;
    db.prepare(`UPDATE organizations SET leader_id=? WHERE org_id=?`).run(lid, oid);
    res.redirect(`/organizations/${oid}`);
  });

  app.post('/organizations/:id/archive', requireAdmin, (req, res) => {
    db.prepare(`UPDATE organizations SET active=0 WHERE org_id=?`).run(Number(req.params.id));
    res.redirect('/organizations');
  });
};
