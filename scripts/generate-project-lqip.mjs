// Generate Low-Quality Image Placeholders (LQIP) for every project image.
//
// Output: src/data/project-lqip.json — a map of image-path → {src, ratio}.
// The Astro template inlines `src` as a CSS background on each image's
// wrapper div, so users see a 20px-wide blurred preview immediately;
// the real image fades in on `load`. `ratio` is the original aspect
// ratio (so the wrapper can reserve space before the image arrives).
//
// Run: node scripts/generate-project-lqip.mjs
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const projects = JSON.parse(
  fs.readFileSync(path.join(REPO, 'src/data/projects.json'), 'utf-8')
);

const lqip = {};
let processed = 0;
let skipped = 0;

for (const tab of projects) {
  if (!tab.projects) continue;
  for (const project of tab.projects) {
    if (!project.images) continue;
    for (const img of project.images) {
      // Each entry in projects.json is a base path like /images/.../01.webp;
      // we actually serve variants like 01-640w.webp. Read the smallest
      // variant for fastest processing.
      const stem = img.replace(/\.[^.]+$/, '');
      const candidates = [
        `public${stem}-640w.webp`,
        `public${stem}-828w.webp`,
        `public${stem}.webp`,
        `public${img}`,
      ];
      const src = candidates.map(p => path.join(REPO, p)).find(p => fs.existsSync(p));
      if (!src) {
        console.warn(`skip (no source found): ${img}`);
        skipped++;
        continue;
      }
      const meta = await sharp(src).metadata();
      const ratio = +(meta.width / meta.height).toFixed(4);
      const buffer = await sharp(src)
        .resize(20, null, { fit: 'inside' })
        .webp({ quality: 35 })
        .toBuffer();
      lqip[img] = {
        src: `data:image/webp;base64,${buffer.toString('base64')}`,
        ratio,
      };
      processed++;
    }
  }
}

const out = path.join(REPO, 'src/data/project-lqip.json');
fs.writeFileSync(out, JSON.stringify(lqip));
const sizeKB = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`Generated ${processed} LQIPs (${sizeKB} KB), skipped ${skipped}`);
console.log(`→ ${out}`);
