const BaseScraper = require('./base');
const axios = require('axios');

const BASE = 'https://comix.to';

class ComixToScraper extends BaseScraper {
  constructor() {
    super(BASE);
  }

  async fetchTitle(url) {
    const { $, html } = await this.fetchHtml(url);

    // Strategy 1: Next.js embedded JSON
    const nextData = this.extractNextData($);
    if (nextData) {
      const result = this._parseNextTitle(nextData, url);
      if (result.title) return result;
    }

    // Strategy 2: Try the site's JSON API (common pattern: /api/comic/<slug>)
    try {
      const slug = url.match(/\/title\/([^/]+)/)?.[1];
      if (slug) {
        const apiResult = await this._tryApiTitle(slug);
        if (apiResult) return apiResult;
      }
    } catch {}

    // Strategy 3: HTML parsing fallback
    return this._parseHtmlTitle($, url);
  }

  async _tryApiTitle(slug) {
    const endpoints = [
      `${BASE}/api/comic/${slug}`,
      `${BASE}/api/title/${slug}`,
      `${BASE}/api/v1/comic/${slug}`,
    ];
    for (const endpoint of endpoints) {
      try {
        const { data } = await axios.get(endpoint, {
          headers: { Referer: BASE },
          timeout: 10000,
        });
        if (data && (data.title || data.name)) {
          return {
            title: data.title || data.name,
            coverUrl: data.cover || data.thumbnail || data.image,
            synopsis: data.description || data.synopsis || '',
            chapters: this._normalizeChapters(data.chapters || data.chapter_list || []),
          };
        }
      } catch {}
    }
    return null;
  }

  _parseNextTitle(nextData, url) {
    const props = nextData?.props?.pageProps;
    const comic = props?.comic || props?.title || props?.data || props?.series;

    if (!comic) return { title: null };

    const chapters = this._normalizeChapters(
      comic.chapters || comic.chapter_list || comic.chapterList || []
    );

    return {
      title: comic.title || comic.name,
      coverUrl: comic.cover || comic.thumbnail || comic.image,
      synopsis: comic.description || comic.synopsis || '',
      status: comic.status,
      genres: comic.genres || comic.tags || [],
      chapters,
    };
  }

  _normalizeChapters(rawChapters) {
    return rawChapters
      .map((ch, i) => {
        const url =
          ch.url ||
          (ch.slug ? `${BASE}/chapter/${ch.slug}/` : null) ||
          (ch.id ? `${BASE}/chapter/${ch.id}/` : null);
        return {
          title: ch.title || ch.name || `Chapter ${ch.number || ch.chapter_number || i + 1}`,
          url,
          number: ch.number || ch.chapter_number || i + 1,
          date: ch.date || ch.created_at || null,
        };
      })
      .filter((ch) => ch.url);
  }

  _parseHtmlTitle($, url) {
    const title =
      $('h1').first().text().trim() ||
      $('.series-title, .manga-title, [class*="title"] h1').first().text().trim();

    const coverUrl = this.resolveUrl(
      $('img[class*="cover"], img[class*="thumbnail"], .thumb img, .cover img')
        .first()
        .attr('src')
    );

    const synopsis = $(
      '.description, .synopsis, .summary, [class*="description"], [class*="synopsis"]'
    )
      .first()
      .text()
      .trim();

    // Collect chapter links — deduplicated
    const seen = new Set();
    const chapters = [];
    $(
      'a[href*="/chapter/"], a[href*="/read/"], .chapter-list a, .chapters a, [class*="chapter"] a'
    ).each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (href && !seen.has(href)) {
        seen.add(href);
        chapters.push({
          title: text || `Chapter ${i + 1}`,
          url: this.resolveUrl(href),
          number: i + 1,
        });
      }
    });

    return { title, coverUrl, synopsis, chapters };
  }

  async fetchChapter(url) {
    const { $, html } = await this.fetchHtml(url, { Referer: url });

    // Strategy 1: Next.js data
    const nextData = this.extractNextData($);
    if (nextData) {
      const images = this._extractNextImages(nextData);
      if (images.length > 0) return { images };
    }

    // Strategy 2: window.__data__ or similar embedded arrays
    const windowImages = this._extractEmbeddedImages(html);
    if (windowImages.length > 0) return { images: windowImages };

    // Strategy 3: HTML img tags in reader area
    const images = [];
    const selectors = [
      '.reader-area img',
      '.chapter-content img',
      '#chapter-content img',
      '.reading-content img',
      '.page-break img',
      '[class*="reader"] img',
      '[class*="chapter-images"] img',
      'img[class*="page"]',
    ];
    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const src =
          $(el).attr('src') ||
          $(el).attr('data-src') ||
          $(el).attr('data-lazy-src') ||
          $(el).attr('data-original');
        if (src && !src.includes('placeholder') && !src.includes('loading') && src.includes('.')) {
          images.push(this.resolveUrl(src));
        }
      });
      if (images.length > 0) break;
    }

    return { images };
  }

  _extractNextImages(nextData) {
    const props = nextData?.props?.pageProps;
    const chapter = props?.chapter || props?.data || props?.images;
    if (!chapter) return [];

    const list = Array.isArray(chapter)
      ? chapter
      : chapter.images || chapter.pages || chapter.image_list || [];

    return list
      .map((img) => (typeof img === 'string' ? img : img.url || img.src || img.image))
      .filter(Boolean)
      .map((src) => this.resolveUrl(src));
  }

  _extractEmbeddedImages(html) {
    // Look for JSON arrays of image URLs embedded in script tags
    const patterns = [
      /(?:images|pages|chapter_images)\s*[:=]\s*(\[[^\]]+\])/,
      /(?:var|const|let)\s+\w+\s*=\s*(\[[^\]]*(?:jpg|jpeg|png|webp)[^\]]*\])/i,
    ];
    for (const pattern of patterns) {
      try {
        const match = html.match(pattern);
        if (match) {
          const arr = JSON.parse(match[1].replace(/'/g, '"'));
          const urls = arr
            .map((item) => (typeof item === 'string' ? item : item?.url || item?.src))
            .filter(Boolean)
            .map((src) => this.resolveUrl(src));
          if (urls.length > 0) return urls;
        }
      } catch {}
    }
    return [];
  }

  async search(query) {
    const searchUrl = `${BASE}/search?q=${encodeURIComponent(query)}`;
    try {
      const { $ } = await this.fetchHtml(searchUrl);
      const results = [];
      // Common search result selectors
      $('.search-result, .comic-item, [class*="search"] [class*="item"]').each((_, el) => {
        const link = $(el).find('a').first();
        const img = $(el).find('img').first();
        results.push({
          title: link.text().trim() || $(el).find('[class*="title"]').text().trim(),
          url: this.resolveUrl(link.attr('href')),
          coverUrl: this.resolveUrl(img.attr('src') || img.attr('data-src')),
        });
      });
      return results.filter((r) => r.url);
    } catch (err) {
      console.error('[comixto search]', err.message);
      return [];
    }
  }
}

module.exports = ComixToScraper;
