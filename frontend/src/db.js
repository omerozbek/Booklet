import { openDB, deleteDB, wrap } from 'idb';

// ─── Storage layout ────────────────────────
//
// Safari's IndexedDB keeps a table of every stored Blob with no index on it,
// and scans that whole table on every delete, every put() that replaces an
// existing row, and every row read. Once a library held thousands of pages in
// one database, deleting a title took minutes (it looked stuck), then failed
// with "Failed to delete record from object store" — and since the scan is
// database-wide, even saving a title row or a read mark crawled.
//
// So pages never share a database with anything else:
//   manhwa-library          titles + chapters metadata — never holds a Blob
//   manhwa-pages:<chapter>  one small database per downloaded chapter
// Deleting a chapter drops its database outright, with no per-row deletes.
//
// `manhwa-reader` is the old single database. Its metadata is copied into the
// library on first open; pages move chapter by chapter in the background, and
// the old database is dropped whole once nothing is left in it.

const LIBRARY_DB = 'manhwa-library';
const LEGACY_DB = 'manhwa-reader';
const PAGES_DB_PREFIX = 'manhwa-pages:';

/** Stamped on a chapter whose pages live in its own database. */
export const OWN_PAGE_DB = 2;

let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openLibrary().catch((err) => {
      dbPromise = null; // let the next call retry instead of caching the failure
      throw err;
    });
  }
  return dbPromise;
}

async function openLibrary() {
  const db = await openDB(LIBRARY_DB, 1, {
    upgrade(db) {
      db.createObjectStore('titles', { keyPath: 'url' });
      db.createObjectStore('chapters', { keyPath: 'url' }).createIndex('titleUrl', 'titleUrl');
      db.createObjectStore('meta', { keyPath: 'key' });
    },
  });
  if (!(await db.get('meta', 'legacyMetadata'))) await copyLegacyMetadata(db);
  return db;
}

async function copyLegacyMetadata(db) {
  const legacy = await getLegacyDb();
  const has = (store) => legacy?.objectStoreNames.contains(store);
  const titles = has('titles') ? await legacy.getAll('titles') : [];
  const chapters = has('chapters') ? await legacy.getAll('chapters') : [];
  // One transaction, marker included: an interrupted copy leaves no half-library.
  const tx = db.transaction(['titles', 'chapters', 'meta'], 'readwrite');
  for (const t of titles) tx.objectStore('titles').put(t);
  for (const c of chapters) tx.objectStore('chapters').put(c);
  tx.objectStore('meta').put({ key: 'legacyMetadata', copiedAt: Date.now() });
  await tx.done;
}

// ─── Legacy database ───────────────────────

let legacyPromise = null;

function getLegacyDb() {
  if (!legacyPromise) {
    const forget = () => {
      if (legacyPromise === p) legacyPromise = null;
    };
    const p = openIfExists(LEGACY_DB, forget).catch((err) => {
      forget();
      throw err;
    });
    legacyPromise = p;
  }
  return legacyPromise;
}

/** Open a database only if it already exists; resolves null otherwise.
 *  A plain open() would create an empty one as a side effect. */
function openIfExists(name, onClosed) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    let created = false;
    req.onupgradeneeded = (e) => {
      if (e.oldVersion === 0) {
        created = true;
        req.transaction.abort();
      }
    };
    req.onsuccess = () => {
      const db = wrap(req.result);
      // Someone is deleting it — let go so the delete isn't blocked on us.
      db.addEventListener('versionchange', () => {
        db.close();
        onClosed?.();
      });
      resolve(db);
    };
    req.onerror = (e) => {
      if (!created) return reject(req.error);
      e.preventDefault();
      resolve(null);
    };
  });
}

// ─── Page databases ────────────────────────

const pageDbs = new Map(); // chapterUrl → Promise<IDBPDatabase>, kept open while downloading

function pagesDbName(chapterUrl) {
  return PAGES_DB_PREFIX + chapterUrl;
}

function openPagesDb(chapterUrl) {
  let p = pageDbs.get(chapterUrl);
  if (!p) {
    p = openDB(pagesDbName(chapterUrl), 1, {
      upgrade(db) {
        db.createObjectStore('pages', { keyPath: 'index' });
      },
      blocking() {
        // Another tab wants to delete this chapter — step aside.
        p.then((db) => db.close());
        if (pageDbs.get(chapterUrl) === p) pageDbs.delete(chapterUrl);
      },
    });
    pageDbs.set(chapterUrl, p);
    p.catch(() => pageDbs.get(chapterUrl) === p && pageDbs.delete(chapterUrl));
  }
  return p;
}

/** Close a chapter's page database connection, if one is open. */
export async function closeChapterPages(chapterUrl) {
  const p = pageDbs.get(chapterUrl);
  if (!p) return;
  pageDbs.delete(chapterUrl);
  try {
    (await p).close();
  } catch { /* never opened */ }
}

async function dropPages(chapterUrl) {
  await closeChapterPages(chapterUrl);
  await deleteDB(pagesDbName(chapterUrl));
}

async function readOwnPages(chapterUrl) {
  const cached = pageDbs.get(chapterUrl);
  // Reading must not create a database for a chapter that was never saved.
  const db = cached ? await cached : await openIfExists(pagesDbName(chapterUrl));
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains('pages')) return [];
    return await db.getAll('pages'); // keyed by index, so already in page order
  } finally {
    if (!cached) db.close();
  }
}

async function readLegacyPages(chapterUrl) {
  if ((await getMigrationMarker())?.done) return [];
  const legacy = await getLegacyDb();
  if (!legacy?.objectStoreNames.contains('images')) return [];
  const rows = await legacy.getAllFromIndex('images', 'chapterUrl', chapterUrl);
  return rows.sort((a, b) => a.index - b.index);
}

/** Every write that replaces or removes a chapter's pages goes through here, so
 *  the background page move can't interleave with a download or a delete. */
const chapterLocks = new Map();

function withChapterLock(chapterUrl, fn) {
  const run = (chapterLocks.get(chapterUrl) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  chapterLocks.set(chapterUrl, tail);
  tail.then(() => chapterLocks.get(chapterUrl) === tail && chapterLocks.delete(chapterUrl));
  return run;
}

/** Drop the page databases of chapters whose rows are already gone. Failures
 *  are left for pruneOrphanPages() to sweep up on a later launch. */
async function dropPagesFor(chapters) {
  const queue = chapters.filter((c) => c.storage === OWN_PAGE_DB).map((c) => c.url);
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      await withChapterLock(url, () => dropPages(url)).catch(() => {});
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
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

  // Metadata first: the title is gone from the library the moment this commits.
  // Pages that were still in the old database go when that database is dropped.
  const tx = db.transaction(['titles', 'chapters'], 'readwrite');
  for (const ch of chapters) tx.objectStore('chapters').delete(ch.url);
  tx.objectStore('titles').delete(url);
  await tx.done;

  try {
    for (const ch of chapters) localStorage.removeItem(`scroll:${ch.url}`);
    const lastRead = JSON.parse(localStorage.getItem('last-read') || 'null');
    if (lastRead?.titleUrl === url) localStorage.removeItem('last-read');
  } catch { /* ignore */ }

  // Pages go in the background; anything cut short is swept up by pruneOrphanPages().
  dropPagesFor(chapters).catch(() => {});
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
  const storedByUrl = new Map(stored.map((c) => [c.url, c]));

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
  const purged = [...drop].filter((url) => !keepUrls.has(url)).map((url) => storedByUrl.get(url));

  const tx = db.transaction('chapters', 'readwrite');
  for (const ch of purged) tx.objectStore('chapters').delete(ch.url);
  for (const ch of final) tx.objectStore('chapters').put(ch);
  await tx.done;

  try {
    for (const ch of purged) localStorage.removeItem(`scroll:${ch.url}`);
  } catch { /* ignore */ }
  await dropPagesFor(purged);

  return final;
}

// ─── Images ────────────────────────────────

export async function saveImage(chapterUrl, index, blob) {
  const db = await openPagesDb(chapterUrl);
  await db.put('pages', { index, blob });
}

export async function getChapterImages(chapterUrl) {
  let rows = await readOwnPages(chapterUrl);
  // Not moved out of the old database yet — read it from there.
  if (!rows.length) {
    const ch = await getChapterMeta(chapterUrl);
    if (ch?.downloaded && ch.storage !== OWN_PAGE_DB) rows = await readLegacyPages(chapterUrl);
  }
  return rows.map((r) => r.blob);
}

export async function saveChapterReadStatus(chapterUrl, status) {
  const db = await getDb();
  const ch = await db.get('chapters', chapterUrl);
  if (ch) await db.put('chapters', { ...ch, readStatus: status, lastReadAt: Date.now() });
}

/** Wipe a chapter's pages and mark it not downloaded, as one step, before a
 *  (re)download or after one fails — so a shorter new page list can't leave
 *  stale trailing pages behind, and a half-saved chapter never reads as whole. */
export async function resetChapterPages(chapterUrl) {
  await withChapterLock(chapterUrl, async () => {
    await dropPages(chapterUrl);
    await updateChapterMeta(chapterUrl, {
      downloaded: false,
      imageCount: 0,
      bytes: 0,
      savedWith: undefined,
      storage: OWN_PAGE_DB,
    });
  });
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
  if (!rows.length) {
    await withChapterLock(chapterUrl, () => dropPages(chapterUrl));
    return;
  }
  for (const r of rows) await resetChapterPages(r.url);
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
  const [titles, chapters] = await Promise.all([db.getAll('titles'), db.getAll('chapters')]);
  const result = new Map(titles.map((t) => [t.url, { url: t.url, title: t.title, bytes: 0, downloadedChapters: 0 }]));
  for (const ch of chapters) {
    const entry = result.get(ch.titleUrl);
    if (!entry || !ch.downloaded) continue;
    entry.downloadedChapters++;
    // Sizes are recorded when a chapter is saved; measure the few that predate that.
    let bytes = ch.bytes;
    if (bytes == null) {
      bytes = (await getChapterImages(ch.url)).reduce((sum, b) => sum + (b?.size || 0), 0);
      if (ch.storage === OWN_PAGE_DB) await updateChapterMeta(ch.url, { bytes });
    }
    entry.bytes += bytes;
  }
  return [...result.values()];
}

// ─── Moving pages out of the old database ──

let migration = { state: 'idle', moved: 0, total: 0, error: '' };
const migrationListeners = new Set();
let migrationRun = null;

function setMigration(patch) {
  migration = { ...migration, ...patch };
  for (const fn of migrationListeners) fn(migration);
}

/** Listen for page-move progress: { state: 'idle'|'running'|'stalled'|'done', moved, total, error }. */
export function subscribeStorageMigration(fn) {
  migrationListeners.add(fn);
  fn(migration);
  return () => migrationListeners.delete(fn);
}

async function getMigrationMarker() {
  const db = await getDb();
  return db.get('meta', 'legacyPages');
}

function stillInLegacy(ch) {
  return ch.downloaded && ch.storage !== OWN_PAGE_DB;
}

/** Start (or join) the background move of downloaded pages into per-chapter
 *  databases. Safe to call on every launch; each chapter moves atomically, so
 *  an interrupted run just picks up where it left off. */
export function migrateLegacyPages() {
  if (!migrationRun) migrationRun = runMigration().finally(() => { migrationRun = null; });
  return migrationRun;
}

async function runMigration() {
  try {
    const db = await getDb();
    if ((await getMigrationMarker())?.done) return setMigration({ state: 'done' });
    const legacy = await getLegacyDb();
    if (!legacy) {
      // Nothing to move from (fresh install, or the old data is already gone).
      await markLegacyChaptersLost(db);
      return await dropLegacyDb(db);
    }
    const pending = (await db.getAll('chapters')).filter(stillInLegacy);
    setMigration({ state: 'running', moved: 0, total: pending.length, error: '' });

    let lastError = '';
    for (const { url } of pending) {
      try {
        await withChapterLock(url, () => moveChapter(db, legacy, url));
      } catch (err) {
        if (err?.name === 'QuotaExceededError') {
          return setMigration({
            state: 'stalled',
            error: 'Not enough free space to move the rest of your downloads.',
          });
        }
        lastError = err?.message || String(err);
      }
      setMigration({ moved: migration.moved + 1 });
    }

    const left = (await db.getAll('chapters')).filter(stillInLegacy).length;
    if (left) {
      return setMigration({
        state: 'stalled',
        error: `${left} chapter${left === 1 ? '' : 's'} could not be moved${lastError ? `: ${lastError}` : ''}.`,
      });
    }
    await dropLegacyDb(db);
  } catch (err) {
    setMigration({ state: 'stalled', error: err?.message || String(err) });
  }
}

async function moveChapter(db, legacy, url) {
  const ch = await db.get('chapters', url);
  if (!ch || !stillInLegacy(ch)) return;

  const rows = legacy.objectStoreNames.contains('images')
    ? (await legacy.getAllFromIndex('images', 'chapterUrl', url)).sort((a, b) => a.index - b.index)
    : [];
  if (!rows.length || rows.length < (ch.imageCount || 0)) {
    // Never fully saved — the reader already treated it as not downloaded.
    await updateChapterMeta(url, { downloaded: false, imageCount: 0, savedWith: undefined, storage: OWN_PAGE_DB });
    return;
  }

  // Copy the bytes into fresh Blobs. Storing the Blob objects read from the old
  // database as-is makes WebKit tie the new records to the old ones: once those
  // readers are garbage-collected, pages read back later fail to load.
  // One chapter at a time keeps memory bounded.
  const blobs = [];
  for (const r of rows) blobs.push(new Blob([await r.blob.arrayBuffer()], { type: r.blob.type }));

  await dropPages(url); // clear leftovers from an earlier interrupted attempt
  const pagesDb = await openPagesDb(url);
  try {
    const tx = pagesDb.transaction('pages', 'readwrite');
    blobs.forEach((blob, index) => tx.objectStore('pages').put({ index, blob }));
    await tx.done;
  } finally {
    await closeChapterPages(url);
  }

  const bytes = blobs.reduce((sum, b) => sum + b.size, 0);
  const moved = await updateChapterMeta(url, { storage: OWN_PAGE_DB, bytes, imageCount: rows.length });
  if (!moved) await dropPages(url); // title was deleted while this chapter moved
}

async function dropLegacyDb(db) {
  // A database too damaged to open can still be deleted.
  const legacy = await getLegacyDb().catch(() => null);
  legacy?.close();
  legacyPromise = null;
  // Dropping the whole database removes its files directly — none of the
  // per-row deletes that stalled before.
  await deleteDB(LEGACY_DB, {
    blocked() {
      setMigration({ error: 'Close any other open Booklet tabs to finish the cleanup.' });
    },
  });
  await db.put('meta', { key: 'legacyPages', done: true, at: Date.now() });
  setMigration({ state: 'done', error: '' });
}

/** Give up on chapters that could not be moved: mark them not downloaded and
 *  drop the old database, freeing its space. */
export async function discardLegacyPages() {
  await migrationRun;
  const db = await getDb();
  const lost = await markLegacyChaptersLost(db);
  await dropLegacyDb(db);
  return lost;
}

async function markLegacyChaptersLost(db) {
  const stuck = (await db.getAll('chapters')).filter(stillInLegacy);
  if (!stuck.length) return 0;
  const tx = db.transaction('chapters', 'readwrite');
  for (const ch of stuck) {
    tx.objectStore('chapters').put({ ...ch, downloaded: false, imageCount: 0, savedWith: undefined });
  }
  await tx.done;
  return stuck.length;
}

/** Delete page databases whose chapter no longer exists (e.g. a title delete
 *  that was interrupted before its pages went). */
export async function pruneOrphanPages() {
  if (!indexedDB.databases) return;
  const db = await getDb();
  const names = (await indexedDB.databases())
    .map((d) => d.name)
    .filter((n) => n?.startsWith(PAGES_DB_PREFIX));
  for (const name of names) {
    const url = name.slice(PAGES_DB_PREFIX.length);
    if (!(await db.getKey('chapters', url))) {
      await withChapterLock(url, () => dropPages(url)).catch(() => {});
    }
  }
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
  const [titles, chapters] = await Promise.all([db.getAll('titles'), db.getAll('chapters')]);

  const imageTable = [];
  const blobParts = [];
  let offset = 0;
  for (const ch of chapters) {
    if (!ch.downloaded) continue;
    const blobs = await getChapterImages(ch.url);
    blobs.forEach((blob, index) => {
      const length = blob?.size || 0;
      imageTable.push({
        id: `${ch.url}||${index}`,
        chapterUrl: ch.url,
        index,
        type: blob?.type || 'image/jpeg',
        offset,
        length,
      });
      if (length > 0) blobParts.push(blob);
      offset += length;
    });
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
  // Where its pages live is this device's business, not the backup's.
  const metaTx = db.transaction(['titles', 'chapters'], 'readwrite');
  for (const t of header.titles || []) metaTx.objectStore('titles').put(t);
  for (const { storage: _s, bytes: _b, ...c } of header.chapters || []) {
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

  // Pages go into each chapter's own database, one transaction per chapter,
  // slicing each blob straight from the file (zero-copy) so memory stays flat
  // regardless of library size.
  const images = header.images || [];
  const byChapter = new Map();
  for (const meta of images) {
    if (!byChapter.has(meta.chapterUrl)) byChapter.set(meta.chapterUrl, []);
    byChapter.get(meta.chapterUrl).push(meta);
  }

  let done = 0;
  for (const [chapterUrl, pages] of byChapter) {
    pages.sort((a, b) => a.index - b.index);
    await withChapterLock(chapterUrl, async () => {
      if (!(await db.getKey('chapters', chapterUrl))) return;
      await dropPages(chapterUrl);
      const pagesDb = await openPagesDb(chapterUrl);
      try {
        const tx = pagesDb.transaction('pages', 'readwrite');
        pages.forEach((meta, index) => {
          const start = dataStart + meta.offset;
          tx.objectStore('pages').put({ index, blob: file.slice(start, start + meta.length, meta.type) });
        });
        await tx.done;
      } finally {
        await closeChapterPages(chapterUrl);
      }
      await updateChapterMeta(chapterUrl, {
        downloaded: true,
        imageCount: pages.length,
        bytes: pages.reduce((sum, p) => sum + p.length, 0),
        storage: OWN_PAGE_DB,
      });
    });
    done += pages.length;
    onProgress?.(done, images.length);
  }

  return {
    titles: (header.titles || []).length,
    chapters: (header.chapters || []).length,
    images: images.length,
  };
}
