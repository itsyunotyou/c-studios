// Handles POST /api/publish-projects — see worker/index.js for routing.
//
// Called by the "Publish projects to site" menu in the master sheet
// (google-apps-script/PublishProjects.gs). Same two-step shape as the
// library endpoint:
//
//   1. Dry run — { projects, dryRun: true }. Responds with
//      { needsImage: [driveFileId, ...] }: the only images worth reading
//      from Drive and sending.
//   2. Commit — { projects, images: [{ id, ext, b64 }] }. May be called
//      several times in a row with the same `projects` and a different slice
//      of `images`, to stay under request size limits.
//
// `projects` is every ticked row of the PROJECTS tab, in sheet order. Each
// has `images`: the numbered images in its Drive folder, in number order, as
// [{ id, version }] — or null when the folder isn't ready (no folder, no
// numbered images, shared with another project, or not readable), in which
// case the project keeps the images it already has on the site.
//
// What this writes, in one commit:
//   - src/data/projects-sheet.json — the tab as published. Only this
//     endpoint writes it.
//   - _incoming/projects/<drive file id>.<ext> — raw images. The
//     process-projects Action turns them into webp sizes, removes them, and
//     rebuilds projects.json from projects-sheet.json.

import { gh, getFile, b64ToText, textToB64, commitFiles, encodePath } from './publish-library.js';
import { isDriveId, IMAGE_EXTENSIONS } from '../scripts/lib/projects-sheet.mjs';

const MANIFEST_PATH = 'src/data/projects-sheet.json';
const PROCESSED_PATH = 'src/data/projects-sheet-processed.json';
const INCOMING_DIR = '_incoming/projects';

const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const str = (v) => String(v ?? '').trim();

async function readJson(env, path, fallback) {
  const file = await getFile(env, path);
  if (!file || !file.content) return fallback;
  return JSON.parse(b64ToText(file.content));
}

async function listIncoming(env) {
  const res = await gh(env, `contents/${encodePath(INCOMING_DIR)}?ref=main`);
  if (res.status === 404) return new Set();
  if (!res.ok) throw new Error(`GET ${INCOMING_DIR} failed: ${res.status} ${await res.text()}`);
  const entries = await res.json();
  return new Set(entries.filter(e => e.type === 'file').map(e => e.name.replace(/\.[^.]+$/, '')));
}

function cleanProject(p) {
  const images = Array.isArray(p.images)
    ? p.images.filter(i => isDriveId(i?.id)).map(i => ({ id: i.id, version: str(i.version) }))
    : null;
  return {
    category: str(p.category),
    title: str(p.title),
    year: str(p.year),
    description: str(p.description),
    folderId: isDriveId(p.folderId) ? p.folderId : null,
    images: images && images.length ? images : null,
  };
}

export async function handlePublishProjects(request, env) {
  const received = request.headers.get('X-Publish-Secret');
  if (!env.PUBLISH_SECRET || received !== env.PUBLISH_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const { images, dryRun } = body;
  if (!Array.isArray(body.projects)) {
    return new Response('projects must be an array', { status: 400 });
  }
  const projects = body.projects.map(cleanProject).filter(p => p.title && p.category);
  // Never let an empty or broken publish wipe the Projects section.
  if (!projects.length) {
    return new Response('No ticked projects with a title and category — nothing published', { status: 400 });
  }

  const [manifest, processed] = await Promise.all([
    readJson(env, MANIFEST_PATH, { projects: [], files: {} }),
    readJson(env, PROCESSED_PATH, {}),
  ]);

  // Every image the sheet currently asks for, with its Drive version.
  const wanted = new Map();
  for (const p of projects) for (const img of p.images || []) wanted.set(img.id, img.version);

  if (dryRun) {
    const incoming = await listIncoming(env);
    const needsImage = [];
    for (const [id, version] of wanted) {
      if (processed[id] === version) continue;                                    // already live
      if (manifest.files?.[id]?.version === version && incoming.has(id)) continue; // waiting on the Action
      needsImage.push(id);
    }
    return json({ needsImage });
  }

  const files = {};
  for (const id of wanted.keys()) {
    if (manifest.files?.[id]) files[id] = manifest.files[id];
  }

  const staged = [];
  for (const img of Array.isArray(images) ? images : []) {
    if (!wanted.has(img?.id) || !img.b64) continue;
    const ext = String(img.ext ?? '').toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) continue;
    staged.push({ path: `${INCOMING_DIR}/${img.id}.${ext}`, contentB64: img.b64 });
    files[img.id] = { version: wanted.get(img.id) };
  }

  const nextText = JSON.stringify({ projects, files }, null, 2) + '\n';
  const prevText = JSON.stringify({ projects: manifest.projects || [], files: manifest.files || {} }, null, 2) + '\n';

  // Nothing changed and nothing new to send: skip the commit so repeat
  // clicks don't fill the history with empty publishes.
  if (nextText === prevText && staged.length === 0) {
    return json({ ok: true, projects: projects.length, staged: 0, unchanged: true });
  }

  const message = staged.length
    ? `Publish projects from sheet (+${staged.length} image${staged.length === 1 ? '' : 's'})`
    : 'Publish projects from sheet';
  await commitFiles(env, [{ path: MANIFEST_PATH, contentB64: textToB64(nextText) }, ...staged], message);

  return json({ ok: true, projects: projects.length, staged: staged.length });
}
