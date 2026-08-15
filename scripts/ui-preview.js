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
const { sparkline } = require('../lib/charts');

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
      <div class="actions"><button type="submit">Save entry</button><button type="button" class="ghost">Cancel</button><button type="submit" class="danger">Reverse</button></div>
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

// The real dashboard (lib/tenant-dashboard.js) needs a database, so its markup
// is mirrored here instead. It is worth mirroring rather than skipping: it is
// the landing screen for every signed-in user, and it is the only place with a
// dark-on-light banner — a heading that inherits white from its container.
// A global `h1 { color }` rule in the theme layer once forced that heading to
// dark ink and made the dashboard title nearly invisible in production, which
// no other preview page could have caught.
function dashboardHero() {
  const tile = (href, name, iconName, desc) =>
    `<a class="report-tile" href="${href}"><div class="ico">${icon(iconName)}</div>`
    + `<div><div class="name">${name}</div><div class="desc">${desc}</div></div></a>`;
  const body = `<section class="dashboard-welcome">
      <div>
        <span class="welcome-eyebrow">Good morning · Saturday 15 August</span>
        <h1>Your ministry at a glance.</h1>
        <p>Stay close to your people, your services and the work that needs attention.</p>
      </div>
      <div class="welcome-actions">
        <a class="btn ghost" href="#">View calendar</a>
        <a class="btn primary" href="#">Add member <span>${icon('plus')}</span></a>
      </div>
    </section>
    ${V.statsRow([
      { cls: 'gold', icon: icon('members'), value: '2', label: 'Members' },
      { cls: 'green', icon: icon('plus'), value: '0', label: 'New this month' },
      { cls: 'blue', icon: icon('attendance'), value: '0', label: 'Check-ins (7d)' },
      { cls: 'purple', icon: icon('finance'), value: '₵0.00', label: 'Income this month' },
    ])}
    <div class="dashboard-section-head"><div><span>Workspace</span><h2>Quick access</h2></div><a href="#">Need help? →</a></div>
    <div class="report-tiles dashboard-quick-links">
      ${tile('#', 'Members', 'members', '2 total')}
      ${tile('#', 'Events', 'events', '0 upcoming')}
      ${tile('#', 'Finance', 'finance', '3 funds')}
      ${tile('#', 'Bible Classes', 'book', '1 class')}
      ${tile('#', 'Organizations', 'organizations', '12 groups')}
      ${tile('#', 'Reports', 'reports', 'Day-born, income, members')}
    </div>`;
  return layout({ title: 'Dashboard', body, active: '/', user: USER, churchName: CHURCH, noHeader: true });
}

// Finance is the largest module and has surfaces nothing else does: a KPI
// strip, a collapsible module directory whose icons are bare glyphs, and a
// printable receipt document. Mirrored from routes-pg-html/finance.js.
function financeIndex() {
  const kpi = (cls, label, value, note) =>
    `<a class="finance-kpi ${cls}" href="#"><span>${label}</span><strong>${value}</strong><small>${note}</small></a>`;
  const group = (label, items, open) => `<details ${open ? 'open' : ''}>
      <summary><span>${label}</span><small>${items.length} tools</small></summary>
      <div class="finance-module-links">${items.map(([g, name]) =>
        `<a href="#"><span class="finance-module-icon">${g}</span><strong>${name}</strong><span aria-hidden="true">→</span></a>`).join('')}</div>
    </details>`;
  const body = `${V.pageHero('Finance', 'A clear view of your church\u2019s financial position and next actions.')}
    <div class="finance-command">
      <section class="finance-kpi-grid" aria-label="Financial overview">
        ${kpi('', 'Fund balances', '\u20b581,410', 'Across 6 active funds')}
        ${kpi('positive', 'Income this month', '\u20b548,920', '2026-08-01 to 2026-08-31')}
        ${kpi('positive', 'Net movement', '\u20b536,780', '\u20b512,140 spent this month')}
        ${kpi('warning', 'Expense budget used', '91%', '\u20b512,140 of \u20b513,340')}
        ${kpi('warning', 'Outstanding pledges', '\u20b54,300', '7 open pledges')}
      </section>
      <section class="finance-quick-actions" aria-label="Quick actions">
        <div><p class="eyebrow">Quick actions</p><h2>Record today\u2019s activity</h2></div>
        <div class="finance-action-buttons">
          <a class="btn" href="#">+ Record income</a>
          <a class="btn secondary" href="#">+ Record expense</a>
          <a class="btn ghost" href="#">Record pledge payment</a>
        </div>
      </section>
      <div class="finance-dashboard-grid">
        <section class="card finance-attention">
          <div class="card-head"><div><p class="eyebrow">Attention</p><h2>Financial checks</h2></div><span class="meta">2 items</span></div>
          <div class="finance-alert-list">
            <a class="finance-alert warning" href="#"><span class="finance-alert-dot"></span><span><strong>Expense budget is nearing its limit</strong><small>Actual spending is 91% of budget.</small></span><span aria-hidden="true">\u2192</span></a>
            <a class="finance-alert neutral" href="#"><span class="finance-alert-dot"></span><span><strong>Current financial period is open</strong><small>Lock it after reconciliation.</small></span><span aria-hidden="true">\u2192</span></a>
          </div>
        </section>
        <section class="card finance-recent">
          <div class="card-head"><div><p class="eyebrow">Ledger</p><h2>Recent activity</h2></div></div>
          <div class="finance-empty"><strong>No ledger activity yet</strong><span>Recorded income and expenses will appear here.</span></div>
        </section>
      </div>
      <section class="finance-module-directory">
        <div class="finance-section-heading"><div><p class="eyebrow">Workspace</p><h2>Finance tools</h2></div><p>Open the detailed registers, controls, and reports.</p></div>
        <div class="finance-module-groups">
          ${group('Money in', [[icon('trend'), 'General income'], [icon('plus'), 'Tithes'], [icon('star'), 'Special offerings'], [icon('sun'), 'Day-born collections'], [icon('church'), 'Services'], [icon('harvest'), 'Harvests'], [icon('diamond'), 'Pledges']], true)}
          ${group('Money out &amp; controls', [[icon('trendDown'), 'Expenses'], [icon('receipt'), 'Payment vouchers'], [icon('wallet'), 'Funds'], [icon('folder'), 'Projects'], [icon('ledger'), 'Budgets'], [icon('clock'), 'Financial periods']], false)}
        </div>
      </section>
    </div>`;
  return layout({ title: 'Finance', body, active: '/finance', user: USER, churchName: CHURCH, noHeader: true });
}

function financeReceipt() {
  const line = (l, r, cls = '') => `<div class="rc-line ${cls}"><span>${l}</span>${r}</div>`;
  const body = `<div class="receipt-actions screen-only">
      <a class="btn-link" href="#">← Back to receipts</a>
      <a class="btn" href="#">🖨 Print / save as PDF</a>
    </div>
    <div class="print-doc receipt-doc">
      <div class="rc-head">
        <div><div class="rc-church">⛪ ${CHURCH}</div><div class="muted-text">Pledge Payment Receipt</div></div>
        <div class="rc-no"><strong>RCT-00841</strong><br><span class="muted-text">2026-08-15</span></div>
      </div>
      ${line('Received from', '<strong>Ama Serwaa</strong>')}
      ${line('For', '<span>Harvest 2026 pledge</span>')}
      ${line('Amount received', '<strong>₵250.00</strong>')}
      ${line('Total pledged', '<span>₵1,000.00</span>')}
      ${line('Paid to date', '<span>₵600.00</span>')}
      ${line('Outstanding balance', '<span>₵400.00</span>', 'rc-total')}
      ${line('Recorded by', '<span>Nana Aboagye</span>')}
      <p class="rc-foot">Thank you. A balance of <strong>₵400.00</strong> remains on this pledge.</p>
    </div>`;
  return layout({ title: 'Receipt RCT-00841', body, active: '/finance', user: USER, churchName: CHURCH, noHeader: true });
}

// Attendance brings two things no other fixture has: a real sparkline from
// lib/charts.js, and a five-across stat row over a seven-column numeric table.
// Both are places where a layout can go wrong without anything else noticing.
function attendancePage() {
  const trend = [42, 51, 47, 63, 58, 71, 66, 74].map((value, i) => ({ label: `Wk ${i + 1}`, value }));
  const cell = (v) => (v == null ? '<span class="muted-text">—</span>' : `<strong>${v}</strong>`);
  const rows = [
    ['2026-08-09 09:00', '<a href="#">Sunday Morning Service</a>', cell(38), cell(52), cell(24), cell(114), '<a class="btn ghost" href="#">Edit →</a>'],
    ['2026-08-06 18:30', '<a href="#">Wednesday Bible Study</a>', cell(12), cell(19), cell(6), cell(37), '<a class="btn ghost" href="#">Edit →</a>'],
    ['2026-08-02 09:00', '<a href="#">Sunday Morning Service</a>', cell(41), cell(55), cell(21), cell(117), '<a class="btn ghost" href="#">Edit →</a>'],
    ['2026-07-30 18:30', '<a href="#">Wednesday Bible Study</a>', cell(null), cell(null), cell(null), cell(null), '<a class="btn ghost" href="#">Edit →</a>'],
  ];
  const inner = V.table(['When', 'Title', 'Men', 'Women', 'Children', 'Total', 'Actions'], rows);
  const body = `${V.pageHero('Attendance', 'Track service participation. Record Men / Women / Children counts per service — add or edit a service right here.')}
    ${V.statsRow([
      { cls: 'gold', icon: icon('attendance'), value: '66', label: 'Avg attendance (last 8)' },
      { cls: 'green', icon: icon('events'), value: '20', label: 'Services tracked' },
      { cls: 'blue', icon: icon('ledger'), value: '17', label: 'Counts recorded' },
      { cls: 'purple', icon: icon('members'), value: '1,284', label: 'Total attendance' },
      { cls: 'green', icon: icon('delta'), value: '+8', label: 'Last service change' },
    ], '<a class="btn primary" href="#">Add Service</a>')}
    <div class="card">
      <div class="card-head"><h2>Attendance trend</h2><span class="meta">Last 8 services</span></div>
      ${sparkline(trend)}
    </div>
    ${V.listCard({ title: 'Recent services', count: 20, countLabel: 'services', inner })}`;
  return layout({ title: 'Attendance', body, active: '/attendance', user: USER, churchName: CHURCH, noHeader: true });
}

// The empty state is a separate surface with its own icon well and centring,
// and it is what a brand-new church sees first.
function attendanceEmpty() {
  const inner = `<div class="empty-state">
      <div class="empty-ico" aria-hidden="true">${icon('attendance')}</div>
      <h3>No services tracked yet</h3>
      <p>Add your first service to start recording attendance counts.</p>
      <a class="btn primary" href="#">Add Service</a>
    </div>`;
  const body = `${V.pageHero('Attendance', 'Track service participation.')}
    ${V.listCard({ title: 'Recent services', count: 0, countLabel: 'services', inner })}`;
  return layout({ title: 'Attendance', body, active: '/attendance', user: USER, churchName: CHURCH, noHeader: true });
}

// The bare/auth shell is a separate template in lib/shell.js — worth its own
// preview, since it is the first screen anyone sees.
function loginPage() {
  const body = `<form class="form" method="post" action="/login">
    <label class="wide">Email<input type="email" value="nana@dunwell.org"></label>
    <label class="wide">Password<input type="password" value="secret123"></label>
    <div class="actions"><button type="submit">Sign in</button></div>
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
  dashboard, dashboardHero, members: membersPage, form: formPage,
  financeIndex, financeReceipt, attendancePage, attendanceEmpty,
  login: loginPage, landing,
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
