'use strict';
// Phase 8a: CSRF protection, ported near-verbatim from server.js:900-933.
// Pure session-state logic, zero SQLite coupling. A synchronizer token per
// session, auto-injected into every rendered <form method="post">, checked
// on every state-changing request.

const crypto = require('crypto');
const { layout } = require('./tenant-shell');

// Issues the token and monkey-patches res.send to splice a hidden _csrf
// field into any outgoing HTML form — route handlers never add it manually.
function csrfIssue(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  const token = req.session.csrfToken;
  res.locals.csrfToken = token;
  const field = `<input type="hidden" name="_csrf" value="${token}">`;
  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (typeof body === 'string' && body.indexOf('<form') !== -1) {
      body = body.replace(/(<form\b[^>]*\bmethod=["']post["'][^>]*>)/gi, `$1${field}`);
    }
    return origSend(body);
  };
  next();
}

function csrfValid(req) {
  const t = req.body && req.body._csrf;
  return !!t && t === req.session.csrfToken;
}

// `/checkin/*` and `/rsvp/*` (Phase 9b) are exempt too: these are public,
// session-less pages reached by scanning a QR code or clicking a link with
// no prior visit to this site — there is no session to bind a
// synchronizer token to. Their security model is different (and
// intentionally so, matching the original app): possession of the
// unguessable 32-byte-hex checkinToken IS the credential, not a session.
//
// The `/api/...` prefix (routes-pg/*.js) is exempt from CSRF entirely: this
// stack has BOTH a browser-form HTML surface (needs CSRF — cookie auth +
// form submission is exactly what CSRF attacks exploit) and a JSON API
// surface (exercised directly by test/*.test.js and any future API
// client). A path prefix, not a content-type sniff, is the right signal
// here: req.is('application/json') returns false for bodyless requests
// (DELETE, PUT/POST with an empty body) even when the header is set — a
// real bug hit while wiring this up, since test/*.test.js's DELETE calls
// carry no body. The `/api/` prefix itself is a legitimate CSRF boundary
// regardless: a cross-site request using a non-GET method or a JSON content
// type is not a "simple request" and triggers a CORS preflight, which this
// server does not grant — so `/api/*` is already CORS-protected against
// exactly the browser-form attack CSRF tokens exist to stop.
function csrfCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/api/')) return next(); // JSON API surface — see comment above
  if (req.path.startsWith('/checkin/') || req.path.startsWith('/rsvp/')) return next(); // public, session-less — see comment above
  if (req.is('multipart/form-data')) return next(); // body parsed later; checked in-route
  if (req.is('application/json')) return next(); // e.g. the shared /signup, /login JSON callers
  if (csrfValid(req)) return next();
  return res.status(403).send(layout({
    title: 'Security check failed', active: null, user: res.locals.user,
    body: '<p>This form was stale or your session expired. Please go back and try again.</p>'
        + '<p><a href="/">Back to dashboard</a></p>',
  }));
}

module.exports = { csrfIssue, csrfCheck, csrfValid };
