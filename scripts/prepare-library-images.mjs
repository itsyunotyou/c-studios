// scripts/prepare-library-images.mjs
//
// For every entry across library-{text,image,sound}.json whose
// `image` field points to a file on disk (checked at its canonical path in
// public/images/library/<category>/, or as a fallback in _incoming/<category>/
// — where the publish pipeline stages a freshly-uploaded raw image under its
// expected basename before this script has had a chance to run):
//   1. Compute dominant RGB and write it back as entry.color
//   2. Generate a 300w -thumb.webp next to it (if not already present)
//   3. Generate an 800w -large.webp next to it (if not already present)
//
// Raw source images are never committed to the repo long-term — only the
// derived thumb/large webp files are. So once a staged _incoming/ source has
// been turned into both variants, it's deleted; entries whose raw source
// lives at the canonical public/ path (the rare manually-added case) are left
// alone.
//
// Entries with no raw source available anywhere are skipped — they keep
// their default grey placeholder at render time.
//
// Usage: node scripts/prepare-library-images.mjs

import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { resolve, join, basename, extname } from 'path';

const DATA_DIR = resolve('src/data');
const IMAGES_ROOT = resolve('public/images/library');
const INCOMING_ROOT = resolve('_incoming');
const CATEGORIES = ['text', 'image', 'sound'];

const THUMB_WIDTH = 300;
const THUMB_QUALITY = 70;
const LARGE_WIDTH = 800;
const LARGE_QUALITY = 80;

// Find a raw source file for `base` (the image field's filename, sans
// extension) in a directory, matching regardless of the actual extension —
// the sheet's FILE NAME column never includes one.
function findByBase(dir, base) {
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find(f => basename(f, extname(f)) === base);
  return match ? join(dir, match) : null;
}

async function processCategory(category) {
  const jsonPath = join(DATA_DIR, `library-${category}.json`);
  const entries = JSON.parse(readFileSync(jsonPath, 'utf-8'));

  let coloredCount = 0;
  let thumbedCount = 0;
  let largedCount = 0;
  let skippedNoFile = 0;
  let thumbAlreadyPresent = 0;
  let largeAlreadyPresent = 0;
  let colorAlreadyPresent = 0;

  const outDir = join(IMAGES_ROOT, category);
  const incomingDir = join(INCOMING_ROOT, category);

  for (const entry of entries) {
    if (!entry.image) { skippedNoFile++; continue; }

    const ext = extname(entry.image);
    const base = basename(entry.image, ext);
    const thumbPath = join(outDir, `${base}-thumb.webp`);
    const largePath = join(outDir, `${base}-large.webp`);
    const needsThumb = !existsSync(thumbPath);
    const needsLarge = !existsSync(largePath);

    // Tally what's already done before we even need a raw source.
    const needsColor = !entry.color;
    if (!needsColor) colorAlreadyPresent++;
    if (!needsThumb) thumbAlreadyPresent++;
    if (!needsLarge) largeAlreadyPresent++;
    if (!needsColor && !needsThumb && !needsLarge) continue;

    // Find a raw source: canonical public/ path first (the rare manually
    // -added case), else a staged upload waiting in _incoming/.
    let srcPath = resolve('public' + entry.image);
    let fromIncoming = false;
    if (!existsSync(srcPath)) {
      srcPath = findByBase(incomingDir, base);
      fromIncoming = !!srcPath;
    }
    if (!srcPath || !existsSync(srcPath)) {
      skippedNoFile++;
      continue;
    }

    // 1) Dominant color
    if (needsColor) {
      try {
        const { dominant } = await sharp(srcPath).stats();
        entry.color = [dominant.r, dominant.g, dominant.b];
        coloredCount++;
      } catch (e) {
        console.warn(`  color fail ${entry.image}: ${e.message}`);
      }
    }

    // 2) Thumbnail
    if (needsThumb) {
      try {
        await sharp(srcPath)
          .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
          .webp({ quality: THUMB_QUALITY })
          .toFile(thumbPath);
        thumbedCount++;
      } catch (e) {
        console.warn(`  thumb fail ${entry.image}: ${e.message}`);
      }
    }

    // 3) Large variant
    if (needsLarge) {
      try {
        await sharp(srcPath)
          .resize(LARGE_WIDTH, null, { withoutEnlargement: true })
          .webp({ quality: LARGE_QUALITY })
          .toFile(largePath);
        largedCount++;
      } catch (e) {
        console.warn(`  large fail ${entry.image}: ${e.message}`);
      }
    }

    // Raw staged uploads are transient — once both variants exist, discard it.
    if (fromIncoming && existsSync(thumbPath) && existsSync(largePath)) {
      unlinkSync(srcPath);
    }
  }

  writeFileSync(jsonPath, JSON.stringify(entries, null, 2) + '\n');
  console.log(
    `${category.padEnd(6)} colors +${coloredCount} (${colorAlreadyPresent} already) · ` +
    `thumbs +${thumbedCount} (${thumbAlreadyPresent} already) · ` +
    `large +${largedCount} (${largeAlreadyPresent} already) · ${skippedNoFile} no file on disk`
  );
}

console.log('Processing library images...\n');
for (const cat of CATEGORIES) {
  await processCategory(cat);
}
console.log('\nDone.');
