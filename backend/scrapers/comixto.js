const BaseScraper = require('./base');
const { getBrowser } = require('../browser');
const imageCache = require('../imageCache');

const BASE = 'https://comix.to';

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

    let pageNum = 1;
    while (true) {
      // Extract all chapter rows on current page
      const rows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.mchap-row')).map(row => {
          const a = row.querySelector('a[href*="-chapter-"]');
          if (!a) return null;
          const href = a.href;
          const numMatch = href.match(/-chapter-([\d.]+)/);
          return {
            url: href,
            number: numMatch ? parseFloat(numMatch[1]) : null,
            title: a.querySelector('.mchap-row__ch')?.textContent.trim() ||
                   a.textContent.trim(),
          };
        }).filter(Boolean);
      });

      for (const ch of rows) {
        const key = ch.number;
        if (key !== null && !seen.has(key)) {
          seen.set(key, ch);
        }
      }

      // Check if there's a next page
      const hasNext = await page.evaluate(() => {
        const btn = document.querySelector('.npager__nav[aria-label="Next page"]');
        return btn && !btn.disabled;
      });

      if (!hasNext) break;

      // Click next page and wait for refresh
      await page.evaluate(() => {
        document.querySelector('.npager__nav[aria-label="Next page"]')?.click();
      });
      await page.waitForFunction(
        (prev) => {
          const rows = document.querySelectorAll('.mchap-row');
          if (rows.length === 0) return false;
          const first = rows[0]?.querySelector('a')?.href;
          return first !== prev;
        },
        {},
        rows[0]?.url || ''
      ).catch(() => {});
      await new Promise(r => setTimeout(r, 200)); // small settle time

      pageNum++;
      if (pageNum > 200) break; // safety limit
    }

    return [...seen.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  }

  // ─── Chapter images (DOM scraping) ──────────────────────────────────────

  async fetchChapter(url) {
    const page = await this._openPage(url);
    const bufferPromises = [];
    // Track final (post-redirect) URL → original request URL so cache lookups work
    const responseUrlToRequestUrl = new Map();

    try {
      page.on('response', (response) => {
        const ct = response.headers()['content-type'] || '';
        if (!response.ok() || !ct.startsWith('image/')) return;
        const responseUrl = response.url();
        const p = response.buffer()
          .then(buf => {
            imageCache.set(responseUrl, buf, ct);
            // Also cache under the request URL (before any redirect) if different
            const reqUrl = response.request()?.url();
            if (reqUrl && reqUrl !== responseUrl) {
              imageCache.set(reqUrl, buf, ct);
              responseUrlToRequestUrl.set(responseUrl, reqUrl);
            }
          })
          .catch(() => {});
        bufferPromises.push(p);
      });

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
      await page.waitForSelector('.rpage-page__img', { timeout: 20000 });

      const totalPages = await page.evaluate(() => {
        const slides = document.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate)');
        if (slides.length > 1) return slides.length;
        return document.querySelectorAll('.rpage-page').length || 0;
      });

      // Force all lazy images to load so the response interceptor captures them
      await page.evaluate(() => {
        document.querySelectorAll('.rpage-page__img').forEach(img => {
          const src = img.dataset?.src || img.dataset?.lazySrc;
          if (src && (!img.src || img.src === window.location.href)) img.src = src;
        });
      });
      // Wait for the triggered requests to complete
      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20000 }).catch(() => {});

      let images = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.rpage-page__img'))
          .map(img => img.src || img.dataset?.src)
          .filter(s => s && s.startsWith('http'))
      );

      if (!images.length) throw new Error('No images found in reader');

      // Fill any gaps not loaded via DOM with URL pattern inference
      if (images.length < totalPages) {
        const firstSrc = images[0];
        const baseMatch = firstSrc && firstSrc.match(/^(.+\/)(\d+)\.(webp|jpg|jpeg|png)$/i);
        if (baseMatch) {
          const [, base, startStr, ext] = baseMatch;
          const start = parseInt(startStr, 10);
          images = Array.from({ length: totalPages }, (_, i) => `${base}${start + i}.${ext}`);
          console.log(`[chapter] inferred ${images.length} URLs from pattern, start=${start}`);
        }
      }

      // Wait for all in-flight buffer() calls to finish before closing the page
      await Promise.allSettled(bufferPromises);

      const cached = images.filter(u => imageCache.get(u)).length;
      console.log(`[chapter] ${images.length} URLs, ${cached} already cached, first: ${images[0]}`);

      const cookies = await page.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      return { images, _cookieDomain: new URL(url).hostname, _cookies: cookieStr };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async _scrollToLoadAll(page, expected) {
    let prev = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await new Promise(r => setTimeout(r, 400));
      const count = await page.evaluate(() =>
        document.querySelectorAll('.rpage-page__img[src]:not([src=""])').length
      );
      if (count >= expected || count === prev) break;
      prev = count;
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
