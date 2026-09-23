/**
 * The DOCUMENT must carry the security headers, not just the API.
 *
 * THE DEFECT THIS EXISTS FOR. `wrangler.jsonc` had
 * `run_worker_first: ["/api/*"]`. Per Cloudflare's docs the array form
 * "disables the automatic Sec-Fetch-Mode: navigate detection", so a
 * navigation to `/` matched no pattern, was served straight off the assets
 * binding, and `src/index.ts` never ran — which meant `withSecurityHeaders()`
 * never ran either.
 *
 * Reproduced against a real `wrangler dev`:
 *
 *   GET /            -> Content-Type, Cache-Control, ETag. Nothing else.
 *   GET /api/health  -> CSP, HSTS, X-Frame-Options, Referrer-Policy, nosniff.
 *
 * The exact inversion of what is wanted: the only response a browser actually
 * renders was the only one with no Content-Security-Policy. The installed PWA
 * was framable, and the strict `script-src` that pins the inline theme
 * bootstrap by SHA-256 was not enforced by anything.
 *
 * WHY THIS TEST IS HERE AND NOT IN test/worker/. `routing.test.ts` asserts
 * these headers and PASSES, because `SELF.fetch()` calls the Worker's default
 * export directly and never goes through Cloudflare's asset router at all.
 * It is structurally incapable of seeing this. The Playwright suite runs the
 * real router, so it is the only place the assertion means anything — the
 * same lesson as the Now-Bar, in a different layer.
 *
 * `test/unit/csp.test.ts` proves the CSP STRING is correct. This proves it is
 * ever actually sent. Both are needed; neither substitutes for the other.
 */

import { test, expect } from './fixtures';

/** Headers every HTML document must carry, with what each one is for. */
const REQUIRED = [
  ['content-security-policy', 'script-src / frame-ancestors are enforced here or nowhere'],
  ['x-frame-options', 'belt-and-braces against framing for older engines'],
  ['x-content-type-options', 'stops MIME sniffing a response into a script'],
  ['referrer-policy', 'no bank-adjacent URL leaves in a Referer header'],
] as const;

test.describe('the PWA document', () => {
  test('carries the security headers on a cold navigation to /', async ({ page }) => {
    // Service workers are taken out of the path deliberately: a cached shell
    // served by sw.ts would not exercise the asset router, and this test is
    // only about what the ORIGIN sends.
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response, 'no response for /').toBeTruthy();
    expect(response!.status()).toBe(200);

    const headers = await response!.allHeaders();
    for (const [name, why] of REQUIRED) {
      expect(headers[name], `${name} missing from the document — ${why}`).toBeTruthy();
    }

    const csp = headers['content-security-policy'];
    // The two directives the document specifically depends on.
    expect(csp, 'the installed PWA must not be framable').toContain("frame-ancestors 'none'");
    expect(csp, 'the inline theme bootstrap is pinned by hash').toMatch(/script-src[^;]*sha256-/);
  });

  test('carries them on a deep link too, which SPA fallback also serves', async ({ page }) => {
    // not_found_handling: single-page-application rewrites unknown paths to
    // index.html. That rewrite must not be a way around the headers.
    const response = await page.goto('/envelopes', { waitUntil: 'domcontentloaded' });
    expect(response!.status()).toBe(200);
    const headers = await response!.allHeaders();
    expect(headers['content-security-policy']).toBeTruthy();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  test('and the API still carries them, so the fix did not trade one for the other', async ({
    page,
  }) => {
    const res = await page.request.get('/api/health');
    expect(res.status()).toBe(200);
    const headers = res.headers();
    for (const [name] of REQUIRED) {
      expect(headers[name], `${name} missing from /api/health`).toBeTruthy();
    }
  });
});
