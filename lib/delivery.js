'use strict';
// Phase 9a: real SMS (Arkesel) + email (SMTP/Resend) delivery, ported from
// the original server.js (see commit f34d66b, the last commit before the
// Phase 8g Postgres cutover rewrote server.js — that's where these lived).
// Multi-tenant adaptation: the original's `loadEmailSettings()` read ONE
// global singleton row; here EmailSetting is per-church (churchId is its
// effective PK — see prisma/schema.prisma), so every function that touches
// email settings/logs takes a tenant-scoped `db` (res.locals.db) instead of
// reading a module-level global. SMS (Arkesel) has no per-church settings
// in the original either — it's one shared account/sender, unchanged here.

const crypto = require('crypto');

// SAFETY NET: real .env files in this project carry REAL SMTP/Arkesel
// secrets (the same ones deployed to Fly) — and @prisma/client auto-loads
// .env into process.env the moment anything requires it, independent of
// what the invoking shell exports. Relying on every test file to remember
// to delete these vars is fragile (a pre-existing test file almost
// triggered a real SMTP send to a non-reserved test domain the first time
// this module was wired into real code — see the Phase 9a memory entry).
// So: detect `node --test` (via execArgv, which reliably carries
// --test-isolation/--test-force-exit-style flags) and force dry-run
// unconditionally in that context, regardless of what secrets are present.
// Escape hatch (ALLOW_REAL_DELIVERY_IN_TESTS=1) exists for the rare case a
// test deliberately wants to exercise a real send.
const UNDER_TEST_RUNNER = (process.execArgv || []).some((a) => a.startsWith('--test'))
  || (process.argv || []).some((a) => a.startsWith('--test'));
const FORCE_DRY_RUN = UNDER_TEST_RUNNER && process.env.ALLOW_REAL_DELIVERY_IN_TESTS !== '1';

const ARKESEL_API_KEY = process.env.ARKESEL_API_KEY || '';
const ARKESEL_SENDER = process.env.ARKESEL_SENDER || 'CHURCH';
const ARKESEL_URL = 'https://sms.arkesel.com/api/v2/sms/send';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `Church <${SMTP_USER}>` : '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_API_URL = 'https://api.resend.com/emails';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

let smtpTransporter = null;
function getMailer() {
  if (smtpTransporter || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) return smtpTransporter;
  const nodemailer = require('nodemailer');
  smtpTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return smtpTransporter;
}

// Normalize Ghana phone numbers to E.164 (+233XXXXXXXXX). Moved here from
// its previously-duplicated home in routes-pg/communications.js and
// routes-pg-html/communications.js — both now import from this module.
function normalizePhoneGH(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0') && s.length === 10) s = '+233' + s.slice(1);
  else if (/^\d{9}$/.test(s)) s = '+233' + s;
  else if (/^233\d{9}$/.test(s)) s = '+' + s;
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

// One shared Arkesel account for the whole deployment (matches the
// original — SMS has no per-church provider settings, only email does).
async function sendSmsBatch(recipients, message) {
  if (FORCE_DRY_RUN) return { ok: false, dryRun: true, message: 'Running under the test runner; forced dry run.' };
  if (!ARKESEL_API_KEY) return { ok: false, dryRun: true, message: 'ARKESEL_API_KEY not set; dry run.' };
  if (!recipients.length) return { ok: true, sent: 0 };
  const res = await fetch(ARKESEL_URL, {
    method: 'POST',
    headers: { 'api-key': ARKESEL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: ARKESEL_SENDER, message, recipients }),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
  return { ok: res.ok && data && data.code === 'ok', status: res.status, response: data, sent: recipients.length };
}

function emailSenderHeader(settings, churchName) {
  const senderName = (settings && settings.senderName ? settings.senderName : churchName || 'Church').trim() || (churchName || 'Church');
  const senderEmail = (settings && settings.senderEmail ? settings.senderEmail : SMTP_USER).trim();
  return senderEmail ? `${senderName} <${senderEmail}>` : senderName;
}

function emailDeliveryInfo(settings, churchName) {
  const provider = String((settings && settings.provider) || 'SMTP').toUpperCase();
  const senderName = (settings && settings.senderName ? settings.senderName : churchName || 'Church').trim() || (churchName || 'Church');
  const senderEmail = (settings && settings.senderEmail ? settings.senderEmail : SMTP_USER).trim();
  const replyToEmail = (settings && settings.replyToEmail ? settings.replyToEmail : SMTP_USER).trim();
  if (provider === 'RESEND') {
    return { provider: 'resend', ready: !!RESEND_API_KEY, secretLabel: 'RESEND_API_KEY', senderHeader: emailSenderHeader(settings, churchName), senderName, senderEmail, replyToEmail };
  }
  return { provider: 'smtp', ready: !!(SMTP_HOST && SMTP_USER && SMTP_PASS), secretLabel: 'SMTP_HOST / SMTP_USER / SMTP_PASS', senderHeader: emailSenderHeader(settings, churchName), senderName, senderEmail, replyToEmail };
}

async function logEmailAttempt(db, { recipient, subject, status, sentAt, errorMessage, provider, senderName, senderEmail, replyToEmail }) {
  try {
    await db.emailLog.create({
      data: {
        recipient: recipient || '', subject: subject || '', status: status || 'failed',
        sentAt: sentAt || new Date(), errorMessage: errorMessage || null, provider: provider || null,
        senderName: senderName || null, senderEmail: senderEmail || null, replyToEmail: replyToEmail || null,
      },
    });
  } catch (e) { console.error('[delivery] logEmailAttempt failed:', e.message); }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Send one personalized email per recipient. `db` must be a tenant-scoped
 * client (res.locals.db) — loads that church's EmailSetting, logs every
 * attempt to that church's EmailLog. recipients: [{ addr, token? }].
 * opts: { html, replyTo, from, withFooter, settings, churchName }.
 */
async function sendEmailEach(db, recipients, subject, body, opts = {}) {
  const settings = opts.settings || await db.emailSetting.findFirst();
  const churchName = opts.churchName || 'Church';
  const delivery = emailDeliveryInfo(settings, churchName);
  if (FORCE_DRY_RUN) delivery.ready = false;
  const senderHeader = opts.from || delivery.senderHeader || SMTP_FROM;
  const replyTo = opts.replyTo || delivery.replyToEmail || '';
  const now = new Date();

  if (!delivery.ready) {
    for (const r of recipients) {
      await logEmailAttempt(db, {
        recipient: r.addr, subject, status: 'dry_run', sentAt: now,
        errorMessage: FORCE_DRY_RUN ? 'Running under the test runner; forced dry run.' : `Email provider not configured (${delivery.secretLabel})`,
        provider: delivery.provider, senderName: delivery.senderName, senderEmail: delivery.senderEmail, replyToEmail: replyTo || null,
      });
    }
    return { ok: false, dryRun: true, total: recipients.length, provider: delivery.provider };
  }
  if (!recipients.length) return { ok: true, sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  const errors = [];
  for (const r of recipients) {
    const footer = (opts.withFooter !== false) && r.token
      ? (PUBLIC_URL ? `\n\n— ${churchName}\nTo stop receiving these messages, visit ${PUBLIC_URL}/u/${r.token}` : `\n\n— ${churchName}\nTo stop receiving messages, contact the church office.`)
      : '';
    try {
      if (delivery.provider === 'resend') {
        const payload = { from: senderHeader, to: r.addr, subject, text: body + footer };
        if (opts.html) payload.html = opts.html + (footer ? `<p style="margin-top:16px;color:#6b7280;font-size:12px">${esc(footer).replace(/\n/g, '<br>')}</p>` : '');
        if (replyTo) payload.reply_to = replyTo;
        const res = await fetch(RESEND_API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const raw = await res.text();
        if (!res.ok) throw new Error(raw || `HTTP ${res.status}`);
      } else {
        const mailer = getMailer();
        if (!mailer) throw new Error('SMTP transporter unavailable');
        await mailer.sendMail({
          from: senderHeader, to: r.addr, subject, text: body + footer,
          html: opts.html ? opts.html + (footer ? `<p style="margin-top:16px;color:#6b7280;font-size:12px">${esc(footer).replace(/\n/g, '<br>')}</p>` : '') : undefined,
          replyTo: replyTo || undefined,
        });
      }
      sent++;
      await logEmailAttempt(db, { recipient: r.addr, subject, status: 'sent', sentAt: new Date(), provider: delivery.provider, senderName: delivery.senderName, senderEmail: delivery.senderEmail, replyToEmail: replyTo || null });
    } catch (e) {
      failed++; errors.push(e.message);
      await logEmailAttempt(db, { recipient: r.addr, subject, status: 'failed', sentAt: new Date(), errorMessage: e.message, provider: delivery.provider, senderName: delivery.senderName, senderEmail: delivery.senderEmail, replyToEmail: replyTo || null });
    }
  }
  return { ok: failed === 0, sent, failed, errors, provider: delivery.provider };
}

module.exports = { sendSmsBatch, sendEmailEach, normalizePhoneGH, emailDeliveryInfo };
