import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DownloadProvider } from './context/DownloadContext';
import { migrateLegacyPages, pruneOrphanPages } from './db';
import Library from './pages/Library';
import TitleView from './pages/TitleView';
import Reader from './pages/Reader';
import Settings from './pages/Settings';

export default function App() {
  useEffect(() => {
    // Moves downloads out of the old single database, then sweeps page
    // databases left behind by interrupted deletes. Both resume where they stopped.
    migrateLegacyPages()
      .then(() => pruneOrphanPages())
      .catch(() => {});
  }, []);

  return (
    <DownloadProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/title" element={<TitleView />} />
          <Route path="/read" element={<Reader />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </BrowserRouter>
    </DownloadProvider>
  );
}
