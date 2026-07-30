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
 *   4. Save, then reload the spreadsheet — a "C-STUDIOS" menu appears with
 *      "Publish to site". The first click asks you to authorize the script
 *      (it needs to read this spreadsheet and the Drive folder) — that's a
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

  const imagesByBase = indexDriveFolder(folderId);
  const results = [];

  for (const category of Object.keys(CATEGORIES)) {
    const { sheetProp, sheetDefault } = CATEGORIES[category];
    const sheetName = props.getProperty(sheetProp) || sheetDefault;
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) {
      results.push(`${category}: sheet tab "${sheetName}" not found — skipped`);
      continue;
    }

    try {
      const { rows, images } = buildPayload(sheet, imagesByBase);
      const res = callEndpoint(endpoint, secret, category, rows, images);
      results.push(`${category}: ${res.entries} entries, ${res.staged} image(s) staged for processing`);
    } catch (e) {
      results.push(`${category}: FAILED — ${e.message}`);
    }
  }

  ui.alert('Publish results\n\n' + results.join('\n'));
}

// Map every file in the Drive folder by its basename (no extension,
// lowercased) so it can be matched against the sheet's extension-less
// FILE NAME column regardless of case or actual file type.
function indexDriveFolder(folderId) {
  const folder = DriveApp.getFolderById(folderId);
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

function buildPayload(sheet, imagesByBase) {
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
  const images = {};
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

    const entry = {
      title,
      name: String(row[cols.name] || '').trim(),
      year,
      added,
      by: String(row[cols.by] || '').trim(),
      fileName,
      notes: cols.notes >= 0 ? String(row[cols.notes] || '').trim() : '',
    };
    rows.push(entry);

    if (fileName) {
      const file = imagesByBase[fileName.toLowerCase()];
      if (file) {
        const key = file.getName(); // real filename, with its actual extension
        if (!images[key]) {
          images[key] = Utilities.base64Encode(file.getBlob().getBytes());
        }
      }
    }
  }

  return { rows, images };
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
