// json-to-csv.mjs
// ONE-TIME bootstrap: generates projects.csv from the existing projects.json.
// Run once after pulling the current state, then use projects.csv going forward.
//
// Usage:
//   node scripts/json-to-csv.mjs

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const JSON_PATH = resolve(ROOT, 'src/data/projects.json');
const CSV_PATH  = resolve(ROOT, 'src/data/projects.csv');

if (!existsSync(JSON_PATH)) {
  console.error(`Missing ${JSON_PATH}`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

// CSV field escaping: wrap in quotes if it has comma/quote/newline; double up internal quotes
function csvField(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const lines = ['tab,title,year,description,slug,images'];
let total = 0;

for (const tab of data) {
  for (const project of tab.projects) {
    const slug = project.slug || '';
    // If images are full URL paths (from folder-based), leave empty so future builds auto-detect.
    // If images are legacy basenames, preserve them.
    const imagesStr = (project.images || [])
      .map(img => {
        // Extract just the filename from a full path if needed
        if (typeof img !== 'string') return '';
        if (img.startsWith('/images/')) {
          // Auto-detected from folder — leave empty so build re-detects
          return '';
        }
        return img;
      })
      .filter(Boolean)
      .join('|');

    lines.push([
      csvField(tab.slug),
      csvField(project.title),
      csvField(project.year),
      csvField(project.description),
      csvField(slug),
      csvField(imagesStr)
    ].join(','));
    total++;
  }
}

writeFileSync(CSV_PATH, lines.join('\n') + '\n', 'utf8');
console.log(`✓ Wrote ${CSV_PATH}`);
console.log(`  ${total} projects exported`);
console.log(`\n  Now you can edit projects.csv freely, then run:`);
console.log(`    npm run sync-projects`);
console.log(`  to regenerate projects.json from your edits.`);
