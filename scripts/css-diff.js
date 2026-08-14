'use strict';
// Diffs two files produced by scripts/css-snapshot.js and reports every
// computed property whose value changed.
//
//   node scripts/css-diff.js <before.json> <after.json> [--max N]
//
// Exit code is 0 whether or not there are differences. A stylesheet change
// SHOULD change how things look, so a difference is not a failure — the point
// is to make the blast radius visible, and to make an accidental change to a
// page nobody was working on impossible to miss. Exits non-zero only when a
// snapshot is missing pages the other one has, which means a page failed to
// render rather than merely looking different.

const fs = require('fs');

function main() {
  const [beforePath, afterPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!beforePath || !afterPath) {
    console.error('usage: node scripts/css-diff.js <before.json> <after.json> [--max N]');
    process.exit(2);
  }
  const maxIdx = process.argv.indexOf('--max');
  const maxSamples = maxIdx === -1 ? 30 : Number(process.argv[maxIdx + 1]) || 30;

  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

  const pages = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  let compared = 0;
  let changedElements = 0;
  let structural = false;
  const byProp = new Map();
  const byPage = new Map();
  const samples = [];

  for (const page of pages) {
    const a = before[page];
    const b = after[page];
    if (!a || !b) {
      console.log(`MISSING PAGE: ${page} (${a ? 'absent after' : 'absent before'})`);
      structural = true;
      continue;
    }
    if (a.length !== b.length) {
      console.log(`ELEMENT COUNT CHANGED on ${page}: ${a.length} -> ${b.length}`);
      structural = true;
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      compared++;
      let changed = false;
      for (const key of Object.keys(a[i])) {
        if (key === 't' || key === 'c') continue;
        if (a[i][key] === b[i][key]) continue;
        changed = true;
        byProp.set(key, (byProp.get(key) || 0) + 1);
        if (samples.length < maxSamples) {
          samples.push(
            `${page}  <${a[i].t.toLowerCase()} class="${(a[i].c || '').slice(0, 44)}">\n` +
            `      ${key}: ${a[i][key]}\n` +
            `        ->  ${b[i][key]}`
          );
        }
      }
      if (changed) {
        changedElements++;
        byPage.set(page, (byPage.get(page) || 0) + 1);
      }
    }
  }

  console.log(`pages compared:    ${pages.length}`);
  console.log(`elements compared: ${compared}`);
  console.log(`elements changed:  ${changedElements}`);

  if (changedElements === 0 && !structural) {
    console.log('\nNo rendered difference.');
    return;
  }
  if (byPage.size) {
    console.log('\nby page:');
    for (const [k, v] of [...byPage].sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  if (byProp.size) {
    console.log('\nby property:');
    for (const [k, v] of [...byProp].sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
    console.log('\nsamples:');
    for (const s of samples) console.log('  ' + s);
  }
  if (structural) process.exit(1);
}

if (require.main === module) main();
