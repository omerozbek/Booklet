const BaseScraper = require('./base');

// Asura Scans is a fully server-rendered (Astro) site, so plain axios + cheerio
// is enough — no puppeteer needed. Title path: /comics/<slug>, chapter path:
// /comics/<slug>/chapter/<n>. Images live on cdn.asurascans.com and have no
// hotlink protection (no Referer/cookies required).
const BASE = 'https://asurascans.com';

class AsuraScansScraper extends BaseScraper {
  constructor() { super(BASE); }

  async fetchTitle(url) {
    const { $ } = await this.fetchHtml(url);

    const title =
      ($('meta[property="og:title"]').attr('content') || '')
        .replace(/\s*\|\s*Asura Scans\s*$/i, '').trim() ||
      $('h1').first().text().trim();

    const coverUrl = $('meta[property="og:image"]').attr('content') || null;

    const synopsis = $('meta[property="og:description"]').attr('content') || '';

    const chapters = [];
    const seen = new Set();

    $('a[href*="/chapter/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const m = href.match(/\/chapter\/([\d.]+)/);
      if (!m) return;
      const number = parseFloat(m[1]);
      if (Number.isNaN(number) || seen.has(number)) return;

      // Each chapter list row starts with a "Chapter N" label. The decorative
      // "First Chapter" / latest-chapter buttons link to the same numbers but
      // don't, so this skips them and keeps the clean per-row title.
      const name = $(el).find('span').first().text().replace(/\s+/g, ' ').trim();
      if (!/^Chapter/i.test(name)) return;

      seen.add(number);
      chapters.push({ url: this.resolveUrl(href), number, title: name });
    });

    chapters.sort((a, b) => a.number - b.number);

    return { title, coverUrl, synopsis, chapters };
  }

  async fetchChapter(url) {
    const { $ } = await this.fetchHtml(url);

    const images = [];
    const seen = new Set();
    $('img[src]').each((_, el) => {
      const src = $(el).attr('src');
      // Page images are served from the CDN under /asura-images/chapters/;
      // this excludes the series cover thumbnail and site assets.
      if (!src || !src.includes('/asura-images/chapters/')) return;
      if (seen.has(src)) return;
      seen.add(src);
      images.push(src);
    });

    if (!images.length) throw new Error('No chapter images found');

    // Order by the page number in the filename (e.g. .../1/001.webp) so the
    // reader never depends on DOM order.
    const pageNum = (u) => {
      const m = u.match(/\/(\d+)\.(?:webp|jpe?g|png)(?:\?|$)/i);
      return m ? parseInt(m[1], 10) : 0;
    };
    images.sort((a, b) => pageNum(a) - pageNum(b));

    return { images };
  }

  async search(query) {
    // Asura's search is client-side only, so do a best-effort scan of the
    // homepage listing and match against the comic slug.
    const q = query.trim().toLowerCase();
    if (!q) return [];
    try {
      const { $ } = await this.fetchHtml(BASE + '/');
      const results = [];
      const seen = new Set();

      $('a[href*="/comics/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.includes('/chapter/')) return;
        const slug = href.split('/comics/')[1]?.split(/[?#]/)[0];
        if (!slug || seen.has(slug)) return;

        // Drop the trailing path hash and turn the slug into a readable title.
        const human = slug
          .replace(/-[0-9a-f]{6,}$/i, '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());

        if (!slug.includes(q) && !human.toLowerCase().includes(q)) return;

        seen.add(slug);
        results.push({
          title: human,
          url: this.resolveUrl(href),
          coverUrl: $(el).find('img').first().attr('src') || null,
        });
      });

      return results.slice(0, 20);
    } catch {
      return [];
    }
  }
}

module.exports = AsuraScansScraper;
