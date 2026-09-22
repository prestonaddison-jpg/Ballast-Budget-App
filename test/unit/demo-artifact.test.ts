/**
 * The shareable demo must not drift behind the app.
 *
 * THE DEFECT THIS EXISTS FOR. `scripts/build-artifact.mjs` bundles the real
 * CSS and the real component bundle and swaps only the network layer for an
 * in-memory model. When proposals landed in v3.0.0 and due dates in v4.0.0,
 * that model was not updated — so the demo still served the app's own compiled
 * code against a backend that had never heard of `/proposals`. The page loaded,
 * the figures rendered, and the Now-Bar read "Couldn't load the queue".
 *
 * Nothing caught it. The demo is generated output, it is gitignored, no suite
 * touched it, and it fails in a way that looks like a working app with one
 * unhappy pill. It was found by opening the file in a browser before publishing
 * a link — which is the same lesson as the Now-Bar, in a different costume.
 *
 * This is a CLASS test: every path the client can request must have a matching
 * branch in the stub. The next endpoint added to api.ts fails here until the
 * demo learns about it.
 */

import { describe, expect, inject, it } from 'vitest';

const SOURCES = inject('sources');
const api = SOURCES['web/src/lib/api.ts'];
const builder = SOURCES['scripts/build-artifact.mjs'];

/**
 * The distinguishing segment of every path the client requests.
 *
 * The stub routes on `url.indexOf('<segment>')`, so what has to exist is a
 * branch mentioning each segment — not a full path match, since real paths
 * carry interpolated ids.
 */
function requestedSegments(source: string): string[] {
  const segments = new Set<string>();
  // Both quoting styles the client uses: plain '/api/...' and `/api/...${id}`.
  for (const m of source.matchAll(/['`](\/api\/[^'`]*)['`]/g)) {
    const path = m[1];
    // The last literal segment is what the stub matches on.
    const literal = path
      .split('/')
      .filter((p) => p && !p.includes('${'))
      .pop();
    if (literal) segments.add(literal);
  }
  return [...segments];
}

describe('the shareable demo', () => {
  it('implements every endpoint the app can call', () => {
    // A segment counts as handled when it appears inside any quoted route
    // string in the builder — '/auth/logout' covers 'logout'. Matching the
    // exact literal '/logout' was too strict and reported a false gap, which
    // on a drift guard is worse than a loose one: nobody trusts it twice.
    const routes = [...builder.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]);
    const missing = requestedSegments(api).filter((seg) => !routes.some((r) => r.includes(seg)));
    expect(missing, 'endpoints the demo backend does not handle').toEqual([]);
  });

  it('handles every write method the client uses', () => {
    // A PATCH the stub does not branch on falls through to its 404, which the
    // UI reports as a failed save — on a page whose whole job is looking right.
    for (const method of [...api.matchAll(/method: '([A-Z]+)'/g)].map((m) => m[1])) {
      expect(builder, `${method} is never handled by the demo backend`).toContain(method);
    }
  });

  it('keeps the residual a derived figure, never a stored one', () => {
    // The demo's whole claim is that conservation holds for the same reason it
    // holds in production: unallocated is cash minus the named envelopes, an
    // identity rather than a number somebody remembers to update.
    expect(builder).toMatch(/function residual\(\)/);
    expect(builder).toMatch(/CASH\s*\)/);
  });

  it('re-checks the live balance when a proposal is approved', () => {
    // Approving against the amount staged rather than the balance now is the
    // single rule the staging model exists to enforce. A demo that skipped it
    // would be showing something Ballast is not.
    expect(builder).toMatch(/insufficient_funds/);
    expect(builder).toMatch(/balanceMinor < target\.amountMinor/);
  });

  it('never ships a service worker or an outbound request', () => {
    // The artifact host blocks service workers, and a self-contained page that
    // phones home is not self-contained.
    expect(builder).toContain('navigator.serviceWorker.register');
    expect(builder).toMatch(/Promise\.reject\(\)/);
  });

  it('sizes the shell to its container, not the viewport', () => {
    // The artifact host pads :root by the safe-area insets; 100svh measures the
    // viewport instead and runs taller than the box it is given, pushing the
    // Now-Bar off the bottom. That exact defect already shipped once.
    expect(builder).toContain("css.replaceAll('100svh', '100%')");
  });
});
