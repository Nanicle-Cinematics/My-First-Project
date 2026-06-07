const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const SID_RAW = process.env.SID || '';
const PORT = process.env.SHOOT_PORT || 3001;
const OUTDIR = process.env.OUTDIR || '/tmp/before';
const FULLPAGE = process.env.FULLPAGE === '1';

const PAGES = [
  { url: '/',                    file: 'dashboard.png',          fullPage: true },
  { url: '/members',             file: 'members.png',            fullPage: true },
  { url: '/members/new',         file: 'members-new.png',        fullPage: true },
  { url: '/members/1',           file: 'members-detail.png',     fullPage: true },
  { url: '/finance',             file: 'finance.png',            fullPage: true },
  { url: '/events',              file: 'events.png',             fullPage: true },
  { url: '/attendance',          file: 'attendance.png',         fullPage: true },
  { url: '/organizations',       file: 'organizations.png',      fullPage: true },
  { url: '/reports',             file: 'reports.png',            fullPage: true },
  { url: '/communications',      file: 'communications.png',     fullPage: true },
  { url: '/inventory',           file: 'inventory.png',          fullPage: true },
  { url: '/bible-classes',       file: 'bible-classes.png',      fullPage: true },
  { url: '/preaching',           file: 'preaching.png',          fullPage: true },
  { url: '/users',               file: 'users.png',              fullPage: true },
  { url: '/backups',             file: 'backups.png',            fullPage: true },
];

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
  });
  if (SID_RAW) {
    await ctx.addCookies([{
      name: 'connect.sid',
      value: SID_RAW.startsWith('s%3A') ? SID_RAW : 's%3A' + SID_RAW,
      domain: 'localhost', path: '/', httpOnly: true,
    }]);
  }
  fs.mkdirSync(OUTDIR, { recursive: true });
  for (const p of PAGES) {
    const page = await ctx.newPage();
    try {
      const resp = await page.goto('http://localhost:' + PORT + p.url, {
        waitUntil: 'networkidle', timeout: 15000,
      });
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(OUTDIR, p.file), fullPage: p.fullPage });
      console.log('OK', p.url, '->', p.file, '(', resp.status(), ')');
    } catch (e) {
      console.error('FAIL', p.url, e.message);
    }
    await page.close();
  }
  await browser.close();
})();
