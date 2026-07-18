# ---------- Stage 1: build frontend ----------
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:20-bookworm-slim

# Debian Chromium for puppeteer-core (apt pulls in all required shared libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces runs the container as UID 1000 — the base image's "node" user
# already has that UID and a writable HOME (needed by Chromium)
USER node
ENV HOME=/home/node
WORKDIR /home/node/app

# Root package.json must exist: backend depends on "manhwa-reader-root": "file:.."
COPY --chown=node package.json ./
COPY --chown=node backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY --chown=node backend/ ./backend/
COPY --chown=node --from=frontend-build /build/dist ./frontend/dist

ENV BROWSER_PATH=/usr/bin/chromium \
    PORT=7860 \
    DISABLE_HTTPS=1
EXPOSE 7860
CMD ["node", "backend/server.js"]
