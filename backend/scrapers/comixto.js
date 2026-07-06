const BaseScraper = require('./base');
const { getBrowser } = require('../browser');
const imageCache = require('../imageCache');

const BASE = 'https://comix.to';

// comix.to renders roughly every 10th page onto a <canvas> (a 2D context whose
// pixels can't be read back) instead of an <img>, as an anti-scraping measure.
// Those pages have no retrievable URL, so we substitute a labelled placeholder
// to keep the page order and count intact and make the gap visible.
function protectedPagePlaceholder(pageLabel) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">` +
    `<rect width="800" height="1200" fill="#15161a"/>` +
    `<text x="400" y="580" fill="#8a8d98" font-family="sans-serif" font-size="36" text-anchor="middle">Page ${pageLabel}</text>` +
    `<text x="400" y="640" fill="#5b5e68" font-family="sans-serif" font-size="24" text-anchor="middle">protected by comix.to — unavailable</text>` +
    `</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

class ComixToScraper extends BaseScraper {
  constructor() { super(BASE); }

  async _openPage(url) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });
    return page;
  }

  // ─── Title + chapter list (DOM scraping) ────────────────────────────────

  async fetchTitle(url) {
    const page = await this._openPage(url);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 });

      // Fast title metadata from initial-data
      const meta = await page.evaluate(() => {
        try {
          const d = JSON.parse(document.getElementById('initial-data').textContent);
          const queries = d.queries || {};
          const key = Object.keys(queries).find(k => k.includes('"detail"'));
          const comic = key ? queries[key] : {};
          return {
            title: comic.title,
            coverUrl: comic.poster?.large || comic.poster?.medium,
            synopsis: comic.synopsis || '',
            status: comic.status,
            genres: (comic.genres || []).map(g => g.title),
            latestChapterNumber: comic.latestChapter,
          };
        } catch { return {}; }
      });

      // Wait for chapter list
      await page.waitForSelector('.mpage__chapters .mchap-row', { timeout: 15000 });

      // Collect all chapters by paginating through all pages
      const chapters = await this._scrapeAllChapterPages(page);

      return { ...meta, chapters };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async _scrapeAllChapterPages(page) {
    const seen = new Map(); // chapter number → chapter object

    // Walk every pager page. Termination is driven by the active-page indicator
    // (.npager__num.is-active): when clicking Next no longer changes it, or the
    // Next button is gone, we've reached the last page. This is more reliable
    // than diffing row hrefs, which can repeat across pages of the same chapter.
    let activePrev = null;
    for (let guard = 0; guard < 500; guard++) {
      const state = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.mchap-row')).map(row => {
          const a = row.querySelector('a[href*="-chapter-"]');
          if (!a) return null;
          return {
            url: a.href,
            title: a.querySelector('.mchap-row__ch')?.textContent.trim() || a.textContent.trim(),
          };
        }).filter(Boolean);
        return {
          rows,
          active: document.querySelector('.npager__num.is-active')?.textContent?.trim() || null,
          hasNext: !!document.querySelector('.npager__nav[aria-label="Next page"]:not([disabled])'),
        };
      });

      for (const ch of state.rows) {
        // Handle decimal chapters in either "-chapter-40-5" or "-chapter-40.5" form.
        const m = ch.url.match(/-chapter-(\d+(?:[.-]\d+)?)/i);
        const number = m ? parseFloat(m[1].replace('-', '.')) : null;
        const key = number ?? ch.url; // fall back to the URL for unnumbered specials
        if (!seen.has(key)) {
          seen.set(key, { url: ch.url, number, title: ch.title || (number != null ? `Chapter ${number}` : ch.title) });
        }
      }

      // Stop if the page didn't advance since the last click, or there's no next.
      if (activePrev !== null && state.active === activePrev) break;
      activePrev = state.active;
      if (!state.hasNext) break;

      await page.evaluate(() => document.querySelector('.npager__nav[aria-label="Next page"]')?.click());
      await page.waitForFunction(
        (prev) => (document.querySelector('.npager__num.is-active')?.textContent?.trim() || null) !== prev,
        { timeout: 8000 },
        state.active
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 150));
    }

    return [...seen.values()]
      .filter(c => c.number !== null) // drop rows we couldn't assign a number to
      .sort((a, b) => a.number - b.number);
  }

  // ─── Chapter images (DOM scraping) ──────────────────────────────────────

  async fetchChapter(url) {
    const page = await this._openPage(url);
    const bufferPromises = [];

    try {
      // Cache every image the reader loads, keyed by URL, so the proxy can serve
      // these session-bound CDN URLs without re-authenticating.
      page.on('response', (response) => {
        const ct = response.headers()['content-type'] || '';
        if (!response.ok() || !ct.startsWith('image/')) return;
        const responseUrl = response.url();
        const requestUrl = response.request()?.url();
        const p = response.buffer()
          .then(buf => {
            imageCache.set(responseUrl, buf, ct);
            // Also cache under the pre-redirect request URL so a proxy lookup by
            // the exact src the reader used still hits.
            if (requestUrl && requestUrl !== responseUrl) imageCache.set(requestUrl, buf, ct);
          })
          .catch(() => {});
        bufferPromises.push(p);
      });

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
      await page.waitForSelector('.rpage-page', { timeout: 20000 });

      // The long-strip reader is virtualised: it keeps only a handful of pages
      // rendered at a time and lazy-loads each <img> as it nears the viewport.
      // Every .rpage-page carries a stable data-page index, so we scroll the
      // reader's own scroll container end-to-end, harvesting each page's URL by
      // its index. This survives images being unloaded again once out of view.
      const harvest = await page.evaluate(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const scroller =
          document.querySelector('.rpage-main--long-strip') ||
          document.querySelector('.rpage-main') ||
          document.scrollingElement;
        const pages = Array.from(document.querySelectorAll('.rpage-page'));
        const total = pages.length;
        const dp = (el) => el.getAttribute('data-page') || null;

        const map = {};              // data-page → url
        const canvasPages = new Set();
        const scan = () => document.querySelectorAll('.rpage-page').forEach(pg => {
          const key = pg.getAttribute('data-page');
          if (!key || map[key]) return;
          const img = pg.querySelector('img');
          if (img && img.src && img.src.startsWith('http')) map[key] = img.src;
          else if (pg.querySelector('canvas')) canvasPages.add(key);
        });
        // Pages still worth chasing: no URL yet and not a (protected) canvas.
        const remaining = () => pages.map(dp).filter(k => k && !map[k] && !canvasPages.has(k));

        // Pass 1: fast sweep top to bottom to load the bulk of the pages.
        const step = Math.max(500, Math.floor((scroller.clientHeight || 900) * 0.85));
        for (let y = 0; y <= scroller.scrollHeight; y += step) {
          scroller.scrollTop = y;
          await sleep(150);
          scan();
        }
        // Passes 2..N: revisit each straggler individually and wait for it to
        // actually load (canvas pages drop out of `remaining`, so we don't spin
        // on the ~1-in-10 pages that never resolve to an image).
        for (let round = 0; round < 4 && remaining().length; round++) {
          for (const key of remaining()) {
            const pg = document.querySelector(`.rpage-page[data-page="${key}"]`);
            if (!pg) continue;
            pg.scrollIntoView({ block: 'center' });
            for (let t = 0; t < 15; t++) { // poll up to ~1.5s for this page
              await sleep(100);
              const img = pg.querySelector('img');
              if ((img && img.src && img.src.startsWith('http')) || pg.querySelector('canvas')) break;
            }
            scan();
          }
        }
        scan();

        const ordered = pages.map((pg, i) => {
          const key = dp(pg) || String(i + 1);
          return { page: key, url: map[key] || null, isCanvas: canvasPages.has(key) };
        });
        return { total, ordered, gotUrls: Object.keys(map).length };
      });

      // Let any in-flight image buffers finish caching before the page closes.
      await Promise.allSettled(bufferPromises);

      if (!harvest.gotUrls) throw new Error('No images found in reader');

      // Assemble the ordered page list, substituting a placeholder for the
      // canvas-protected pages we can't retrieve.
      const images = harvest.ordered.map(p => p.url || protectedPagePlaceholder(p.page));
      const protectedCount = harvest.ordered.filter(p => !p.url).length;
      console.log(`[chapter] ${images.length} pages (${harvest.gotUrls} images, ${protectedCount} protected/placeholder)`);

      const cookies = await page.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      return { images, _cookieDomain: new URL(url).hostname, _cookies: cookieStr };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async search(query) {
    // Use the fast HTML scraper for search (no auth needed for search page)
    const searchUrl = `${BASE}/?q=${encodeURIComponent(query)}`;
    try {
      const { $ } = await this.fetchHtml(searchUrl);
      const results = [];
      $('a[href*="/title/"]').each((_, el) => {
        const href = $(el).attr('href');
        const img = $(el).find('img').first();
        const title = $(el).find('[class*="title"], h3, h2').first().text().trim() ||
                      img.attr('alt') || $(el).text().trim().substring(0, 60);
        if (href && title && !results.find(r => r.url === `${BASE}${href}`)) {
          results.push({
            title,
            url: `${BASE}${href}`,
            coverUrl: img.attr('src') || img.attr('data-src'),
          });
        }
      });
      return results.filter(r => r.title).slice(0, 20);
    } catch {
      return [];
    }
  }
}

module.exports = ComixToScraper;
