'use strict';

const assert = require('node:assert');
const base = process.argv[2] || 'http://127.0.0.1:3000';

(async () => {
  const home = await fetch(base, { redirect: 'manual' });
  assert.strictEqual(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.strictEqual(home.headers.get('x-content-type-options'), 'nosniff');

  const protectedResponse = await fetch(`${base}/api/platform/churches`, { redirect: 'manual' });
  assert.ok([401, 403].includes(protectedResponse.status));

  const traversal = await fetch(`${base}/static/%2e%2e%2fserver.js`, { redirect: 'manual' });
  assert.notStrictEqual(traversal.status, 200);
  console.log('security_smoke=passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
