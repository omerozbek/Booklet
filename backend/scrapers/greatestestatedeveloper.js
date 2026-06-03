const BaseScraper = require('./base');

const BASE = 'https://w21.greatestestatedeveloper.org';
const HOSTNAME = 'w21.greatestestatedeveloper.org';

class GreatestEstateDeveloperScraper extends BaseScraper {
  constructor() { super(BASE); }

  async fetchTitle(url) {
    const { $ } = await this.fetchHtml(BASE + '/');

    const title =
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      'The Greatest Estate Developer';

    const coverUrl =
      $('meta[property="og:image"]').attr('content') ||
      $('img[src*="wp-content/uploads"]').first().attr('src') ||
      null;

    const synopsis =
      $('meta[property="og:description"]').attr('content') ||
      $('div.summary__content p').first().text().trim() ||
      '';

    const chapters = [];
    const seen = new Set();

    $('a[href*="/manga/"]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (!href || !href.includes('-chapter-')) return;
      const numMatch = href.match(/chapter-([\d]+(?:-\d+)?)\/?$/i);
      if (!numMatch) return;
      const rawNum = numMatch[1].replace('-', '.');
      const number = parseFloat(rawNum);
      if (!seen.has(number)) {
        seen.add(number);
        chapters.push({ url: href, number, title: text || `Chapter ${number}` });
      }
    });

    chapters.sort((a, b) => a.number - b.number);

    return { title, coverUrl, synopsis, chapters };
  }

  async fetchChapter(url) {
    const { $ } = await this.fetchHtml(url, { Referer: BASE });

    const images = [];
    $('img[src]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (!src || !src.startsWith('http')) return;
      try {
        const h = new URL(src).hostname;
        // Skip site's own assets (logos, icons, cover thumbnails)
        if (h === HOSTNAME || h.endsWith('.' + HOSTNAME)) return;
        // Skip tiny tracking/ad images
        const w = parseInt($(el).attr('width') || '0', 10);
        const h2 = parseInt($(el).attr('height') || '0', 10);
        if ((w && w < 100) || (h2 && h2 < 100)) return;
      } catch { return; }
      images.push(src);
    });

    if (!images.length) throw new Error('No chapter images found');

    return { images };
  }

  async search(query) {
    const q = query.toLowerCase();
    const keywords = ['greatest', 'estate', 'developer', 'lloyd', 'suho', 'frontera', 'engineer'];
    if (keywords.some(k => q.includes(k))) {
      try {
        const { $ } = await this.fetchHtml(BASE + '/');
        const coverUrl =
          $('meta[property="og:image"]').attr('content') ||
          $('img[src*="wp-content/uploads"]').first().attr('src') ||
          null;
        return [{ title: 'The Greatest Estate Developer', url: BASE + '/', coverUrl }];
      } catch {
        return [{ title: 'The Greatest Estate Developer', url: BASE + '/', coverUrl: null }];
      }
    }
    return [];
  }
}

module.exports = GreatestEstateDeveloperScraper;
