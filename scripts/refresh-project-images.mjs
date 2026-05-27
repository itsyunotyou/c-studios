// refresh-project-images.mjs
// Re-scans each slug folder under public/images/projects and updates the
// `images` array on the matching entry in src/data/projects.json. Keeps the
// existing project list/order/metadata untouched — only the image URLs are
// regenerated from what's actually on disk.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const IMG_ROOT = resolve(ROOT, 'public/images/projects');
const JSON_PATH = resolve(ROOT, 'src/data/projects.json');
const IMG_URL_BASE = '/images/projects';

const data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

function readSources(slug) {
  const dir = join(IMG_ROOT, slug);
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir);

  // Prefer actual source files when present.
  const sources = all
    .filter(f => /\.(webp|jpg|jpeg|png|gif|tif|tiff)$/i.test(f))
    .filter(f => !/-\d+w\.webp$/i.test(f))
    .sort();
  if (sources.length) {
    return sources.map(f => `${IMG_URL_BASE}/${slug}/${f}`);
  }

  // Fallback: derive image names from existing variants when sources have
  // been stripped from the bundle (the page only fetches the -<w>w.webp
  // variants, so sources are optional at runtime). Each variant like
  // 01-1280w.webp implies a base "01" image.
  const stems = new Set();
  for (const f of all) {
    const m = f.match(/^(.+?)-\d+w\.webp$/i);
    if (m) stems.add(m[1]);
  }
  return Array.from(stems)
    .sort()
    .map(stem => `${IMG_URL_BASE}/${slug}/${stem}.webp`);
}

let updated = 0, unchanged = 0;
for (const cat of data) {
  for (const p of cat.projects) {
    const fresh = readSources(p.slug);
    const same = fresh.length === p.images.length &&
                 fresh.every((u, i) => u === p.images[i]);
    if (!same) {
      console.log(`✓ ${p.slug.padEnd(50)} ${p.images.length} → ${fresh.length}`);
      p.images = fresh;
      updated++;
    } else {
      unchanged++;
    }
  }
}

writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
console.log(`\nUpdated ${updated} entries, ${unchanged} unchanged.`);
