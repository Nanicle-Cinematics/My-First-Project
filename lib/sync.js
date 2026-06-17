'use strict';
// Member-sync token signer. This app is the system of record for members; it
// pushes member records to church-finance's /api/sync/members, authenticated by
// a short-lived HS256 JWT (audience "member-sync") signed with the shared
// SSO_SECRET. Same scheme as the SSO handoff (lib/sso.js), different audience.
const crypto = require('crypto');

const SYNC_AUDIENCE = 'member-sync';
const TOKEN_TTL_SECONDS = 120;

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signSyncToken(secret) {
  if (!secret) throw new Error('SSO_SECRET is not set');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: SYNC_AUDIENCE,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    jti: crypto.randomBytes(16).toString('hex'),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

module.exports = { signSyncToken, SYNC_AUDIENCE, TOKEN_TTL_SECONDS };
