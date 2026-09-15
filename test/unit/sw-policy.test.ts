import { describe, expect, it } from 'vitest';
import { isNeverCacheable } from '../../web/src/lib/sw-policy';

const ORIGIN = 'https://ballast.example';
const decide = (path: string, method = 'GET', origin = ORIGIN) =>
  isNeverCacheable({ url: new URL(path, origin), method, workerOrigin: ORIGIN });

describe('service worker caching policy', () => {
  it('NEVER caches anything under /api/', () => {
    // Cache Storage has no notion of user identity: a cached authenticated
    // response is readable by the next person to open the device.
    expect(decide('/api/me')).toBe(true);
    expect(decide('/api/health')).toBe(true);
    expect(decide('/api/auth/login', 'POST')).toBe(true);
    expect(decide('/api/webhooks/plaid', 'POST')).toBe(true);
    expect(decide('/api/me?entity=abc')).toBe(true);
  });

  it('never caches the other server-state prefixes', () => {
    expect(decide('/auth/callback')).toBe(true);
    expect(decide('/webhooks/plaid')).toBe(true);
  });

  it('never caches a non-GET request, whatever the path', () => {
    expect(decide('/index.html', 'POST')).toBe(true);
    expect(decide('/assets/main.js', 'PUT')).toBe(true);
    expect(decide('/', 'DELETE')).toBe(true);
    expect(decide('/', 'HEAD')).toBe(true);
  });

  it('never caches a cross-origin request', () => {
    // Opaque responses poison a cache and are not ours to store.
    expect(decide('https://evil.example/api/me', 'GET', 'https://evil.example')).toBe(true);
    expect(decide('https://cdn.example/font.woff2', 'GET', 'https://cdn.example')).toBe(true);
  });

  it('DOES allow the app shell and static assets', () => {
    expect(decide('/')).toBe(false);
    expect(decide('/index.html')).toBe(false);
    expect(decide('/manifest.webmanifest')).toBe(false);
    expect(decide('/assets/main-abc123.js')).toBe(false);
    expect(decide('/assets/main-abc123.css')).toBe(false);
    expect(decide('/icons/icon-192.png')).toBe(false);
  });

  it('is not fooled by a path that merely contains an excluded prefix', () => {
    // The check is startsWith, so these are legitimately cacheable — but if
    // someone ever changes it to `includes`, these assertions catch the
    // over-broad match. The reverse mistake matters more, and is covered
    // below.
    expect(decide('/assets/api-client-abc.js')).toBe(false);
    expect(decide('/icons/auth-badge.png')).toBe(false);
  });

  it('is not fooled by a path that only LOOKS outside /api/', () => {
    // Traversal and encoding tricks must not sneak an API response into the
    // cache. URL normalization resolves these before the prefix check.
    expect(decide('/static/../api/me')).toBe(true);
    expect(decide('/api/../api/me')).toBe(true);
  });
});
