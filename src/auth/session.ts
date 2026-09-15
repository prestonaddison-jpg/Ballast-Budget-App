/**
 * Custom cookie-only sessions (§15).
 *
 * Cloudflare Access was dropped because it blocked Plaid webhooks and broke
 * standalone-iOS SSO and the service worker. So the session IS the access
 * boundary, and it is held to ASVS Level 3.
 *
 * DESIGN:
 *   - The token is 256 bits from the CSPRNG. It carries no meaning and is not
 *     a JWT: there is nothing to parse, no algorithm to confuse, and
 *     revocation is a DELETE rather than a blocklist.
 *   - D1 stores only SHA-256(token). A dump of the sessions table therefore
 *     yields no usable session — the same reasoning as password hashing.
 *     (A fast hash is correct here, unlike for passwords: the input already
 *     has 256 bits of entropy, so there is nothing to brute-force.)
 *     NOTE: this is defence in depth, NOT an ASVS requirement — 5.0 has no
 *     requirement to store session tokens hashed at rest, so no requirement
 *     id is claimed for it.
 *   - Two independent clocks: an IDLE timeout (sliding, for an abandoned
 *     session) and an ABSOLUTE timeout (hard cap, so a stolen token cannot be
 *     kept alive forever by touching it).
 *   - The token is rotated on every authentication, which kills session
 *     fixation: a token planted before login is not the token that ends up
 *     authenticated.
 */

import { randomToken } from '../crypto/random';
import { sha256Base64Url } from '../crypto/hash';

/**
 * TIMEOUTS.
 *
 * ASVS 5.0 deliberately specifies NO numeric value: V7.3.1 (idle) and V7.3.2
 * (absolute) both defer to "risk analysis and documented security decisions",
 * and V7.1.1 requires that the decision be written down. The reasoning is
 * therefore recorded in docs/SECURITY.md, not just encoded here.
 *
 * Summary of that reasoning: Ballast is single-operator, read-only, installed
 * to one iOS Home Screen behind device biometrics, and it moves no money. The
 * dominant risk is an unattended device, which the OS lock screen already
 * addresses; forcing frequent re-authentication on a glanceable
 * cash-allocation app mainly teaches the operator to stop opening it.
 */
/** Sliding window: a session untouched for this long is dead. */
export const IDLE_TIMEOUT_SECONDS = 14 * 24 * 60 * 60; // 14 days
/** Hard cap regardless of activity: re-authentication is required after this. */
export const ABSOLUTE_TIMEOUT_SECONDS = 90 * 24 * 60 * 60; // 90 days
/** Only write `last_seen_at` when it has moved by more than this. */
const TOUCH_GRANULARITY_SECONDS = 5 * 60;

export interface SessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
}

export interface ActiveSession {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
}

export interface IssuedSession extends ActiveSession {
  /** Returned exactly once, to be placed in the Set-Cookie header. */
  token: string;
  maxAgeSeconds: number;
}

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Base64Url(token);
}

export interface SessionStore {
  insert(record: SessionRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  touch(id: string, lastSeenAt: number): Promise<void>;
  revoke(id: string, revokedAt: number): Promise<void>;
  revokeAllForUser(userId: string, revokedAt: number): Promise<void>;
  deleteExpired(before: number): Promise<number>;
}

/**
 * Issue a new session. Call on successful authentication ONLY — and always
 * after revoking the caller's previous session, so the token rotates.
 */
export async function issueSession(
  store: SessionStore,
  userId: string,
  now: number,
  sessionId: string,
): Promise<IssuedSession> {
  const token = randomToken(32);
  const tokenHash = await hashSessionToken(token);
  const absoluteExpiresAt = now + ABSOLUTE_TIMEOUT_SECONDS;

  await store.insert({
    id: sessionId,
    user_id: userId,
    token_hash: tokenHash,
    created_at: now,
    last_seen_at: now,
    absolute_expires_at: absoluteExpiresAt,
    revoked_at: null,
  });

  return {
    id: sessionId,
    userId,
    token,
    createdAt: now,
    lastSeenAt: now,
    absoluteExpiresAt,
    // The cookie should not outlive the session itself.
    maxAgeSeconds: Math.min(IDLE_TIMEOUT_SECONDS, ABSOLUTE_TIMEOUT_SECONDS),
  };
}

export type SessionFailure =
  'missing' | 'unknown' | 'revoked' | 'idle_expired' | 'absolute_expired';

export type SessionValidation =
  { ok: true; session: ActiveSession } | { ok: false; reason: SessionFailure };

/**
 * Validate a presented token. Returns a reason on failure so the route layer
 * can log it — but the reason must NEVER reach the client, which always sees
 * a flat 401.
 */
export async function validateSession(
  store: SessionStore,
  token: string | null,
  now: number,
): Promise<SessionValidation> {
  if (!token) return { ok: false, reason: 'missing' };

  const tokenHash = await hashSessionToken(token);
  const record = await store.findByTokenHash(tokenHash);
  if (!record) return { ok: false, reason: 'unknown' };
  if (record.revoked_at != null) return { ok: false, reason: 'revoked' };
  if (now >= record.absolute_expires_at) return { ok: false, reason: 'absolute_expired' };
  if (now - record.last_seen_at >= IDLE_TIMEOUT_SECONDS)
    return { ok: false, reason: 'idle_expired' };

  // Slide the idle window, but avoid a D1 write on every single request.
  if (now - record.last_seen_at > TOUCH_GRANULARITY_SECONDS) {
    await store.touch(record.id, now);
  }

  return {
    ok: true,
    session: {
      id: record.id,
      userId: record.user_id,
      createdAt: record.created_at,
      lastSeenAt: now,
      absoluteExpiresAt: record.absolute_expires_at,
    },
  };
}

export async function revokeSession(
  store: SessionStore,
  sessionId: string,
  now: number,
): Promise<void> {
  await store.revoke(sessionId, now);
}
