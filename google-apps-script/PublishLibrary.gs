/**
 * C-STUDIOS Library — "Publish to site" Apps Script.
 *
 * This file is NOT run by this repo — it runs inside Google's own
 * infrastructure, bound to the library spreadsheet. To install it:
 *   1. Open the Sheet → Extensions → Apps Script.
 *   2. Delete the placeholder Code.gs content, paste this file's contents in.
 *   3. Project Settings (gear icon) → Script Properties → add:
 *        ENDPOINT_URL     https://<your-site-domain>/api/publish-library
 *        PUBLISH_SECRET   <the same random string set as the Cloudflare
 *                          Pages "PUBLISH_SECRET" environment variable>
 *        DRIVE_FOLDER_ID  <the Drive folder's ID, from its URL:
 *                          drive.google.com/drive/folders/THIS_PART>
 *      Optionally override sheet tab names (defaults shown):
 *        SHEET_TEXT   TEXT DATABASE
 *        SHEET_IMAGE  IMAGE DATABASE
 *        SHEET_SOUND  SOUND DATABASE
 *   4. Gear icon (Project Settings) → check "Show 'appsscript.json' manifest
 *      file in editor" → a new appsscript.json appears in the file list.
 *      Replace its contents with this folder's appsscript.json (keep
 *      "timeZone" matching whatever the project already had if different —
 *      it affects how ADDED dates are formatted). This declares narrow,
 *      explicit permissions (read-only Drive access, and only this bound
 *      spreadsheet rather than every Sheet in your account) instead of the
 *      broad access Apps Script requests by default when scopes aren't
 *      declared explicitly.
 *   5. Save, then reload the spreadsheet — a "C-STUDIOS" menu appears with
 *      "Publish to site". The first click asks you to authorize the script
 *      (read-only access to this spreadsheet and the Drive folder) — a
 *      one-time prompt for whoever's Google account owns the script.
 *
 * What it does: reads every row from each of the three library tabs, finds
 * each row's cover image in the Drive folder by matching the FILE NAME
 * column, and POSTs everything to the site's publish endpoint — once per
 * tab. The endpoint treats each tab as the complete list for that category,
 * so removing a row here removes it from the site on the next publish.
 */

const CATEGORIES = {
  text:  { sheetProp: 'SHEET_TEXT',  sheetDefault: 'TEXT DATABASE' },
  image: { sheetProp: 'SHEET_IMAGE', sheetDefault: 'IMAGE DATABASE' },
  sound: { sheetProp: 'SHEET_SOUND', sheetDefault: 'SOUND DATABASE' },
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('C-STUDIOS')
    .addItem('Publish to site', 'publishAll')
    .addToUi();
}

function publishAll() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const endpoint = props.getProperty('ENDPOINT_URL');
  const secret = props.getProperty('PUBLISH_SECRET');
  const folderId = props.getProperty('DRIVE_FOLDER_ID');

  if (!endpoint || !secret || !folderId) {
    ui.alert('Missing setup — check Script Properties (Project Settings) for ENDPOINT_URL, PUBLISH_SECRET, and DRIVE_FOLDER_ID.');
    return;
  }

  const rootFolder = DriveApp.getFolderById(folderId);
  const results = [];

  // Apps Script kills the whole run at 6 minutes. Retrying every
  // never-processed image (not just changed ones) can mean far more Drive
  // reads than fit in one run, so stop starting new ones once the budget's
  // spent and let a re-run pick up the rest — anything still missing a
  // computed color keeps getting flagged by the plan call regardless of
  // reference, so nothing is lost, just spread across runs.
  const startTime = Date.now();
  const TIME_BUDGET_MS = 5 * 60 * 1000;
  const hasTimeLeft = () => (Date.now() - startTime) < TIME_BUDGET_MS;

  for (const category of Object.keys(CATEGORIES)) {
    const { sheetProp, sheetDefault } = CATEGORIES[category];
    const sheetName = props.getProperty(sheetProp) || sheetDefault;
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      results.push(`${category}: sheet tab "${sheetName}" not found — skipped`);
      continue;
    }

    const categoryFolder = findSubfolder(rootFolder, category);
    const imagesByBase = categoryFolder ? indexDriveFolder(categoryFolder) : {};
    if (!categoryFolder) {
      results.push(`${category}: no "${category}" subfolder found under DRIVE_FOLDER_ID — image matching skipped`);
    }

    try {
      const rows = collectRows(sheet);
      const needsImage = planCategory(endpoint, secret, category, rows);
      const images = encodeImages(rows, imagesByBase, needsImage, hasTimeLeft);
      const res = callEndpointBatched(endpoint, secret, category, rows, images);
      const ranOutOfTime = !hasTimeLeft() && Object.keys(images).length < needsImage.size;
      results.push(`${category}: ${res.entries} entries, ${res.staged} image(s) staged for processing`
        + (ranOutOfTime ? ' (time budget reached — run Publish again to continue the rest)' : ''));
    } catch (e) {
      results.push(`${category}: FAILED — ${e.message}`);
    }
  }

  ui.alert('Publish results\n\n' + results.join('\n'));
}

// Covers live in per-category subfolders (image/sound/text) under
// DRIVE_FOLDER_ID rather than directly in it — find the one matching this
// category's name (case-insensitive).
function findSubfolder(parentFolder, name) {
  const target = name.trim().toLowerCase();
  const subfolders = parentFolder.getFolders();
  while (subfolders.hasNext()) {
    const sub = subfolders.next();
    if (sub.getName().trim().toLowerCase() === target) return sub;
  }
  return null;
}

// Map every file in a Drive folder by its basename (no extension,
// lowercased) so it can be matched against the sheet's extension-less
// FILE NAME column regardless of case or actual file type.
function indexDriveFolder(folder) {
  const files = folder.getFiles();
  const map = {};
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    const dot = name.lastIndexOf('.');
    const base = (dot > 0 ? name.slice(0, dot) : name).trim().toLowerCase();
    map[base] = file;
  }
  return map;
}

// Scan the top of the sheet for the header row (the row containing a
// "TITLE" cell) rather than assuming a fixed row number — the sheet has a
// few decorative rows above the actual table that can shift over time.
function findHeaderRow(values) {
  for (let i = 0; i < Math.min(values.length, 20); i++) {
    if (values[i].some(cell => String(cell).trim().toUpperCase() === 'TITLE')) return i;
  }
  throw new Error('Could not find a header row (no "TITLE" column found in the first 20 rows)');
}

function collectRows(sheet) {
  const values = sheet.getDataRange().getValues();
  const headerRow = findHeaderRow(values);
  const headers = values[headerRow].map(h => String(h).trim().toUpperCase());

  const colIndex = (name) => headers.indexOf(name);
  const notesCol = headers.findIndex(h => h.indexOf('NOTES') === 0);
  const cols = {
    title: colIndex('TITLE'),
    name: colIndex('NAME'),
    year: colIndex('YEAR'),
    added: colIndex('ADDED'),
    by: colIndex('BY'),
    fileName: colIndex('FILE NAME'),
    notes: notesCol,
  };
  if (cols.title < 0 || cols.fileName < 0) {
    throw new Error('Sheet is missing a TITLE or FILE NAME column');
  }

  const rows = [];
  const tz = Session.getScriptTimeZone();

  for (let i = headerRow + 1; i < values.length; i++) {
    const row = values[i];
    const title = String(row[cols.title] || '').trim();
    if (!title) break; // end of the table

    const fileName = String(row[cols.fileName] || '').trim();
    const yearRaw = row[cols.year];
    const year = (yearRaw instanceof Date)
      ? String(yearRaw.getFullYear())
      : String(yearRaw || '').trim();
    const addedRaw = row[cols.added];
    const added = (addedRaw instanceof Date)
      ? Utilities.formatDate(addedRaw, tz, 'dd/MM/yyyy')
      : String(addedRaw || '').trim();

    rows.push({
      title,
      name: String(row[cols.name] || '').trim(),
      year,
      added,
      by: String(row[cols.by] || '').trim(),
      fileName,
      notes: cols.notes >= 0 ? String(row[cols.notes] || '').trim() : '',
    });
  }

  return rows;
}

const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

// Some covers in Drive turn out to have no extension in their stored name
// at all (confirmed by hand — Drive shows the name completely bare). The
// worker keys staged images by "<base>.<ext>" to recover the extension, so
// a name with no dot in it would silently never match despite being read
// and sent correctly. Falls back to the file's actual MIME type instead of
// trusting the name to have one.
function keyFor(file) {
  const name = file.getName();
  if (name.lastIndexOf('.') > 0) return name;
  const ext = MIME_EXTENSIONS[file.getMimeType()];
  return ext ? `${name}.${ext}` : name;
}

// Only reads + base64-encodes the Drive files the endpoint's dry-run plan
// actually asked for (see planCategory below) — reading every cover on
// every publish is what used to blow Apps Script's 6-minute execution cap.
// Stops starting new reads once hasTimeLeft() says the budget's spent,
// leaving the rest for a subsequent run.
function encodeImages(rows, imagesByBase, needsImage, hasTimeLeft) {
  const images = {};
  for (const r of rows) {
    if (!hasTimeLeft()) break;
    if (!r.fileName || !needsImage.has(r.fileName.toLowerCase())) continue;
    const file = imagesByBase[r.fileName.toLowerCase()];
    if (!file) continue;
    const key = keyFor(file);
    if (!images[key]) {
      images[key] = Utilities.base64Encode(file.getBlob().getBytes());
    }
  }
  return images;
}

// Asks the endpoint which covers are actually new/changed before reading
// and encoding anything from Drive — see worker/publish-library.js for the
// dryRun branch this talks to.
function planCategory(endpoint, secret, category, rows) {
  const res = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Publish-Secret': secret },
    payload: JSON.stringify({ category, rows, dryRun: true }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error(`plan HTTP ${code}: ${res.getContentText()}`);
  }
  const body = JSON.parse(res.getContentText());
  return new Set(body.needsImage || []);
}

function callEndpoint(endpoint, secret, category, rows, images) {
  const res = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Publish-Secret': secret },
    payload: JSON.stringify({ category, rows, images }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error(`HTTP ${code}: ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText());
}

// Apps Script's own URLFetch POST body cap (~50MB) is per-request, not
// per-run — a backlog of covers that never got a computed color (see the
// "reference unchanged" comment in encodeImages) can mean enough base64
// piles up in one go to blow that even though it's well within the time
// budget. Stays well under the cap and splits `images` across as many
// commit calls as needed; sending the same full `rows` with each batch is
// safe because the endpoint treats an image it just wrote in an earlier
// batch as "same reference, not yet processed" and skips re-staging it.
const MAX_BATCH_PAYLOAD_BYTES = 20 * 1024 * 1024;

// Cloudflare caps how many outbound fetches a single Worker invocation can
// make (50 on free/low-tier plans). Every staged cover costs the endpoint
// 2 of those — a GET to check for an existing file sha, then the PUT — on
// top of the 2 it always spends rewriting library-<category>.json, so a
// batch that's well under the byte cap above can still trip that limit if
// it's made up of a lot of small files. Keeps well clear of it.
const MAX_BATCH_IMAGE_COUNT = 20;

function callEndpointBatched(endpoint, secret, category, rows, images) {
  const keys = Object.keys(images);
  if (keys.length === 0) return callEndpoint(endpoint, secret, category, rows, images);

  let entries = 0;
  let staged = 0;
  let batch = {};
  let batchSize = 0;
  let batchCount = 0;

  const flush = () => {
    if (batchCount === 0) return;
    const res = callEndpoint(endpoint, secret, category, rows, batch);
    entries = res.entries;
    staged += res.staged;
    batch = {};
    batchSize = 0;
    batchCount = 0;
  };

  for (const key of keys) {
    const size = images[key].length;
    if (batchCount > 0 && (batchSize + size > MAX_BATCH_PAYLOAD_BYTES || batchCount >= MAX_BATCH_IMAGE_COUNT)) flush();
    batch[key] = images[key];
    batchSize += size;
    batchCount++;
  }
  flush();

  return { entries, staged };
}
