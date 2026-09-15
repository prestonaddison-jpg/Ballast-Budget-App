import { describe, expect, it } from 'vitest';

describe('harness', () => {
  it('runs inside workerd with Web Crypto available', async () => {
    expect(typeof crypto.subtle.digest).toBe('function');
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ballast'));
    expect(new Uint8Array(d)).toHaveLength(32);
  });
});
