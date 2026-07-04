'use strict';
// Phase 6, module 3: platform (SaaS-operator) admin — the "generalize
// /tenant + /operations into real platform-admin tooling now that there are
// many tenants" item from the migration plan. This is genuinely NEW
// capability, not a port: the original /tenant page let each church's own
// owner self-report their plan/status (that made sense in the old
// deploy-per-church model, where the deployment WAS the customer); it's
// replaced here by (a) routes-pg/settings.js's read-only per-church "my
// plan" view, and (b) this file, a real cross-tenant view for the person
// running the SaaS platform itself, not any individual church.
//
// DECISION (one of the plan's explicitly flagged open items — "platform/
// superadmin model: dedicated table vs. env allowlist"): went with an env
// allowlist (PLATFORM_ADMIN_EMAILS, comma-separated), the simpler of the
// two options. A dedicated PlatformAdmin table would be the natural
// upgrade if/when this needs finer-grained roles.
//
// SAFETY: every handler here deliberately uses the RAW (unscoped) Prisma
// client — that's the whole point, seeing across tenants — so none of it
// goes through tenantDb's protection. Gate first, always: requirePlatformAdmin
// runs before any handler touches the raw client.

const asyncHandler = require('../lib/async-handler');
const { db: rawDb } = require('../lib/tenant');
const { isPro } = require('./settings');
const { requestIp, requestUserAgent } = require('../lib/security-audit');

function platformAdminEmails() {
  return String(process.env.PLATFORM_ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function requirePlatformAdmin(req, res, next) {
  const email = res.locals.user && res.locals.user.email;
  if (email && platformAdminEmails().includes(email.toLowerCase())) return next();
  return res.status(403).json({ error: 'platform admin only' });
}

function register(app) {
  app.get('/api/platform/churches', requirePlatformAdmin, asyncHandler(async (req, res) => {
    const churches = await rawDb.church.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true, members: true } } },
    });
    res.json(churches.map((c) => ({
      id: c.id, name: c.name, slug: c.slug, plan: c.plan, proUntil: c.proUntil,
      suspendedAt: c.suspendedAt, suspensionReason: c.suspensionReason,
      deletedAt: c.deletedAt, deletionReason: c.deletionReason,
      deletionPurgeAfter: c.deletionPurgeAfter,
      isPro: isPro(c), createdAt: c.createdAt,
      userCount: c._count.users, memberCount: c._count.members,
    })));
  }));

  app.get('/api/platform/summary', requirePlatformAdmin, asyncHandler(async (req, res) => {
    const [churchCount, userCount, memberCount, proCount] = await Promise.all([
      rawDb.church.count(),
      rawDb.user.count({ where: { deletedAt: null } }),
      rawDb.member.count({ where: { deletedAt: null } }),
      rawDb.church.count({ where: { plan: 'pro' } }),
    ]);
    res.json({ churches: churchCount, users: userCount, members: memberCount, proChurches: proCount });
  }));

  // Operator-run plan activation (mirrors poultry-manager's scripts/set-plan.mjs,
  // as a real authenticated endpoint instead of a script — flip a church to
  // Pro after a manual payment is confirmed).
  app.post('/api/platform/churches/:id/plan', requirePlatformAdmin, asyncHandler(async (req, res) => {
    const { plan, months } = req.body || {};
    if (!['free', 'pro'].includes(plan)) return res.status(400).json({ error: 'plan must be "free" or "pro"' });
    const data = { plan };
    if (plan === 'pro') {
      data.proSince = new Date();
      data.proUntil = months ? new Date(Date.now() + Number(months) * 30 * 24 * 60 * 60 * 1000) : null;
    } else {
      data.proSince = null;
      data.proUntil = null;
    }
    try {
      const church = await rawDb.church.update({ where: { id: req.params.id }, data });
      await rawDb.securityAuditLog.create({ data: {
        churchId: church.id, actorId: res.locals.user.id,
        event: plan === 'pro' ? 'platform.plan_upgraded' : 'platform.plan_downgraded',
        subject: `${church.name} (${church.slug}) -> ${plan}`,
        ip: requestIp(req), userAgent: requestUserAgent(req),
      } });
      res.json({ id: church.id, plan: church.plan, proUntil: church.proUntil });
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.post('/api/platform/churches/:id/access', requirePlatformAdmin, asyncHandler(async (req, res) => {
    const action = String(req.body?.action || '');
    if (!['suspend', 'reactivate', 'delete', 'restore'].includes(action)) {
      return res.status(400).json({ error: 'invalid access action' });
    }
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (['suspend', 'delete'].includes(action) && !reason) {
      return res.status(400).json({ error: 'a reason is required' });
    }
    try {
      const existing = await rawDb.church.findUnique({ where: { id: req.params.id } });
      if (!existing) return res.status(404).json({ error: 'Not found' });
      if (action === 'delete' && String(req.body?.confirmSlug || '') !== existing.slug) {
        return res.status(400).json({ error: 'confirmSlug must exactly match the church slug' });
      }
      const data = action === 'suspend'
        ? { suspendedAt: new Date(), suspensionReason: reason }
        : action === 'reactivate'
          ? { suspendedAt: null, suspensionReason: null }
          : action === 'delete'
            ? {
              deletedAt: new Date(), deletionReason: reason,
              deletionPurgeAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            }
            : { deletedAt: null, deletionReason: null, deletionPurgeAfter: null };
      const church = await rawDb.church.update({
        where: { id: req.params.id },
        data,
      });
      const events = {
        suspend: 'platform.church_suspended', reactivate: 'platform.church_reactivated',
        delete: 'platform.church_deleted', restore: 'platform.church_restored',
      };
      await rawDb.securityAuditLog.create({
        data: {
          churchId: church.id,
          actorId: res.locals.user.id,
          event: events[action],
          subject: ['suspend', 'delete'].includes(action) ? reason : `${church.name} ${action}d`,
          ip: String(req.ip || '').slice(0, 128) || null,
          userAgent: String(req.get('user-agent') || '').slice(0, 512) || null,
        },
      });
      return res.json({
        id: church.id, suspendedAt: church.suspendedAt, suspensionReason: church.suspensionReason,
        deletedAt: church.deletedAt, deletionReason: church.deletionReason,
        deletionPurgeAfter: church.deletionPurgeAfter,
      });
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));
}

module.exports = { register, platformAdminEmails, requirePlatformAdmin };
