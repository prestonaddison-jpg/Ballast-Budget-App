/**
 * Field-level encryption for secrets stored in D1 (Plaid access tokens above
 * all).
 *
 * THREAT MODEL (§16, stated so nobody over-trusts this):
 *   Field encryption protects a D1 DUMP. It does NOT protect against a
 *   compromised Worker — the Worker holds the key by definition. Its job is to
 *   make a leaked database file, backup, or SQL export useless on its own.
 *
 * Construction: AES-256-GCM with a UNIQUE 96-bit IV per encryption.
 *   - IV reuse under the same key is catastrophic for GCM: it leaks the XOR of
 *     plaintexts and, worse, allows forgery by recovering the auth subkey. The
 *     IV is therefore always freshly random here and never derived or reused.
 *   - 96 bits is GCM's native IV size; other lengths are rehashed internally
 *     by GHASH and buy nothing.
 *   - With RANDOM 96-bit IVs the birthday bound caps safe use at roughly 2^32
 *     encryptions under one key. Ballast encrypts one field per linked
 *     institution, so that ceiling is unreachable in practice — but it is the
 *     reason key rotation exists as a documented procedure rather than an
 *     afterthought (docs/SECURITY.md).
 *   - Additional authenticated data (AAD) binds each ciphertext to the record
 *     it belongs to. Without AAD an attacker with write access to D1 could
 *     move a valid ciphertext from one row to another (a ciphertext-swap) and
 *     the Worker would decrypt it happily. With AAD, a moved ciphertext fails
 *     authentication.
 *
 * Envelope format: `v1.<base64url iv>.<base64url ciphertext||tag>`
 * The version prefix exists so the key/algorithm can be rotated without
 * guessing at the shape of historical rows.
 */

import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from './encoding';
import { randomBytes } from './random';

const VERSION = 'v1';
const IV_BYTES = 12; // 96-bit GCM nonce
const KEY_BYTES = 32; // AES-256

export class FieldCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldCryptoError';
  }
}

/**
 * Import the encryption key from its base64 secret.
 *
 * Kept as a function (not a module-level cached key) because module scope in a
 * Worker is shared across requests — see §16 "no request state in module or
 * global scope". A CryptoKey is not request state, but caching it here would
 * be the first step onto that path, and importKey is cheap.
 */
export async function importFieldKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64UrlToBytes(base64Key.trim());
  } catch {
    throw new FieldCryptoError('FIELD_ENCRYPTION_KEY is not valid base64');
  }
  if (raw.length !== KEY_BYTES) {
    throw new FieldCryptoError(
      `FIELD_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a string field.
 *
 * @param aad Stable identifier of the row this ciphertext belongs to, e.g.
 *            `plaid_item:${itemId}`. MUST be supplied and MUST match on
 *            decrypt.
 */
export async function encryptField(
  key: CryptoKey,
  plaintext: string,
  aad: string,
): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8(aad) as BufferSource },
    key,
    utf8(plaintext) as BufferSource,
  );
  return `${VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ct))}`;
}

export async function decryptField(key: CryptoKey, envelope: string, aad: string): Promise<string> {
  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new FieldCryptoError('Unrecognised ciphertext envelope');
  }

  // base64UrlToBytes calls atob, which throws a raw DOMException on invalid
  // characters. A truncated or mangled ciphertext column — a partial write, a
  // bad export/import, a manual SQL edit — would otherwise escape this
  // module's FieldCryptoError contract and surface as an unhandled 500.
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = base64UrlToBytes(parts[1]);
    ct = base64UrlToBytes(parts[2]);
  } catch {
    throw new FieldCryptoError('Malformed ciphertext envelope');
  }
  if (iv.length !== IV_BYTES) throw new FieldCryptoError('Bad IV length');

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8(aad) as BufferSource },
      key,
      ct as BufferSource,
    );
  } catch {
    // Authentication failure: wrong key, tampered ciphertext, or a ciphertext
    // lifted from a different row. Never distinguish these to the caller.
    throw new FieldCryptoError('Decryption failed');
  }
  return fromUtf8(new Uint8Array(plain));
}

/** Generate a fresh key, for `wrangler secret put FIELD_ENCRYPTION_KEY`. */
export function generateFieldKey(): string {
  return bytesToBase64Url(randomBytes(KEY_BYTES));
}
