const ComixToScraper = require('./comixto');

// Map hostname → scraper instance
// Add new sites here as you discover them
const scrapers = {
  'comix.to': new ComixToScraper(),
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
