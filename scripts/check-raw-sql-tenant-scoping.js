#!/usr/bin/env node
'use strict';
// CI guardrail (Phase 4): Prisma's tenantDb extension (lib/tenant.js) only
// intercepts MODEL operations (findMany, create, update, ...) — it cannot
// see inside `$queryRaw`/`$queryRawUnsafe`/`$executeRaw`/`$executeRawUnsafe`
// template strings, so raw SQL is NOT auto-scoped by churchId. Every raw-SQL
// call site in routes-pg/**/*.js must reference "churchId" somewhere in its
// SQL text (usually as a bound parameter in every branch of a UNION/CTE).
// This script fails the build if any raw-SQL block doesn't.
//
// Usage: node scripts/check-raw-sql-tenant-scoping.js

const fs = require('fs');
const path = require('path');

const ROOTS = [
  path.join(__dirname, '..', 'routes-pg'),
  path.join(__dirname, '..', 'lib', 'ledger-pg.js'),
];
const RAW_SQL_CALL = /\$(?:query|execute)Raw(?:Unsafe)?\s*(?:\(|`)/;

function findJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return findJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

// Find each `db.$queryRaw`-style call and capture the template literal that
// follows it, handling nested backtick-delimited ${...} interpolations by
// tracking backtick depth rather than a single non-greedy regex.
function extractRawSqlBlocks(source) {
  const blocks = [];
  const callRe = /\$(?:query|execute)Raw(?:Unsafe)?\s*(\(|`)/g;
  let m;
  while ((m = callRe.exec(source))) {
    const startIdx = m.index;
    const tplStart = source.indexOf('`', m.index);
    if (tplStart === -1) continue;
    let i = tplStart + 1;
    let depth = 0;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source.startsWith('${', i)) { depth++; i += 2; continue; }
      if (depth > 0 && source[i] === '}') { depth--; i += 1; continue; }
      if (depth === 0 && source[i] === '`') break;
      i += 1;
    }
    const line = source.slice(0, startIdx).split('\n').length;
    blocks.push({ line, text: source.slice(tplStart, i + 1) });
  }
  return blocks;
}

function main() {
  const files = ROOTS.flatMap((root) => {
    if (!fs.existsSync(root)) return [];
    return fs.statSync(root).isDirectory() ? findJsFiles(root) : [root];
  });
  const problems = [];
  let totalBlocks = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (!RAW_SQL_CALL.test(source)) continue;
    const blocks = extractRawSqlBlocks(source);
    for (const block of blocks) {
      totalBlocks++;
      if (!/churchId/i.test(block.text)) {
        problems.push(`${path.relative(process.cwd(), file)}:${block.line} — raw SQL block has no "churchId" reference`);
      }
    }
  }

  if (problems.length) {
    console.error(`Raw-SQL tenant-scoping check FAILED (${problems.length} problem(s), ${totalBlocks} raw-SQL block(s) scanned):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`Raw-SQL tenant-scoping check passed (${totalBlocks} raw-SQL block(s) scanned, all churchId-scoped).`);
}

main();
