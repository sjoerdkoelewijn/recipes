/* KoeleKook service worker — offline support.
   Bump VERSION when the caching logic changes to drop old caches. */
const VERSION = 'v2';
const SHELL_CACHE = 'kk-shell-' + VERSION;
const DATA_CACHE  = 'kk-data-'  + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try { await cache.add('index.html'); } catch (e) {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === SHELL_CACHE || k === DATA_CACHE) ? null : caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never touch writes (PUT/DELETE)
  const url = new URL(req.url);

  // App shell (HTML): network-first, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const res = await fetch(req);
        cache.put('index.html', res.clone());
        return res;
      } catch (e) {
        return (await cache.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  // Recipe text (index.json + .md via the GitHub API): network-first.
  if (url.hostname === 'api.github.com') {
    event.respondWith(networkFirst(req, DATA_CACHE));
    return;
  }

  // Recipe photos: serve cached instantly, refresh in the background.
  if (url.hostname === 'raw.githubusercontent.com') {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // Same-origin assets + Google Fonts: cache-first.
  event.respondWith(cacheFirst(req, SHELL_CACHE));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}
