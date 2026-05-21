// scripts/csv-to-json.mjs
// Converts the C-STUDIOS library CSV into references.json
//
// Usage: npm run csv-to-json -- <path-to-csv>
// Example: npm run csv-to-json -- ./C-S_LIBRARY_DATABASE_-_TEXT.csv

import { parse } from 'csv-parse/sync';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: npm run csv-to-json -- <path-to-csv>');
  process.exit(1);
}

// Category for this CSV — change per import.
// Options: Image, Sound, Film, Text
const CATEGORY = process.env.CATEGORY || 'Text';

const csvText = readFileSync(resolve(csvPath), 'utf-8');
const records = parse(csvText, {
  relax_column_count: true,
  skip_empty_lines: true,
});

const refs = [];
const seenTitles = new Set();

for (const row of records) {
  // Pad short rows
  while (row.length < 12) row.push('');
  
  const title = (row[3] || '').trim();
  const artist = ((row[4] || '').replace(/\s+/g, ' ')).trim();
  const yearRaw = (row[5] || '').trim();
  const addedBy = (row[9] || '').trim();
  const filename = (row[10] || '').trim();
  
  // Skip junk
  if (!title) continue;
  const upper = title.toUpperCase();
  if (upper === 'TITLE' || upper === 'ASSET') continue;
  if (upper.includes('FILE NAMING')) continue;
  if (upper.includes('NOTE:')) continue;
  if (upper.includes('C-STUDIOS')) continue;
  
  // Skip duplicates
  if (seenTitles.has(title)) continue;
  seenTitles.add(title);
  
  // Normalize year
  let year = yearRaw;
  const num = parseFloat(yearRaw);
  if (!isNaN(num) && /^[\d.]+$/.test(yearRaw)) year = String(Math.floor(num));
  
  refs.push({
    title,
    artist,
    year,
    cat: CATEGORY,
    addedBy,
    filename,
    color: null,
    img: null,
    imgFull: null,
  });
}

const outPath = resolve('src/data/references.json');
// Merge with existing data
let existing = [];
try {
  existing = JSON.parse(readFileSync(outPath, 'utf-8'));
} catch (e) {
  // no existing file
}

const existingTitles = new Set(existing.map(r => r.title));
const newRefs = refs.filter(r => !existingTitles.has(r.title));

const merged = [...existing, ...newRefs];

writeFileSync(outPath, JSON.stringify(merged, null, 2));
console.log(`✓ Added ${newRefs.length} new ${CATEGORY} references (skipped ${refs.length - newRefs.length} duplicates)`);
console.log(`✓ Total references: ${merged.length}`);
console.log(`✓ Written to: ${outPath}`);
