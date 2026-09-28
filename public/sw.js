/**
 * Service worker.
 *
 * Strategy:
 *  - App shell (HTML, CSS, JS, Leaflet): cache-first, refreshed in the
 *    background. The app opens instantly even with no signal.
 *  - Map tiles: cache-first with a rolling cap, so roads you have already
 *    looked at stay visible offline.
 *  - API GETs: network-first, falling back to the last good response.
 *  - API writes: never cached — the app's own outbox handles those.
 */

const VERSION = 'v2.0.0';
const SHELL_CACHE = `nr-shell-${VERSION}`;
const TILE_CACHE = 'nr-tiles';
const DATA_CACHE = 'nr-data';
const TILE_LIMIT = 600;

const SHELL = [
  '/',
  '/index.html',
  '/track.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/store.js',
  '/js/util.js',
  '/js/mapview.js',
  '/js/plan.js',
  '/js/reports.js',
  '/js/trips.js',
  '/js/insights.js',
  '/js/assistant.js',
  '/js/track.js',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/icons/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nr-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept the live event stream.
  if (url.pathname === '/api/stream') return;

  // Map tiles from any provider.
  if (/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/.test(url.hostname)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const response = await fetch(request);
          if (response.ok) {
            cache.put(request, response.clone());
            trimCache(TILE_CACHE, TILE_LIMIT);
          }
          return response;
        } catch {
          return new Response('', { status: 504 });
        }
      }),
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // API: network first, cached copy as the safety net.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(DATA_CACHE);
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match(request);
          if (cached) {
            const body = await cached.json().catch(() => ({}));
            return new Response(JSON.stringify({ ...body, stale: true }), {
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ error: 'You are offline and this has not been cached yet.' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
      })(),
    );
    return;
  }

  // Shell: cache first, revalidate quietly.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      const network = fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);
      if (cached) return cached;
      const response = await network;
      if (response) return response;
      if (request.mode === 'navigate') {
        return (await caches.match('/index.html')) ?? new Response('Offline', { status: 503 });
      }
      return new Response('', { status: 504 });
    })(),
  );
});
