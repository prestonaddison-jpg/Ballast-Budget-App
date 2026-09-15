/**
 * Fixed-window rate limiting, backed by KV.
 *
 * Scope: the login route, which is the only unauthenticated, credential-
 * accepting endpoint. Without a limit, PBKDF2 at 600k iterations is also a
 * denial-of-service amplifier — each attempt costs the Worker real CPU.
 *
 * KV is eventually consistent, so this is a best-effort control: a determined
 * attacker hitting several colos at once can exceed the nominal limit. That is
 * acceptable for a brute-force speed bump on a single-operator app, and it is
 * stated here so nobody mistakes it for a hard quota.
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
  kv: KVNamespace,
  key: string,
  now: number,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const window = Math.floor(now / opts.windowSeconds);
  const cacheKey = `rl:${key}:${window}`;

  const current = Number.parseInt((await kv.get(cacheKey)) ?? '0', 10);
  const count = Number.isFinite(current) ? current : 0;
  const resetAt = (window + 1) * opts.windowSeconds;
  const retryAfterSeconds = Math.max(1, resetAt - now);

  if (count >= opts.limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  // expirationTtl has a 60-second MINIMUM in KV; a shorter window would be
  // rejected outright, so the TTL is floored rather than passed through.
  await kv.put(cacheKey, String(count + 1), {
    expirationTtl: Math.max(60, opts.windowSeconds + 60),
  });

  return { allowed: true, remaining: opts.limit - count - 1, retryAfterSeconds };
}

/**
 * Identify the caller for rate-limiting.
 *
 * CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the
 * client (unlike X-Forwarded-For, which is why that header is NOT used here).
 */
export function clientKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
