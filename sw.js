/* KoeleKook service worker — offline support.
   Bump VERSION when the caching logic changes to drop old caches. */
const VERSION = 'v3';
const SHELL_CACHE = 'kk-shell-' + VERSION;
const DATA_CACHE  = 'kk-data-'  + VERSION;

/* Precached on install so the app works offline right after the first visit,
   before the worker has had a chance to see these requests go by. */
const SHELL_ASSETS = ['index.html', 'app.js', 'style.css', 'logo.svg', 'favicon.svg', 'icon.svg', 'manifest.json'];
const RECIPE_INDEX = 'https://api.github.com/repos/sjoerdkoelewijn/recipes/contents/recipes/index.json?ref=main';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // Individually, so one failure doesn't abort the whole install.
    await Promise.all(SHELL_ASSETS.map(a => shell.add(a).catch(() => {})));
    const data = await caches.open(DATA_CACHE);
    await data.add(RECIPE_INDEX).catch(() => {});
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

/* The app asks for a full offline copy once it has loaded (and is online).
   Recipe text is tiny, so all of it is fetched; photos follow after, and any
   photo that isn't cached simply falls back to the app's placeholder. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'cache-all') {
    event.waitUntil(cacheAllRecipes());
  }
});

const API_BASE = 'https://api.github.com/repos/sjoerdkoelewijn/recipes/contents/';
const RAW_BASE = 'https://raw.githubusercontent.com/sjoerdkoelewijn/recipes/main/recipes/';

async function cacheAllRecipes() {
  const cache = await caches.open(DATA_CACHE);
  let entries;
  try {
    const res = await fetch(RECIPE_INDEX);
    if (!res.ok) return;
    cache.put(RECIPE_INDEX, res.clone());
    const data = await res.json();
    entries = JSON.parse(atob(data.content.replace(/\s/g, '')));
  } catch (e) { return; }

  // 1. Recipe text — small, so fetch every one that isn't cached yet.
  for (const entry of entries) {
    const url = `${API_BASE}recipes/${entry.slug}.md?ref=main`;
    if (await cache.match(url)) continue;
    try {
      const r = await fetch(url);
      if (r.ok) await cache.put(url, r.clone());
    } catch (e) { return; }   // offline again: stop quietly
  }

  // 2. Photos — heavier, fetched one at a time so we don't hog bandwidth.
  for (const entry of entries) {
    if (!entry.image) continue;
    const url = RAW_BASE + entry.image;
    if (await cache.match(url)) continue;
    try {
      const r = await fetch(url);
      if (r.ok) await cache.put(url, r.clone());
    } catch (e) { return; }
  }
}

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
  // Fall back to ignoring ?v= so a precached asset still matches a versioned
  // request (and an old cached copy still works offline after a version bump).
  const cached = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
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
