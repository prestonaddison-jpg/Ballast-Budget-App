import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { rateLimit, sweepRateLimits } from '../../src/http/rate-limit';

const NOW = 1_800_000_000;
const OPTS = { limit: 3, windowSeconds: 60 };

describe('rate limiting', () => {
  it('allows up to the limit and then blocks', async () => {
    const key = `t:${crypto.randomUUID()}`;
    expect((await rateLimit(env.DB, key, NOW, OPTS)).allowed).toBe(true);
    expect((await rateLimit(env.DB, key, NOW, OPTS)).allowed).toBe(true);
    const third = await rateLimit(env.DB, key, NOW, OPTS);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    expect((await rateLimit(env.DB, key, NOW, OPTS)).allowed).toBe(false);
  });

  it('counts a CONCURRENT burst correctly', async () => {
    // This is the whole reason the counter moved from KV to D1. A KV
    // read-modify-write across three awaited steps lets every request in a
    // burst observe the same pre-increment value, so all of them pass and the
    // limiter does nothing. A single atomic D1 statement cannot.
    const key = `burst:${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rateLimit(env.DB, key, NOW, OPTS)),
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(OPTS.limit);
  });

  it('keeps buckets independent', async () => {
    const a = `a:${crypto.randomUUID()}`;
    const b = `b:${crypto.randomUUID()}`;
    for (let i = 0; i < 4; i++) await rateLimit(env.DB, a, NOW, OPTS);
    expect((await rateLimit(env.DB, a, NOW, OPTS)).allowed).toBe(false);
    expect((await rateLimit(env.DB, b, NOW, OPTS)).allowed).toBe(true);
  });

  it('resets in the next window', async () => {
    const key = `w:${crypto.randomUUID()}`;
    for (let i = 0; i < 4; i++) await rateLimit(env.DB, key, NOW, OPTS);
    expect((await rateLimit(env.DB, key, NOW, OPTS)).allowed).toBe(false);
    expect((await rateLimit(env.DB, key, NOW + OPTS.windowSeconds, OPTS)).allowed).toBe(true);
  });

  it('reports a retry-after inside the window', async () => {
    const key = `r:${crypto.randomUUID()}`;
    const result = await rateLimit(env.DB, key, NOW + 5, OPTS);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(OPTS.windowSeconds);
  });

  it('sweeps elapsed windows', async () => {
    const key = `s:${crypto.randomUUID()}`;
    await rateLimit(env.DB, key, NOW, OPTS);
    const removed = await sweepRateLimits(env.DB, NOW + 3600);
    expect(removed).toBeGreaterThan(0);
  });
});
