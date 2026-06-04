'use strict';
// Preaching-plan routes + reminders. register(app, ctx).
module.exports.register = function register(app, ctx) {
  const { db, esc, fmtDate, fmtPreachDate, requireAdmin, logActivity, preacherContact, sendPreachingReminder } = ctx;

  function preachingMemberOptions(selectedId) {
    const members = db.prepare(
      `SELECT member_id, first_name || ' ' || last_name AS name
         FROM members WHERE deleted_at IS NULL ORDER BY last_name`).all();
    return '<option value="">— guest / not a member —</option>' +
      members.map((m) =>
        `<option value="${m.member_id}" ${m.member_id === selectedId ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  }
  function preachingForm(plan = {}, action) {
    return `
      <form class="form" method="post" action="${action}">
        <label>Date<input type="date" name="preach_date" required value="${esc(fmtDate(plan.preach_date))}"></label>
        <label>Service / occasion<input name="service_label" placeholder="e.g. Sunday 9:00 AM service" value="${esc(plan.service_label || '')}"></label>
        <label>Preacher (member)<select name="member_id">${preachingMemberOptions(plan.member_id)}</select></label>
        <div class="wide-cell"><span class="hint">If the preacher is a guest (not a member), leave the dropdown on
          <em>guest</em> and fill in their name and contact below so reminders can still reach them.</span></div>
        <label>Guest name<input name="preacher_name" value="${esc(plan.preacher_name || '')}"></label>
        <label>Guest phone<input name="preacher_phone" value="${esc(plan.preacher_phone || '')}"></label>
        <label>Guest email<input type="email" name="preacher_email" value="${esc(plan.preacher_email || '')}"></label>
        <label>Topic / theme<input name="topic" value="${esc(plan.topic || '')}"></label>
        <label>Scripture<input name="scripture" placeholder="e.g. John 3:16" value="${esc(plan.scripture || '')}"></label>
        <label class="wide-cell">Notes<textarea name="notes" rows="2">${esc(plan.notes || '')}</textarea></label>
        <div class="actions">
          <button type="submit">Save</button>
          <a href="/preaching" class="link">Cancel</a>
        </div>
      </form>`;
  }
  function preacherLabel(p) {
    if (p.member_id && p.member_name) return `<a href="/members/${p.member_id}">${esc(p.member_name)}</a>`;
    if (p.preacher_name) return `${esc(p.preacher_name)} <span class="muted-text">(guest)</span>`;
    return '<span class="muted-text">— unassigned —</span>';
  }
  function preachingHasContact(p) {
    if (p.member_id) return !!(p.member_phone || p.member_email);
    return !!(p.preacher_phone || p.preacher_email);
  }
  const PREACHING_SELECT = `
    SELECT pp.*, m.first_name || ' ' || m.last_name AS member_name,
           m.mobile_phone AS member_phone, m.email AS member_email
    FROM preaching_plan pp
    LEFT JOIN members m ON m.member_id = pp.member_id
    WHERE pp.deleted_at IS NULL`;

  function preachingBody(b) {
    return {
      preach_date: (b.preach_date || '').slice(0, 10),
      service_label: (b.service_label || '').trim() || null,
      member_id: b.member_id ? Number(b.member_id) : null,
      preacher_name: (b.preacher_name || '').trim() || null,
      preacher_phone: (b.preacher_phone || '').trim() || null,
      preacher_email: (b.preacher_email || '').trim() || null,
      topic: (b.topic || '').trim() || null,
      scripture: (b.scripture || '').trim() || null,
      notes: (b.notes || '').trim() || null,
    };
  }

  app.get('/preaching', (req, res) => {
    const upcoming = db.prepare(
      `${PREACHING_SELECT} AND date(pp.preach_date) >= date('now') ORDER BY pp.preach_date ASC`).all();
    const past = db.prepare(
      `${PREACHING_SELECT} AND date(pp.preach_date) < date('now') ORDER BY pp.preach_date DESC LIMIT 20`).all();

    const reminderFlash = {
      ok: 'Preaching reminder sent.',
      dry: 'Reminder logged as a dry run — SMS/email are not configured, so nothing was actually delivered.',
      nocontact: 'Could not send: that preacher has no phone or email on file.',
      fail: 'The reminder could not be sent. Check the SMS / email settings.',
    }[req.query.reminder];

    const next = upcoming[0];
    const nextCard = next
      ? `<section class="card" style="margin-bottom:1rem;border-left:4px solid var(--accent)">
           <div class="card-head"><h2>Next up</h2><span class="meta">${esc(fmtPreachDate(next.preach_date))}</span></div>
           <p style="font-size:1.05rem"><strong>${preacherLabel(next)}</strong>
             ${next.service_label ? ` · ${esc(next.service_label)}` : ''}</p>
           ${next.topic ? `<p>Topic: ${esc(next.topic)}${next.scripture ? ` · ${esc(next.scripture)}` : ''}</p>` : ''}
           ${next.reminder_sent_at ? `<p class="muted-text">Reminder last sent ${esc(String(next.reminder_sent_at).slice(0, 16))}.</p>` : ''}
           ${res.locals.isAdmin ? (preachingHasContact(next)
             ? `<form method="post" action="/preaching/${next.plan_id}/remind"
                      onsubmit="return confirm('Send an SMS / email reminder to this preacher?')">
                  <button type="submit">📣 Send reminder to ${esc((preacherContact(next).first) || 'preacher')}</button>
                </form>`
             : '<p class="muted-text">Add a phone or email for this preacher to enable reminders.</p>') : ''}
         </section>`
      : '<p class="muted-text">No upcoming preaching appointments scheduled.</p>';

    const newForm = res.locals.isAdmin
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Schedule a preaching appointment</strong></summary>
           <div style="margin-top:0.75rem">${preachingForm({}, '/preaching')}</div>
         </details>`
      : '';

    const renderRows = (list) => list.map((p) => `
      <tr>
        <td>${esc(fmtPreachDate(p.preach_date))}</td>
        <td>${preacherLabel(p)}</td>
        <td>${esc(p.service_label || '—')}</td>
        <td>${p.topic ? esc(p.topic) : '—'}</td>
        ${res.locals.isAdmin ? `<td style="white-space:nowrap">
          <a href="/preaching/${p.plan_id}/edit" class="link">Edit</a>
          ${preachingHasContact(p)
            ? `<form method="post" action="/preaching/${p.plan_id}/remind" class="inline"
                    onsubmit="return confirm('Send an SMS / email reminder to this preacher?')">
                 <button type="submit" class="link">Remind</button>
               </form>` : ''}
          <form method="post" action="/preaching/${p.plan_id}/delete" class="inline"
                onsubmit="return confirm('Archive this appointment? It will be hidden but not permanently deleted.')">
            <button type="submit" class="link">Archive</button>
          </form>
        </td>` : ''}
      </tr>`).join('');

    const head = `<thead><tr><th>Date</th><th>Preacher</th><th>Service</th><th>Topic</th>${res.locals.isAdmin ? '<th></th>' : ''}</tr></thead>`;
    const upcomingTable = upcoming.length
      ? `<section class="card" style="margin-bottom:1rem"><h2>Upcoming</h2><table>${head}<tbody>${renderRows(upcoming)}</tbody></table></section>`
      : '';
    const pastTable = past.length
      ? `<section class="card"><h2>Recent (past)</h2><table>${head}<tbody>${renderRows(past)}</tbody></table></section>`
      : '';

    res.page({
      title: 'Preaching Plan',
      subtitle: 'Schedule of preaching appointments. Send a reminder to whoever is next.',
      active: '/preaching',
      flash: reminderFlash,
      body: `${nextCard}${newForm}${upcomingTable}${pastTable}`,
    });
  });

  app.post('/preaching', requireAdmin, (req, res) => {
    const v = preachingBody(req.body);
    if (!v.preach_date) return res.redirect('/preaching');
    db.prepare(`
      INSERT INTO preaching_plan
        (preach_date, service_label, member_id, preacher_name, preacher_phone, preacher_email, topic, scripture, notes)
      VALUES (@preach_date, @service_label, @member_id, @preacher_name, @preacher_phone, @preacher_email, @topic, @scripture, @notes)
    `).run(v);
    logActivity('preaching_scheduled',
      `Scheduled preaching for ${fmtPreachDate(v.preach_date)}`,
      '/preaching', res.locals.user.user_id);
    res.redirect('/preaching');
  });

  app.get('/preaching/:id/edit', requireAdmin, (req, res) => {
    const plan = db.prepare(`SELECT * FROM preaching_plan WHERE plan_id=? AND deleted_at IS NULL`)
      .get(Number(req.params.id));
    if (!plan) return res.status(404).send('Appointment not found');
    res.page({
      title: 'Edit Preaching Appointment', active: '/preaching',
      body: preachingForm(plan, `/preaching/${plan.plan_id}`),
    });
  });

  app.post('/preaching/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const v = preachingBody(req.body);
    if (!v.preach_date) return res.redirect(`/preaching/${id}/edit`);
    db.prepare(`
      UPDATE preaching_plan SET
        preach_date=@preach_date, service_label=@service_label, member_id=@member_id,
        preacher_name=@preacher_name, preacher_phone=@preacher_phone, preacher_email=@preacher_email,
        topic=@topic, scripture=@scripture, notes=@notes, updated_at=CURRENT_TIMESTAMP
      WHERE plan_id=@id AND deleted_at IS NULL
    `).run({ ...v, id });
    res.redirect('/preaching');
  });

  app.post('/preaching/:id/delete', requireAdmin, (req, res) => {
    db.prepare(`UPDATE preaching_plan SET deleted_at=CURRENT_TIMESTAMP WHERE plan_id=?`)
      .run(Number(req.params.id));
    res.redirect('/preaching');
  });

  app.post('/preaching/:id/remind', requireAdmin, async (req, res) => {
    const plan = db.prepare(`SELECT * FROM preaching_plan WHERE plan_id=? AND deleted_at IS NULL`)
      .get(Number(req.params.id));
    if (!plan) return res.redirect('/preaching');
    const r = await sendPreachingReminder(plan, res.locals.user.user_id);
    if (!r.ok) return res.redirect('/preaching?reminder=nocontact');
    if (!r.hadPhone && !r.hadEmail) return res.redirect('/preaching?reminder=nocontact');
    if (r.dryRun) return res.redirect('/preaching?reminder=dry');
    const delivered = (r.smsOk === true) || (r.emailOk === true);
    return res.redirect('/preaching?reminder=' + (delivered ? 'ok' : 'fail'));
  });
};
