#!/usr/bin/env node
/**
 * Enforces requirement 8.7: total initial download under 5 MB gzipped.
 *
 * Because all content is procedural, the payload is code plus JSON definitions,
 * so this budget is generous. If it is ever approached, the cause is almost
 * certainly an accidental dependency rather than legitimate growth.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';

const DIST = 'dist';
const BUDGET_BYTES = 5 * 1024 * 1024;
/** Extensions that count toward the initial download. */
const COUNTED = new Set(['.js', '.mjs', '.css', '.html', '.json', '.wasm']);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

async function main() {
  if (!existsSync(DIST)) {
    console.error(`✗ ${DIST}/ not found. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const files = (await walk(DIST)).filter(
    (f) => COUNTED.has(extname(f).toLowerCase()) && !f.endsWith('.map'),
  );

  const entries = [];
  let total = 0;

  for (const file of files) {
    const raw = await readFile(file);
    const gz = gzipSync(raw).byteLength;
    total += gz;
    entries.push({ name: relative(DIST, file), raw: raw.byteLength, gz });
  }

  entries.sort((a, b) => b.gz - a.gz);

  console.log('  Largest files (gzipped):');
  for (const e of entries.slice(0, 10)) {
    console.log(`    ${kb(e.gz).padStart(10)}  ${e.name}`);
  }

  const pct = ((total / BUDGET_BYTES) * 100).toFixed(1);
  console.log(`\n  Total: ${kb(total)} gzipped across ${entries.length} files`);
  console.log(`  Budget: ${kb(BUDGET_BYTES)} — using ${pct}%`);

  if (total > BUDGET_BYTES) {
    console.error(`\n✗ Payload budget exceeded by ${kb(total - BUDGET_BYTES)}.`);
    process.exit(1);
  }

  console.log('✓ Within payload budget');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
