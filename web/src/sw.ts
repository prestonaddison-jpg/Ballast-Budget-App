/// <reference lib="webworker" />
/**
 * Ballast service worker.
 *
 * SECURITY RULE — THE ONE THAT MATTERS:
 *   Nothing under /api/ is ever cached, ever read from a cache, and never
 *   falls back to a cached response. Financial balances and session responses
 *   must never be served from disk after the fact. A cached "safe to spend"
 *   is the same class of lie as a stale Plaid sync (§14, "green but dead") —
 *   except the user cannot even see that it is stale.
 *
 * The service worker therefore does exactly one job: precache the app shell so
 * the PWA opens instantly and works offline enough to say "you're offline".
 * All data comes from the network, every time.
 */

declare const self: ServiceWorkerGlobalScope;

// Replaced at build time by Vite's `define`; changing it invalidates the
// shell cache so a deploy cannot leave a stale bundle controlling the app.
declare const __BALLAST_SW_VERSION__: string;
const VERSION = __BALLAST_SW_VERSION__;
const SHELL_CACHE = `ballast-shell-${VERSION}`;

/** Injected at build time with the hashed asset list. */
const SHELL_ASSETS: string[] = (self as unknown as { __BALLAST_SHELL__?: string[] })
  .__BALLAST_SHELL__ ?? ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individual failures must not abort the whole install.
      await Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** Anything the service worker must keep its hands off entirely. */
function isNeverCacheable(url: URL, request: Request): boolean {
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith('/api/')) return true;
  if (url.pathname.startsWith('/auth/')) return true;
  if (url.pathname.startsWith('/webhooks/')) return true;
  // Only GET is ever cacheable.
  if (request.method !== 'GET') return true;
  return false;
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const request = event.request;
  const url = new URL(request.url);

  // Pass straight through to the network — no respondWith, no interception,
  // so there is no code path on which a financial response can be stored.
  if (isNeverCacheable(url, request)) return;

  // App-shell navigations: network first (so a deploy lands immediately),
  // falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cached = await caches.match('/index.html', { cacheName: SHELL_CACHE });
          return (
            cached ??
            new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })
          );
        }
      })(),
    );
    return;
  }

  // Static assets: cache first. They are content-hashed by the build, so a
  // stale hit is impossible for a changed file.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { cacheName: SHELL_CACHE });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});

/**
 * Web Push (Slice 6 wires the payload; the handler ships now so the
 * subscription lifecycle can be exercised in Phase 0).
 *
 * iOS CONSTRAINTS, all of which shape this handler:
 *   - Push requires the PWA to be installed to the Home Screen.
 *     `registration.pushManager` does not exist in a Safari tab at all, so
 *     feature-detection must gate on installed mode, not on the API.
 *   - There is NO silent/background push. `userVisibleOnly: true` is required
 *     and EVERY push must show a notification. If the handler returns before
 *     showNotification resolves, WebKit counts it as a silent push; after
 *     roughly three violations it terminates the subscription while the OS
 *     permission still reads "granted". Hence event.waitUntil() below is not
 *     optional.
 *   - Safari does not fire `pushsubscriptionchange`; subscriptions vanish
 *     silently. The client must call pushManager.getSubscription() on every
 *     app open and re-subscribe — which is why there is no handler for that
 *     event here.
 *   - There is no Background Sync or Periodic Background Sync on iOS, so data
 *     refresh happens on app open and visibilitychange, never in the worker.
 */
self.addEventListener('push', (event: PushEvent) => {
  const data = (() => {
    try {
      return event.data?.json() ?? {};
    } catch {
      return { title: 'Ballast', body: event.data?.text() ?? '' };
    }
  })();

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Ballast', {
      body: data.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      tag: data.tag ?? 'ballast',
      data: { url: data.url ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const target = (event.notification.data?.url as string) ?? '/';
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

export {};
