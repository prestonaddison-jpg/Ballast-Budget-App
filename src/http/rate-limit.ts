/**
 * Fixed-window rate limiting, backed by D1.
 *
 * Scope: the login route and the public webhook route — the only two
 * unauthenticated endpoints, and both of which do expensive work (a
 * 600k-iteration KDF, and an outbound call to Plaid respectively).
 *
 * WHY D1 AND NOT KV:
 *   A KV implementation reads the counter, compares it, and writes count+1 as
 *   three separate awaited steps. That is a read-modify-write with no atomic
 *   increment, so a burst of concurrent requests ALL observe the same
 *   pre-increment value and ALL pass. Two hundred parallel logins from one IP
 *   would every one of them read "0", see 0 < limit, and proceed — the limiter
 *   would not slow an attacker down at all. KV's eventual consistency makes it
 *   worse still.
 *
 *   D1 can increment and read in a SINGLE statement:
 *
 *     INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
 *     ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
 *     RETURNING count
 *
 *   One statement is atomic, so concurrent callers are serialized by the
 *   database and each gets a distinct count.
 *
 * NOTE this counts the CURRENT request before deciding, so the first caller
 * sees 1. A limit of 10 therefore allows 10 requests per window.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
}

export async function rateLimit(
  db: D1Database,
  key: string,
  now: number,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / opts.windowSeconds) * opts.windowSeconds;
  const resetAt = windowStart + opts.windowSeconds;
  const retryAfterSeconds = Math.max(1, resetAt - now);

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count)
            VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start)
         DO UPDATE SET count = count + 1
         RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();

  // A failed RETURNING should fail CLOSED: if the limiter cannot count, it
  // must not wave the request through.
  const count = row?.count ?? Number.MAX_SAFE_INTEGER;

  if (count > opts.limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }
  return { allowed: true, remaining: opts.limit - count, retryAfterSeconds };
}

/** Delete elapsed windows. Called from cron. */
export async function sweepRateLimits(db: D1Database, before: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(before)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Identify the caller.
 *
 * CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the
 * client — unlike X-Forwarded-For, which is client-settable and is therefore
 * deliberately NOT used here.
 *
 * A missing value buckets to 'unknown', which is shared. That is intentional:
 * sharing one bucket is a tighter limit, not a looser one, so an attacker
 * cannot escape rate limiting by arranging for the header to be absent.
 */
export function clientKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
