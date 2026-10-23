// scripts/lib/projects-sheet.mjs
//
// Shared by worker/publish-projects.js (the publish endpoint) and
// scripts/build-projects-from-sheet.mjs (the GitHub Action that makes the
// image sizes and writes projects.json). No Node-only APIs: the Worker
// bundles this too.

export const VARIANT_WIDTHS = [640, 828, 1280, 2560];
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'heic', 'avif'];

// Drive file ids are used as the stored image name, so they must be safe in
// a URL and a file path.
export const isDriveId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{10,100}$/.test(id);

// The sheet mixes "|", "│" and "—" between title parts. The site has always
// shown "│" as " — ", so keep that, and tidy stray spaces.
export function displayTitle(title) {
  return String(title ?? '')
    .normalize('NFC')
    .replace(/\s*\u2502\s*/g, ' — ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanText(text) {
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

// Loose key for recognising a sheet row as a project already on the site,
// whichever separator, quote style, case or spacing it was typed with.
export function matchKey(title) {
  return String(title ?? '')
    .normalize('NFC')
    .toUpperCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[|\u2502\u2014\u2013]/g, '|')
    .replace(/\s+/g, '');
}

export function slugify(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'project';
}
