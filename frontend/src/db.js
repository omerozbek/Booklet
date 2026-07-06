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
  const tx = db.transaction(['chapters', 'images'], 'readwrite');
  for (const ch of chapters) {
    const imgs = await tx.objectStore('images').index('chapterUrl').getAll(ch.url);
    for (const img of imgs) tx.objectStore('images').delete(img.id);
    tx.objectStore('chapters').delete(ch.url);
  }
  await tx.done;
  await db.delete('titles', url);
}

// ─── Chapters ──────────────────────────────

export async function saveChapterMeta(chapter) {
  const db = await getDb();
  await db.put('chapters', chapter);
}

export async function getChaptersForTitle(titleUrl) {
  const db = await getDb();
  const chapters = await db.getAllFromIndex('chapters', 'titleUrl', titleUrl);
  return chapters.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

export async function getChapterMeta(chapterUrl) {
  const db = await getDb();
  return db.get('chapters', chapterUrl);
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

export async function deleteChapterImages(chapterUrl) {
  const db = await getDb();
  const imgs = await db.getAllFromIndex('images', 'chapterUrl', chapterUrl);
  const tx = db.transaction(['images', 'chapters'], 'readwrite');
  for (const img of imgs) tx.objectStore('images').delete(img.id);
  const ch = await tx.objectStore('chapters').get(chapterUrl);
  if (ch) tx.objectStore('chapters').put({ ...ch, downloaded: false, imageCount: 0 });
  await tx.done;
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
