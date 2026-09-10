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

    // Read the current pager page: its rows, which page is active, and how the
    // pager is currently laid out.
    const readState = () => page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.mchap-row')).map(row => {
        const a = row.querySelector('a[href*="-chapter-"]');
        if (!a) return null;
        return {
          url: a.href,
          title: a.querySelector('.mchap-row__ch')?.textContent.trim() || a.textContent.trim(),
        };
      }).filter(Boolean);
      const active = parseInt(document.querySelector('.npager__num.is-active')?.textContent?.trim() || '', 10);
      return {
        rows,
        active: Number.isFinite(active) ? active : null,
        hasNext: !!document.querySelector('.npager__nav[aria-label="Next page"]:not([disabled])'),
      };
    });

    // While the chapter list re-renders, the pager briefly drops its nav
    // buttons — read it mid-render and "Next page" looks like it's gone. That
    // used to end the walk early and silently truncate the chapter list at a
    // random page. So never act on a single reading: wait until two
    // consecutive reads agree before deciding anything.
    const settle = async () => {
      let prev = null;
      let state = null;
      for (let i = 0; i < 40; i++) {
        state = await readState();
        // Mid-render the pager has no active number and the list can be empty;
        // such a reading proves nothing, so it never counts towards agreement.
        if (state.active !== null && state.rows.length) {
          const sig = `${state.active}|${state.rows.length}|${state.rows[0].url}|${state.hasNext}`;
          if (sig === prev) return state;
          prev = sig;
        } else {
          prev = null;
        }
        await new Promise(r => setTimeout(r, 120));
      }
      return state;
    };

    const clickNav = (label) => page.evaluate((l) => {
      const b = document.querySelector(`.npager__nav[aria-label="${l}"]`);
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }, label);

    /** Click the pager button for a specific page number, if it's on screen. */
    const clickPageNumber = (n) => page.evaluate((num) => {
      const btn = Array.from(document.querySelectorAll('.npager__num'))
        .find(b => parseInt(b.textContent.trim(), 10) === num);
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    }, n);

    /** Wait until the pager's active number is something other than `prev`. */
    const waitForPageChange = (prev) => page.waitForFunction(
      (p) => {
        const a = parseInt(document.querySelector('.npager__num.is-active')?.textContent?.trim() || '', 10);
        return Number.isFinite(a) && a !== p;
      },
      { timeout: 8000 },
      prev
    ).then(() => true).catch(() => false);

    /** Wait until the pager reports it is on exactly page `n`. */
    const waitForPage = (n) => page.waitForFunction(
      (want) => parseInt(document.querySelector('.npager__num.is-active')?.textContent?.trim() || '', 10) === want,
      { timeout: 5000 },
      n
    ).then(() => true).catch(() => false);

    const collect = (rows) => {
      for (const ch of rows) {
        // Handle decimal chapters in either "-chapter-40-5" or "-chapter-40.5" form.
        const m = ch.url.match(/-chapter-(\d+(?:[.-]\d+)?)/i);
        const number = m ? parseFloat(m[1].replace('-', '.')) : null;
        const key = number ?? ch.url; // fall back to the URL for unnumbered specials
        if (!seen.has(key)) {
          seen.set(key, { url: ch.url, number, title: ch.title || (number != null ? `Chapter ${number}` : ch.title) });
        }
      }
    };

    // Ask the pager how many pages there actually are, by jumping to the last
    // one and reading the active number, then coming back. Knowing the target
    // up front means the walk below stops because it reached the end, not
    // because a button blinked out of the DOM at the wrong moment.
    const startUrl = page.url();
    let state = await settle();
    let totalPages = null;
    if (state.active !== null && await clickNav('Last page')) {
      await waitForPageChange(state.active);
      const last = await settle();
      totalPages = last.active;
      collect(last.rows); // already here — no reason to fetch it again

      if (await clickNav('First page')) await waitForPageChange(last.active);
      state = await settle();
      if (state.active !== 1) {
        // Couldn't get back to the start by clicking — reload and start over.
        await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 35000 });
        await page.waitForSelector('.mpage__chapters .mchap-row', { timeout: 15000 });
        state = await settle();
        if (state.active !== 1) totalPages = null; // give up on the count, walk blind
      }
    }

    const limit = totalPages ? totalPages + 5 : 500;
    for (let guard = 0; guard < limit; guard++) {
      collect(state.rows);

      // With the page count known, that's the only stop condition worth
      // trusting; without it, fall back to the (racy) Next button.
      if (totalPages ? state.active >= totalPages : !state.hasNext) break;
      if (state.active === null) break; // no readable pager — this is the only page

      // Prefer clicking the target page's own number over "Next page": it
      // says exactly where to land, so a click that lands nowhere (the pager
      // re-rendered under it) is retried rather than mistaken for the end of
      // the list. Falling short here is how pages used to get skipped.
      const target = state.active + 1;
      let advanced = false;
      for (let attempt = 0; attempt < 4 && !advanced; attempt++) {
        const clicked = (await clickPageNumber(target)) || (await clickNav('Next page'));
        if (!clicked) {
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        advanced = await waitForPage(target);
      }
      if (!advanced) {
        console.warn(`[title] pager stalled on page ${state.active}${totalPages ? ` of ${totalPages}` : ''}`);
        break;
      }
      state = await settle();
    }

    const chapters = [...seen.values()]
      .filter(c => c.number !== null) // drop rows we couldn't assign a number to
      .sort((a, b) => a.number - b.number);
    console.log(`[title] ${chapters.length} chapters over ${totalPages ?? '?'} pager pages` +
      (chapters.length ? ` (${chapters[0].number}–${chapters[chapters.length - 1].number})` : ''));
    return chapters;
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

        // Every .rpage-page carries a stable data-page index. Page order is
        // taken from that number and nothing else — never from the order of a
        // NodeList captured up front, which can be short (pages not mounted
        // yet) or stale (nodes replaced) by the time the sweep finishes.
        const map = new Map();        // data-page → url
        const canvasPages = new Set();
        const known = new Set();      // every data-page the reader ever showed

        const scan = () => {
          for (const pg of document.querySelectorAll('.rpage-page')) {
            const key = pg.getAttribute('data-page');
            if (!key) continue;
            known.add(key);
            if (map.has(key)) continue;
            const img = pg.querySelector('img');
            if (img && img.src && img.src.startsWith('http')) {
              map.set(key, img.src);
              canvasPages.delete(key);
            } else if (pg.querySelector('canvas')) {
              canvasPages.add(key);
            }
          }
        };
        // Pages still worth chasing: no URL yet and not a (protected) canvas.
        const remaining = () => [...known].filter(k => !map.has(k) && !canvasPages.has(k));

        scan();

        // Pass 1: fast sweep top to bottom to load the bulk of the pages. The
        // strip grows as real images replace placeholders, so scrollHeight is
        // re-read every step rather than fixed up front.
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

        // Order strictly by page number. Any page in the range we never got a
        // URL for still gets its slot, so a gap can never shift every later
        // page up by one.
        const num = k => { const n = parseInt(k, 10); return Number.isFinite(n) ? n : null; };
        const byNum = new Map();
        for (const k of known) {
          const n = num(k);
          if (n !== null && !byNum.has(n)) byNum.set(n, k);
        }
        const lo = byNum.size ? Math.min(...byNum.keys()) : 0;
        const hi = byNum.size ? Math.max(...byNum.keys()) : 0;

        let ordered;
        if (byNum.size === known.size && byNum.size && hi - lo < 2000) {
          ordered = [];
          for (let n = lo; n <= hi; n++) {
            const k = byNum.get(n);
            ordered.push({ page: k ?? String(n), url: k ? (map.get(k) || null) : null });
          }
        } else {
          // Non-numeric data-page values: fall back to sorting what we have.
          ordered = [...known]
            .sort((a, b) => (num(a) ?? 0) - (num(b) ?? 0))
            .map(k => ({ page: k, url: map.get(k) || null }));
        }
        return { total: ordered.length, ordered, gotUrls: map.size };
      });

      // Let any in-flight image buffers finish caching before the page closes.
      await Promise.allSettled(bufferPromises);

      if (!harvest.gotUrls) throw new Error('No images found in reader');

      // Assemble the ordered page list, substituting a placeholder for the
      // canvas-protected pages we can't retrieve.
      const images = harvest.ordered.map(p => p.url || protectedPagePlaceholder(p.page));
      const protectedCount = harvest.ordered.filter(p => !p.url).length;
      // Two slots pointing at one image means a page was harvested from a
      // half-updated DOM — worth seeing in the log if it ever happens again.
      const realUrls = harvest.ordered.filter(p => p.url).map(p => p.url);
      const dupes = realUrls.length - new Set(realUrls).size;
      console.log(`[chapter] ${images.length} pages (${harvest.gotUrls} images, ${protectedCount} protected/placeholder` +
        (dupes ? `, ${dupes} DUPLICATE url(s)` : '') + ')');

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
