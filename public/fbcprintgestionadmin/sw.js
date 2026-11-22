const CACHE_NAME = 'fbc-atelier-v2';
const BADGE_CACHE_NAME = 'fbc-atelier-badge-v1';
const BADGE_URL = '/__fbc_atelier_unread_badge__';
const APP_SHELL_URL = '/fbcprintgestionadmin/';

const STATIC_ASSETS = [
  '/atelier-icon.svg',
  '/atelier-apple-touch-icon.png',
  '/atelier-192x192.png',
  '/atelier-512x512.png',
  '/atelier-maskable-512x512.png',
  '/atelier-manifest.webmanifest',
];

async function readStoredBadgeCount() {
  try {
    const cache = await caches.open(BADGE_CACHE_NAME);
    const res = await cache.match(BADGE_URL);
    if (!res) return 0;
    const raw = await res.text();
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

async function writeStoredBadgeCount(count) {
  const safeCount = Math.max(0, Math.floor(count));
  try {
    const cache = await caches.open(BADGE_CACHE_NAME);
    await cache.put(
      BADGE_URL,
      new Response(String(safeCount), {
        headers: { 'Content-Type': 'text/plain' },
      })
    );
  } catch {
    // Ignore cache write errors
  }
  return safeCount;
}

async function applyAppBadge(count) {
  const safeCount = Math.max(0, Math.floor(count));
  await writeStoredBadgeCount(safeCount);
  try {
    if (safeCount > 0) {
      if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
        await self.navigator.setAppBadge(safeCount);
      } else if (self.registration && typeof self.registration.setAppBadge === 'function') {
        await self.registration.setAppBadge(safeCount);
      }
    } else {
      if (self.navigator && typeof self.navigator.clearAppBadge === 'function') {
        await self.navigator.clearAppBadge();
      } else if (self.registration && typeof self.registration.clearAppBadge === 'function') {
        await self.registration.clearAppBadge();
      }
    }
  } catch {
    // App Badging API unsupported on this platform
  }
}

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
            .filter(
              (key) =>
                key.startsWith('fbc-atelier-') &&
                key !== CACHE_NAME &&
                key !== BADGE_CACHE_NAME
            )
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

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json() || {};
    } catch {
      payload = { title: 'FBC Atelier', body: event.data.text() };
    }
  }

  const title = payload.title || 'FBC Atelier — Nouvelle alerte';
  const body = payload.body || 'Une action est requise dans votre espace atelier.';
  const targetUrl = payload.url || APP_SHELL_URL;
  const tag = payload.tag || `fbc-atelier-${Date.now()}`;

  event.waitUntil(
    (async () => {
      const currentStored = await readStoredBadgeCount();
      const nextCount =
        typeof payload.unreadCount === 'number' && payload.unreadCount > 0
          ? payload.unreadCount
          : currentStored + 1;

      await applyAppBadge(nextCount);

      await self.registration.showNotification(title, {
        body,
        icon: payload.icon || '/atelier-192x192.png',
        badge: payload.badge || '/atelier-192x192.png',
        tag,
        renotify: true,
        silent: false,
        vibrate: [220, 100, 220],
        requireInteraction: Boolean(payload.requireInteraction),
        timestamp: payload.timestamp || Date.now(),
        data: {
          url: targetUrl,
          notifId: payload.notifId,
        },
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl =
    (event.notification.data && event.notification.data.url) || APP_SHELL_URL;

  event.waitUntil(
    (async () => {
      const remaining = await self.registration.getNotifications();
      await applyAppBadge(remaining.length);

      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if (client.url.includes('/fbcprintgestionadmin') && 'focus' in client) {
          if ('navigate' in client && typeof client.navigate === 'function') {
            const nav = await client.navigate(targetUrl).catch(() => null);
            return nav ? nav.focus() : client.focus();
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })()
  );
});

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'SET_BADGE') {
    const count = typeof msg.count === 'number' ? msg.count : 0;
    event.waitUntil(applyAppBadge(count));
  } else if (msg.type === 'CLEAR_BADGE') {
    event.waitUntil(applyAppBadge(0));
  }
});
