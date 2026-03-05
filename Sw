/* FoxPot Club — Service Worker v1 */
const CACHE = 'foxpot-v1';
const OFFLINE_URL = '/offline.html';

/* Assets to pre-cache on install */
const PRE_CACHE = [
  '/webapp',
  '/offline.html',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter+Tight:wght@400;500;600;700;800&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRE_CACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Never intercept API calls, Telegram auth, or external resources */
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/top-secret') ||
    url.hostname !== self.location.hostname
  ) {
    return;
  }

  /* Network-first for navigation (always fresh HTML) */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then(r => r || new Response('Brak połączenia', { status: 503 }))
      )
    );
    return;
  }

  /* Cache-first for static assets (fonts, images) */
  if (
    url.pathname.match(/\.(css|js|png|jpg|jpeg|webp|svg|woff2?)$/) ||
    url.hostname.includes('fonts.googleapis') ||
    url.hostname.includes('fonts.gstatic')
  ) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }
});
