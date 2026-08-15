'use strict';
// Design-preview harness. Renders the REAL page shell (lib/tenant-shell.js ->
// lib/shell.js) and the REAL view components (lib/views.js) against a set of
// representative fixtures, then writes standalone HTML files with
// public/styles.css inlined so they can be opened or screenshotted with no
// server and no database.
//
// This exists so a stylesheet change can be reviewed against true-to-
// production markup instead of a hand-written mockup that quietly drifts.
//
//   node scripts/ui-preview.js [outDir]

const fs = require('fs');
const path = require('path');
const { layout } = require('../lib/tenant-shell');
const V = require('../lib/views');
const { icon } = require('../lib/icons');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const THEME = fs.readFileSync(path.join(ROOT, 'public', 'theme-ios26.css'), 'utf8');

const USER = { role: 'admin', display_name: 'Nana Aboagye', username: 'nana' };
const CHURCH = 'Dunwell Methodist Church';

function dashboard() {
  const stats = V.statsRow([
    { cls: 'gold', icon: icon('members'), value: '1,284', label: 'Active members' },
    { cls: 'green', icon: icon('finance'), value: '₵48,920', label: 'Giving this month' },
    { cls: 'blue', icon: icon('attendance'), value: '86%', label: 'Attendance rate' },
    { cls: 'purple', icon: icon('events'), value: '7', label: 'Upcoming events' },
  ], '<a class="btn" href="#">Record giving</a><a class="btn ghost" href="#">Add member</a>');

  const recent = `<ul class="list">
    <li><span class="ico">${icon('members')}</span><div><strong>Ama Serwaa</strong> joined Bible Class B</div><span class="when">2h ago</span></li>
    <li><span class="ico">${icon('finance')}</span><div>Sunday offering posted — <strong>₵4,210</strong></div><span class="when">Yesterday</span></li>
    <li><span class="ico">${icon('events')}</span><div>Harvest service scheduled</div><span class="when">2 days ago</span></li>
    <li><span class="ico">${icon('attendance')}</span><div>Attendance recorded for Wednesday service</div><span class="when">3 days ago</span></li>
  </ul>`;

  const finance = `<div class="fin-row"><span class="lbl"><span class="dot">${icon('finance')}</span> Tithes</span><strong>₵18,400</strong></div>
    <div class="fin-row"><span class="lbl"><span class="dot">${icon('wallet')}</span> Offerings</span><strong>₵14,250</strong></div>
    <div class="fin-row"><span class="lbl"><span class="dot">${icon('star')}</span> Harvest</span><strong>₵12,100</strong></div>
    <div class="fin-row"><span class="lbl"><span class="dot">${icon('receipt')}</span> Special</span><strong>₵4,170</strong></div>
    <div class="fin-row total"><span class="lbl">Total</span><strong>₵48,920</strong></div>`;

  const body = `${V.pageHero('Good morning, Nana', 'Here is what is happening across the church this week.')}
    ${stats}
    <div class="grid-2">
      <div class="card"><div class="card-head"><h2>Recent activity</h2><a href="#">View all</a></div>${recent}</div>
      <div class="card"><div class="card-head"><h2>Giving this month</h2><span class="meta">August</span></div>${finance}</div>
    </div>`;
  return layout({ title: 'Dashboard', body, active: '/', user: USER, churchName: CHURCH });
}

function membersPage() {
  const pill = (s, cls) => `<span class="pill pill-${cls}">${s}</span>`;
  const actions = `<a class="icon-btn view" href="#">${V.ICON_EYE}</a><a class="icon-btn edit" href="#">${V.ICON_PENCIL}</a><a class="icon-btn del" href="#">${V.ICON_TRASH}</a>`;
  const rows = [
    ['MBR-001', '<strong>Ama Serwaa</strong>', '024 555 0111', 'Bible Class B', pill('Member', 'member'), actions],
    ['MBR-002', '<strong>Kwame Mensah</strong>', '020 555 0142', 'Bible Class A', pill('Regular', 'regular'), actions],
    ['MBR-003', '<strong>Akosua Boateng</strong>', '055 555 0193', 'Bible Class C', pill('Visitor', 'visitor'), actions],
    ['MBR-004', '<strong>Yaw Darko</strong>', '027 555 0164', 'Bible Class B', pill('Member', 'member'), actions],
    ['MBR-005', '<strong>Efua Nyarko</strong>', '024 555 0175', 'Bible Class A', pill('Inactive', 'inactive'), actions],
  ];
  const inner = V.table(['ID', 'Name', 'Phone', 'Class', 'Status', ''], rows);
  const body = `${V.statsRow([
    { cls: 'gold', icon: icon('members'), value: '1,284', label: 'Total members' },
    { cls: 'green', icon: icon('attendance'), value: '1,102', label: 'Active' },
    { cls: 'blue', icon: icon('star'), value: '46', label: 'New this month' },
  ], '<a class="btn" href="#">Add member</a>')}
    ${V.filterCard({ q: '', placeholder: 'Search members, phone, email…', controls: '<select><option>All classes</option></select><select><option>All statuses</option></select>' })}
    ${V.listCard({ title: 'Members', count: 1284, countLabel: 'members', inner })}
    ${V.pager('/members', {}, 2, 9)}`;
  return layout({ title: 'Members', subtitle: 'Every person on the roll, with class and status.', body, active: '/members', user: USER, churchName: CHURCH });
}

function formPage() {
  const body = `${V.pageHero('Record giving', 'Post an offering straight into the ledger.')}
    <div class="card"><form class="form">
      <label>Member<input value="Ama Serwaa"></label>
      <label>Amount (₵)<input value="250.00" required></label>
      <label>Fund<select><option>General Fund</option><option>Building Fund</option></select></label>
      <label>Date<input type="date" value="2026-08-14"></label>
      <label>Payment method<select><option>Cash</option><option>Mobile money</option></select></label>
      <label>Receipt no.<input value="RCT-00841" readonly></label>
      <label class="wide">Note<textarea rows="3">Sunday morning service.</textarea></label>
      <div class="actions"><button type="button">Save entry</button><button type="button" class="ghost">Cancel</button><button type="button" class="danger">Reverse</button></div>
    </form></div>`;
  return layout({ title: 'Record giving', body, active: '/finance', user: USER, churchName: CHURCH, flash: 'Entry saved and posted to the ledger.', flashType: 'success' });
}

function page(html, { theme } = {}) {
  // Inline both stylesheets, in link order, so the file is self-contained.
  const inlined = html
    .replace(/<link rel="stylesheet" href="\/static\/styles\.css[^"]*">/, `<style>\n${CSS}\n</style>`)
    .replace(/<link rel="stylesheet" href="\/static\/theme-ios26\.css[^"]*">/, `<style>\n${THEME}\n</style>`);
  // Pin the colour scheme so a screenshot is deterministic instead of
  // following whatever the rendering host prefers. The shell's inline
  // theme-init script reads localStorage/matchMedia and would immediately
  // overwrite the pinned attribute, so it is dropped when pinning.
  if (!theme) return inlined;
  // The shell runs two theme scripts that read localStorage/matchMedia, so a
  // pinned attribute in <html> gets overwritten during load. Re-assert it
  // from the very end of <body>, after both have run.
  const pin = `<script>document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});</script>`;
  return inlined
    .replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`)
    .replace('</body>', `${pin}</body>`);
}

// The bare/auth shell is a separate template in lib/shell.js — worth its own
// preview, since it is the first screen anyone sees.
function loginPage() {
  const body = `<form class="form" method="post" action="/login">
    <label class="wide">Email<input type="email" value="nana@dunwell.org"></label>
    <label class="wide">Password<input type="password" value="secret123"></label>
    <div class="actions"><button type="button">Sign in</button></div>
    <p class="hint"><a href="/forgot">Forgot your password?</a></p>
  </form>`;
  return layout({ title: 'Sign in', body, bare: true, active: null, user: null, churchName: CHURCH });
}

// The public marketing page builds its own document rather than going through
// lib/shell.js, so it needs its own preview entry.
function landing() {
  return require('../lib/tenant-landing').landingPage(false);
}

const PAGES = {
  dashboard, members: membersPage, form: formPage, login: loginPage, landing,
};

function main() {
  const outDir = process.argv[2] || path.join(ROOT, '.ui-preview');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, fn] of Object.entries(PAGES)) {
    for (const theme of ['light', 'dark']) {
      const file = path.join(outDir, `${name}-${theme}.html`);
      fs.writeFileSync(file, page(fn(), { theme }));
      console.log(file);
    }
  }
}

if (require.main === module) main();
module.exports = { PAGES, page };
