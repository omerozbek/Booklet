import { createContext, useContext, useRef, useState, useCallback } from 'react';
import { saveImage, saveChapterMeta } from '../db';

const DownloadContext = createContext(null);

export function DownloadProvider({ children }) {
  const [downloads, setDownloads] = useState({});
  const [downloadingAll, setDownloadingAll] = useState({});
  const abortRefs = useRef({});
  const cancelAllRef = useRef(false);

  const downloadChapter = useCallback(async (chapter, onComplete) => {
    if (abortRefs.current[chapter.url]) return;

    try {
      const res = await fetch(`/api/chapter?url=${encodeURIComponent(chapter.url)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { images } = await res.json();
      if (!images?.length) throw new Error('No images found');

      const abort = new AbortController();
      abortRefs.current[chapter.url] = abort;

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

      if (!abort.signal.aborted) {
        const updated = { ...chapter, downloaded: true, imageCount: images.length };
        await saveChapterMeta(updated);
        onComplete?.(updated);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        alert(`Download failed: ${err.message}`);
      }
    } finally {
      setDownloads((prev) => {
        const next = { ...prev };
        delete next[chapter.url];
        return next;
      });
      delete abortRefs.current[chapter.url];
    }
  }, []);

  const cancelDownload = useCallback((chapterUrl) => {
    abortRefs.current[chapterUrl]?.abort();
  }, []);

  const downloadAll = useCallback(
    async (chapters, titleUrl, onChapterComplete) => {
      cancelAllRef.current = false;
      setDownloadingAll((prev) => ({ ...prev, [titleUrl]: true }));
      const toDownload = chapters.filter((c) => !c.downloaded && !abortRefs.current[c.url]);
      for (const ch of toDownload) {
        if (cancelAllRef.current) break;
        await downloadChapter(ch, onChapterComplete);
      }
      setDownloadingAll((prev) => ({ ...prev, [titleUrl]: false }));
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
