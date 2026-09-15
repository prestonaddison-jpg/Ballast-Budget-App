import { bytesToBase64Url, bytesToHex, utf8 } from './encoding';

/** SHA-256 over raw bytes. */
export async function sha256(input: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  // Copy into a fresh, exactly-sized ArrayBuffer so a subarray view never
  // hashes its parent buffer's trailing bytes.
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(digest);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return bytesToHex(await sha256(typeof input === 'string' ? utf8(input) : input));
}

export async function sha256Base64Url(input: string | Uint8Array): Promise<string> {
  return bytesToBase64Url(await sha256(typeof input === 'string' ? utf8(input) : input));
}
