// import-projects-zip.mjs
// Imports project images from the extracted zip at /tmp/projects-zip/PROJECTS,
// numbering them per their leading number (1*, 2*, …) and copying into the
// existing per-slug folders at public/images/projects/<slug>/ as 01.ext, 02.ext…
//
// Source files are kept as-is (jpg/png/etc.); the existing
// generate-variants.mjs handles WebP variant generation afterwards. Any
// existing source images (01.jpg, 02.png, etc.) in the target slug folder
// are removed first so we don't end up with stale higher-numbered images.

import { readdirSync, existsSync, statSync, mkdirSync, copyFileSync, rmSync } from 'fs';
import { resolve, join, extname } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const ZIP_ROOT = '/tmp/projects-zip/PROJECTS';
const IMG_ROOT = resolve(ROOT, 'public/images/projects');

// Map: zip folder path (relative to ZIP_ROOT) → website slug.
// `null` = intentionally skip (no matching project / multiple matches need review).
const MAPPING = [
  // ── CONSULTING ──
  ['CONSULTING /10K GLOBAL',           '10k-global'],
  ['CONSULTING /DAUAN JACARI',         'dauan-jacari-residency'],
  ['CONSULTING /LIZ JOHNSON ARTUR ',   'liz-johnson-artur-180-listening-sessions'],
  ['CONSULTING /RACHEL JONES STUDIO',  'rachel-jones-hey-maudie'],
  ['CONSULTING /ROC NATION',           'roc-nation-artist-development'],
  ['CONSULTING /XL RECORDINGS',        'xl-recordings-keiyaa-hookes-law-album-release'],

  // ── CREATIVE DIRECTION ──
  ['CREATIVE DIRECTION /10k Global - BEWARE OF THE MONKEY', '10k-global-beware-of-the-monkey'],
  ['CREATIVE DIRECTION /ACNE PAPER _ OLA ELUEBUTI',         'ola-ebiti-acne-paper-nocturne'],
  ['CREATIVE DIRECTION /AKEEM SMITH STUDIO',                'akeem-smith-studio'],
  ['CREATIVE DIRECTION /FACT MAGAZINE _ KLEIN  ',           'klein-fact-magazine'],
  ['CREATIVE DIRECTION /MOSES BOYD ',                       'moses-boyd-dark-matter'],
  ['CREATIVE DIRECTION /NUBA FASHION EAST',                 'nuba-ss26-solid-fashion-east'],
  ['CREATIVE DIRECTION /NUBA SMOKE',                        'nuba-ss24-smoke'],
  ['CREATIVE DIRECTION /SUUTOO',                            'suutoo-extra-loud'],

  // ── CREATIVE STRATEGY ──
  ['CREATIVE STRATEGY /SELECTED CLIENTS /ADIDAS _ WALES BONNER (NO IMAGES) ', 'adidas-originals-wales-bonner'],
  ['CREATIVE STRATEGY /SELECTED CLIENTS /ARMANI _ BUREAU FUTURE (NO IMAGES) ', 'bureau-future-giorgio-armani'],
  ['CREATIVE STRATEGY /SELECTED CLIENTS /CONVOY _ CK ',                       'convoy'],

  // ── CULTURAL RESEARCH ──
  ['CULTURAL RESEARCH /SELECTED CLIENTS /(NEW) LOCALLY GROWN ',     'locally-grown-c-studios-tv'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /AIR AFRIQUE ',             'air-afrique-issue-1-london-stopover'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /CURA MAGAZINE ',           'josiane-mh-pozi-cura-magazine'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /DAUAN JACARI ',            'dauan-jacari-boy-brother-friend'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /NUBA',                     'nuba-boy-brother-friend'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /RACHEL JONES WHITECHAPEL GALLERY', 'rachel-jones-studio-whitechapel-gallery'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /ROYAL ACADEMY OF ART',     'royal-academy-of-arts-obi-agwam-reimagining-the-canon-panel'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /SSR',                      'nism-self-study-room'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /STONE ISLAND ',            'stone-island-pompeii-utility-album-release'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /THE FACE',                 'the-face-earl-sweatshirt-mike-interview'],
  ['CULTURAL RESEARCH /SELECTED CLIENTS /TRIPPIN X NEW BALANCE',    'trippin-new-balance-the-runners-atlas'],

  // ── CURATION ──
  ['CURATION/SELECTED CLIENTS /ALLEN-GOLDER CARPENTER',         'allen-golder-carpenter-sojourn-camden-arts-centre'],
  ['CURATION/SELECTED CLIENTS /BLKNWS ',                        'blknws-in-residence-music-centre-la'],
  ['CURATION/SELECTED CLIENTS /CHURCH OF SOUND - JAMES BALDWIN ', 'church-of-sound-james-baldwin'],
  ['CURATION/SELECTED CLIENTS /EWUSIE ',                        'ewusie-aw26-cut-from-the-same-cloth-activation'],
  ['CURATION/SELECTED CLIENTS /LADJI DIABY',                    'ladji-diaby-kunstverein-nuernberg'],
  ['CURATION/SELECTED CLIENTS /LEE SCRATCH PERRY',              'edition-patrick-frey-lsp-black-ark-book-launch'],
  ['CURATION/SELECTED CLIENTS /MC QUEEN I  REVERB',             'mcqueen-reverb'],
  ['CURATION/SELECTED CLIENTS /PROLOGUE+',                      'prologue-supreme'],
  ['CURATION/SELECTED CLIENTS /PROLOGUE+ PRECIOUS RENEE TUCKER ', 'precious-renee-tucker-love-magazine'],
  ['CURATION/SELECTED CLIENTS /PROLOGUE+ X TELFAR ',            'precious-renee-tucker-telfar'],
  ['CURATION/SELECTED CLIENTS /RACHEL JONES A SHORN ROOT ',     'rachel-jones-a-shorn-root'],
  ['CURATION/SELECTED CLIENTS /RACHEL JONES- MESSIANEN',        'rachel-jones-messiaen-song-cycles-britten-pears'],
  ['CURATION/SELECTED CLIENTS /TAKA _ YOUNG RECORDS ',          'taka-young-records'],
  ['CURATION/SELECTED CLIENTS /XL RECORDINGS I  KEIYAA ALBUM LISTENING', 'xl-recordings-keiyaa-hookes-law'],

  // ── LADJI DIABY also has a subfolder, handled above (LADJI DIABY).
];

const IMG_EXT = /\.(jpg|jpeg|png|webp|tif|tiff|gif)$/i;
const VARIANT_RE = /-\d+w\.webp$/i;

let processed = 0, totalCopied = 0, totalSkipped = 0;
const skippedZip = [];

for (const [zipRel, slug] of MAPPING) {
  const zipDir = join(ZIP_ROOT, zipRel);
  if (!existsSync(zipDir) || !statSync(zipDir).isDirectory()) {
    console.warn(`  ⚠ Zip folder not found: ${zipRel}`);
    skippedZip.push(zipRel);
    continue;
  }
  const slugDir = join(IMG_ROOT, slug);
  if (!existsSync(slugDir)) {
    mkdirSync(slugDir, { recursive: true });
  }

  // 1. Collect numbered source images from the zip folder (e.g. 1Foo.jpg).
  //    Skip files in subfolders (Archive/, etc.).
  const files = readdirSync(zipDir, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name)
    .filter(name => IMG_EXT.test(name) || !extname(name))  // include extensionless
    .filter(name => /^\d+/.test(name));

  if (!files.length) {
    console.warn(`  ⚠ No numbered images in: ${zipRel}`);
    continue;
  }

  // 2. Sort by leading number.
  files.sort((a, b) => {
    const na = parseInt(a.match(/^\d+/)[0], 10);
    const nb = parseInt(b.match(/^\d+/)[0], 10);
    return na - nb;
  });

  // 3. Wipe existing source files (keep responsive variants — they'll be
  //    regenerated; deleting them here would just slow the rebuild).
  //    Wait — variants reference the source stem, so if we change which
  //    source is "01.jpg" the old variants are stale. Remove ALL files in
  //    target folder so generate-variants starts fresh.
  for (const f of readdirSync(slugDir)) {
    rmSync(join(slugDir, f));
  }

  // 4. Copy each zip file to the slug folder, renamed 01.ext, 02.ext, …
  files.forEach((srcName, idx) => {
    const srcPath = join(zipDir, srcName);
    let ext = extname(srcName).toLowerCase();
    if (!ext) ext = '.jpg';  // extensionless files in the zip appear to be jpgs
    // tif/tiff aren't browser-friendly but sharp handles them on the variant step
    const padded = String(idx + 1).padStart(2, '0');
    const destName = `${padded}${ext}`;
    const destPath = join(slugDir, destName);
    copyFileSync(srcPath, destPath);
    totalCopied++;
  });

  console.log(`✓ ${slug.padEnd(50)} ${files.length} images from ${zipRel}`);
  processed++;
}

console.log('\n─── Summary ───');
console.log(`Mapped folders processed: ${processed}/${MAPPING.length}`);
console.log(`Image source files copied: ${totalCopied}`);
if (skippedZip.length) {
  console.log(`\nMissing zip folders:`);
  skippedZip.forEach(z => console.log(`  - ${z}`));
}
console.log(`\nNext: \`npm run generate-variants\` then \`npm run sync-projects\`.`);
