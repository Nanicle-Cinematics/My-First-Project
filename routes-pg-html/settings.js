'use strict';
// Phase 8e: HTML port of routes-pg/settings.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/settings.js (JSON at /api/settings, this
// is the bare-path HTML surface).
//
// SCOPE matches routes-pg/settings.js exactly: church profile (name, editable)
// + a read-only "my plan" view. Plan CHANGES are deliberately NOT self-
// service here — that's routes-pg-html/platform.js's job (cross-tenant
// admin, manual activation model). DEFERRED: birthday-reminder automation,
// SMS/email test-send (both depend on the already-deferred delivery
// integration — see communications module's header).

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { PLAN_LIMITS, isPro } = require('../routes-pg/settings');

function requireOwner(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  if (res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

function register(app) {
  app.get('/settings', requireOwner, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const userCount = await db.user.count({ where: { deletedAt: null } });
    const pro = isPro(church);
    const plan = PLAN_LIMITS[pro ? 'pro' : 'free'];

    const body = `
      ${pageHero('Settings', 'Church profile and current plan.')}
      ${statsRow([
        { cls: 'blue', icon: '▣', value: esc(plan.label), label: 'Plan' },
        { cls: 'green', icon: '🔑', value: `${userCount}${plan.maxUsers ? '/' + plan.maxUsers : ''}`, label: 'Users' },
      ])}
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Church profile</h2></div>
        <form class="form" method="post" action="/settings">
          <label class="wide">Church name<input name="name" required value="${esc(church.name)}"></label>
          <div class="actions"><button type="submit">Save changes</button></div>
        </form>
      </section>
      <section class="card">
        <div class="card-head"><h2>Plan</h2><span class="meta">Contact us to change your plan</span></div>
        <dl class="stats">
          <dt>Plan</dt><dd>${esc(plan.label)}</dd>
          <dt>Max users</dt><dd>${plan.maxUsers ?? 'Unlimited'}</dd>
          <dt>Reports</dt><dd>${plan.reports ? 'Included' : 'Not included'}</dd>
          <dt>Pro until</dt><dd>${church.proUntil ? esc(church.proUntil.toISOString().slice(0, 10)) : '—'}</dd>
        </dl>
      </section>`;
    res.page({ title: 'Settings', active: '/settings', noHeader: true, body });
  }));

  app.post('/settings', requireOwner, asyncHandler(async (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) { flash(req, 'Church name is required.'); return res.redirect('/settings'); }
    await res.locals.db.church.update({ where: { id: res.locals.churchId }, data: { name } });
    flash(req, 'Settings saved.', 'success');
    res.redirect('/settings');
  }));
}

module.exports = { register };
