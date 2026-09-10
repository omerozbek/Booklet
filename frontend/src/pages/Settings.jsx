import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStorageByTitle, exportData, importData } from '../db';

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
  const [busy, setBusy] = useState(null); // 'export' | 'import' | null
  const [migrateMsg, setMigrateMsg] = useState('');
  const fileInputRef = useRef(null);

  const enabled = autoDelete.enabled || false;
  const delay = autoDelete.delay ?? 0;

  function refreshStorage() {
    return getStorageByTitle().then((data) => {
      setStorage(data);
      setLoadingStorage(false);
    });
  }

  useEffect(() => {
    refreshStorage();
  }, []);

  async function handleExport() {
    setBusy('export');
    setMigrateMsg('');
    try {
      const blob = await exportData();
      if (blob.size <= 4) {
        setMigrateMsg('Nothing to export yet.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `manhwa-backup-${date}.manhwabak`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setMigrateMsg(`Exported ${formatBytes(blob.size)}. Save it, then import on the other URL.`);
    } catch (err) {
      setMigrateMsg(`Export failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    setBusy('import');
    setMigrateMsg('Reading backup…');
    try {
      const result = await importData(file, (done, total) => {
        setMigrateMsg(`Importing images… ${done}/${total}`);
      });
      await refreshStorage();
      setMigrateMsg(
        `Imported ${result.titles} title${result.titles !== 1 ? 's' : ''}, ` +
          `${result.chapters} chapter${result.chapters !== 1 ? 's' : ''}, ` +
          `${result.images} image${result.images !== 1 ? 's' : ''}` +
          ` — reading progress included.`
      );
    } catch (err) {
      setMigrateMsg(`Import failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  }

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

        <section className="settings-section">
          <h2 className="settings-section-title">Backup &amp; Migrate</h2>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Move downloads to another URL</div>
              <div className="settings-row-desc">
                Downloads are stored per-URL. If you open the app from a different
                address (new IP, or :5173 vs :3001), export here, then import on the
                other URL. Everything moves with it: downloaded chapters, read /
                in-progress marks, scroll positions, and the Continue button.
                Importing merges — it won't erase existing downloads.
              </div>
            </div>
          </div>

          <div className="settings-row" style={{ gap: 10 }}>
            <button
              className="btn btn-secondary"
              onClick={handleExport}
              disabled={busy !== null}
            >
              {busy === 'export' ? 'Exporting…' : 'Export'}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy !== null}
            >
              {busy === 'import' ? 'Importing…' : 'Import'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleImportFile}
              style={{ display: 'none' }}
            />
          </div>

          {migrateMsg && (
            <div className="settings-row-desc" style={{ padding: '0 4px' }}>
              {migrateMsg}
            </div>
          )}
        </section>

        <section className="settings-section">
          <h2 className="settings-section-title">About</h2>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Version</div>
              <div className="settings-row-desc">
                Built {new Date(__BUILD_TIME__).toLocaleString()}
              </div>
            </div>
            <span className="settings-storage-size">
              v{__APP_VERSION__}{__GIT_COMMIT__ && ` (${__GIT_COMMIT__})`}
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
