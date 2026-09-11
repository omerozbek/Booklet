const BaseScraper = require('./base');

// Asura Scans is a fully server-rendered (Astro) site, so plain axios + cheerio
// is enough — no puppeteer needed. Title path: /comics/<slug>, chapter path:
// /comics/<slug>/chapter/<n>. Images live on cdn.asurascans.com and have no
// hotlink protection (no Referer/cookies required).
const BASE = 'https://asurascans.com';

// Astro serialises island props as [type, value] pairs: 0 is a plain value
// (an object's fields are pairs again), 1 is an array of pairs. Other types
// (dates, maps, …) aren't needed here and are passed through as-is.
function reviveAstroProps(node) {
  if (Array.isArray(node)) {
    const [type, value] = node;
    if (type === 1 && Array.isArray(value)) return value.map(reviveAstroProps);
    if (type === 0) return reviveAstroFields(value);
    return value;
  }
  return reviveAstroFields(node);
}

function reviveAstroFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reviveAstroProps(v)]));
}

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

    // The page order is the site's own, never re-derived from filenames. Asura
    // splits tall pages into parts — 001.webp, 002_p1.webp, 002_p2.webp, …,
    // 009.webp — and the old filename sort couldn't read "002_p1" as a page
    // number, ranked those as page 0 and shoved 001 to the end of the chapter.
    const props = this._readerProps($);
    if (props?.isLocked) {
      throw new Error('This chapter is locked on Asura Scans (early access)');
    }

    // 1) The reader component's own page list.
    let images = (props?.pages || [])
      .map((p) => p?.url)
      .filter((u) => typeof u === 'string' && u.startsWith('http'));

    // 2) Fallback: the rendered <img> tags, in document order. Page images are
    // served from the CDN under /asura-images/chapters/; this excludes the
    // series cover thumbnail and site assets.
    if (!images.length) {
      $('img[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src && src.includes('/asura-images/chapters/')) images.push(src);
      });
    }

    images = [...new Set(images)];
    if (!images.length) throw new Error('No chapter images found');

    return { images };
  }

  /** Props of the Astro <astro-island> that renders the chapter reader. */
  _readerProps($) {
    let props = null;
    $('astro-island[props]').each((_, el) => {
      if (props) return;
      const raw = $(el).attr('props');
      if (!raw || !raw.includes('"pages"')) return;
      try {
        props = reviveAstroProps(JSON.parse(raw));
      } catch { /* malformed — fall back to the DOM */ }
    });
    return props;
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
