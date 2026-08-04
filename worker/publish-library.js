// Handles POST /api/publish-library — see worker/index.js for routing.
//
// Called by the Apps Script "Publish to site" menu item, once per library
// tab (text/image/sound). Body:
//   {
//     category: 'text' | 'image' | 'sound',
//     rows: [{ title, author, year, added, by, fileName, notes? }, ...],
//     images: { "<fileName>.<ext>": "<base64 bytes>", ... }   // only for
//                                                              // rows whose
//                                                              // cover is new
//                                                              // or changed
//   }
//
// The sheet is treated as the full source of truth: `rows` is every row
// currently in that tab, and the resulting library-<category>.json is
// REPLACED with exactly those rows (mapped to the site's entry shape) — so
// deleting a row from the sheet removes it from the site on the next publish.
//
// This can't run sharp (Workers have no native modules), so it only stages
// new/changed raw images under _incoming/<category>/ — the
// process-library-images GitHub Action turns those into the actual
// thumb/large webp variants + dominant color and commits the result.
//
// Each GitHub Contents API write is its own commit (simpler than building a
// single atomic multi-file commit via the Git Data API) — a publish with
// several new images lands as a handful of commits in quick succession
// rather than one. Fine for how infrequently this runs.

const OWNER = 'itsyunotyou';
const REPO = 'c-studios';
const BRANCH = 'main';
const CATEGORIES = new Set(['text', 'image', 'sound']);

function norm(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function entryKey(entry) {
  return `${norm(entry.title)}|${norm(entry.author)}|${norm(entry.year)}`;
}

// Both the sheet's FILE NAME value and the images map's keys end up in a
// GitHub file path below, and both come from the request body — untrusted
// as far as this code is concerned, whether or not the real Apps Script is
// what sent it. Real filenames here (derived from titles) legitimately use
// all sorts of punctuation — ! & ' , @ [ ] etc. — so this blocks the actual
// path-escape vectors (separators, ".." traversal, control characters)
// rather than whitelisting an exact charset.
function isSafeFileSegment(s) {
  return typeof s === 'string' && s.length > 0
    && !/[/\\]/.test(s) && !s.includes('..') && !/[\x00-\x1f]/.test(s);
}

async function gh(env, path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'c-studios-publish-library',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res;
}

// Base64 -> UTF-8 string, and back. GitHub's Contents API always deals in
// base64, but JSON needs decoding to text to parse/modify it as JS.
function b64ToText(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), c => c.charCodeAt(0)));
}
function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  // Spreading the whole array into String.fromCharCode blows the call-stack
  // limit once `text` is large enough (library-image.json, with 400+
  // entries, hits this) — build it up in chunks instead.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function getFile(env, path) {
  const res = await gh(env, `contents/${path}?ref=${BRANCH}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { sha: json.sha, content: json.content };
}

async function putFile(env, path, contentB64, message, sha) {
  const res = await gh(env, `contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: contentB64,
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function handlePublishLibrary(request, env) {
  const received = request.headers.get('X-Publish-Secret');
  if (!env.PUBLISH_SECRET || received !== env.PUBLISH_SECRET) {
    // TEMPORARY diagnostic — reveals only lengths/presence, never the actual
    // secret value, to debug a setup mismatch. Remove once resolved.
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      envSecretSet: !!env.PUBLISH_SECRET,
      envSecretLength: env.PUBLISH_SECRET ? env.PUBLISH_SECRET.length : 0,
      headerReceived: received !== null,
      receivedLength: received ? received.length : 0,
    }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const { category, rows, images } = body;
  if (!CATEGORIES.has(category)) {
    return new Response(`Invalid category: ${category}`, { status: 400 });
  }
  if (!Array.isArray(rows)) {
    return new Response('rows must be an array', { status: 400 });
  }

  const jsonPath = `src/data/library-${category}.json`;
  const existingFile = await getFile(env, jsonPath);
  const existingEntries = existingFile ? JSON.parse(b64ToText(existingFile.content)) : [];
  const existingByKey = new Map(existingEntries.map(e => [entryKey(e), e]));

  const staged = [];
  const finalEntries = rows
    .filter(r => r.title && r.fileName)
    .map(r => {
      // The sheet's FILE NAME column is always extension-less — the real
      // extension only exists on the actual uploaded file (or, for a row
      // that hasn't changed, on the existing entry we already committed).
      // Stripped of path separators and leading dots: this value flows
      // straight into a GitHub file path below, and rows come from the
      // sheet — untrusted input as far as this code is concerned.
      const rawBase = String(r.fileName).trim();
      const base = isSafeFileSegment(rawBase) ? rawBase : '';
      const uploadedExt = base
        ? Object.keys(images || {}).find(k => k.startsWith(base + '.') && isSafeFileSegment(k))
        : undefined;

      const entry = {
        title: r.title,
        author: r.name || r.author || '',
        year: r.year || '',
        added: r.added || '',
        by: r.by || '',
        category,
      };
      if (r.notes) entry.notes = r.notes;

      const old = existingByKey.get(entryKey(entry));
      const oldBase = old ? old.image.replace(/^.*\//, '').replace(/\.[^.]+$/, '') : null;
      const sameImage = old && oldBase === base;

      if (sameImage && old.color && !uploadedExt) {
        // Nothing changed — keep the existing (already-processed) image path
        // and color as-is rather than re-deriving a path we can't get the
        // real extension for.
        entry.image = old.image;
        entry.color = old.color;
      } else if (uploadedExt) {
        entry.image = `/images/library/${category}/${uploadedExt}`;
        staged.push({ path: `_incoming/${category}/${uploadedExt}`, b64: images[uploadedExt] });
      } else if (sameImage) {
        // Same file reference but not yet fully processed (e.g. a previous
        // publish is still mid-flight) — keep pointing at it, no new upload.
        entry.image = old.image;
      } else {
        // Brand-new row with no matching upload — Apps Script should always
        // send one, but if it didn't, fall back to an extension-less path;
        // the site shows a grey placeholder until this is corrected.
        entry.image = `/images/library/${category}/${base}`;
      }
      return entry;
    });

  await putFile(
    env, jsonPath,
    textToB64(JSON.stringify(finalEntries, null, 2) + '\n'),
    `Publish ${category} library from sheet`,
    existingFile?.sha
  );

  for (const file of staged) {
    const existing = await getFile(env, file.path);
    await putFile(env, file.path, file.b64, `Stage ${file.path}`, existing?.sha);
  }

  return new Response(JSON.stringify({
    ok: true,
    entries: finalEntries.length,
    staged: staged.length,
  }), { headers: { 'Content-Type': 'application/json' } });
}
