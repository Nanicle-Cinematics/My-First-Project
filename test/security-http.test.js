'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');

test('public responses carry the application security baseline headers', async () => {
  const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' });
  const app = createTenantApp({ pool, sessionSecret: 'header-test-secret' });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(response.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.strictEqual(response.headers.get('x-powered-by'), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
