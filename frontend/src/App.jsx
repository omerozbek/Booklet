import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DownloadProvider } from './context/DownloadContext';
import Library from './pages/Library';
import TitleView from './pages/TitleView';
import Reader from './pages/Reader';
import Settings from './pages/Settings';

export default function App() {
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
