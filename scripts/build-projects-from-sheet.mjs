// scripts/build-projects-from-sheet.mjs
//
// Run by .github/workflows/process-projects.yml after the master sheet's
// "Publish projects to site" menu commits. Two jobs:
//
//   1. Every raw image staged in _incoming/projects/<drive file id>.<ext>
//      becomes public/images/projects/drive/<id>-{640,828,1280,2560}w.webp
//      (the sizes the homepage and cylinder ask for). The raw file is then
//      deleted. Images are stored by Drive file id, so renaming a file to
//      change its position never needs a re-upload.
//   2. src/data/projects.json is rebuilt from src/data/projects-sheet.json:
//      categories and projects in sheet order, text exactly as published.
//      A project's images switch to its Drive folder only once every one of
//      them is processed; until then — or when its folder isn't ready — it
//      keeps the images it already had, so the site never shows a gap.
//
// Projects keep their existing slug (the cylinder and image folders rely on
// it): matched first by Drive folder, then by title. New projects get a slug
// from their title.
//
// Usage: node scripts/build-projects-from-sheet.mjs

import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { VARIANT_WIDTHS, displayTitle, cleanText, matchKey, slugify } from './lib/projects-sheet.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(ROOT, 'src/data/projects-sheet.json');
const PROCESSED_PATH = resolve(ROOT, 'src/data/projects-sheet-processed.json');
const PROJECTS_PATH = resolve(ROOT, 'src/data/projects.json');
const INCOMING_DIR = resolve(ROOT, '_incoming/projects');
const IMAGES_DIR = resolve(ROOT, 'public/images/projects/drive');
const QUALITY = 80;

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const variantPath = (id, w) => join(IMAGES_DIR, `${id}-${w}w.webp`);

const manifest = readJson(MANIFEST_PATH, { projects: [], files: {} });
const processed = readJson(PROCESSED_PATH, {});
const previous = readJson(PROJECTS_PATH, []);

// ── 1. Staged raw images → webp sizes ────────────────────────────────────
let made = 0, failed = 0, orphaned = 0;
const incoming = existsSync(INCOMING_DIR) ? readdirSync(INCOMING_DIR).filter(f => !f.startsWith('.')) : [];
mkdirSync(IMAGES_DIR, { recursive: true });

for (const file of incoming) {
  const src = join(INCOMING_DIR, file);
  const id = file.replace(/\.[^.]+$/, '');
  const staged = manifest.files?.[id];

  // No longer used by any ticked project since it was staged.
  if (!staged) {
    unlinkSync(src);
    orphaned++;
    continue;
  }

  try {
    const meta = await sharp(src).metadata();
    const sideways = meta.orientation && meta.orientation >= 5;
    const originalWidth = (sideways ? meta.height : meta.width) || VARIANT_WIDTHS.at(-1);
    for (const w of VARIANT_WIDTHS) {
      await sharp(src)
        .rotate() // respect camera orientation
        .resize({ width: Math.min(w, originalWidth), withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toFile(variantPath(id, w));
    }
    processed[id] = staged.version;
    unlinkSync(src);
    made++;
  } catch (e) {
    // Leave the raw file so the next publish retries it; don't block the rest.
    failed++;
    console.log(`✗ ${file} — ${e.message}`);
  }
}

// ── 2. Rebuild projects.json ─────────────────────────────────────────────
const isReady = (img) => processed[img.id] === img.version && VARIANT_WIDTHS.every(w => existsSync(variantPath(img.id, w)));

const prevProjects = previous.flatMap(cat => cat.projects);
const byFolder = new Map(prevProjects.filter(p => p.driveFolder).map(p => [p.driveFolder, p]));
const byTitle = new Map(prevProjects.map(p => [matchKey(p.title), p]));

// A folder linked from more than one ticked row can't identify a project.
const folderUse = new Map();
for (const p of manifest.projects) if (p.folderId) folderUse.set(p.folderId, (folderUse.get(p.folderId) || 0) + 1);

// Match each row to a project already on the site so it keeps its slug and
// images. Pass 1: same Drive folder, then same title (ignoring separators,
// quotes, case and spacing). Pass 2, for rows still unmatched: a title that's
// one or two characters off — a typo fix in the sheet ("MESSIANEN" →
// "MESSIAEN") shouldn't drop a project's images.
const claimed = new Set();
const matches = new Array(manifest.projects.length).fill(null);
const uniqueFolderOf = (row) => (row.folderId && folderUse.get(row.folderId) === 1 ? row.folderId : null);
const claim = (i, p) => { if (p && !claimed.has(p.slug)) { matches[i] = p; claimed.add(p.slug); return true; } return false; };

manifest.projects.forEach((row, i) => {
  const folder = uniqueFolderOf(row);
  if (folder && claim(i, byFolder.get(folder))) return;
  claim(i, byTitle.get(matchKey(row.title)));
});
manifest.projects.forEach((row, i) => {
  if (matches[i]) return;
  const key = matchKey(row.title);
  if (key.length < 12) return;
  const close = prevProjects.filter(p => !claimed.has(p.slug) && editDistance(key, matchKey(p.title)) <= 2);
  if (close.length === 1) claim(i, close[0]);
});

const usedSlugs = new Set();
const categories = [];
const pendingImages = [];
const noImages = [];

manifest.projects.forEach((row, i) => {
  const prev = matches[i];
  const uniqueFolder = uniqueFolderOf(row);

  const base = prev?.slug || slugify(displayTitle(row.title));
  let slug = base;
  for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
  usedSlugs.add(slug);

  let images = prev?.images || [];
  if (row.images && row.images.length) {
    if (row.images.every(isReady)) images = row.images.map(img => `/images/projects/drive/${img.id}.webp`);
    else pendingImages.push(row.title);
  }
  if (!images.length) noImages.push(row.title);

  const project = {
    title: displayTitle(row.title),
    year: cleanText(row.year),
    description: cleanText(row.description),
    slug,
    images,
  };
  if (uniqueFolder) project.driveFolder = uniqueFolder;

  let cat = categories.find(c => c.name === cleanText(row.category));
  if (!cat) {
    cat = { name: cleanText(row.category), slug: slugify(row.category), projects: [] };
    categories.push(cat);
  }
  cat.projects.push(project);
});

// Forget processed entries for images no ticked project uses any more.
const live = new Set(Object.keys(manifest.files || {}));
for (const id of Object.keys(processed)) if (!live.has(id)) delete processed[id];
writeFileSync(PROCESSED_PATH, JSON.stringify(processed, null, 2) + '\n');

if (categories.length) {
  writeFileSync(PROJECTS_PATH, JSON.stringify(categories, null, 2) + '\n');
} else {
  console.log('Sheet has no projects — projects.json left untouched.');
}

const total = categories.reduce((n, c) => n + c.projects.length, 0);
console.log(`Images processed: ${made}, failed: ${failed}, discarded: ${orphaned}`);
console.log(`Projects written: ${total} across ${categories.length} categories`);
if (pendingImages.length) console.log(`Waiting on images (showing previous ones for now): ${pendingImages.join(' · ')}`);
if (noImages.length) console.log(`No images: ${noImages.join(' · ')}`);
if (failed) console.log(`::warning::${failed} image(s) could not be processed — see log above`);

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
