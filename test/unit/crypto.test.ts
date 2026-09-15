import { describe, expect, it } from 'vitest';
import {
  decryptField,
  encryptField,
  FieldCryptoError,
  generateFieldKey,
  importFieldKey,
} from '../../src/crypto/field-encryption';
import { timingSafeEqual, timingSafeEqualHex } from '../../src/crypto/constant-time';
import { randomToken } from '../../src/crypto/random';
import { base64UrlToBytes, bytesToBase64Url } from '../../src/crypto/encoding';
import { hashPassword, verifyPassword } from '../../src/auth/password';

describe('field encryption', () => {
  const AAD = 'plaid_item:item_123';

  it('round-trips a value', async () => {
    const key = await importFieldKey(generateFieldKey());
    const envelope = await encryptField(key, 'access-sandbox-abc', AAD);
    expect(await decryptField(key, envelope, AAD)).toBe('access-sandbox-abc');
  });

  it('produces a DIFFERENT ciphertext each time (unique IV)', async () => {
    // IV reuse under one key is catastrophic for GCM: it leaks the XOR of
    // plaintexts and enables forgery. Identical ciphertexts would be the
    // visible symptom.
    const key = await importFieldKey(generateFieldKey());
    const a = await encryptField(key, 'same', AAD);
    const b = await encryptField(key, 'same', AAD);
    expect(a).not.toBe(b);
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
  });

  it('refuses a ciphertext moved to a different row (AAD binding)', async () => {
    // Without AAD, someone with write access to D1 could swap a valid
    // ciphertext between rows and the Worker would decrypt it happily.
    const key = await importFieldKey(generateFieldKey());
    const envelope = await encryptField(key, 'secret', 'plaid_item:item_A');
    await expect(decryptField(key, envelope, 'plaid_item:item_B')).rejects.toThrow(
      FieldCryptoError,
    );
  });

  it('refuses a tampered ciphertext', async () => {
    const key = await importFieldKey(generateFieldKey());
    const envelope = await encryptField(key, 'secret', AAD);
    const [v, iv, ct] = envelope.split('.');
    const bytes = base64UrlToBytes(ct);
    bytes[0] ^= 0xff;
    await expect(decryptField(key, `${v}.${iv}.${bytesToBase64Url(bytes)}`, AAD)).rejects.toThrow();
  });

  it('refuses a key of the wrong length', async () => {
    await expect(importFieldKey(bytesToBase64Url(new Uint8Array(16)))).rejects.toThrow(
      FieldCryptoError,
    );
  });

  it('refuses an unknown envelope version', async () => {
    const key = await importFieldKey(generateFieldKey());
    await expect(decryptField(key, 'v2.aaaa.bbbb', AAD)).rejects.toThrow(FieldCryptoError);
  });

  it('uses a 96-bit IV', async () => {
    const key = await importFieldKey(generateFieldKey());
    const envelope = await encryptField(key, 'x', AAD);
    expect(base64UrlToBytes(envelope.split('.')[1])).toHaveLength(12);
  });
});

describe('constant-time comparison', () => {
  it('matches equal inputs', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualHex('abc123', 'abc123')).toBe(true);
  });

  it('rejects differing inputs and differing lengths', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(timingSafeEqualHex('abc', 'abd')).toBe(false);
    expect(timingSafeEqualHex('ab', 'abc')).toBe(false);
  });
});

describe('randomToken', () => {
  it('yields 256 bits, distinct each call', () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toBe(b);
    expect(base64UrlToBytes(a)).toHaveLength(32);
    // base64url must be URL/cookie-safe: no +, /, or = padding.
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('password hashing', () => {
  // Deliberately low iteration counts: these tests assert behaviour, not cost.
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple', 1000);
    expect((await verifyPassword('correct horse battery staple', stored)).valid).toBe(true);
    expect((await verifyPassword('wrong', stored)).valid).toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const a = await hashPassword('same', 1000);
    const b = await hashPassword('same', 1000);
    expect(a).not.toBe(b);
  });

  it('flags a hash stored under weaker parameters for rehash', async () => {
    const stored = await hashPassword('pw', 1000);
    const result = await verifyPassword('pw', stored);
    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it('rejects a malformed stored hash without throwing', async () => {
    expect((await verifyPassword('pw', 'garbage')).valid).toBe(false);
    expect((await verifyPassword('pw', 'pbkdf2$sha256$notanumber$a$b')).valid).toBe(false);
    expect((await verifyPassword('pw', 'bcrypt$sha256$1000$a$b')).valid).toBe(false);
  });

  it('embeds its parameters so cost can be raised later', async () => {
    const stored = await hashPassword('pw', 1234);
    expect(stored.startsWith('pbkdf2$sha256$1234$')).toBe(true);
  });
});
