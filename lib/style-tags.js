'use strict';
// One definition of "which stylesheets a page loads, in what order, with what
// cache-buster". Both HTML entry points use it: lib/shell.js (the app and auth
// shells) and lib/tenant-landing.js (the public marketing page, which builds
// its own document).
//
// It exists because those two drifted: the landing page linked styles.css with
// no version query at all, so returning visitors kept a stale copy after every
// deploy, and it missed the theme layer entirely when that was added.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Order matters: theme-ios26.css layers over styles.css and wins on source
// order, so it must come second.
const SHEETS = ['styles.css', 'theme-ios26.css'];

// Hashed once at module load — these files only change on deploy.
function cssVersion(file) {
  try {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', file));
    return crypto.createHash('sha1').update(css).digest('hex').slice(0, 10);
  } catch (_) {
    return 'dev';
  }
}

const STYLE_TAGS = SHEETS
  .map((file) => `<link rel="stylesheet" href="/static/${file}?v=${cssVersion(file)}">`)
  .join('\n');

module.exports = { STYLE_TAGS, SHEETS, cssVersion };
