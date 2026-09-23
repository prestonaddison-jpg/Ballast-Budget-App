/**
 * Ballast must serve itself with NO Plaid configuration at all.
 *
 * THE DEFECT THIS EXISTS FOR, found on the first real deployment. `assertEnv`
 * demanded PLAID_CLIENT_ID, PLAID_SECRET and FIELD_ENCRYPTION_KEY on EVERY
 * /api/ request. The Worker deployed green, the shell loaded, and every single
 * API call answered 503 "The server is not configured" — including the login
 * form — purely because no Plaid account existed yet.
 *
 * Nothing caught it because the test environment sets all three. The suite was
 * only ever exercising the configured case, so the one configuration a first
 * deploy actually has was the one nobody tested.
 *
 * It contradicted the product's own premise: you can sign in, create
 * envelopes, move money between them and approve proposals with no bank
 * connected whatsoever. Plaid is for reading real balances, not for permission
 * to run.
 */

import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

const ORIGIN = 'https://example.com';
const PLAID_KEYS = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'FIELD_ENCRYPTION_KEY'] as const;

type Mutable = Record<string, string | undefined>;

/** Strip Plaid configuration for the duration of one test. */
function withoutPlaidConfig(): () => void {
  const saved: Mutable = {};
  for (const key of PLAID_KEYS) {
    saved[key] = (env as unknown as Mutable)[key];
    delete (env as unknown as Mutable)[key];
  }
  return () => {
    for (const key of PLAID_KEYS) (env as unknown as Mutable)[key] = saved[key];
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('with no Plaid configuration at all', () => {
  it('serves the app shell', async () => {
    restore = withoutPlaidConfig();
    const res = await SELF.fetch(`${ORIGIN}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Ballast</title>');
  });

  it('answers /api/health rather than 503', async () => {
    restore = withoutPlaidConfig();
    const res = await SELF.fetch(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it('lets an unauthenticated request reach the AUTH layer, not the config gate', async () => {
    // 401 is the correct answer: "you are not signed in". 503 would be "this
    // server is broken", which is what it used to say — and it is the
    // difference between a login screen that works and one that cannot.
    restore = withoutPlaidConfig();
    const res = await SELF.fetch(`${ORIGIN}/api/me`);
    expect(res.status).toBe(401);
  });

  it('lets the LOGIN ROUTE run — the one that made the first deploy unusable', async () => {
    restore = withoutPlaidConfig();
    const res = await SELF.fetch(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'ballast',
        Origin: 'http://localhost:8787',
      },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong-password' }),
    });
    // 401 (bad credentials) or 429 (rate limited by an earlier test) both mean
    // the request REACHED the auth logic. 503 means it never got there.
    expect([401, 429]).toContain(res.status);
  });

  it('still refuses the PLAID path, loudly and specifically', async () => {
    // The assertion did not disappear, it moved to where it belongs. This
    // route genuinely cannot verify a webhook signature without credentials.
    restore = withoutPlaidConfig();
    const res = await SELF.fetch(`${ORIGIN}/api/webhooks/plaid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_type: 'TRANSACTIONS' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'misconfigured' });
  });
});
