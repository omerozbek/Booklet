import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  getChapterImages,
  saveChapterReadStatus,
  getChaptersForTitle,
  deleteChapterImages,
  getScrollPosition,
  setScrollPosition,
} from '../db';

const CIRCUMFERENCE = 2 * Math.PI * 20;

export default function Reader() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const { chapterUrl, titleUrl, chapters: navChapters = [], startIndex = 0 } = state || {};

  const [chapters, setChapters] = useState(navChapters);
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showOverlay, setShowOverlay] = useState(true);
  const [currentChapterIdx, setCurrentChapterIdx] = useState(startIndex);
  const [nextProgress, setNextProgress] = useState(0);

  const overlayTimer = useRef(null);
  const nextTriggerRef = useRef(false);
  const nextProgressRef = useRef(0);
  const scrollRestoredRef = useRef(false);
  const scrollSaveTimer = useRef(null);
  // Last position the user actually scrolled to, tagged with its chapter url
  // so it can never be saved under a different chapter's key.
  const lastPosRef = useRef(null);
  const imagesContainerRef = useRef(null);
  const chaptersLoadedRef = useRef(navChapters.length > 0);

  const currentChapter = chapters[currentChapterIdx];
  const hasNext = currentChapterIdx < chapters.length - 1;

  // Load chapters from DB if navigated without a chapter list (e.g. from "Continue" button)
  useEffect(() => {
    if (chaptersLoadedRef.current || !titleUrl) return;
    getChaptersForTitle(titleUrl).then((chs) => {
      chaptersLoadedRef.current = true;
      setChapters(chs);
      if (chapterUrl) {
        const idx = chs.findIndex((c) => c.url === chapterUrl);
        if (idx >= 0 && idx !== currentChapterIdx) {
          setCurrentChapterIdx(idx);
        }
      }
    });
  }, []);

  // Load chapter images whenever the current chapter changes
  useEffect(() => {
    scrollRestoredRef.current = false;
    nextTriggerRef.current = false;
    lastPosRef.current = null;
    setNextProgress(0);
    if (!currentChapter) return;
    loadChapter(currentChapter);
  }, [currentChapterIdx, currentChapter?.url]);

  // Topmost visible image (index + how far into it we've scrolled). Anchoring
  // on an image survives lazy-load layout shifts, unlike a raw pixel offset.
  function captureAnchor() {
    const container = imagesContainerRef.current;
    if (!container) return null;
    const wrappers = container.querySelectorAll('.reader-img');
    for (let i = 0; i < wrappers.length; i++) {
      const rect = wrappers[i].getBoundingClientRect();
      if (rect.bottom > 0) {
        const frac = rect.height > 0 ? Math.max(0, -rect.top / rect.height) : 0;
        return { index: i, frac };
      }
    }
    return null;
  }

  // Restore scroll position after images load
  useEffect(() => {
    if (loading || !images.length || scrollRestoredRef.current || !currentChapter) return;
    scrollRestoredRef.current = true;
    const saved = getScrollPosition(currentChapter.url);
    const hasPosition = saved && (saved.index > 0 || saved.frac > 0 || saved.y > 0);
    if (!hasPosition) {
      window.scrollTo(0, 0); // fresh chapter always starts at the top
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const cancel = () => { cancelled = true; };

    function target() {
      if (saved.index != null) {
        const el = imagesContainerRef.current?.querySelectorAll('.reader-img')[saved.index];
        if (el) {
          const rect = el.getBoundingClientRect();
          return window.scrollY + rect.top + (saved.frac || 0) * rect.height;
        }
      }
      return saved.y || 0; // legacy pixel-only positions
    }

    // Images load in and change layout for a while, so keep correcting the
    // position until it settles — but stop as soon as the user scrolls.
    function settle() {
      if (cancelled) return;
      const t = target();
      if (Math.abs(window.scrollY - t) > 2) window.scrollTo(0, t);
      if (++attempts < 25) setTimeout(settle, 120);
    }

    window.addEventListener('touchstart', cancel, { once: true, passive: true });
    window.addEventListener('wheel', cancel, { once: true, passive: true });
    setTimeout(settle, 50);
    return () => {
      cancelled = true;
      window.removeEventListener('touchstart', cancel);
      window.removeEventListener('wheel', cancel);
    };
  }, [loading, images.length]);

  // Save scroll position on scroll (debounced) and when navigating away or app is hidden
  useEffect(() => {
    if (loading || !currentChapter) return;
    const url = currentChapter.url;

    function save() {
      const pos = lastPosRef.current;
      if (!pos || pos.url !== url) return; // never write another chapter's position
      setScrollPosition(url, { y: pos.y, index: pos.index, frac: pos.frac });
    }

    function onScroll() {
      // Ignore programmatic scrolls while a chapter is loading/restoring;
      // only positions the user actually scrolled to get recorded.
      if (!scrollRestoredRef.current) return;
      const anchor = captureAnchor();
      lastPosRef.current = {
        url,
        y: window.scrollY,
        index: anchor ? anchor.index : null,
        frac: anchor ? anchor.frac : 0,
      };
      clearTimeout(scrollSaveTimer.current);
      scrollSaveTimer.current = setTimeout(save, 300);
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        clearTimeout(scrollSaveTimer.current);
        save();
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(scrollSaveTimer.current);
      save(); // save using lastPosRef, not window.scrollY (which may already be 0)
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loading, currentChapter?.url]);

  // Track last read chapter for the Library "Continue" button
  useEffect(() => {
    if (!currentChapter || !titleUrl) return;
    localStorage.setItem(
      'last-read',
      JSON.stringify({ chapterUrl: currentChapter.url, chapterTitle: currentChapter.title, titleUrl })
    );
  }, [currentChapter?.url, titleUrl]);

  useEffect(() => {
    if (showOverlay) {
      clearTimeout(overlayTimer.current);
      overlayTimer.current = setTimeout(() => setShowOverlay(false), 3000);
    }
    return () => clearTimeout(overlayTimer.current);
  }, [showOverlay]);

  // Scroll-to-next detection
  useEffect(() => {
    if (loading || !hasNext) return;
    const ZONE = 240;

    function onScroll() {
      const scrolled = window.scrollY + window.innerHeight;
      const total = document.documentElement.scrollHeight;
      const raw = (scrolled - (total - ZONE)) / ZONE;
      const progress = Math.max(0, Math.min(1, raw));
      setNextProgress(progress);
      nextProgressRef.current = progress;
    }

    function onTouchEnd() {
      if (nextProgressRef.current >= 1 && !nextTriggerRef.current) {
        nextTriggerRef.current = true;
        saveChapterReadStatus(currentChapter.url, 'completed');
        goToChapter(currentChapterIdx + 1, true);
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [loading, currentChapterIdx, chapters.length, hasNext, images.length]);

  useEffect(() => {
    return () => {
      images.forEach((img) => { if (img.isBlob) URL.revokeObjectURL(img.src); });
    };
  }, [images]);

  async function loadChapter(chapter) {
    setLoading(true);
    setImages([]);
    setError('');
    saveChapterReadStatus(chapter.url, 'reading');

    try {
      const blobs = await getChapterImages(chapter.url);
      if (blobs.length > 0) {
        setImages(blobs.map((blob) => ({ src: URL.createObjectURL(blob), isBlob: true })));
        setLoading(false);
        return;
      }

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

  function triggerAutoDelete(fromIdx) {
    try {
      const settings = JSON.parse(localStorage.getItem('auto-delete') || '{}');
      if (!settings.enabled) return;
      const delay = settings.delay ?? 0;
      const deleteIdx = fromIdx - delay;
      if (deleteIdx >= 0 && chapters[deleteIdx]?.downloaded) {
        deleteChapterImages(chapters[deleteIdx].url);
      }
    } catch {}
  }

  function toggleOverlay() {
    setShowOverlay((v) => !v);
  }

  function goToChapter(idx, completed = false) {
    if (idx < 0 || idx >= chapters.length) return;
    if (completed) {
      triggerAutoDelete(currentChapterIdx);
      // Finished chapters restart from the top if reopened
      if (currentChapter) setScrollPosition(currentChapter.url, { y: 0, index: 0, frac: 0 });
      lastPosRef.current = null;
    }
    // Stop recording scroll events until the next chapter has restored,
    // so the scroll-to-top below can't be saved as a reading position.
    scrollRestoredRef.current = false;
    window.scrollTo(0, 0);
    setCurrentChapterIdx(idx);
    setShowOverlay(true);
  }

  if (!currentChapter && chapters.length === 0) {
    return (
      <div className="reader" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        <p>No chapter selected.</p>
      </div>
    );
  }

  if (!currentChapter) {
    return (
      <div className="reader" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="spinner" style={{ width: 36, height: 36, borderWidth: 3 }} />
      </div>
    );
  }

  return (
    <div className="reader" onClick={toggleOverlay}>
      <div className={`reader-overlay ${showOverlay ? '' : 'hidden'}`} onClick={(e) => e.stopPropagation()}>
        <button
          className="btn btn-icon"
          style={{ color: 'var(--text)', flexShrink: 0 }}
          onClick={() => navigate('/title', { state: { titleUrl } })}
        >
          ←
        </button>
        <span className="reader-title">{currentChapter.title}</span>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50dvh' }}>
          <div className="spinner" style={{ width: 36, height: 36, borderWidth: 3 }} />
        </div>
      ) : error ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '50dvh', padding: 20 }}>
          <div className="error-banner">{error}</div>
        </div>
      ) : (
        <div className="reader-images" ref={imagesContainerRef}>
          {images.map((img, i) => (
            <LazyImage key={img.src} src={img.src} index={i} />
          ))}

          {hasNext ? (
            <div className="reader-next-zone">
              <svg width="52" height="52" viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
                <circle
                  cx="24" cy="24" r="20"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - nextProgress)}
                  transform="rotate(-90 24 24)"
                  style={{ transition: 'stroke-dashoffset 0.08s' }}
                />
                <text x="24" y="28" textAnchor="middle" fontSize="11" fill="rgba(255,255,255,0.7)">↓</text>
              </svg>
              <span className="reader-next-label">
                {nextProgress >= 1 ? 'Loading…' : 'Next Chapter'}
              </span>
            </div>
          ) : (
            <div className="reader-end-zone">
              <span>End of available chapters</span>
            </div>
          )}
        </div>
      )}

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
          disabled={!hasNext}
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
  const [visible, setVisible] = useState(index < 3);

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
