// Service worker: the app opens offline. Network first (so a new version shows
// up at once), the cache when there is no network. Only the app's own files
// and fonts are cached — never canvases.

const CACHE = 'ilucanvas-app-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin && !url.pathname.includes('__ilucanvas');
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!own && !fonts) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'cors')) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: own && url.pathname.endsWith('/') });
      if (hit) return hit;
      throw err;
    }
  })());
});
