// import-library.mjs
// Generalized library category import. Takes category name as argument.
//
// Usage:
//   node scripts/import-library.mjs text
//   node scripts/import-library.mjs image
//   node scripts/import-library.mjs sound
//
// Or import all categories at once:
//   node scripts/import-library.mjs all
//
// For each category {cat}, expects:
//   - CSV at:          src/data/library-{cat}.csv
//   - Image folder at: public/images/library/{cat}/
//   - Outputs to:      src/data/library-{cat}.json
//
// CSV format (after any leading empty rows):
//   columns: ASSET, TITLE, NAME, YEAR, COPYRIGHT, PROJECT, ADDED, BY, FILE NAME, NOTES

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const VALID_CATEGORIES = ['text', 'image', 'sound'];
const arg = (process.argv[2] || '').toLowerCase();

if (!arg) {
  console.error(`Usage: node scripts/import-library.mjs <category>`);
  console.error(`Categories: ${VALID_CATEGORIES.join(', ')}, or 'all'`);
  process.exit(1);
}

const categories = arg === 'all' ? VALID_CATEGORIES : [arg];
for (const cat of categories) {
  if (!VALID_CATEGORIES.includes(cat)) {
    console.error(`Invalid category: ${cat}`);
    console.error(`Valid: ${VALID_CATEGORIES.join(', ')}`);
    process.exit(1);
  }
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

function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ─── Import a single category ───
function importCategory(category) {
  const CSV_PATH = resolve(ROOT, `src/data/library-${category}.csv`);
  const JSON_PATH = resolve(ROOT, `src/data/library-${category}.json`);
  const IMG_DIR = resolve(ROOT, `public/images/library/${category}`);
  const IMG_URL_BASE = `/images/library/${category}`;

  console.log(`\n════════════════════════════════════════════`);
  console.log(`Importing category: ${category.toUpperCase()}`);
  console.log(`════════════════════════════════════════════`);

  if (!existsSync(CSV_PATH)) {
    console.error(`✗ Missing CSV: ${CSV_PATH}`);
    console.error(`  Skipping ${category}.`);
    return;
  }
  if (!existsSync(IMG_DIR)) {
    console.error(`✗ Missing image folder: ${IMG_DIR}`);
    console.error(`  Skipping ${category}.`);
    return;
  }

  // Parse CSV
  const rows = parseCSV(readFileSync(CSV_PATH, 'utf8'));
  let headerIdx = -1;
  let colMap = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lower = r.map(c => String(c).trim().toLowerCase());
    if (lower.includes('title') && lower.includes('name') && lower.includes('year')) {
      headerIdx = i;
      colMap = {
        title: lower.indexOf('title'),
        name: lower.indexOf('name'),
        year: lower.indexOf('year'),
        project: lower.indexOf('project'),
        added: lower.indexOf('added'),
        by: lower.indexOf('by'),
        filename: lower.indexOf('file name'),
        notes: lower.indexOf('notes')
      };
      break;
    }
  }
  if (headerIdx === -1) {
    console.error(`✗ Couldn't find header row in CSV (expecting TITLE, NAME, YEAR columns).`);
    return;
  }
  console.log(`Header at CSV row ${headerIdx + 1}.`);

  // Parse entries
  const entries = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const title = (r[colMap.title] || '').trim();
    if (!title) continue;

    entries.push({
      title,
      name: (r[colMap.name] || '').trim().replace(/\s*\n+\s*/g, ' '),
      year: (r[colMap.year] || '').trim(),
      filename: (r[colMap.filename] || '').trim(),
      project: colMap.project !== -1 ? (r[colMap.project] || '').trim() : '',
      added: colMap.added !== -1 ? (r[colMap.added] || '').trim() : '',
      by: colMap.by !== -1 ? (r[colMap.by] || '').trim() : '',
      notes: colMap.notes !== -1 ? (r[colMap.notes] || '').trim() : ''
    });
  }
  console.log(`Parsed ${entries.length} entries from CSV.`);

  // Scan image folder
  const imgFiles = readdirSync(IMG_DIR);
  console.log(`Found ${imgFiles.length} files in image folder.`);

  const imgIndex = imgFiles.map(f => ({
    filename: f,
    stem: f.replace(/\.[^.]+$/, ''),
    normalized: normalize(f)
  }));

  // Match
  function findImage(entry) {
    const tN = normalize(entry.title);
    const yN = entry.year ? String(entry.year).trim() : '';
    const fN = normalize(entry.filename);

    if (fN) {
      const exact = imgIndex.find(img => normalize(img.stem) === fN);
      if (exact) return { img: exact, kind: 'filename-exact' };
    }
    if (fN) {
      const match = imgIndex.find(img =>
        img.normalized.includes(fN) || fN.includes(img.normalized.replace(/(jpg|jpeg|png|webp|gif)$/, ''))
      );
      if (match) return { img: match, kind: 'filename-fuzzy' };
    }
    if (tN && yN) {
      const match = imgIndex.find(img =>
        img.normalized.includes(tN) && img.normalized.includes(yN)
      );
      if (match) return { img: match, kind: 'title+year' };
    }
    if (tN.length >= 6) {
      const matches = imgIndex.filter(img => img.normalized.includes(tN));
      if (matches.length === 1) return { img: matches[0], kind: 'title-only' };
    }
    return null;
  }

  const matched = [];
  const unmatched = [];
  const usedImages = new Set();

  for (const entry of entries) {
    const result = findImage(entry);
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

  console.log(`\n✓ Matched: ${matched.length}`);
  console.log(`✗ Unmatched: ${unmatched.length}`);
  const unused = imgFiles.filter(f => !usedImages.has(f));
  console.log(`Images not matched: ${unused.length}`);

  const kinds = {};
  for (const m of matched) kinds[m.matchKind] = (kinds[m.matchKind] || 0) + 1;
  for (const [k, v] of Object.entries(kinds)) console.log(`  ${k}: ${v}`);

  if (unmatched.length && unmatched.length <= 30) {
    console.log(`\nUnmatched entries:`);
    for (const u of unmatched) {
      console.log(`  • ${u.title} (${u.year}) — ${u.name}`);
      if (u.filename) console.log(`    expected: ${u.filename}`);
    }
  } else if (unmatched.length > 30) {
    console.log(`\n(${unmatched.length} unmatched — too many to list, see JSON output)`);
  }

  if (unused.length && unused.length <= 15) {
    console.log(`\nImages not used:`);
    for (const f of unused) console.log(`  ${f}`);
  }

  // Write JSON
  const output = matched.map(m => ({
    title: m.title,
    author: m.name,
    year: m.year,
    image: m.image,
    project: m.project || undefined,
    added: m.added || undefined,
    by: m.by || undefined,
    notes: m.notes || undefined,
    category
  }));

  writeFileSync(JSON_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`\n✓ Wrote ${output.length} entries to ${JSON_PATH}`);
}

// Run
for (const cat of categories) {
  importCategory(cat);
}
console.log(`\nDone.`);
