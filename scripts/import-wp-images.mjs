// import-wp-images.mjs
// Reads a WordPress XML export, finds all project (elemenfolio) entries with their
// image URLs, matches them to your projects.csv, and downloads images into
// public/images/projects/[slug]/01.jpg, 02.jpg, etc.
//
// Usage:
//   1. Place the WordPress export XML at: c-studios_WordPress_2026-05-13.xml in project root
//      (or pass a different path as the first arg)
//   2. Run: node scripts/import-wp-images.mjs
//
// What it does:
//   - Parses WP XML, extracts elemenfolio entries (projects)
//   - Matches each project to your CSV using fuzzy title matching
//   - Downloads all images for each project into the matching slug folder
//   - Reports: matched, unmatched, missing images
//
// Run twice safely: skips images that already exist locally.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, extname } from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CSV_PATH = resolve(ROOT, 'src/data/projects.csv');
const IMG_ROOT = resolve(ROOT, 'public/images/projects');
const XML_PATH = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(ROOT, 'c-studios_WordPress_2026-05-13.xml');

if (!existsSync(XML_PATH)) {
  console.error(`Missing XML file at: ${XML_PATH}`);
  console.error(`Place your WordPress export XML in the project root, or pass a path:`);
  console.error(`  node scripts/import-wp-images.mjs /path/to/export.xml`);
  process.exit(1);
}
if (!existsSync(CSV_PATH)) {
  console.error(`Missing ${CSV_PATH}. Run: node scripts/json-to-csv.mjs first.`);
  process.exit(1);
}

// ─── HTML entity decode ───
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8230;/g, '…')
    .replace(/&#x2019;/g, "'");
}

// ─── CSV parsing ───
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

// ─── Normalize a title for fuzzy matching ───
function normTitle(s) {
  return decodeEntities(s)
    .toLowerCase()
    .replace(/[│|]/g, '')                  // remove pipe-style separators
    .replace(/[^a-z0-9]+/g, ' ')           // non-alphanum → space
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Parse XML for project entries ───
function parseWordpressXML(xmlText) {
  const items = xmlText.split(/<item>/).slice(1);
  const projects = [];

  for (const item of items) {
    if (!item.includes('elemenfolio')) continue;

    const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || '';
    const slug = item.match(/<wp:post_name><!\[CDATA\[(.*?)\]\]><\/wp:post_name>/)?.[1] || '';
    const status = item.match(/<wp:status><!\[CDATA\[(.*?)\]\]><\/wp:status>/)?.[1] || '';
    const category = item.match(/<category domain="elemenfoliocategory" nicename="(.*?)">/)?.[1] || '';
    const content = item.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/)?.[1] || '';

    // Extract image URLs from <img src="...">
    const imageUrls = [...content.matchAll(/src="(https:\/\/c-studios\.co\.uk\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp|gif))"/gi)]
      .map(m => m[1])
      .filter((url, i, arr) => arr.indexOf(url) === i); // dedupe

    projects.push({
      title: decodeEntities(title),
      slug,
      status,
      category,
      imageUrls
    });
  }
  return projects;
}

// ─── Download a single file ───
async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(res.body, createWriteStream(destPath));
}

// ─── Main ───
console.log(`Reading XML: ${XML_PATH}`);
const xmlText = readFileSync(XML_PATH, 'utf8');
const wpProjects = parseWordpressXML(xmlText);
console.log(`Found ${wpProjects.length} WordPress projects (${wpProjects.filter(p => p.imageUrls.length).length} with images).\n`);

console.log(`Reading CSV: ${CSV_PATH}`);
const csvRows = parseCSV(readFileSync(CSV_PATH, 'utf8'));
const header = csvRows.shift().map(h => h.trim().toLowerCase());
const colIdx = name => header.indexOf(name);
const csvProjects = csvRows.map(r => ({
  tab: r[colIdx('tab')]?.trim() || '',
  title: r[colIdx('title')]?.trim() || '',
  slug: (colIdx('slug') !== -1 ? r[colIdx('slug')] : '')?.trim() || ''
}));
// Auto-derive slug if missing
const slugify = s => s.toLowerCase().replace(/[|&,()'":]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
for (const p of csvProjects) if (!p.slug) p.slug = slugify(p.title);

console.log(`Found ${csvProjects.length} CSV projects.\n`);

// ─── Match CSV → WP ───
function findMatch(csvProj, wpProjects) {
  const target = normTitle(csvProj.title);
  // Exact title match
  let m = wpProjects.find(w => normTitle(w.title) === target);
  if (m) return { wp: m, kind: 'exact-title' };
  // Slug match
  m = wpProjects.find(w => w.slug === csvProj.slug);
  if (m) return { wp: m, kind: 'slug' };
  // Contains match (target inside WP or vice versa)
  m = wpProjects.find(w => {
    const wt = normTitle(w.title);
    return wt.includes(target) || target.includes(wt);
  });
  if (m) return { wp: m, kind: 'contains' };
  return null;
}

const matches = [];
const unmatched = [];

for (const csvProj of csvProjects) {
  const result = findMatch(csvProj, wpProjects);
  if (result) {
    matches.push({ csv: csvProj, wp: result.wp, kind: result.kind });
  } else {
    unmatched.push(csvProj);
  }
}

console.log('─── Match Report ───');
console.log(`✓ Matched: ${matches.length}`);
console.log(`✗ Unmatched: ${unmatched.length}\n`);

if (unmatched.length) {
  console.log('CSV projects with no WP match:');
  for (const p of unmatched) console.log(`   [${p.tab}] ${p.title}`);
  console.log();
}

// ─── Download ───
let totalDownloaded = 0, totalSkipped = 0, totalFailed = 0;
const projectsWithoutImages = [];

for (const m of matches) {
  const { csv, wp } = m;
  if (!wp.imageUrls.length) {
    projectsWithoutImages.push(csv);
    continue;
  }

  const folder = join(IMG_ROOT, csv.slug);
  mkdirSync(folder, { recursive: true });

  console.log(`\n→ ${csv.title}`);
  console.log(`  CSV slug: ${csv.slug}   WP slug: ${wp.slug}   Match: ${m.kind}`);
  console.log(`  ${wp.imageUrls.length} image(s) to download...`);

  for (let i = 0; i < wp.imageUrls.length; i++) {
    const url = wp.imageUrls[i];
    const ext = (extname(new URL(url).pathname).match(/\.(jpg|jpeg|png|webp|gif)/i)?.[0] || '.jpg').toLowerCase();
    const filename = String(i + 1).padStart(2, '0') + ext;
    const dest = join(folder, filename);

    if (existsSync(dest) && statSync(dest).size > 0) {
      console.log(`    ✓ ${filename} (exists, skipped)`);
      totalSkipped++;
      continue;
    }

    try {
      await downloadFile(url, dest);
      console.log(`    ↓ ${filename}`);
      totalDownloaded++;
    } catch (e) {
      console.log(`    ✗ ${filename} — ${e.message}`);
      totalFailed++;
    }
  }
}

// ─── Final Report ───
console.log('\n─── Summary ───');
console.log(`Matched projects: ${matches.length}`);
console.log(`Downloaded:       ${totalDownloaded}`);
console.log(`Skipped (exists): ${totalSkipped}`);
console.log(`Failed:           ${totalFailed}`);

if (projectsWithoutImages.length) {
  console.log(`\nMatched projects with NO images in WordPress (${projectsWithoutImages.length}):`);
  for (const p of projectsWithoutImages) console.log(`   [${p.tab}] ${p.title}`);
}

if (unmatched.length) {
  console.log(`\nCSV projects with no WP match (${unmatched.length}) — handle these manually:`);
  for (const p of unmatched) console.log(`   [${p.tab}] ${p.title}`);
}

console.log(`\nNext: run \`npm run sync-projects\` to update projects.json with the new images.`);
