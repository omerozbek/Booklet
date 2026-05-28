const TTL = 60 * 60 * 1000; // 1 hour

const cache = new Map();

module.exports = {
  set(url, buffer, contentType) {
    cache.set(url, { buffer, contentType, expires: Date.now() + TTL });
  },
  get(url) {
    const entry = cache.get(url);
    if (!entry) return null;
    if (Date.now() > entry.expires) { cache.delete(url); return null; }
    return entry;
  },
};
