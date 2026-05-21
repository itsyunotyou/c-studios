// csv-to-projects.mjs
// Reads projects.csv and writes projects.json, auto-detecting images from
// per-project folders in public/images/projects/[slug]/
//
// CSV columns (header row required):
//   tab, title, year, description, slug (optional — auto-generated from title if omitted)
//
// Image discovery:
//   For each project, this script scans public/images/projects/[slug]/ and lists
//   all image files (.webp, .jpg, .jpeg, .png), sorted alphabetically. So name
//   them 01.webp, 02.webp, 03.webp, etc. and they'll appear in order.
//
// Usage (from project root):
//   node scripts/csv-to-projects.mjs
//
// Or via npm script:
//   npm run sync-projects

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const CSV_PATH  = resolve(ROOT, 'src/data/projects.csv');
const JSON_PATH = resolve(ROOT, 'src/data/projects.json');
const IMG_ROOT  = resolve(ROOT, 'public/images/projects');
const IMG_URL_BASE = '/images/projects';

if (!existsSync(CSV_PATH)) {
  console.error(`Missing ${CSV_PATH}`);
  process.exit(1);
}

// Tab order + display names
const TAB_DEFS = [
  { slug: 'creative-strategy',  name: 'Creative Strategy' },
  { slug: 'consulting',         name: 'Consulting' },
  { slug: 'curation',           name: 'Curation' },
  { slug: 'creative-direction', name: 'Creative Direction' },
  { slug: 'cultural-research',  name: 'Cultural Research' }
];

// Minimal RFC-4180 CSV parser
function parseCSV(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && r.some(c => c.trim()));
}

// Slugify a title for use as a folder name
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[|&,()'":]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

// List all image files in a project folder, sorted alphabetically
function readImagesForSlug(slug) {
  const dir = join(IMG_ROOT, slug);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => /\.(webp|jpg|jpeg|png|gif)$/i.test(f))
      .filter(f => !/-\d+w\.webp$/i.test(f))   // exclude responsive variants
      .sort()
      .map(f => `${IMG_URL_BASE}/${slug}/${f}`);
  } catch (e) {
    console.warn(`⚠ Couldn't read ${dir}: ${e.message}`);
    return [];
  }
}

// ─── Parse CSV ───
const csvText = readFileSync(CSV_PATH, 'utf8');
const rows = parseCSV(csvText);
if (!rows.length) { console.error('CSV is empty'); process.exit(1); }

const header = rows.shift().map(h => h.trim().toLowerCase());
const colIdx = (name) => header.indexOf(name);
const REQUIRED = ['tab', 'title', 'year', 'description'];
for (const col of REQUIRED) {
  if (colIdx(col) === -1) {
    console.error(`CSV is missing required column: ${col}`);
    process.exit(1);
  }
}
const slugColIdx   = colIdx('slug');    // optional
const imagesColIdx = colIdx('images');  // optional — legacy support

// ─── Build projects, grouped by tab ───
const byTab = new Map(TAB_DEFS.map(t => [t.slug, []]));
let skipped = 0, totalImages = 0;

for (const row of rows) {
  const tabSlug = row[colIdx('tab')].trim();
  if (!byTab.has(tabSlug)) {
    console.warn(`⚠ Unknown tab "${tabSlug}" — skipping row: ${row[colIdx('title')]}`);
    skipped++;
    continue;
  }

  const title = row[colIdx('title')].trim();
  const slug = (slugColIdx !== -1 && row[slugColIdx]?.trim())
    ? row[slugColIdx].trim()
    : slugify(title);

  // Images: prefer folder-based discovery; fall back to legacy CSV column if folder is empty
  let images = readImagesForSlug(slug);
  if (!images.length && imagesColIdx !== -1) {
    const legacy = row[imagesColIdx].split('|').map(s => s.trim()).filter(Boolean);
    images = legacy.map(name =>
      name.includes('.') ? `${IMG_URL_BASE}/${name}` : `${IMG_URL_BASE}/${name}.webp`
    );
  }
  totalImages += images.length;

  byTab.get(tabSlug).push({
    title,
    year:        row[colIdx('year')].trim(),
    description: row[colIdx('description')].trim(),
    slug,
    images
  });
}

// ─── Build final structure ───
const out = TAB_DEFS.map(t => ({
  name: t.name,
  slug: t.slug,
  projects: byTab.get(t.slug)
}));

writeFileSync(JSON_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

// ─── Report ───
const totalProjects = out.reduce((s, t) => s + t.projects.length, 0);
console.log(`\n✓ Wrote ${JSON_PATH}`);
console.log(`  ${out.length} tabs · ${totalProjects} projects · ${totalImages} images`);
if (skipped) console.log(`  ${skipped} rows skipped (bad tab slug)`);
for (const t of out) {
  const withImgs = t.projects.filter(p => p.images.length).length;
  console.log(`    ${t.name}: ${t.projects.length} projects (${withImgs} with images)`);
}

const missingImages = out.flatMap(t => t.projects.filter(p => !p.images.length).map(p => ({tab: t.name, ...p})));
if (missingImages.length) {
  console.log(`\n  Projects without images yet (${missingImages.length}):`);
  for (const p of missingImages) {
    console.log(`    [${p.tab}] ${p.title}`);
    console.log(`        → drop images into: public/images/projects/${p.slug}/`);
  }
}
