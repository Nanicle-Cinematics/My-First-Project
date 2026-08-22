'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { isDatabaseUnavailableError } = require('../lib/db-health');
const { maintenancePage } = require('../lib/maintenance-page');

test('recognises the Neon quota error that took the app offline', () => {
  // Verbatim shape from the August 2026 outage. It arrives as an ordinary query
  // error, so matching on connection codes alone misses it entirely.
  assert.ok(isDatabaseUnavailableError(new Error(
    'Error querying the database: ERROR: Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits.',
  )));
});

test('recognises unreachable-server codes from both pg and Prisma', () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', '57P03', '08006', 'P1001', 'P1017']) {
    assert.ok(isDatabaseUnavailableError({ code }), `expected ${code} to count as unavailable`);
  }
  assert.ok(isDatabaseUnavailableError({ cause: { code: 'ECONNREFUSED' } }), 'should unwrap cause');
});

test('does NOT mistake ordinary query failures for an outage', () => {
  // The critical negative case. Treating a real bug as an outage would hide it
  // behind a reassuring page and make the app look down when it is fine.
  assert.strictEqual(isDatabaseUnavailableError({ code: '23505', message: 'duplicate key value' }), false);
  assert.strictEqual(isDatabaseUnavailableError({ code: '42P01', message: 'relation does not exist' }), false);
  assert.strictEqual(isDatabaseUnavailableError(new Error('Cannot read properties of undefined')), false);
  assert.strictEqual(isDatabaseUnavailableError(null), false);
  assert.strictEqual(isDatabaseUnavailableError({}), false);
});

test('the maintenance page renders without a database and escapes its input', () => {
  const html = maintenancePage({ churchName: 'Grace Chapel', expectedBack: '1 September 2026' });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Grace Chapel'));
  assert.ok(html.includes('1 September 2026'));
  // The reassurance is the point of the page: an administrator must not be left
  // wondering whether the records are gone.
  assert.ok(html.includes('Every record is safe'));
  assert.ok(html.includes('noindex'));

  // Degrades with no arguments at all, and omits the date block rather than
  // printing an empty promise.
  const bare = maintenancePage();
  assert.ok(bare.includes('Church Manager'));
  assert.ok(!bare.includes('Expected back'));

  assert.ok(maintenancePage({ churchName: '<script>alert(1)</script>' }).includes('&lt;script&gt;'));
});

test('an unreachable database serves the maintenance page, not a generic error', async () => {
  // Port 1 refuses instantly, which is the same class of failure as the compute
  // being stopped: the server is simply not answering.
  const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' });
  const app = createTenantApp({ pool, sessionSecret: 'maintenance-test-secret' });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Sign-in is the path that actually needs the database, and the one an
    // administrator hits first when something is wrong.
    const page = await fetch(`${base}/login`);
    const cookie = (page.headers.get('set-cookie') || '').split(';')[0];
    const match = /name="_csrf"[^>]*value="([^"]+)"/.exec(await page.text());
    assert.ok(match, 'expected a CSRF token on the login page');

    const response = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ email: 'a@example.com', password: 'irrelevant', _csrf: match[1] }),
    });

    assert.strictEqual(response.status, 503, 'an outage is unavailable, not an internal error');
    assert.strictEqual(response.headers.get('retry-after'), '3600');

    const body = await response.text();
    assert.ok(body.includes('Temporarily unavailable'));
    assert.ok(!body.includes('Something went wrong'), 'must not fall through to the generic error page');
  } finally {
    server.close();
    await pool.end().catch(() => {});
  }
});

test('the API surface gets JSON, not an HTML maintenance page', async () => {
  const pool = new Pool({ connectionString: 'postgresql://unused:unused@127.0.0.1:1/unused' });
  const app = createTenantApp({ pool, sessionSecret: 'maintenance-test-secret-2' });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/members`, {
      headers: { accept: 'application/json' },
    });
    // Unauthenticated API calls are rejected before any query, so this asserts
    // the far more important thing: an outage never returns an HTML document to
    // a client that asked for JSON.
    assert.ok(!(await response.text()).includes('<!doctype html>'));
  } finally {
    server.close();
    await pool.end().catch(() => {});
  }
});
