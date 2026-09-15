// scripts/check-library-images.mjs
//
// Reports every library entry (across text/image/sound) whose cover is
// missing its -thumb.webp or -large.webp — the same check done by hand,
// over and over, while tracking down ~150 missing covers in one cleanup.
// Exits non-zero when anything's missing, so it can gate a CI job.
//
// Usage: node scripts/check-library-images.mjs

import { readFileSync, existsSync } from 'fs';
import { resolve, join, basename } from 'path';

const DATA_DIR = resolve('src/data');
const IMAGES_ROOT = resolve('public/images/library');
const CATEGORIES = ['text', 'image', 'sound'];

// Mirrors stripExt() in src/pages/library.astro — a sheet-imported entry's
// `image` field is usually extension-less, but can carry a real extension
// once the sheet-side publish flow has matched and uploaded a fresh cover.
const KNOWN_EXT_RE = /\.(jpe?g|png|webp|gif|avif|svg|tiff?|heic|bmp)$/i;
function stripExt(imagePath) {
  return imagePath.replace(KNOWN_EXT_RE, '');
}

let totalMissing = 0;
const report = [];

for (const category of CATEGORIES) {
  const jsonPath = join(DATA_DIR, `library-${category}.json`);
  const entries = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const outDir = join(IMAGES_ROOT, category);

  for (const entry of entries) {
    if (!entry.image) continue;
    const base = basename(stripExt(entry.image));
    const thumbPath = join(outDir, `${base}-thumb.webp`);
    const largePath = join(outDir, `${base}-large.webp`);
    if (!existsSync(thumbPath) || !existsSync(largePath)) {
      totalMissing++;
      report.push(`${category} | ${entry.title} | added by ${entry.by || '(unknown)'} | ${entry.image}`);
    }
  }
}

if (totalMissing === 0) {
  console.log('All library entries have both thumb and large covers.');
  process.exit(0);
}

console.log(`${totalMissing} entr${totalMissing === 1 ? 'y is' : 'ies are'} missing a cover:\n`);
console.log(report.join('\n'));
process.exit(1);
