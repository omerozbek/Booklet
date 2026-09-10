import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  getTitle,
  saveTitleMeta,
  getChaptersForTitle,
  saveChapterMeta,
  syncTitleChapters,
  deleteChapterImages,
} from '../db';
import { useDownloads } from '../context/DownloadContext';

export default function TitleView() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const titleUrl = state?.titleUrl;

  const [meta, setMeta] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [error, setError] = useState('');
  const [showEditNames, setShowEditNames] = useState(false);
  const [namePrefix, setNamePrefix] = useState('');

  const chapterRowRefs = useRef({});
  const hasAutoScrolled = useRef(false);

  const { downloads, downloadingAll, downloadChapter, cancelDownload, downloadAll, cancelAll } = useDownloads();

  useEffect(() => {
    if (!titleUrl) return;
    hasAutoScrolled.current = false;
    loadData();
  }, [titleUrl]);

  // Auto-scroll to last read chapter once chapters are available
  useEffect(() => {
    if (!chapters.length || hasAutoScrolled.current) return;
    const lastRead = chapters.reduce((best, ch) => {
      if (!ch.lastReadAt) return best;
      if (!best || ch.lastReadAt > best.lastReadAt) return ch;
      return best;
    }, null);
    if (lastRead && chapterRowRefs.current[lastRead.url]) {
      hasAutoScrolled.current = true;
      setTimeout(() => {
        chapterRowRefs.current[lastRead.url]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 150);
    }
  }, [chapters]);

  async function loadData() {
    const cached = await getTitle(titleUrl);
    if (cached) setMeta(cached);

    const cachedChapters = await getChaptersForTitle(titleUrl);
    if (cachedChapters.length) setChapters(cachedChapters);

    try {
      const res = await fetch(`/api/title?url=${encodeURIComponent(titleUrl)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const titleMeta = { url: titleUrl, ...data, chapters: undefined };
      await saveTitleMeta(titleMeta);
      setMeta(titleMeta);

      // Matching on chapter number (not URL), collapsing duplicates, and
      // keeping chapters the scrape missed all live in syncTitleChapters.
      setChapters(await syncTitleChapters(titleUrl, data.chapters || []));
    } catch (err) {
      if (!meta) setError(err.message);
    }
  }

  function onChapterDownloaded(updated) {
    setChapters((prev) => prev.map((c) => (c.url === updated.url ? { ...c, downloaded: true, imageCount: updated.imageCount } : c)));
  }

  function handleDownloadChapter(chapter) {
    downloadChapter(chapter, onChapterDownloaded);
  }

  function handleDownloadAll() {
    downloadAll(chapters, titleUrl, onChapterDownloaded);
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

  if (!titleUrl) {
    return (
      <div className="page">
        <div className="scroll-area">
          <p>No title selected.</p>
        </div>
      </div>
    );
  }

  const isDownloadingAll = downloadingAll[titleUrl] || false;
  const downloadedCount = chapters.filter((c) => c.downloaded).length;

  const lastReadChapter = chapters.reduce((best, ch, idx) => {
    if (!ch.lastReadAt) return best;
    if (!best || ch.lastReadAt > best.ch.lastReadAt) return { ch, idx };
    return best;
  }, null);

  return (
    <div className="page title-view-page">
      <div className="topbar">
        <button className="btn btn-icon" onClick={() => navigate('/')}>←</button>
        <span className="topbar-title">{meta?.title || 'Loading…'}</span>
      </div>

      <div className="title-view-header">
        {error && <div className="error-banner">{error}</div>}

        {meta ? (
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
                <p className="synopsis" style={{ marginTop: 8 }}>
                  {meta.synopsis.slice(0, 200)}{meta.synopsis.length > 200 ? '…' : ''}
                </p>
              )}
            </div>
          </div>
        ) : !error ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}>
            <div className="spinner" />
          </div>
        ) : null}

        {chapters.length > 0 && (
          <div className="chapter-actions">
            {lastReadChapter && (
              <button
                className="btn btn-accent btn-sm"
                onClick={() => openReader(lastReadChapter.ch, lastReadChapter.idx)}
              >
                ▶ Continue
              </button>
            )}
            {isDownloadingAll ? (
              <button className="btn btn-secondary btn-sm" onClick={() => cancelAll(titleUrl)}>
                Cancel
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={handleDownloadAll}>
                Download All {downloadedCount > 0 ? `${downloadedCount}/${chapters.length}` : ''}
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={openEditNames}>
              Edit Names
            </button>
          </div>
        )}
      </div>

      <div className="scroll-area">
        <div className="chapter-list">
          {chapters.map((ch, idx) => {
            const dl = downloads[ch.url];
            return (
              <div
                key={ch.url}
                className="chapter-row"
                ref={(el) => { chapterRowRefs.current[ch.url] = el; }}
              >
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
                  <button className="btn btn-secondary btn-sm" onClick={() => handleDownloadChapter(ch)}>↓ Save</button>
                )}
              </div>
            );
          })}
        </div>
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
