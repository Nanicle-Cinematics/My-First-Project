'use strict';
// Reports class selectors in a stylesheet that nothing in the codebase appears
// to use. Written for public/styles.css, which carries several generations of
// superseded design and a lot of CSS for markup that no longer exists.
//
//   node scripts/find-unused-css.js            # summary
//   node scripts/find-unused-css.js --list     # every unused class
//   node scripts/find-unused-css.js --used     # every class judged in use
//
// It is deliberately biased toward calling a class USED. Three things in this
// codebase produce class names that no literal grep would find, and each one
// is a way to delete something load-bearing:
//
//   1. Template-built names — `class="pill pill-${status}"`. Any class whose
//      name starts with a prefix seen before a `${` is treated as used, so
//      `pill-member`, `pill-failed` and friends all survive on one sighting.
//   2. Runtime-added names — lib/shell.js's inline scripts add `is-open`,
//      `td-extra`, `toast-hide`, `nav-open` and others via classList, never in
//      a class attribute.
//   3. Names split across concatenation — `'btn ' + variant`.
//
// A class is reported unused only when its exact token appears nowhere in any
// scanned source. That still leaves false positives (a name could be built by
// concatenation this scanner cannot see), so treat the output as a candidate
// list to review, never as a delete script.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Everything that can emit markup or manipulate classes at runtime.
const SOURCE_DIRS = ['lib', 'routes-pg-html', 'routes-pg', 'scripts', 'test'];
const SOURCE_FILES = ['docs/components.html', 'docs/ui-mockup.html'];

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(js|html)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Class tokens appearing in selector position. At-rule preludes (@media
// conditions and the like) are skipped so their contents aren't mistaken for
// selectors; the blocks inside them are still walked.
function cssClasses(css) {
  const classes = new Map(); // name -> occurrence count
  const text = stripComments(css);
  let depth = 0;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = buf.trim();
      buf = '';
      depth++;
      if (prelude.startsWith('@')) continue; // at-rule prelude, not a selector
      for (const m of prelude.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
        classes.set(m[1], (classes.get(m[1]) || 0) + 1);
      }
      continue;
    }
    if (ch === '}') { depth--; buf = ''; continue; }
    if (ch === ';' && depth > 0) { buf = ''; continue; }
    buf += ch;
    if (buf.length > 4000) buf = buf.slice(-2000);
  }
  return classes;
}

function main() {
  const cssPath = process.argv.find((a) => a.endsWith('.css')) || 'public/styles.css';
  const css = fs.readFileSync(path.join(ROOT, cssPath), 'utf8');
  const classes = cssClasses(css);

  const files = [...SOURCE_DIRS.flatMap((d) => walk(d)), ...SOURCE_FILES]
    .filter((f) => fs.existsSync(path.join(ROOT, f)));

  // Every identifier-ish token across all sources, plus the prefixes that
  // precede a template interpolation.
  const tokens = new Set();
  const dynamicPrefixes = new Set();
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const t of src.split(/[^A-Za-z0-9_-]+/)) if (t) tokens.add(t);
    // `pill-${x}` / `status-${x}` — capture the literal stem before the hole.
    for (const m of src.matchAll(/([A-Za-z][\w-]*-)\$\{/g)) dynamicPrefixes.add(m[1]);
  }

  const unused = [];
  const used = [];
  for (const [name, count] of classes) {
    const byToken = tokens.has(name);
    const byPrefix = [...dynamicPrefixes].some((p) => name.startsWith(p));
    (byToken || byPrefix ? used : unused).push({ name, count, byPrefix });
  }
  unused.sort((a, b) => b.count - a.count);

  console.log(`stylesheet:      ${cssPath}`);
  console.log(`sources scanned: ${files.length}`);
  console.log(`dynamic prefixes: ${[...dynamicPrefixes].sort().join(' ') || '(none)'}`);
  console.log(`classes total:   ${classes.size}`);
  console.log(`  in use:        ${used.length}`);
  console.log(`  no reference:  ${unused.length}`);

  if (process.argv.includes('--list')) {
    console.log('\nunused (selector occurrences, name):');
    for (const u of unused) console.log(`  ${String(u.count).padStart(3)}  ${u.name}`);
  }
  if (process.argv.includes('--used')) {
    console.log('\nused:');
    for (const u of used.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${u.name}${u.byPrefix ? '  (via dynamic prefix)' : ''}`);
    }
  }
}

if (require.main === module) main();
module.exports = { cssClasses };
