import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAllTitles, deleteTitle, subscribeStorageMigration } from '../db';
import AddTitle from '../components/AddTitle';
import logoUrl from '/icon.svg';

export default function Library() {
  const [titles, setTitles] = useState(null); // null until the library has loaded
  const [loadError, setLoadError] = useState('');
  const [migration, setMigration] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [lastRead, setLastRead] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // title awaiting confirmation
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  const loadTitles = useCallback(async () => {
    setLoadError('');
    try {
      setTitles(await getAllTitles());
    } catch (err) {
      setLoadError(err.message || String(err));
    }
  }, []);

  useEffect(() => subscribeStorageMigration(setMigration), []);

  useEffect(() => {
    loadTitles();
    try {
      const lr = localStorage.getItem('last-read');
      if (lr) setLastRead(JSON.parse(lr));
    } catch {}
  }, [loadTitles]);

  // Confirmation is an in-app sheet rather than window.confirm(): native
  // dialogs aren't dependable in a Home Screen web app on iOS, and a dialog
  // that never appears reads as a delete button that does nothing.
  function askDelete(e, title) {
    e.preventDefault();
    e.stopPropagation();
    setPendingDelete(title);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const { url } = pendingDelete;
    setDeleting(true);
    try {
      await deleteTitle(url);
      setTitles((prev) => (prev || []).filter((t) => t.url !== url));
      if (lastRead?.titleUrl === url) setLastRead(null);
      setPendingDelete(null);
    } catch (err) {
      alert(`Could not delete: ${err.message}`);
    } finally {
      setDeleting(false);
    }
  }

  const lastReadTitle = lastRead && titles ? titles.find((t) => t.url === lastRead.titleUrl) : null;

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

        {migration?.state === 'running' && migration.total > 0 && (
          <div className="stale-banner">
            Moving your downloads to faster storage… {migration.moved}/{migration.total}.
            Keep the app open until it finishes — reading still works meanwhile.
          </div>
        )}
        {migration?.state === 'stalled' && (
          <div className="stale-banner" onClick={() => navigate('/settings')}>
            Couldn't finish moving your downloads. <strong>Open Settings</strong> for details.
          </div>
        )}

        {loadError ? (
          <div className="error-banner">
            Couldn't open your library: {loadError}
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-secondary btn-sm" onClick={loadTitles}>Try again</button>
            </div>
          </div>
        ) : titles === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <div className="spinner" />
          </div>
        ) : titles.length === 0 ? (
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
                    onClick={(e) => askDelete(e, t)}
                    title="Delete title"
                    aria-label={`Delete ${t.title || 'title'}`}
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

      {pendingDelete && (
        <div className="sheet-backdrop" onClick={() => !deleting && setPendingDelete(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Remove title?</h2>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--text)' }}>{pendingDelete.title || 'This title'}</strong> and
              all of its downloaded chapters will be deleted from this device.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={confirmDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <AddTitle
          onClose={() => setShowAdd(false)}
          onAdded={(title) => {
            setTitles((prev) => {
              const list = prev || [];
              return list.some((t) => t.url === title.url) ? list : [...list, title];
            });
          }}
        />
      )}
    </div>
  );
}
