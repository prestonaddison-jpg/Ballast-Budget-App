/**
 * CSRF defence for a cookie-authenticated JSON API.
 *
 * LAYERS (defence in depth — any one of these alone has a gap):
 *   1. SameSite=Strict on the session cookie. Blocks the browser from
 *      attaching the session to cross-site requests at all. This is the
 *      primary control and, for this app, close to sufficient on its own.
 *   2. Origin / Sec-Fetch-Site check, below. Catches the cases SameSite does
 *      not: older browsers, and any future same-site-but-different-subdomain
 *      surface.
 *   3. A required custom header (`X-Requested-With`). An HTML form or an
 *      <img>/<script> cross-origin request cannot set a custom header without
 *      triggering a CORS preflight, which the Worker never approves.
 *
 * Note the ordering: Sec-Fetch-Site is checked FIRST where present, because it
 * is set by the browser and cannot be spoofed by page script, whereas Origin
 * is absent on some same-origin requests. OWASP now treats Sec-Fetch-Site as
 * the PRIMARY signal, but states that an Origin/Referer fallback "is a
 * mandatory requirement" because legacy and embedded browsers omit the
 * Sec-Fetch-* family entirely — so a fetch-metadata-only check is incomplete.
 *
 * A note on SameSite's real reach: it is scoped to the REGISTRABLE DOMAIN, not
 * the origin. If Ballast were ever served from a subdomain of a parent domain
 * shared with hosts outside this project, a sibling subdomain would count as
 * "same-site" and SameSite would protect far less than it appears to. That is
 * a deployment constraint, not a code one, and it is recorded in
 * docs/SECURITY.md.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfResult = { ok: true } | { ok: false; reason: string };

export function checkCsrf(request: Request, expectedOrigin: string): CsrfResult {
  if (SAFE_METHODS.has(request.method)) return { ok: true };

  // 1. Fetch metadata, where the browser provides it.
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, reason: `sec-fetch-site=${fetchSite}` };
  }

  // 2. Origin must match exactly when present.
  const origin = request.headers.get('origin');
  if (origin) {
    if (origin !== expectedOrigin) return { ok: false, reason: 'origin-mismatch' };
  } else if (!fetchSite) {
    // Neither signal present: a very old browser or a non-browser client.
    // Fall through to the custom-header requirement rather than failing open.
  }

  // 3. Custom header — unsettable cross-origin without a preflight.
  if (request.headers.get('x-requested-with') !== 'ballast') {
    return { ok: false, reason: 'missing-x-requested-with' };
  }

  return { ok: true };
}
