'use strict';
// Records the computed style of every element on every preview page, in both
// themes, to a JSON file. Diffing two of these (scripts/css-diff.js) shows
// whether a stylesheet edit changed anything that actually reaches the screen.
//
//   node scripts/css-snapshot.js <out.json>
//
// This is more precise than comparing screenshots and needs no image decoding:
// it reads the values the browser resolved after the whole cascade, so an
// edit that is genuinely inert produces a byte-identical result.
//
// Chrome is located via $CHROME_BIN, else the usual macOS and Linux paths.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* keep looking */ }
  }
  throw new Error('No Chrome found. Set CHROME_BIN. Tried:\n  ' + CHROME_CANDIDATES.join('\n  '));
}

// Properties broad enough to catch a real visual change, narrow enough that
// the output stays diffable by eye.
const PROPS = [
  'display', 'position', 'color', 'backgroundColor', 'backgroundImage',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopColor', 'borderBottomColor', 'borderTopLeftRadius', 'borderBottomRightRadius',
  'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'textTransform',
  'marginTop', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingLeft',
  'boxShadow', 'opacity', 'zIndex', 'overflowX', 'overflowY',
  'flexDirection', 'justifyContent', 'alignItems', 'gap', 'gridTemplateColumns',
  'transform', 'backdropFilter', 'width', 'height', 'textAlign', 'whiteSpace',
];

const probeScript = (props) => `<script>
(function () {
  var PROPS = ${JSON.stringify(props)};
  var out = [];
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    var s = getComputedStyle(el);
    // getAttribute, not className: on SVG elements className is an
    // SVGAnimatedString, which stringifies to "[object SVGAnimatedString]"
    // and makes every icon in the report indistinguishable.
    var rec = { t: el.tagName, c: el.getAttribute('class') || '' };
    for (var j = 0; j < PROPS.length; j++) rec[PROPS[j]] = s[PROPS[j]];
    out.push(rec);
  }
  document.title = 'SNAP' + JSON.stringify(out);
})();
</script>`;

function main() {
  const outFile = process.argv[2];
  if (!outFile) {
    console.error('usage: node scripts/css-snapshot.js <out.json>');
    process.exit(2);
  }
  const chrome = findChrome();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'css-snap-'));

  execFileSync('node', [path.join(__dirname, 'ui-preview.js'), tmp], { stdio: 'ignore' });

  const snapshot = {};
  for (const file of fs.readdirSync(tmp).filter((f) => f.endsWith('.html')).sort()) {
    // Strip every script before probing. The shell's theme scripts read
    // matchMedia and race the pinned data-theme attribute, which makes an
    // identical page report light values on one run and dark on the next.
    // That noise swamps the signal. Removing them costs a little coverage
    // (a few classes are added at runtime) but costs it equally on both
    // sides of any comparison.
    const theme = /-dark\./.test(file) ? 'dark' : 'light';
    const html = fs.readFileSync(path.join(tmp, file), 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<html lang="en"[^>]*>/, `<html lang="en" data-theme="${theme}">`)
      .replace('</body>', probeScript(PROPS) + '</body>');
    const probed = path.join(tmp, file.replace('.html', '.probe.html'));
    fs.writeFileSync(probed, html);

    const dom = execFileSync(chrome, [
      // Every script is stripped above, so there is nothing async left to
      // wait for — a small virtual-time budget is enough and keeps the run
      // from costing minutes per page.
      '--headless', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=800', '--window-size=1440,1200',
      '--dump-dom', probed,
    ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

    const m = dom.match(/<title>SNAP([\s\S]*?)<\/title>/);
    if (!m) {
      console.error(`no snapshot produced for ${file} — Chrome may have failed to render it`);
      process.exit(1);
    }
    const json = m[1]
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    snapshot[file] = JSON.parse(json);
  }

  fs.writeFileSync(outFile, JSON.stringify(snapshot));
  fs.rmSync(tmp, { recursive: true, force: true });
  const elements = Object.values(snapshot).reduce((n, a) => n + a.length, 0);
  console.log(`snapshot written: ${outFile} (${Object.keys(snapshot).length} pages, ${elements} elements)`);
}

if (require.main === module) main();
