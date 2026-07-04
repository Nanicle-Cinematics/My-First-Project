'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { exportableTenantModels, sanitizeExportValue } = require('../lib/tenant-export');

test('tenant export covers tenant-owned models but excludes reset tokens', () => {
  const models = exportableTenantModels().map((entry) => entry.model);
  assert.ok(models.includes('Member'));
  assert.ok(models.includes('JournalEntry'));
  assert.ok(models.includes('SecurityAuditLog'));
  assert.ok(models.includes('User'));
  assert.ok(!models.includes('Church'));
  assert.ok(!models.includes('PasswordResetToken'));
});

test('tenant export strips authentication secrets recursively', () => {
  const clean = sanitizeExportValue({
    email: 'owner@example.test',
    passwordHash: 'secret',
    nested: { totpSecret: 'secret', totpRecoveryCodes: 'secret', safe: true },
  });
  assert.deepStrictEqual(clean, {
    email: 'owner@example.test',
    nested: { safe: true },
  });
});
