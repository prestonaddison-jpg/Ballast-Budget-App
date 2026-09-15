/**
 * Authentication routes.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import { isLocalDev } from '../env';
import { buildClearCookie, buildSessionCookie, readSessionCookie } from '../auth/cookies';
import { dummyVerify, hashPassword, verifyPassword } from '../auth/password';
import { issueSession, validateSession } from '../auth/session';
import { createSessionStore, findUserByEmail, updatePasswordHash } from '../db/repos/users';
import { audit } from '../db/repos/audit';
import { randomId } from '../crypto/random';
import { error, json, noContent } from '../http/responses';
import { clientKey, rateLimit } from '../http/rate-limit';

export const authRoutes = new Hono<{ Bindings: Env }>();

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

authRoutes.post('/login', async (c) => {
  const env = c.env;
  const ctx = { secure: !isLocalDev(env) };
  const now = Math.floor(Date.now() / 1000);

  // Brute-force and CPU-exhaustion guard. PBKDF2 at 600k iterations is
  // expensive by design, which makes an unthrottled login endpoint a DoS
  // vector as well as a credential-stuffing target.
  const limit = await rateLimit(env.CACHE, `login:${clientKey(c.req.raw)}`, now, {
    limit: 10,
    windowSeconds: 600,
  });
  if (!limit.allowed) {
    return error(429, 'rate_limited', 'Too many attempts. Try again shortly.', ctx, {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }

  let body: LoginBody;
  try {
    body = await c.req.json<LoginBody>();
  } catch {
    return error(400, 'bad_request', 'Expected JSON.', ctx);
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return error(400, 'bad_request', 'Email and password are required.', ctx);
  }

  const user = await findUserByEmail(env.DB, email);

  if (!user) {
    // Burn comparable CPU so that "no such user" and "wrong password" are
    // indistinguishable by response time, not merely by response body.
    await dummyVerify();
    await audit(env.DB, {
      userId: null,
      action: 'login.failure',
      detail: { reason: 'unknown_user' },
      now,
    });
    return error(401, 'invalid_credentials', 'That email and password did not match.', ctx);
  }

  const verification = await verifyPassword(password, user.password_hash);
  if (!verification.valid) {
    await audit(env.DB, {
      userId: user.id,
      action: 'login.failure',
      detail: { reason: 'bad_password' },
      now,
    });
    return error(401, 'invalid_credentials', 'That email and password did not match.', ctx);
  }

  // Transparently upgrade a hash stored under weaker parameters.
  if (verification.needsRehash) {
    await updatePasswordHash(env.DB, user.id, await hashPassword(password), now);
  }

  const store = createSessionStore(env.DB);
  // Session FIXATION defence: any session presented on the login request is
  // revoked, and a brand-new token is minted. The token that ends up
  // authenticated is never one the caller chose.
  const presented = readSessionCookie(c.req.header('Cookie') ?? null, isLocalDev(env));
  if (presented) {
    const existing = await validateSession(store, presented, now);
    if (existing.ok) await store.revoke(existing.session.id, now);
  }

  const session = await issueSession(store, user.id, now, randomId());
  await audit(env.DB, {
    userId: user.id,
    action: 'login.success',
    subjectType: 'session',
    subjectId: session.id,
    now,
  });

  return json({ user: { userId: user.id, email: user.email } }, ctx, {
    headers: {
      'Set-Cookie': buildSessionCookie(session.token, {
        maxAgeSeconds: session.maxAgeSeconds,
        insecureForLocalDev: isLocalDev(env),
      }),
    },
  });
});

authRoutes.post('/logout', async (c) => {
  const env = c.env;
  const ctx = { secure: !isLocalDev(env) };
  const now = Math.floor(Date.now() / 1000);

  const token = readSessionCookie(c.req.header('Cookie') ?? null, isLocalDev(env));
  if (token) {
    const store = createSessionStore(env.DB);
    const result = await validateSession(store, token, now);
    if (result.ok) {
      await store.revoke(result.session.id, now);
      await audit(env.DB, {
        userId: result.session.userId,
        action: 'logout',
        subjectType: 'session',
        subjectId: result.session.id,
        now,
      });
    }
  }

  // Always clear the cookie, even when the session was already dead, so the
  // browser cannot keep presenting a stale token.
  return noContent(ctx, {
    headers: { 'Set-Cookie': buildClearCookie({ insecureForLocalDev: isLocalDev(env) }) },
  });
});
