// App-shell cache only. Never touches /.netlify/functions/ or cross-origin requests (Mapbox, fonts).
// Network first so a deploy shows up immediately; the cache is the offline fallback.
const CACHE = 'spin-shell-v1';
const SHELL = ['/', '/index.html', '/app.js', '/here.js', '/here.css', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/.netlify/')) return;
  const path = url.pathname === '/' ? '/' : url.pathname;
  if (!SHELL.includes(path)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(path, copy));
        }
        return res;
      })
      .catch(() => caches.match(path))
  );
});
