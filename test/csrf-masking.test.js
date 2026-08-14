'use strict';
// The CSRF token is XOR-masked under a fresh nonce on every response, so the
// same session secret never appears twice on the wire. These tests pin that
// property directly rather than through a rendered page, so they need no
// database and run in milliseconds.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { csrfIssue, csrfValid, maskToken, unmaskToken } = require('../lib/tenant-csrf');

const RAW = crypto.randomBytes(32).toString('hex');

function issueInto(session) {
  const req = { session };
  const res = { locals: {}, send: (b) => b };
  csrfIssue(req, res, () => {});
  return { req, res };
}

test('a masked token unmasks back to the session secret', () => {
  const masked = maskToken(RAW);
  assert.strictEqual(masked.length, 128);
  assert.notStrictEqual(masked, RAW);
  assert.strictEqual(unmaskToken(masked), RAW);
});

test('the same secret masks differently every time', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(maskToken(RAW));
  // This is the whole point: a BREACH attacker never sees a fixed target.
  assert.strictEqual(seen.size, 50, 'masked values repeated — the nonce is not random per call');
  for (const m of seen) assert.strictEqual(unmaskToken(m), RAW);
});

test('two responses in one session render different token values', () => {
  const session = {};
  const a = issueInto(session).res.locals.csrfToken;
  const b = issueInto(session).res.locals.csrfToken;
  assert.notStrictEqual(a, b);
  // …while both still resolve to the one secret held in the session.
  assert.strictEqual(unmaskToken(a), session.csrfToken);
  assert.strictEqual(unmaskToken(b), session.csrfToken);
});

test('a masked token from this session validates', () => {
  const session = {};
  const { res } = issueInto(session);
  const req = { session, body: { _csrf: res.locals.csrfToken } };
  assert.strictEqual(csrfValid(req), true);
});

test('an unmasked legacy token still validates during rollout', () => {
  // A form rendered before this change is still open in someone's browser.
  const session = { csrfToken: RAW };
  assert.strictEqual(csrfValid({ session, body: { _csrf: RAW } }), true);
});

test('a token from a different session is rejected', () => {
  const mine = {};
  issueInto(mine);
  const theirs = {};
  const { res } = issueInto(theirs);
  const req = { session: mine, body: { _csrf: res.locals.csrfToken } };
  assert.strictEqual(csrfValid(req), false);
});

test('malformed and missing tokens are rejected, not thrown on', () => {
  const session = { csrfToken: RAW };
  const bad = [
    undefined, '', 'nope', 'z'.repeat(128), RAW.slice(0, 63),
    maskToken(RAW).slice(0, 127), maskToken(RAW) + 'ff',
  ];
  for (const value of bad) {
    assert.strictEqual(csrfValid({ session, body: { _csrf: value } }), false, `accepted: ${value}`);
  }
  assert.strictEqual(csrfValid({ session, body: {} }), false);
  assert.strictEqual(csrfValid({ session: {}, body: { _csrf: RAW } }), false);
});

test('flipping any bit of a masked token invalidates it', () => {
  const session = { csrfToken: RAW };
  const masked = maskToken(RAW);
  for (const i of [0, 63, 64, 127]) {
    const ch = masked[i] === 'a' ? 'b' : 'a';
    const tampered = masked.slice(0, i) + ch + masked.slice(i + 1);
    assert.strictEqual(csrfValid({ session, body: { _csrf: tampered } }), false, `accepted tampered at ${i}`);
  }
});
