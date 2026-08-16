'use strict';
// Phase 6, module 1: Postgres/Prisma port of the /users section of
// server.js. Same coexistence approach as every prior phase.
//
// NOTABLE FIX, not just a port: the original gates create/reset/delete/
// disable-2FA behind `isUserManager`, which is hardcoded to
// `username === 'dunwelladmin'` (server.js:1005-1006) — a single-tenant hack
// that makes no sense once every church has its own ADMIN. This port uses
// `role === 'ADMIN'` (i.e. this church's own owner) for all of it instead,
// per the Phase-1 decision to not carry hardcoded single-tenant usernames
// forward. Role-change ("/role") already used the real requireOwner gate in
// the original, so that part is an unchanged port.

const bcrypt = require('bcryptjs');
const asyncHandler = require('../lib/async-handler');
const { canAddUser, upgradeMessage } = require('../lib/plan');

const ROLES = ['ADMIN', 'EDITOR', 'VIEWER'];
const FINANCE_ROLES = ['NONE', 'CASHIER', 'TREASURER', 'AUDITOR', 'FINANCE_ADMIN'];

function requireOwner(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function shapeUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, displayName: u.displayName,
    role: u.role, financeRole: u.financeRole, totpEnabled: u.totpEnabled, createdAt: u.createdAt,
  };
}

function register(app) {
  app.get('/api/users', requireOwner, asyncHandler(async (req, res) => {
    const rows = await res.locals.db.user.findMany({ where: { deletedAt: null }, orderBy: { username: 'asc' } });
    res.json(rows.map(shapeUser));
  }));

  app.post('/api/users', requireOwner, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const b = req.body || {};
    if (!b.username || !String(b.username).trim()) return res.status(400).json({ error: 'username is required' });
    if (!b.email || !/^\S+@\S+\.\S+$/.test(b.email)) return res.status(400).json({ error: 'a valid email is required' });
    if (!b.password || String(b.password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const role = ROLES.includes(b.role) ? b.role : 'VIEWER';
    const financeRole = FINANCE_ROLES.includes(b.financeRole) ? b.financeRole : 'NONE';

    // email is globally unique across ALL tenants (the login identifier —
    // see lib/provision.js), so this check must use the RAW client, not the
    // church-scoped one, to catch a collision with a DIFFERENT church's user.
    const { db: rawDb } = require('../lib/tenant');
    const existing = await rawDb.user.findUnique({ where: { email: b.email.toLowerCase().trim() } });
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    // Same seat limit as the HTML form. Enforcing on only one of the two
    // surfaces would leave the API as a way around the plan.
    const activeUsers = await db.user.count({ where: { deletedAt: null } });
    if (!canAddUser(res.locals.church, activeUsers)) {
      return res.status(402).json({ error: upgradeMessage('users'), code: 'plan_limit' });
    }

    const passwordHash = await bcrypt.hash(b.password, 10);
    try {
      const user = await db.user.create({
        data: { username: String(b.username).trim(), email: b.email.toLowerCase().trim(), passwordHash, displayName: b.displayName || null, role, financeRole },
      });
      res.status(201).json(shapeUser(user));
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'That username is already taken in this church' });
      throw e;
    }
  }));

  app.put('/api/users/:id/role', requireOwner, asyncHandler(async (req, res) => {
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
        return res.status(400).json({ error: "Cannot demote the church's last admin — promote another user first" });
      }
    }
    try {
      const user = await db.user.update({ where: { id }, data: { role, financeRole } });
      res.json(shapeUser(user));
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.post('/api/users/:id/reset-password', requireOwner, asyncHandler(async (req, res) => {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      await res.locals.db.user.update({ where: { id: Number(req.params.id) }, data: { passwordHash } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.post('/api/users/:id/disable-2fa', requireOwner, asyncHandler(async (req, res) => {
    try {
      await res.locals.db.user.update({ where: { id: Number(req.params.id) }, data: { totpSecret: null, totpEnabled: false } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.delete('/api/users/:id', requireOwner, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (id === res.locals.user.id) return res.status(400).json({ error: "You can't delete your own account" });
    try {
      await res.locals.db.user.update({ where: { id }, data: { deletedAt: new Date() } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));
}

module.exports = { register };
