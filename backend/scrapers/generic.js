const BaseScraper = require('./base');
const axios = require('axios');
const cheerio = require('cheerio');
const { getBrowser } = require('../browser');
const imageCache = require('../imageCache');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Reader containers used by the common manga themes (Madara / Themesia / etc.).
// If page images live in one of these, they're almost always the real pages.
const READER_CONTAINERS = [
  '#readerarea', '.reading-content', '.read-content', '.chapter-content',
  '.entry-content', '.container-chapter-reader', '.page-break', '.text-left',
];

// Junk we never want to treat as a comic page.
const JUNK_IMG = /(logo|icon|avatar|gravatar|banner|ads?[-_./]|sponsor|placeholder|loading|spinner|blank|small|thumb|cover|discord|patreon|telegram)/i;

/**
 * Best-effort scraper for arbitrary manhwa sites. Used as the registry's
 * default when no site-specific scraper is registered for a host.
 *
 * Strategy is always "cheapest first": plain axios + cheerio, then theme-aware
 * tricks (Madara AJAX, Themesia ts_reader JSON), and only a headless browser as
 * a last resort (for Cloudflare / JS-rendered / lazy-loaded pages).
 */
class GenericScraper extends BaseScraper {
  constructor() { super(''); } // base is derived per-URL, not fixed

  // ─── helpers ────────────────────────────────────────────────────────────

  _origin(url) {
    try { return new URL(url).origin; } catch { return ''; }
  }

  _resolve(href, origin) {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    if (href.startsWith('//')) return 'https:' + href;
    return origin.replace(/\/$/, '') + (href.startsWith('/') ? '' : '/') + href;
  }

  _chapterNumber(href, text) {
    for (const s of [href || '', text || '']) {
      const m = s.match(/chapter[\s\/_-]*?(\d+(?:\.\d+)?)/i);
      if (m) return parseFloat(m[1]);
    }
    // Fall back to a trailing number in a chapter-looking href
    const m = (href || '').match(/(\d+(?:\.\d+)?)\/?$/);
    return m ? parseFloat(m[1]) : null;
  }

  // ─── title + chapter list ────────────────────────────────────────────────

  async fetchTitle(url) {
    const origin = this._origin(url);
    let $, html;
    try {
      ({ $, html } = await this.fetchHtml(url, { Referer: origin }));
    } catch {
      // Fetch blocked (e.g. Cloudflare) — go straight to the browser.
      return this._titleViaBrowser(url);
    }

    const meta = this._metadata($);

    let chapters = this._chaptersFromHtml($, origin);
    if (!chapters.length) chapters = await this._chaptersFromMadara($, html, url, origin);
    if (!chapters.length) {
      const viaBrowser = await this._titleViaBrowser(url).catch(() => null);
      if (viaBrowser) return viaBrowser;
    }

    return { ...meta, chapters };
  }

  _metadata($) {
    const title =
      ($('meta[property="og:title"]').attr('content') || '')
        .replace(/\s*[|\-–—]\s*[^|\-–—]*$/, '').trim() ||
      $('h1').first().text().trim() ||
      $('title').text().trim();

    const coverUrl =
      $('meta[property="og:image"]').attr('content') ||
      $('.summary_image img, .thumb img, .series-thumb img').first().attr('src') ||
      null;

    const synopsis =
      $('meta[property="og:description"]').attr('content') ||
      $('.summary__content, .description-summary, .entry-content p, .synopsis').first().text().trim() ||
      '';

    return { title, coverUrl, synopsis };
  }

  _chaptersFromHtml($, origin) {
    const chapters = [];
    const seen = new Set();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (!href) return;
      // Only consider links that clearly point at a chapter.
      if (!/chapter/i.test(href) && !/chapter/i.test(text)) return;

      const number = this._chapterNumber(href, text);
      if (number === null || Number.isNaN(number) || seen.has(number)) return;

      seen.add(number);
      chapters.push({
        url: this._resolve(href, origin),
        number,
        title: /^chapter/i.test(text) ? text.split('\n')[0].slice(0, 60) : `Chapter ${number}`,
      });
    });

    chapters.sort((a, b) => a.number - b.number);
    return chapters;
  }

  /**
   * Madara (WordPress wp-manga) themes load chapters over AJAX rather than in
   * the initial HTML. Try both the modern and legacy endpoints.
   */
  async _chaptersFromMadara($, html, url, origin) {
    const mangaUrl = url.replace(/\/$/, '') + '/';
    const attempts = [];

    // Modern Madara: POST <manga-url>/ajax/chapters/
    attempts.push({ url: mangaUrl + 'ajax/chapters/', body: '' });

    // Legacy Madara: POST /wp-admin/admin-ajax.php with the post id
    const id =
      $('#manga-chapters-holder').attr('data-id') ||
      $('input.rating-post-id').attr('value') ||
      (html.match(/manga_id["']?\s*[:=]\s*["']?(\d+)/) || [])[1] ||
      (html.match(/"post_id"\s*:\s*"?(\d+)/) || [])[1];
    if (id) {
      attempts.push({
        url: origin + '/wp-admin/admin-ajax.php',
        body: `action=manga_get_chapters&manga=${id}`,
      });
    }

    for (const a of attempts) {
      try {
        const res = await axios.post(a.url, a.body, {
          headers: {
            'User-Agent': UA,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Referer: mangaUrl,
          },
          timeout: 30000,
        });
        const chapters = this._chaptersFromHtml(cheerio.load(res.data), origin);
        if (chapters.length) return chapters;
      } catch { /* try next */ }
    }
    return [];
  }

  async _titleViaBrowser(url) {
    const origin = this._origin(url);
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setUserAgent(UA);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
      await this._autoScroll(page);
      const html = await page.content();
      const $ = cheerio.load(html);
      return { ...this._metadata($), chapters: this._chaptersFromHtml($, origin) };
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ─── chapter images ───────────────────────────────────────────────────────

  async fetchChapter(url) {
    const origin = this._origin(url);
    let $, html;
    try {
      ({ $, html } = await this.fetchHtml(url, { Referer: origin }));
    } catch {
      return this._chapterViaBrowser(url);
    }

    // 1) Themesia "ts_reader" embeds the full page list as JSON — most reliable.
    let images = this._imagesFromTsReader(html);
    // 2) Images inside a known reader container.
    if (!images.length) images = this._imagesFromContainers($, origin);
    // 3) Generic scan of all <img> with junk/size filtering.
    if (!images.length) images = this._imagesGeneric($, origin);
    // 4) Nothing in the static HTML — render it.
    if (!images.length) return this._chapterViaBrowser(url);

    return { images };
  }

  _imagesFromTsReader(html) {
    const m = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
    if (!m) return [];
    try {
      const data = JSON.parse(m[1]);
      const imgs = (data.sources || []).flatMap(s => s.images || []);
      return imgs.filter(u => typeof u === 'string' && u.startsWith('http'));
    } catch { return []; }
  }

  _pickSrc($el) {
    return (
      $el.attr('data-src') || $el.attr('data-lazy-src') ||
      $el.attr('data-original') || $el.attr('src') || ''
    ).trim();
  }

  _imagesFromContainers($, origin) {
    for (const sel of READER_CONTAINERS) {
      const container = $(sel).first();
      if (!container.length) continue;
      const images = [];
      const seen = new Set();
      container.find('img').each((_, el) => {
        const src = this._pickSrc($(el));
        if (!/^https?:/.test(src) || JUNK_IMG.test(src)) return;
        if (seen.has(src)) return;
        seen.add(src);
        images.push(this._resolve(src, origin));
      });
      if (images.length) return images;
    }
    return [];
  }

  _imagesGeneric($, origin) {
    const images = [];
    const seen = new Set();
    const siteHost = this._origin(origin) ? new URL(origin).hostname : '';

    $('img').each((_, el) => {
      const src = this._pickSrc($(el));
      if (!/^https?:/.test(src) || JUNK_IMG.test(src)) return;
      if (seen.has(src)) return;

      // Keep off-site (CDN) images, or ones that look big / sequential.
      let host = '';
      try { host = new URL(src).hostname; } catch { return; }
      const w = parseInt($(el).attr('width') || '0', 10);
      const h = parseInt($(el).attr('height') || '0', 10);
      const sequential = /\/\d{1,4}\.(webp|jpe?g|png)(\?|$)/i.test(src);
      const bigEnough = w >= 500 || h >= 500;
      const offSite = host && host !== siteHost;
      if ((w && w < 200) || (h && h < 200)) return; // clearly not a page
      if (!offSite && !bigEnough && !sequential) return;

      seen.add(src);
      images.push(this._resolve(src, origin));
    });
    return images;
  }

  /** Headless-browser fallback: renders the page, scrolls to load lazy images,
   *  and captures image responses so tokenized/cookie-gated CDNs still work. */
  async _chapterViaBrowser(url) {
    const origin = this._origin(url);
    const browser = await getBrowser();
    const page = await browser.newPage();
    const bufferPromises = [];
    try {
      await page.setUserAgent(UA);

      page.on('response', (response) => {
        const ct = response.headers()['content-type'] || '';
        if (!response.ok() || !ct.startsWith('image/')) return;
        const p = response.buffer()
          .then(buf => imageCache.set(response.url(), buf, ct))
          .catch(() => {});
        bufferPromises.push(p);
      });

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
      await this._autoScroll(page);
      await page.waitForNetworkIdle({ idleTime: 1200, timeout: 15000 }).catch(() => {});

      const images = await page.evaluate((containers, junkSource) => {
        const junk = new RegExp(junkSource, 'i');
        // Lazy loaders keep the real URL in a data- attribute until the image
        // is decoded, with a spinner or data: placeholder in src meanwhile.
        const pick = (img) => [
          img.getAttribute('data-src'), img.getAttribute('data-lazy-src'),
          img.getAttribute('data-original'), img.currentSrc, img.src,
        ].find(s => s && /^https?:/.test(s) && !junk.test(s)) || null;

        // Inside a reader container every image is a page, loaded or not, in
        // document order. Filtering those by decoded size used to drop any
        // page still loading and silently punch holes in the chapter.
        for (const sel of containers) {
          const c = document.querySelector(sel);
          if (!c) continue;
          const list = Array.from(c.querySelectorAll('img')).map(pick).filter(Boolean);
          if (list.length >= 2) return list;
        }
        return Array.from(document.querySelectorAll('img'))
          .filter(img => (img.naturalWidth || 0) >= 300 && (img.naturalHeight || 0) >= 300)
          .map(pick)
          .filter(Boolean);
      }, READER_CONTAINERS, JUNK_IMG.source);

      await Promise.allSettled(bufferPromises);

      if (!images.length) throw new Error('No chapter images found');

      const cookies = await page.cookies();
      return {
        images: [...new Set(images)],
        _cookieDomain: new URL(url).hostname,
        _cookies: cookies.map(c => `${c.name}=${c.value}`).join('; '),
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async _autoScroll(page) {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const step = 800;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          total += step;
          if (total >= document.body.scrollHeight - window.innerHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
      });
    }).catch(() => {});
  }

  // Generic sites have no common search API, so add-by-URL is the path here.
  async search() {
    return [];
  }
}

module.exports = GenericScraper;
