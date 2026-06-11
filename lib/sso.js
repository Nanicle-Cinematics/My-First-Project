'use strict';
// SSO handoff signer. This app is the identity provider; church-finance is the
// service provider. We mint a short-lived HS256 JWT signed with the shared
// SSO_SECRET and redirect the user to church-finance's /sso/callback, which
// verifies it with `jose`. Standard JWT — no extra dependency, just Node crypto.
const crypto = require('crypto');

const SSO_AUDIENCE = 'church-finance';
const TOKEN_TTL_SECONDS = 60;

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Sign a handoff token for the given user. `role` is the management-system role
// (admin | editor | viewer); church-finance maps it to a finance role.
function signHandoffToken({ sub, name, role }, secret) {
  if (!secret) throw new Error('SSO_SECRET is not set');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: String(sub),
    name: name || String(sub),
    role,
    aud: SSO_AUDIENCE,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    jti: crypto.randomBytes(16).toString('hex'),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

module.exports = { signHandoffToken, SSO_AUDIENCE, TOKEN_TTL_SECONDS };
