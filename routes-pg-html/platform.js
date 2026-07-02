'use strict';
// Phase 8e: HTML surface for routes-pg/platform.js. Genuinely NEW page (no
// original precedent — see routes-pg/platform.js's own header comment: this
// is real cross-tenant SaaS-operator tooling, not a port of the old
// single-tenant /tenant page). JSON stays at /api/platform/..., this is the
// bare-path HTML surface, gated by the same PLATFORM_ADMIN_EMAILS allowlist.
//
// SAFETY: uses the RAW (unscoped) Prisma client deliberately — this is the
// one legitimate cross-tenant view in the whole app. requirePlatformAdmin
// gates every handler before it touches the raw client.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, listCard, table } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { db: rawDb } = require('../lib/tenant');
const { isPro } = require('../routes-pg/settings');

// requirePlatformAdmin* is JSON-only (403 JSON) — this HTML variant redirects
// to / instead, matching every other module's admin-gate HTML convention.
function requirePlatformAdmin(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  const allow = String(process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (allow.includes(res.locals.user.email.toLowerCase())) return next();
  return res.status(403).send('Platform admin only');
}

function register(app) {
  app.get('/platform', requirePlatformAdmin, asyncHandler(async (req, res) => {
    const [churches, churchCount, userCount, memberCount, proCount] = await Promise.all([
      rawDb.church.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { users: true, members: true } } } }),
      rawDb.church.count(),
      rawDb.user.count({ where: { deletedAt: null } }),
      rawDb.member.count({ where: { deletedAt: null } }),
      rawDb.church.count({ where: { plan: 'pro' } }),
    ]);

    const rows = churches.map((c) => [
      esc(c.name), esc(c.slug),
      isPro(c) ? '<span class="pill pill-fulfilled">Pro</span>' : '<span class="pill pill-pending">Free</span>',
      c.proUntil ? esc(c.proUntil.toISOString().slice(0, 10)) : '—',
      c._count.users, c._count.members,
      esc(c.createdAt.toISOString().slice(0, 10)),
      `<form method="post" action="/platform/churches/${c.id}/plan" class="inline">
         <select name="plan"><option value="free" ${c.plan === 'free' ? 'selected' : ''}>free</option><option value="pro" ${c.plan === 'pro' ? 'selected' : ''}>pro</option></select>
         <input type="number" name="months" placeholder="months" min="1" style="width:80px">
         <button type="submit">Save</button>
       </form>`,
    ]);

    const body = `
      ${pageHero('Platform Admin', 'Cross-tenant view for the person running this SaaS — not any individual church.')}
      ${statsRow([
        { cls: 'gold', icon: '▣', value: churchCount.toLocaleString(), label: 'Churches' },
        { cls: 'green', icon: '★', value: proCount.toLocaleString(), label: 'Pro churches' },
        { cls: 'blue', icon: '🔑', value: userCount.toLocaleString(), label: 'Users (all churches)' },
        { cls: 'purple', icon: '👥', value: memberCount.toLocaleString(), label: 'Members (all churches)' },
      ])}
      ${listCard({
        title: 'Churches', count: churches.length, countLabel: 'churches',
        inner: churches.length ? table(['Name', 'Slug', 'Plan', 'Pro until', 'Users', 'Members', 'Signed up', 'Set plan'], rows) : '<p class="muted-text">No churches yet.</p>',
      })}`;
    res.page({ title: 'Platform Admin', active: '/platform', noHeader: true, body });
  }));

  app.post('/platform/churches/:id/plan', requirePlatformAdmin, asyncHandler(async (req, res) => {
    const { plan, months } = req.body || {};
    if (!['free', 'pro'].includes(plan)) { flash(req, 'Plan must be "free" or "pro".'); return res.redirect('/platform'); }
    const data = { plan };
    if (plan === 'pro') {
      data.proSince = new Date();
      data.proUntil = months ? new Date(Date.now() + Number(months) * 30 * 24 * 60 * 60 * 1000) : null;
    } else {
      data.proSince = null;
      data.proUntil = null;
    }
    try {
      await rawDb.church.update({ where: { id: req.params.id }, data });
      flash(req, 'Plan updated.', 'success');
    } catch (e) {
      if (e.code !== 'P2025') throw e;
      flash(req, 'Church not found.');
    }
    res.redirect('/platform');
  }));
}

module.exports = { register };
