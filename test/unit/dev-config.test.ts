/**
 * The shipped config must be production-safe AND local development must work.
 *
 * THE DEFECT THIS EXISTS FOR. `APP_ORIGIN` was widened to a comma-separated
 * list and set to the two production origins. That is correct for production
 * and it silently killed local development, because:
 *
 *   - `checkCsrf` requires the request Origin to be one of `allowedOrigins`,
 *     and `http://localhost:8787` is not in that list — so `npm run dev`
 *     answered **403 to every write, including login**. Reproduced live
 *     against a real `wrangler dev`: POST /api/auth/login with
 *     `Origin: http://localhost:8787` returned `403 {"code":"forbidden"}`.
 *
 *   - `isLocalDev()` reads only the CANONICAL (first) origin, which is now
 *     https, so the same local server sets a `__Host-`/`Secure` session
 *     cookie over plain http. WebKit refuses to store that at all.
 *
 * WHY THIS MATTERS MORE THAN AN ORDINARY BUG: CLAUDE.md's first rule is "run
 * it and look at it", and `scripts/capture-preview.mjs` — the script that
 * does the looking — signs in through the login form. A 403 there disables
 * the one practice this repository was built around. The fix broke the
 * safety net rather than the feature, which is the worst place to break.
 *
 * NEITHER SUITE COULD SEE IT. `playwright.config.ts` passes
 * `--var APP_ORIGIN:${BASE_URL}`, so all 120 browser tests run against an
 * origin list that the shipped file does not contain; and the worker tests
 * set their own origin in `vitest.config.ts`. Every suite overrode the value
 * whose brokenness was the bug. So this test does not exercise behaviour at
 * all — it asserts the AGREEMENT between three files, which is where the
 * defect actually lived and the only place it is visible.
 */

import { describe, expect, inject, it } from 'vitest';

const SOURCES = inject('sources');

/** `"APP_ORIGIN": "a,b"` out of wrangler.jsonc, without a JSONC parser. */
function shippedOrigins(): string[] {
  const m = SOURCES['wrangler.jsonc'].match(/"APP_ORIGIN"\s*:\s*"([^"]*)"/);
  expect(m, 'wrangler.jsonc must set APP_ORIGIN').toBeTruthy();
  return m![1]
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

const devScript = (): string => JSON.parse(SOURCES['package.json']).scripts.dev as string;

describe('the shipped APP_ORIGIN', () => {
  it('contains no http:// origin', () => {
    // Every entry, not just the first. One http:// buried at the end still
    // reaches production, and `check-deploy-config.mjs` refuses the deploy —
    // so this is also the guard that keeps the deploy guard from firing.
    const origins = shippedOrigins();
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.filter((o) => o.startsWith('http://'))).toEqual([]);
  });

  it('is therefore unusable locally, which the dev script MUST compensate for', () => {
    // The implication, stated as the test. Given the shipped value is https
    // only, `wrangler dev` with no override cannot accept a localhost origin.
    // If someone later drops the --var, this fails here instead of failing
    // silently in a browser nobody opened.
    const origins = shippedOrigins();
    const shippedWorksLocally = origins.some((o) => o.startsWith('http://localhost'));
    if (shippedWorksLocally) return; // a different, also-valid world

    const dev = devScript();
    expect(dev, '`npm run dev` must override APP_ORIGIN').toMatch(/--var\s+APP_ORIGIN:/);

    const override = dev.match(/--var\s+APP_ORIGIN:(\S+)/)?.[1] ?? '';
    // http://, so isLocalDev() is true and the cookie drops Secure.
    expect(override.startsWith('http://')).toBe(true);
    expect(override).toContain('localhost');
  });

  it('is overridden by the browser suite too, which is why it hid the bug', () => {
    // Not a requirement so much as a note kept executable: this line is the
    // reason 120 green browser tests said nothing about the shipped value.
    expect(SOURCES['playwright.config.ts']).toMatch(/--var\s+APP_ORIGIN:/);
  });
});

describe('the asset router', () => {
  it('runs the Worker first for EVERY request, not just /api/*', () => {
    // `run_worker_first: ["/api/*"]` served `/` straight off the assets
    // binding, so src/index.ts never ran and the document went out with no
    // Content-Security-Policy, no frame-ancestors and no HSTS — while
    // /api/health on the same server carried all of them.
    //
    // Per Cloudflare's docs, the array form "disables the automatic
    // Sec-Fetch-Mode: navigate detection", which is what made a navigation
    // bypass the Worker. Only `true` invokes it unconditionally.
    const m = SOURCES['wrangler.jsonc'].match(/"run_worker_first"\s*:\s*([^\n,]+)/);
    expect(m, 'wrangler.jsonc must set run_worker_first').toBeTruthy();
    expect(m![1].trim()).toBe('true');
  });
});
