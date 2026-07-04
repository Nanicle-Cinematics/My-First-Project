'use strict';

const test = require('node:test');
const assert = require('node:assert');
const OTPAuth = require('otpauth');
const {
  createTotpSecret,
  verifyTotp,
  createRecoveryCodes,
  consumeRecoveryCode,
} = require('../lib/mfa');

test('TOTP secrets produce valid one-time codes and reject malformed codes', () => {
  const enrollment = createTotpSecret('owner@example.test');
  const totp = new OTPAuth.TOTP({
    issuer: 'Church Manager',
    label: 'owner@example.test',
    secret: OTPAuth.Secret.fromBase32(enrollment.secret),
  });
  assert.match(enrollment.uri, /^otpauth:\/\/totp\//);
  assert.strictEqual(verifyTotp(enrollment.secret, totp.generate()), true);
  assert.strictEqual(verifyTotp(enrollment.secret, 'not-a-code'), false);
});

test('recovery codes are one-time and stored only as salted hashes', () => {
  const recovery = createRecoveryCodes();
  assert.strictEqual(recovery.codes.length, 10);
  assert.ok(recovery.codes.every((code) => !recovery.serialized.includes(code)));

  const afterUse = consumeRecoveryCode(recovery.serialized, recovery.codes[0].toLowerCase());
  assert.ok(afterUse);
  assert.strictEqual(JSON.parse(afterUse).length, 9);
  assert.strictEqual(consumeRecoveryCode(afterUse, recovery.codes[0]), null);
});
