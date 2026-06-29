'use strict';
// Communications: announcements + bulk SMS/email broadcasts. register(app, ctx).
const { esc } = require('../lib/format');
const { table } = require('../lib/views');

module.exports.register = function register(app, ctx) {
  const { db, requireAdmin, logActivity, flash, csrfValid, CHURCH_NAME, PREF_LABELS,
    pageHero, statsRow,
    loadBibleClasses, loadOrganizations, sendSmsBatch, sendEmailEach, normalizePhoneGH,
    ARKESEL_API_KEY, SMTP_HOST, SMTP_USER, SMTP_PASS, isEmailish } = ctx;

  function requireEmailAdmin(req, res, next) {
    if (res.locals.isOwner) return next();
    res.status(403);
    return res.page({
      title: 'Administrators only',
      active: '/communications',
      body: '<p>Email settings are reserved for administrators.</p><p><a href="/communications">Back to communications</a></p>',
    });
  }

  function loadEmailSettings() {
    return db.prepare(`SELECT * FROM email_settings WHERE setting_id=1`).get() || {
      setting_id: 1,
      provider: 'smtp',
      sender_name: CHURCH_NAME,
      sender_email: SMTP_USER || '',
      reply_to_email: SMTP_USER || '',
      test_recipient_email: '',
    };
  }

  function providerLabel(provider) {
    return ({ smtp: 'SMTP', resend: 'Resend API' }[provider] || 'SMTP');
  }

  function providerReady(provider) {
    return provider === 'resend'
      ? !!process.env.RESEND_API_KEY
      : !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
  }

  function saveEmailSettings(body) {
    const provider = String(body.provider || 'smtp').toLowerCase();
    const senderName = String(body.sender_name || '').trim();
    const senderEmail = String(body.sender_email || '').trim();
    const replyToEmail = String(body.reply_to_email || '').trim();
    const testRecipientEmail = String(body.test_recipient_email || '').trim();
    const errors = [];
    if (!['smtp', 'resend'].includes(provider)) errors.push('Choose a valid email provider.');
    if (!senderName) errors.push('Sender name is required.');
    if (!isEmailish(senderEmail)) errors.push('Sender email must be a valid email address.');
    if (replyToEmail && !isEmailish(replyToEmail)) errors.push('Reply-to email must be valid.');
    if (testRecipientEmail && !isEmailish(testRecipientEmail)) errors.push('Test recipient email must be valid.');
    if (errors.length) return { ok: false, errors };
    db.prepare(`
      INSERT INTO email_settings
        (setting_id, provider, sender_name, sender_email, reply_to_email, test_recipient_email, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(setting_id) DO UPDATE SET
        provider=excluded.provider,
        sender_name=excluded.sender_name,
        sender_email=excluded.sender_email,
        reply_to_email=excluded.reply_to_email,
        test_recipient_email=excluded.test_recipient_email,
        updated_at=CURRENT_TIMESTAMP
    `).run(provider, senderName, senderEmail, replyToEmail, testRecipientEmail);
    return { ok: true };
  }

app.get('/communications', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.display_name, u.username FROM announcements a
    LEFT JOIN users u ON u.user_id=a.posted_by
    ORDER BY a.posted_at DESC LIMIT 50`).all();
  const newForm = res.locals.isAdmin
    ? `<div class="card" style="margin-bottom:1rem">
         <div class="card-head"><h2>Post an announcement</h2></div>
         <form class="form" method="post" action="/communications" style="box-shadow:none;border:0;padding:0">
           <label class="wide">Title<input name="title" required></label>
           <label class="wide">Message<textarea name="body" rows="4" required></textarea></label>
           <label>Audience<select name="audience">
             <option value="all">Everyone</option>
             <option value="members">Members only</option>
           </select></label>
           <div class="actions form-actions">
             <button type="submit">Post announcement</button>
           </div>
         </form>
       </div>` : '';
  const list = rows.length
    ? rows.map((a) => `
        <div class="card" style="margin-bottom:0.75rem">
          <div class="card-head">
            <h2>${esc(a.title)}</h2>
            <span class="meta">${esc(a.posted_at.slice(0, 16).replace('T', ' '))}</span>
          </div>
          <p>${esc(a.body)}</p>
          <p class="muted-text">— ${esc(a.display_name || a.username || 'system')} · audience: ${esc(a.audience)}</p>
        </div>`).join('')
    : `<div class="empty-state">
        <div class="empty-ico" aria-hidden="true">✉</div>
        <h3>No announcements yet</h3>
        <p>${res.locals.isAdmin ? 'Use the form above to post your first announcement.' : 'Once an admin posts an announcement it will appear here.'}</p>
      </div>`;
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM announcements) AS announcements,
      (SELECT COUNT(*) FROM broadcasts) AS broadcasts,
      (SELECT COUNT(*) FROM members WHERE deleted_at IS NULL AND preferred_channel != 'none') AS contactable,
      (SELECT COUNT(*) FROM members WHERE deleted_at IS NULL AND preferred_channel != 'none'
         AND (COALESCE(NULLIF(TRIM(email), ''), NULLIF(TRIM(mobile_phone), '')) IS NOT NULL)) AS reachable,
      (SELECT COUNT(*) FROM broadcast_recipients WHERE status='failed') AS failed_recipients,
      (SELECT COUNT(*) FROM broadcast_recipients WHERE status='sent') AS sent_recipients,
      (SELECT COUNT(*) FROM broadcast_recipients WHERE status='pending') AS pending_recipients
  `).get();
  const readinessRows = [
    ['SMS provider', ARKESEL_API_KEY ? 'configured' : 'dry-run', ARKESEL_API_KEY ? 'Arkesel key is set' : 'SMS sends will be simulated until ARKESEL_API_KEY is configured.'],
    ['Email provider', SMTP_HOST && SMTP_USER && SMTP_PASS ? 'configured' : 'dry-run', SMTP_HOST && SMTP_USER && SMTP_PASS ? `${SMTP_HOST}` : 'Email sends will be simulated until SMTP is configured.'],
    ['Reachable members', Number(stats.reachable).toLocaleString(), `${Number(stats.contactable).toLocaleString()} members have a messaging preference.`],
    ['Failed recipients', Number(stats.failed_recipients).toLocaleString(), 'Review broadcast history for failed destinations.'],
  ];
  const broadcastCta = res.locals.isAdmin
    ? `<div class="page-actions">
         <a class="btn primary" href="/communications/broadcast">＋ Send SMS/email broadcast</a>
         <a class="btn ghost" href="/communications/broadcast?member_id=">Send to one member</a>
         <a class="btn ghost" href="/communications/broadcasts">View broadcast history</a>
         ${res.locals.isOwner ? '<a class="btn ghost" href="/communications/email-settings">Email settings</a>' : ''}
       </div>` : '';
  res.page({
    title: 'Communications', active: '/communications', noHeader: true,
    body: `${pageHero('Communications', 'Announcements, broadcast history and member messaging readiness.')}
      ${statsRow([
        { cls: 'gold', icon: '✉', value: Number(stats.announcements).toLocaleString(), label: 'Announcements' },
        { cls: 'green', icon: '📣', value: Number(stats.broadcasts).toLocaleString(), label: 'Broadcasts' },
        { cls: 'blue', icon: '✓', value: Number(stats.contactable).toLocaleString(), label: 'Contactable Members' },
        { cls: Number(stats.failed_recipients) ? 'orange' : 'green', icon: '!', value: Number(stats.failed_recipients).toLocaleString(), label: 'Failed Recipients' },
      ])}
      ${broadcastCta}
      <section class="card" style="margin-bottom:1rem">
        <div class="card-head"><h2>Messaging Readiness</h2><span class="meta">Providers and delivery health</span></div>
        ${table(['Check', 'Status', 'Detail'], readinessRows.map((row) => row.map(esc)))}
      </section>
      ${newForm}<div class="card-head" style="padding-top:0.5rem"><h2>Recent announcements</h2></div>${list}`,
  });
});

app.get('/communications/new', requireAdmin, (req, res) => res.redirect('/communications'));

app.post('/communications', requireAdmin, (req, res) => {
  const { title, body, audience } = req.body;
  if (!title || !body) return res.redirect('/communications');
  db.prepare(`
    INSERT INTO announcements (title, body, audience, posted_by)
    VALUES (?, ?, ?, ?)`).run(
    title, body, audience || 'all', res.locals.user.user_id
  );
  logActivity('announcement', `New announcement: ${title}`, '/communications', res.locals.user.user_id);
  res.redirect('/communications');
});

// ---------- communications: bulk SMS + email broadcasts ----------
function resolveAudience(orgIds) {
  // orgIds: array of org IDs, OR an empty array for "All members".
  if (!orgIds || orgIds.length === 0) {
    return db.prepare(
      `SELECT m.member_id, m.first_name||' '||m.last_name AS name,
              m.email, m.mobile_phone, m.preferred_channel, m.unsubscribe_token
       FROM members m
       WHERE m.deleted_at IS NULL
         AND m.membership_status IN ('member','regular','visitor')
       ORDER BY m.last_name`
    ).all();
  }
  const placeholders = orgIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT DISTINCT m.member_id, m.first_name||' '||m.last_name AS name,
            m.email, m.mobile_phone, m.preferred_channel, m.unsubscribe_token
     FROM organization_memberships om
     JOIN members m USING(member_id)
     WHERE om.org_id IN (${placeholders})
       AND m.deleted_at IS NULL
       AND m.membership_status IN ('member','regular','visitor')
     ORDER BY m.last_name`
  ).all(...orgIds);
}

function resolveSingleMember(memberId) {
  if (!memberId) return [];
  const member = db.prepare(
    `SELECT m.member_id, m.first_name||' '||m.last_name AS name,
            m.email, m.mobile_phone, m.preferred_channel, m.unsubscribe_token
     FROM members m
     WHERE m.member_id = ?
       AND m.deleted_at IS NULL`
  ).get(memberId);
  return member ? [member] : [];
}

function loadMemberChoices() {
  return db.prepare(
    `SELECT m.member_id, m.first_name||' '||m.last_name AS name,
            m.email, m.mobile_phone, m.preferred_channel
     FROM members m
     WHERE m.deleted_at IS NULL
     ORDER BY m.last_name, m.first_name
     LIMIT 500`
  ).all();
}

// Decide whether a member can receive a given channel, respecting their preferred_channel.
function canReceive(member, channel) {
  const pref = (member.preferred_channel || 'none');
  if (pref === 'none') return false;
  if (channel === 'sms')   return pref !== 'email_only';
  if (channel === 'email') return pref !== 'sms_only';
  return true;
}

function sendErrorText(result) {
  if (!result) return null;
  if (result.dryRun) return 'dry run';
  if (result.error) return result.error;
  if (Array.isArray(result.errors) && result.errors.length) return result.errors.slice(0, 3).join(' | ');
  if (result.response) {
    try { return JSON.stringify(result.response); } catch (_) { return String(result.response); }
  }
  return null;
}

function parseOrgChoice(b) {
  const memberId = Number(b.member_id) || null;
  if (memberId) return { allMembers: false, orgIds: [], memberId };
  if (b.all_members === '1') return { allMembers: true, orgIds: [], memberId: null };
  let raw = b.org_ids;
  if (!raw) return { allMembers: false, orgIds: [], memberId: null };
  const ids = (Array.isArray(raw) ? raw : [raw]).map((x) => Number(x)).filter(Boolean);
  return { allMembers: false, orgIds: ids, memberId: null };
}

function audienceLabel(orgs, choice, recipients = []) {
  if (choice.memberId) return recipients[0] ? `Single member: ${recipients[0].name}` : 'Single member';
  if (choice.allMembers) return 'All members';
  if (!choice.orgIds.length) return 'None';
  const names = orgs.filter((o) => choice.orgIds.includes(o.org_id)).map((o) => o.name);
  return names.length === 1 ? names[0] : names.join(' + ');
}

app.get('/communications/broadcast', requireAdmin, (req, res) => {
  const orgs = loadOrganizations();
  const memberChoices = loadMemberChoices();
  const choice = parseOrgChoice(req.query);
  const audienceChosen = choice.allMembers || choice.orgIds.length > 0 || !!choice.memberId;
  const recipients = audienceChosen
    ? (choice.memberId ? resolveSingleMember(choice.memberId) : resolveAudience(choice.allMembers ? [] : choice.orgIds))
    : [];
  const emailSettings = loadEmailSettings();

  // Channel breakdown — already respects preferred_channel.
  let bothCount = 0, smsOnlyCount = 0, emailOnlyCount = 0, noneCount = 0, excludedPref = 0;
  for (const r of recipients) {
    if ((r.preferred_channel || 'none') === 'none') { excludedPref++; continue; }
    const hasPhone = !!normalizePhoneGH(r.mobile_phone) && canReceive(r, 'sms');
    const hasEmail = !!r.email && canReceive(r, 'email');
    if (hasPhone && hasEmail) bothCount++;
    else if (hasPhone) smsOnlyCount++;
    else if (hasEmail) emailOnlyCount++;
    else noneCount++;
  }
  const reachableSms   = bothCount + smsOnlyCount;
  const reachableEmail = bothCount + emailOnlyCount;

  const smsReady    = !!ARKESEL_API_KEY;
  const emailReady  = providerReady(emailSettings.provider);
  const emailLabel  = providerLabel(emailSettings.provider);
  const statusBanner = (smsReady && emailReady) ? '' :
    `<div class="flash">
       ${smsReady ? '' : '<strong>SMS dry-run mode.</strong> ARKESEL_API_KEY is not set — messages will be logged but not actually sent. '}
       ${emailReady ? '' : `<strong>Email dry-run mode.</strong> ${esc(emailLabel)} secret is not configured.`}
     </div>`;

  const audienceForm = `
    <form method="get" action="/communications/broadcast" class="card" style="margin-bottom:1rem">
      <h2 style="margin-top:0">Audience</h2>
      <label class="check" style="background:none;padding:0;margin-bottom:0.5rem">
        <input type="checkbox" name="all_members" value="1" ${choice.allMembers ? 'checked' : ''}>
        <strong>All members</strong> <span class="muted-text">(every active member)</span>
      </label>
      <label>Single member SMS/email
        <select name="member_id">
          <option value="">Choose one member…</option>
          ${memberChoices.map((m) => `
            <option value="${m.member_id}" ${choice.memberId === m.member_id ? 'selected' : ''}>
              ${esc(m.name)}${m.mobile_phone ? ` · ${esc(m.mobile_phone)}` : ''}${m.email ? ` · ${esc(m.email)}` : ''}
            </option>`).join('')}
        </select>
        <span class="hint">Choose one member to send an individual SMS/email instead of a group broadcast.</span>
      </label>
      <p class="muted-text" style="margin:0.5rem 0">Or choose organization audiences:</p>
      <div class="check-grid" style="opacity:${choice.allMembers ? '0.5' : '1'}">
        ${orgs.map((o) => `
          <label class="check">
            <input type="checkbox" name="org_ids" value="${o.org_id}"
              ${choice.orgIds.includes(o.org_id) ? 'checked' : ''}
              ${choice.allMembers ? 'disabled' : ''}>
            ${esc(o.name)}
          </label>`).join('')}
      </div>
      <div class="actions" style="margin-top:0.75rem"><button type="submit">Load audience</button></div>
    </form>`;

  const previewSection = audienceChosen ? `
    <h2>Audience preview · ${recipients.length} member${recipients.length === 1 ? '' : 's'}</h2>
    <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
      <div class="stat"><div class="ico green">✓</div><div>
        <div class="label">Reachable by SMS</div>
        <div class="value">${reachableSms}</div></div></div>
      <div class="stat"><div class="ico blue">✉</div><div>
        <div class="label">Reachable by email</div>
        <div class="value">${reachableEmail}</div></div></div>
      <div class="stat"><div class="ico purple">📲</div><div>
        <div class="label">Both</div>
        <div class="value">${bothCount}</div></div></div>
      <div class="stat"><div class="ico orange">⚠</div><div>
        <div class="label">No contact info</div>
        <div class="value">${noneCount}</div></div></div>
      <div class="stat"><div class="ico orange">🚫</div><div>
        <div class="label">Excluded (opted out)</div>
        <div class="value">${excludedPref}</div></div></div>
    </div>
    ${recipients.length ? `<details style="margin:0.75rem 0 1rem">
      <summary>Show recipient list</summary>
      ${table(['Name', 'Phone', 'Email', 'Preference'],
        recipients.map((r) => [esc(r.name),
          normalizePhoneGH(r.mobile_phone) || `<span class="muted-text">${esc(r.mobile_phone) || '—'}</span>`,
          esc(r.email) || '<span class="muted-text">—</span>',
          esc(PREF_LABELS[r.preferred_channel || 'none'] || 'Do not contact')]))}
    </details>` : ''}
  ` : '';

  // Hidden inputs to preserve audience selection in the compose form POST.
  const audienceHidden = choice.memberId
    ? `<input type="hidden" name="member_id" value="${choice.memberId}">`
    : (choice.allMembers
      ? `<input type="hidden" name="all_members" value="1">`
      : choice.orgIds.map((id) => `<input type="hidden" name="org_ids" value="${id}">`).join(''));

  const composeForm = audienceChosen && recipients.length ? `
    <h2>Compose message</h2>
    <form class="form" method="post" action="/communications/broadcast">
      ${audienceHidden}
      <label>Channel<select name="channel" required>
        <option value="sms">SMS only (${reachableSms})</option>
        <option value="email">Email only (${reachableEmail})</option>
        <option value="both" selected>Both (${reachableSms} SMS · ${reachableEmail} email)</option>
      </select></label>
      <label>Email subject<input name="subject" placeholder="(required for email)"></label>
      <label class="wide">Message body<textarea name="body" rows="5" required maxlength="900"
        placeholder="Keep it under 160 chars for a single SMS."></textarea></label>
      <p class="muted-text wide" style="margin:0">Members with only a phone receive just the SMS; members with only an email receive just the email. Members missing both are skipped.</p>

      <label class="wide check" style="background:var(--danger-soft);padding:0.5rem 0.75rem;border-radius:8px;margin-top:0.5rem">
        <input type="checkbox" name="ignore_prefs" value="1">
        <strong>Override member preferences (urgent only)</strong> — sends to opted-out members too.
        Use sparingly, e.g. funeral / safety notices.
      </label>

      <fieldset class="wide" style="margin-top:0.5rem">
        <legend>Test send (optional)</legend>
        <label class="check" style="background:none;padding:0">
          <input type="checkbox" name="test_only" value="1">
          <strong>Test only — send to the addresses below instead of the audience</strong>
        </label>
        <div class="day-born-grid" style="grid-template-columns:1fr 1fr;margin-top:0.5rem">
          <label>Test phone<input name="test_phone" placeholder="e.g. 0244555001"></label>
          <label>Test email<input name="test_email" type="email" placeholder="e.g. you@example.com"></label>
        </div>
        <p class="muted-text" style="margin:0.4rem 0 0">Once the test arrives correctly, untick the box and send again to deliver to the full audience.</p>
      </fieldset>

      <div class="actions">
        <button type="submit" onclick="return confirm('Send this broadcast?')">📣 Send broadcast</button>
      </div>
    </form>` : '';

  const body = `
    ${statusBanner}
    ${audienceForm}
    ${previewSection}
    ${composeForm}
    <p style="margin-top:1.5rem"><a href="/communications/broadcasts">View broadcast history →</a></p>
  `;
  res.page({ title: 'Send broadcast', active: '/communications', body });
});

app.get('/communications/email-settings', requireEmailAdmin, (req, res) => {
  const settings = loadEmailSettings();
  const deliveryReady = providerReady(settings.provider);
  const logs = db.prepare(`
    SELECT recipient, subject, status, sent_at, error_message
    FROM email_logs
    ORDER BY email_log_id DESC
    LIMIT 100
  `).all();
  const body = `
    <div class="dashboard-row dashboard-row-split">
      <div class="card">
        <h2>Delivery profile</h2>
        <dl class="stats">
          <dt>Provider</dt><dd>${providerLabel(settings.provider)} <span class="pill pill-${deliveryReady ? 'sent' : 'dry_run'}">${deliveryReady ? 'ready' : 'missing secret'}</span></dd>
          <dt>Sender</dt><dd>${esc(settings.sender_name || CHURCH_NAME)} &lt;${esc(settings.sender_email || '')}&gt;</dd>
          <dt>Reply-to</dt><dd>${esc(settings.reply_to_email || '—')}</dd>
          <dt>Test recipient</dt><dd>${esc(settings.test_recipient_email || '—')}</dd>
        </dl>
        <p class="muted-text">Only non-sensitive delivery details are stored in the database. API keys and SMTP passwords stay in environment secrets.</p>
      </div>
      <div class="card">
        <h2>Secret setup</h2>
        <dl class="stats">
          <dt>SMTP secret</dt><dd><span class="pill pill-${SMTP_HOST && SMTP_USER && SMTP_PASS ? 'sent' : 'dry_run'}">${SMTP_HOST && SMTP_USER && SMTP_PASS ? 'configured' : 'missing'}</span></dd>
          <dt>Resend key</dt><dd><span class="pill pill-${process.env.RESEND_API_KEY ? 'sent' : 'dry_run'}">${process.env.RESEND_API_KEY ? 'configured' : 'missing'}</span></dd>
        </dl>
        <pre>flyctl secrets set \\
  SMTP_HOST="smtp.gmail.com" \\
  SMTP_PORT="465" \\
  SMTP_USER="your.address@gmail.com" \\
  SMTP_PASS="your-app-password" \\
  RESEND_API_KEY="..."</pre>
        <p class="muted-text">Choose SMTP when your mail server uses username/password. Choose Resend when your deployment uses an API key.</p>
      </div>
    </div>
    <div class="card">
      <h2>Configure email</h2>
      <form class="form" method="post" action="/communications/email-settings">
        <label>Email provider
          <select name="provider" required>
            <option value="smtp"${settings.provider === 'smtp' ? ' selected' : ''}>SMTP</option>
            <option value="resend"${settings.provider === 'resend' ? ' selected' : ''}>Resend API</option>
          </select>
        </label>
        <label>Sender name<input name="sender_name" value="${esc(settings.sender_name || CHURCH_NAME)}" required></label>
        <label>Sender email<input type="email" name="sender_email" value="${esc(settings.sender_email || '')}" required></label>
        <label>Reply-to email<input type="email" name="reply_to_email" value="${esc(settings.reply_to_email || '')}" placeholder="Optional"></label>
        <label>Test recipient email<input type="email" name="test_recipient_email" value="${esc(settings.test_recipient_email || '')}" placeholder="Optional"></label>
        <p class="muted-text wide">This page stores display and routing details only. Secret values remain in Fly / environment variables.</p>
        <div class="actions">
          <button type="submit">Save settings</button>
        </div>
      </form>
      <form method="post" action="/communications/email-settings/test" class="filter-bar" data-no-confirm="1" style="margin-top:0.8rem">
        <input type="email" name="recipient" value="${esc(settings.test_recipient_email || '')}" placeholder="Send test to…" required style="flex:1;min-width:220px">
        <button type="submit">Send Test Email</button>
      </form>
    </div>
    <div class="card">
      <h2>Email logs</h2>
      ${logs.length ? table(['Recipient', 'Subject', 'Status', 'Sent date', 'Error'], logs.map((row) => [
        esc(row.recipient),
        esc(row.subject),
        `<span class="pill pill-${esc(row.status)}">${esc(row.status.replace(/_/g, ' '))}</span>`,
        esc(row.sent_at),
        esc(row.error_message || '—'),
      ])) : '<p class="muted-text">No email sends yet.</p>'}
    </div>
  `;
  res.page({ title: 'Email Settings', active: '/communications', body });
});

app.post('/communications/email-settings', requireEmailAdmin, (req, res) => {
  const result = saveEmailSettings(req.body || {});
  if (!result.ok) {
    flash(req, result.errors.join(' '));
    return res.redirect('/communications/email-settings');
  }
  logActivity('settings', 'Updated email settings', '/communications/email-settings', res.locals.user.user_id);
  flash(req, 'Email settings saved.', 'success');
  res.redirect('/communications/email-settings');
});

app.post('/communications/email-settings/test', requireEmailAdmin, async (req, res) => {
  const settings = loadEmailSettings();
  const recipient = (req.body.recipient || settings.test_recipient_email || '').trim();
  if (!isEmailish(recipient)) {
    flash(req, 'Enter a valid test recipient email address.');
    return res.redirect('/communications/email-settings');
  }
  try {
    const result = await sendEmailEach(
      [{ addr: recipient, token: null }],
      `Test email — ${CHURCH_NAME}`,
      `This is a test email from ${CHURCH_NAME}. If you received it, email delivery is configured correctly.`,
      {
        withFooter: false,
        settings,
      }
    );
    if (result.dryRun) flash(req, 'Email is in dry-run mode because the selected provider secret is missing.', 'info');
    else if (result.ok) flash(req, `Test email sent to ${recipient}.`, 'success');
    else flash(req, `Email send failed: ${(result.errors && result.errors[0]) || 'unknown error'}`.slice(0, 300));
  } catch (e) {
    flash(req, `Email error: ${e.message}`);
  }
  res.redirect('/communications/email-settings');
});

app.post('/communications/broadcast', requireAdmin, async (req, res) => {
  const { channel, subject, body } = req.body;
  if (!body || !['sms', 'email', 'both'].includes(channel)) return res.redirect('/communications/broadcast');

  const orgs = loadOrganizations();
  const choice = parseOrgChoice(req.body);
  const testOnly = req.body.test_only === '1';

  // Build the actual audience to send to.
  let audience;
  let audienceLbl;
  let orgIdForRow;
  if (testOnly) {
    const phone = (req.body.test_phone || '').trim();
    const email = (req.body.test_email || '').trim();
    if (!phone && !email) return res.redirect('/communications/broadcast');
    audience = [{
      member_id: null,
      name: 'Test recipient',
      mobile_phone: phone || null,
      email: email || null,
    }];
    audienceLbl = `Test send (${[phone, email].filter(Boolean).join(' / ')})`;
    orgIdForRow = null;
  } else {
    if (!choice.memberId && !choice.allMembers && choice.orgIds.length === 0) {
      return res.redirect('/communications/broadcast');
    }
    audience = choice.memberId ? resolveSingleMember(choice.memberId) : resolveAudience(choice.allMembers ? [] : choice.orgIds);
    if (!audience.length) return res.redirect('/communications/broadcast');
    audienceLbl = audienceLabel(orgs, choice, audience);
    // Only set org_id when exactly one org is selected (schema is single-FK).
    orgIdForRow = (!choice.memberId && !choice.allMembers && choice.orgIds.length === 1) ? choice.orgIds[0] : null;
  }

  // Create the broadcast row.
  const bres = db.prepare(`
    INSERT INTO broadcasts (channel, audience_label, org_id, subject, body, total_recipients, status, sent_by)
    VALUES (?, ?, ?, ?, ?, ?, 'sending', ?)`).run(
    channel, audienceLbl, orgIdForRow, subject || null, body, audience.length, res.locals.user.user_id
  );
  const broadcastId = bres.lastInsertRowid;
  const orgName = audienceLbl;

  const insRecip = db.prepare(`
    INSERT INTO broadcast_recipients (broadcast_id, member_id, channel, destination, status)
    VALUES (?, ?, ?, ?, ?)`);

  // Build per-channel recipient lists. Respects preferred_channel unless override.
  const ignorePrefs = req.body.ignore_prefs === '1';
  const smsList = [];   // {member_id, phone}
  const emailList = []; // {member_id, addr, token}
  for (const m of audience) {
    const prefAllowsSms   = ignorePrefs || canReceive(m, 'sms');
    const prefAllowsEmail = ignorePrefs || canReceive(m, 'email');
    if (channel === 'sms' || channel === 'both') {
      if (!prefAllowsSms) {
        insRecip.run(broadcastId, m.member_id, 'sms', m.mobile_phone || '', 'skipped');
      } else {
        const phone = normalizePhoneGH(m.mobile_phone);
        if (phone) smsList.push({ member_id: m.member_id, phone });
        else insRecip.run(broadcastId, m.member_id, 'sms', m.mobile_phone || '', 'skipped');
      }
    }
    if (channel === 'email' || channel === 'both') {
      if (!prefAllowsEmail) {
        insRecip.run(broadcastId, m.member_id, 'email', m.email || '', 'skipped');
      } else if (m.email) {
        emailList.push({ member_id: m.member_id, addr: m.email, token: m.unsubscribe_token });
      } else {
        insRecip.run(broadcastId, m.member_id, 'email', m.email || '', 'skipped');
      }
    }
  }

  let smsRes = null, emailRes = null;
  if (smsList.length) {
    try {
      smsRes = await sendSmsBatch(smsList.map((s) => s.phone), body);
    } catch (e) { smsRes = { ok: false, error: e.message }; }
    const status = smsRes && smsRes.dryRun ? 'pending' : (smsRes && smsRes.ok ? 'sent' : 'failed');
    const errText = sendErrorText(smsRes);
    const now = new Date().toISOString();
    for (const s of smsList) insRecip.run(broadcastId, s.member_id, 'sms', s.phone, status);
    if (status === 'sent' || status === 'pending') {
      db.prepare(`UPDATE broadcast_recipients SET sent_at=? WHERE broadcast_id=? AND channel='sms' AND status=?`)
        .run(now, broadcastId, status);
    }
    if (errText) {
      db.prepare(`UPDATE broadcast_recipients SET error=? WHERE broadcast_id=? AND channel='sms'`)
        .run(errText, broadcastId);
    }
  }

  if (emailList.length && (channel === 'email' || channel === 'both')) {
    const emailSubject = subject || (orgName ? `Message from ${CHURCH_NAME}` : `Message from ${CHURCH_NAME}`);
    try {
      emailRes = await sendEmailEach(emailList, emailSubject, body);
    } catch (e) { emailRes = { ok: false, error: e.message }; }
    const status = emailRes && emailRes.dryRun ? 'pending' : (emailRes && emailRes.ok ? 'sent' : 'failed');
    const errText = sendErrorText(emailRes);
    const now = new Date().toISOString();
    for (const e of emailList) insRecip.run(broadcastId, e.member_id, 'email', e.addr, status);
    if (status === 'sent' || status === 'pending') {
      db.prepare(`UPDATE broadcast_recipients SET sent_at=? WHERE broadcast_id=? AND channel='email' AND status=?`)
        .run(now, broadcastId, status);
    }
    if (errText) {
      db.prepare(`UPDATE broadcast_recipients SET error=? WHERE broadcast_id=? AND channel='email'`)
        .run(errText, broadcastId);
    }
  }

  // Tally up.
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status='sent'    THEN 1 ELSE 0 END) AS s,
      SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS f,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS p
    FROM broadcast_recipients WHERE broadcast_id=?`).get(broadcastId);

  const dryRun = (smsRes && smsRes.dryRun) || (emailRes && emailRes.dryRun);
  const finalStatus = dryRun
    ? 'dry_run'
    : (counts.f > 0 && counts.s === 0 ? 'failed' : 'sent');

  db.prepare(`
    UPDATE broadcasts SET successful_sends=?, failed_sends=?, status=?
    WHERE broadcast_id=?`).run(counts.s || 0, counts.f || 0, finalStatus, broadcastId);

  logActivity('announcement',
    `Broadcast to ${orgName}: ${audience.length} recipient(s) [${finalStatus}]`,
    `/communications/broadcasts/${broadcastId}`, res.locals.user.user_id);
  res.redirect(`/communications/broadcasts/${broadcastId}`);
});

app.get('/communications/broadcasts', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, COALESCE(u.display_name, u.username) AS sender
    FROM broadcasts b LEFT JOIN users u ON u.user_id=b.sent_by
    ORDER BY b.sent_at DESC LIMIT 100`).all();
  const body = `
    <div class="page-actions"><a class="btn primary" href="/communications/broadcast">＋ Compose new broadcast</a></div>
    ${rows.length ? table(['Sent', 'Channel', 'Audience', 'Recipients', '✓ sent', '✗ failed', 'Status', 'By'],
      rows.map((b) => [esc(b.sent_at.slice(0, 16).replace('T', ' ')),
        esc(b.channel),
        `<a href="/communications/broadcasts/${b.broadcast_id}">${esc(b.audience_label)}</a>`,
        b.total_recipients,
        b.successful_sends,
        b.failed_sends,
        `<span class="pill pill-${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span>`,
        esc(b.sender)]))
      : '<p class="muted-text">No broadcasts sent yet.</p>'}`;
  res.page({ title: 'Broadcast history', active: '/communications', body });
});

app.get('/communications/broadcasts/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare(`
    SELECT b.*, COALESCE(u.display_name, u.username) AS sender,
           o.name AS org_name
    FROM broadcasts b
    LEFT JOIN users u ON u.user_id=b.sent_by
    LEFT JOIN organizations o ON o.org_id=b.org_id
    WHERE b.broadcast_id=?`).get(id);
  if (!b) return res.status(404).send('Not found');
  const recipients = db.prepare(`
    SELECT r.*, m.first_name || ' ' || m.last_name AS name
    FROM broadcast_recipients r
    LEFT JOIN members m ON m.member_id=r.member_id
    WHERE r.broadcast_id=?
    ORDER BY r.status DESC, m.last_name`).all(id);
  const body = `
    <div class="card">
      <div class="card-head">
        <h2>${esc(b.audience_label)} · ${esc(b.channel)}</h2>
        <span class="meta">${esc(b.sent_at.slice(0, 16).replace('T', ' '))} · by ${esc(b.sender)}</span>
      </div>
      <dl class="stats">
        <dt>Status</dt><dd><span class="pill pill-${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></dd>
        <dt>Recipients</dt><dd>${b.total_recipients} (${b.successful_sends} sent, ${b.failed_sends} failed)</dd>
        ${b.subject ? `<dt>Subject</dt><dd>${esc(b.subject)}</dd>` : ''}
      </dl>
      <h3>Message</h3>
      <pre style="white-space:pre-wrap;background:var(--soft);padding:0.75rem;border-radius:8px">${esc(b.body)}</pre>
    </div>
    <h2>Per-recipient log</h2>
    ${table(['Name', 'Channel', 'Destination', 'Status', 'Error'],
      recipients.map((r) => [esc(r.name) || '—', esc(r.channel),
        esc(r.destination) || '<span class="muted-text">—</span>',
        `<span class="pill pill-${esc(r.status)}">${esc(r.status)}</span>`,
        esc(r.error) || '']))}`;
  res.page({ title: 'Broadcast detail', active: '/communications', body });
});
};
