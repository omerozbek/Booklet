import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Library from './pages/Library';
import TitleView from './pages/TitleView';
import Reader from './pages/Reader';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/title" element={<TitleView />} />
        <Route path="/read" element={<Reader />} />
      </Routes>
    </BrowserRouter>
  );
}
