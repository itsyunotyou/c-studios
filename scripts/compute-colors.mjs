// scripts/compute-colors.mjs
// Computes average RGB color for each reference's image.
// Reads from public/images/references/, writes back to src/data/references.json.
//
// Usage: npm run compute-colors

import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const refsPath = resolve('src/data/references.json');
const imagesDir = resolve('public/images/references');

const refs = JSON.parse(readFileSync(refsPath, 'utf-8'));

console.log(`Processing ${refs.length} references...`);

let computed = 0;
let missing = 0;

// Normalize filename: lowercase, strip non-alphanumeric (WP-style sanitization)
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9_]/g, '');

// Try common extensions
const extensions = ['.jpg', '.jpeg', '.png', '.webp'];

// Build a lookup of normalized filename → actual path
const { readdirSync } = await import('fs');
let fileList = [];
try {
  fileList = readdirSync(imagesDir);
} catch (e) {
  console.error(`No images directory found at: ${imagesDir}`);
  console.error('Create it and add your image files before running this.');
  process.exit(1);
}

const fileLookup = new Map();
for (const f of fileList) {
  const base = f.replace(/\.[^.]+$/, '');
  fileLookup.set(normalize(base), f);
}

for (const ref of refs) {
  if (!ref.filename) {
    missing++;
    continue;
  }
  
  const key = normalize(ref.filename);
  const actualFile = fileLookup.get(key);
  
  if (!actualFile) {
    console.warn(`  ✗ no image found for: ${ref.title} (looking for ${ref.filename})`);
    missing++;
    continue;
  }
  
  const imgPath = join(imagesDir, actualFile);
  
  try {
    // Compute average RGB via sharp's stats
    const { dominant } = await sharp(imgPath).stats();
    ref.color = [dominant.r, dominant.g, dominant.b];
    ref.img = `/images/references/${actualFile}`;
    ref.imgFull = `/images/references/${actualFile}`;
    computed++;
  } catch (e) {
    console.warn(`  ✗ failed to process ${actualFile}: ${e.message}`);
    missing++;
  }
}

writeFileSync(refsPath, JSON.stringify(refs, null, 2));

console.log(`\n✓ Computed colors for ${computed} references`);
if (missing > 0) console.log(`✗ Missing/failed: ${missing}`);
console.log(`✓ Saved to: ${refsPath}`);
