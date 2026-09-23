/**
 * Worker environment bindings.
 *
 * Declared by hand rather than generated, so that every binding carries the
 * reasoning for why it exists and what may go in it.
 */

export interface Env {
  // --- Bindings ---
  /** Static assets: the built PWA shell. */
  ASSETS: Fetcher;
  /** Source of truth. Balances, ledger, sessions — everything durable. */
  DB: D1Database;
  /**
   * Cache ONLY. Plaid webhook signing keys (public) and rate-limit counters.
   * KV is eventually consistent, so it must never hold authoritative state.
   */
  CACHE: KVNamespace;
  /** Receipts (Slice 5). Highest-sensitivity tier. */
  RECEIPTS: R2Bucket;
  /**
   * Sync jobs, so a webhook returns immediately and work happens off-request.
   *
   * OPTIONAL, because the binding is commented out of wrangler.jsonc until
   * Plaid exists — see the note there. Typed honestly rather than as a lie the
   * compiler would let every caller believe: the one producer must check it.
   */
  SYNC_QUEUE?: Queue<SyncJob>;

  // --- Vars (wrangler.jsonc) ---
  PLAID_ENV: string;
  /** Canonical origin, used for the CSRF origin check and webhook URLs. */
  APP_ORIGIN: string;

  // --- Secrets (wrangler secret put) ---
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  /** 32 bytes, base64url. Generate with `npm run gen:key`. */
  FIELD_ENCRYPTION_KEY: string;
}

export interface SyncJob {
  /** Ballast's internal source_items.id, never the provider's. */
  itemId: string;
  userId: string;
  trigger: 'webhook' | 'cron' | 'manual' | 'initial';
}

/**
 * Fail fast on configuration the app CANNOT SERVE A REQUEST WITHOUT.
 *
 * That is a much shorter list than it used to be, and the difference matters.
 * This once demanded PLAID_CLIENT_ID, PLAID_SECRET and FIELD_ENCRYPTION_KEY on
 * every single /api/ request — so the first real deployment answered 503 to
 * everything, including the login form, purely because no Plaid account
 * existed yet. The shell loaded and nothing in it worked.
 *
 * Ballast is explicitly designed to run before any bank is connected: you can
 * sign in, create envelopes, move money between them and approve proposals
 * with no Plaid whatsoever. Demanding Plaid credentials to serve those paths
 * contradicted the product's own premise.
 *
 * So the rule is now: assert what THIS request needs, where it needs it. Plaid
 * configuration is asserted by the Plaid paths (see assertPlaidEnv) rather
 * than by the front door.
 */
export function assertEnv(env: Env): void {
  // APP_ORIGIN decides whether the session cookie carries Secure and which
  // origin the CSRF check accepts. Every authenticated request depends on it,
  // so its absence is genuinely unservable.
  if (!env.APP_ORIGIN) {
    throw new Error('Missing required configuration: APP_ORIGIN');
  }
}

/**
 * Configuration the PLAID paths cannot work without.
 *
 * Called where Plaid is actually reached — webhook verification, link, sync —
 * so an unconfigured deploy fails loudly on those routes and stays perfectly
 * usable everywhere else.
 *
 * FIELD_ENCRYPTION_KEY belongs here rather than at the front door because its
 * only job is encrypting stored access tokens. With no linked institution
 * there is nothing to encrypt, and refusing to serve the Canvas over a key
 * that has nothing to protect yet is theatre, not safety.
 */
export function assertPlaidEnv(env: Env): void {
  const missing: string[] = [];
  for (const key of ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'FIELD_ENCRYPTION_KEY'] as const) {
    if (!env[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(`Missing required Plaid configuration: ${missing.join(', ')}`);
  }
}

export function isLocalDev(env: Env): boolean {
  return env.APP_ORIGIN.startsWith('http://');
}
