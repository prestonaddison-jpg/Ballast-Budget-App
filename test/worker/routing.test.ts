import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * Route + middleware ORDERING.
 *
 * src/index.ts mounts the Plaid webhook BEFORE `app.use('/api/*', csrfGuard)`,
 * and every other API route after it. That ordering is load-bearing and
 * non-obvious:
 *
 *   - Plaid is a server. It sends no Origin, no Sec-Fetch-Site and no custom
 *     header, so the browser-shaped CSRF check would reject EVERY genuine
 *     webhook. Its authorization is the ES256 signature instead.
 *   - Every other route is browser traffic and MUST be guarded.
 *
 * Hono composes matched handlers in registration order, so a route registered
 * before `app.use()` is not covered by it. That is a framework behaviour, not
 * something the code states, so it is pinned here: a future refactor that
 * moves the `app.route('/api/webhooks', ...)` line below the `app.use()` line
 * would silently break Plaid, and a refactor that moves it above would
 * silently unguard the API.
 */
describe('API routing and CSRF ordering', () => {
  it('lets the Plaid webhook past the CSRF guard', async () => {
    const res = await SELF.fetch('https://example.com/api/webhooks/plaid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' }),
    });

    // 401 means it REACHED the route and failed signature verification, which
    // is correct — there is no Plaid-Verification header here.
    // 403 would mean the CSRF guard rejected it, which would break every real
    // webhook Plaid ever sends.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('blocks a state-changing API request with no CSRF signals', async () => {
    const res = await SELF.fetch('https://example.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.test', password: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('blocks a cross-origin state-changing request', async () => {
    const res = await SELF.fetch('https://example.com/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'ballast',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ email: 'a@b.test', password: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('lets a same-origin request through the guard to the handler', async () => {
    const res = await SELF.fetch('https://example.com/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'ballast',
        Origin: 'http://localhost:8787',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong' }),
    });
    // 401 = it reached the login handler and the credentials failed.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_credentials');
  });

  it('does not require CSRF signals on a safe method', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.status).toBe(200);
  });

  it('returns 401, not 403, for an unauthenticated read', async () => {
    const res = await SELF.fetch('https://example.com/api/me');
    expect(res.status).toBe(401);
  });
});

describe('security headers', () => {
  it('sets a strict CSP that still permits the service worker and manifest', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    const csp = res.headers.get('Content-Security-Policy') ?? '';

    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // Without these two the strict script-src would block the SW and manifest,
    // which on an installed PWA means no offline shell and no install.
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    // frame-ancestors is the credited anti-framing control; X-Frame-Options is
    // declared obsolete by ASVS 5.0 V3.4.6.
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('never allows an account-data response to be cached', async () => {
    const res = await SELF.fetch('https://example.com/api/me');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('Cache-Control')).toContain('private');
  });

  it('varies on the headers the CSRF guard branches on', async () => {
    // Without this a shared cache could serve one context's response into
    // another.
    const res = await SELF.fetch('https://example.com/api/health');
    const vary = res.headers.get('Vary') ?? '';
    expect(vary).toContain('Sec-Fetch-Site');
    expect(vary).toContain('Origin');
  });

  it('leaks no server or framework identification', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.headers.get('X-Powered-By')).toBeNull();
  });
});
