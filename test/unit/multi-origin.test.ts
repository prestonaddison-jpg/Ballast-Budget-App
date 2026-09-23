/**
 * APP_ORIGIN as a LIST, and the ways that could go wrong.
 *
 * WHY IT IS A LIST. A Worker on a custom domain still answers on its
 * workers.dev hostname, and a single expected origin silently 403s every write
 * on whichever of the two it is not. It also makes moving to a custom domain a
 * safe, non-atomic operation — add the origin, attach the domain, drop the old
 * one — instead of a flip where one hostname is always broken.
 *
 * A list is a wider door, so the tests here are mostly about it NOT being
 * wider than intended: no prefix matching, no suffix matching, no empty string
 * matching everything, and no http:// entry quietly turning off Secure
 * cookies in production.
 */

import { describe, expect, it } from 'vitest';
import { checkCsrf } from '../../src/http/csrf';
import { allowedOrigins, canonicalOrigin, isLocalDev } from '../../src/env';
import type { Env } from '../../src/env';

const CUSTOM = 'https://ballast-finance-app.praeclarusventures.com';
const WORKERS = 'https://ballast.addisonfoxhole.workers.dev';

const envWith = (appOrigin: string) => ({ APP_ORIGIN: appOrigin }) as unknown as Env;

const post = (origin: string | null, headers: Record<string, string> = {}) =>
  new Request('https://example.com/api/thing', {
    method: 'POST',
    headers: {
      'X-Requested-With': 'ballast',
      ...(origin ? { Origin: origin } : {}),
      ...headers,
    },
  });

describe('parsing the list', () => {
  it('splits on commas and trims', () => {
    expect(allowedOrigins(envWith(` ${CUSTOM} , ${WORKERS} `))).toEqual([CUSTOM, WORKERS]);
  });

  it('drops empties, so a trailing comma cannot create an origin of ""', () => {
    // An empty string in the allow-list would be matched by a request with no
    // Origin header in some shapes — a hole opened by punctuation.
    expect(allowedOrigins(envWith(`${CUSTOM},,`))).toEqual([CUSTOM]);
    expect(allowedOrigins(envWith(''))).toEqual([]);
  });

  it('treats the FIRST entry as canonical', () => {
    expect(canonicalOrigin(envWith(`${CUSTOM},${WORKERS}`))).toBe(CUSTOM);
  });
});

describe('isLocalDev', () => {
  it('follows the canonical origin, not any entry', () => {
    expect(isLocalDev(envWith('http://localhost:8787'))).toBe(true);
    expect(isLocalDev(envWith(`${CUSTOM},${WORKERS}`))).toBe(false);
  });

  it('does NOT drop Secure just because a stray http:// origin is listed', () => {
    // The dangerous reading of an ambiguous list. If a production deploy ever
    // listed a local origin by mistake, treating "any http://" as local would
    // strip Secure from real session cookies on the public internet.
    expect(isLocalDev(envWith(`${CUSTOM},http://localhost:8787`))).toBe(false);
  });
});

describe('checkCsrf against several origins', () => {
  const allowed = [CUSTOM, WORKERS];

  it('accepts every listed origin', () => {
    expect(checkCsrf(post(CUSTOM), allowed).ok).toBe(true);
    expect(checkCsrf(post(WORKERS), allowed).ok).toBe(true);
  });

  it('still accepts a single origin passed as a plain string', () => {
    expect(checkCsrf(post(CUSTOM), CUSTOM).ok).toBe(true);
    expect(checkCsrf(post(WORKERS), CUSTOM).ok).toBe(false);
  });

  it('REFUSES a lookalike that merely contains an allowed origin', () => {
    // The bug a sloppy endsWith() or includes() would introduce. Every one of
    // these is a different site that an attacker can register.
    for (const evil of [
      `${WORKERS}.evil.example`,
      'https://ballast-finance-app.praeclarusventures.com.evil.example',
      'https://evil-ballast-finance-app.praeclarusventures.com',
      'https://praeclarusventures.com.attacker.test',
      `http://ballast-finance-app.praeclarusventures.com`,
    ]) {
      expect(checkCsrf(post(evil), allowed), evil).toEqual({
        ok: false,
        reason: 'origin-mismatch',
      });
    }
  });

  it('refuses an unlisted origin even with the custom header', () => {
    expect(checkCsrf(post('https://evil.example'), allowed).ok).toBe(false);
  });

  it('refuses everything when the list is empty', () => {
    // Misconfiguration must fail CLOSED. An empty allow-list accepting
    // anything is the worst possible reading of "no origins configured".
    expect(checkCsrf(post(CUSTOM), []).ok).toBe(false);
    expect(checkCsrf(post(CUSTOM), '').ok).toBe(false);
  });

  it('still requires the custom header on a listed origin', () => {
    const req = new Request('https://example.com/api/thing', {
      method: 'POST',
      headers: { Origin: CUSTOM },
    });
    expect(checkCsrf(req, allowed)).toEqual({ ok: false, reason: 'missing-x-requested-with' });
  });

  it('still rejects on Sec-Fetch-Site before Origin is even considered', () => {
    const req = post(CUSTOM, { 'Sec-Fetch-Site': 'cross-site' });
    expect(checkCsrf(req, allowed)).toEqual({ ok: false, reason: 'sec-fetch-site=cross-site' });
  });

  it('leaves safe methods alone', () => {
    const get = new Request('https://example.com/api/thing', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(checkCsrf(get, allowed).ok).toBe(true);
  });
});
