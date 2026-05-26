'use strict';
// Integration smoke tests. No external deps: Node's built-in test runner +
// the global fetch, driving the real Express app against a throwaway SQLite DB.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Point the app at a temp DB BEFORE requiring it (it opens the DB on import).
const TMP_DB = path.join(os.tmpdir(), `cms-test-${process.pid}-${Date.now()}.db`);
const TMP_BACKUPS = `${TMP_DB}-backups`;
process.env.CHURCH_DB = TMP_DB;
process.env.BACKUP_DIR = TMP_BACKUPS;
process.env.SESSION_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const app = require('../server.js');

let server, base, cookie;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + ext); } catch (_) {} }
  try { fs.rmSync(TMP_BACKUPS, { recursive: true, force: true }); } catch (_) {}
});

// --- tiny cookie-aware client + CSRF token extraction ---
function rememberCookie(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) {
    if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  }
}
async function get(p) {
  const res = await fetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  rememberCookie(res);
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), body };
}
function tokenFrom(html) {
  const m = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  return m ? m[1] : null;
}
async function post(p, fields) {
  const res = await fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  rememberCookie(res);
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), body };
}

test('unauthenticated root redirects to setup on first run', async () => {
  const r = await get('/');
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /\/setup/);
});

test('setup form carries a CSRF token and creates the admin', async () => {
  const form = await get('/setup');
  const token = tokenFrom(form.body);
  assert.ok(token, 'setup form should contain a CSRF token');
  const r = await post('/setup', {
    username: 'dunwelladmin', display_name: 'Tester',
    password: 'testpass1', password2: 'testpass1', _csrf: token,
  });
  assert.strictEqual(r.status, 302);
  const home = await get('/');
  assert.strictEqual(home.status, 200);
  assert.match(home.body, /Dashboard/);
});

test('state-changing POST without a CSRF token is rejected (403)', async () => {
  const r = await post('/members', { first_name: 'No', last_name: 'Token' });
  assert.strictEqual(r.status, 403);
});

test('a member can be created and shows in the directory', async () => {
  const form = await get('/members/new');
  const token = tokenFrom(form.body);
  assert.ok(token);
  const created = await post('/members', {
    first_name: 'Grace', last_name: 'Tester', membership_status: 'member',
    mobile_phone: '0200000000', gender: 'F', preferred_channel: 'none', _csrf: token,
  });
  assert.strictEqual(created.status, 302);
  const list = await get('/members');
  assert.match(list.body, /Grace<\/a>|Grace Tester|Grace/);
  assert.match(list.body, /Members Directory/);
});

test('invalid member submission is rejected with a flash message', async () => {
  const form = await get('/members/new');
  const token = tokenFrom(form.body);
  const r = await post('/members', { first_name: '', last_name: '', mobile_phone: '123', _csrf: token });
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /\/members\/new/);
  const back = await get('/members/new');
  assert.match(back.body, /First name is required/);
});

test('negative finance amount is rejected', async () => {
  const form = await get('/finance/services');
  const token = tokenFrom(form.body);
  const r = await post('/finance/services', {
    service_type_id: '1', service_date: '2025-01-05', total_amount: '-50', _csrf: token,
  });
  assert.strictEqual(r.status, 302);
  const back = await get('/finance/services');
  assert.match(back.body, /Amount must be a number of 0 or more/);
});

test('bulk export of selected members returns CSV', async () => {
  const list = await get('/members');
  const m = list.body.match(/class="bulk-box" value="(\d+)"/);
  assert.ok(m, 'members list should expose selectable checkboxes');
  const token = tokenFrom(list.body);
  const res = await fetch(base + '/members/bulk', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ member_ids: m[1], action: 'export', _csrf: token }).toString(),
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /csv/);
  assert.match(await res.text(), /Member ID,First name/);
});

test('live-search and bulk markup is present on the members page', async () => {
  const r = await get('/members');
  assert.match(r.body, /data-live-search/);
  assert.match(r.body, /data-results/);
  assert.match(r.body, /class="bulk-bar"/);
});

test('giving statement pages render', async () => {
  const idx = await get('/finance/statements');
  assert.strictEqual(idx.status, 200);
  assert.match(idx.body, /Giving Statements/);
  const stmt = await get('/members/1/statement');
  assert.strictEqual(stmt.status, 200);
  assert.match(stmt.body, /Annual Giving Statement/);
});

test('backups page renders and a backup can be created', async () => {
  const page = await get('/backups');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Backups &amp; Restore/);
  const token = tokenFrom(page.body);
  const r = await post('/backups/create', { _csrf: token });
  assert.strictEqual(r.status, 302);
  const after = await get('/backups');
  assert.match(after.body, /church-\d+\.db/);
});

test('events calendar renders', async () => {
  const r = await get('/events/calendar');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Events Calendar/);
});

test('public RSVP link rejects an unknown token', async () => {
  const r = await get('/rsvp/deadbeef');
  assert.strictEqual(r.status, 404);
});

test('editor role can edit content but is blocked from owner areas', async () => {
  // As the owner (dunwelladmin from setup), create an editor account.
  const form = await get('/users/new');
  const token = tokenFrom(form.body);
  const made = await post('/users', { username: 'editor1', display_name: 'Ed', password: 'editorpass1', role: 'editor', _csrf: token });
  assert.strictEqual(made.status, 302);
  const owner = cookie;
  // Log in as the editor (fresh session).
  cookie = undefined;
  const lp = await get('/login');
  const li = await post('/login', { username: 'editor1', password: 'editorpass1', _csrf: tokenFrom(lp.body) });
  assert.strictEqual(li.status, 302);
  const newMember = await get('/members/new');
  assert.strictEqual(newMember.status, 200);           // editor can edit content
  const backups = await get('/backups');
  assert.strictEqual(backups.status, 403);             // but not owner-only areas
  cookie = owner;
});

test('inventory (extracted route module) can add and list an item', async () => {
  const page = await get('/inventory');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Inventory/);
  const token = tokenFrom(page.body);
  const created = await post('/inventory', { name: 'Keyboard', quantity: '2', category: 'Instruments', _csrf: token });
  assert.strictEqual(created.status, 302);
  const after = await get('/inventory');
  assert.match(after.body, /Keyboard/);
  assert.match(after.body, /Instruments/);
});

test('bible classes (extracted route module) can add and list a class', async () => {
  const page = await get('/bible-classes');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Bible Classes/);
  const created = await post('/bible-classes', { name: 'Adonai Class', _csrf: tokenFrom(page.body) });
  assert.strictEqual(created.status, 302);
  const after = await get('/bible-classes');
  assert.match(after.body, /Adonai Class/);
});

test('unknown route returns a 404 page', async () => {
  const r = await get('/no/such/page');
  assert.strictEqual(r.status, 404);
  assert.match(r.body, /does not exist/);
});

test('the error handler catches a thrown route error, logs it, shows 500', async () => {
  const r = await get('/__throw');
  assert.strictEqual(r.status, 500);
  assert.match(r.body, /Something went wrong/);
  // The owner can then see it in the error log.
  const log = await get('/errors');
  assert.strictEqual(log.status, 200);
  assert.match(log.body, /Error Log/);
  assert.match(log.body, /\/__throw/);
});

test('security headers are present', async () => {
  const res = await fetch(base + '/login', { redirect: 'manual' });
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
});

// Runs LAST: tripping the throttle blocks this IP, so no login may follow it.
test('login throttle returns 429 after repeated failures', async () => {
  const saved = cookie; cookie = undefined;
  const form = await get('/login');
  const token = tokenFrom(form.body);
  assert.ok(token, 'login form should contain a CSRF token');
  let last = 0;
  for (let i = 0; i < 11; i++) {
    const r = await post('/login', { username: 'dunwelladmin', password: 'WRONG', _csrf: token });
    last = r.status;
  }
  assert.strictEqual(last, 429);
  cookie = saved;
});
