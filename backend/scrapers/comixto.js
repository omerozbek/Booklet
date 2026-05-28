const BaseScraper = require('./base');
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const BASE = 'https://comix.to';
const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const BROWSER_PATHS = [
  EDGE_PATH,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
];

function findBrowser() {
  const env = process.env.BROWSER_PATH;
  if (env && fs.existsSync(env)) return env;
  return BROWSER_PATHS.find(p => fs.existsSync(p)) || null;
}

let _browser = null;
async function getBrowser() {
  if (_browser) {
    try { await _browser.version(); return _browser; } catch { _browser = null; }
  }
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('No Chrome/Edge found. Set BROWSER_PATH env var.');
  console.log('[browser] Using:', executablePath);
  _browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,900'],
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
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
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });

      // Wait for at least one reader image to appear
      await page.waitForSelector('.rpage-page__img', { timeout: 20000 });

      // Get total page count from the reader state / DOM
      const totalPages = await page.evaluate(() => {
        // Try swiper slide count
        const slides = document.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate)');
        if (slides.length > 1) return slides.length;
        // Try rpage containers
        const pages = document.querySelectorAll('.rpage-page');
        return pages.length || 0;
      });

      // Extract currently-loaded images to get the CDN base URL
      const loadedImages = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.rpage-page__img'))
          .map(img => img.src || img.dataset?.src)
          .filter(s => s && !s.startsWith('data:'));
      });

      if (!loadedImages.length) throw new Error('No images found in reader');

      // Infer full image list from the pattern: /si/{token}/{n}.webp
      const firstSrc = loadedImages[0];
      const baseMatch = firstSrc.match(/^(.+\/)(\d+)\.(webp|jpg|jpeg|png)$/i);

      if (baseMatch && totalPages > 1) {
        const [, base, , ext] = baseMatch;
        const images = [];
        for (let i = 1; i <= totalPages; i++) {
          images.push(`${base}${i}.${ext}`);
        }
        return { images };
      }

      // Fallback: scroll to load all lazy images then collect
      if (totalPages > loadedImages.length) {
        await this._scrollToLoadAll(page, totalPages);
        const allImages = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.rpage-page__img'))
            .map(img => img.src || img.dataset?.src)
            .filter(s => s && !s.startsWith('data:'))
        );
        return { images: allImages };
      }

      return { images: loadedImages };
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
