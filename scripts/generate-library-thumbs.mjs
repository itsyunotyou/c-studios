// generate-library-thumbs.mjs
// Generates small WebP thumbnails for every library image.
// For each image at public/images/library/{category}/cover.jpg,
// creates: cover-thumb.webp (300w, quality 75)
//
// The cylinder uses thumbnails for fast rendering; originals stay for zoom views.
//
// Usage:
//   node scripts/generate-library-thumbs.mjs
//
// Safe to re-run — skips already-generated thumbnails.
// Requires: sharp (already installed for project images)

import { readdirSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, extname, basename } from 'path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LIB_ROOT = resolve(ROOT, 'public/images/library');

const THUMB_WIDTH = 300;
const THUMB_QUALITY = 75;

if (!existsSync(LIB_ROOT)) {
  console.error(`Missing ${LIB_ROOT}`);
  process.exit(1);
}

const categories = readdirSync(LIB_ROOT)
  .map(name => ({ name, path: join(LIB_ROOT, name) }))
  .filter(d => existsSync(d.path) && statSync(d.path).isDirectory());

console.log(`Found ${categories.length} categories: ${categories.map(c => c.name).join(', ')}\n`);

let totalGenerated = 0, totalSkipped = 0, totalFailed = 0;
const startTime = Date.now();

for (const cat of categories) {
  const files = readdirSync(cat.path)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f) || !/\./.test(f))   // also include extension-less
    .filter(f => !/-thumb\.webp$/i.test(f));  // exclude existing thumbs

  if (!files.length) continue;
  console.log(`→ ${cat.name} (${files.length} images)`);

  for (const file of files) {
    const srcPath = join(cat.path, file);
    const stem = basename(file, extname(file)) || file;
    const thumbPath = join(cat.path, `${stem}-thumb.webp`);

    if (existsSync(thumbPath) && statSync(thumbPath).size > 0) {
      totalSkipped++;
      continue;
    }

    try {
      await sharp(srcPath)
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: THUMB_QUALITY })
        .toFile(thumbPath);
      totalGenerated++;
    } catch (e) {
      console.log(`    ✗ ${file} — ${e.message}`);
      totalFailed++;
    }
  }
  console.log(`  ✓ ${cat.name} done`);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n─── Summary ───`);
console.log(`Generated: ${totalGenerated}`);
console.log(`Skipped:   ${totalSkipped}`);
console.log(`Failed:    ${totalFailed}`);
console.log(`Time:      ${elapsed}s`);
console.log(`\nNext: update library.astro to use *-thumb.webp paths for the cylinder.`);
