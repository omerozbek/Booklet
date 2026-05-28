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
