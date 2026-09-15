/**
 * Plaid webhook verification — ES256 JWT, via Web Crypto only.
 *
 * The webhook route is PUBLIC (§15): Cloudflare Access was dropped precisely
 * because it blocked Plaid's webhooks. This signature check is therefore the
 * ONLY thing standing between the open internet and Ballast's sync pipeline.
 *
 * Plaid's documented algorithm, in order:
 *   1. Read the JWT from the `Plaid-Verification` header.
 *   2. Decode the JWT header WITHOUT verifying.
 *   3. Assert `alg === "ES256"`. This is the algorithm-confusion guard: never
 *      let the token choose its own verifier (the "alg: none" class of bug).
 *   4. Take `kid` from the header.
 *   5. POST /webhook_verification_key/get with `key_id` (NOT `kid` — the
 *      request field is named differently from the JWT header field).
 *   6. Verify the signature against the returned JWK.
 *   7. Reject if `iat` is more than 5 minutes old (replay bound).
 *   8. SHA-256 the RAW body and constant-time-compare to
 *      `request_body_sha256`.
 *
 * TWO TRAPS, both silent:
 *
 *   RAW BYTES. The digest covers the exact bytes on the wire. Plaid sends the
 *   body pretty-printed with two-space indentation, so `JSON.stringify(await
 *   req.json())` produces a DIFFERENT string and the comparison always fails.
 *   This function takes an ArrayBuffer for that reason and never parses before
 *   verifying.
 *
 *   SIGNATURE FORMAT. JOSE ES256 signatures are raw r||s — two 32-byte
 *   big-endian integers, 64 bytes. Web Crypto's ECDSA verify expects exactly
 *   that, so no conversion is needed here. (Node's crypto defaults to DER and
 *   needs `dsaEncoding: 'ieee-p1363'`; porting Node code in would break this.)
 *   A format mismatch makes crypto.subtle.verify RESOLVE FALSE rather than
 *   throw, which reads like a wrong key rather than a wrong encoding.
 */

import { base64UrlToBytes, bytesToHex, utf8 } from '../../crypto/encoding';
import { sha256 } from '../../crypto/hash';
import { timingSafeEqualHex } from '../../crypto/constant-time';
import { LedgerSourceError } from '../types';
import type { PlaidJwkPublicKey } from './api-types';

/** Plaid's documented replay bound. */
const MAX_AGE_SECONDS = 300;
/** Defensive only; Plaid does not specify a future-skew bound. */
const MAX_FUTURE_SKEW_SECONDS = 60;

export interface PlaidJwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

export interface PlaidJwtClaims {
  iat: number;
  request_body_sha256: string;
}

export class WebhookVerificationError extends LedgerSourceError {
  constructor(reason: string) {
    // Never retryable: a bad signature does not get better on a second try.
    super('WEBHOOK_VERIFICATION_FAILED', reason, false);
    this.name = 'WebhookVerificationError';
  }
}

/** Fetches a Plaid JWK by key id. Implementations should cache by kid. */
export type JwkFetcher = (keyId: string) => Promise<PlaidJwkPublicKey>;

function decodeSegment<T>(segment: string, what: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
  } catch {
    throw new WebhookVerificationError(`Malformed JWT ${what}`);
  }
  // JSON.parse('null') SUCCEEDS and returns null, and 'bnVsbA' is a valid
  // base64url segment — so without this check a crafted header would reach
  // `header.alg` on null and throw a raw TypeError, escaping this module's
  // error contract and surfacing as a 500 instead of a clean rejection.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookVerificationError(`JWT ${what} is not an object`);
  }
  return parsed as T;
}

/**
 * Plaid key ids are fixed-length lowercase hex. Pinning the shape matters
 * because `kid` is attacker-controlled and drives an outbound request: without
 * it, every junk value is a distinct cache key and therefore a fresh call to
 * Plaid.
 */
const KID_PATTERN = /^[a-f0-9]{16,64}$/i;

/**
 * Verify a webhook and return its parsed body.
 *
 * @param rawBody The EXACT bytes received. Never a re-serialized object.
 */
export interface VerifiedWebhook {
  payload: unknown;
  /**
   * Hex SHA-256 of the signed delivery token. This — not the body digest — is
   * the correct dedup key: a Plaid RETRY re-sends the same JWT, while two
   * distinct events carry different `iat` values and therefore different
   * signatures. Deduplicating on the body would collapse genuinely different
   * sync notifications, whose bodies are byte-identical.
   */
  deliveryDigest: string;
  bodyDigest: string;
}

export async function verifyPlaidWebhook(
  rawBody: ArrayBuffer,
  headers: Headers,
  fetchJwk: JwkFetcher,
  nowSeconds: number,
): Promise<VerifiedWebhook> {
  const jwt = headers.get('Plaid-Verification');
  if (!jwt) throw new WebhookVerificationError('Missing Plaid-Verification header');

  const segments = jwt.split('.');
  if (segments.length !== 3) throw new WebhookVerificationError('JWT must have three segments');
  const [headerB64, payloadB64, signatureB64] = segments;

  // Step 2-3: decode the header and pin the algorithm BEFORE any crypto.
  const header = decodeSegment<PlaidJwtHeader>(headerB64, 'header');
  if (header.alg !== 'ES256') {
    throw new WebhookVerificationError(`Unexpected alg: ${header.alg}`);
  }
  if (typeof header.kid !== 'string' || !KID_PATTERN.test(header.kid)) {
    // Rejecting a malformed kid BEFORE the fetch keeps an unauthenticated
    // caller from using this route to drive arbitrary outbound requests.
    throw new WebhookVerificationError('Missing or malformed kid');
  }

  // Step 5: fetch the key for this kid.
  const jwk = await fetchJwk(header.kid);
  if (jwk.expired_at != null) {
    throw new WebhookVerificationError('Signing key has expired');
  }

  // Step 6: verify the signature over `header.payload`, exactly as received.
  // Only the four standard EC members are passed: Plaid's JWK carries
  // created_at / expired_at, which are not JWK members and mean nothing to
  // Web Crypto.
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch (cause) {
    // Distinct from a verify-false below, so a bad key is not misdiagnosed as
    // a bad signature.
    throw new WebhookVerificationError('Could not import signing key');
  }

  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(signatureB64); // raw r||s, 64 bytes
  } catch {
    throw new WebhookVerificationError('Malformed JWT signature segment');
  }
  const signedData = utf8(`${headerB64}.${payloadB64}`);
  const signatureValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature as BufferSource,
    signedData as BufferSource,
  );
  if (!signatureValid) throw new WebhookVerificationError('Signature did not verify');

  // Step 7: replay bound.
  const claims = decodeSegment<PlaidJwtClaims>(payloadB64, 'payload');
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
    throw new WebhookVerificationError('Missing iat');
  }
  const age = nowSeconds - claims.iat;
  if (age > MAX_AGE_SECONDS) throw new WebhookVerificationError('Webhook is older than 5 minutes');
  if (age < -MAX_FUTURE_SKEW_SECONDS)
    throw new WebhookVerificationError('Webhook iat is in the future');

  // Step 8: body integrity, over the raw bytes, compared in constant time.
  if (typeof claims.request_body_sha256 !== 'string') {
    throw new WebhookVerificationError('Missing request_body_sha256');
  }
  const actualDigest = bytesToHex(await sha256(rawBody));
  if (!timingSafeEqualHex(actualDigest, claims.request_body_sha256.toLowerCase())) {
    throw new WebhookVerificationError('Body digest mismatch');
  }

  // Only now is it safe to parse.
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw new WebhookVerificationError('Verified body was not valid JSON');
  }

  return {
    payload,
    deliveryDigest: bytesToHex(await sha256(utf8(jwt))),
    bodyDigest: actualDigest,
  };
}

/**
 * JWK fetcher with a KV cache.
 *
 * Plaid rotates signing keys, so the cache is keyed by `kid` and a miss simply
 * fetches. Caching matters: without it every webhook costs an extra
 * round-trip to Plaid before the Worker can decide whether to trust the body.
 */
export function cachedJwkFetcher(
  kv: KVNamespace,
  fetchFromPlaid: (keyId: string) => Promise<PlaidJwkPublicKey>,
  ttlSeconds = 24 * 60 * 60,
): JwkFetcher {
  return async (keyId: string) => {
    const cacheKey = `plaid:jwk:${keyId}`;
    const cached = await kv.get<PlaidJwkPublicKey>(cacheKey, 'json');
    if (cached && cached.expired_at == null) return cached;

    const fresh = await fetchFromPlaid(keyId);
    // Never cache an expired key.
    if (fresh.expired_at == null) {
      await kv.put(cacheKey, JSON.stringify(fresh), { expirationTtl: ttlSeconds });
    }
    return fresh;
  };
}
