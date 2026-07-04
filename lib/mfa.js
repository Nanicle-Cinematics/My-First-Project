'use strict';

const crypto = require('crypto');
const OTPAuth = require('otpauth');

const ISSUER = 'Church Manager';

function createTotpSecret(label) {
  const secret = new OTPAuth.Secret();
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: String(label || 'account'),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
  return { secret: secret.base32, uri: totp.toString() };
}

function verifyTotp(secret, token) {
  if (!secret || !/^\d{6}$/.test(String(token || '').trim())) return false;
  try {
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      label: 'account',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    return totp.validate({ token: String(token).trim(), window: 1 }) !== null;
  } catch (_) {
    return false;
  }
}

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function recoveryHash(code, salt) {
  return crypto.scryptSync(normalizeRecoveryCode(code), salt, 32).toString('hex');
}

function createRecoveryCodes(count = 10) {
  const codes = [];
  const stored = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    const salt = crypto.randomBytes(16).toString('hex');
    codes.push(code);
    stored.push({ salt, hash: recoveryHash(code, salt) });
  }
  return { codes, serialized: JSON.stringify(stored) };
}

function consumeRecoveryCode(serialized, suppliedCode) {
  const normalized = normalizeRecoveryCode(suppliedCode);
  if (!normalized) return null;
  let rows;
  try {
    rows = JSON.parse(serialized || '[]');
  } catch (_) {
    return null;
  }
  const index = rows.findIndex((row) => {
    if (!row || !row.salt || !row.hash) return false;
    const actual = Buffer.from(recoveryHash(normalized, row.salt), 'hex');
    const expected = Buffer.from(row.hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
  if (index < 0) return null;
  rows.splice(index, 1);
  return JSON.stringify(rows);
}

module.exports = {
  createTotpSecret,
  verifyTotp,
  createRecoveryCodes,
  consumeRecoveryCode,
  normalizeRecoveryCode,
};
