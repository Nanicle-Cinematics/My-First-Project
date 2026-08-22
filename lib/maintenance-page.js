'use strict';

/**
 * The page shown when Postgres cannot be reached.
 *
 * Written after the August 2026 outage, when Neon's compute-time allowance ran
 * out and every route fell through to the generic "Something went wrong" error
 * page — whose only link pointed at the dashboard, which failed the same way.
 * A church administrator could not tell that from the system being broken or
 * abandoned, and there was nothing on screen saying the records were safe.
 *
 * Deliberately self-contained: no layout helper, no stylesheet link, no logo.
 * This must render when everything else is unavailable, and the shared layout
 * pulls in /branding/logo, which is itself a database read.
 */

const DEFAULT_CHURCH_NAME = 'Church Manager';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {object} [options]
 * @param {string} [options.churchName]  Display name, if one is known without a query.
 * @param {string} [options.expectedBack] Human-readable return date, omitted if unknown.
 * @param {string} [options.contactEmail] Where to write for help.
 */
function maintenancePage(options) {
  const opts = options || {};
  const churchName = opts.churchName || DEFAULT_CHURCH_NAME;
  const expectedBack = opts.expectedBack || '';
  const contactEmail = opts.contactEmail || '';

  const backBlock = expectedBack
    ? `<div class="row">
        <span class="dot dot-info" aria-hidden="true"></span>
        <div>
          <div class="row-title">Expected back: ${esc(expectedBack)}</div>
          <p>Service resumes automatically. If it comes back sooner, nothing needs to be done.</p>
        </div>
      </div>`
    : '';

  const contactBlock = contactEmail
    ? `<a class="btn" href="mailto:${esc(contactEmail)}?subject=${encodeURIComponent('Church system unavailable')}">Contact support</a>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Temporarily unavailable · ${esc(churchName)}</title>
<style>
  :root {
    --bg: #f6f7fb; --card: #ffffff; --ink: #0f172a; --muted: #475569;
    --line: #e2e8f0; --accent: #2563eb; --accent-soft: #eaf2ff;
    --ok: #15803d; --warn: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a; --card: #16213a; --ink: #e8edf7; --muted: #a3b0c7;
      --line: #26324b; --accent: #6ea8fe; --accent-soft: #1b2a45;
      --ok: #5fca8a; --warn: #e0a86a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 24px; background: var(--bg); color: var(--ink);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 560px; background: var(--card);
    border: 1px solid var(--line); border-radius: 18px; padding: 32px;
    box-shadow: 0 8px 30px rgba(15, 23, 42, 0.07);
  }
  .badge {
    display: inline-block; padding: 4px 12px; border-radius: 999px;
    background: var(--accent-soft); color: var(--accent);
    font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  }
  h1 { margin: 16px 0 8px; font-size: 26px; line-height: 1.25; }
  p { margin: 0; color: var(--muted); }
  .lead { margin-bottom: 24px; }
  .row { display: flex; gap: 12px; align-items: flex-start; padding: 14px 0; border-top: 1px solid var(--line); }
  .row-title { font-weight: 650; color: var(--ink); }
  .row p { font-size: 14px; margin-top: 2px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 8px; flex: 0 0 auto; }
  .dot-ok { background: var(--ok); }
  .dot-info { background: var(--accent); }
  .btn {
    display: inline-block; margin-top: 22px; padding: 12px 20px; border-radius: 12px;
    background: var(--accent); color: #fff; font-weight: 650; text-decoration: none;
  }
  .foot { margin-top: 18px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
  <main class="card">
    <span class="badge">Temporarily unavailable</span>
    <h1>${esc(churchName)} is offline for a short while</h1>
    <p class="lead">
      The system cannot reach its records right now. This is a problem on our side, not
      anything you did, and we are sorry for the interruption.
    </p>

    <div class="row">
      <span class="dot dot-ok" aria-hidden="true"></span>
      <div>
        <div class="row-title">Every record is safe</div>
        <p>Nothing has been deleted or lost. Members, attendance, giving and reports are all intact and will be exactly as you left them.</p>
      </div>
    </div>
    ${backBlock}

    ${contactBlock}
    <p class="foot">Please try again shortly. There is nothing you need to fix.</p>
  </main>
</body>
</html>`;
}

module.exports = { maintenancePage };
