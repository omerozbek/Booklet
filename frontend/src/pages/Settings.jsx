import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStorageByTitle } from '../db';

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function loadAutoDelete() {
  try {
    return JSON.parse(localStorage.getItem('auto-delete') || '{}');
  } catch {
    return {};
  }
}

export default function Settings() {
  const navigate = useNavigate();
  const [storage, setStorage] = useState([]);
  const [loadingStorage, setLoadingStorage] = useState(true);
  const [autoDelete, setAutoDelete] = useState(loadAutoDelete);

  const enabled = autoDelete.enabled || false;
  const delay = autoDelete.delay ?? 0;

  useEffect(() => {
    getStorageByTitle().then((data) => {
      setStorage(data);
      setLoadingStorage(false);
    });
  }, []);

  function saveAutoDelete(updates) {
    const next = { ...autoDelete, ...updates };
    setAutoDelete(next);
    localStorage.setItem('auto-delete', JSON.stringify(next));
  }

  const totalBytes = storage.reduce((sum, t) => sum + t.bytes, 0);

  return (
    <div className="page">
      <div className="topbar">
        <button className="btn btn-icon" onClick={() => navigate('/')}>←</button>
        <span className="topbar-title">Settings</span>
      </div>

      <div className="scroll-area">
        <section className="settings-section">
          <h2 className="settings-section-title">Auto-Delete</h2>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Auto-delete read chapters</div>
              <div className="settings-row-desc">
                {enabled
                  ? delay === 0
                    ? 'Deletes a chapter when you move to the next one'
                    : `Keeps ${delay} chapter${delay !== 1 ? 's' : ''} behind your current position`
                  : 'Off — chapters kept until manually deleted'}
              </div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => saveAutoDelete({ enabled: e.target.checked })}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {enabled && (
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Chapters to keep behind</div>
                <div className="settings-row-desc">
                  {delay === 0 ? 'Delete immediately on advance' : `Delete after ${delay} chapter${delay !== 1 ? 's' : ''} pass`}
                </div>
              </div>
              <div className="settings-stepper">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => saveAutoDelete({ delay: Math.max(0, delay - 1) })}
                >
                  −
                </button>
                <span className="settings-stepper-val">{delay}</span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => saveAutoDelete({ delay: delay + 1 })}
                >
                  +
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">Storage</h2>

          {loadingStorage ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
              <div className="spinner" />
            </div>
          ) : (
            <>
              <div className="settings-storage-total">
                Total used: <strong>{formatBytes(totalBytes)}</strong>
              </div>
              {storage.length === 0 && (
                <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No downloaded content.</p>
              )}
              {storage.map((t) => (
                <div key={t.url} className="settings-storage-row">
                  <div className="settings-row-text">
                    <div className="settings-row-label">{t.title || 'Unknown'}</div>
                    <div className="settings-row-desc">{t.downloadedChapters} chapter{t.downloadedChapters !== 1 ? 's' : ''} downloaded</div>
                  </div>
                  <span className="settings-storage-size">{formatBytes(t.bytes)}</span>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
