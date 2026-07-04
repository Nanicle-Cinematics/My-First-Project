'use strict';

const path = require('path');
const { execFile } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;

async function alertFailure(message) {
  if (!process.env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `CRITICAL: Church Manager ${message}` }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error('[operations] alert delivery failed:', error.message);
  }
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
  if (process.env.BACKUP_RUN_ON_START === '1') setTimeout(runBackup, 30_000);
  const hour = Number(process.env.BACKUP_HOUR_UTC || 2);
  const minute = Number(process.env.BACKUP_MINUTE_UTC || 17);
  setTimeout(() => {
    runBackup();
    setInterval(runBackup, DAY_MS);
  }, msUntil(hour, minute));
}

module.exports = { startOperationsScheduler, runBackup, msUntil };
