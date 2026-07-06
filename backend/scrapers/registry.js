const ComixToScraper = require('./comixto');
const Logging10000Scraper = require('./logging10000');
const GreatestEstateDeveloperScraper = require('./greatestestatedeveloper');
const AsuraScansScraper = require('./asurascans');
const GenericScraper = require('./generic');

// Map hostname → dedicated scraper instance. Hosts listed here get purpose-built
// handling; anything else falls back to the GenericScraper below.
const asuraScraper = new AsuraScansScraper();
const scrapers = {
  'comix.to': new ComixToScraper(),
  'logging10000yearsintothefuture.org': new Logging10000Scraper(),
  'w21.greatestestatedeveloper.org': new GreatestEstateDeveloperScraper(),
  'asurascans.com': asuraScraper,
  'asuracomic.net': asuraScraper, // legacy domain → same handler
};

// Default for unknown hosts: best-effort generic scraper (Madara / Themesia /
// server-rendered themes, with a headless-browser fallback).
const defaultScraper = new GenericScraper();

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
