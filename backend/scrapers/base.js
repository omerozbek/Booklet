const axios = require('axios');
const cheerio = require('cheerio');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

class BaseScraper {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  async fetchHtml(url, extraHeaders = {}) {
    const response = await axios.get(url, {
      headers: { ...BROWSER_HEADERS, Referer: this.baseUrl, ...extraHeaders },
      timeout: 30000,
    });
    return { $: cheerio.load(response.data), html: response.data };
  }

  /** Extract __NEXT_DATA__ embedded JSON (Next.js sites) */
  extractNextData($) {
    try {
      const raw = $('#__NEXT_DATA__').html();
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** Extract any JSON assigned to a window variable */
  extractWindowVar(html, varName) {
    try {
      const match = html.match(new RegExp(`${varName}\\s*=\\s*(\\{[\\s\\S]*?\\});`));
      return match ? JSON.parse(match[1]) : null;
    } catch {
      return null;
    }
  }

  /** Resolve a potentially relative URL against this scraper's base */
  resolveUrl(href) {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    if (href.startsWith('//')) return `https:${href}`;
    return `${this.baseUrl.replace(/\/$/, '')}${href.startsWith('/') ? '' : '/'}${href}`;
  }

  async fetchTitle(url) {
    throw new Error('fetchTitle() not implemented for this scraper');
  }

  async fetchChapter(url) {
    throw new Error('fetchChapter() not implemented for this scraper');
  }

  async search(query) {
    throw new Error('search() not implemented for this scraper');
  }
}

module.exports = BaseScraper;
