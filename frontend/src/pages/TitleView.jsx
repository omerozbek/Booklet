import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  getTitle,
  saveTitleMeta,
  getChaptersForTitle,
  saveChapterMeta,
  getChapterImages,
  saveImage,
  deleteChapterImages,
} from '../db';

export default function TitleView() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const titleUrl = state?.titleUrl;

  const [meta, setMeta] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [downloading, setDownloading] = useState({}); // chapterUrl → { current, total }
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [error, setError] = useState('');
  const [showEditNames, setShowEditNames] = useState(false);
  const [namePrefix, setNamePrefix] = useState('');
  const abortRefs = useRef({});
  const cancelAllRef = useRef(false);

  // Load from IndexedDB then refresh from network
  useEffect(() => {
    if (!titleUrl) return;
    loadData();
  }, [titleUrl]);

  async function loadData() {
    // Show cached data immediately
    const cached = await getTitle(titleUrl);
    if (cached) setMeta(cached);

    const cachedChapters = await getChaptersForTitle(titleUrl);
    if (cachedChapters.length) setChapters(cachedChapters);

    // Refresh from network
    try {
      const res = await fetch(`/api/title?url=${encodeURIComponent(titleUrl)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const titleMeta = { url: titleUrl, ...data, chapters: undefined };
      await saveTitleMeta(titleMeta);
      setMeta(titleMeta);

      // Merge chapters with download status from DB
      const existing = Object.fromEntries(cachedChapters.map((c) => [c.url, c]));
      const merged = (data.chapters || []).map((ch) => ({
        ...ch,
        titleUrl,
        title: existing[ch.url]?.titleEdited ? existing[ch.url].title : ch.title,
        titleEdited: existing[ch.url]?.titleEdited || false,
        downloaded: existing[ch.url]?.downloaded || false,
        imageCount: existing[ch.url]?.imageCount || 0,
        readStatus: existing[ch.url]?.readStatus,
        lastReadAt: existing[ch.url]?.lastReadAt,
      }));

      for (const ch of merged) {
        if (!existing[ch.url]) await saveChapterMeta(ch);
      }
      setChapters(merged);
    } catch (err) {
      if (!meta) setError(err.message);
    }
  }

  async function downloadChapter(chapter) {
    if (downloading[chapter.url]) return;

    try {
      // Fetch image URL list
      const res = await fetch(`/api/chapter?url=${encodeURIComponent(chapter.url)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { images } = await res.json();
      if (!images?.length) throw new Error('No images found in this chapter');

      const abort = new AbortController();
      abortRefs.current[chapter.url] = abort;

      setDownloading((prev) => ({ ...prev, [chapter.url]: { current: 0, total: images.length } }));

      for (let i = 0; i < images.length; i++) {
        if (abort.signal.aborted) break;
        const proxyUrl = `/api/proxy?url=${encodeURIComponent(images[i])}&referer=${encodeURIComponent(chapter.url)}`;

        const imgRes = await fetch(proxyUrl, { signal: abort.signal });
        if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
        const blob = await imgRes.blob();
        await saveImage(chapter.url, i, blob);
        setDownloading((prev) => ({
          ...prev,
          [chapter.url]: { current: i + 1, total: images.length },
        }));
      }

      if (!abort.signal.aborted) {
        const updated = { ...chapter, downloaded: true, imageCount: images.length };
        await saveChapterMeta(updated);
        setChapters((prev) => prev.map((c) => (c.url === chapter.url ? updated : c)));
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        alert(`Download failed: ${err.message}`);
      }
    } finally {
      setDownloading((prev) => {
        const next = { ...prev };
        delete next[chapter.url];
        return next;
      });
      delete abortRefs.current[chapter.url];
    }
  }

  async function downloadAll() {
    cancelAllRef.current = false;
    setDownloadingAll(true);
    const toDownload = chapters.filter((c) => !c.downloaded && !downloading[c.url]);
    for (const ch of toDownload) {
      if (cancelAllRef.current) break;
      await downloadChapter(ch);
    }
    setDownloadingAll(false);
  }

  function cancelDownloadAll() {
    cancelAllRef.current = true;
    Object.keys(abortRefs.current).forEach((url) => abortRefs.current[url]?.abort());
    setDownloadingAll(false);
  }

  function cancelDownload(chapterUrl) {
    abortRefs.current[chapterUrl]?.abort();
  }

  async function deleteChapter(chapter) {
    await deleteChapterImages(chapter.url);
    setChapters((prev) =>
      prev.map((c) => (c.url === chapter.url ? { ...c, downloaded: false, imageCount: 0 } : c))
    );
  }

  function openEditNames() {
    const titles = chapters.map((c) => c.title || '');
    if (!titles.length) return;
    let prefix = titles[0];
    for (const t of titles.slice(1)) {
      while (prefix && !t.startsWith(prefix)) prefix = prefix.slice(0, -1);
      if (!prefix) break;
    }
    setNamePrefix(prefix);
    setShowEditNames(true);
  }

  async function applyNamePrefix() {
    if (!namePrefix) return;
    const updated = chapters.map((ch) => ({
      ...ch,
      title: ch.title.startsWith(namePrefix) ? ch.title.slice(namePrefix.length).trim() : ch.title,
      titleEdited: true,
    }));
    for (const ch of updated) await saveChapterMeta(ch);
    setChapters(updated);
    setShowEditNames(false);
  }

  function openReader(chapter, index) {
    navigate('/read', {
      state: { chapterUrl: chapter.url, titleUrl, chapters, startIndex: index },
    });
  }

  if (!titleUrl) return <div className="page"><div className="scroll-area"><p>No title selected.</p></div></div>;

  const downloadedCount = chapters.filter((c) => c.downloaded).length;

  return (
    <div className="page">
      <div className="topbar">
        <button className="btn btn-icon" onClick={() => navigate('/')}>
          ←
        </button>
        <span className="topbar-title">{meta?.title || 'Loading…'}</span>
      </div>

      <div className="scroll-area">
        {error && <div className="error-banner">{error}</div>}

        {meta && (
          <div className="title-hero">
            <div className="title-cover">
              {meta.coverUrl ? (
                <img
                  src={`/api/proxy?url=${encodeURIComponent(meta.coverUrl)}&referer=${encodeURIComponent(titleUrl)}`}
                  alt={meta.title}
                />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 40 }}>📖</div>
              )}
            </div>
            <div className="title-meta">
              <h1>{meta.title}</h1>
              {meta.status && <div className="tag" style={{ marginBottom: 6 }}>{meta.status}</div>}
              {(meta.genres || []).map((g) => <span key={g} className="tag">{g}</span>)}
              {meta.synopsis && (
                <p className="synopsis" style={{ marginTop: 8 }}>{meta.synopsis.slice(0, 200)}{meta.synopsis.length > 200 ? '…' : ''}</p>
              )}
            </div>
          </div>
        )}

        {chapters.length > 0 && (
          <>
            <div className="chapter-actions">
              {downloadingAll ? (
                <button className="btn btn-secondary btn-sm" onClick={cancelDownloadAll}>
                  Cancel Download
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={downloadAll}>
                  Download All ({chapters.length - downloadedCount} left)
                </button>
              )}
              {downloadedCount > 0 && (
                <span style={{ fontSize: 13, color: 'var(--text-muted)', alignSelf: 'center' }}>
                  {downloadedCount}/{chapters.length} saved
                </span>
              )}
              <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={openEditNames}>
                Edit Names
              </button>
            </div>

            <div className="chapter-list">
              {chapters.map((ch, idx) => {
                const dl = downloading[ch.url];
                return (
                  <div key={ch.url} className="chapter-row">
                    <div className="chapter-row-info" onClick={() => openReader(ch, idx)} style={{ cursor: 'pointer' }}>
                      <div className="chapter-row-title">{ch.title}</div>
                      {ch.date && <div className="chapter-row-date">{ch.date}</div>}
                      {dl && (
                        <div className="progress-bar">
                          <div className="progress-fill" style={{ width: `${(dl.current / dl.total) * 100}%` }} />
                        </div>
                      )}
                    </div>

                    {ch.readStatus === 'completed' && (
                      <span className="chapter-row-badge badge-completed" title="Completed">✓</span>
                    )}
                    {ch.readStatus === 'reading' && (
                      <span className="chapter-row-badge badge-reading" title="In progress">●</span>
                    )}

                    {ch.downloaded ? (
                      <>
                        <span className="chapter-row-badge badge-downloaded">Saved</span>
                        <button className="btn btn-primary btn-sm" onClick={() => openReader(ch, idx)}>Read</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => deleteChapter(ch)} title="Delete">✕</button>
                      </>
                    ) : dl ? (
                      <>
                        <span className="chapter-row-badge badge-downloading">{dl.current}/{dl.total}</span>
                        <button className="btn btn-secondary btn-sm" onClick={() => cancelDownload(ch.url)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn btn-secondary btn-sm" onClick={() => downloadChapter(ch)}>↓ Save</button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {!meta && !error && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <div className="spinner" />
          </div>
        )}
      </div>

      {showEditNames && (
        <div className="sheet-backdrop" onClick={() => setShowEditNames(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Edit Chapter Names</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
              Remove this text from the start of every chapter name:
            </p>
            <input
              className="input"
              value={namePrefix}
              onChange={(e) => setNamePrefix(e.target.value)}
              placeholder="Prefix to remove…"
              autoFocus
            />

            {namePrefix && (
              <div style={{ marginTop: 14 }}>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Preview (first 3):</p>
                {chapters.slice(0, 3).map((ch) => {
                  const after = ch.title.startsWith(namePrefix)
                    ? ch.title.slice(namePrefix.length).trim()
                    : ch.title;
                  return (
                    <div key={ch.url} style={{ fontSize: 13, marginBottom: 6, lineHeight: 1.4 }}>
                      <span style={{ color: 'var(--text-muted)', textDecoration: 'line-through' }}>{ch.title}</span>
                      <br />
                      <span style={{ color: 'var(--text)' }}>→ {after || <em style={{ color: 'var(--accent)' }}>(empty)</em>}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowEditNames(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={!namePrefix}
                onClick={applyNamePrefix}
              >
                Apply to All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
