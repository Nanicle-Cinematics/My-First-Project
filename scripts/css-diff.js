'use strict';
// Diffs two files produced by scripts/css-snapshot.js and reports every
// computed property whose value changed.
//
//   node scripts/css-diff.js <before.json> <after.json> [--max N]
//
// Exit code is 0 whether or not there are differences. A stylesheet change
// SHOULD change how things look, so a difference is not a failure — the point
// is to make the blast radius visible, and to make an accidental change to a
// page nobody was working on impossible to miss.
//
// Exits non-zero only when a page is absent from one side or came back empty,
// which means it failed to render rather than merely looking different. An
// element-count change is reported loudly but is NOT fatal: comparing aligns
// elements by position, so once the counts differ the per-element results
// below are unreliable and should be read as "markup moved", not as a list of
// regressions.

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
  let failedToRender = false;   // fatal: a page is missing or empty
  let markupMoved = false;      // reported: element counts differ
  const byProp = new Map();
  const byPage = new Map();
  const samples = [];

  for (const page of pages) {
    const a = before[page];
    const b = after[page];
    if (!a || !b) {
      console.log(`FAILED TO RENDER: ${page} (${a ? 'absent after' : 'absent before'})`);
      failedToRender = true;
      continue;
    }
    if (a.length === 0 || b.length === 0) {
      console.log(`FAILED TO RENDER: ${page} produced no elements`);
      failedToRender = true;
      continue;
    }
    if (a.length !== b.length) {
      // Not a failure — markup changed. Say so plainly, because everything
      // below aligns elements by index and stops meaning much once the
      // counts diverge.
      console.log(`MARKUP MOVED on ${page}: ${a.length} -> ${b.length} elements`
        + ' (per-element results below are unreliable for this page)');
      markupMoved = true;
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

  if (changedElements === 0 && !markupMoved && !failedToRender) {
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
  if (failedToRender) process.exit(1);
}

if (require.main === module) main();
