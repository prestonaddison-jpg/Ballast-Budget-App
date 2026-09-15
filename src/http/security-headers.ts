/**
 * Security response headers.
 *
 * CSP NOTES:
 *   - No 'unsafe-inline' anywhere. The shell loads one module bundle, plus a
 *     single inline theme-bootstrap script allowed by SHA-256 hash.
 *   - style-src is 'self' only. CSP governs <style> blocks and style
 *     ATTRIBUTES; it does not govern CSSOM writes like `el.style.width = …`,
 *     which is what the components actually do.
 *   - `connect-src 'self'` — the PWA talks to its own Worker and nothing else.
 *     Plaid is called server-side only, so the browser needs no Plaid origin.
 *     Plaid Link (Slice 1+) will require widening this; the comment is here so
 *     that widening is a conscious edit rather than a copy-paste.
 *   - `frame-ancestors 'none'` is THE credited control: ASVS 5.0 V3.4.6
 *     declares X-Frame-Options obsolete and says it "may not be relied upon",
 *     so shipping only the legacy header would fail that requirement. Both are
 *     sent, but frame-ancestors is the one that counts.
 *   - `worker-src` and `manifest-src` are set EXPLICITLY. They fall back
 *     through child-src -> script-src -> default-src, and a strict script-src
 *     would otherwise block the service worker and the manifest outright —
 *     which on an installed PWA means no offline shell and no install prompt.
 *   - `form-action 'self'` stops an injected form from posting credentials out.
 */

export interface SecurityHeaderOptions {
  /** HSTS is pointless (and harmful in dev) over plain http://localhost. */
  includeHsts: boolean;
}

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  // The hash covers the inline theme-bootstrap script in web/index.html,
  // which must run before first paint to avoid a light flash for dark-pole
  // users. Everything else is 'self'. test/worker/csp.test.ts re-computes the
  // hash from index.html and asserts it is still listed here.
  "script-src 'self' 'sha256-tcK04qrUXA6vmj5/fd3mzqnvcmFzvXf5don0dMtAZ4Q='",
  // No 'unsafe-inline'. The components set styles through the CSSOM
  // (element.style.*), which CSP does not govern at all — the earlier comment
  // claiming otherwise was simply wrong about how CSP works. The one real
  // inline style attribute (the <noscript> message) is now a class.
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

export function securityHeaders(opts: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // The CSRF guard branches on Sec-Fetch-Site and Origin, so responses DO
    // differ by those headers. Without Vary, a shared cache (Cloudflare's own
    // included) could serve a cross-site rejection to a legitimate same-origin
    // request, or worse, the reverse.
    Vary: 'Sec-Fetch-Site, Origin, Cookie',
  };
  if (opts.includeHsts) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
  }
  return headers;
}

/**
 * Headers for any response carrying account data. Financial responses must
 * never be written to a shared or disk cache, and must never appear in a
 * back/forward cache snapshot after sign-out.
 */
export function noStoreHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
  };
}
