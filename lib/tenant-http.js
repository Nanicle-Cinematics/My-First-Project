'use strict';
// Minimal Express app wiring the new Postgres-backed auth/signup/session
// subsystem together (lib/auth.js + lib/provision.js + lib/tenant.js +
// lib/async-handler.js). Used by test/tenant-auth.test.js today; this is the
// seed of what server.js's auth section becomes once the live app is ready
// to cut over (Phase 7) — NOT wired into the current production server.js.

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const asyncHandler = require('./async-handler');
const { tenantDb } = require('./tenant');
const { authenticate, resolveSessionUser, createSession, destroySession } = require('./auth');
const { signupChurch, SignupError } = require('./provision');

function createTenantApp({ sessionSecret, pool, sessionTableName = 'session' } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
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

  function requireAuth(req, res, next) {
    if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
    next();
  }

  app.post('/signup', asyncHandler(async (req, res) => {
    try {
      const { church, user } = await signupChurch(req.body || {});
      createSession(req, user.id);
      res.status(201).json({ ok: true, church: { id: church.id, slug: church.slug }, user: { id: user.id, email: user.email } });
    } catch (e) {
      if (e instanceof SignupError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }));

  app.post('/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const result = await authenticate(email, password);
    if (result.status === 'locked') {
      const mins = Math.max(1, Math.ceil((result.until.getTime() - Date.now()) / 60000));
      return res.status(423).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
    }
    if (result.status !== 'ok') return res.status(401).json({ error: 'Incorrect email or password.' });
    createSession(req, result.user.id);
    res.json({ ok: true, user: { id: result.user.id, email: result.user.email, churchId: result.user.churchId } });
  }));

  app.post('/logout', (req, res) => {
    destroySession(req, () => res.json({ ok: true }));
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

  // Last resort: always return JSON, never Express's default HTML error page.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[tenant-http]', err);
    res.status(500).json({ error: 'internal error', message: err.message });
  });

  return app;
}

module.exports = { createTenantApp };
