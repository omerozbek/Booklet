import { createContext, useContext, useRef, useState, useCallback } from 'react';
import { saveImage, saveChapterMeta, updateChapterMeta, clearChapterImages } from '../db';

const DownloadContext = createContext(null);

export function DownloadProvider({ children }) {
  const [downloads, setDownloads] = useState({});
  const [downloadingAll, setDownloadingAll] = useState({});
  const abortRefs = useRef({});
  const cancelAllRef = useRef(false);

  // Claimed the moment a download starts, before any await. The abort
  // controller used to be registered only after the chapter fetch resolved, so
  // tapping Save while "Download All" was working on the same chapter started
  // two downloads that interleaved their writes into one set of page slots.
  const inFlightRef = useRef(new Set());

  const downloadChapter = useCallback(async (chapter, onComplete, options = {}) => {
    if (inFlightRef.current.has(chapter.url)) return { ok: true, skipped: true };
    inFlightRef.current.add(chapter.url);

    const abort = new AbortController();
    abortRefs.current[chapter.url] = abort;
    let result = { ok: true };

    try {
      setDownloads((prev) => ({ ...prev, [chapter.url]: { current: 0, total: 0 } }));

      const res = await fetch(`/api/chapter?url=${encodeURIComponent(chapter.url)}`, {
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { images } = await res.json();
      if (!images?.length) throw new Error('No images found');

      // Start from a clean slate: a previous attempt may have left pages
      // behind, and if it had more pages than this one those extras would
      // survive at the end of the chapter.
      await clearChapterImages(chapter.url);
      await updateChapterMeta(chapter.url, { downloaded: false, imageCount: 0 });

      setDownloads((prev) => ({ ...prev, [chapter.url]: { current: 0, total: images.length } }));

      for (let i = 0; i < images.length; i++) {
        if (abort.signal.aborted) break;
        const proxyUrl = `/api/proxy?url=${encodeURIComponent(images[i])}&referer=${encodeURIComponent(chapter.url)}`;
        const imgRes = await fetch(proxyUrl, { signal: abort.signal });
        if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
        const blob = await imgRes.blob();
        await saveImage(chapter.url, i, blob);
        setDownloads((prev) => ({ ...prev, [chapter.url]: { current: i + 1, total: images.length } }));
      }

      if (abort.signal.aborted) {
        // A half-saved chapter reads as a corrupt one, so leave nothing behind.
        await clearChapterImages(chapter.url);
      } else {
        const stored = await updateChapterMeta(chapter.url, {
          downloaded: true,
          imageCount: images.length,
        });
        const updated = stored || { ...chapter, downloaded: true, imageCount: images.length };
        if (!stored) await saveChapterMeta(updated);
        onComplete?.(updated);
      }
    } catch (err) {
      result = { ok: false, error: err.message };
      if (err.name !== 'AbortError') {
        await clearChapterImages(chapter.url).catch(() => {});
        await updateChapterMeta(chapter.url, { downloaded: false, imageCount: 0 }).catch(() => {});
        if (!options.silent) alert(`Download failed: ${err.message}`);
      }
    } finally {
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[chapter.url];
        return next;
      });
      delete abortRefs.current[chapter.url];
      inFlightRef.current.delete(chapter.url);
    }
    return result;
  }, []);

  const cancelDownload = useCallback((chapterUrl) => {
    abortRefs.current[chapterUrl]?.abort();
  }, []);

  const downloadAll = useCallback(
    async (chapters, titleUrl, onChapterComplete) => {
      cancelAllRef.current = false;
      setDownloadingAll((prev) => ({ ...prev, [titleUrl]: true }));
      const toDownload = chapters.filter((c) => !c.downloaded && !inFlightRef.current.has(c.url));
      // One failing chapter used to pop a modal that blocked the whole run.
      // Collect them instead and report once at the end.
      const failed = [];
      for (const ch of toDownload) {
        if (cancelAllRef.current) break;
        const r = await downloadChapter(ch, onChapterComplete, { silent: true });
        if (!r.ok) failed.push(ch.title || ch.url);
      }
      setDownloadingAll((prev) => ({ ...prev, [titleUrl]: false }));
      if (failed.length && !cancelAllRef.current) {
        alert(
          `${failed.length} chapter${failed.length === 1 ? '' : 's'} could not be saved:\n` +
            failed.slice(0, 8).join('\n') +
            (failed.length > 8 ? `\n…and ${failed.length - 8} more` : '')
        );
      }
    },
    [downloadChapter]
  );

  const cancelAll = useCallback((titleUrl) => {
    cancelAllRef.current = true;
    Object.values(abortRefs.current).forEach((abort) => abort?.abort());
    if (titleUrl) {
      setDownloadingAll((prev) => ({ ...prev, [titleUrl]: false }));
    } else {
      setDownloadingAll({});
    }
  }, []);

  return (
    <DownloadContext.Provider value={{ downloads, downloadingAll, downloadChapter, cancelDownload, downloadAll, cancelAll }}>
      {children}
    </DownloadContext.Provider>
  );
}

export function useDownloads() {
  return useContext(DownloadContext);
}
