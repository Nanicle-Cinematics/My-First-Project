'use strict';
// Members directory: list, search, bulk, CSV, create, detail, edit, photo, archive.
// register(app, ctx). Pure helpers come from lib/*; server state via ctx.
const { esc, initials, fmtDate, MONTHS, DAYS_OF_WEEK, parseDob, dobMonth, dobDay,
  isValidDate, isEmailish, isPhoneish } = require('../lib/format');
const { pageHero, statsRow, filterCard, listCard, table, pager,
  ICON_EYE, ICON_PENCIL, ICON_TRASH, memberAvatar } = require('../lib/views');

module.exports.register = function register(app, ctx) {
  const { db, requireAdmin, logActivity, flash, csrfValid, looksLikeImage,
    photoUpload, EXT_FROM_MIME, PHOTO_DIR, PREF_LABELS, nextMemberId,
    loadBibleClasses, loadOrganizations } = ctx;

function memberErrors(b) {
  if (!b.first_name || !b.first_name.trim()) return 'First name is required.';
  if (!b.last_name || !b.last_name.trim()) return 'Last name is required.';
  if (b.email && !isEmailish(b.email)) return 'Enter a valid email address, or leave it blank.';
  if (b.mobile_phone && !isPhoneish(b.mobile_phone)) return 'Enter a valid mobile number (at least 7 digits).';
  for (const f of ['join_date', 'baptism_date', 'confirmation_date']) {
    if (b[f] && !isValidDate(b[f])) return 'Dates must be in YYYY-MM-DD format.';
  }
  return null;
}

// ---------- members ----------
function memberWhere({ q, status, classId }) {
  const where = ['m.deleted_at IS NULL'];
  const params = {};
  if (q) {
    where.push(`(m.first_name LIKE @q OR m.last_name LIKE @q OR m.email LIKE @q
                 OR m.mobile_phone LIKE @q OR m.external_id LIKE @q)`);
    params.q = `%${q}%`;
  }
  if (status) { where.push(`m.membership_status = @status`); params.status = status; }
  if (classId) { where.push(`m.bible_class_id = @classId`); params.classId = Number(classId); }
  return { clause: where.join(' AND '), params };
}
function selectMembers(filters) {
  const { clause, params } = memberWhere(filters);
  let sql = `
    SELECT m.member_id, m.external_id, m.first_name, m.last_name, m.email, m.mobile_phone,
           m.membership_status, m.photo_filename, m.day_born, mn.name AS bible_class
    FROM members m LEFT JOIN ministries mn ON mn.ministry_id = m.bible_class_id
    WHERE ${clause}
    ORDER BY m.last_name, m.first_name`;
  if (filters.limit != null) {
    sql += ` LIMIT @limit OFFSET @offset`;
    params.limit = filters.limit;
    params.offset = filters.offset || 0;
  }
  return db.prepare(sql).all(params);
}
function countMembers(filters) {
  const { clause, params } = memberWhere(filters);
  return db.prepare(`SELECT COUNT(*) c FROM members m WHERE ${clause}`).get(params).c;
}

// Build Prev / page-of / Next controls preserving the current query string.
const MEMBER_STATUS_LABELS = {
  visitor: 'Visitor', regular: 'Regular', member: 'Member', inactive: 'Inactive',
  transferred: 'Transferred', deceased: 'Deceased', other: 'Other',
};
const AKAN_NAMES = {
  Sunday: 'Akosua / Kwasi',
  Monday: 'Adwoa / Kwadwo',
  Tuesday: 'Abena / Kwabena',
  Wednesday: 'Akua / Kwaku',
  Thursday: 'Yaa / Yaw',
  Friday: 'Afia / Kofi',
  Saturday: 'Ama / Kwame',
};
const MEMBERS_PER_PAGE = 25;
app.get('/members', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const classId = (req.query.class || '').trim();
  const matched = countMembers({ q, status, classId });
  const pages = Math.max(1, Math.ceil(matched / MEMBERS_PER_PAGE));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const rows = selectMembers({ q, status, classId, limit: MEMBERS_PER_PAGE, offset: (page - 1) * MEMBERS_PER_PAGE });
  const isAdmin = res.locals.isAdmin;

  const totalMembers = db.prepare(`SELECT COUNT(*) c FROM members WHERE deleted_at IS NULL`).get().c;
  const activeMembers = db.prepare(
    `SELECT COUNT(*) c FROM members WHERE deleted_at IS NULL AND membership_status IN ('member','regular')`).get().c;
  const newMembers = db.prepare(
    `SELECT COUNT(*) c FROM members WHERE deleted_at IS NULL AND join_date >= date('now','-30 days')`).get().c;

  const classes = loadBibleClasses();
  const classOpts = `<option value="">All Bible classes</option>` + classes.map((c) =>
    `<option value="${c.ministry_id}" ${String(c.ministry_id) === classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const statuses = ['', 'visitor', 'regular', 'member', 'inactive', 'transferred', 'deceased', 'other'];
  const statusOpts = statuses.map((s) =>
    `<option value="${s}" ${s === status ? 'selected' : ''}>${s ? MEMBER_STATUS_LABELS[s] : 'All statuses'}</option>`).join('');
  const exportQs = new URLSearchParams({ q, status, class: classId }).toString();

  const hero = pageHero('Members Directory',
    'Manage and view all church members in one place. Search, filter, and act on member records.');
  const stats = statsRow([
    { cls: 'gold', icon: '👥', value: totalMembers.toLocaleString(), label: 'Total Members' },
    { cls: 'green', icon: '✓', value: activeMembers.toLocaleString(), label: 'Active' },
    { cls: 'blue', icon: '＋', value: newMembers.toLocaleString(), label: 'New (30d)' },
  ], `${isAdmin ? `<a class="btn primary" href="/members/new">＋ Add New Member</a>` : ''}
      <a class="btn ghost" href="/bible-classes">📚 Bible Classes</a>`);
  const filters = filterCard({
    q, placeholder: 'Search members by name, ID, email or phone…',
    controls: `<select name="class" aria-label="Filter by Bible class">${classOpts}</select>
      <select name="status" aria-label="Filter by status">${statusOpts}</select>
      <details class="export">
        <summary>⋯ Export</summary>
        <a href="/members.csv?${exportQs}">Export CSV</a>
        <a href="javascript:window.print()">Print / PDF</a>
      </details>`,
  });

  const rowHtml = rows.map((r) => {
    const id = r.member_id;
    const phone = esc(r.mobile_phone);
    const email = esc(r.email);
    const actions = `
      <div class="row-actions">
        <a class="icon-btn view" href="/members/${id}" title="View" aria-label="View">${ICON_EYE}</a>
        ${isAdmin ? `<a class="icon-btn edit" href="/members/${id}#edit" title="Edit" aria-label="Edit">${ICON_PENCIL}</a>
        <form method="post" action="/members/${id}/delete" onsubmit="return confirm('Archive this member? They will be hidden but not permanently deleted.')">
          <button class="icon-btn del" type="submit" title="Archive" aria-label="Archive">${ICON_TRASH}</button>
        </form>` : ''}
      </div>`;
    return `<tr>
      ${isAdmin ? `<td class="bulk-cell"><input type="checkbox" class="bulk-box" value="${id}" aria-label="Select ${esc(r.first_name)} ${esc(r.last_name)}"></td>` : ''}
      <td data-label="Name">
        <div class="m-name-cell">
          ${memberAvatar(r)}
          <div>
            <a class="m-name" href="/members/${id}">${esc(r.first_name)} ${esc(r.last_name)}</a>
            <div class="m-sub">${esc(r.external_id) || '—'}</div>
          </div>
        </div>
      </td>
      <td data-label="Contact">
        <div class="m-contact">
          ${phone ? `<div><span class="ci">📞</span> <a href="tel:${phone}">${phone}</a></div>` : '<div class="muted-text">No phone</div>'}
          ${email ? `<div><span class="ci">✉</span> <a href="mailto:${email}">${email}</a></div>` : ''}
          ${phone ? '<span class="momo-badge">MoMo ready</span>' : ''}
        </div>
      </td>
      <td data-label="Day Name">${r.day_born
        ? `<span class="pill pill-day" title="Akan Names: ${esc(AKAN_NAMES[r.day_born] || r.day_born)}">${esc(r.day_born)}</span>`
        : '—'}</td>
      <td data-label="Group">${esc(r.bible_class) || '—'}</td>
      <td data-label="Status"><span class="pill pill-${esc(r.membership_status)}">${esc(MEMBER_STATUS_LABELS[r.membership_status] || r.membership_status)}</span></td>
      <td data-label="Actions">${actions}</td>
    </tr>`;
  }).join('');

  const orgsForBulk = loadOrganizations();
  const bulkBar = isAdmin ? `
    <form class="bulk-bar" method="post" action="/members/bulk">
      <input type="hidden" name="member_ids" value="">
      <span class="bulk-summary"><strong class="bulk-count">0</strong> selected</span>
      <select name="action" aria-label="Bulk action">
        <option value="export">Export selected (CSV)</option>
        <option value="add_org">Add to organization…</option>
      </select>
      <select name="org_id" aria-label="Organization">
        ${orgsForBulk.map((o) => `<option value="${o.org_id}">${esc(o.name)}</option>`).join('')}
      </select>
      <button type="submit">Apply</button>
    </form>` : '';
  const list = listCard({
    title: 'Members List', count: matched, countLabel: 'members',
    note: 'Results update as you search and filter',
    inner: rows.length ? `${bulkBar}<table class="data-table members-table"${isAdmin ? ' data-bulk' : ''}>
        <thead><tr>${isAdmin ? '<th class="bulk-cell"><input type="checkbox" class="bulk-all" aria-label="Select all"></th>' : ''}<th>Name</th><th>Contact</th><th>Day Name</th><th>Group</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
      ${pager('/members', { q, status, class: classId }, page, pages)}` : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">👥</div>
        <h3>${q || classId || status ? 'No members match your search' : 'No members yet'}</h3>
        <p>${q || classId || status ? 'Try clearing filters or searching by phone number.' : 'Add your first member and the directory will start populating.'}</p>
        ${isAdmin ? '<a class="btn primary" href="/members/new">＋ Add New Member</a>' : ''}
        ${q || classId || status ? '<div style="margin-top:0.6rem"><a class="link" href="/members">Clear filters →</a></div>' : ''}
      </div>`,
  });

  res.page({
    title: 'Members',
    active: '/members',
    noHeader: true,
    body: `${hero}${stats}${filters}${list}`,
  });
});

function membersCsv(rows) {
  const headers = ['Member ID', 'First name', 'Last name', 'Bible class', 'Status', 'Email', 'Phone'];
  return [headers.join(',')].concat(
    rows.map((r) => [r.external_id, r.first_name, r.last_name, r.bible_class,
      r.membership_status, r.email, r.mobile_phone]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
  ).join('\n');
}
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(csv);
}

app.get('/members.csv', (req, res) => {
  sendCsv(res, 'members.csv', membersCsv(selectMembers({ q: req.query.q || '', status: req.query.status || '' })));
});

// Bulk actions on selected members: export to CSV or add to an organization.
app.post('/members/bulk', requireAdmin, (req, res) => {
  const ids = String(req.body.member_ids || '').split(',').map(Number).filter(Boolean);
  if (!ids.length) { flash(req, 'Select at least one member first.'); return res.redirect('/members'); }
  const placeholders = ids.map(() => '?').join(',');
  if (req.body.action === 'export') {
    const rows = db.prepare(`
      SELECT m.external_id, m.first_name, m.last_name, m.membership_status, m.email, m.mobile_phone,
             mn.name AS bible_class
      FROM members m LEFT JOIN ministries mn ON mn.ministry_id = m.bible_class_id
      WHERE m.member_id IN (${placeholders}) AND m.deleted_at IS NULL
      ORDER BY m.last_name, m.first_name`).all(...ids);
    return sendCsv(res, 'members-selected.csv', membersCsv(rows));
  }
  if (req.body.action === 'add_org') {
    const orgId = Number(req.body.org_id);
    if (!orgId) { flash(req, 'Choose an organization.'); return res.redirect('/members'); }
    const org = db.prepare(`SELECT name FROM organizations WHERE org_id=? AND active=1`).get(orgId);
    if (!org) { flash(req, 'That organization no longer exists.'); return res.redirect('/members'); }
    const ins = db.prepare(`INSERT OR IGNORE INTO organization_memberships (org_id, member_id, role) VALUES (?, ?, 'member')`);
    const tx = db.transaction(() => { for (const id of ids) ins.run(orgId, id); });
    tx();
    flash(req, `Added ${ids.length} member${ids.length === 1 ? '' : 's'} to ${org.name}.`, 'success');
    return res.redirect('/members');
  }
  flash(req, 'Unknown bulk action.');
  res.redirect('/members');
});

function memberForm(member = {}, bibleClasses = [], organizations = [], memberOrgIds = [], action) {
  const bibleClassOpts = '<option value="">— none —</option>' +
    bibleClasses.map((b) =>
      `<option value="${b.ministry_id}" ${b.ministry_id === member.bible_class_id ? 'selected' : ''}>${esc(b.name)}</option>`
    ).join('');
  const statusOpts = ['visitor', 'member']
    .map((s) => `<option value="${s}" ${s === member.membership_status ? 'selected' : ''}>${s}</option>`).join('');
  const maritalOpts = ['', 'single', 'married', 'divorced', 'widowed', 'separated', 'other']
    .map((s) => `<option value="${s}" ${s === (member.marital_status || '') ? 'selected' : ''}>${s || '—'}</option>`).join('');
  const genderLabels = { '': '—', M: 'M', F: 'F', O: 'Other' };
  const genderOpts = ['', 'M', 'F', 'O']
    .map((s) => `<option value="${s}" ${s === (member.gender || '') ? 'selected' : ''}>${genderLabels[s]}</option>`).join('');
  const orgChecks = organizations.map((o) => `
      <label class="check"><input type="checkbox" name="org_ids" value="${o.org_id}"
        ${memberOrgIds.includes(o.org_id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('');
  const orgsOpen = memberOrgIds.length > 0;
  const orgsCount = memberOrgIds.length;
  const memberIdField = member.member_id
    ? `<label>Member ID<input name="external_id" value="${esc(member.external_id || '')}" readonly></label>`
    : `<label>Member ID<input name="external_id" value="(auto-generated on save)" readonly></label>`;
  return `
    <form method="post" action="${action}" class="form">
      ${memberIdField}
      <label>Status<select name="membership_status" required>${statusOpts}</select></label>
      <label>First name<input name="first_name" required value="${esc(member.first_name)}"></label>
      <label>Last name<input name="last_name" required value="${esc(member.last_name)}"></label>
      <label>Email<input type="email" name="email" value="${esc(member.email)}"></label>
      <label>Mobile<input name="mobile_phone" required value="${esc(member.mobile_phone)}"></label>
      <label>Date of birth (day &amp; month)
        <div class="dob-row">
          <select name="dob_month" aria-label="Month" required>
            <option value="">— month —</option>
            ${MONTHS.map((mn, i) => `<option value="${i + 1}" ${(i + 1) === dobMonth(member.date_of_birth) ? 'selected' : ''}>${mn}</option>`).join('')}
          </select>
          <select name="dob_day" aria-label="Day" required>
            <option value="">— day —</option>
            ${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${(i + 1) === dobDay(member.date_of_birth) ? 'selected' : ''}>${i + 1}</option>`).join('')}
          </select>
        </div>
      </label>
      <label>Day born<select name="day_born">
        <option value="">—</option>
        ${DAYS_OF_WEEK.map((d) => `<option value="${d}" ${d === (member.day_born || '') ? 'selected' : ''}>${d}</option>`).join('')}
      </select></label>
      <label>Gender<select name="gender" required>${genderOpts}</select></label>
      <label>Marital<select name="marital_status">${maritalOpts}</select></label>
      <label>Bible class<select name="bible_class_id">${bibleClassOpts}</select></label>
      <label>Communication preference
        <select name="preferred_channel" required>
          ${Object.entries(PREF_LABELS).map(([v, l]) =>
            `<option value="${v}" ${v === (member.preferred_channel || 'none') ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <span class="hint">New members default to <em>Do not contact</em>. Switch once the member consents to SMS / email.</span>
      </label>
      <label>Join date<input type="date" name="join_date" value="${fmtDate(member.join_date)}"></label>
      <label>Baptism date<input type="date" name="baptism_date" value="${fmtDate(member.baptism_date)}"></label>
      <label>Confirmation date<input type="date" name="confirmation_date" value="${fmtDate(member.confirmation_date)}"></label>
      <div class="wide-cell">
        <details class="form-toggle" ${orgsOpen ? 'open' : ''}>
          <summary><strong>Choose organizations</strong>
            <span class="muted-text">${orgsCount > 0 ? `(${orgsCount} selected)` : '(optional — click to expand)'}</span>
          </summary>
          <div class="check-grid" style="margin-top:0.5rem">${orgChecks || '<span class="muted-text">No organizations yet.</span>'}</div>
        </details>
      </div>
      <div class="wide-cell"><h3 class="form-section">Emergency contact</h3></div>
      <label>Contact name<input name="emergency_contact_name" value="${esc(member.emergency_contact_name)}"></label>
      <label>Contact phone<input name="emergency_contact_phone" value="${esc(member.emergency_contact_phone)}"></label>
      <label>Relationship<input name="emergency_contact_relation" placeholder="e.g. spouse, parent, sibling" value="${esc(member.emergency_contact_relation)}"></label>
      <label class="wide">Notes<textarea name="notes" rows="3">${esc(member.notes)}</textarea></label>
      <div class="actions"><button type="submit">Save</button></div>
    </form>`;
}

app.get('/members/new', requireAdmin, (req, res) => {
  res.page({
    title: 'New member', active: '/members',
    body: memberForm({}, loadBibleClasses(), loadOrganizations(), [], '/members'),
  });
});

function parseOrgIds(body) {
  const v = body.org_ids;
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => Number(x)).filter((x) => x);
}

function saveMemberOrgs(memberId, orgIds) {
  db.prepare(`DELETE FROM organization_memberships WHERE member_id=?`).run(memberId);
  const ins = db.prepare(`INSERT INTO organization_memberships (org_id, member_id) VALUES (?, ?)`);
  for (const oid of orgIds) ins.run(oid, memberId);
}

app.post('/members', requireAdmin, (req, res) => {
  const b = req.body;
  const err = memberErrors(b);
  if (err) { flash(req, err); return res.redirect('/members/new'); }
  const externalId = nextMemberId();
  const info = db.prepare(`
    INSERT INTO members (external_id, bible_class_id, first_name, last_name, email, mobile_phone,
      date_of_birth, day_born, gender, marital_status, membership_status,
      join_date, baptism_date, confirmation_date, notes,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
      preferred_channel, unsubscribe_token)
    VALUES (@external_id, @bible_class_id, @first_name, @last_name, @email, @mobile_phone,
      @date_of_birth, @day_born, @gender, @marital_status, @membership_status,
      @join_date, @baptism_date, @confirmation_date, @notes,
      @emergency_contact_name, @emergency_contact_phone, @emergency_contact_relation,
      @preferred_channel, lower(hex(randomblob(16))))
  `).run({
    external_id: externalId,
    bible_class_id: b.bible_class_id ? Number(b.bible_class_id) : null,
    first_name: b.first_name, last_name: b.last_name,
    email: b.email || null, mobile_phone: b.mobile_phone || null,
    date_of_birth: parseDob(b.dob_month, b.dob_day),
    day_born: DAYS_OF_WEEK.includes(b.day_born) ? b.day_born : null,
    gender: b.gender || null,
    preferred_channel: PREF_LABELS[b.preferred_channel] ? b.preferred_channel : 'none',
    marital_status: b.marital_status || null,
    membership_status: b.membership_status || 'visitor',
    join_date: b.join_date || null, baptism_date: b.baptism_date || null,
    confirmation_date: b.confirmation_date || null,
    notes: b.notes || null,
    emergency_contact_name: b.emergency_contact_name || null,
    emergency_contact_phone: b.emergency_contact_phone || null,
    emergency_contact_relation: b.emergency_contact_relation || null,
  });
  saveMemberOrgs(info.lastInsertRowid, parseOrgIds(b));
  logActivity('member_added',
    `New member added: ${b.first_name} ${b.last_name} (${externalId})`,
    `/members/${info.lastInsertRowid}`, res.locals.user.user_id);
  res.redirect(`/members/${info.lastInsertRowid}`);
});

app.get('/members/:id', (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare(`
    SELECT m.*, mn.name AS bible_class_name FROM members m
    LEFT JOIN ministries mn ON mn.ministry_id = m.bible_class_id
    WHERE m.member_id = ? AND m.deleted_at IS NULL`).get(id);
  if (!m) return res.status(404).send('Not found');
  const memberOrgs = db.prepare(
    `SELECT org_id FROM organization_memberships WHERE member_id=?`
  ).all(id).map((r) => r.org_id);
  const memberOrgsNamed = db.prepare(`
    SELECT o.org_id, o.name FROM organization_memberships om
    JOIN organizations o USING(org_id) WHERE om.member_id=? ORDER BY o.name`).all(id);
  const ministries = db.prepare(`
    SELECT mn.name, mm.role, mm.joined_date FROM ministry_memberships mm
    JOIN ministries mn USING(ministry_id) WHERE mm.member_id = ? AND mm.left_date IS NULL
    ORDER BY mn.name`).all(id);
  const sacraments = db.prepare(`
    SELECT sacrament_type, occurred_on, location FROM sacraments
    WHERE member_id = ? OR spouse_id = ? ORDER BY occurred_on DESC`).all(id, id);
  const attendance = db.prepare(`
    SELECT e.title, e.starts_at FROM attendance a
    JOIN events e USING(event_id) WHERE a.member_id = ?
    ORDER BY e.starts_at DESC LIMIT 10`).all(id);

  const photoBlock = `
    <div class="member-photo">
      ${m.photo_filename
        ? `<img src="/photos/${esc(m.photo_filename)}" alt="Photo of ${esc(m.first_name)} ${esc(m.last_name)}">`
        : `<div class="avatar-lg">${esc(initials(m.first_name + ' ' + m.last_name))}</div>`}
      ${res.locals.isAdmin ? `
        <form method="post" action="/members/${id}/photo" enctype="multipart/form-data" class="photo-form">
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/gif" required>
          <button type="submit">Upload</button>
          ${m.photo_filename ? `
            <form method="post" action="/members/${id}/photo/delete" style="display:inline"
                  onsubmit="return confirm('Remove this photo?')">
              <button class="link" type="submit">Remove photo</button>
            </form>` : ''}
        </form>` : ''}
    </div>`;
  const editPanel = res.locals.isAdmin
    ? `${photoBlock}
       <h2>Edit</h2>
       ${memberForm(m, loadBibleClasses(), loadOrganizations(), memberOrgs, `/members/${id}`)}
       <form method="post" action="/members/${id}/delete" onsubmit="return confirm('Archive this member? They will be hidden but not permanently deleted.')">
         <button class="danger" type="submit">Archive member</button>
       </form>`
    : `${photoBlock}
       <h2>Profile</h2>
       <dl class="stats">
         <dt>Member ID</dt><dd>${esc(m.external_id) || '—'}</dd>
         <dt>Name</dt><dd>${esc(m.first_name)} ${esc(m.last_name)}</dd>
         <dt>Email</dt><dd>${esc(m.email) || '—'}</dd>
         <dt>Mobile</dt><dd>${esc(m.mobile_phone) || '—'}</dd>
         <dt>Status</dt><dd>${esc(m.membership_status)}</dd>
         <dt>Bible class</dt><dd>${esc(m.bible_class_name) || '—'}</dd>
         <dt>Organizations</dt><dd>${memberOrgsNamed.map((o) => esc(o.name)).join(', ') || '—'}</dd>
         <dt>Joined</dt><dd>${esc(m.join_date) || '—'}</dd>
         <dt>Baptized</dt><dd>${esc(m.baptism_date) || '—'}</dd>
         <dt>Confirmed</dt><dd>${esc(m.confirmation_date) || '—'}</dd>
         <dt>Notes</dt><dd>${esc(m.notes) || '—'}</dd>
       </dl>`;
  const body = `
    <div class="two-col">
      <section>
        ${editPanel}
      </section>
      <section>
        <h2>At a glance</h2>

        <p><a class="btn ghost" href="/members/${id}/statement">🧾 Giving statement</a></p>

        <h3>🚨 Emergency contact</h3>
        ${(m.emergency_contact_name || m.emergency_contact_phone || m.emergency_contact_relation)
          ? `<dl class="stats emergency-box">
               <dt>Name</dt><dd>${esc(m.emergency_contact_name) || '—'}</dd>
               <dt>Phone</dt><dd>${m.emergency_contact_phone
                 ? `<a href="tel:${esc(m.emergency_contact_phone)}">${esc(m.emergency_contact_phone)}</a>` : '—'}</dd>
               <dt>Relationship</dt><dd>${esc(m.emergency_contact_relation) || '—'}</dd>
             </dl>`
          : '<p class="muted-text">No emergency contact on file.</p>'}

        <h3>Ministries</h3>
        ${ministries.length ? table(['Ministry', 'Role', 'Joined'],
          ministries.map((r) => [esc(r.name), esc(r.role), esc(r.joined_date)]))
          : '<p>Not in any ministry.</p>'}

        <h3>Sacraments</h3>
        ${sacraments.length ? table(['Type', 'Date', 'Location'],
          sacraments.map((r) => [esc(r.sacrament_type), esc(r.occurred_on), esc(r.location)]))
          : '<p>None recorded.</p>'}

        <h3>Recent attendance</h3>
        ${attendance.length ? table(['Event', 'When'],
          attendance.map((r) => [esc(r.title), esc(r.starts_at)]))
          : '<p>No attendance recorded.</p>'}
      </section>
    </div>`;
  res.page({
    title: `${m.first_name} ${m.last_name}`, active: '/members', body,
  });
});

app.post('/members/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const b = req.body;
  const err = memberErrors(b);
  if (err) { flash(req, err); return res.redirect(`/members/${id}`); }
  db.prepare(`
    UPDATE members SET bible_class_id=@bible_class_id, first_name=@first_name, last_name=@last_name,
      email=@email, mobile_phone=@mobile_phone, date_of_birth=@date_of_birth,
      day_born=@day_born, gender=@gender,
      marital_status=@marital_status, membership_status=@membership_status,
      join_date=@join_date, baptism_date=@baptism_date,
      confirmation_date=@confirmation_date, notes=@notes,
      emergency_contact_name=@emergency_contact_name,
      emergency_contact_phone=@emergency_contact_phone,
      emergency_contact_relation=@emergency_contact_relation,
      preferred_channel=@preferred_channel
    WHERE member_id=@id`).run({
    id,
    bible_class_id: b.bible_class_id ? Number(b.bible_class_id) : null,
    first_name: b.first_name, last_name: b.last_name,
    email: b.email || null, mobile_phone: b.mobile_phone || null,
    date_of_birth: parseDob(b.dob_month, b.dob_day),
    day_born: DAYS_OF_WEEK.includes(b.day_born) ? b.day_born : null,
    gender: b.gender || null,
    preferred_channel: PREF_LABELS[b.preferred_channel] ? b.preferred_channel : 'none',
    marital_status: b.marital_status || null,
    membership_status: b.membership_status || 'visitor',
    join_date: b.join_date || null, baptism_date: b.baptism_date || null,
    confirmation_date: b.confirmation_date || null,
    notes: b.notes || null,
    emergency_contact_name: b.emergency_contact_name || null,
    emergency_contact_phone: b.emergency_contact_phone || null,
    emergency_contact_relation: b.emergency_contact_relation || null,
  });
  saveMemberOrgs(id, parseOrgIds(b));
  res.redirect(`/members/${id}`);
});

app.post('/members/:id/photo', requireAdmin, photoUpload.single('photo'), (req, res) => {
  const id = Number(req.params.id);
  if (!csrfValid(req)) return res.status(403).send(layout({
    title: 'Security check failed', user: res.locals.user, active: null,
    body: '<p>This form was stale. Please go back and try again.</p>',
  }));
  if (!req.file) return res.redirect(`/members/${id}`);
  if (!looksLikeImage(req.file.buffer)) return res.status(400).send(layout({
    title: 'Invalid image', user: res.locals.user, active: null,
    body: `<p>That file does not look like a valid image. Upload a JPG, PNG, WebP or GIF.</p><p><a href="/members/${id}">Back</a></p>`,
  }));
  const ext = EXT_FROM_MIME[req.file.mimetype.toLowerCase()] || 'jpg';
  const filename = `${id}.${ext}`;
  try {
    fs.writeFileSync(path.join(PHOTO_DIR, filename), req.file.buffer);
    // Remove any stale photos with other extensions.
    for (const otherExt of Object.values(EXT_FROM_MIME)) {
      if (otherExt !== ext) {
        try { fs.unlinkSync(path.join(PHOTO_DIR, `${id}.${otherExt}`)); } catch (_) {}
      }
    }
    db.prepare(`UPDATE members SET photo_filename = ? WHERE member_id = ?`).run(filename, id);
  } catch (e) {
    console.error('photo upload failed:', e.message);
  }
  res.redirect(`/members/${id}`);
});

app.post('/members/:id/photo/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const m = db.prepare(`SELECT photo_filename FROM members WHERE member_id=?`).get(id);
  if (m && m.photo_filename) {
    try { fs.unlinkSync(path.join(PHOTO_DIR, m.photo_filename)); } catch (_) {}
    db.prepare(`UPDATE members SET photo_filename = NULL WHERE member_id = ?`).run(id);
  }
  res.redirect(`/members/${id}`);
});

// Serve member photos. Auth-gated (the middleware above already required login).
app.get('/photos/:filename', (req, res) => {
  const safe = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const full = path.join(PHOTO_DIR, safe);
  if (!fs.existsSync(full)) return res.status(404).send('Not found');
  res.sendFile(full);
});

app.post('/members/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE members SET deleted_at=CURRENT_TIMESTAMP WHERE member_id=?`).run(id);
  res.redirect('/members');
});

// Keep old URLs working.
app.get('/households',  (_, res) => res.redirect('/members'));
app.get('/ministries',  (_, res) => res.redirect('/bible-classes'));
app.get('/welfare',     (_, res) => res.redirect('/organizations'));

// ---------- bible classes (formerly ministries) ----------
};
