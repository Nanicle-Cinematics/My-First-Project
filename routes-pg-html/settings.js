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
const { esc, looksLikeImage } = require('../lib/format');
const { pageHero, statsRow } = require('../lib/views');
const { flash } = require('../lib/tenant-flash');
const { PLAN_LIMITS, isPro } = require('../routes-pg/settings');
const QRCode = require('qrcode');
const { createTotpSecret, verifyTotp, createRecoveryCodes, consumeRecoveryCode } = require('../lib/mfa');
const { logSecurityEvent } = require('../lib/security-audit');
const { logActivity } = require('../lib/tenant-activity');
const { db: rawDb } = require('../lib/tenant');
const { exportTenantData } = require('../lib/tenant-export');
const { csrfValid } = require('../lib/tenant-csrf');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { icon } = require('../lib/icons');

const LOGO_DIR = process.env.LOGO_DIR || path.join(process.env.PHOTO_DIR || path.join(__dirname, '..', 'photos'), 'church-logos');
const DEFAULT_LOGO = path.join(__dirname, '..', 'public', 'logo.png');
const LOGO_EXTENSIONS = ['png', 'jpg', 'webp', 'gif'];
const LOGO_EXT_FROM_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch (_) { /* created by the mounted volume at runtime */ }
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = Object.hasOwn(LOGO_EXT_FROM_MIME, String(file.mimetype).toLowerCase());
    cb(ok ? null : new Error('Only JPG, PNG, WebP or GIF images are allowed.'), ok);
  },
});
function tenantLogoPath(churchId) {
  for (const ext of LOGO_EXTENSIONS) {
    const candidate = path.join(LOGO_DIR, `${churchId}.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
function deleteTenantLogo(churchId) {
  for (const ext of LOGO_EXTENSIONS) {
    try { fs.unlinkSync(path.join(LOGO_DIR, `${churchId}.${ext}`)); } catch (_) { /* no file with this extension */ }
  }
}

function requireOwner(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  if (res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  next();
}

function mfaControls(user) {
  return user.totpEnabled ? `
    <p>Your account requires an authenticator or one-time recovery code at sign-in.</p>
    <form class="form" method="post" action="/settings/mfa/disable">
      <label class="wide">Current authenticator or recovery code<input name="code" required autocomplete="one-time-code"></label>
      <div class="actions"><button class="danger" type="submit">Disable two-factor authentication</button></div>
    </form>` : `
    <p>Protect your account with an authenticator app. You will also receive ten one-time recovery codes.</p>
    <form method="post" action="/settings/mfa/start">
      <button type="submit">Set up two-factor authentication</button>
    </form>`;
}

function register(app) {
  app.get('/branding/logo', (req, res) => {
    const custom = res.locals.churchId ? tenantLogoPath(res.locals.churchId) : null;
    res.set('Cache-Control', custom ? 'private, no-store' : 'public, max-age=86400');
    res.sendFile(custom || DEFAULT_LOGO);
  });

  app.get('/profile', requireAuth, (req, res) => {
    const user = res.locals.user;
    const body = `
      ${pageHero('My account', 'Identity and sign-in security.')}
      <section class="card">
        <dl class="stats">
          <dt>Name</dt><dd>${esc(user.displayName || user.username)}</dd>
          <dt>Email</dt><dd>${esc(user.email || '—')}</dd>
          <dt>Role</dt><dd>${esc(user.role)}</dd>
        </dl>
      </section>
      <section class="card" style="margin-top:1rem">
        <div class="card-head"><h2>Two-factor authentication</h2><span class="meta">${user.totpEnabled ? 'Enabled' : 'Not enabled'}</span></div>
        ${mfaControls(user)}
      </section>`;
    res.page({ title: 'My account', active: null, noHeader: true, body });
  });

  app.get('/settings', requireOwner, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const church = await db.church.findUnique({ where: { id: res.locals.churchId } });
    const userCount = await db.user.count({ where: { deletedAt: null } });
    const pro = isPro(church);
    const plan = PLAN_LIMITS[pro ? 'pro' : 'free'];

    const body = `
      ${pageHero('Settings', 'Church profile and current plan.')}
      ${statsRow([
        { cls: 'blue', icon: icon('platform'), value: esc(plan.label), label: 'Plan' },
        { cls: 'green', icon: icon('users'), value: `${userCount}${plan.maxUsers ? '/' + plan.maxUsers : ''}`, label: 'Users' },
      ])}
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Church profile</h2></div>
        <form class="form" method="post" action="/settings">
          <label class="wide">Church name<input name="name" required value="${esc(church.name)}"></label>
          <div class="actions"><button type="submit">Save changes</button></div>
        </form>
      </section>
      <section class="card church-branding-card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Church logo</h2><span class="meta">${tenantLogoPath(church.id) ? 'Custom logo' : 'Default platform logo'}</span></div>
        <div class="church-logo-settings">
          <img src="/branding/logo?v=${church.updatedAt ? church.updatedAt.getTime() : Date.now()}" alt="${esc(church.name)} logo">
          <div>
            <p>Upload your church’s logo. It will replace the default logo throughout your workspace.</p>
            <form method="post" action="/settings/logo" enctype="multipart/form-data" class="church-logo-form">
              <input type="file" name="logo" accept="image/jpeg,image/png,image/webp,image/gif" required>
              <button type="submit">${tenantLogoPath(church.id) ? 'Replace logo' : 'Upload logo'}</button>
            </form>
            ${tenantLogoPath(church.id) ? `<form method="post" action="/settings/logo/delete" onsubmit="return confirm('Remove your custom logo and restore the default?')">
              <button class="link" type="submit">Restore default logo</button>
            </form>` : ''}
            <small class="muted-text">PNG, JPG, WebP or GIF · maximum 4 MB · square images work best.</small>
          </div>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Plan</h2><span class="meta">Contact us to change your plan</span></div>
        <dl class="stats">
          <dt>Plan</dt><dd>${esc(plan.label)}</dd>
          <dt>Max users</dt><dd>${plan.maxUsers ?? 'Unlimited'}</dd>
          <dt>Reports</dt><dd>${plan.reports ? 'Included' : 'Not included'}</dd>
          <dt>Pro until</dt><dd>${church.proUntil ? esc(church.proUntil.toISOString().slice(0, 10)) : '—'}</dd>
        </dl>
      </section>
      <section class="card" style="margin-top:1rem">
        <div class="card-head"><h2>Two-factor authentication</h2><span class="meta">${res.locals.user.totpEnabled ? 'Enabled' : 'Not enabled'}</span></div>
        ${mfaControls(res.locals.user)}
      </section>
      <section class="card" style="margin-top:1rem">
        <div class="card-head"><h2>Data portability</h2><span class="meta">Owner only</span></div>
        <p>Download a complete tenant-scoped JSON export. Password hashes, MFA secrets, recovery codes, and reset tokens are excluded.</p>
        <p><a class="btn ghost" href="/settings/export.json">Download church data</a></p>
      </section>`;
    res.page({ title: 'Settings', active: '/settings', noHeader: true, body });
  }));

  app.post('/settings', requireOwner, asyncHandler(async (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) { flash(req, 'Church name is required.'); return res.redirect('/settings'); }
    await res.locals.db.church.update({ where: { id: res.locals.churchId }, data: { name } });
    await logActivity(res.locals.db, 'settings_updated', `Church name set to: ${name}`, '/settings', res.locals.user.id);
    flash(req, 'Settings saved.', 'success');
    res.redirect('/settings');
  }));

  app.post('/settings/logo', requireOwner, logoUpload.single('logo'), asyncHandler(async (req, res) => {
    if (!csrfValid(req)) return res.status(403).send('Security check failed. Refresh Settings and try again.');
    if (!req.file || !looksLikeImage(req.file.buffer)) {
      flash(req, 'That file does not look like a valid image.');
      return res.redirect('/settings');
    }
    const ext = LOGO_EXT_FROM_MIME[String(req.file.mimetype).toLowerCase()] || 'png';
    deleteTenantLogo(res.locals.churchId);
    fs.writeFileSync(path.join(LOGO_DIR, `${res.locals.churchId}.${ext}`), req.file.buffer);
    await logActivity(res.locals.db, 'settings_logo_updated', 'Church logo updated', '/settings', res.locals.user.id);
    flash(req, 'Church logo updated.', 'success');
    res.redirect('/settings');
  }));

  app.post('/settings/logo/delete', requireOwner, asyncHandler(async (req, res) => {
    deleteTenantLogo(res.locals.churchId);
    await logActivity(res.locals.db, 'settings_logo_removed', 'Church logo removed', '/settings', res.locals.user.id);
    flash(req, 'Default church logo restored.', 'success');
    res.redirect('/settings');
  }));

  app.post('/settings/mfa/start', requireAuth, asyncHandler(async (req, res) => {
    const enrollment = createTotpSecret(res.locals.user.email);
    req.session.mfaSetupSecret = enrollment.secret;
    req.session.mfaSetupUri = enrollment.uri;
    res.redirect('/settings/mfa/setup');
  }));

  app.get('/settings/mfa/setup', requireAuth, asyncHandler(async (req, res) => {
    if (!req.session.mfaSetupSecret || !req.session.mfaSetupUri) return res.redirect('/settings');
    const qr = await QRCode.toDataURL(req.session.mfaSetupUri, { width: 220, margin: 1 });
    const body = `
      ${pageHero('Set up two-factor authentication', 'Scan the code, then verify one six-digit code.')}
      <section class="card">
        <p><img src="${esc(qr)}" alt="Authenticator setup QR code" width="220" height="220"></p>
        <details><summary>Enter setup key manually</summary><code>${esc(req.session.mfaSetupSecret)}</code></details>
        <form class="form" method="post" action="/settings/mfa/confirm">
          <label class="wide">Six-digit code<input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}"></label>
          <div class="actions"><button type="submit">Enable two-factor authentication</button></div>
        </form>
      </section>`;
    res.page({ title: 'Set up MFA', active: '/settings', noHeader: true, body });
  }));

  app.post('/settings/mfa/confirm', requireAuth, asyncHandler(async (req, res) => {
    const secret = req.session.mfaSetupSecret;
    if (!secret || !verifyTotp(secret, req.body?.code)) {
      flash(req, 'That verification code is invalid.');
      return res.redirect('/settings/mfa/setup');
    }
    const recovery = createRecoveryCodes();
    await res.locals.db.user.update({
      where: { id: res.locals.user.id },
      data: { totpEnabled: true, totpSecret: secret, totpRecoveryCodes: recovery.serialized },
    });
    delete req.session.mfaSetupSecret;
    delete req.session.mfaSetupUri;
    await logSecurityEvent(res.locals.db, req, {
      event: 'auth.mfa_enabled',
      subject: res.locals.user.email,
      actorId: res.locals.user.id,
    });
    const body = `
      ${pageHero('Save your recovery codes', 'Each code works once. Store them somewhere secure before leaving this page.')}
      <section class="card">
        <pre>${recovery.codes.map(esc).join('\n')}</pre>
        <p><strong>These codes will not be shown again.</strong></p>
        <p><a class="btn" href="/settings">I saved them</a></p>
      </section>`;
    res.page({ title: 'MFA recovery codes', active: '/settings', noHeader: true, body });
  }));

  app.post('/settings/mfa/disable', requireAuth, asyncHandler(async (req, res) => {
    const user = res.locals.user;
    const code = String(req.body?.code || '').trim();
    const validTotp = verifyTotp(user.totpSecret, code);
    const remaining = validTotp ? null : consumeRecoveryCode(user.totpRecoveryCodes, code);
    if (!validTotp && remaining === null) {
      flash(req, 'That verification code is invalid.');
      return res.redirect('/settings');
    }
    await res.locals.db.user.update({
      where: { id: user.id },
      data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: null },
    });
    await logSecurityEvent(res.locals.db, req, {
      event: 'auth.mfa_disabled',
      subject: user.email,
      actorId: user.id,
    });
    flash(req, 'Two-factor authentication disabled.', 'success');
    res.redirect('/settings');
  }));

  app.get('/settings/export.json', requireOwner, asyncHandler(async (req, res) => {
    const payload = await exportTenantData(rawDb, res.locals.churchId);
    await logSecurityEvent(res.locals.db, req, {
      event: 'tenant.export_downloaded',
      subject: payload.church.name,
      actorId: res.locals.user.id,
    });
    const filename = `${payload.church.slug || 'church'}-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '-')}"`);
    res.send(JSON.stringify(payload, null, 2));
  }));
}

module.exports = { register };
