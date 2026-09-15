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
 * Stored format: `pbkdf2$sha256$<iterations>$<salt b64url>$<hash b64url>`
 * The parameters travel with the hash so the cost can be raised later and old
 * hashes still verify (and can be transparently upgraded on next login).
 */

import { base64UrlToBytes, bytesToBase64Url, utf8 } from '../crypto/encoding';
import { randomBytes } from '../crypto/random';
import { timingSafeEqual } from '../crypto/constant-time';

const ALGO = 'pbkdf2';
const DIGEST = 'sha256';
export const DEFAULT_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    utf8(password) as BufferSource,
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

export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, iterations);
  return `${ALGO}$${DIGEST}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export interface PasswordVerification {
  valid: boolean;
  /** True when the stored hash used weaker parameters than we now require. */
  needsRehash: boolean;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<PasswordVerification> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== ALGO || parts[1] !== DIGEST) {
    return { valid: false, needsRehash: false };
  }
  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) {
    return { valid: false, needsRehash: false };
  }

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64UrlToBytes(parts[3]);
    expected = base64UrlToBytes(parts[4]);
  } catch {
    return { valid: false, needsRehash: false };
  }

  const actual = await derive(password, salt, iterations);
  const valid = timingSafeEqual(actual, expected);
  return { valid, needsRehash: valid && iterations < DEFAULT_ITERATIONS };
}

/**
 * Burn a comparable amount of CPU when the account does not exist, so that
 * "no such user" and "wrong password" are indistinguishable by timing. The
 * login route already returns an identical response body for both.
 */
export async function dummyVerify(): Promise<void> {
  await derive('ballast-dummy-password', randomBytes(SALT_BYTES), DEFAULT_ITERATIONS);
}
