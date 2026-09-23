/**
 * The runtime refuses the iteration count this app was configured to use.
 *
 * THE DEFECT THIS EXISTS FOR — the one that made the first production
 * deployment impossible to log into, and the one I misdiagnosed twice.
 *
 *     Pbkdf2 failed: iteration counts above 100000 are not supported
 *     (requested 600000).
 *
 * Not a CPU budget. Not a plan limit. A hard rejection of the PARAMETER,
 * identical on Free and Paid. The request never ran long enough to spend CPU
 * at all — Cloudflare's own log recorded `cpuTimeMs: 5` on the 500.
 *
 * WHY 402 PASSING TESTS SAID NOTHING. Every fixture in the suite calls
 * `hashPassword(password, 1000)` with an explicit low count, "because these
 * tests assert behaviour, not cost". So `DEFAULT_ITERATIONS` — the value
 * production actually uses — was never once executed inside workerd, in a
 * suite that runs inside workerd and would have thrown on the first call.
 * The seed script that DID use 600,000 runs in Node, where no cap exists.
 *
 * Both halves of the login route were dead, which is why it looked like the
 * handler was never reached: `dummyVerify()` used the same constant, so the
 * "no such user" arm threw too and `audit_log` stayed empty.
 *
 * So the rule these tests encode: EXERCISE THE SHIPPED PARAMETERS, on the
 * real runtime, not a convenient stand-in for them. A test that substitutes
 * the value whose value is the bug cannot fail for the reason it exists.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ITERATIONS,
  MAX_ITERATIONS_PER_ROUND,
  dummyVerify,
  hashPassword,
  verifyPassword,
} from '../../src/auth/password';

/** Plain, single-shot PBKDF2 — an implementation independent of the one under test. */
async function plainPbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

const b64urlToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/**
 * NOTE, AND IT IS THE WHOLE REASON THIS CLASS IS DANGEROUS.
 *
 * The workerd in `@cloudflare/vitest-pool-workers` does NOT enforce the cap.
 * Asked for 600,000 iterations it returns a key; the deployed runtime answers
 *
 *     Pbkdf2 failed: iteration counts above 100000 are not supported
 *
 * So there is no local assertion that can reproduce the production rejection,
 * and CI cannot either — a boundary test here would pass on both the broken
 * and the fixed implementation. That was tried first and it is recorded here
 * so nobody tries it again.
 *
 * What CAN be asserted locally is the SHAPE of what we ask for: that the
 * implementation never issues a single request above the cap, provable
 * because a chained derivation and a single-shot derivation of the same total
 * produce DIFFERENT bytes. That is the guard below.
 */
describe('the implementation never asks for more than one round at a time', () => {
  it('at the cap, derives in a single round — identical to plain PBKDF2', async () => {
    const stored = await hashPassword('pw', MAX_ITERATIONS_PER_ROUND);
    const [algo, , , saltB64, hashB64] = stored.split('$');
    expect(algo).toBe('pbkdf2');
    const expected = await plainPbkdf2('pw', b64urlToBytes(saltB64), MAX_ITERATIONS_PER_ROUND);
    expect(b64urlToBytes(hashB64)).toEqual(expected);
  });

  it('ABOVE the cap, the bytes prove it chained instead of asking for it all at once', async () => {
    // If the implementation regressed to a single deriveBits(200_000) call,
    // this would match plain PBKDF2 and the test fails — which is exactly the
    // regression that takes production down, caught without needing the
    // runtime to enforce anything.
    const total = MAX_ITERATIONS_PER_ROUND * 2;
    const stored = await hashPassword('pw', total);
    const [algo, , , saltB64, hashB64] = stored.split('$');
    expect(algo).toBe('pbkdf2c');

    const singleShot = await plainPbkdf2('pw', b64urlToBytes(saltB64), total);
    expect(b64urlToBytes(hashB64)).not.toEqual(singleShot);
  });

  it('and the chained bytes are exactly what two manual rounds produce', async () => {
    // Pins the construction itself: round 2 keys on round 1's output.
    const total = MAX_ITERATIONS_PER_ROUND * 2;
    const stored = await hashPassword('pw', total);
    const saltB64 = stored.split('$')[3];
    const salt = b64urlToBytes(saltB64);

    const round1 = await plainPbkdf2('pw', salt, MAX_ITERATIONS_PER_ROUND);
    const key2 = await crypto.subtle.importKey(
      'raw',
      round1 as BufferSource,
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const round2 = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: salt as BufferSource,
          iterations: MAX_ITERATIONS_PER_ROUND,
          hash: 'SHA-256',
        },
        key2,
        256,
      ),
    );
    expect(b64urlToBytes(stored.split('$')[4])).toEqual(round2);
  });

  it('splits the shipped default into exactly ceil(600000 / 100000) rounds', async () => {
    expect(DEFAULT_ITERATIONS / MAX_ITERATIONS_PER_ROUND).toBe(6);
    const stored = await hashPassword('pw');
    expect(stored.startsWith(`pbkdf2c$sha256$${DEFAULT_ITERATIONS}$`)).toBe(true);
  });
});

describe('the shipped default, exercised as production calls it', () => {
  it('hashes with NO iteration argument at all', async () => {
    // THE TEST THAT WAS MISSING. One line, no arguments, and it is the exact
    // call src/routes/auth.ts makes. It throws on the old implementation.
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith(`pbkdf2c$sha256$${DEFAULT_ITERATIONS}$`)).toBe(true);
  });

  it('round-trips at the default cost', async () => {
    const stored = await hashPassword('correct horse battery staple');
    const ok = await verifyPassword('correct horse battery staple', stored);
    expect(ok.valid).toBe(true);
    expect(ok.needsRehash).toBe(false);
    expect(ok.unsupported).toBe(false);
    expect((await verifyPassword('wrong', stored)).valid).toBe(false);
  });

  it('dummyVerify does not throw, so the no-such-user arm survives', async () => {
    // This arm failing is why audit_log was empty and the whole thing looked
    // like it never reached the handler.
    await expect(dummyVerify()).resolves.toBeUndefined();
  });
});

describe('chaining preserves the work factor without changing cheap hashes', () => {
  it('is byte-identical to plain PBKDF2 at or below one round', async () => {
    // The compatibility claim, checked against an independent implementation.
    // This is what keeps every pre-existing hash and test fixture valid.
    const stored = await hashPassword('pw', 1000);
    const [algo, , iters, saltB64, hashB64] = stored.split('$');
    expect(algo).toBe('pbkdf2');
    expect(iters).toBe('1000');

    const expected = await plainPbkdf2('pw', b64urlToBytes(saltB64), 1000);
    expect(b64urlToBytes(hashB64)).toEqual(expected);
  });

  it('is NOT plain PBKDF2 above one round, and says so in the tag', async () => {
    // Honesty in the stored format. The output genuinely is not PBKDF2-600k,
    // so it must not be labelled as though it were — otherwise a future reader
    // (or another implementation) would try to verify it the wrong way.
    const stored = await hashPassword('pw', MAX_ITERATIONS_PER_ROUND + 1);
    expect(stored.startsWith('pbkdf2c$')).toBe(true);
  });

  it('changes with the password, the salt and the total work', async () => {
    const a = await hashPassword('pw', 200_000);
    const b = await hashPassword('pw', 200_000);
    const c = await hashPassword('pw', 300_000);
    // Different salts each time.
    expect(a).not.toBe(b);
    expect(a.split('$')[4]).not.toBe(b.split('$')[4]);
    // And a different work factor is a different record entirely.
    expect(c.split('$')[2]).toBe('300000');
    expect((await verifyPassword('pw', c)).valid).toBe(true);
    expect((await verifyPassword('pw ', c)).valid).toBe(false);
  });
});

describe('a hash this runtime cannot evaluate', () => {
  const LEGACY =
    'pbkdf2$sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('is reported as unsupported, NOT as a wrong password', async () => {
    // This is exactly what the production row looked like: written in Node by
    // the seed script at a flat 600,000, unreproducible inside workerd.
    //
    // The distinction is the whole point. "Wrong password" is the user's
    // problem; "we cannot evaluate this hash" is ours, and collapsing the two
    // is how an operator ends up retyping a correct password for three hours.
    const result = await verifyPassword('whatever', LEGACY);
    expect(result.unsupported).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it('does not throw, so it cannot become a 500 again', async () => {
    await expect(verifyPassword('whatever', LEGACY)).resolves.toBeDefined();
  });

  it('still rejects genuinely malformed records as plain failures', async () => {
    for (const bad of ['garbage', 'pbkdf2$sha256$notanumber$a$b', 'bcrypt$sha256$1000$a$b']) {
      const r = await verifyPassword('pw', bad);
      expect(r.valid).toBe(false);
      expect(r.unsupported).toBe(false);
    }
  });
});
