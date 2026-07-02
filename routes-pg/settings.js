'use strict';
// Phase 6, module 2: church-scoped settings. Ports a bounded slice of the
// original /settings + /tenant pages — church profile and a read-only
// self-service "my plan" view. Plan CHANGES are deliberately NOT self-
// service here (see routes-pg/platform.js) — mirrors poultry-manager's
// manual-activation model, where an operator flips a church to Pro after
// payment, not the church itself.
//
// DEFERRED (documented): birthday-reminder automation and SMS/email test-
// send settings — both depend on the already-deferred delivery integration
// (see routes-pg/communications.js's module header).

const asyncHandler = require('../lib/async-handler');

const PLAN_LIMITS = {
  free: { label: 'Free', maxUsers: 2, reports: false },
  pro: { label: 'Pro', maxUsers: null, reports: true },
};

function requireOwner(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function isPro(church) {
  if (church.plan !== 'pro') return false;
  return !church.proUntil || new Date(church.proUntil) > new Date();
}

function register(app) {
  app.get('/api/settings', requireAuth, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const userCount = await db.user.count({ where: { deletedAt: null } });
    const pro = isPro(church);
    res.json({
      church: { id: church.id, name: church.name, slug: church.slug },
      plan: {
        key: pro ? 'pro' : 'free',
        label: PLAN_LIMITS[pro ? 'pro' : 'free'].label,
        maxUsers: PLAN_LIMITS[pro ? 'pro' : 'free'].maxUsers,
        reports: PLAN_LIMITS[pro ? 'pro' : 'free'].reports,
        proUntil: church.proUntil,
        userCount,
      },
    });
  }));

  app.put('/api/settings', requireOwner, asyncHandler(async (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const church = await res.locals.db.church.update({ where: { id: res.locals.churchId }, data: { name } });
    res.json({ id: church.id, name: church.name, slug: church.slug });
  }));
}

module.exports = { register, PLAN_LIMITS, isPro };
