// Offline support: the app opens with no signal, and map tiles you have already viewed stay cached.
// Bump VERSION whenever app files change so phones pick up the update.
const VERSION = 'v2';
const APP_CACHE = `gss-app-${VERSION}`;
const TILE_CACHE = 'gss-tiles';
const MAX_TILES = 3000;

const APP_FILES = [
  './', './index.html', './css/app.css', './js/app.js', './js/logic.js', './js/pdf.js', './js/vendor/pdf-lib.esm.min.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith('gss-app-') && k !== APP_CACHE).map((k) => caches.delete(k)),
  )).then(() => self.clients.claim()));
});

function isTile(url) {
  return url.hostname === 'server.arcgisonline.com' || url.hostname === 'tile.openstreetmap.org';
}

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (isTile(url)) {
    // Network first so tiles stay fresh; fall back to cache when offline.
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(TILE_CACHE).then((c) => c.put(e.request, copy)).then(() => { if (Math.random() < 0.02) trimTiles(); });
      }
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }

  // App files: network first (so updates show right away), cache when offline.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && (url.origin === location.origin || url.hostname === 'unpkg.com')) {
      const copy = res.clone();
      caches.open(APP_CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
