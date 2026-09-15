/**
 * Randomness.
 *
 * WORKER DISCIPLINE (§16): Web Crypto, NEVER Math.random(). Math.random() is
 * not cryptographically secure anywhere, and in a Worker it is additionally
 * seeded per-isolate in ways that can repeat across requests. Every secret
 * value in Ballast — session tokens, salts, IVs, CSRF values — comes from
 * crypto.getRandomValues via this module, so there is exactly one place to
 * audit.
 */

import { bytesToBase64Url } from './encoding';

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * 256 bits of entropy, base64url encoded (43 chars).
 *
 * Comfortably above ASVS 5.0 V7.2.3's 128-bit floor for reference session
 * tokens. (Note the OWASP Session Management Cheat Sheet still quotes a lower
 * 64-bit minimum; 5.0's 128 is the number Ballast builds to.)
 */
export function randomToken(byteLength = 32): string {
  return bytesToBase64Url(randomBytes(byteLength));
}

/**
 * RFC 4122 v4 UUID, for NON-SECRET identifiers only (primary keys, audit-log
 * ids, correlation ids).
 *
 * NEVER use this for anything unguessable-by-design. ASVS 5.0 V11.5.1 requires
 * at least 128 bits of entropy for non-guessable values and calls UUIDs out by
 * name: "Note that UUIDs do not respect this condition." A v4 UUID carries 122
 * bits, six short of the floor. Session tokens, CSRF values and the like use
 * randomToken() above, which is 256 bits.
 */
export function randomId(): string {
  return crypto.randomUUID();
}
