/**
 * Security response headers.
 *
 * CSP NOTES:
 *   - No 'unsafe-inline' for scripts. The shell loads one module bundle.
 *   - `style-src 'self' 'unsafe-inline'` is a deliberate, narrow concession:
 *     the components set a handful of inline styles (gauge sweep offset,
 *     meter width). Scripts, which are the actual XSS vector, stay strict.
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
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
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
