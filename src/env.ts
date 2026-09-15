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
  /** Sync jobs, so a webhook returns immediately and work happens off-request. */
  SYNC_QUEUE: Queue<SyncJob>;

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
 * Fail fast and loudly when configuration is missing.
 *
 * A Worker with no FIELD_ENCRYPTION_KEY would otherwise run happily until the
 * first bank connection, then fail somewhere much less obvious.
 */
export function assertEnv(env: Env): void {
  const missing: string[] = [];
  for (const key of [
    'PLAID_CLIENT_ID',
    'PLAID_SECRET',
    'FIELD_ENCRYPTION_KEY',
    'APP_ORIGIN',
  ] as const) {
    if (!env[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}

export function isLocalDev(env: Env): boolean {
  return env.APP_ORIGIN.startsWith('http://');
}
