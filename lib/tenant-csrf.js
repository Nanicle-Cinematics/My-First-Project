'use strict';
// Phase 8a: CSRF protection, ported near-verbatim from server.js:900-933.
// Pure session-state logic, zero SQLite coupling. A synchronizer token per
// session, auto-injected into every rendered <form method="post">, checked
// on every state-changing request.

const crypto = require('crypto');
const { layout } = require('./tenant-shell');

const TOKEN_BYTES = 32;
const HEX = TOKEN_BYTES * 2;          // 64 chars for a raw token
const MASKED_HEX = HEX * 2;           // 128 chars for nonce + masked

// The session token is never rendered directly. Each response carries it
// XOR-masked under a fresh random nonce, so the bytes on the wire differ every
// time even though the underlying secret does not.
//
// Why: responses are gzipped (the Fly proxy compresses HTML regardless of what
// this app does), and pages like /members?q=… put attacker-influenceable text
// in the same response as this token. Compression makes response size depend
// on how well the two match, which is what BREACH exploits to recover a static
// secret a byte at a time. A per-response mask removes the fixed target — the
// attacker never sees the same token bytes twice.
function maskToken(rawHex) {
  const raw = Buffer.from(rawHex, 'hex');
  const nonce = crypto.randomBytes(raw.length);
  const masked = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) masked[i] = raw[i] ^ nonce[i];
  return nonce.toString('hex') + masked.toString('hex');
}

// Returns the raw token hex, or null if the value is malformed.
function unmaskToken(value) {
  if (typeof value !== 'string' || value.length !== MASKED_HEX) return null;
  if (!/^[0-9a-f]+$/i.test(value)) return null;
  const nonce = Buffer.from(value.slice(0, HEX), 'hex');
  const masked = Buffer.from(value.slice(HEX), 'hex');
  if (nonce.length !== TOKEN_BYTES || masked.length !== TOKEN_BYTES) return null;
  const raw = Buffer.alloc(TOKEN_BYTES);
  for (let i = 0; i < TOKEN_BYTES; i++) raw[i] = masked[i] ^ nonce[i];
  return raw.toString('hex');
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Issues the token and monkey-patches res.send to splice a hidden _csrf
// field into any outgoing HTML form — route handlers never add it manually.
// One mask is generated per response, shared by every form on the page; the
// property that matters is that it changes between responses.
function csrfIssue(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const masked = maskToken(req.session.csrfToken);
  res.locals.csrfToken = masked;
  const field = `<input type="hidden" name="_csrf" value="${masked}">`;
  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (typeof body === 'string' && body.indexOf('<form') !== -1) {
      body = body.replace(/(<form\b[^>]*\bmethod=["']post["'][^>]*>)/gi, `$1${field}`);
    }
    return origSend(body);
  };
  next();
}

// Only the masked form is accepted. A transitional branch here also accepted
// a bare session token, so that forms rendered before masking shipped could
// still be submitted; sessions last 8 hours, that window has passed, and
// leaving it in place would have meant a valid-looking unmasked token was
// still a working credential — which is the exact thing masking removes.
function csrfValid(req) {
  const submitted = req.body && req.body._csrf;
  const session = req.session && req.session.csrfToken;
  if (!submitted || !session) return false;
  const raw = unmaskToken(submitted);
  return raw !== null && sameToken(raw, session);
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

module.exports = { csrfIssue, csrfCheck, csrfValid, maskToken, unmaskToken };
