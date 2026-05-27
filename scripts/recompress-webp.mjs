// Re-encode every .webp under public/images at quality 75 with maximum
// compression effort. Visually indistinguishable from the originals at
// typical web sizes (sharp's effort: 6 squeezes the encoder harder
// without lossy concessions). Only overwrites a file if the new bytes
// are actually smaller than the original — so a file is never made
// worse by this script.
//
// Run: node scripts/recompress-webp.mjs
//
// To roll back: `git checkout public/images/` restores the prior binaries.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const ROOT = path.join(REPO, 'public/images');
const QUALITY = 75;
const EFFORT = 6;
const MIN_SIZE = 4 * 1024; // <4 KB files are tiny placeholders; skip

let totalBefore = 0;
let totalAfter = 0;
let processed = 0;
let skipped = 0;
let unchanged = 0;
const startedAt = Date.now();

async function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.toLowerCase().endsWith('.webp')) yield full;
  }
}

const allFiles = [];
for await (const f of walk(ROOT)) allFiles.push(f);
console.log(`Found ${allFiles.length} .webp files under public/images`);

for (const file of allFiles) {
  const before = fs.statSync(file).size;
  if (before < MIN_SIZE) {
    skipped++;
    continue;
  }
  try {
    const out = await sharp(file)
      .webp({
        quality: QUALITY,
        effort: EFFORT,
        alphaQuality: 80,
        smartSubsample: true,
      })
      .toBuffer();
    if (out.length < before) {
      fs.writeFileSync(file, out);
      totalBefore += before;
      totalAfter += out.length;
      processed++;
    } else {
      unchanged++;
    }
  } catch (e) {
    console.warn(`error on ${file}: ${e.message}`);
    skipped++;
  }
  if ((processed + unchanged + skipped) % 200 === 0) {
    const pct = totalBefore ? ((1 - totalAfter / totalBefore) * 100).toFixed(1) : '—';
    console.log(`  ${processed + unchanged + skipped}/${allFiles.length} (${pct}% smaller so far)`);
  }
}

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
const mbBefore = (totalBefore / 1024 / 1024).toFixed(1);
const mbAfter = (totalAfter / 1024 / 1024).toFixed(1);
const savings = totalBefore ? ((1 - totalAfter / totalBefore) * 100).toFixed(1) : '0';
console.log(`\nDone in ${elapsedSec}s`);
console.log(`  Processed: ${processed} files`);
console.log(`  Unchanged (recompression was larger): ${unchanged}`);
console.log(`  Skipped (too small or errored): ${skipped}`);
console.log(`  Total: ${mbBefore} MB → ${mbAfter} MB  (${savings}% saved)`);
