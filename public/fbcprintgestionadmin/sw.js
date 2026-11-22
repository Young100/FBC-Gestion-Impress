const CACHE_NAME = 'fbc-atelier-v1';
const APP_SHELL_URL = '/fbcprintgestionadmin/';

const STATIC_ASSETS = [
  '/atelier-icon.svg',
  '/atelier-apple-touch-icon.png',
  '/atelier-192x192.png',
  '/atelier-512x512.png',
  '/atelier-maskable-512x512.png',
  '/atelier-manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('fbc-atelier-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for Atelier HTML shell so auth/version updates stay fresh
  if (request.mode === 'navigate' && url.pathname.startsWith('/fbcprintgestionadmin')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(APP_SHELL_URL, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(APP_SHELL_URL);
          return cached || Response.error();
        })
    );
    return;
  }

  // Cache-first with background refresh for Atelier icons, manifests & built assets
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/atelier-')
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || APP_SHELL_URL;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/fbcprintgestionadmin') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});

