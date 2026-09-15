/**
 * Session cookie handling.
 *
 * NAME: `__Host-ballast_session`.
 *   The `__Host-` prefix is enforced by the browser and is the strongest
 *   cookie integrity guarantee available: the cookie is only accepted if it is
 *   Secure, has Path=/, and has NO Domain attribute. That last part is the
 *   valuable one — it makes the cookie un-settable by a sibling subdomain, so
 *   an XSS or takeover on any other *.ballast host cannot inject a session
 *   cookie into this one (cookie-tossing / session fixation).
 *
 * ATTRIBUTES:
 *   HttpOnly  — JS can never read the token, so an XSS cannot exfiltrate it.
 *   Secure    — required by __Host-, and non-negotiable for a finance app.
 *   SameSite=Strict — Ballast is an installed, single-origin PWA. Every
 *               request it makes is same-origin fetch(), so Strict costs
 *               nothing and removes cross-site request forgery as a class.
 *               (Strict's usual downside — losing the session when following
 *               an inbound link from another site — does not apply: there is
 *               no inbound-link flow, and the app is opened from the Home
 *               Screen.)
 *   Path=/    — required by __Host-.
 */

export const SESSION_COOKIE = '__Host-ballast_session';

export interface CookieOptions {
  maxAgeSeconds: number;
  /**
   * Local development over http://localhost cannot set a `__Host-` /Secure
   * cookie. Only ever true when the Worker is running in dev.
   */
  insecureForLocalDev?: boolean;
}

export function buildSessionCookie(token: string, opts: CookieOptions): string {
  const name = opts.insecureForLocalDev ? 'ballast_session_dev' : SESSION_COOKIE;
  const parts = [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
  ];
  if (!opts.insecureForLocalDev) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearCookie(opts: { insecureForLocalDev?: boolean } = {}): string {
  const name = opts.insecureForLocalDev ? 'ballast_session_dev' : SESSION_COOKIE;
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (!opts.insecureForLocalDev) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Parse a single cookie out of a Cookie header.
 *
 * Deliberately does not build a full map: we only ever want one value, and a
 * permissive parser that returns everything invites accidentally trusting some
 * other cookie later.
 */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    if (segment.slice(0, eq).trim() === name) {
      return segment.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

export function readSessionCookie(
  header: string | null,
  insecureForLocalDev = false,
): string | null {
  return readCookie(header, insecureForLocalDev ? 'ballast_session_dev' : SESSION_COOKIE);
}
