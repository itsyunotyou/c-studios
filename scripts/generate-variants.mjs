// generate-variants.mjs
// Generates responsive WebP variants for all project images.
// For each base image at public/images/projects/[slug]/01.png (or .jpg/.webp),
// creates: 01-640w.webp, 01-828w.webp, 01-1280w.webp, 01-2560w.webp
//
// Usage:
//   node scripts/generate-variants.mjs
//
// Safe to re-run — skips variants that already exist.
// Requires: npm install sharp --save-dev

import { readdirSync, existsSync, statSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, extname, basename } from 'path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const IMG_ROOT = resolve(ROOT, 'public/images/projects');

const WIDTHS = [640, 828, 1280, 2560];
const QUALITY = 80;

if (!existsSync(IMG_ROOT)) {
  console.error(`Missing ${IMG_ROOT}`);
  process.exit(1);
}

// Find all project slug folders
const slugFolders = readdirSync(IMG_ROOT)
  .map(name => ({ name, path: join(IMG_ROOT, name) }))
  .filter(f => existsSync(f.path) && statSync(f.path).isDirectory());

console.log(`Found ${slugFolders.length} project folders.\n`);

let totalSource = 0, totalGenerated = 0, totalSkipped = 0, totalFailed = 0;
const startTime = Date.now();

for (const folder of slugFolders) {
  // Find all source images (excluding existing variants)
  const files = readdirSync(folder.path)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .filter(f => !/-(\d+)w\.webp$/.test(f)); // exclude variants

  if (!files.length) continue;

  console.log(`→ ${folder.name} (${files.length} source images)`);
  totalSource += files.length;

  for (const file of files) {
    const srcPath = join(folder.path, file);
    const stem = basename(file, extname(file));

    // Get original image dimensions
    let metadata;
    try {
      metadata = await sharp(srcPath).metadata();
    } catch (e) {
      console.log(`    ✗ ${file} — couldn't read metadata: ${e.message}`);
      totalFailed++;
      continue;
    }

    const originalWidth = metadata.width || 0;

    for (const width of WIDTHS) {
      const variantName = `${stem}-${width}w.webp`;
      const variantPath = join(folder.path, variantName);

      // Skip if variant exists
      if (existsSync(variantPath) && statSync(variantPath).size > 0) {
        totalSkipped++;
        continue;
      }

      // Skip variants larger than the original (no upscaling)
      const targetWidth = Math.min(width, originalWidth);

      try {
        await sharp(srcPath)
          .resize({ width: targetWidth, withoutEnlargement: true })
          .webp({ quality: QUALITY })
          .toFile(variantPath);
        totalGenerated++;
      } catch (e) {
        console.log(`    ✗ ${variantName} — ${e.message}`);
        totalFailed++;
      }
    }
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

console.log('\n─── Summary ───');
console.log(`Source images:     ${totalSource}`);
console.log(`Variants generated: ${totalGenerated}`);
console.log(`Skipped (exists):   ${totalSkipped}`);
console.log(`Failed:             ${totalFailed}`);
console.log(`Time:               ${elapsed}s`);
console.log(`\nNext: run \`npm run sync-projects\` to refresh projects.json.`);
