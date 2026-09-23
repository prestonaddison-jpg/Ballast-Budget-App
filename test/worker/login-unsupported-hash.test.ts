/**
 * A hash the runtime cannot evaluate must not be reported as a bad password.
 *
 * THE PRODUCTION FAILURE THIS REPRODUCES. The first deployed user's row was
 * written by a Node seed script at a flat 600,000 PBKDF2 iterations. workerd
 * refuses any count above 100,000, so `verifyPassword` THREW, the route
 * answered 500, and the login screen said "That email and password did not
 * match." The password was correct. The operator retyped it for hours.
 *
 * Two separate wrongs, and this file pins both:
 *
 *   1. It threw at all, turning a data condition into an unhandled 500.
 *   2. It was described to the operator as their typing mistake.
 *
 * `audit_log` was empty throughout, which made it look like the request never
 * reached the handler — because `dummyVerify()` used the same constant and the
 * "no such user" arm threw identically. Both arms are asserted here.
 */

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../../src/db/repos/users';
import { hashPassword } from '../../src/auth/password';
import { randomId } from '../../src/crypto/random';

const NOW = 1_800_000_000;
// MUST match vitest.config.ts's APP_ORIGIN binding, or every POST is
// refused by the CSRF check as cross-origin before the route ever runs.
const ORIGIN = 'http://localhost:8787';

/** The stored shape of a hash created off-platform, above workerd's cap. */
const UNVERIFIABLE =
  'pbkdf2$sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function login(email: string, password: string) {
  return SELF.fetch(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'ballast',
      Origin: ORIGIN,
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ email, password }),
  });
}

const auditRows = async (userId: string) =>
  (
    await env.DB.prepare('SELECT action, detail FROM audit_log WHERE user_id = ?')
      .bind(userId)
      .all<{ action: string; detail: string }>()
  ).results ?? [];

describe('a stored hash this runtime cannot reproduce', () => {
  let userId: string;
  let email: string;

  beforeEach(async () => {
    userId = randomId();
    email = `${userId}@example.test`;
    await createUser(env.DB, { id: userId, email, passwordHash: UNVERIFIABLE, now: NOW });
  });

  it('answers 503, not 401 — it is our problem, not the operator’s', async () => {
    const res = await login(email, 'the-correct-password');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('misconfigured');
  });

  it('never tells the operator their password was wrong', async () => {
    const res = await login(email, 'the-correct-password');
    const body = (await res.json()) as { message: string };
    // The exact sentence that was shown in production while the password was
    // correct. It must not appear for this condition again.
    expect(body.message).not.toMatch(/did not match/i);
  });

  it('writes an audit row naming the real reason', async () => {
    await login(email, 'the-correct-password');
    const rows = await auditRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('login.failure');
    expect(rows[0].detail).toContain('hash_unsupported');
  });

  it('does not 500, which is what it actually did', async () => {
    const res = await login(email, 'anything');
    expect(res.status).not.toBe(500);
  });
});

describe('the arms that must keep working', () => {
  it('an unknown user still gets 401 and an audit row, not a crash', async () => {
    // dummyVerify() runs here. It used the uncapped constant too, so this arm
    // threw in production and wrote nothing — which is precisely why an empty
    // audit_log was misread as "the request never arrived".
    const res = await login('nobody@example.test', 'wrong');
    expect(res.status).toBe(401);

    const rows =
      (
        await env.DB.prepare(
          "SELECT action, detail FROM audit_log WHERE user_id IS NULL AND action = 'login.failure'",
        ).all<{ action: string; detail: string }>()
      ).results ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.detail.includes('unknown_user'))).toBe(true);
  });

  it('a real user at the shipped default logs in', async () => {
    // End to end through the SAME default production uses — no test-only
    // iteration count anywhere in this path.
    const id = randomId();
    const addr = `${id}@example.test`;
    await createUser(env.DB, {
      id,
      email: addr,
      passwordHash: await hashPassword('correct horse battery staple'),
      now: NOW,
    });

    const res = await login(addr, 'correct horse battery staple');
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toBeTruthy();

    const rows = await auditRows(id);
    expect(rows.some((r) => r.action === 'login.success')).toBe(true);
  });

  it('and a wrong password for that user is still a plain 401', async () => {
    const id = randomId();
    const addr = `${id}@example.test`;
    await createUser(env.DB, {
      id,
      email: addr,
      passwordHash: await hashPassword('correct horse battery staple'),
      now: NOW,
    });

    const res = await login(addr, 'not the password');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/did not match/i);
  });
});
