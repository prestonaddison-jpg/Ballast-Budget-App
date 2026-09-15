/**
 * Service worker caching policy.
 *
 * Extracted from sw.ts so it can be tested directly. This is the single most
 * security-critical function in the front end: it decides what may touch Cache
 * Storage at all.
 *
 * WHY THAT MATTERS: Cache Storage is keyed by URL and has NO notion of user
 * identity. A cached authenticated response is readable by the next person to
 * open the device, with no token and no session. So the rule is not "cache API
 * responses carefully" — it is "never let an API response near the cache".
 */

/** Paths that are server state and must never be cached under any strategy. */
const NEVER_CACHE_PREFIXES = ['/api/', '/auth/', '/webhooks/'];

export interface CacheDecisionInput {
  url: URL;
  method: string;
  /** Same-origin check is done against this. */
  workerOrigin: string;
}

/**
 * True when the service worker must NOT touch this request at all.
 *
 * Callers must respond to `true` by returning from the fetch handler WITHOUT
 * calling `event.respondWith()`. Passing through with a manually constructed
 * Request would drop credentials by default and prevent `Set-Cookie` from
 * reaching the document, silently breaking session auth.
 */
export function isNeverCacheable(input: CacheDecisionInput): boolean {
  // Cross-origin: not ours to cache, and opaque responses poison a cache.
  if (input.url.origin !== input.workerOrigin) return true;

  // Only GET is ever cacheable. A POST to /login is not a cache candidate
  // even before the path check runs.
  if (input.method !== 'GET') return true;

  for (const prefix of NEVER_CACHE_PREFIXES) {
    if (input.url.pathname.startsWith(prefix)) return true;
  }

  return false;
}
