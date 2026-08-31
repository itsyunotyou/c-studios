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

// A brand-new entry's `image` field is stored extension-less (see
// worker/publish-library.js) until this script resolves it against a real
// staged file. `basename(x, extname(x))` assumes whatever follows the last
// "." is a real extension, which mis-parses titles that legitimately
// contain periods with no extension at all (e.g. "...C.P.Company_2021_JY"
// reads as ext ".Company_2021_JY"). Only strip a suffix that's actually a
// known image extension.
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|svg|tiff?)$/i;
function baseOf(imagePath) {
  const b = basename(imagePath);
  return b.replace(IMAGE_EXT_RE, '');
}

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
  let orphanedCleaned = 0;

  const outDir = join(IMAGES_ROOT, category);
  const incomingDir = join(INCOMING_ROOT, category);

  // Multiple catalog entries can legitimately share one cover file (the
  // same image reused across a few rows) — group by basename so a shared
  // _incoming/ raw source only gets deleted once every entry that needs it
  // this run has actually been processed against it. Deleting it after
  // just the first one to finish used to permanently strand the rest:
  // their `color` would never get computed since the source was already
  // gone, so every future publish kept re-flagging and re-staging the same
  // file for nothing.
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.image) { skippedNoFile++; continue; }
    const base = baseOf(entry.image);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(entry);
  }

  for (const [base, group] of groups) {
    const thumbPath = join(outDir, `${base}-thumb.webp`);
    const largePath = join(outDir, `${base}-large.webp`);
    let srcPath = null;
    let fromIncoming = false;

    for (const entry of group) {
      const needsThumb = !existsSync(thumbPath);
      const needsLarge = !existsSync(largePath);
      const needsColor = !entry.color;
      if (!needsColor) colorAlreadyPresent++;
      if (!needsThumb) thumbAlreadyPresent++;
      if (!needsLarge) largeAlreadyPresent++;
      if (!needsColor && !needsThumb && !needsLarge) continue;

      // Find a raw source: canonical public/ path first (the rare manually
      // -added case), else a staged upload waiting in _incoming/. Resolved
      // per entry (not hoisted above the loop) since the canonical path is
      // entry-specific even when the basename is shared.
      if (!srcPath) {
        srcPath = resolve('public' + entry.image);
        if (!existsSync(srcPath)) {
          srcPath = findByBase(incomingDir, base);
          fromIncoming = !!srcPath;
        }
      }
      if (!srcPath || !existsSync(srcPath)) {
        skippedNoFile++;
        continue;
      }

      // 1) Dominant color
      if (needsColor) {
        try {
          // .rotate() with no args auto-orients from the source's EXIF
          // Orientation tag (and strips it) — scanned covers routinely carry
          // one (a flatbed scan fed in sideways, say), and without this the
          // dominant color, thumb, and large all silently come out rotated
          // to match the raw sensor data instead of how the image actually
          // looks.
          const { dominant } = await sharp(srcPath).rotate().stats();
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
            .rotate()
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
            .rotate()
            .resize(LARGE_WIDTH, null, { withoutEnlargement: true })
            .webp({ quality: LARGE_QUALITY })
            .toFile(largePath);
          largedCount++;
        } catch (e) {
          console.warn(`  large fail ${entry.image}: ${e.message}`);
        }
      }
    }

    // Raw staged uploads are transient — once every entry sharing this
    // basename has had its turn, discard it. The loop above only sets
    // srcPath when it actually needed to do work this run; a basename whose
    // thumb/large were already fully done (e.g. processed in an earlier
    // run) never sets it, so re-check _incoming/ directly here — otherwise
    // an already-processed source just sits there forever, un-cleaned.
    if (!srcPath) {
      const leftover = findByBase(incomingDir, base);
      if (leftover) {
        srcPath = leftover;
        fromIncoming = true;
      }
    }
    if (fromIncoming && existsSync(srcPath) && existsSync(thumbPath) && existsSync(largePath)) {
      unlinkSync(srcPath);
      orphanedCleaned++;
    }
  }

  writeFileSync(jsonPath, JSON.stringify(entries, null, 2) + '\n');
  console.log(
    `${category.padEnd(6)} colors +${coloredCount} (${colorAlreadyPresent} already) · ` +
    `thumbs +${thumbedCount} (${thumbAlreadyPresent} already) · ` +
    `large +${largedCount} (${largeAlreadyPresent} already) · ${skippedNoFile} no file on disk · ` +
    `${orphanedCleaned} orphaned _incoming/ source(s) cleaned up`
  );
}

console.log('Processing library images...\n');
for (const cat of CATEGORIES) {
  await processCategory(cat);
}
console.log('\nDone.');
