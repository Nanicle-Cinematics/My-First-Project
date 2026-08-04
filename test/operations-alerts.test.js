'use strict';
// Alerting for scheduled-backup failures. These matter because the previous
// implementation was webhook-only and silently no-op'd when the webhook was
// unset -- which it was in production -- so seven hours of failed backups
// produced nothing but log lines nobody was reading.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { alertFailure, alertChannels } = require('../lib/operations-scheduler');

const ENV_KEYS = ['ALERT_WEBHOOK_URL', 'ALERT_EMAIL', 'PLATFORM_ADMIN_EMAILS', 'SENTRY_DSN'];
const saved = {};
test.beforeEach(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
test.afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clearAll() { for (const k of ENV_KEYS) delete process.env[k]; }

test('alertChannels reports exactly which channels are configured', () => {
  clearAll();
  assert.deepStrictEqual(alertChannels(), { sentry: false, webhook: false, email: false });

  process.env.SENTRY_DSN = 'https://x@example.test/1';
  process.env.ALERT_WEBHOOK_URL = 'http://127.0.0.1:1/hook';
  assert.deepStrictEqual(alertChannels(), { sentry: true, webhook: true, email: false });
});

test('email channel falls back to PLATFORM_ADMIN_EMAILS when ALERT_EMAIL is unset', () => {
  clearAll();
  process.env.PLATFORM_ADMIN_EMAILS = 'ops@example.test';
  assert.strictEqual(alertChannels().email, true);

  delete process.env.PLATFORM_ADMIN_EMAILS;
  process.env.ALERT_EMAIL = 'someone@example.test';
  assert.strictEqual(alertChannels().email, true);
});

test('a configured webhook actually receives the alert payload', async () => {
  clearAll();
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received = { method: req.method, body }; res.writeHead(204); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/hook`;

  const results = await alertFailure('scheduled backup failed: boom');
  server.close();

  const webhook = results.find((r) => r.channel === 'webhook');
  assert.strictEqual(webhook.ok, true, 'webhook channel should report success');
  assert.strictEqual(received.method, 'POST');
  assert.match(JSON.parse(received.body).text, /CRITICAL: Church Manager scheduled backup failed: boom/);
});

test('one broken channel never suppresses the others', async () => {
  clearAll();
  // Unroutable webhook: must fail without preventing the other channels.
  process.env.ALERT_WEBHOOK_URL = 'http://127.0.0.1:1/definitely-refused';
  process.env.SENTRY_DSN = 'https://x@example.test/1';

  const results = await alertFailure('scheduled backup failed: boom');
  assert.strictEqual(results.length, 3, 'every channel is attempted');
  assert.strictEqual(results.find((r) => r.channel === 'webhook').ok, false);
  assert.strictEqual(results.find((r) => r.channel === 'sentry').ok, true,
    'sentry still fires even though the webhook is refused');
});

test('with nothing configured, alertFailure resolves and reports every channel unconfigured', async () => {
  clearAll();
  const results = await alertFailure('scheduled backup failed: boom');
  assert.strictEqual(results.every((r) => r.ok === false), true);
  assert.deepStrictEqual(results.map((r) => r.channel).sort(), ['email', 'sentry', 'webhook']);
  // Each reports WHY, so the log line is diagnosable rather than just silent.
  assert.ok(results.every((r) => typeof r.reason === 'string' && r.reason.length));
});

test('email alerts never send for real under the test runner', async () => {
  clearAll();
  process.env.PLATFORM_ADMIN_EMAILS = 'ops@example.test';
  process.env.SMTP_HOST = process.env.SMTP_HOST || 'smtp.example.test';
  const results = await alertFailure('scheduled backup failed: boom');
  const email = results.find((r) => r.channel === 'email');
  assert.strictEqual(email.ok, false);
  assert.strictEqual(email.reason, 'test runner', 'lib/delivery.js FORCE_DRY_RUN must block real sends');
});
