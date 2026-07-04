'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../lib/rate-limit');

function response() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    set(name, value) { headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

test('rate limiter permits the configured allowance then returns 429', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, key: (req) => req.ip });
  const req = { ip: '203.0.113.10', is: () => true };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = response();
    let continued = false;
    limiter(req, res, () => { continued = true; });
    assert.strictEqual(continued, true);
    assert.strictEqual(res.headers['RateLimit-Limit'], '2');
  }

  const blocked = response();
  limiter(req, blocked, () => assert.fail('blocked request must not continue'));
  assert.strictEqual(blocked.statusCode, 429);
  assert.match(blocked.body.error, /Too many requests/);
  assert.ok(Number(blocked.headers['Retry-After']) >= 1);
});
