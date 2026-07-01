// Throwaway spike (Phase 0, Spike B): prove async-handler + tenantDb(churchId)
// + connect-pg-simple session plumbing work together in a real Express app,
// end to end over HTTP, before committing to the pattern for the real
// route-by-route conversion (Phase 2+). This is standalone — it does NOT
// touch server.js or routes/preaching.js.
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const asyncHandler = require('../lib/async-handler');
const { db, tenantDb } = require('../lib/tenant');

const PORT = 3999;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Seed two churches + a preaching-plan row each, so we can prove isolation
  // over real HTTP requests, not just direct Prisma calls (Spike A already
  // covered that).
  const churchA = await db.church.create({ data: { name: 'Spike Express A', slug: `spike-express-a-${Date.now()}` } });
  const churchB = await db.church.create({ data: { name: 'Spike Express B', slug: `spike-express-b-${Date.now()}` } });
  await tenantDb(churchA.id).preachingPlan.create({
    data: { preachDate: new Date('2026-08-02'), serviceLabel: 'Sunday Service (A)', topic: 'Faith' },
  });
  await tenantDb(churchB.id).preachingPlan.create({
    data: { preachDate: new Date('2026-08-09'), serviceLabel: 'Sunday Service (B)', topic: 'Hope' },
  });

  const app = express();
  app.use(session({
    store: new pgSession({ pool, tableName: 'spike_session', createTableIfMissing: true }),
    secret: 'spike-only-not-real',
    resave: false,
    saveUninitialized: false,
  }));

  // Minimal stand-in for the real auth gate (Phase 1 builds the real one):
  // a login-as endpoint that sets req.session.churchId directly.
  app.get('/spike/login-as/:churchId', (req, res) => {
    req.session.churchId = req.params.churchId;
    res.json({ ok: true, churchId: req.params.churchId });
  });

  // The route under test: async handler + tenantDb(churchId) resolved from session.
  app.get('/preaching.json', asyncHandler(async (req, res) => {
    if (!req.session.churchId) return res.status(401).json({ error: 'not logged in' });
    const scoped = tenantDb(req.session.churchId);
    const rows = await scoped.preachingPlan.findMany({ orderBy: { preachDate: 'asc' } });
    res.json({ churchId: req.session.churchId, count: rows.length, topics: rows.map((r) => r.topic) });
  }));

  const server = app.listen(PORT, async () => {
    try {
      // Client 1: log in as church A, hit the route, persist session via cookie.
      // (Fully consume each response body before firing the next request —
      // undici keep-alive sockets misbehave if a prior body is left unread.)
      const loginA = await fetch(`http://127.0.0.1:${PORT}/spike/login-as/${churchA.id}`);
      const cookieA = loginA.headers.get('set-cookie');
      await loginA.json();
      const respA = await fetch(`http://127.0.0.1:${PORT}/preaching.json`, { headers: { cookie: cookieA } });
      const dataA = await respA.json();
      console.log('Church A sees:', dataA);

      // Client 2: log in as church B, separate session/cookie.
      const loginB = await fetch(`http://127.0.0.1:${PORT}/spike/login-as/${churchB.id}`);
      const cookieB = loginB.headers.get('set-cookie');
      await loginB.json();
      const respB = await fetch(`http://127.0.0.1:${PORT}/preaching.json`, { headers: { cookie: cookieB } });
      const dataB = await respB.json();
      console.log('Church B sees:', dataB);

      // No session at all -> 401.
      const noAuth = await fetch(`http://127.0.0.1:${PORT}/preaching.json`);
      console.log('No session status (expect 401):', noAuth.status);

      const pass =
        dataA.count === 1 && dataA.topics[0] === 'Faith' &&
        dataB.count === 1 && dataB.topics[0] === 'Hope' &&
        noAuth.status === 401;
      console.log(pass ? 'SPIKE B: PASS' : 'SPIKE B: FAIL');

      // Cleanup.
      await db.preachingPlan.deleteMany({ where: { churchId: { in: [churchA.id, churchB.id] } } });
      await db.church.deleteMany({ where: { id: { in: [churchA.id, churchB.id] } } });
      await pool.query('DELETE FROM spike_session');
      await db.$disconnect();
      await pool.end();
      server.close(() => process.exit(pass ? 0 : 1));
    } catch (e) {
      console.error('SPIKE FAILED:', e);
      server.close(() => process.exit(1));
    }
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
