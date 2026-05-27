// build-cynthia-data.mjs
// Generates src/data/cynthia.json. Source of truth for which projects appear
// in the cylinder is the PROJECT CYLINDER sheet (gid 233495172) of the
// master Google sheet; each project's row count caps how many cards we
// render for it. Pulled fresh from the sheet on every run; a local copy
// is kept at /tmp as an offline fallback.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const ROOT = resolve(import.meta.dirname, '..');
const PROJECTS = JSON.parse(readFileSync(resolve(ROOT, 'src/data/projects.json'), 'utf8'));

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1UeBpqpuMH9RbpESDIDiMieMZWdI9gkNTgwMr9PzGehY/export?format=csv&gid=233495172';
const FALLBACK = '/tmp/project-cylinder.csv';

let csvText = '';
try {
  csvText = execSync(`curl -sL "${SHEET_CSV_URL}"`, { encoding: 'utf8' });
  if (csvText.length < 200) throw new Error('Empty / too short CSV response');
  writeFileSync(FALLBACK, csvText);
} catch (e) {
  if (!existsSync(FALLBACK)) {
    console.error('Could not fetch sheet and no fallback exists:', e.message);
    process.exit(1);
  }
  csvText = readFileSync(FALLBACK, 'utf8');
}

// FILE NAME (from PROJECT CYLINDER sheet) → projects.json slug.
// Anything not in this map will not appear in the cylinder.
const FILE_TO_SLUG = {
  'AdidasOriginals_WalesBonnerCollaboration_2025_CreativeStrategy': 'adidas-originals-wales-bonner',
  "XLRecordings_KeiyaAHooke'sLawAlbumRelease_2025_Consulting":      'xl-recordings-keiyaa-hookes-law-album-release',
  'LizJohnsonArtur_180ListeningSessions_2025_Consulting':           'liz-johnson-artur-180-listening-sessions',
  'RachelJones_HeyMaudie_2025_Consulting':                          'rachel-jones-hey-maudie',
  'DauanJacari_2024_Consulting':                                    'dauan-jacari-residency',
  '10kGlobal_2023_Consulting':                                      '10k-global',
  'Allen-GolderCarpenter_Sojourn,CamdenArtsCentre_2026_Curation':   'allen-golder-carpenter-sojourn-camden-arts-centre',
  'EditionPatrickFrey_L$PBlackArkBookLaunch_2026_Curation':         'edition-patrick-frey-lsp-black-ark-book-launch',
  'Ewusie_AW26CutFromtheSameCloth(Lookbook)_2026_Curation':         'ewusie-aw26-cut-from-the-same-cloth-activation',
  'PreciousReneeTucker_Telfar_2025_Curation':                       'precious-renee-tucker-telfar',
  'PreciousReneeTucker_LoveMagazine_2025_Curation':                 'precious-renee-tucker-love-magazine',
  'AlexanderMcQueen_Reverb_2025_Curation':                          'mcqueen-reverb',
  "XLRecordings_KeiyaA(Hooke'sLawListeningEvent)_2025_Curation":    'xl-recordings-keiyaa-hookes-law',
  'LadjiDiaby_KunstvereinNuernberg_2025_Curation':                  'ladji-diaby-kunstverein-nuernberg',
  'Prologue+_Supreme_2024_Curation':                                'prologue-supreme',
  'BLKNWSInResidence_MusicCentreLA_2024_Curation':                  'blknws-in-residence-music-centre-la',
  'ChurchofSound_JamesBaldwin_2024_Curation':                       'church-of-sound-james-baldwin',
  'RachelJones_BrittenPears_2024_Curation':                         'rachel-jones-messiaen-song-cycles-britten-pears',
  'RachelJones(ThaddaeusRopac)_ashornrootExhibition(Catalogue)_2024_Curation': 'rachel-jones-a-shorn-root',
  'TAKA_YoungRecords_2023_Curation':                                'taka-young-records',
  'NUBA_SS26FashionEastPresentation_2025_CreativeDirection':        'nuba-ss26-solid-fashion-east',
  'OlaEbiti_AcnePaper(Nocturne)_2024_CreativeDirection':            'ola-ebiti-acne-paper-nocturne',
  'SUUTOO_Extra/Loud_2024_CreativeDirection':                       'suutoo-extra-loud',
  "NUBA_SS24'SMOKE'_2023_CreativeDirection":                        'nuba-ss24-smoke',
  '10kGlobal_MIKE(Ipari&BewareoftheMonkeys)_2023_CreativeDirection': '10k-global-beware-of-the-monkey',
  'Klein_FactMagazine_2021_CreativeDirection':                      'klein-fact-magazine',
  'MosesBoyd_DarkMatter_2020_CreativeDirection':                    'moses-boyd-dark-matter',
  "RoyalAcademyofArts_ObiAgwam-'ReimaginingtheCanon'Panel_2026_CulturalResearch": 'royal-academy-of-arts-obi-agwam-reimagining-the-canon-panel',
  "StoneIsland_'Pompeii/Utility'AlbumRelease_2026_CulturalResearch": 'stone-island-pompeii-utility-album-release',
  'TheFace_EarlSweatshirt&MIKEInterview_2026_CulturalResearch':     'the-face-earl-sweatshirt-mike-interview',
  'TrippinxNewBalance_TheRunnersAtlas_2026_CulturalResearch':       'trippin-new-balance-the-runners-atlas',
  'JosianeM.H.Pozi_CuraMagazine_2025_CulturalResearch':             'josiane-mh-pozi-cura-magazine',
  'DauanJacari_BOY.BROTHER.FRIEND_2025_CulturalResearch':           'dauan-jacari-boy-brother-friend',
  'NISM_Self-StudyRoom_2024_CulturalResearch':                      'nism-self-study-room',
  'RachelJones_WhitechapelGallery_2023_CulturalResearch':           'rachel-jones-studio-whitechapel-gallery',
  'AirAfrique_IssueOne:LondonStopover_2023_CulturalResearch':       'air-afrique-issue-1-london-stopover',
  'NUBA_BOY.BROTHER.FRIEND_2023_CulturalResearch':                  'nuba-boy-brother-friend',
  'LocallyGrown_C-StudiosTV_2020_CulturalResearch':                 'locally-grown-c-studios-tv',
};

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c === '\r') { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const rows = parseCSV(csvText);
const headerIdx = rows.findIndex(r => r.some(c => c.trim().toUpperCase() === 'FILE NAME'));
if (headerIdx < 0) { console.error('No header row found in CSV'); process.exit(1); }
const header = rows[headerIdx].map(h => h.trim().toUpperCase());
const fileNameCol = header.indexOf('FILE NAME');
const dataRows = rows.slice(headerIdx + 1);

// Count rows per FILE NAME — this is the card cap per project.
const countByFile = new Map();
const orderByFile = [];
for (const r of dataRows) {
  const fname = (r[fileNameCol] || '').trim();
  if (!fname) continue;
  if (!countByFile.has(fname)) orderByFile.push(fname);
  countByFile.set(fname, (countByFile.get(fname) || 0) + 1);
}

const slugMeta = {};
for (const cat of PROJECTS) {
  for (const p of cat.projects) {
    slugMeta[p.slug] = {
      title: p.title,
      year: p.year,
      description: p.description,
      category: cat.name,
      images: p.images,
    };
  }
}

const cards = [];
const projects = {};
const unmapped = [];
const noImages = [];

for (const fname of orderByFile) {
  const slug = FILE_TO_SLUG[fname];
  if (!slug) { unmapped.push(fname); continue; }
  const meta = slugMeta[slug];
  if (!meta) { console.warn(`  ⚠ slug "${slug}" mapped from "${fname}" not found in projects.json`); continue; }

  const cap = countByFile.get(fname);
  const usedImages = meta.images.slice(0, cap);
  if (!usedImages.length) { noImages.push(slug); continue; }

  projects[slug] = {
    title: meta.title,
    year: meta.year,
    description: meta.description,
    category: meta.category,
    images: usedImages,
    references: [],
  };
  for (const img of usedImages) {
    cards.push({ slug, img });
  }
}

// Shuffle cards so project images aren't grouped on the cylinder — each
// project's photos get scattered across the wrap-around. Seeded so the
// order is stable across builds (no flicker for return visitors).
let seed = 12345;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
for (let i = cards.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [cards[i], cards[j]] = [cards[j], cards[i]];
}

writeFileSync(
  resolve(ROOT, 'src/data/cynthia.json'),
  JSON.stringify({ cards, projects }, null, 2) + '\n'
);

console.log(`Built cynthia: ${cards.length} cards across ${Object.keys(projects).length} projects.`);
if (noImages.length) {
  console.log(`\nSkipped (mapped but no images on disk):`);
  noImages.forEach(s => console.log(`  - ${s}`));
}
if (unmapped.length) {
  console.log('\nUnmapped CSV file names (add to FILE_TO_SLUG if these should appear):');
  unmapped.forEach(f => console.log(`  - ${f}`));
}
