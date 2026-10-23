/**
 * C-STUDIOS master sheet — "Publish projects to site" Apps Script.
 *
 * Bound to the C-S WEBSITE_MASTER SHEET (the library sheet keeps its own
 * PublishLibrary.gs). To install:
 *   1. Open the master sheet → Extensions → Apps Script.
 *   2. Paste this file's contents into Code.gs (replacing the placeholder).
 *   3. Project Settings (gear icon) → tick "Show appsscript.json manifest
 *      file in editor", then replace appsscript.json with the one in this
 *      folder (read this sheet, read-only Drive, call the site).
 *   4. Project Settings → Script Properties → add:
 *        ENDPOINT_URL    https://<same domain as the library's ENDPOINT_URL>/api/publish-projects
 *        PUBLISH_SECRET  <the same value the library script uses>
 *      Optional: SHEET_PROJECTS if the tab is ever renamed (default: PROJECTS).
 *   5. Save and reload the sheet. A "C-STUDIOS" menu appears. The first click
 *      asks whoever clicks it to authorize the script once.
 *
 * How the PROJECTS tab maps to the site:
 *   - Only rows with COPY APPROVED ticked are published, in row order.
 *     Unticking a row takes it off the site.
 *   - CATEGORY decides the tab; categories appear in the order they first
 *     appear in the sheet.
 *   - TITLE, YEAR and DESCRIPTION are shown as typed.
 *   - DRIVE LINK points to the project's own folder. Images whose file name
 *     starts with a number are shown, in number order (01, 02 … 10).
 *     Everything else in the folder is ignored.
 *   - If a project's folder isn't ready (no link, no numbered images, or the
 *     same folder linked from another project), it keeps the images it
 *     already has on the site.
 */

const DEFAULT_SHEET = 'PROJECTS';
const TIME_BUDGET_MS = 4 * 60 * 1000;          // Apps Script stops at 6 min
const MAX_BATCH_PAYLOAD_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_IMAGE_COUNT = 10;              // keeps the Worker under its request cap

const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/tiff': 'tiff', 'image/avif': 'avif',
};
const KNOWN_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'tif', 'tiff', 'avif'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('C-STUDIOS')
    .addItem('Publish projects to site', 'publishProjects')
    .addToUi();
}

function publishProjects() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const endpoint = props.getProperty('ENDPOINT_URL');
  const secret = props.getProperty('PUBLISH_SECRET');
  if (!endpoint || !secret) {
    ui.alert('Setup missing: add ENDPOINT_URL and PUBLISH_SECRET under Project Settings → Script Properties.');
    return;
  }

  const sheetName = props.getProperty('SHEET_PROJECTS') || DEFAULT_SHEET;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    ui.alert(`No tab called "${sheetName}" in this sheet.`);
    return;
  }

  const startTime = Date.now();
  const hasTimeLeft = () => (Date.now() - startTime) < TIME_BUDGET_MS;

  try {
    const { projects, unticked } = collectProjects(sheet);
    if (!projects.length) {
      ui.alert('No projects have COPY APPROVED ticked, so nothing was published. (Publishing with none ticked would empty the Projects section.)');
      return;
    }

    const notes = { shared: [], noFolder: [], noAccess: [], noNumbered: [], year: [], description: [] };
    const filesById = {};
    readFolders(projects, filesById, notes);

    for (const p of projects) {
      if (!/^\d{4}$/.test(p.year)) notes.year.push(`${p.title} (“${p.year || 'blank'}”)`);
      if (!p.description) notes.description.push(p.title);
    }

    const plan = post(endpoint, secret, { projects: projects, dryRun: true });
    const needed = plan.needsImage || [];

    // Read and send in batches as we go, so a slow Drive doesn't eat the
    // whole time budget before anything reaches the site.
    let staged = 0, sentCount = 0, batch = [], size = 0, posted = false;
    const flush = () => {
      if (!batch.length) return;
      staged += post(endpoint, secret, { projects: projects, images: batch }).staged || 0;
      batch = []; size = 0; posted = true;
    };
    for (const id of needed) {
      if (!hasTimeLeft()) break;
      const file = filesById[id];
      if (!file) continue;
      const b64 = Utilities.base64Encode(file.getBlob().getBytes());
      if (batch.length && (size + b64.length > MAX_BATCH_PAYLOAD_BYTES || batch.length >= MAX_BATCH_IMAGE_COUNT)) flush();
      batch.push({ id: id, ext: extFor(file), b64: b64 });
      size += b64.length;
      sentCount++;
    }
    flush();
    if (!posted) post(endpoint, secret, { projects: projects, images: [] }); // text and order changes only

    const lines = [];
    lines.push(`${projects.length} ticked projects published (${unticked} not ticked, left off the site).`);
    lines.push(staged
      ? `${staged} new or changed image(s) sent.`
      : 'No new images to send.');
    lines.push('Changes appear on the site in about 10 minutes.');
    if (sentCount < needed.length) {
      lines.push(`\nRan out of time with ${needed.length - sentCount} image(s) still to send. Click Publish again to continue — those projects show their current images until then.`);
    }
    addNote(lines, 'Same Drive folder linked from more than one project (keeping current images)', notes.shared);
    addNote(lines, 'No Drive link (keeping current images)', notes.noFolder);
    addNote(lines, 'No numbered images in the folder yet (keeping current images)', notes.noNumbered);
    addNote(lines, "Couldn't open the Drive folder — check you have access", notes.noAccess);
    addNote(lines, 'Year looks unusual', notes.year);
    addNote(lines, 'No description', notes.description);
    ui.alert('Publish projects', lines.join('\n'), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Publish failed', e.message, ui.ButtonSet.OK);
  }
}

// Finds the header row (the one with TITLE and CATEGORY) instead of assuming
// a row number — the checklist notes above the table can grow or shrink.
function collectProjects(sheet) {
  const values = sheet.getDataRange().getValues();
  let headerRow = -1;
  for (let i = 0; i < Math.min(values.length, 30); i++) {
    const cells = values[i].map(c => String(c).trim().toUpperCase());
    if (cells.indexOf('TITLE') >= 0 && cells.indexOf('CATEGORY') >= 0) { headerRow = i; break; }
  }
  if (headerRow < 0) throw new Error('No header row with TITLE and CATEGORY found in the first 30 rows.');

  const headers = values[headerRow].map(h => String(h).trim().toUpperCase());
  const cols = {
    category: headers.indexOf('CATEGORY'),
    title: headers.indexOf('TITLE'),
    year: headers.indexOf('YEAR'),
    description: headers.indexOf('DESCRIPTION'),
    approved: headers.findIndex(h => h.indexOf('APPROVED') >= 0),
    link: headers.findIndex(h => h.indexOf('DRIVE') >= 0),
  };
  if (cols.approved < 0) throw new Error('No COPY APPROVED column found.');
  const cell = (row, i) => (i >= 0 ? String(row[i] == null ? '' : row[i]).trim() : '');

  const projects = [];
  let unticked = 0;
  for (let i = headerRow + 1; i < values.length; i++) {
    const r = values[i];
    const title = cell(r, cols.title);
    if (!title || title.toUpperCase() === 'TITLE') continue; // blank row or a repeated header
    const ticked = r[cols.approved] === true || /^(true|yes|y|x|✓|✔)$/i.test(cell(r, cols.approved));
    if (!ticked) { unticked++; continue; }
    const yearRaw = cols.year >= 0 ? r[cols.year] : '';
    projects.push({
      category: cell(r, cols.category),
      title: title,
      year: yearRaw instanceof Date ? String(yearRaw.getFullYear()) : String(yearRaw || '').trim(),
      description: cell(r, cols.description),
      folderId: folderIdFrom(cell(r, cols.link)),
      images: null,
    });
  }
  return { projects: projects, unticked: unticked };
}

function folderIdFrom(link) {
  const m = String(link).match(/\/folders\/([A-Za-z0-9_-]{10,})/) || String(link).match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}

function readFolders(projects, filesById, notes) {
  const uses = {};
  projects.forEach(p => { if (p.folderId) uses[p.folderId] = (uses[p.folderId] || 0) + 1; });

  const cache = {};
  for (const p of projects) {
    if (!p.folderId) { notes.noFolder.push(p.title); continue; }
    if (uses[p.folderId] > 1) { notes.shared.push(p.title); continue; }
    if (!cache[p.folderId]) cache[p.folderId] = numberedImages(p.folderId);
    const result = cache[p.folderId];
    if (result.error) { notes.noAccess.push(p.title); continue; }
    if (!result.files.length) { notes.noNumbered.push(p.title); continue; }
    p.images = result.files.map(f => {
      filesById[f.getId()] = f;
      return { id: f.getId(), version: `${f.getLastUpdated().getTime()}:${f.getSize()}` };
    });
  }
}

// Images in the folder (not subfolders) whose name starts with a number,
// sorted by that number: 1, 2 … 10 (or 01, 02 … 10).
function numberedImages(folderId) {
  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    return { error: e.message, files: [] };
  }
  const found = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const name = f.getName();
    const m = name.match(/^\s*(\d+)/);
    if (!m) continue;
    const isImage = String(f.getMimeType()).indexOf('image/') === 0 || splitExt(name).ext;
    if (!isImage) continue;
    found.push({ n: Number(m[1]), name: name, file: f });
  }
  found.sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  return { files: found.map(x => x.file) };
}

// Only a recognised image extension counts as one.
function splitExt(name) {
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (KNOWN_EXTENSIONS.indexOf(ext) >= 0) return { base: name.slice(0, dot), ext: ext };
  }
  return { base: name, ext: null };
}

function extFor(file) {
  return splitExt(file.getName()).ext || MIME_EXTENSIONS[file.getMimeType()] || 'jpg';
}

function post(endpoint, secret, payload) {
  const res = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Publish-Secret': secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error(`The site answered ${code}: ${res.getContentText().slice(0, 300)}`);
  return JSON.parse(res.getContentText());
}

function addNote(lines, heading, items) {
  if (!items.length) return;
  const shown = items.slice(0, 10).map(s => '• ' + s).join('\n');
  lines.push(`\n${heading} (${items.length}):\n${shown}${items.length > 10 ? `\n…and ${items.length - 10} more` : ''}`);
}
