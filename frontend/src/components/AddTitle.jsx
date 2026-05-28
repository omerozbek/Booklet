import { useState } from 'react';
import { saveTitleMeta, saveChapterMeta } from '../db';

export default function AddTitle({ onClose, onAdded }) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(null); // { current, total }
  const [error, setError] = useState('');

  async function handleAdd() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError('');
    setLoading(true);
    setStatus('Fetching title info…');
    setProgress(null);

    try {
      const res = await fetch(`/api/title?url=${encodeURIComponent(trimmed)}`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.title && !data.chapters?.length) throw new Error('Could not find any content at this URL. Try a different link.');

      setStatus('Saving title…');
      const titleMeta = { url: trimmed, ...data, chapters: undefined };
      await saveTitleMeta(titleMeta);

      const chapters = data.chapters || [];
      setStatus(`Saving chapters…`);
      setProgress({ current: 0, total: chapters.length });
      for (let i = 0; i < chapters.length; i++) {
        await saveChapterMeta({ ...chapters[i], titleUrl: trimmed, downloaded: false, imageCount: 0 });
        setProgress({ current: i + 1, total: chapters.length });
      }

      onAdded(titleMeta);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setStatus('');
      setProgress(null);
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter') handleAdd();
    if (e.key === 'Escape') onClose();
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Add a Title</h2>

        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          Paste the URL of the title page (e.g. <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 4, fontSize: 11 }}>comix.to/title/…</code>)
        </p>

        <input
          className="input"
          type="url"
          placeholder="https://comix.to/title/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleKey}
          autoFocus
          style={{ marginBottom: 12 }}
        />

        {loading && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>{status}</div>
            {progress && (
              <>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textAlign: 'right' }}>
                  {progress.current} / {progress.total}
                </div>
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleAdd} disabled={loading || !url.trim()}>
            {loading ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Adding…</> : 'Add Title'}
          </button>
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
