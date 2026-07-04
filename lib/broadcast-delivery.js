'use strict';
// Phase 9a: the real send-and-tally logic for a broadcast, shared by
// routes-pg/communications.js (JSON) and routes-pg-html/communications.js
// (HTML) so this isn't duplicated in two places. Ported from the original
// server.js/routes/communications.js's broadcast POST handler (see commit
// f34d66b for the original SQLite version) — same recipient-list-building,
// same per-channel batch/per-recipient send shape, same status tallying.

const { sendSmsBatch, sendEmailEach, normalizePhoneGH } = require('./delivery');

function canReceive(member, channel) {
  const pref = member.preferredChannel || 'NONE';
  if (pref === 'NONE') return false;
  if (channel === 'sms') return pref !== 'EMAIL_ONLY';
  if (channel === 'email') return pref !== 'SMS_ONLY';
  return true;
}

function sendErrorText(result) {
  if (!result) return null;
  if (result.dryRun) return 'dry run';
  if (result.error) return result.error;
  if (Array.isArray(result.errors) && result.errors.length) return result.errors.slice(0, 3).join(' | ');
  return null;
}

/**
 * Sends a broadcast for real (or dry-run, per lib/delivery.js's own
 * secret-presence checks) and updates the Broadcast + BroadcastRecipient
 * rows to reflect the outcome. `db` must be tenant-scoped. `audience` is
 * the array of Member rows already resolved by the caller (same shape
 * resolveAudience() in communications.js produces).
 */
async function sendBroadcastAndTally(db, { broadcastId, audience, channel, subject, body, ignorePrefs, churchName }) {
  const smsList = []; // { memberId, phone }
  const emailList = []; // { memberId, addr, token }

  for (const m of audience) {
    const prefAllowsSms = ignorePrefs || canReceive(m, 'sms');
    const prefAllowsEmail = ignorePrefs || canReceive(m, 'email');
    if (channel === 'sms' || channel === 'both') {
      const phone = prefAllowsSms ? normalizePhoneGH(m.mobilePhone) : null;
      if (phone) smsList.push({ memberId: m.id, phone });
      else await db.broadcastRecipient.updateMany({ where: { broadcastId, memberId: m.id, channel: 'sms' }, data: { status: 'SKIPPED' } });
    }
    if (channel === 'email' || channel === 'both') {
      if (prefAllowsEmail && m.email) emailList.push({ memberId: m.id, addr: m.email, token: m.unsubscribeToken });
      else await db.broadcastRecipient.updateMany({ where: { broadcastId, memberId: m.id, channel: 'email' }, data: { status: 'SKIPPED' } });
    }
  }

  let smsRes = null, emailRes = null;
  if (smsList.length) {
    try { smsRes = await sendSmsBatch(smsList.map((s) => s.phone), body); }
    catch (e) { smsRes = { ok: false, error: e.message }; }
    const status = smsRes && smsRes.dryRun ? 'PENDING' : (smsRes && smsRes.ok ? 'SENT' : 'FAILED');
    const errText = sendErrorText(smsRes);
    const data = { status, ...(status === 'SENT' || status === 'PENDING' ? { sentAt: new Date() } : {}), ...(errText ? { error: errText } : {}) };
    await db.broadcastRecipient.updateMany({ where: { broadcastId, channel: 'sms', memberId: { in: smsList.map((s) => s.memberId) } }, data });
  }

  if (emailList.length && (channel === 'email' || channel === 'both')) {
    const emailSubject = subject || `Message from ${churchName}`;
    try { emailRes = await sendEmailEach(db, emailList, emailSubject, body, { churchName }); }
    catch (e) { emailRes = { ok: false, error: e.message }; }
    const status = emailRes && emailRes.dryRun ? 'PENDING' : (emailRes && emailRes.ok ? 'SENT' : 'FAILED');
    const errText = sendErrorText(emailRes);
    const data = { status, ...(status === 'SENT' || status === 'PENDING' ? { sentAt: new Date() } : {}), ...(errText ? { error: errText } : {}) };
    await db.broadcastRecipient.updateMany({ where: { broadcastId, channel: 'email', memberId: { in: emailList.map((e) => e.memberId) } }, data });
  }

  const [sentCount, failedCount] = await Promise.all([
    db.broadcastRecipient.count({ where: { broadcastId, status: 'SENT' } }),
    db.broadcastRecipient.count({ where: { broadcastId, status: 'FAILED' } }),
  ]);
  const dryRun = (smsRes && smsRes.dryRun) || (emailRes && emailRes.dryRun);
  const finalStatus = dryRun ? 'DRY_RUN' : (failedCount > 0 && sentCount === 0 ? 'FAILED' : 'SENT');

  return db.broadcast.update({
    where: { id: broadcastId },
    data: { successfulSends: sentCount, failedSends: failedCount, status: finalStatus },
  });
}

module.exports = { sendBroadcastAndTally, canReceive };
