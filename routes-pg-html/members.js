'use strict';
// Phase 8d: HTML port of routes/members.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/members.js (JSON at /api/members, this is
// the bare-path HTML surface).
//
// SCOPE matches routes-pg/members.js exactly: core member CRUD + directly-
// owned relations (organization memberships, active ministry memberships,
// sacraments, recent attendance). DEFERRED, same as the JSON layer:
// CSV export/import, bulk actions, absent-members report, and the detail
// page's giving/pledges/activity timeline (needs Finance models + a
// not-yet-built audit-log write path — Phase 8e).
//
// Phase 9c added photo upload — local Fly volume (PHOTO_DIR), ported
// near-verbatim from the original (memoryStorage multer -> fs.writeFileSync
// keyed by Member.id + extension). Member.id is a single global Postgres
// sequence (not per-church), so `${id}.${ext}` filenames stay
// collision-free across tenants exactly as they were single-tenant.
// GET /photos/:filename (below) has a real cross-tenant concern the
// original never had (single-tenant = no other church's photos existed to
// leak): it verifies the requesting user's OWN church actually owns a
// member with that photoFilename via the tenant-scoped `db` before serving
// the file, so a curious/malicious user from church B can't view church
// A's member photos by guessing `{id}.{ext}` filenames from a shared
// directory.

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const asyncHandler = require('../lib/async-handler');
const { esc, initials, fmtDate, DAYS_OF_WEEK, looksLikeImage } = require('../lib/format');
const { pageHero, statsRow, filterCard, listCard, table, pager, ICON_EYE, ICON_PENCIL, ICON_TRASH, memberAvatar } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const { icon } = require('../lib/icons');

const PHOTO_DIR = process.env.PHOTO_DIR || path.join(__dirname, '..', 'photos');
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch (_) { /* already exists */ }
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp|gif)$/i.test(file.mimetype);
    cb(ok ? null : new Error('Only JPG / PNG / WebP / GIF images are allowed'), ok);
  },
});
const EXT_FROM_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

const MEMBERSHIP_STATUSES = ['VISITOR', 'REGULAR', 'MEMBER', 'INACTIVE', 'TRANSFERRED', 'DECEASED', 'OTHER'];
const MEMBER_STATUS_LABELS = { VISITOR: 'Visitor', REGULAR: 'Regular', MEMBER: 'Member', INACTIVE: 'Inactive', TRANSFERRED: 'Transferred', DECEASED: 'Deceased', OTHER: 'Other' };
const PREF_LABELS = { EITHER: 'Both', SMS_ONLY: 'SMS only', EMAIL_ONLY: 'Email only', NONE: 'Do not contact' };
const MARITAL_STATUSES = ['', 'SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED', 'OTHER'];
const AKAN_NAMES = { Sunday: 'Akosua / Kwasi', Monday: 'Adwoa / Kwadwo', Tuesday: 'Abena / Kwabena', Wednesday: 'Akua / Kwaku', Thursday: 'Yaa / Yaw', Friday: 'Afia / Kofi', Saturday: 'Ama / Kwame' };
const MEMBERS_PER_PAGE = 25;

function isEmailish(s) { return !s || /^\S+@\S+\.\S+$/.test(s); }
function isPhoneish(s) { return !s || /\d{7,}/.test(String(s).replace(/\D/g, '')); }
function memberErrors(b) {
  if (!b.firstName || !String(b.firstName).trim()) return 'First name is required.';
  if (!b.lastName || !String(b.lastName).trim()) return 'Last name is required.';
  if (b.email && !isEmailish(b.email)) return 'Enter a valid email address, or leave it blank.';
  if (b.mobilePhone && !isPhoneish(b.mobilePhone)) return 'Enter a valid mobile number (at least 7 digits).';
  return null;
}

async function nextMemberId(db) {
  const rows = await db.member.findMany({ where: { externalId: { startsWith: 'MBR-' } }, select: { externalId: true } });
  let max = 0;
  for (const r of rows) { const m = /-(\d+)$/.exec(r.externalId || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `MBR-${String(max + 1).padStart(3, '0')}`;
}

function parseMemberBody(b) {
  return {
    bibleClassId: b.bibleClassId ? Number(b.bibleClassId) : null,
    firstName: (b.firstName || '').trim(),
    lastName: (b.lastName || '').trim(),
    email: (b.email || '').trim() || null,
    mobilePhone: (b.mobilePhone || '').trim() || null,
    dateOfBirth: b.dateOfBirth ? new Date(b.dateOfBirth) : null,
    dayBorn: DAYS_OF_WEEK.includes(b.dayBorn) ? b.dayBorn : null,
    gender: b.gender || null,
    maritalStatus: b.maritalStatus || null,
    membershipStatus: MEMBERSHIP_STATUSES.includes(b.membershipStatus) ? b.membershipStatus : 'VISITOR',
    joinDate: b.joinDate ? new Date(b.joinDate) : null,
    baptismDate: b.baptismDate ? new Date(b.baptismDate) : null,
    confirmationDate: b.confirmationDate ? new Date(b.confirmationDate) : null,
    notes: (b.notes || '').trim() || null,
    emergencyContactName: (b.emergencyContactName || '').trim() || null,
    emergencyContactPhone: (b.emergencyContactPhone || '').trim() || null,
    emergencyContactRelation: (b.emergencyContactRelation || '').trim() || null,
    preferredChannel: b.preferredChannel || 'NONE',
  };
}

function parseOrgIds(body) {
  const v = body.orgIds;
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => Number(x)).filter(Boolean);
}

async function saveMemberOrgs(db, memberId, orgIds) {
  await db.organizationMembership.deleteMany({ where: { memberId } });
  if (orgIds.length) await db.organizationMembership.createMany({ data: orgIds.map((orgId) => ({ orgId, memberId })) });
}

// createMany only stamps churchId onto each new row — it does not verify
// that a client-supplied orgId belongs to this tenant, so callers must
// validate orgIds through the scoped client before calling saveMemberOrgs,
// or a cross-tenant orgId in the request body would silently link the
// member into another church's organization roster.
async function validOrgIds(db, orgIds) {
  if (!orgIds.length) return true;
  const found = await db.organization.count({ where: { id: { in: orgIds } } });
  return found === new Set(orgIds).size;
}

// Same tenant-validation as validOrgIds, for Member.bibleClassId.
async function checkBibleClassId(db, bodyBibleClassId) {
  if (!bodyBibleClassId) return { ok: true, bibleClassId: null };
  const ministry = await db.ministry.findUnique({ where: { id: Number(bodyBibleClassId) } });
  return ministry ? { ok: true, bibleClassId: ministry.id } : { ok: false, bibleClassId: null };
}

async function memberForm(db, member = {}, memberOrgIds, action) {
  const [bibleClasses, organizations] = await Promise.all([
    db.ministry.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    db.organization.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  const bibleClassOpts = '<option value="">— none —</option>' +
    bibleClasses.map((b) => `<option value="${b.id}" ${b.id === member.bibleClassId ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  const statusOpts = MEMBERSHIP_STATUSES.map((s) => `<option value="${s}" ${s === (member.membershipStatus || 'VISITOR') ? 'selected' : ''}>${MEMBER_STATUS_LABELS[s]}</option>`).join('');
  const maritalOpts = MARITAL_STATUSES.map((s) => `<option value="${s}" ${s === (member.maritalStatus || '') ? 'selected' : ''}>${s || '—'}</option>`).join('');
  const genderLabels = { '': '—', M: 'M', F: 'F', O: 'Other' };
  const genderOpts = ['', 'M', 'F', 'O'].map((s) => `<option value="${s}" ${s === (member.gender || '') ? 'selected' : ''}>${genderLabels[s]}</option>`).join('');
  const orgChecks = organizations.map((o) => `
      <label class="check"><input type="checkbox" name="orgIds" value="${o.id}"
        ${(memberOrgIds || []).includes(o.id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('');
  const orgsOpen = (memberOrgIds || []).length > 0;
  const memberIdField = member.id
    ? `<label>Member ID<input value="${esc(member.externalId || '')}" readonly></label>`
    : `<label>Member ID<input value="(auto-generated on save)" readonly></label>`;
  return `
    <form method="post" action="${action}" class="form">
      ${memberIdField}
      <label>Status<select name="membershipStatus" required>${statusOpts}</select></label>
      <label>First name<input name="firstName" required value="${esc(member.firstName)}"></label>
      <label>Last name<input name="lastName" required value="${esc(member.lastName)}"></label>
      <label>Email<input type="email" name="email" value="${esc(member.email)}"></label>
      <label>Mobile<input name="mobilePhone" required value="${esc(member.mobilePhone)}"></label>
      <label>Date of birth<input type="date" name="dateOfBirth" value="${fmtDate(member.dateOfBirth instanceof Date ? member.dateOfBirth.toISOString() : member.dateOfBirth)}"></label>
      <label>Day born<select name="dayBorn">
        <option value="">—</option>
        ${DAYS_OF_WEEK.map((d) => `<option value="${d}" ${d === (member.dayBorn || '') ? 'selected' : ''}>${d}</option>`).join('')}
      </select></label>
      <label>Gender<select name="gender" required>${genderOpts}</select></label>
      <label>Marital<select name="maritalStatus">${maritalOpts}</select></label>
      <label>Bible class<select name="bibleClassId">${bibleClassOpts}</select></label>
      <label>Communication preference
        <select name="preferredChannel" required>
          ${Object.entries(PREF_LABELS).map(([v, l]) => `<option value="${v}" ${v === (member.preferredChannel || 'NONE') ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <span class="hint">New members default to <em>Do not contact</em>. Switch once the member consents to SMS / email.</span>
      </label>
      <label>Join date<input type="date" name="joinDate" value="${fmtDate(member.joinDate instanceof Date ? member.joinDate.toISOString() : member.joinDate)}"></label>
      <label>Baptism date<input type="date" name="baptismDate" value="${fmtDate(member.baptismDate instanceof Date ? member.baptismDate.toISOString() : member.baptismDate)}"></label>
      <label>Confirmation date<input type="date" name="confirmationDate" value="${fmtDate(member.confirmationDate instanceof Date ? member.confirmationDate.toISOString() : member.confirmationDate)}"></label>
      <div class="wide-cell">
        <details class="form-toggle" ${orgsOpen ? 'open' : ''}>
          <summary><strong>Choose organizations</strong>
            <span class="muted-text">${orgsOpen ? `(${memberOrgIds.length} selected)` : '(optional — click to expand)'}</span>
          </summary>
          <div class="check-grid" style="margin-top:0.5rem">${orgChecks || '<span class="muted-text">No organizations yet.</span>'}</div>
        </details>
      </div>
      <div class="wide-cell"><h3 class="form-section">Emergency contact</h3></div>
      <label>Contact name<input name="emergencyContactName" value="${esc(member.emergencyContactName)}"></label>
      <label>Contact phone<input name="emergencyContactPhone" value="${esc(member.emergencyContactPhone)}"></label>
      <label>Relationship<input name="emergencyContactRelation" placeholder="e.g. spouse, parent, sibling" value="${esc(member.emergencyContactRelation)}"></label>
      <label class="wide">Notes<textarea name="notes" rows="3">${esc(member.notes)}</textarea></label>
      <div class="actions form-actions">
        <a class="btn ghost" href="/members">Cancel</a>
        <button type="submit">Save member</button>
      </div>
    </form>`;
}

function register(app) {
  app.get('/members', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const q = (req.query.q || '').trim();
    const status = MEMBERSHIP_STATUSES.includes(req.query.status) ? req.query.status : '';
    const classId = (req.query.class || '').trim();
    const dayBorn = (req.query.day_born || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const where = {
      deletedAt: null,
      ...(status ? { membershipStatus: status } : {}),
      ...(classId ? { bibleClassId: Number(classId) } : {}),
      ...(dayBorn ? { dayBorn } : {}),
      ...(q ? { OR: [
        { firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } }, { mobilePhone: { contains: q } }, { externalId: { contains: q, mode: 'insensitive' } },
      ] } : {}),
    };

    const [matched, rows, totalMembers, activeMembers, newMembers, missingContact, inactiveMembers, classes] = await Promise.all([
      db.member.count({ where }),
      db.member.findMany({ where, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], take: MEMBERS_PER_PAGE, skip: (page - 1) * MEMBERS_PER_PAGE, include: { bibleClass: { select: { name: true } } } }),
      db.member.count({ where: { deletedAt: null } }),
      db.member.count({ where: { deletedAt: null, membershipStatus: { in: ['MEMBER', 'REGULAR'] } } }),
      db.member.count({ where: { deletedAt: null, joinDate: { gte: new Date(Date.now() - 30 * 86400000) } } }),
      db.member.count({ where: { deletedAt: null, email: null, mobilePhone: null } }),
      db.member.count({ where: { deletedAt: null, membershipStatus: { in: ['INACTIVE', 'TRANSFERRED', 'DECEASED'] } } }),
      db.ministry.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    const pages = Math.max(1, Math.ceil(matched / MEMBERS_PER_PAGE));

    const classOpts = `<option value="">All Bible classes</option>` + classes.map((c) => `<option value="${c.id}" ${String(c.id) === classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const statusOpts = [''].concat(MEMBERSHIP_STATUSES).map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${s ? MEMBER_STATUS_LABELS[s] : 'All statuses'}</option>`).join('');
    const dayBornOpts = `<option value="">All day-born</option>` + DAYS_OF_WEEK.map((d) => `<option value="${d}" ${d === dayBorn ? 'selected' : ''}>${d} (${esc(AKAN_NAMES[d] || d)})</option>`).join('');

    const hero = pageHero('Members Directory', 'Manage and view all church members in one place. Search, filter, and act on member records.');
    const stats = statsRow([
      { cls: 'gold', icon: icon('members'), value: totalMembers.toLocaleString(), label: 'Total Members' },
      { cls: 'green', icon: icon('attendance'), value: activeMembers.toLocaleString(), label: 'Active' },
      { cls: 'blue', icon: icon('plus'), value: newMembers.toLocaleString(), label: 'New (30d)' },
      { cls: missingContact ? 'orange' : 'green', icon: icon('phone'), value: missingContact.toLocaleString(), label: 'Missing Contact' },
      { cls: inactiveMembers ? 'purple' : 'blue', icon: icon('alert'), value: inactiveMembers.toLocaleString(), label: 'Inactive / Other' },
    ], `${isAdmin ? `<a class="btn primary" href="/members/new">＋ Add New Member</a>` : ''}
        <a class="btn ghost" href="/bible-classes">📚 Bible Classes</a>`);
    const filters = filterCard({
      q, placeholder: 'Search members by name, ID, email or phone…',
      controls: `<select name="class" aria-label="Filter by Bible class">${classOpts}</select>
        <select name="status" aria-label="Filter by status">${statusOpts}</select>
        <select name="day_born" aria-label="Filter by day-born">${dayBornOpts}</select>`,
    });

    const rowHtml = rows.map((r) => {
      const phone = esc(r.mobilePhone);
      const email = esc(r.email);
      const avatar = memberAvatar({ photo_filename: r.photoFilename, first_name: r.firstName, last_name: r.lastName });
      const actions = `
        <div class="row-actions">
          <a class="icon-btn view" href="/members/${r.id}" title="View" aria-label="View">${ICON_EYE}</a>
          ${isAdmin ? `<a class="icon-btn edit" href="/members/${r.id}#edit" title="Edit" aria-label="Edit">${ICON_PENCIL}</a>
          <form method="post" action="/members/${r.id}/delete" onsubmit="return confirm('Archive this member? They will be hidden but not permanently deleted.')">
            <button class="icon-btn del" type="submit" title="Archive" aria-label="Archive">${ICON_TRASH}</button>
          </form>` : ''}
        </div>`;
      return `<tr>
        <td data-label="Name">
          <div class="m-name-cell">
            ${avatar}
            <div>
              <a class="m-name" href="/members/${r.id}">${esc(r.firstName)} ${esc(r.lastName)}</a>
              <div class="m-sub">${esc(r.externalId) || '—'}</div>
            </div>
          </div>
        </td>
        <td data-label="Contact">
          <div class="m-contact">
            ${phone ? `<div><span class="ci">📞</span> <a href="tel:${phone}">${phone}</a></div>` : '<div class="muted-text">No phone</div>'}
            ${email ? `<div><span class="ci">✉</span> <a href="mailto:${email}">${email}</a></div>` : ''}
          </div>
        </td>
        <td data-label="Day Name">${r.dayBorn ? `<span class="pill pill-day" title="Akan Names: ${esc(AKAN_NAMES[r.dayBorn] || r.dayBorn)}">${esc(r.dayBorn)}</span>` : '—'}</td>
        <td data-label="Group">${esc(r.bibleClass && r.bibleClass.name) || '—'}</td>
        <td data-label="Status"><span class="pill pill-${esc(r.membershipStatus.toLowerCase())}">${esc(MEMBER_STATUS_LABELS[r.membershipStatus] || r.membershipStatus)}</span></td>
        <td data-label="Actions">${actions}</td>
      </tr>`;
    }).join('');

    const list = listCard({
      title: 'Members List', count: matched, countLabel: 'members', note: 'Results update as you search and filter',
      inner: rows.length ? `<table class="data-table members-table">
          <thead><tr><th>Name</th><th>Contact</th><th>Day Name</th><th>Group</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rowHtml}</tbody>
        </table>
        ${pager('/members', { q, status, class: classId, day_born: dayBorn }, page, pages)}` : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">👥</div>
          <h3>${q || classId || status || dayBorn ? 'No members match your search' : 'No members yet'}</h3>
          <p>${q || classId || status || dayBorn ? 'Try clearing filters or searching by phone number.' : 'Add your first member and the directory will start populating.'}</p>
          ${isAdmin ? '<a class="btn primary" href="/members/new">＋ Add New Member</a>' : ''}
          ${q || classId || status || dayBorn ? '<div style="margin-top:0.6rem"><a class="link" href="/members">Clear filters →</a></div>' : ''}
        </div>`,
    });

    res.page({ title: 'Members', active: '/members', noHeader: true, body: `${hero}${stats}${filters}${list}` });
  }));

  app.get('/members/new', requireAdmin, asyncHandler(async (req, res) => {
    res.page({ title: 'New member', active: '/members', noHeader: true, body: `${pageHero('New member', '')}${await memberForm(res.locals.db, {}, [], '/members')}` });
  }));

  app.post('/members', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    const err = memberErrors(b);
    if (err) { flash(req, err); return res.redirect('/members/new'); }
    const orgIds = parseOrgIds(b);
    if (!(await validOrgIds(db, orgIds))) { flash(req, 'One or more organizations were not found.'); return res.redirect('/members/new'); }
    const bibleClassCheck = await checkBibleClassId(db, b.bibleClassId);
    if (!bibleClassCheck.ok) { flash(req, 'Bible class not found.'); return res.redirect('/members/new'); }
    const externalId = await nextMemberId(db);
    const member = await db.member.create({ data: { ...parseMemberBody(b), bibleClassId: bibleClassCheck.bibleClassId, externalId, unsubscribeToken: require('crypto').randomBytes(16).toString('hex') } });
    if (orgIds.length) await saveMemberOrgs(db, member.id, orgIds);
    await logActivity(db, 'member_added', `New member added: ${b.firstName} ${b.lastName} (${externalId})`, `/members/${member.id}`, res.locals.user.id);
    res.redirect(`/members/${member.id}`);
  }));

  app.get('/members/:id', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const id = Number(req.params.id);
    const m = await db.member.findFirst({ where: { id, deletedAt: null }, include: { bibleClass: { select: { name: true } } } });
    if (!m) return res.status(404).send('Not found');

    const [memberOrgsNamed, ministries, sacraments, attendance] = await Promise.all([
      db.organizationMembership.findMany({ where: { memberId: id }, include: { organization: { select: { id: true, name: true } } } }),
      db.ministryMembership.findMany({ where: { memberId: id, leftDate: null }, include: { ministry: { select: { name: true } } } }),
      db.sacrament.findMany({ where: { OR: [{ memberId: id }, { spouseId: id }] }, orderBy: { occurredOn: 'desc' } }),
      db.attendance.findMany({ where: { memberId: id }, include: { event: { select: { title: true, startsAt: true } } }, orderBy: { checkedInAt: 'desc' }, take: 10 }),
    ]);
    const memberOrgIds = memberOrgsNamed.map((o) => o.orgId);

    const avatar = memberAvatar({ photo_filename: m.photoFilename, first_name: m.firstName, last_name: m.lastName });
    const photoBlock = isAdmin
      ? `<div class="member-photo">
           ${avatar}
           <form method="post" action="/members/${id}/photo" enctype="multipart/form-data" class="photo-form">
             <input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/gif" required>
             <button type="submit">${m.photoFilename ? 'Replace photo' : 'Upload photo'}</button>
           </form>
           ${m.photoFilename ? `
             <form method="post" action="/members/${id}/photo/delete" style="display:inline"
                   onsubmit="return confirm('Remove this photo?')">
               <button class="link" type="submit">Remove photo</button>
             </form>` : ''}
         </div>`
      : `<div class="member-photo">${avatar}</div>`;
    const editPanel = isAdmin
      ? `${photoBlock}
         <h2>Edit</h2>
         ${await memberForm(db, m, memberOrgIds, `/members/${id}`)}
         <form method="post" action="/members/${id}/delete" onsubmit="return confirm('Archive this member? They will be hidden but not permanently deleted.')">
           <button class="danger" type="submit">Archive member</button>
         </form>`
      : `${photoBlock}
         <h2>Profile</h2>
         <dl class="stats">
           <dt>Member ID</dt><dd>${esc(m.externalId) || '—'}</dd>
           <dt>Name</dt><dd>${esc(m.firstName)} ${esc(m.lastName)}</dd>
           <dt>Email</dt><dd>${esc(m.email) || '—'}</dd>
           <dt>Mobile</dt><dd>${esc(m.mobilePhone) || '—'}</dd>
           <dt>Status</dt><dd>${esc(MEMBER_STATUS_LABELS[m.membershipStatus] || m.membershipStatus)}</dd>
           <dt>Bible class</dt><dd>${esc(m.bibleClass && m.bibleClass.name) || '—'}</dd>
           <dt>Organizations</dt><dd>${memberOrgsNamed.map((o) => esc(o.organization.name)).join(', ') || '—'}</dd>
           <dt>Joined</dt><dd>${esc(fmtDate(m.joinDate)) || '—'}</dd>
           <dt>Baptized</dt><dd>${esc(fmtDate(m.baptismDate)) || '—'}</dd>
           <dt>Confirmed</dt><dd>${esc(fmtDate(m.confirmationDate)) || '—'}</dd>
           <dt>Notes</dt><dd>${esc(m.notes) || '—'}</dd>
         </dl>`;
    const body = `
      <div class="two-col">
        <section>${editPanel}</section>
        <section>
          <h2>At a glance</h2>
          <h3>🚨 Emergency contact</h3>
          ${(m.emergencyContactName || m.emergencyContactPhone || m.emergencyContactRelation)
            ? `<dl class="stats emergency-box">
                 <dt>Name</dt><dd>${esc(m.emergencyContactName) || '—'}</dd>
                 <dt>Phone</dt><dd>${m.emergencyContactPhone ? `<a href="tel:${esc(m.emergencyContactPhone)}">${esc(m.emergencyContactPhone)}</a>` : '—'}</dd>
                 <dt>Relationship</dt><dd>${esc(m.emergencyContactRelation) || '—'}</dd>
               </dl>`
            : '<p class="muted-text">No emergency contact on file.</p>'}
          <h3>Ministries</h3>
          ${ministries.length ? table(['Ministry', 'Role', 'Joined'], ministries.map((r) => [esc(r.ministry.name), esc(r.role), esc(fmtDate(r.joinedDate))])) : '<p>Not in any ministry.</p>'}
          <h3>Sacraments</h3>
          ${sacraments.length ? table(['Type', 'Date', 'Location'], sacraments.map((r) => [esc(r.sacramentType), esc(fmtDate(r.occurredOn)), esc(r.location)])) : '<p>None recorded.</p>'}
          <h3>Recent attendance</h3>
          ${attendance.length ? table(['Event', 'When'], attendance.map((r) => [esc(r.event.title), esc(fmtDate(r.event.startsAt))])) : '<p>No attendance recorded.</p>'}
        </section>
      </div>`;
    res.page({ title: `${m.firstName} ${m.lastName}`, active: '/members', noHeader: true, body: `${pageHero(`${m.firstName} ${m.lastName}`, '')}${body}` });
  }));

  app.post('/members/:id', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const b = req.body || {};
    const err = memberErrors(b);
    if (err) { flash(req, err); return res.redirect(`/members/${id}`); }
    const orgIds = parseOrgIds(b);
    if (!(await validOrgIds(db, orgIds))) { flash(req, 'One or more organizations were not found.'); return res.redirect(`/members/${id}`); }
    const bibleClassCheck = await checkBibleClassId(db, b.bibleClassId);
    if (!bibleClassCheck.ok) { flash(req, 'Bible class not found.'); return res.redirect(`/members/${id}`); }
    try {
      await db.member.update({ where: { id }, data: { ...parseMemberBody(b), bibleClassId: bibleClassCheck.bibleClassId } });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    await saveMemberOrgs(db, id, orgIds);
    await logActivity(db, 'member_updated', `Member updated: ${b.firstName} ${b.lastName}`, `/members/${id}`, res.locals.user.id);
    res.redirect(`/members/${id}`);
  }));

  app.post('/members/:id/delete', requireAdmin, asyncHandler(async (req, res) => {
    try {
      const removed = await res.locals.db.member.update({ where: { id: Number(req.params.id) }, data: { deletedAt: new Date() } });
      await logActivity(res.locals.db, 'member_deleted',
        `Member removed: ${removed.firstName} ${removed.lastName}${removed.externalId ? ` (${removed.externalId})` : ''}`,
        '/members', res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect('/members');
  }));

  app.post('/members/:id/photo', requireAdmin, photoUpload.single('photo'), asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    if (!req.file) return res.redirect(`/members/${id}`);
    if (!looksLikeImage(req.file.buffer)) {
      return res.status(400).send(`<p>That file does not look like a valid image. Upload a JPG, PNG, WebP or GIF.</p><p><a href="/members/${id}">Back</a></p>`);
    }
    const ext = EXT_FROM_MIME[req.file.mimetype.toLowerCase()] || 'jpg';
    const filename = `${id}.${ext}`;
    fs.writeFileSync(path.join(PHOTO_DIR, filename), req.file.buffer);
    // Remove any stale photos with other extensions for this member.
    for (const otherExt of Object.values(EXT_FROM_MIME)) {
      if (otherExt !== ext) {
        try { fs.unlinkSync(path.join(PHOTO_DIR, `${id}.${otherExt}`)); } catch (_) { /* didn't exist */ }
      }
    }
    try {
      await db.member.update({ where: { id }, data: { photoFilename: filename } });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    await logActivity(db, 'member_photo_updated', `Member photo updated for #${id}`, `/members/${id}`, res.locals.user.id);
    res.redirect(`/members/${id}`);
  }));

  app.post('/members/:id/photo/delete', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const m = await db.member.findFirst({ where: { id }, select: { photoFilename: true } });
    if (m && m.photoFilename) {
      try { fs.unlinkSync(path.join(PHOTO_DIR, m.photoFilename)); } catch (_) { /* already gone */ }
      await db.member.update({ where: { id }, data: { photoFilename: null } });
      await logActivity(db, 'member_photo_deleted', `Member photo removed for #${id}`, `/members/${id}`, res.locals.user.id);
    }
    res.redirect(`/members/${id}`);
  }));

  // Serve member photos. Cross-tenant check: only served if the requesting
  // user's own church actually has a member with this photoFilename — see
  // the module header for why this is necessary here but wasn't in the
  // single-tenant original.
  app.get('/photos/:filename', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const safe = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const owner = await res.locals.db.member.findFirst({ where: { photoFilename: safe }, select: { id: true } });
    if (!owner) return res.status(404).send('Not found');
    const full = path.join(PHOTO_DIR, safe);
    if (!fs.existsSync(full)) return res.status(404).send('Not found');
    res.sendFile(full);
  }));
}

module.exports = { register };
