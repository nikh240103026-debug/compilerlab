// @ts-check
// Enforces the Part 13 budget: initial JS under 300 KB gzipped.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ROOT } from './lib/env.mjs';

const BUDGET_KB = 300;
const dist = join(ROOT, 'apps', 'web', 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');

const initial = new Set(
  [
    ...html.matchAll(/<script[^>]+src="\/([^"]+\.js)"/g),
    ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/([^"]+\.js)"/g),
  ].map((match) => /** @type {string} */ (match[1])),
);

let totalBytes = 0;
for (const file of initial) {
  totalBytes += gzipSync(readFileSync(join(dist, file))).length;
}

const totalKb = totalBytes / 1024;
console.log(`Initial JS: ${totalKb.toFixed(1)} KB gzipped (budget ${BUDGET_KB} KB)`);
if (totalKb >= BUDGET_KB) {
  console.error('Over budget. Lazy-load more of the app.');
  process.exit(1);
}
