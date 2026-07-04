'use strict';
// Express app wiring the Postgres-backed auth/signup/session subsystem
// (lib/auth.js + lib/provision.js + lib/tenant.js + lib/async-handler.js)
// AND, as of Phase 8, the HTML view layer (lib/tenant-shell.js/tenant-csrf.js
// /tenant-flash.js, routes-pg-html/*.js) — one app, so session/CSRF/auth
// resolution is identical for JSON and HTML requests. NOT wired into the
// live production server.js; see the Phase 8 plan for the eventual cutover.

const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const asyncHandler = require('./async-handler');
const { tenantDb, db: rawDb } = require('./tenant');
const {
  authenticate, resolveSessionUser, createSession, createPendingMfaSession, destroySession,
  createEmailVerificationToken,
} = require('./auth');
const { signupChurch, SignupError } = require('./provision');
const { csrfIssue, csrfCheck } = require('./tenant-csrf');
const { flashRead } = require('./tenant-flash');
const { layout, authPage } = require('./tenant-shell');
const authRoutes = require('./tenant-auth-routes');
const { landingPage } = require('./tenant-landing');
const { renderDashboard } = require('./tenant-dashboard');
const { logSecurityEvent } = require('./security-audit');
const { createRateLimiter } = require('./rate-limit');
const { verifyTotp, consumeRecoveryCode } = require('./mfa');
const { sendEmailEach } = require('./delivery');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  if (IS_PRODUCTION) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

function createTenantApp({ sessionSecret, pool, sessionTableName = 'session' } = {}) {
  const app = express();
  const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    key: (req) => `${req.ip}|${String(req.body?.email || '').trim().toLowerCase()}`,
  });
  const signupRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 30,
    key: (req) => req.ip,
  });
  const mfaRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    key: (req) => `${req.ip}|${req.session?.pendingMfaUserId || 'none'}`,
  });
  app.disable('x-powered-by');
  if (IS_PRODUCTION) app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), {
    maxAge: IS_PRODUCTION ? '1d' : 0,
    immutable: false,
  }));

  // Fly.io health checks (see fly.toml) — must not require session/auth.
  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/readyz', asyncHandler(async (req, res) => {
    try {
      await rawDb.$queryRaw`SELECT 1 AS ok`;
      res.status(200).json({ status: 'ready', db: 'ok' });
    } catch (error) {
      res.status(503).json({ status: 'not-ready', db: 'error', error: 'database unavailable' });
    }
  }));

  app.use(session({
    // The table must already exist (run `node scripts/ensure-session-table.js`
    // once) — createTableIfMissing is deliberately off. connect-pg-simple
    // hardcodes its PK constraint name to "session_pkey" regardless of table
    // name, so concurrent auto-create attempts (e.g. two test files) race on
    // that literal schema-wide-unique name.
    store: new pgSession({ pool: pool || new Pool({ connectionString: process.env.DATABASE_URL }), tableName: sessionTableName, createTableIfMissing: false }),
    secret: sessionSecret || process.env.SESSION_SECRET || 'dev-only-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    },
  }));

  // Attach res.locals.user/church/db for any authenticated request.
  app.use(asyncHandler(async (req, res, next) => {
    const user = await resolveSessionUser(req);
    if (user) {
      res.locals.user = user;
      res.locals.churchId = user.churchId;
      res.locals.db = tenantDb(user.churchId);
    }
    next();
  }));

  // One central suspension gate protects every tenant route. Platform owners
  // retain access to the operator console so they can reactivate a church.
  app.use((req, res, next) => {
    const user = res.locals.user;
    if (!user?.church?.suspendedAt && !user?.church?.deletedAt) return next();
    const platformEmails = String(process.env.PLATFORM_ADMIN_EMAILS || '')
      .split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
    const isPlatformOwner = platformEmails.includes(String(user.email).toLowerCase());
    const isOperatorRoute = req.path === '/platform' || req.path.startsWith('/platform/')
      || req.path.startsWith('/api/platform/');
    if ((isPlatformOwner && isOperatorRoute) || req.path === '/logout') return next();
    const message = user.church.deletedAt
      ? (user.church.deletionReason
        ? `This church has been deleted: ${user.church.deletionReason}`
        : 'This church has been deleted. Contact the platform owner if it should be restored.')
      : (user.church.suspensionReason
        ? `This church's access is suspended: ${user.church.suspensionReason}`
        : 'This church’s access is suspended. Contact the platform owner.');
    if (req.path.startsWith('/api/') || req.is('application/json')) {
      return res.status(403).json({ error: user.church.deletedAt ? 'church deleted' : 'church suspended', message });
    }
    return res.status(403).send(authPage('Access suspended',
      `<p class="error">${message}</p><form method="post" action="/logout"><button type="submit">Sign out</button></form>`));
  });

  // Phase 8: HTML-layer middleware (CSRF issue+check, flash, res.page).
  // JSON API requests bypass CSRF (see lib/tenant-csrf.js) so none of the
  // existing routes-pg/*.js / test/*-pg.test.js behavior changes.
  app.use(csrfIssue);
  app.use(csrfCheck);
  app.use(flashRead);
  app.use((req, res, next) => {
    res.page = (opts) => res.send(layout({
      ...opts,
      user: opts.user ?? res.locals.user,
      flash: opts.flash ?? res.locals.flash,
      flashType: opts.flashType ?? res.locals.flashType,
    }));
    next();
  });

  function requireAuth(req, res, next) {
    if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
    next();
  }

  // These three endpoints are shared by BOTH the JSON API surface (used by
  // every test/*-pg.test.js file since Phase 1) and, as of Phase 8, real
  // HTML <form> submissions. They content-negotiate on the SAME signal
  // lib/tenant-csrf.js already uses (req.is('application/json')) rather than
  // duplicating separate HTML routes at the same paths, which Express could
  // never reach anyway (first-registered route wins) — existing JSON
  // behavior is completely unchanged for JSON requests.
  app.post('/signup', signupRateLimit, asyncHandler(async (req, res) => {
    const wantsJson = req.is('application/json');
    try {
      const { church, user } = await signupChurch(req.body || {});
      if (process.env.REQUIRE_EMAIL_VERIFICATION === '1') {
        const verification = await createEmailVerificationToken(user.id);
        const link = `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/verify-email/${verification.token}`;
        const sent = await sendEmailEach(tenantDb(church.id), [{ addr: user.email }],
          'Verify your Church Manager email',
          `Verify your email within 24 hours:\n\n${link}`, { churchName: church.name, withFooter: false });
        if (wantsJson) return res.status(201).json({
          ok: true, verificationRequired: true, verificationEmailSent: sent.ok,
        });
        return res.send(authPage('Check your email', sent.ok
          ? '<p class="success">We sent you a verification link. It expires in 24 hours.</p>'
          : '<p class="error">Your church was created, but email delivery is temporarily unavailable. Contact support or resend verification from the login page.</p>'));
      }
      await createSession(req, user.id);
      if (wantsJson) {
        return res.status(201).json({ ok: true, church: { id: church.id, slug: church.slug }, user: { id: user.id, email: user.email } });
      }
      return res.redirect('/');
    } catch (e) {
      if (e instanceof SignupError) {
        if (wantsJson) return res.status(400).json({ error: e.message });
        return authRoutes.renderSignupForm(req, res, { error: e.message, body: req.body });
      }
      throw e;
    }
  }));

  app.post('/login', loginRateLimit, asyncHandler(async (req, res) => {
    const wantsJson = req.is('application/json');
    const { email, password } = req.body || {};
    const result = await authenticate(email, password);
    if (result.status === 'locked') {
      if (result.user) {
        await logSecurityEvent(tenantDb(result.user.churchId), req, {
          event: 'auth.login_locked',
          subject: result.user.email,
          actorId: result.user.id,
        });
      }
      const mins = Math.max(1, Math.ceil((result.until.getTime() - Date.now()) / 60000));
      const message = `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
      if (wantsJson) return res.status(423).json({ error: message });
      return authRoutes.renderLoginForm(req, res, { error: message, email });
    }
    if (result.status === 'unverified') {
      const message = 'Verify your email before signing in.';
      if (wantsJson) return res.status(403).json({ error: message, verificationRequired: true });
      return authRoutes.renderLoginForm(req, res, { error: message, email });
    }
    if (result.status !== 'ok') {
      if (result.user) {
        await logSecurityEvent(tenantDb(result.user.churchId), req, {
          event: 'auth.login_failed',
          subject: result.user.email,
          actorId: result.user.id,
        });
      }
      if (wantsJson) return res.status(401).json({ error: 'Incorrect email or password.' });
      return authRoutes.renderLoginForm(req, res, { error: 'Incorrect email or password.', email });
    }
    if (result.user.totpEnabled) {
      await createPendingMfaSession(req, result.user.id);
      if (wantsJson) return res.status(202).json({ ok: false, mfaRequired: true });
      return res.redirect('/login/mfa');
    }
    await createSession(req, result.user.id);
    await logSecurityEvent(tenantDb(result.user.churchId), req, {
      event: 'auth.login_succeeded',
      subject: result.user.email,
      actorId: result.user.id,
    });
    if (wantsJson) return res.json({ ok: true, user: { id: result.user.id, email: result.user.email, churchId: result.user.churchId } });
    return res.redirect('/');
  }));

  app.get('/login/mfa', (req, res) => {
    if (res.locals.user) return res.redirect('/');
    if (!req.session.pendingMfaUserId || Date.now() - Number(req.session.pendingMfaAt || 0) > 5 * 60 * 1000) {
      return res.redirect('/login');
    }
    res.send(authPage('Security verification', `
      <p class="muted">Enter the six-digit code from your authenticator app, or use one recovery code.</p>
      <form class="form auth-form" method="post" action="/login/mfa">
        <label class="wide">Verification code<input name="code" required autofocus autocomplete="one-time-code"></label>
        <div class="actions"><button type="submit">Verify</button></div>
      </form>`));
  });

  app.post('/login/mfa', mfaRateLimit, asyncHandler(async (req, res) => {
    const wantsJson = req.is('application/json');
    const pendingUserId = req.session.pendingMfaUserId;
    const pendingAt = Number(req.session.pendingMfaAt || 0);
    if (!pendingUserId || Date.now() - pendingAt > 5 * 60 * 1000) {
      if (wantsJson) return res.status(401).json({ error: 'MFA challenge expired.' });
      return res.redirect('/login');
    }
    const user = await rawDb.user.findUnique({ where: { id: pendingUserId } });
    if (!user || user.deletedAt || !user.totpEnabled || !user.totpSecret) {
      return res.status(401).json({ error: 'MFA challenge is invalid.' });
    }
    const code = String(req.body?.code || '').trim();
    const validTotp = verifyTotp(user.totpSecret, code);
    const remainingRecoveryCodes = validTotp ? null : consumeRecoveryCode(user.totpRecoveryCodes, code);
    if (!validTotp && remainingRecoveryCodes === null) {
      await logSecurityEvent(tenantDb(user.churchId), req, {
        event: 'auth.mfa_failed',
        subject: user.email,
        actorId: user.id,
      });
      const message = 'Incorrect verification code.';
      if (wantsJson) return res.status(401).json({ error: message });
      return res.status(401).send(authPage('Security verification', `<p class="error">${message}</p><p><a href="/login/mfa">Try again</a></p>`));
    }
    if (remainingRecoveryCodes !== null) {
      await rawDb.user.update({
        where: { id: user.id },
        data: { totpRecoveryCodes: remainingRecoveryCodes },
      });
    }
    await createSession(req, user.id);
    await logSecurityEvent(tenantDb(user.churchId), req, {
      event: remainingRecoveryCodes !== null ? 'auth.mfa_recovery_succeeded' : 'auth.mfa_succeeded',
      subject: user.email,
      actorId: user.id,
    });
    if (wantsJson) return res.json({ ok: true, user: { id: user.id, email: user.email, churchId: user.churchId } });
    return res.redirect('/');
  }));

  app.post('/logout', (req, res) => {
    const wantsJson = req.is('application/json');
    const user = res.locals.user;
    if (user) {
      void logSecurityEvent(res.locals.db, req, {
        event: 'auth.logout',
        subject: user.email,
        actorId: user.id,
      });
    }
    destroySession(req, () => {
      res.clearCookie('connect.sid');
      return wantsJson ? res.json({ ok: true }) : res.redirect('/login');
    });
  });

  app.get('/whoami', requireAuth, (req, res) => {
    res.json({ userId: res.locals.user.id, email: res.locals.user.email, churchId: res.locals.churchId });
  });

  // Phase 2 module registrations — each is a standalone, fully-tested
  // Postgres/Prisma port of the matching routes/*.js file, not yet wired
  // into the live server.js (see church-mgmt-multitenant-rewrite memory).
  require('../routes-pg/preaching').register(app);
  require('../routes-pg/bible-classes').register(app);
  require('../routes-pg/inventory').register(app);
  require('../routes-pg/organizations').register(app);
  require('../routes-pg/attendance').register(app);
  require('../routes-pg/communications').register(app);
  require('../routes-pg/events').register(app);
  require('../routes-pg/members').register(app);
  require('../routes-pg/reports').register(app);
  require('../routes-pg/finance').register(app);
  require('../routes-pg/users').register(app);
  require('../routes-pg/settings').register(app);
  require('../routes-pg/platform').register(app);

  // Phase 8: HTML route modules. Registered alongside (not instead of) the
  // JSON routes-pg/*.js modules above — HTML lives at bare paths (/preaching),
  // JSON at /api/... (see routes-pg/preaching.js), no collision.
  authRoutes.register(app); // GET /login, GET /signup (forms)
  require('../routes-pg-html/preaching').register(app);
  require('../routes-pg-html/bible-classes').register(app);
  require('../routes-pg-html/inventory').register(app);
  require('../routes-pg-html/organizations').register(app);
  require('../routes-pg-html/attendance').register(app);
  require('../routes-pg-html/communications').register(app);
  require('../routes-pg-html/events').register(app);
  require('../routes-pg-html/members').register(app);
  require('../routes-pg-html/reports').register(app);
  require('../routes-pg-html/finance').register(app);
  require('../routes-pg-html/users').register(app);
  require('../routes-pg-html/settings').register(app);
  require('../routes-pg-html/platform').register(app);

  // Landing/dashboard are deferred past Phase 8a (see the plan) — a minimal
  // stub so the app has a sensible "/" while those don't exist yet.
  app.get('/', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.send(landingPage(false));
    const body = await renderDashboard(res.locals.db);
    res.page({ title: 'Dashboard', active: '/', noHeader: true, body });
  }));

  // Last resort: JSON for the API surface (never Express's default HTML
  // error page), a plain HTML error page for browser/form requests.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[tenant-http]', err);
    void rawDb.errorLog.create({
      data: {
        churchId: res.locals.churchId || null,
        method: String(req.method || '').slice(0, 16),
        path: String(req.originalUrl || req.path || '').slice(0, 500),
        message: String(err.message || err).slice(0, 2000),
        stack: err.stack ? String(err.stack).slice(0, 10000) : null,
        userId: res.locals.user?.id || null,
      },
    }).catch((logError) => console.error('[error-log] failed:', logError.message));
    if (req.is('application/json') || req.path.startsWith('/api/')) {
      return res.status(500).json({ error: 'internal error', message: err.message });
    }
    return res.status(500).send(layout({
      title: 'Something went wrong', active: null, user: res.locals.user,
      body: `<p>Sorry, something went wrong on our end.</p><p><a href="/">Back to dashboard</a></p>`,
    }));
  });

  return app;
}

module.exports = { createTenantApp };
