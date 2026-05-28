import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAllTitles, deleteTitle } from '../db';
import AddTitle from '../components/AddTitle';

export default function Library() {
  const [titles, setTitles] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const navigate = useNavigate();

  const loadTitles = useCallback(async () => {
    setTitles(await getAllTitles());
  }, []);

  useEffect(() => { loadTitles(); }, [loadTitles]);

  async function handleDelete(e, url) {
    e.stopPropagation();
    if (!confirm('Remove this title and all downloaded chapters?')) return;
    await deleteTitle(url);
    setTitles((prev) => prev.filter((t) => t.url !== url));
  }

  return (
    <div className="page">
      <div className="topbar">
        <span className="topbar-title">Manhwa Reader</span>
        <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>
          + Add
        </button>
      </div>

      <div className="scroll-area">
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
