import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAllTitles, deleteTitle } from '../db';
import AddTitle from '../components/AddTitle';
import logoUrl from '/icon.svg';

export default function Library() {
  const [titles, setTitles] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [lastRead, setLastRead] = useState(null);
  const navigate = useNavigate();

  const loadTitles = useCallback(async () => {
    setTitles(await getAllTitles());
  }, []);

  useEffect(() => {
    loadTitles();
    try {
      const lr = localStorage.getItem('last-read');
      if (lr) setLastRead(JSON.parse(lr));
    } catch {}
  }, [loadTitles]);

  async function handleDelete(e, url) {
    e.stopPropagation();
    if (!confirm('Remove this title and all downloaded chapters?')) return;
    await deleteTitle(url);
    setTitles((prev) => prev.filter((t) => t.url !== url));
  }

  const lastReadTitle = lastRead ? titles.find((t) => t.url === lastRead.titleUrl) : null;

  return (
    <div className="page">
      <div className="topbar">
        <span className="topbar-title">
          <img src={logoUrl} alt="" className="topbar-logo" />
          Booklet
        </span>
        <button
          className="btn btn-ghost btn-sm"
          style={{ fontSize: 18, padding: '4px 8px' }}
          onClick={() => navigate('/settings')}
          title="Settings"
        >
          ⚙
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>
          + Add
        </button>
      </div>

      <div className="scroll-area">
        {lastRead && lastReadTitle && (
          <div
            className="continue-banner"
            onClick={() => navigate('/read', { state: { chapterUrl: lastRead.chapterUrl, titleUrl: lastRead.titleUrl } })}
          >
            <div className="continue-info">
              <span className="continue-label">Continue Reading</span>
              <span className="continue-title-name">{lastReadTitle.title}</span>
              <span className="continue-chapter-name">{lastRead.chapterTitle}</span>
            </div>
            <span className="continue-arrow">▶</span>
          </div>
        )}

        {titles.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📚</div>
            <p>No titles yet.<br />Tap <strong>+ Add</strong> and paste a manhwa URL to get started.</p>
          </div>
        ) : (
          <div className="title-grid">
            {titles.map((t) => (
              <div
                key={t.url}
                className="title-card"
                onClick={() => navigate('/title', { state: { titleUrl: t.url } })}
              >
                <div className="title-card-cover-wrap">
                  {t.coverUrl ? (
                    <img
                      className="title-card-cover"
                      src={`/api/proxy?url=${encodeURIComponent(t.coverUrl)}&referer=${encodeURIComponent(t.url)}`}
                      alt={t.title}
                      loading="lazy"
                    />
                  ) : (
                    <div className="title-card-cover-placeholder">📖</div>
                  )}
                  <button
                    className="title-card-delete"
                    onClick={(e) => handleDelete(e, t.url)}
                    title="Delete title"
                  >
                    ✕
                  </button>
                </div>
                <div className="title-card-name">{t.title || 'Untitled'}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAdd && (
        <AddTitle
          onClose={() => setShowAdd(false)}
          onAdded={(title) => {
            setTitles((prev) => {
              const exists = prev.some((t) => t.url === title.url);
              return exists ? prev : [...prev, title];
            });
          }}
        />
      )}
    </div>
  );
}
