import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getChapterImages } from '../db';

export default function Reader() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const { chapterUrl, titleUrl, chapters = [], startIndex = 0 } = state || {};

  const [images, setImages] = useState([]); // array of { src, isBlob }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showOverlay, setShowOverlay] = useState(true);
  const [currentChapterIdx, setCurrentChapterIdx] = useState(startIndex);
  const overlayTimer = useRef(null);
  const currentChapter = chapters[currentChapterIdx];

  useEffect(() => {
    if (!currentChapter) return;
    loadChapter(currentChapter);
  }, [currentChapterIdx]);

  // Auto-hide overlay after 3s
  useEffect(() => {
    if (showOverlay) {
      clearTimeout(overlayTimer.current);
      overlayTimer.current = setTimeout(() => setShowOverlay(false), 3000);
    }
    return () => clearTimeout(overlayTimer.current);
  }, [showOverlay]);

  async function loadChapter(chapter) {
    setLoading(true);
    setImages([]);
    setError('');

    try {
      // Try IndexedDB first (downloaded chapters)
      const blobs = await getChapterImages(chapter.url);
      if (blobs.length > 0) {
        setImages(blobs.map((blob) => ({ src: URL.createObjectURL(blob), isBlob: true })));
        setLoading(false);
        return;
      }

      // Fall back to streaming via proxy
      const res = await fetch(`/api/chapter?url=${encodeURIComponent(chapter.url)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { images: urls } = await res.json();
      if (!urls?.length) throw new Error('No images found for this chapter');

      setImages(
        urls.map((url) => ({
          src: `/api/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(chapter.url)}`,
          isBlob: false,
        }))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Cleanup blob URLs on unmount / chapter change
  useEffect(() => {
    return () => {
      images.forEach((img) => { if (img.isBlob) URL.revokeObjectURL(img.src); });
    };
  }, [images]);

  function toggleOverlay() {
    setShowOverlay((v) => !v);
  }

  function goToChapter(idx) {
    if (idx < 0 || idx >= chapters.length) return;
    window.scrollTo(0, 0);
    setCurrentChapterIdx(idx);
    setShowOverlay(true);
  }

  if (!currentChapter) {
    return (
      <div className="reader" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        <p>No chapter selected.</p>
      </div>
    );
  }

  return (
    <div className="reader" onClick={toggleOverlay}>
      {/* Top overlay */}
      <div className={`reader-overlay ${showOverlay ? '' : 'hidden'}`} onClick={(e) => e.stopPropagation()}>
        <button
          className="btn btn-ghost btn-icon"
          style={{ color: '#fff' }}
          onClick={() => navigate('/title', { state: { titleUrl } })}
        >
          ←
        </button>
        <span className="reader-title">{currentChapter.title}</span>
      </div>

      {/* Images */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50dvh' }}>
          <div className="spinner" style={{ width: 36, height: 36, borderWidth: 3 }} />
        </div>
      ) : error ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '50dvh', padding: 20 }}>
          <div className="error-banner">{error}</div>
        </div>
      ) : (
        <div className="reader-images">
          {images.map((img, i) => (
            <LazyImage key={img.src} src={img.src} index={i} />
          ))}
        </div>
      )}

      {/* Bottom overlay: chapter nav */}
      <div className={`reader-footer ${showOverlay ? '' : 'hidden'}`} onClick={(e) => e.stopPropagation()}>
        <button
          className="btn btn-secondary btn-sm"
          disabled={currentChapterIdx === 0}
          onClick={() => goToChapter(currentChapterIdx - 1)}
        >
          ← Prev
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {currentChapterIdx + 1} / {chapters.length}
        </span>
        <button
          className="btn btn-secondary btn-sm"
          disabled={currentChapterIdx >= chapters.length - 1}
          onClick={() => goToChapter(currentChapterIdx + 1)}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function LazyImage({ src, index }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(index < 3); // eagerly load first 3

  useEffect(() => {
    if (visible) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { rootMargin: '400px' }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={ref} className="reader-img" style={{ minHeight: visible ? 'auto' : '60vw' }}>
      {visible && <img src={src} alt={`Page ${index + 1}`} loading="lazy" />}
    </div>
  );
}
