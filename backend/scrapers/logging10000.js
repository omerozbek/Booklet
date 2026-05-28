const BaseScraper = require('./base');

const BASE = 'https://logging10000yearsintothefuture.org';
const HOSTNAME = 'logging10000yearsintothefuture.org';

class Logging10000Scraper extends BaseScraper {
  constructor() { super(BASE); }

  async fetchTitle(url) {
    const { $ } = await this.fetchHtml(BASE + '/');

    const title =
      $('h1').first().text().trim() ||
      'Logging 10000 Years into the Future';

    // Cover is the first img from wp-content/uploads
    const coverUrl =
      $('img[src*="wp-content/uploads"]').first().attr('src') || null;

    const synopsis = $('p').first().text().trim() || '';

    const chapters = [];
    const seen = new Set();

    $('li a[href*="/manga/"]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (!href) return;
      const numMatch = href.match(/chapter-([\d.]+)\/?$/i);
      if (!numMatch) return;
      const number = parseFloat(numMatch[1]);
      if (!seen.has(number)) {
        seen.add(number);
        chapters.push({ url: href, number, title: text || `Chapter ${number}` });
      }
    });

    chapters.sort((a, b) => a.number - b.number);

    return { title, coverUrl, synopsis, chapters };
  }

  async fetchChapter(url) {
    const { $ } = await this.fetchHtml(url);

    const images = [];
    $('img[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src || !src.startsWith('http')) return;
      // Exclude images served from the main site (nav, logos, cover thumbnails)
      try {
        if (new URL(src).hostname === HOSTNAME) return;
      } catch { return; }
      images.push(src);
    });

    if (!images.length) throw new Error('No chapter images found');

    return { images };
  }

  async search(query) {
    const q = query.toLowerCase();
    const keywords = ['log', '10000', 'apex', 'future', 'martial'];
    if (keywords.some(k => q.includes(k))) {
      // Fetch the cover to return a complete result
      try {
        const { $ } = await this.fetchHtml(BASE + '/');
        const coverUrl = $('img[src*="wp-content/uploads"]').first().attr('src') || null;
        return [{ title: 'Logging 10000 Years into the Future', url: BASE + '/', coverUrl }];
      } catch {
        return [{ title: 'Logging 10000 Years into the Future', url: BASE + '/', coverUrl: null }];
      }
    }
    return [];
  }
}

module.exports = Logging10000Scraper;
