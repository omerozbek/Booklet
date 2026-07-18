const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const https = require('https');
const fs = require('fs');
const selfsigned = require('selfsigned');
const registry = require('./scrapers/registry');
const imageCache = require('./imageCache');

const app = express();
const PORT = process.env.PORT || 3001;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Keyed by base domain (e.g. "comix.to") → cookie string from a real browser session
const domainCookies = new Map();

app.use(cors());
app.use(express.json());

// Serve apple-touch-icon explicitly so iOS always gets the real file
app.get('/apple-touch-icon.png', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '../frontend/dist/apple-touch-icon.png'));
});

// Serve built frontend in production
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// Fetch title info + chapter list from a manhwa site URL
app.get('/api/title', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  try {
    const scraper = registry.getScraper(url);
    const data = await scraper.fetchTitle(url);
    res.json(data);
  } catch (err) {
    console.error('[title]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetch image URLs for a single chapter
app.get('/api/chapter', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  try {
    const scraper = registry.getScraper(url);
    const data = await scraper.fetchChapter(url);

    // Store browser cookies server-side so the proxy can reuse them
    if (data._cookies && data._cookieDomain) {
      domainCookies.set(data._cookieDomain, data._cookies);
      console.log('[chapter] stored cookies for', data._cookieDomain);
    }
    delete data._cookies;
    delete data._cookieDomain;

    res.json(data);
  } catch (err) {
    console.error('[chapter]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Proxy images to bypass CORS / hotlink protection
app.get('/api/proxy', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  // Self-contained data: URLs (e.g. placeholder pages) — decode and serve as-is.
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
    if (m) {
      const [, contentType, base64, data] = m;
      const buffer = base64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
      res.set('Content-Type', contentType || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=604800');
      res.set('Access-Control-Allow-Origin', '*');
      return res.send(buffer);
    }
    return res.status(400).json({ error: 'Invalid data URL' });
  }

  const origin = new URL(url).origin;
  const hostname = new URL(url).hostname;

  // Serve from puppeteer-captured cache (session-bound CDN tokens work here)
  const cached = imageCache.get(url);
  if (cached) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=604800');
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(cached.buffer);
  }

  // Find stored browser cookies for this domain (e.g. Cloudflare cf_clearance)
  let cookieHeader = '';
  for (const [domain, value] of domainCookies) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      cookieHeader = value;
      break;
    }
  }

  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': referer || origin,
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(cookieHeader && { 'Cookie': cookieHeader }),
      },
      timeout: 30000,
      maxRedirects: 5,
    });

    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=604800');
    res.set('Access-Control-Allow-Origin', '*');
    response.data.pipe(res);
  } catch (err) {
    const status = err.response?.status || 'ERR';
    console.error(`[proxy] ${status} fetching ${url} — ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch image' });
  }
});

// Search for a title by keyword using the first available scraper
app.get('/api/search', async (req, res) => {
  const { q, site } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter required' });

  try {
    const scraper = site ? registry.getScraperByHost(site) : registry.getDefault();
    const data = await scraper.search(q);
    res.json(data);
  } catch (err) {
    console.error('[search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend for all non-API routes (SPA fallback)
app.get('*', (req, res) => {
  const distIndex = path.join(__dirname, '../frontend/dist/index.html');
  res.sendFile(distIndex, (err) => {
    if (err) res.status(404).send('Run `npm run build` in the frontend folder first.');
  });
});

// HTTP server (localhost dev use)
app.listen(PORT, '0.0.0.0', () => {
  console.log(` HTTP  → http://localhost:${PORT}`);
});

// HTTPS server — required for service worker / PWA on iPhone over LAN
async function getOrCreateCert() {
  const keyPath = path.join(__dirname, 'cert.key');
  const certPath = path.join(__dirname, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const attrs = [{ name: 'commonName', value: 'manhwa-reader.local' }];
  const pems = await selfsigned.generate(attrs, { days: 825, keySize: 2048 });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

// Skip the self-signed HTTPS listener when the host terminates TLS (e.g. Hugging Face Spaces)
const HTTPS_DISABLED = process.env.DISABLE_HTTPS === '1' || !!process.env.SPACE_ID;

if (HTTPS_DISABLED) {
  console.log(' HTTPS listener disabled (TLS handled by host)');
} else {
  getOrCreateCert().then((tlsCreds) => {
    https.createServer(tlsCreds, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(` HTTPS → https://localhost:${HTTPS_PORT}`);
      console.log('\n For iPhone: open https://<your-PC-IP>:3443 in Safari');
      console.log(' Accept the self-signed cert warning once, then "Add to Home Screen"\n');
    });
  });
}
