// Handles POST /api/publish-library — see worker/index.js for routing.
//
// Called by the Apps Script "Publish to site" menu item, twice per library
// tab (text/image/sound):
//
//   1. A dry-run plan call — { category, rows, dryRun: true } — with no
//      images. Diffs `rows` against what's already published and responds
//      with { needsImage: ["<fileName base, lowercased>", ...] }, the only
//      covers actually worth reading from Drive and base64-encoding.
//   2. The real commit call — { category, rows, images } — where `images`
//      only needs to contain the files `needsImage` asked for.
//
// Splitting it this way keeps Apps Script from having to read + encode a
// Drive file for every row on every publish, which used to blow its own
// 6-minute execution cap once cover matching actually started working.
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
// The library-<category>.json rewrite and every staged image land in ONE
// atomic commit via the Git Data API (blobs + tree + commit + ref update),
// not one Contents-API PUT per file. That used to be N+1 separate commits
// per batch, and every single one of them independently triggers
// process-library-images.yml (it filters on any push touching
// _incoming/**) — which takes 20-45+ seconds to run. A batch of 10 staged
// images could fire that Action 10 times while this same request was still
// mid-batch writing more commits, and the Action's own commit (adding
// colors, deleting processed _incoming/ files) landing in that window is
// exactly what caused the recurring sha conflicts. One commit per batch
// means one trigger, which shrinks that collision window by the same
// factor as the batch size — and tree entries don't need an existing sha
// at all, so the whole per-file conflict dance just doesn't apply anymore.

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

// Looks up a row's existing published entry (if any) by title/author/year,
// shared between the dry-run plan and the real commit so both agree on
// what counts as "unchanged".
function oldEntryFor(r, existingByKey) {
  return existingByKey.get(entryKey({
    title: r.title,
    author: r.name || r.author || '',
    year: r.year || '',
  }));
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

// isSafeFileSegment above only blocks path-escape vectors, not URL-reserved
// characters — a title-derived filename legitimately containing "?" (as
// "MarkFisher_CapitalistRealism:IsThereNoAlternative?_2012_JY.jpg" did)
// otherwise gets truncated at that character once dropped straight into a
// URL, since fetch parses everything from "?" on as a query string. Every
// path segment needs its own encodeURIComponent — encoding the whole path
// at once would also escape the "/" separators.
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function getFile(env, path) {
  const res = await gh(env, `contents/${encodePath(path)}?ref=${BRANCH}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { sha: json.sha, content: json.content };
}

async function ghJson(env, path, options) {
  const res = await gh(env, path, options);
  if (!res.ok) throw new Error(`${options?.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Commits every file in `files` ({path, contentB64}) as ONE atomic commit
// via the Git Data API, instead of one Contents-API PUT per file — see the
// header comment above for why that distinction actually matters here.
// Tree entries reference files purely by JSON `path` strings (no URL
// involved), so this also sidesteps the whole "?" -in-filename truncation
// class of bug that the Contents API's URL-based paths were exposed to.
//
// The only race left is the ref update itself (someone else — almost
// always the image-processing Action — advancing main between our GET and
// our PATCH). That's a genuine conflict, not a cache-lag artifact, so it's
// handled by rebuilding the tree on top of the new HEAD and retrying,
// rather than just re-sending the same PATCH.
async function commitFiles(env, files, message, attempt = 1) {
  const ref = await ghJson(env, `git/refs/heads/${BRANCH}`);
  const parentSha = ref.object.sha;
  const parentCommit = await ghJson(env, `git/commits/${parentSha}`);

  const tree = [];
  for (const file of files) {
    const blob = await ghJson(env, 'git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: file.contentB64, encoding: 'base64' }),
    });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await ghJson(env, 'git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree }),
  });

  const newCommit = await ghJson(env, 'git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] }),
  });

  const updateRes = await gh(env, `git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  });
  if (!updateRes.ok) {
    const bodyText = await updateRes.text();
    if (attempt < 3) {
      return commitFiles(env, files, message, attempt + 1);
    }
    throw new Error(`update ref failed: ${updateRes.status} ${bodyText}`);
  }
  return newCommit.sha;
}

export async function handlePublishLibrary(request, env) {
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

  const { category, rows, images, dryRun } = body;
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

  // Reading + base64-encoding a cover from Drive for every row on every
  // publish is what blew Apps Script's own 6-minute execution cap once the
  // folder-matching fix meant covers actually started resolving. Instead,
  // Apps Script calls this first with just `rows` (no images) to find out
  // which covers are actually new/changed, then only encodes and sends
  // those in the real (non-dryRun) call that follows.
  if (dryRun) {
    const needsImage = new Set();
    for (const r of rows) {
      if (!r.title || !r.fileName) continue;
      const rawBase = String(r.fileName).trim();
      const base = isSafeFileSegment(rawBase) ? rawBase : '';
      if (!base) continue;
      const old = oldEntryFor(r, existingByKey);
      const oldBase = old ? old.image.replace(/^.*\//, '').replace(/\.[^.]+$/, '') : null;
      // "Reference unchanged" isn't the same as "already processed" — a lot
      // of entries have had the same broken, extension-less reference sit
      // there since before Drive matching ever worked, so also retry
      // anything that was never actually staged into a real image/color.
      if (oldBase !== base || !old.color) needsImage.add(base.toLowerCase());
    }
    return new Response(JSON.stringify({ needsImage: [...needsImage] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

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

      const old = oldEntryFor(r, existingByKey);
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

  const filesToCommit = [
    { path: jsonPath, contentB64: textToB64(JSON.stringify(finalEntries, null, 2) + '\n') },
    ...staged.map(f => ({ path: f.path, contentB64: f.b64 })),
  ];
  const message = staged.length
    ? `Publish ${category} library from sheet (+${staged.length} staged image${staged.length === 1 ? '' : 's'})`
    : `Publish ${category} library from sheet`;
  await commitFiles(env, filesToCommit, message);

  return new Response(JSON.stringify({
    ok: true,
    entries: finalEntries.length,
    staged: staged.length,
  }), { headers: { 'Content-Type': 'application/json' } });
}
