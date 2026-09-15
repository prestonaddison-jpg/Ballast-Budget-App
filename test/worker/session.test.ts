import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ABSOLUTE_TIMEOUT_SECONDS,
  IDLE_TIMEOUT_SECONDS,
  issueSession,
  validateSession,
} from '../../src/auth/session';
import { createSessionStore, createUser } from '../../src/db/repos/users';
import { hashPassword } from '../../src/auth/password';
import { randomId } from '../../src/crypto/random';

/** Runs against a REAL D1 database inside workerd, not a mock. */
const NOW = 1_800_000_000;

async function seedUser(): Promise<string> {
  const id = randomId();
  await createUser(env.DB, {
    id,
    email: `${id}@example.test`,
    passwordHash: await hashPassword('pw', 1000),
    now: NOW,
  });
  return id;
}

describe('session lifecycle', () => {
  let userId: string;
  beforeEach(async () => {
    userId = await seedUser();
  });

  it('issues a session that validates', async () => {
    const store = createSessionStore(env.DB);
    const issued = await issueSession(store, userId, NOW, randomId());

    const result = await validateSession(store, issued.token, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.userId).toBe(userId);
  });

  it('stores only a HASH of the token, never the token itself', async () => {
    // A dump of the sessions table must not yield a usable session.
    const store = createSessionStore(env.DB);
    const issued = await issueSession(store, userId, NOW, randomId());

    const row = await env.DB.prepare('SELECT token_hash FROM sessions WHERE user_id = ?')
      .bind(userId)
      .first<{ token_hash: string }>();

    expect(row).not.toBeNull();
    expect(row!.token_hash).not.toBe(issued.token);
    expect(row!.token_hash).not.toContain(issued.token);
  });

  it('rejects an unknown token', async () => {
    const result = await validateSession(createSessionStore(env.DB), 'not-a-real-token', NOW);
    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a missing token', async () => {
    const result = await validateSession(createSessionStore(env.DB), null, NOW);
    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a revoked session', async () => {
    const store = createSessionStore(env.DB);
    const issued = await issueSession(store, userId, NOW, randomId());
    await store.revoke(issued.id, NOW);

    expect(await validateSession(store, issued.token, NOW)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('enforces the idle timeout', async () => {
    const store = createSessionStore(env.DB);
    const issued = await issueSession(store, userId, NOW, randomId());

    const justInside = NOW + IDLE_TIMEOUT_SECONDS - 1;
    expect((await validateSession(store, issued.token, justInside)).ok).toBe(true);

    // The successful check above slid last_seen_at forward, so step from there.
    const past = justInside + IDLE_TIMEOUT_SECONDS;
    expect(await validateSession(store, issued.token, past)).toEqual({
      ok: false,
      reason: 'idle_expired',
    });
  });

  it('enforces the absolute timeout even on an actively-used session', async () => {
    // The point of the absolute cap: a stolen token must not be keepable alive
    // forever simply by touching it.
    const store = createSessionStore(env.DB);
    const issued = await issueSession(store, userId, NOW, randomId());

    let clock = NOW;
    while (clock < NOW + ABSOLUTE_TIMEOUT_SECONDS - IDLE_TIMEOUT_SECONDS) {
      clock += IDLE_TIMEOUT_SECONDS - 60;
      const ok = await validateSession(store, issued.token, clock);
      expect(ok.ok).toBe(true);
    }

    const beyond = NOW + ABSOLUTE_TIMEOUT_SECONDS;
    expect(await validateSession(store, issued.token, beyond)).toEqual({
      ok: false,
      reason: 'absolute_expired',
    });
  });

  it('slides the idle window on use', async () => {
    const store = createSessionStore(env.DB);
    const issued = await issueSession(store, userId, randomId() ? NOW : NOW, randomId());

    const later = NOW + 3600;
    expect((await validateSession(store, issued.token, later)).ok).toBe(true);

    const row = await env.DB.prepare('SELECT last_seen_at FROM sessions WHERE id = ?')
      .bind(issued.id)
      .first<{ last_seen_at: number }>();
    expect(row!.last_seen_at).toBe(later);
  });

  it('revokes every session for a user at once', async () => {
    const store = createSessionStore(env.DB);
    const a = await issueSession(store, userId, NOW, randomId());
    const b = await issueSession(store, userId, NOW, randomId());

    await store.revokeAllForUser(userId, NOW);

    expect((await validateSession(store, a.token, NOW)).ok).toBe(false);
    expect((await validateSession(store, b.token, NOW)).ok).toBe(false);
  });

  it('sweeps expired sessions', async () => {
    const store = createSessionStore(env.DB);
    await issueSession(store, userId, NOW, randomId());
    const removed = await store.deleteExpired(NOW + ABSOLUTE_TIMEOUT_SECONDS + 1);
    expect(removed).toBeGreaterThan(0);
  });

  it('isolates sessions between users', async () => {
    // BOLA at the session layer: one user's token must never resolve to
    // another user's id.
    const store = createSessionStore(env.DB);
    const otherUserId = await seedUser();
    const mine = await issueSession(store, userId, NOW, randomId());
    const theirs = await issueSession(store, otherUserId, NOW, randomId());

    const a = await validateSession(store, mine.token, NOW);
    const b = await validateSession(store, theirs.token, NOW);
    expect(a.ok && a.session.userId).toBe(userId);
    expect(b.ok && b.session.userId).toBe(otherUserId);
  });
});
