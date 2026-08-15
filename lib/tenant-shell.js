'use strict';
// Phase 8a: adapter wiring the EXISTING, unmodified lib/shell.js (layout()/
// authPage()) to the Postgres stack. lib/shell.js/lib/views.js/lib/format.js
// and public/styles.css are pure/stateless and 100% reused as-is — this file
// only supplies Postgres-appropriate deps and the one normalization shell.js
// actually needs.
//
// shellUser(user): shell.js was written against the OLD SQLite user shape
// (`user.role` lowercase 'admin'/'editor'/'viewer', `user.display_name`
// snake_case). The new Prisma User has `role` as the UPPERCASE UserRole enum
// and `displayName` camelCase. Rather than touch shell.js (kept byte-
// identical/diffable against the original until server.js is retired —
// see the Phase 8 plan), every call site normalizes the user object at this
// boundary before handing it to layout()/res.page().
//
// Backups and delete-all are out of scope (Phase 6 decision) — stubbed as
// safe no-ops, not features to build here.

const { createShell } = require('./shell');
const { esc, initials } = require('./format');
const { flashHtml } = require('./views');
const { icon } = require('./icons');

const CHURCH_NAME_FALLBACK = 'Church Manager';

const VERSES = [
  ['I was glad when they said to me, "Let us go to the house of the Lord."', 'Psalm 122:1'],
  ['The Lord is my shepherd; I shall not want.', 'Psalm 23:1'],
  ['Trust in the Lord with all your heart, and lean not on your own understanding.', 'Proverbs 3:5'],
  ['For I know the plans I have for you, declares the Lord.', 'Jeremiah 29:11'],
  ['Be still, and know that I am God.', 'Psalm 46:10'],
  ['Cast all your anxiety on him because he cares for you.', '1 Peter 5:7'],
  ['The joy of the Lord is your strength.', 'Nehemiah 8:10'],
  ['Love the Lord your God with all your heart.', 'Matthew 22:37'],
  ['I can do all things through Christ who strengthens me.', 'Philippians 4:13'],
  ['Therefore go and make disciples of all nations.', 'Matthew 28:19'],
  ['Let us not grow weary in doing good.', 'Galatians 6:9'],
  ['The Lord bless you and keep you.', 'Numbers 6:24'],
  ['Come to me, all who labor and are heavy laden, and I will give you rest.', 'Matthew 11:28'],
  ['Rejoice in the Lord always; again I will say, rejoice.', 'Philippians 4:4'],
];
function scriptureOfDay() {
  const d = new Date();
  const start = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((d - start) / 86400000);
  return VERSES[dayOfYear % VERSES.length];
}

// Ported from server.js:1178, `/tenant` renamed to `/platform` (the new
// cross-tenant admin surface — see routes-pg/platform.js). Modules not yet
// HTML-ported render dead links until their phase lands (expected, see the
// Phase 8 plan's roadmap note).
const NAV = [
  ['/', 'Dashboard', icon('dashboard')],
  ['/members', 'Members', icon('members')],
  ['/attendance', 'Attendance', icon('attendance')],
  ['/finance', 'Finance', icon('finance')],
  ['/bible-classes', 'Bible Classes', icon('book')],
  ['/organizations', 'Organizations', icon('organizations')],
  ['/inventory', 'Inventory', icon('inventory')],
  ['/events', 'Events', icon('events')],
  ['/preaching', 'Preaching Plan', icon('preaching')],
  ['/communications', 'Communications', icon('communications')],
  ['/reports', 'Reports', icon('reports')],
  ['/help', 'Help', icon('help')],
  ['/platform', 'Platform', icon('platform'), 'admin'],
  ['/users', 'Users & Roles', icon('users'), 'admin'],
  ['/settings', 'Settings', icon('settings')],
];

/** Normalize a Prisma User row into the shape lib/shell.js expects. */
function shellUser(user) {
  if (!user) return null;
  return {
    role: String(user.role || 'VIEWER').toLowerCase(),
    username: user.username,
    display_name: user.displayName,
    canPermanentDeleteAll: false, // delete-all is out of scope; always false is safe
  };
}

const { layout: rawLayout, authPage } = createShell({
  CHURCH_NAME: process.env.CHURCH_NAME || CHURCH_NAME_FALLBACK,
  NAV,
  esc,
  initials,
  flashHtml,
  scriptureOfDay,
  listBackups: () => [], // stub — backups out of scope (Phase 6)
  deleteAllScopes: {}, // stub — delete-all out of scope (Phase 6)
});

// Wrap layout() so every call site can pass the raw Prisma user and get the
// shellUser() normalization applied automatically, rather than remembering
// to call it everywhere.
function layout(opts) {
  const churchName = opts.churchName
    || (opts.user && opts.user.church && opts.user.church.name)
    || undefined;
  return rawLayout({
    ...opts,
    churchName,
    user: opts.user ? shellUser(opts.user) : opts.user,
  });
}

module.exports = { layout, authPage, shellUser, NAV };
