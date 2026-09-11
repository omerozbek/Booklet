# Manhwa Reader

A self-hosted Progressive Web App for downloading and reading manhwa on your iPhone. Runs a local Node.js backend that scrapes chapter images and proxies them to the app, which stores downloaded chapters in IndexedDB for offline reading.

**Live app:** https://booklet-jmqp.onrender.com

Open it in iPhone Safari and tap **Share → Add to Home Screen**. It's hosted on Render's free tier, so the first load after ~15 minutes of inactivity can take about a minute while the server wakes up.

## Features

- Add any title by pasting its URL
- Download chapters for offline reading (with cancel support)
- Delete titles — removes all downloaded chapters and images
- Vertical scroll reader optimized for webtoon/manhwa format
- Works as a full-screen PWA when added to iPhone home screen
- Extensible scraper system — add new sites easily

## Requirements

- [Node.js](https://nodejs.org/) v18+
- Your iPhone and PC on the same Wi-Fi network

## Setup

```bash
# Install all dependencies
npm run install:all

# Generate PWA icons (optional but recommended for a proper home screen icon)
npm install canvas
node generate-icons.mjs
```

## Running

### Development (hot reload)

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3001`

### Production (iPhone-ready)

```bash
npm run build   # build the frontend
npm start       # serve everything from port 3001
```

Then find your PC's local IP address:

```bash
ipconfig        # look for IPv4 Address, e.g. 192.168.1.42
```

Open `http://192.168.1.42:3001` in iPhone Safari, tap **Share → Add to Home Screen**.

> **iPhone can't connect?** Your Windows network profile is probably set to Public. Run this in PowerShell as Administrator to fix it:
> ```powershell
> Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq "Public" } | Set-NetConnectionProfile -NetworkCategory Private
> ```
> Also allow the ports through Windows Firewall:
> ```powershell
> New-NetFirewallRule -DisplayName "Manhwa Vite 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Any
> New-NetFirewallRule -DisplayName "Manhwa Backend 3001" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow -Profile Any
> ```

## Usage

1. Tap **+ Add** and paste a title page URL (e.g. `https://comix.to/title/some-title/`)
2. The chapter list loads automatically
3. Tap **↓ Save** on individual chapters or **Download All**
4. Tap **Read** on any saved chapter — works fully offline

## Adding a New Site

1. Create `backend/scrapers/yoursite.js` extending `BaseScraper`:

```js
const BaseScraper = require('./base');

class YourSiteScraper extends BaseScraper {
  constructor() { super('https://yoursite.com'); }

  async fetchTitle(url) {
    const { $ } = await this.fetchHtml(url);
    // parse and return { title, coverUrl, synopsis, chapters: [{ title, url, number }] }
  }

  async fetchChapter(url) {
    const { $ } = await this.fetchHtml(url);
    // return { images: ['https://...', ...] }
  }
}

module.exports = YourSiteScraper;
```

2. Register it in `backend/scrapers/registry.js`:

```js
const YourSiteScraper = require('./yoursite');
const scrapers = {
  'comix.to': new ComixToScraper(),
  'yoursite.com': new YourSiteScraper(),  // add this
};
```

## Commit Workflow

- **Commit after every change.** Each change gets its own commit — don't let work pile up uncommitted.
- **No AI attribution.** Commit messages must not mention Claude or any AI assistant — no `Co-Authored-By` trailers, session links, or "generated with" notes.
- **Bump the version in every commit.** The app version shown in **Settings → About** comes from `frontend/package.json`. Bump it before committing (patch for fixes, minor for features):

  ```bash
  cd frontend
  npm version patch --no-git-tag-version   # or: minor
  ```

  This updates both `package.json` and `package-lock.json`; include them in the commit.

## Project Structure

```
├── backend/
│   ├── server.js           # Express API (title, chapter, proxy endpoints)
│   └── scrapers/
│       ├── base.js             # Base class with fetch + cheerio helpers
│       ├── comixto.js          # comix.to scraper
│       ├── logging10000.js     # logging10000.com scraper
│       └── registry.js         # hostname → scraper mapping
└── frontend/
    └── src/
        ├── db.js                   # IndexedDB wrapper (titles, chapters, images)
        ├── pages/Library.jsx       # Home screen — saved titles grid
        ├── pages/TitleView.jsx     # Chapter list + download manager
        ├── pages/Reader.jsx        # Vertical scroll reader
        └── components/AddTitle.jsx # Add-title sheet
```
