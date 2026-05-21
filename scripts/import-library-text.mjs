// import-library-text.mjs
// Imports the TEXT library category from CSV + image folder into library-text.json.
//
// Setup:
//   1. Place the CSV at: src/data/library-text.csv
//      (export your Google Sheet or save the C-S_LIBRARY_DATABASE_-_TEXT.csv there)
//   2. Place all cover images in: public/images/library/text/
//      (any extension: .jpg, .png, .webp, even no extension)
//   3. Run: node scripts/import-library-text.mjs
//
// What it does:
//   - Parses the messy CSV (skips empty header rows, leading empty columns)
//   - For each entry, finds the matching image using normalized title+year
//   - Outputs src/data/library-text.json with full entry data + image paths
//   - Reports any unmatched entries (with the exact image filename to look for)
//
// Safe to re-run. CSV is the source of truth.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CSV_PATH = resolve(ROOT, 'src/data/library-text.csv');
const JSON_PATH = resolve(ROOT, 'src/data/library-text.json');
const IMG_DIR = resolve(ROOT, 'public/images/library/text');
const IMG_URL_BASE = '/images/library/text';

if (!existsSync(CSV_PATH)) {
  console.error(`Missing CSV: ${CSV_PATH}`);
  console.error(`Save your library text CSV at that path and re-run.`);
  process.exit(1);
}
if (!existsSync(IMG_DIR)) {
  console.error(`Missing image folder: ${IMG_DIR}`);
  console.error(`Create the folder and move all cover images into it.`);
  process.exit(1);
}

// ─── CSV parser ───
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
  return rows;
}

// Normalize a string for matching: lowercase, alphanumerics only
function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ─── Find header row in the messy CSV ───
const rows = parseCSV(readFileSync(CSV_PATH, 'utf8'));
let headerIdx = -1;
let colMap = null;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  // Find row containing TITLE, NAME, YEAR columns
  const lower = r.map(c => String(c).trim().toLowerCase());
  if (lower.includes('title') && lower.includes('name') && lower.includes('year')) {
    headerIdx = i;
    colMap = {
      title:    lower.indexOf('title'),
      name:     lower.indexOf('name'),
      year:     lower.indexOf('year'),
      project:  lower.indexOf('project'),
      added:    lower.indexOf('added'),
      by:       lower.indexOf('by'),
      filename: lower.indexOf('file name'),
      notes:    lower.indexOf('notes')
    };
    break;
  }
}
if (headerIdx === -1) {
  console.error(`Couldn't find header row in CSV. Expecting columns: TITLE, NAME, YEAR, FILE NAME...`);
  process.exit(1);
}
console.log(`Found header at row ${headerIdx + 1} of CSV.`);

// ─── Parse entries ───
const entries = [];
for (let i = headerIdx + 1; i < rows.length; i++) {
  const r = rows[i];
  const title = (r[colMap.title] || '').trim();
  if (!title) continue; // skip empty rows

  const name = (r[colMap.name] || '').trim().replace(/\s*\n+\s*/g, ' ');
  const year = (r[colMap.year] || '').trim();
  const filename = (r[colMap.filename] || '').trim();
  const project = colMap.project !== -1 ? (r[colMap.project] || '').trim() : '';
  const added = colMap.added !== -1 ? (r[colMap.added] || '').trim() : '';
  const by = colMap.by !== -1 ? (r[colMap.by] || '').trim() : '';
  const notes = colMap.notes !== -1 ? (r[colMap.notes] || '').trim() : '';

  entries.push({ title, name, year, filename, project, added, by, notes });
}
console.log(`Parsed ${entries.length} text entries from CSV.\n`);

// ─── Scan image folder ───
const imgFiles = readdirSync(IMG_DIR);
console.log(`Found ${imgFiles.length} files in image folder.\n`);

// Build normalized index for fast lookup
const imgIndex = imgFiles.map(f => ({
  filename: f,
  // Strip extension(s)
  stem: f.replace(/\.[^.]+$/, ''),
  normalized: normalize(f)
}));

// ─── Matching logic ───
function findImageForEntry(entry) {
  const tN = normalize(entry.title);
  const yN = entry.year ? String(entry.year).trim() : '';
  const fN = normalize(entry.filename);

  // Strategy 1: exact filename match (most reliable)
  if (fN) {
    const exact = imgIndex.find(img => normalize(img.stem) === fN);
    if (exact) return { img: exact, kind: 'filename-exact' };
  }

  // Strategy 2: filename column normalized appears in image stem (or vice versa)
  if (fN) {
    const match = imgIndex.find(img =>
      img.normalized.includes(fN) || fN.includes(img.normalized.replace(/(jpg|jpeg|png|webp|gif)$/, ''))
    );
    if (match) return { img: match, kind: 'filename-fuzzy' };
  }

  // Strategy 3: title + year appear in image filename
  if (tN && yN) {
    const match = imgIndex.find(img =>
      img.normalized.includes(tN) && img.normalized.includes(yN)
    );
    if (match) return { img: match, kind: 'title+year' };
  }

  // Strategy 4: just title (use cautiously, may have false positives)
  if (tN.length >= 6) {
    const matches = imgIndex.filter(img => img.normalized.includes(tN));
    if (matches.length === 1) return { img: matches[0], kind: 'title-only' };
  }

  return null;
}

// ─── Match all entries ───
const matched = [];
const unmatched = [];
const usedImages = new Set();

for (const entry of entries) {
  const result = findImageForEntry(entry);
  if (result) {
    matched.push({
      ...entry,
      image: `${IMG_URL_BASE}/${result.img.filename}`,
      matchKind: result.kind
    });
    usedImages.add(result.img.filename);
  } else {
    unmatched.push(entry);
  }
}

// ─── Report ───
console.log('─── Match Report ───');
console.log(`✓ Matched: ${matched.length}`);
console.log(`✗ Unmatched: ${unmatched.length}`);
const unusedImages = imgFiles.filter(f => !usedImages.has(f));
console.log(`Images not matched to any entry: ${unusedImages.length}\n`);

// Match kind breakdown
const kinds = {};
for (const m of matched) kinds[m.matchKind] = (kinds[m.matchKind] || 0) + 1;
for (const [k, v] of Object.entries(kinds)) console.log(`  ${k}: ${v}`);

if (unmatched.length) {
  console.log('\nEntries with NO image match:');
  for (const u of unmatched) {
    console.log(`  • ${u.title} (${u.year}) — ${u.name}`);
    if (u.filename) console.log(`    expected: ${u.filename}`);
  }
}

if (unusedImages.length) {
  console.log('\nImages with no matching CSV entry:');
  for (const f of unusedImages.slice(0, 20)) console.log(`  ${f}`);
  if (unusedImages.length > 20) console.log(`  ... and ${unusedImages.length - 20} more`);
}

// ─── Write JSON ───
const output = matched.map(m => ({
  title: m.title,
  author: m.name,
  year: m.year,
  image: m.image,
  project: m.project || undefined,
  added: m.added || undefined,
  by: m.by || undefined,
  notes: m.notes || undefined,
  category: 'text'
}));

writeFileSync(JSON_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(`\n✓ Wrote ${output.length} entries to ${JSON_PATH}`);
