const puppeteer = require('puppeteer-core');
const fs = require('fs');

const BROWSER_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
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

module.exports = { getBrowser };
