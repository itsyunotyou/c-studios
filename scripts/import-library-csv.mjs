// scripts/import-library-csv.mjs
// Merge new rows from /Users/u/Downloads/NEWLIBRARY/{TEXT,IMAGE,SOUND,FILM}.csv
// into src/data/library-{text,image,sound,film}.json.
//
// Dedupes against existing entries using normalized title|author|year
// (same key library.astro uses to dedupe at render time).
//
// Usage: node scripts/import-library-csv.mjs

import { parse } from 'csv-parse/sync';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const SRC_DIR = '/Users/u/Downloads/NEWLIBRARY';
const DATA_DIR = resolve('src/data');
const PUBLIC_DIR = resolve('public/images/library');

// Per-category column maps. Indices are 0-based into the CSV row array.
// Each CSV starts with junk rows; header is on row 9 (index 8) with the
// columns shown below. Data starts on row 10 (index 9).
const CATEGORIES = {
  text:  { headerRow: 8, cols: { title: 3, author: 4, year: 5, added: 8,  by: 9,  filename: 10, notes: 11 } },
  image: { headerRow: 8, cols: { title: 3, author: 4, year: 5, added: 6,  by: 7,  filename: 8,  notes: 9  } },
  film:  { headerRow: 8, cols: { title: 3, author: 4, year: 5, added: 7,  by: 8,  filename: 9,  notes: 10 } },
  sound: { headerRow: 8, cols: { title: 3, author: 4, year: 6, added: 8,  by: 9,  filename: 10, notes: 12 } },
};

const SRC_FILES = {
  text:  'TEXT.csv',
  image: 'IMAGE.csv',
  film:  'FILM.csv',
  sound: 'SOUND.csv',
};

const cleanCell = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Build a filename → actual path lookup per category by scanning the public dir.
function buildFileLookup(category) {
  const dir = join(PUBLIC_DIR, category);
  const lookup = new Map();
  if (!existsSync(dir)) return lookup;
  for (const f of readdirSync(dir)) {
    const base = f.replace(/\.[^.]+$/, '');
    // Index by the raw base and a normalized form for fuzzy matches
    lookup.set(base, f);
    lookup.set(norm(base), f);
  }
  return lookup;
}

function resolveImagePath(category, filenameRaw) {
  const lookup = buildFileLookup(category);
  const cleaned = cleanCell(filenameRaw).replace(/\s+/g, '');
  if (!cleaned) return '';
  if (lookup.has(cleaned)) return `/images/library/${category}/${lookup.get(cleaned)}`;
  if (lookup.has(norm(cleaned))) return `/images/library/${category}/${lookup.get(norm(cleaned))}`;
  // No file on disk — leave a best-guess path without extension; the page
  // already tolerates this case.
  return `/images/library/${category}/${cleaned}`;
}

function rowToEntry(row, category, cols) {
  const title  = cleanCell(row[cols.title]);
  if (!title) return null;
  const upper = title.toUpperCase();
  if (upper === 'TITLE' || upper === 'ASSET') return null;
  if (upper.includes('FILE NAMING')) return null;
  if (upper.includes('NOTE:')) return null;

  const author = cleanCell(row[cols.author]);
  const year   = cleanCell(row[cols.year]);
  const added  = cleanCell(row[cols.added]);
  const by     = cleanCell(row[cols.by]);
  const notes  = cleanCell(row[cols.notes]);
  const image  = resolveImagePath(category, row[cols.filename]);

  const entry = { title, author, year, image, added, by, category };
  if (notes) entry.notes = notes;
  return entry;
}

function importCategory(category) {
  const csvPath = join(SRC_DIR, SRC_FILES[category]);
  const jsonPath = join(DATA_DIR, `library-${category}.json`);
  const { cols, headerRow } = CATEGORIES[category];

  const csvText = readFileSync(csvPath, 'utf-8');
  const records = parse(csvText, { relax_column_count: true, skip_empty_lines: false });

  // Skip everything up to and including the header row.
  const dataRows = records.slice(headerRow + 1);

  const existing = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const existingByKey = new Map(
    existing.map((e) => [norm(e.title) + '|' + norm(e.author) + '|' + norm(e.year), e])
  );

  // Build the new list in CSV order. Preserve the existing JSON entry when
  // the key already exists (keeps any resolved image extensions intact).
  const synced = [];
  const seenKeys = new Set();
  let kept = 0;
  let added = 0;

  for (const row of dataRows) {
    const entry = rowToEntry(row, category, cols);
    if (!entry) continue;
    const key = norm(entry.title) + '|' + norm(entry.author) + '|' + norm(entry.year);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (existingByKey.has(key)) {
      // Refresh every field from the CSV, but keep the existing image path
      // when it has a real extension (the importer's best-guess fallback
      // produces an extension-less path).
      const prev = existingByKey.get(key);
      const prevHasExt = /\.[a-z0-9]+$/i.test(prev.image || '');
      const newHasExt  = /\.[a-z0-9]+$/i.test(entry.image || '');
      synced.push({ ...entry, image: (prevHasExt && !newHasExt) ? prev.image : entry.image });
      kept++;
    } else {
      synced.push(entry);
      added++;
    }
  }

  const removed = existing.length - kept;

  writeFileSync(jsonPath, JSON.stringify(synced, null, 2) + '\n');
  console.log(
    `${category.padEnd(6)} kept ${kept} · +${added} new · -${removed} removed → ${synced.length} total (was ${existing.length})`
  );
}

for (const cat of Object.keys(CATEGORIES)) {
  importCategory(cat);
}
