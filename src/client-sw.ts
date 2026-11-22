// FBC Print Client PWA Service Worker (works in both dev module SW and production build)

interface SwManifestEntry {
  url: string;
  revision?: string | null;
}

interface SwWindowClient {
  url: string;
  focused?: boolean;
  focus: () => Promise<SwWindowClient>;
  navigate?: (url: string) => Promise<SwWindowClient | null>;
}

interface SwNotificationActionEvent extends Event {
  notification: Notification & { data?: { url?: string; notifId?: string } };
  waitUntil: (promise: Promise<unknown>) => void;
}

interface SwPushEvent extends Event {
  data?: {
    json: () => unknown;
    text: () => string;
  } | null;
  waitUntil: (promise: Promise<unknown>) => void;
}

interface SwMessageEvent extends Event {
  data: { type?: string; count?: number } | null;
  waitUntil: (promise: Promise<unknown>) => void;
}

interface SwGlobalScope {
  __WB_MANIFEST?: Array<string | SwManifestEntry>;
  location: Location;
  navigator: Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  registration: ServiceWorkerRegistration & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  clients: {
    claim: () => Promise<void>;
    matchAll: (options?: { type?: string; includeUncontrolled?: boolean }) => Promise<SwWindowClient[]>;
    openWindow: (url: string) => Promise<SwWindowClient | null>;
  };
  skipWaiting: () => Promise<void>;
  addEventListener: (
    type: string,
    listener: (event: any) => void
  ) => void;
}

const sw = self as unknown as SwGlobalScope;

const CACHE_NAME = 'fbc-client-v2';
const BADGE_CACHE_NAME = 'fbc-client-badge-v1';
const BADGE_URL = '/__fbc_client_unread_badge__';
const APP_SHELL_URL = '/client/';

const STATIC_ASSETS = [
  '/icon.svg',
  '/apple-touch-icon.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
];

// Injected by VitePWA injectManifest during production build; empty in dev mode
const precacheManifest: Array<string | SwManifestEntry> =
  (self as unknown as SwGlobalScope).__WB_MANIFEST || [];

async function readStoredBadgeCount(): Promise<number> {
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

async function writeStoredBadgeCount(count: number): Promise<number> {
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
    // Ignore cache write failures
  }
  return safeCount;
}

async function applyAppBadge(count: number): Promise<void> {
  const safeCount = Math.max(0, Math.floor(count));
  await writeStoredBadgeCount(safeCount);
  try {
    if (safeCount > 0) {
      if (typeof sw.navigator.setAppBadge === 'function') {
        await sw.navigator.setAppBadge(safeCount);
      } else if (typeof sw.registration.setAppBadge === 'function') {
        await sw.registration.setAppBadge(safeCount);
      }
    } else {
      if (typeof sw.navigator.clearAppBadge === 'function') {
        await sw.navigator.clearAppBadge();
      } else if (typeof sw.registration.clearAppBadge === 'function') {
        await sw.registration.clearAppBadge();
      }
    }
  } catch {
    // App Badging API may be unsupported on some platforms
  }
}

sw.addEventListener('install', (event: { waitUntil: (p: Promise<unknown>) => void }) => {
  const manifestUrls = precacheManifest
    .map((entry) => (typeof entry === 'string' ? entry : entry.url))
    .filter((u) => Boolean(u) && !u.includes('atelier'));

  const urlsToCache = Array.from(new Set([...STATIC_ASSETS, ...manifestUrls]));

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          urlsToCache.map((u) =>
            cache.add(u).catch(() => undefined)
          )
        )
      )
      .then(() => sw.skipWaiting())
  );
});

sw.addEventListener('activate', (event: { waitUntil: (p: Promise<unknown>) => void }) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('fbc-client-') && k !== CACHE_NAME && k !== BADGE_CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener('fetch', (event: { request: Request; respondWith: (p: Promise<Response>) => void }) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/fbcprintgestionadmin')) return;
  if (url.pathname.startsWith('/server-views/')) return;

  if (
    request.mode === 'navigate' &&
    (url.pathname === '/client' || url.pathname.startsWith('/client/'))
  ) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(APP_SHELL_URL, copy));
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

  if (
    url.pathname.startsWith('/pwa-') ||
    url.pathname === '/icon.svg' ||
    url.pathname === '/apple-touch-icon.png'
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const net = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached as Response);
        return cached || net;
      })
    );
  }
});

sw.addEventListener('push', (event: SwPushEvent) => {
  let payload: {
    title?: string;
    body?: string;
    tag?: string;
    icon?: string;
    badge?: string;
    url?: string;
    unreadCount?: number;
    requireInteraction?: boolean;
    notifId?: string;
    timestamp?: number;
  } = {};

  if (event.data) {
    try {
      payload = (event.data.json() as typeof payload) || {};
    } catch {
      const txt = event.data.text();
      payload = { title: 'FBC Print', body: txt };
    }
  }

  const title = payload.title || 'FBC Print — Mise à jour commande';
  const body =
    payload.body || 'Votre commande a reçu une nouvelle mise à jour.';
  const targetUrl = payload.url || APP_SHELL_URL;
  const tag = payload.tag || `fbc-client-${Date.now()}`;

  event.waitUntil(
    (async () => {
      const currentStored = await readStoredBadgeCount();
      const nextCount =
        typeof payload.unreadCount === 'number' && payload.unreadCount > 0
          ? payload.unreadCount
          : currentStored + 1;

      await applyAppBadge(nextCount);

      const notifOptions: NotificationOptions & {
        renotify?: boolean;
        silent?: boolean;
        vibrate?: number[];
        timestamp?: number;
        data?: { url?: string; notifId?: string };
      } = {
        body,
        icon: payload.icon || '/pwa-192x192.png',
        badge: payload.badge || '/pwa-192x192.png',
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
      };

      await sw.registration.showNotification(title, notifOptions);
    })()
  );
});

sw.addEventListener('notificationclick', (event: SwNotificationActionEvent) => {
  event.notification.close();
  const targetUrl =
    (event.notification.data && event.notification.data.url) || APP_SHELL_URL;

  event.waitUntil(
    (async () => {
      const remaining = await sw.registration.getNotifications();
      if (remaining.length === 0) {
        await applyAppBadge(0);
      } else {
        await applyAppBadge(remaining.length);
      }

      const clientList = await sw.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if (client.url.includes('/client') && 'focus' in client) {
          if (typeof client.navigate === 'function') {
            const navigated = await client.navigate(targetUrl).catch(() => null);
            return navigated ? navigated.focus() : client.focus();
          }
          return client.focus();
        }
      }
      if (sw.clients.openWindow) {
        return sw.clients.openWindow(targetUrl);
      }
      return undefined;
    })()
  );
});

sw.addEventListener('message', (event: SwMessageEvent) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'SET_BADGE') {
    const count = typeof msg.count === 'number' ? msg.count : 0;
    event.waitUntil(applyAppBadge(count));
  } else if (msg.type === 'CLEAR_BADGE') {
    event.waitUntil(applyAppBadge(0));
  }
});
