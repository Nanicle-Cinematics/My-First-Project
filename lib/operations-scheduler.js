'use strict';

const path = require('path');
const { execFile } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;

// Where operator alerts go. Previously this was webhook-only and returned
// immediately when ALERT_WEBHOOK_URL was unset -- which it was -- so backup
// failures were logged and nothing else. That is how a TLS change silently
// broke every scheduled backup for seven hours while the app stayed healthy:
// the failing path had no alerting and no health check.
//
// Now every configured channel is tried, independently: one being
// unconfigured or failing must never suppress the others.
function alertRecipients() {
  return process.env.ALERT_EMAIL || process.env.PLATFORM_ADMIN_EMAILS || '';
}

function alertChannels() {
  return {
    sentry: !!process.env.SENTRY_DSN,
    webhook: !!process.env.ALERT_WEBHOOK_URL,
    email: !!alertRecipients(),
  };
}

async function alertViaSentry(text) {
  if (!process.env.SENTRY_DSN) return { channel: 'sentry', ok: false, reason: 'no SENTRY_DSN' };
  try {
    // Already initialised by lib/instrument.js (server.js's first require);
    // requiring it again returns the same cached, configured module.
    const Sentry = require('@sentry/node');
    Sentry.captureMessage(text, 'error');
    return { channel: 'sentry', ok: true };
  } catch (error) {
    return { channel: 'sentry', ok: false, reason: error.message };
  }
}

async function alertViaWebhook(text) {
  if (!process.env.ALERT_WEBHOOK_URL) return { channel: 'webhook', ok: false, reason: 'no ALERT_WEBHOOK_URL' };
  try {
    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    return { channel: 'webhook', ok: true };
  } catch (error) {
    return { channel: 'webhook', ok: false, reason: error.message };
  }
}

async function alertViaEmail(text) {
  const to = alertRecipients();
  if (!to) return { channel: 'email', ok: false, reason: 'no ALERT_EMAIL / PLATFORM_ADMIN_EMAILS' };
  try {
    const { sendOpsEmail } = require('./delivery');
    const res = await sendOpsEmail(to, 'CRITICAL: Church Manager backup failure', text);
    return { channel: 'email', ok: !!res.ok, reason: res.reason };
  } catch (error) {
    return { channel: 'email', ok: false, reason: error.message };
  }
}

async function alertFailure(message) {
  const text = `CRITICAL: Church Manager ${message}`;
  const settled = await Promise.allSettled([
    alertViaSentry(text), alertViaWebhook(text), alertViaEmail(text),
  ]);
  const results = settled.map((s) => (s.status === 'fulfilled'
    ? s.value
    : { channel: 'unknown', ok: false, reason: s.reason?.message }));
  const delivered = results.filter((r) => r.ok).map((r) => r.channel);
  if (delivered.length) {
    console.error(`[operations] alert delivered via: ${delivered.join(', ')}`);
  } else {
    console.error('[operations] ALERT UNDELIVERED — no channel accepted it:',
      results.map((r) => `${r.channel}(${r.reason})`).join(' '));
  }
  return results;
}

function runBackup() {
  const script = path.join(__dirname, '..', 'scripts', 'pg-backup.sh');
  execFile('bash', [script], { env: process.env, timeout: 30 * 60 * 1000 }, (error, stdout, stderr) => {
    if (error) {
      console.error('[operations] scheduled backup failed:', stderr || error.message);
      void alertFailure(`scheduled backup failed: ${error.message}`);
      return;
    }
    console.log('[operations]', stdout.trim());
  });
}

function msUntil(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function startOperationsScheduler() {
  if (process.env.NODE_ENV !== 'production' || process.env.DISABLE_SCHEDULED_BACKUPS === '1') return;
  const channels = alertChannels();
  const active = Object.entries(channels).filter(([, on]) => on).map(([name]) => name);
  if (active.length) {
    console.log(`[operations] backup alerting active via: ${active.join(', ')}`);
  } else {
    console.warn('[operations] WARNING: no alert channel configured (SENTRY_DSN, '
      + 'ALERT_WEBHOOK_URL, ALERT_EMAIL/PLATFORM_ADMIN_EMAILS all unset) — '
      + 'backup failures will only appear in logs.');
  }
  if (process.env.BACKUP_RUN_ON_START === '1') setTimeout(runBackup, 30_000);
  const hour = Number(process.env.BACKUP_HOUR_UTC || 2);
  const minute = Number(process.env.BACKUP_MINUTE_UTC || 17);
  setTimeout(() => {
    runBackup();
    setInterval(runBackup, DAY_MS);
  }, msUntil(hour, minute));
}

module.exports = { startOperationsScheduler, runBackup, msUntil, alertFailure, alertChannels };
