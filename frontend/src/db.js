import { openDB } from 'idb';

const DB_NAME = 'manhwa-reader';
const DB_VERSION = 1;

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('titles')) {
          db.createObjectStore('titles', { keyPath: 'url' });
        }
        if (!db.objectStoreNames.contains('chapters')) {
          const cs = db.createObjectStore('chapters', { keyPath: 'url' });
          cs.createIndex('titleUrl', 'titleUrl');
        }
        if (!db.objectStoreNames.contains('images')) {
          const is = db.createObjectStore('images', { keyPath: 'id' });
          is.createIndex('chapterUrl', 'chapterUrl');
        }
      },
    });
  }
  return dbPromise;
}

// ─── Titles ────────────────────────────────

export async function saveTitleMeta(title) {
  const db = await getDb();
  await db.put('titles', { ...title, savedAt: Date.now() });
}

export async function getAllTitles() {
  const db = await getDb();
  return db.getAll('titles');
}

export async function getTitle(url) {
  const db = await getDb();
  return db.get('titles', url);
}

export async function deleteTitle(url) {
  const db = await getDb();
  const chapters = await db.getAllFromIndex('chapters', 'titleUrl', url);
  // Collect every key up front (keys only — no image blobs pulled into
  // memory), then delete in one transaction with nothing awaited inside it.
  const imageKeys = [];
  for (const ch of chapters) {
    imageKeys.push(...(await db.getAllKeysFromIndex('images', 'chapterUrl', ch.url)));
  }
  const tx = db.transaction(['titles', 'chapters', 'images'], 'readwrite');
  for (const key of imageKeys) tx.objectStore('images').delete(key);
  for (const ch of chapters) tx.objectStore('chapters').delete(ch.url);
  tx.objectStore('titles').delete(url);
  await tx.done;

  try {
    for (const ch of chapters) localStorage.removeItem(`scroll:${ch.url}`);
    const lastRead = JSON.parse(localStorage.getItem('last-read') || 'null');
    if (lastRead?.titleUrl === url) localStorage.removeItem('last-read');
  } catch { /* ignore */ }
}

// ─── Chapters ──────────────────────────────

export async function saveChapterMeta(chapter) {
  const db = await getDb();
  await db.put('chapters', chapter);
}

/** Merge a patch into a stored chapter without clobbering fields set elsewhere. */
export async function updateChapterMeta(chapterUrl, patch) {
  const db = await getDb();
  const existing = await db.get('chapters', chapterUrl);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  await db.put('chapters', next);
  return next;
}

// ─── Chapter identity ──────────────────────
//
// Sites list several uploads of the same chapter — one per scanlation group —
// each under its own URL (on comix.to, .../11306138-chapter-61 and
// .../11306111-chapter-61 are both chapter 61). Records are keyed by URL, so
// when the site surfaces a different upload than the one already saved, the
// same chapter gets stored twice: the list doubles, and the copy carrying
// `downloaded: true` hides behind the fresh duplicate — downloads look lost.
//
// A chapter's real identity is (titleUrl, number). The URL is only the upload
// we happen to read. Everything below keys off that.

function chapterKey(ch) {
  return ch.number == null || Number.isNaN(ch.number) ? `url:${ch.url}` : `num:${ch.number}`;
}

function sortChapters(list) {
  return list.slice().sort((a, b) => {
    if (a.number == null && b.number == null) return 0;
    if (a.number == null) return 1; // unnumbered specials go last, not first
    if (b.number == null) return -1;
    return a.number - b.number;
  });
}

/** Of several stored rows for one chapter, the copy worth keeping. */
function bestOf(rows) {
  return rows.slice().sort((a, b) =>
    (b.imageCount || 0) - (a.imageCount || 0) ||
    (b.downloaded ? 1 : 0) - (a.downloaded ? 1 : 0) ||
    (b.lastReadAt || 0) - (a.lastReadAt || 0)
  )[0];
}

/** Fold duplicate rows for one chapter into a single record, keeping the
 *  furthest reading progress and any hand-edited name found on any of them. */
function mergeGroup(rows) {
  if (rows.length === 1) return rows[0];
  const winner = bestOf(rows);
  const lastReadAt = Math.max(...rows.map((r) => r.lastReadAt || 0)) || undefined;
  const readStatus = rows.some((r) => r.readStatus === 'completed')
    ? 'completed'
    : rows.some((r) => r.readStatus === 'reading')
      ? 'reading'
      : winner.readStatus;
  const edited = rows.find((r) => r.titleEdited);
  return {
    ...winner,
    lastReadAt,
    readStatus,
    ...(edited ? { title: edited.title, titleEdited: true } : {}),
  };
}

function groupByChapter(rows) {
  const groups = new Map();
  for (const ch of rows) {
    const k = chapterKey(ch);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(ch);
  }
  return groups;
}

export async function getChaptersForTitle(titleUrl) {
  const db = await getDb();
  const chapters = await db.getAllFromIndex('chapters', 'titleUrl', titleUrl);
  // Collapse duplicates for display too, so a doubled list reads correctly
  // even offline, before any sync has had a chance to clean the store up.
  return sortChapters([...groupByChapter(chapters).values()].map(mergeGroup));
}

export async function getChapterMeta(chapterUrl) {
  const db = await getDb();
  return db.get('chapters', chapterUrl);
}

/** Delete a chapter row outright, with its images and saved scroll position. */
async function purgeChapter(db, chapterUrl) {
  const imgs = await db.getAllFromIndex('images', 'chapterUrl', chapterUrl);
  const tx = db.transaction(['images', 'chapters'], 'readwrite');
  for (const img of imgs) tx.objectStore('images').delete(img.id);
  tx.objectStore('chapters').delete(chapterUrl);
  await tx.done;
  try { localStorage.removeItem(`scroll:${chapterUrl}`); } catch { /* ignore */ }
}

/**
 * Reconcile a freshly scraped chapter list into the store, matching on chapter
 * number rather than URL, and return the merged list to display.
 *
 * Rules, in order of how much they matter:
 *  - Duplicate rows for one chapter are collapsed into the best copy.
 *  - A chapter the user has invested in (downloaded pages or reading progress)
 *    stays pinned to the exact upload those belong to, whatever the site is
 *    surfacing today. That is what stops downloads from going missing.
 *  - An untouched chapter follows the site, so one whose upload was pulled
 *    heals itself on the next open.
 *  - Stored chapters the scrape did not return are kept, never deleted. A
 *    partial scrape (site hiccup, offline) must not shrink the library.
 */
export async function syncTitleChapters(titleUrl, scraped) {
  const db = await getDb();
  const stored = await db.getAllFromIndex('chapters', 'titleUrl', titleUrl);

  const merged = new Map();
  const drop = new Set();

  for (const [key, rows] of groupByChapter(stored)) {
    const row = mergeGroup(rows);
    merged.set(key, row);
    for (const r of rows) if (r.url !== row.url) drop.add(r.url);
  }

  for (const ch of scraped || []) {
    const key = chapterKey(ch);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...ch, titleUrl, downloaded: false, imageCount: 0 });
      continue;
    }
    const anchored =
      prev.downloaded || (prev.imageCount || 0) > 0 || !!prev.lastReadAt || !!prev.readStatus;
    if (!anchored && prev.url !== ch.url) drop.add(prev.url);
    merged.set(key, {
      ...prev,
      ...ch,
      url: anchored ? prev.url : ch.url,
      titleUrl,
      title: prev.titleEdited ? prev.title : ch.title || prev.title,
      titleEdited: prev.titleEdited || false,
      downloaded: prev.downloaded || false,
      imageCount: prev.imageCount || 0,
      readStatus: prev.readStatus,
      lastReadAt: prev.lastReadAt,
    });
  }

  const final = sortChapters([...merged.values()]);
  const keepUrls = new Set(final.map((c) => c.url));
  for (const url of drop) {
    if (!keepUrls.has(url)) await purgeChapter(db, url);
  }

  const tx = db.transaction('chapters', 'readwrite');
  for (const ch of final) tx.objectStore('chapters').put(ch);
  await tx.done;

  return final;
}

// ─── Images ────────────────────────────────

export async function saveImage(chapterUrl, index, blob) {
  const db = await getDb();
  await db.put('images', { id: `${chapterUrl}||${index}`, chapterUrl, index, blob });
}

export async function getChapterImages(chapterUrl) {
  const db = await getDb();
  const imgs = await db.getAllFromIndex('images', 'chapterUrl', chapterUrl);
  return imgs.sort((a, b) => a.index - b.index).map((i) => i.blob);
}

export async function saveChapterReadStatus(chapterUrl, status) {
  const db = await getDb();
  const ch = await db.get('chapters', chapterUrl);
  if (ch) await db.put('chapters', { ...ch, readStatus: status, lastReadAt: Date.now() });
}

/** Drop a chapter's stored pages without touching its metadata. Used before a
 *  (re)download so a shorter new page list can't leave stale trailing pages
 *  from the previous attempt behind. */
export async function clearChapterImages(chapterUrl) {
  const db = await getDb();
  const imgs = await db.getAllFromIndex('images', 'chapterUrl', chapterUrl);
  if (!imgs.length) return;
  const tx = db.transaction('images', 'readwrite');
  for (const img of imgs) tx.objectStore('images').delete(img.id);
  await tx.done;
}

export async function deleteChapterImages(chapterUrl) {
  const db = await getDb();
  const ch = await db.get('chapters', chapterUrl);

  // Clear every stored copy of this chapter, not just the row that was tapped.
  // A library hit by the old duplicate-chapter bug can hold a second saved
  // upload of the same chapter number, which would otherwise take over the
  // row and bring "Saved" straight back after a delete.
  let rows = ch ? [ch] : [];
  if (ch && ch.number != null) {
    rows = (await db.getAllFromIndex('chapters', 'titleUrl', ch.titleUrl))
      .filter((r) => r.number === ch.number);
  }
  const urls = rows.length ? rows.map((r) => r.url) : [chapterUrl];

  const imageKeys = [];
  for (const url of urls) {
    imageKeys.push(...(await db.getAllKeysFromIndex('images', 'chapterUrl', url)));
  }
  const tx = db.transaction(['images', 'chapters'], 'readwrite');
  for (const key of imageKeys) tx.objectStore('images').delete(key);
  for (const r of rows) {
    tx.objectStore('chapters').put({ ...r, downloaded: false, imageCount: 0, savedWith: undefined });
  }
  await tx.done;
}

// Bumped whenever a scraper bug is found that saved pages wrongly. Downloads
// stamped with an older value (or none) from an affected site get flagged in
// the chapter list for a re-download.
export const DOWNLOAD_FORMAT = 2;

/** Downloads saved before Asura Scans' page-order fix are likely scrambled:
 *  its split pages (002_p1, 002_p2, …) were sorted behind page 001. */
export function needsRedownload(ch) {
  if (!ch?.downloaded || (ch.savedWith || 0) >= DOWNLOAD_FORMAT) return false;
  try {
    return /(^|\.)asura(scans|comic)\.(com|net)$/.test(new URL(ch.url).hostname);
  } catch {
    return false;
  }
}

export async function getStorageByTitle() {
  const db = await getDb();
  const titles = await db.getAll('titles');
  const result = [];
  for (const title of titles) {
    const chapters = await db.getAllFromIndex('chapters', 'titleUrl', title.url);
    let bytes = 0;
    for (const ch of chapters) {
      const imgs = await db.getAllFromIndex('images', 'chapterUrl', ch.url);
      bytes += imgs.reduce((sum, img) => sum + (img.blob?.size || 0), 0);
    }
    result.push({
      url: title.url,
      title: title.title,
      bytes,
      downloadedChapters: chapters.filter((c) => c.downloaded).length,
    });
  }
  return result;
}

// Positions are stored as { y, index, frac }: raw pixel offset plus an anchor
// (topmost visible image index + fraction scrolled into it). Older versions
// stored a bare pixel number — still readable as { y }.
export function getScrollPosition(chapterUrl) {
  try {
    const raw = localStorage.getItem(`scroll:${chapterUrl}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'number') return { y: parsed, index: null, frac: 0 };
    return parsed;
  } catch {
    return null;
  }
}

export function setScrollPosition(chapterUrl, pos) {
  localStorage.setItem(
    `scroll:${chapterUrl}`,
    JSON.stringify({ y: Math.floor(pos.y || 0), index: pos.index ?? null, frac: pos.frac || 0 })
  );
}

// ─── Backup / Migration ────────────────────
//
// IndexedDB is scoped per-origin, so downloads saved under one URL are
// invisible from another (e.g. a new local IP, or dev :5173 vs prod :3001).
// These helpers move a whole library between origins via a single file.
//
// File layout (binary, no base64 so image bytes aren't inflated):
//   [4 bytes: header JSON length, uint32 little-endian]
//   [header JSON, UTF-8]
//   [all image blobs concatenated, raw]
// The header lists titles, chapters, and an image table with byte offsets,
// so import can re-slice each image straight from the file without ever
// holding the whole library in memory.

const BACKUP_FORMAT = 'manhwa-reader-backup';

// Reading state lives in localStorage, not IndexedDB: the Continue button's
// last-read chapter, per-chapter scroll positions, and auto-delete settings.
function collectLocalState() {
  const state = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === 'last-read' || key === 'auto-delete' || key.startsWith('scroll:')) {
      state[key] = localStorage.getItem(key);
    }
  }
  return state;
}

export async function exportData() {
  const db = await getDb();
  const [titles, chapters, images] = await Promise.all([
    db.getAll('titles'),
    db.getAll('chapters'),
    db.getAll('images'),
  ]);

  const imageTable = [];
  const blobParts = [];
  let offset = 0;
  for (const img of images) {
    const blob = img.blob;
    const length = blob?.size || 0;
    imageTable.push({
      id: img.id,
      chapterUrl: img.chapterUrl,
      index: img.index,
      type: blob?.type || 'image/jpeg',
      offset,
      length,
    });
    if (length > 0) blobParts.push(blob);
    offset += length;
  }

  const header = {
    format: BACKUP_FORMAT,
    version: 2,
    exportedAt: Date.now(),
    titles,
    chapters,
    images: imageTable,
    localState: collectLocalState(),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const lenPrefix = new Uint8Array(4);
  new DataView(lenPrefix.buffer).setUint32(0, headerBytes.length, true);

  // Blob() keeps each part by reference, so the image bytes are streamed
  // from IndexedDB-backed storage rather than copied into JS memory.
  return new Blob([lenPrefix, headerBytes, ...blobParts], {
    type: 'application/octet-stream',
  });
}

export async function importData(file, onProgress) {
  const lenBuf = await file.slice(0, 4).arrayBuffer();
  const headerLen = new DataView(lenBuf).getUint32(0, true);
  if (!headerLen || headerLen > file.size) {
    throw new Error('Not a valid backup file');
  }
  const header = JSON.parse(await file.slice(4, 4 + headerLen).text());
  if (header.format !== BACKUP_FORMAT) {
    throw new Error('Not a valid backup file');
  }

  const dataStart = 4 + headerLen;
  const db = await getDb();

  // Metadata is small — write titles + chapters in one transaction.
  // Chapters merge with any existing record: imported read state wins, but a
  // chapter already downloaded on this origin stays marked as downloaded.
  const metaTx = db.transaction(['titles', 'chapters'], 'readwrite');
  for (const t of header.titles || []) metaTx.objectStore('titles').put(t);
  for (const c of header.chapters || []) {
    const existing = await metaTx.objectStore('chapters').get(c.url);
    metaTx.objectStore('chapters').put(
      existing
        ? {
            ...existing,
            ...c,
            downloaded: existing.downloaded || c.downloaded || false,
            imageCount: Math.max(existing.imageCount || 0, c.imageCount || 0),
          }
        : c
    );
  }
  await metaTx.done;

  // Restore reading state (Continue button, scroll positions, settings)
  for (const [key, value] of Object.entries(header.localState || {})) {
    localStorage.setItem(key, value);
  }

  // Images can be large — write in small batches, slicing each blob straight
  // from the file (zero-copy) so memory stays flat regardless of library size.
  const images = header.images || [];
  const BATCH = 25;
  for (let i = 0; i < images.length; i += BATCH) {
    const batch = images.slice(i, i + BATCH);
    const tx = db.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    for (const meta of batch) {
      const start = dataStart + meta.offset;
      const blob = file.slice(start, start + meta.length, meta.type);
      store.put({ id: meta.id, chapterUrl: meta.chapterUrl, index: meta.index, blob });
    }
    await tx.done;
    onProgress?.(Math.min(i + BATCH, images.length), images.length);
  }

  return {
    titles: (header.titles || []).length,
    chapters: (header.chapters || []).length,
    images: images.length,
  };
}
