'use strict';
// Bible classes (ministries) routes. register(app, ctx) — deps injected.
module.exports.register = function register(app, ctx) {
  const { db, esc, initials, pageHero, statsRow, filterCard, listCard, loadOrganizations, requireAdmin } = ctx;

  app.get('/bible-classes', (req, res) => {
    const q = (req.query.q || '').trim();
    const isAdmin = res.locals.isAdmin;
    const rows = db.prepare(`
      SELECT mn.ministry_id, mn.name, mn.description, mn.meets_on, mn.active,
             ml.first_name || ' ' || ml.last_name AS leader_name,
             ml.member_id AS leader_id,
             o.org_id, o.name AS org_name,
             (SELECT COUNT(*) FROM members m WHERE m.bible_class_id=mn.ministry_id AND m.deleted_at IS NULL) AS member_count
      FROM ministries mn
      LEFT JOIN members ml ON ml.member_id = mn.leader_id
      LEFT JOIN organizations o ON o.org_id = mn.org_id
      ${q ? 'WHERE mn.name LIKE @q' : ''}
      ORDER BY mn.name`).all(q ? { q: `%${q}%` } : {});
    const orgs = loadOrganizations();
    const allMembers = db.prepare(
      `SELECT member_id, first_name || ' ' || last_name AS name FROM members
         WHERE deleted_at IS NULL ORDER BY last_name`).all();
    const orgOpts = (selected) => '<option value="">— none —</option>' +
      orgs.map((o) => `<option value="${o.org_id}" ${o.org_id === selected ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
    const memberOpts = (selected) => '<option value="">— none —</option>' +
      allMembers.map((m) => `<option value="${m.member_id}" ${m.member_id === selected ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

    const totalClasses = db.prepare(`SELECT COUNT(*) c FROM ministries`).get().c;
    const enrolled = db.prepare(`SELECT COUNT(*) c FROM members WHERE bible_class_id IS NOT NULL AND deleted_at IS NULL`).get().c;
    const withLeader = db.prepare(`SELECT COUNT(*) c FROM ministries WHERE leader_id IS NOT NULL`).get().c;

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
            <div class="m-sub">${r.description ? esc(r.description) : (r.meets_on ? `Meets ${esc(r.meets_on)}` : '—')}</div>
          </div>
        </div>
      </td>
      <td data-label="Leader">${r.leader_id ? `<a href="/members/${r.leader_id}">${esc(r.leader_name)}</a>` : '<span class="muted-text">—</span>'}</td>
      <td data-label="Organization">${r.org_id ? esc(r.org_name) : '<span class="muted-text">—</span>'}</td>
      <td data-label="Members"><a class="count-badge" href="/members?class=${r.ministry_id}">${r.member_count}</a></td>
      ${isAdmin ? `<td data-label="Edit">
        <form method="post" action="/bible-classes/${r.ministry_id}" class="filter-bar" style="gap:0.4rem;margin:0">
          <select name="leader_id" aria-label="Leader">${memberOpts(r.leader_id)}</select>
          <select name="org_id" aria-label="Organization">${orgOpts(r.org_id)}</select>
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
             <label>Leader<select name="leader_id">${memberOpts()}</select></label>
             <label>Organization<select name="org_id">${orgOpts()}</select></label>
             <label>Meets<input name="meets_on" placeholder="e.g. Sunday 8am"></label>
             <label class="wide">Description<input name="description"></label>
             <div class="actions"><button type="submit">Add</button></div>
           </form>
         </details>` : '';

    res.page({
      title: 'Bible Classes', active: '/bible-classes', noHeader: true,
      body: `${hero}${stats}${filters}${list}${newForm}`,
    });
  });

  app.post('/bible-classes', requireAdmin, (req, res) => {
    const b = req.body;
    if (!b.name) return res.redirect('/bible-classes');
    db.prepare(`
      INSERT INTO ministries (name, description, leader_id, org_id, meets_on)
      VALUES (?, ?, ?, ?, ?)`).run(
      b.name, b.description || null,
      b.leader_id ? Number(b.leader_id) : null,
      b.org_id ? Number(b.org_id) : null,
      b.meets_on || null
    );
    res.redirect('/bible-classes');
  });

  app.post('/bible-classes/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const b = req.body;
    db.prepare(`UPDATE ministries SET leader_id=?, org_id=? WHERE ministry_id=?`)
      .run(b.leader_id ? Number(b.leader_id) : null,
           b.org_id ? Number(b.org_id) : null, id);
    res.redirect('/bible-classes');
  });
};
