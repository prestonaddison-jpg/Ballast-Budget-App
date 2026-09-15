/**
 * Request middleware.
 *
 * WORKER DISCIPLINE (§16): nothing here caches request state at module scope.
 * Workers reuse an isolate across requests, so a module-level `currentUser`
 * would leak one operator's session into another's request. All per-request
 * state lives in Hono's context, which is created per request.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { isLocalDev } from '../env';
import { readSessionCookie } from '../auth/cookies';
import { validateSession, type ActiveSession } from '../auth/session';
import { createSessionStore } from '../db/repos/users';
import { checkCsrf } from './csrf';
import { error, unauthorized } from './responses';

export interface AppVariables {
  session: ActiveSession;
}

export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

/** Reject cross-site state-changing requests before they touch any handler. */
export const csrfGuard: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (
  c,
  next,
) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const result = checkCsrf(c.req.raw, c.env.APP_ORIGIN);
  if (!result.ok) {
    console.warn('csrf_rejected', { reason: result.reason, path: new URL(c.req.url).pathname });
    return error(403, 'forbidden', 'Request blocked.', ctx);
  }
  await next();
};

/** Require a valid session; attaches it to the context. */
export const requireSession: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (
  c,
  next,
) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const now = Math.floor(Date.now() / 1000);

  const token = readSessionCookie(c.req.header('Cookie') ?? null, isLocalDev(c.env));
  const result = await validateSession(createSessionStore(c.env.DB), token, now);

  if (!result.ok) {
    // The reason is logged for operations; the client always sees a flat 401.
    console.info('session_rejected', { reason: result.reason });
    return unauthorized(ctx);
  }

  c.set('session', result.session);
  await next();
};
