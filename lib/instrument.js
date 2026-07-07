'use strict';
// Must be required before any other module (server.js's first require) so
// Sentry's auto-instrumentation can wrap http/express/pg before they load.
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1,
});

module.exports = Sentry;
