'use strict';
// Phase 8g cutover: this file is now the bootstrap for the Postgres-backed,
// multi-tenant version of Church Manager (lib/tenant-http.js's
// createTenantApp(), assembled from lib/tenant.js/tenant-shell.js/
// tenant-csrf.js/tenant-flash.js/tenant-auth-routes.js/tenant-landing.js/
// tenant-dashboard.js + every routes-pg/*.js and routes-pg-html/*.js
// module — see the church-mgmt-multitenant-rewrite memory / the Phase 8
// plan for the full history).
//
// The original single-tenant, better-sqlite3-backed app that used to live
// in this file has been fully superseded, and its source (routes/*.js,
// lib/db.js, lib/ledger.js, lib/finance.js, schema.sql) has now been
// removed along with the better-sqlite3 dependencies. To consult it, read
// the tree at the cutover commit fae9159 or its parent.
//
// package.json's "main"/"start" ("node server.js") and every deploy config
// (fly.toml, Dockerfile) already point at this file, so no deploy-config
// changes were needed for this cutover.

require('./lib/instrument');

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set — generating an ephemeral one (logins will be lost on restart).');
}
if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL not set — the app will fail to connect to Postgres.');
}

const { createTenantApp } = require('./lib/tenant-http');
const { startOperationsScheduler } = require('./lib/operations-scheduler');

const PORT = process.env.PORT || 3000;
const app = createTenantApp();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Church Manager running at http://localhost:${PORT}`);
    startOperationsScheduler();
  });
}

module.exports = app;
