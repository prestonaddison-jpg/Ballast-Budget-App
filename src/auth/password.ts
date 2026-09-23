/**
 * Password hashing — PBKDF2-HMAC-SHA256 via Web Crypto.
 *
 * WHY PBKDF2 AND NOT ARGON2/BCRYPT/SCRYPT:
 *   Workers expose Web Crypto, which offers PBKDF2 and nothing else in the
 *   password-hashing family. Argon2id would be the first choice on a platform
 *   that had it; shipping a WASM Argon2 into a Worker is possible but adds a
 *   large audited-dependency surface to the most security-critical path in the
 *   app. PBKDF2 at a high iteration count is the sanctioned fallback.
 *
 * PARAMETERS follow the OWASP Password Storage Cheat Sheet: PBKDF2-HMAC-SHA256
 * at 600,000 iterations, a 128-bit random salt, and a 256-bit derived key
 * (matching the HMAC-SHA256 output size — asking for more would be wasted work
 * that an attacker skips).
 *
 * ---------------------------------------------------------------------------
 * THE PLATFORM CAP, and the reason this file is not a plain PBKDF2 call.
 *
 * workerd REFUSES an iteration count above 100,000. Not a CPU budget, not a
 * soft limit — a hard rejection of the parameter, identical on every plan:
 *
 *     Pbkdf2 failed: iteration counts above 100000 are not supported
 *     (requested 600000).
 *
 * This is what broke login on the first production deployment. Every request
 * to /api/auth/login answered 500, from BOTH branches — dummyVerify() used the
 * same constant, so "no such user" threw too, which is why audit_log stayed
 * empty and made the failure look like it never reached the handler.
 *
 * Nothing caught it because every test in the suite passes an explicit 1,000,
 * and scripts/seed-preview.mjs runs in Node, where there is no cap. The
 * default was therefore never once executed inside workerd — in a suite that
 * runs inside workerd and would have thrown on the first call.
 *
 * WHAT WE DO ABOUT IT. Dropping to 100,000 would be a 6x cut below the OWASP
 * figure, so instead the work is CHAINED: ceil(total / 100,000) sequential
 * PBKDF2 calls, each capped at 100,000, with each round's 256-bit output used
 * as the next round's key material. An attacker testing a candidate password
 * must still perform all 600,000 iterations — the cost, which is the entire
 * security property of a password hash, is preserved exactly.
 *
 * Two properties make this safe rather than clever:
 *
 *   1. A total at or below 100,000 runs as exactly ONE round from the
 *      password, so the output is byte-identical to a plain PBKDF2 call.
 *      Old hashes keep verifying and `pbkdf2` keeps meaning what it said.
 *      `test/unit/crypto.test.ts` pins that equivalence against an
 *      independent implementation.
 *   2. Anything above 100,000 is written with a DIFFERENT algorithm tag
 *      (`pbkdf2c`), because its output is legitimately not plain PBKDF2.
 *      A stored `pbkdf2` hash above the cap can never be reproduced on this
 *      platform and is reported as unsupported rather than silently wrong.
 *
 * Stored format: `<algo>$sha256$<iterations>$<salt b64url>$<hash b64url>`
 * The parameters travel with the hash so the cost can be raised later and old
 * hashes still verify (and can be transparently upgraded on next login).
 */

import { base64UrlToBytes, bytesToBase64Url, utf8 } from '../crypto/encoding';
import { randomBytes } from '../crypto/random';
import { timingSafeEqual } from '../crypto/constant-time';

/** Plain PBKDF2. Only ever written when iterations fit in one round. */
const ALGO_SINGLE = 'pbkdf2';
/** Chained PBKDF2. Written whenever the work exceeds one round. */
const ALGO_CHAINED = 'pbkdf2c';
const DIGEST = 'sha256';

/**
 * The hard ceiling workerd enforces on a single deriveBits call.
 *
 * Exported so a test can assert the boundary against the real runtime rather
 * than trusting this comment. Cloudflare does not document the figure; it
 * comes from the runtime's own error message and is verified in
 * test/unit/crypto.test.ts by calling deriveBits at the limit and one above.
 */
export const MAX_ITERATIONS_PER_ROUND = 100_000;

/** Total work factor, per OWASP. Split across rounds, never requested at once. */
export const DEFAULT_ITERATIONS = 600_000;

const SALT_BYTES = 16;
const KEY_BITS = 256;

/** One PBKDF2 call. `material` is the password bytes, or a previous round's output. */
async function deriveRound(
  material: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    material as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * `totalIterations` of PBKDF2 work, in rounds no larger than the platform cap.
 *
 * With `totalIterations <= MAX_ITERATIONS_PER_ROUND` this is one round from
 * the password and is therefore identical to plain PBKDF2 — which is what
 * keeps every pre-existing hash and every test fixture valid.
 */
async function derive(
  password: string,
  salt: Uint8Array,
  totalIterations: number,
): Promise<Uint8Array> {
  let remaining = totalIterations;
  // The first round keys on the password itself; each later round keys on the
  // 256 bits the previous one produced. Sequential by construction — a round
  // cannot start until the one before it has finished, so the work cannot be
  // parallelised away by an attacker any more than PBKDF2's own chain can.
  let material = utf8(password);
  let out: Uint8Array | null = null;

  while (remaining > 0) {
    const thisRound = Math.min(remaining, MAX_ITERATIONS_PER_ROUND);
    out = await deriveRound(material, salt, thisRound);
    material = out;
    remaining -= thisRound;
  }

  // Unreachable for any caller-visible iteration count: hashPassword rejects
  // anything below 1, and verifyPassword rejects it while parsing.
  if (out === null) throw new Error('derive called with no iterations');
  return out;
}

function algoFor(iterations: number): string {
  return iterations <= MAX_ITERATIONS_PER_ROUND ? ALGO_SINGLE : ALGO_CHAINED;
}

export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`hashPassword: iterations must be a positive integer, got ${iterations}`);
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, iterations);
  return `${algoFor(iterations)}$${DIGEST}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export interface PasswordVerification {
  valid: boolean;
  /** True when the stored hash used weaker parameters than we now require. */
  needsRehash: boolean;
  /**
   * True when the hash is well-formed but CANNOT be checked on this runtime —
   * a plain `pbkdf2` record above the platform's iteration cap, which is what
   * a hash created off-platform (in Node, say, by a seed script) looks like.
   *
   * Distinguished from `valid: false` on purpose. A wrong password and a hash
   * we are structurally unable to evaluate are different events: the first is
   * the user's problem, the second is ours, and logging them the same way is
   * how this defect stayed invisible for a whole deployment.
   */
  unsupported: boolean;
}

const FAILED: PasswordVerification = { valid: false, needsRehash: false, unsupported: false };

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<PasswordVerification> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[1] !== DIGEST) return FAILED;

  const algo = parts[0];
  if (algo !== ALGO_SINGLE && algo !== ALGO_CHAINED) return FAILED;

  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return FAILED;

  // A plain-PBKDF2 record above the cap cannot be recomputed here at all. Say
  // so rather than returning a confident "wrong password".
  if (algo === ALGO_SINGLE && iterations > MAX_ITERATIONS_PER_ROUND) {
    return { valid: false, needsRehash: false, unsupported: true };
  }

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlToBytes(parts[3]);
    expected = base64UrlToBytes(parts[4]);
  } catch {
    return FAILED;
  }

  const actual = await derive(password, salt, iterations);
  const valid = timingSafeEqual(actual, expected);
  return { valid, needsRehash: valid && iterations < DEFAULT_ITERATIONS, unsupported: false };
}

/**
 * Burn a comparable amount of CPU when the account does not exist, so that
 * "no such user" and "wrong password" are indistinguishable by timing. The
 * login route already returns an identical response body for both.
 *
 * This used the uncapped constant too, so on the first deployment it threw
 * exactly like the real path — the arm that exists to hide which branch ran
 * was the second arm failing. It goes through `derive`, so it now costs the
 * same as a real verification and cannot exceed the cap.
 */
export async function dummyVerify(): Promise<void> {
  await derive('ballast-dummy-password', randomBytes(SALT_BYTES), DEFAULT_ITERATIONS);
}
