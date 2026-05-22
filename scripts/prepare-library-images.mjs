// scripts/prepare-library-images.mjs
//
// For every entry across library-{text,image,sound,film}.json whose
// `image` field points to a file on disk:
//   1. Compute dominant RGB and write it back as entry.color
//   2. Generate a 300w -thumb.webp next to it (if not already present)
//
// Entries with extension-less image paths (files not yet uploaded) are
// skipped — they keep their default grey placeholder at render time.
//
// Usage: node scripts/prepare-library-images.mjs

import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, join, basename, extname, dirname } from 'path';

const DATA_DIR = resolve('src/data');
const CATEGORIES = ['text', 'image', 'film', 'sound'];

const THUMB_WIDTH = 300;
const THUMB_QUALITY = 70;

async function processCategory(category) {
  const jsonPath = join(DATA_DIR, `library-${category}.json`);
  const entries = JSON.parse(readFileSync(jsonPath, 'utf-8'));

  let coloredCount = 0;
  let thumbedCount = 0;
  let skippedNoFile = 0;
  let thumbAlreadyPresent = 0;
  let colorAlreadyPresent = 0;

  for (const entry of entries) {
    if (!entry.image) { skippedNoFile++; continue; }

    const imgPath = resolve('public' + entry.image);
    if (!existsSync(imgPath)) { skippedNoFile++; continue; }

    // Skip if the path points at an already-generated thumb (shouldn't happen
    // but cheap to guard against).
    if (imgPath.endsWith('-thumb.webp')) continue;

    // 1) Dominant color
    if (!entry.color) {
      try {
        const { dominant } = await sharp(imgPath).stats();
        entry.color = [dominant.r, dominant.g, dominant.b];
        coloredCount++;
      } catch (e) {
        console.warn(`  color fail ${entry.image}: ${e.message}`);
      }
    } else {
      colorAlreadyPresent++;
    }

    // 2) Thumbnail
    const ext = extname(imgPath);
    const base = basename(imgPath, ext);
    const thumbPath = join(dirname(imgPath), `${base}-thumb.webp`);
    if (existsSync(thumbPath)) {
      thumbAlreadyPresent++;
    } else {
      try {
        await sharp(imgPath)
          .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
          .webp({ quality: THUMB_QUALITY })
          .toFile(thumbPath);
        thumbedCount++;
      } catch (e) {
        console.warn(`  thumb fail ${entry.image}: ${e.message}`);
      }
    }
  }

  writeFileSync(jsonPath, JSON.stringify(entries, null, 2) + '\n');
  console.log(
    `${category.padEnd(6)} colors +${coloredCount} (${colorAlreadyPresent} already) · ` +
    `thumbs +${thumbedCount} (${thumbAlreadyPresent} already) · ${skippedNoFile} no file on disk`
  );
}

console.log('Processing library images...\n');
for (const cat of CATEGORIES) {
  await processCategory(cat);
}
console.log('\nDone.');
