const ComixToScraper = require('./comixto');
const Logging10000Scraper = require('./logging10000');

// Map hostname → scraper instance
// Add new sites here as you discover them
const scrapers = {
  'comix.to': new ComixToScraper(),
  'logging10000yearsintothefuture.org': new Logging10000Scraper(),
};

const defaultScraper = new ComixToScraper();

function getScraper(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return scrapers[hostname] || defaultScraper;
  } catch {
    return defaultScraper;
  }
}

function getScraperByHost(host) {
  return scrapers[host.replace(/^www\./, '')] || defaultScraper;
}

function getDefault() {
  return defaultScraper;
}

function registerScraper(hostname, scraper) {
  scrapers[hostname] = scraper;
}

module.exports = { getScraper, getScraperByHost, getDefault, registerScraper };
