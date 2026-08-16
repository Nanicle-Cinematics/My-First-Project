'use strict';
// Phase 8e: HTML port of the /users section of server.js onto the Postgres
// stack. Registered ALONGSIDE routes-pg/users.js (JSON at /api/users, this
// is the bare-path HTML surface).
//
// NOTABLE FIX carried over from routes-pg/users.js (not just a port): the
// original gates create/reset/delete/disable-2FA behind `isUserManager`,
// hardcoded to `username === 'dunwelladmin'` — a single-tenant hack. This
// port uses `role === 'ADMIN'` (this church's own owner) uniformly instead,
// matching routes-pg/users.js's already-made Phase-1 decision.
//
// New user creation now requires an email (globally-unique login identifier
// — see lib/provision.js/lib/auth.js), not just a username+password, since
// login is email-based on this stack.

const bcrypt = require('bcryptjs');
const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { logActivity } = require('../lib/tenant-activity');
const { logSecurityEvent } = require('../lib/security-audit');
const { db: rawDb } = require('../lib/tenant');
const { canAddUser, upgradeMessage } = require('../lib/plan');

const ROLES = ['ADMIN', 'EDITOR', 'VIEWER'];
const FINANCE_ROLES = ['NONE', 'CASHIER', 'TREASURER', 'AUDITOR', 'FINANCE_ADMIN'];
const FINANCE_ROLE_LABELS = { NONE: 'No finance access', CASHIER: 'Cashier', TREASURER: 'Steward / Treasurer', AUDITOR: 'Auditor', FINANCE_ADMIN: 'Finance admin' };

function requireOwner(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  if (res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

function register(app) {
  app.get('/users', requireOwner, asyncHandler(async (req, res) => {
    const users = await res.locals.db.user.findMany({ where: { deletedAt: null }, orderBy: { username: 'asc' } });
    const rows = users.map((u) => [
      esc(u.username), esc(u.displayName) || '—',
      `<span class="role-badge role-${esc(u.role.toLowerCase())}">${esc(u.role)}</span>`,
      esc(FINANCE_ROLE_LABELS[u.financeRole || 'NONE'] || u.financeRole),
      u.totpEnabled ? '<span class="pill pill-admin" title="2FA active">2FA ✓</span>' : '<span class="muted-text">—</span>',
      esc(u.createdAt.toISOString().slice(0, 10)),
      `<form method="post" action="/users/${u.id}/role" class="inline">
         <select name="role">${ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r.toLowerCase()}</option>`).join('')}</select>
         <select name="financeRole">${Object.entries(FINANCE_ROLE_LABELS).map(([v, l]) => `<option value="${v}" ${(u.financeRole || 'NONE') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
         <button type="submit">Save</button>
       </form>
       <form method="post" action="/users/${u.id}/reset" class="inline">
         <input type="password" name="password" placeholder="new password" minlength="8" required>
         <button type="submit">Reset</button>
       </form>
       ${u.totpEnabled ? `<form method="post" action="/users/${u.id}/disable-2fa" class="inline" onsubmit="return confirm('Disable 2FA for ${esc(u.username)}?')"><button type="submit">Disable 2FA</button></form>` : ''}
       ${u.id !== res.locals.user.id ? `<form method="post" action="/users/${u.id}/delete" class="inline" onsubmit="return confirm('Delete ${esc(u.username)}?')"><button class="danger" type="submit">Delete</button></form>` : ''}`,
    ]);
    const body = `
      ${pageHero('Users & Roles', 'Admin-only access control for staff and ministry administrators.')}
      <p class="muted-text">Any administrator can set a user's access level: <strong>Admin</strong> = full read &amp; write; <strong>Viewer</strong> = read-only.</p>
      <p class="muted-text">Finance roles are separate: <strong>Cashiers</strong> record income/expenses, <strong>Treasurers</strong> record and review accounting, <strong>Auditors</strong> review accounting only, and <strong>Finance admins</strong> can do both.</p>
      <div class="page-actions"><a class="btn primary" href="/users/new">＋ New user</a></div>
      ${table(['Username', 'Display name', 'Role', 'Finance role', '2FA', 'Created', 'Actions'], rows)}`;
    res.page({ title: 'Users', active: '/users', noHeader: true, body });
  }));

  app.get('/users/new', requireOwner, (req, res) => {
    const body = `
      <form class="form" method="post" action="/users">
        <label>Username<input name="username" required></label>
        <label>Display name<input name="displayName"></label>
        <label>Email<input type="email" name="email" required></label>
        <label>Password<input type="password" name="password" required minlength="8"></label>
        <label>Role<select name="role">
          <option value="ADMIN">admin (full access)</option>
          <option value="EDITOR">editor (manage records)</option>
          <option value="VIEWER" selected>viewer (read-only)</option>
        </select>
        <span class="hint">Admins manage everything incl. users &amp; settings. Editors manage records but not those admin areas. Viewers are read-only.</span></label>
        <label>Finance role<select name="financeRole">
          ${Object.entries(FINANCE_ROLE_LABELS).map(([v, l]) => `<option value="${v}"${v === 'NONE' ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <span class="hint">Finance roles control recording and accounting access inside the Finance module.</span></label>
        <div class="actions form-actions">
          <a class="btn ghost" href="/users">Cancel</a>
          <button type="submit">Create user</button>
        </div>
      </form>`;
    res.page({ title: 'New user', active: '/users', noHeader: true, body: `${pageHero('New user', '')}${body}` });
  });

  app.post('/users', requireOwner, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    if (!b.username || !String(b.username).trim()) { flash(req, 'Username is required.'); return res.redirect('/users/new'); }
    if (!b.email || !/^\S+@\S+\.\S+$/.test(b.email)) { flash(req, 'A valid email is required.'); return res.redirect('/users/new'); }
    if (!b.password || String(b.password).length < 8) { flash(req, 'Password must be at least 8 characters.'); return res.redirect('/users/new'); }
    const role = ROLES.includes(b.role) ? b.role : 'VIEWER';
    const financeRole = FINANCE_ROLES.includes(b.financeRole) ? b.financeRole : 'NONE';

    const existing = await rawDb.user.findUnique({ where: { email: b.email.toLowerCase().trim() } });
    if (existing) { flash(req, 'An account with that email already exists.'); return res.redirect('/users/new'); }

    // Seat limit. Checked against active accounts only, so a soft-deleted user
    // frees its seat, and enforced here rather than by disabling anyone: a
    // church already over the limit keeps its people and simply cannot add.
    const activeUsers = await db.user.count({ where: { deletedAt: null } });
    if (!canAddUser(res.locals.church, activeUsers)) {
      flash(req, upgradeMessage('users'));
      return res.redirect('/settings');
    }

    const passwordHash = await bcrypt.hash(b.password, 10);
    try {
      const user = await db.user.create({
        data: { username: String(b.username).trim(), email: b.email.toLowerCase().trim(), passwordHash, displayName: b.displayName || null, role, financeRole },
      });
      await logActivity(db, 'user_created', `User created: ${user.username} (${role})`, '/users', res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      flash(req, 'That username is already taken in this church.');
      return res.redirect('/users/new');
    }
    res.redirect('/users');
  }));

  app.post('/users/:id/role', requireOwner, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const id = Number(req.params.id);
    const role = ROLES.includes(req.body.role) ? req.body.role : 'VIEWER';
    const financeRole = FINANCE_ROLES.includes(req.body.financeRole) ? req.body.financeRole : 'NONE';
    if (role !== 'ADMIN') {
      const [admins, target] = await Promise.all([
        db.user.count({ where: { role: 'ADMIN', deletedAt: null } }),
        db.user.findUnique({ where: { id } }),
      ]);
      if (target && target.role === 'ADMIN' && admins <= 1) {
        flash(req, "Cannot demote the church's last admin — promote another user first.");
        return res.redirect('/users');
      }
    }
    try {
      const updated = await db.user.update({ where: { id }, data: { role, financeRole } });
      await logActivity(db, 'user_role_changed',
        `Role changed for ${updated.username}: ${role} / finance ${financeRole}`, '/users', res.locals.user.id);
      // A privilege change is a security event, not just feed noise — same
      // trail (with IP/user-agent) the MFA changes in settings.js write to.
      await logSecurityEvent(db, req, {
        event: 'user.role_changed',
        subject: `${updated.email} -> ${role}/${financeRole}`,
        actorId: res.locals.user.id,
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    res.redirect('/users');
  }));

  app.post('/users/:id/reset', requireOwner, asyncHandler(async (req, res) => {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) { flash(req, 'Password must be at least 8 characters.'); return res.redirect('/users'); }
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const target = await res.locals.db.user.update({ where: { id: Number(req.params.id) }, data: { passwordHash } });
      await logActivity(res.locals.db, 'user_password_reset', `Password reset for ${target.username}`, '/users', res.locals.user.id);
      await logSecurityEvent(res.locals.db, req, {
        event: 'user.password_reset_by_admin',
        subject: target.email,
        actorId: res.locals.user.id,
      });
      flash(req, 'Password reset.', 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    res.redirect('/users');
  }));

  app.post('/users/:id/disable-2fa', requireOwner, asyncHandler(async (req, res) => {
    try {
      const target = await res.locals.db.user.update({ where: { id: Number(req.params.id) }, data: { totpSecret: null, totpEnabled: false } });
      await logActivity(res.locals.db, 'user_2fa_disabled', `Two-factor disabled for ${target.username}`, '/users', res.locals.user.id);
      // Distinct from settings.js's self-service 'auth.mfa_disabled' — this is
      // an admin disabling it on someone else's account.
      await logSecurityEvent(res.locals.db, req, {
        event: 'user.mfa_disabled_by_admin',
        subject: target.email,
        actorId: res.locals.user.id,
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    res.redirect('/users');
  }));

  app.post('/users/:id/delete', requireOwner, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === res.locals.user.id) { flash(req, "You can't delete your own account."); return res.redirect('/users'); }
    try {
      const target = await res.locals.db.user.update({ where: { id }, data: { deletedAt: new Date() } });
      await logActivity(res.locals.db, 'user_deleted', `User account deleted: ${target.username}`, '/users', res.locals.user.id);
      await logSecurityEvent(res.locals.db, req, {
        event: 'user.deleted',
        subject: target.email,
        actorId: res.locals.user.id,
      });
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      return res.status(404).send('Not found');
    }
    res.redirect('/users');
  }));
}

module.exports = { register };
