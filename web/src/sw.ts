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

import { isNeverCacheable } from './lib/sw-policy';

declare const self: ServiceWorkerGlobalScope;

// Replaced at build time by Vite's `define`; changing it invalidates the
// shell cache so a deploy cannot leave a stale bundle controlling the app.
declare const __BALLAST_SW_VERSION__: string;
const VERSION = __BALLAST_SW_VERSION__;
const SHELL_CACHE = `ballast-shell-${VERSION}`;

/**
 * The app shell, injected at build time with the REAL content-hashed asset
 * filenames (see the ballastShellManifest plugin in web/vite.config.ts).
 *
 * This has to happen at build time: bundle names carry content hashes that are
 * not known when this file is written. Precaching the actual names is what
 * makes the shell work offline on the FIRST launch, rather than only after a
 * successful online visit has populated the runtime cache.
 */
declare const __BALLAST_SHELL__: string[];
const SHELL_ASSETS: string[] = __BALLAST_SHELL__;

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // One failed asset must not abort the whole install, but it must not
      // pass unnoticed either: `activate` deletes every older cache, so a
      // silently incomplete precache leaves a permanently broken offline
      // shell with no way to notice it happened.
      const results = await Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      );
      const failed = SHELL_ASSETS.filter((_, i) => results[i].status === 'rejected');
      if (failed.length) {
        console.warn('[ballast sw] shell assets failed to precache', failed);
      }
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

self.addEventListener('fetch', (event: FetchEvent) => {
  const request = event.request;
  const url = new URL(request.url);

  // Pass straight through to the network — no respondWith, no interception,
  // so there is no code path on which a financial response can be stored.
  if (isNeverCacheable({ url, method: request.method, workerOrigin: self.location.origin })) return;

  // App-shell navigations: network first (so a deploy lands immediately),
  // falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          // Cache Storage matches on URL, so '/' and '/index.html' are
          // DIFFERENT keys. Both are precached; try each before giving up,
          // because which one a navigation resolves to depends on how the
          // app was opened (Home Screen start_url vs a deep link).
          const cached =
            (await caches.match('/index.html', { cacheName: SHELL_CACHE })) ??
            (await caches.match('/', { cacheName: SHELL_CACHE }));
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
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        // Offline with a cache miss — an asset that failed to precache, or one
        // added after this worker installed. Without this catch the fetch
        // handler rejects and the browser shows its own network error page
        // instead of the app shell's offline state.
        return new Response('', { status: 504, statusText: 'Offline' });
      }
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
