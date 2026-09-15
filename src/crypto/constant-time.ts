/**
 * Constant-time comparison.
 *
 * Comparing secrets with === (or with String equality) short-circuits on the
 * first differing byte, which leaks a prefix-length oracle to anyone who can
 * time the response. Every comparison of a session token hash, an HMAC, or a
 * webhook body digest goes through here.
 *
 * Workers exposes a NON-STANDARD `crypto.subtle.timingSafeEqual(a, b)`. It is
 * preferred when present — a native implementation is not subject to the JIT
 * deciding to optimise a hand-written loop into something that short-circuits.
 * The portable fallback exists so these functions also work in plain Node
 * (the spikes) and in any future non-Workers context.
 */

interface SubtleWithTimingSafeEqual {
  timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean;
}

function nativeTimingSafeEqual(a: Uint8Array, b: Uint8Array): boolean | null {
  const subtle = crypto.subtle as unknown as SubtleWithTimingSafeEqual;
  if (typeof subtle.timingSafeEqual !== 'function') return null;
  // The native version throws on a length mismatch rather than returning
  // false, so the (non-secret) length is checked first either way.
  if (a.length !== b.length) return false;
  return subtle.timingSafeEqual(a, b);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Length is not secret, but returning early on a length mismatch must not
  // skip the loop for equal-length inputs.
  if (a.length !== b.length) return false;

  const native = nativeTimingSafeEqual(a, b);
  if (native !== null) return native;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
