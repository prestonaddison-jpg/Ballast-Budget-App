/**
 * Response helpers.
 *
 * Every JSON response carries the security headers and, for anything derived
 * from account data, no-store. The helpers exist so that "add the headers" is
 * not a thing a route author has to remember.
 */

import { noStoreHeaders, securityHeaders } from './security-headers';

export interface ResponseContext {
  /** false in local http:// dev, where HSTS is wrong. */
  secure: boolean;
}

export function json(body: unknown, ctx: ResponseContext, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...securityHeaders({ includeHsts: ctx.secure }),
      ...noStoreHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export function noContent(ctx: ResponseContext, init: ResponseInit = {}): Response {
  return new Response(null, {
    ...init,
    status: 204,
    headers: {
      ...securityHeaders({ includeHsts: ctx.secure }),
      ...noStoreHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

/**
 * Error response.
 *
 * `message` is shown to the operator, so it must never leak why a credential
 * failed, whether an account exists, or any internal detail. Diagnostics go to
 * the audit log and to console, not into the body.
 */
export function error(
  status: number,
  code: string,
  message: string,
  ctx: ResponseContext,
  extraHeaders?: Record<string, string>,
): Response {
  return json({ code, message } satisfies ApiErrorBody, ctx, { status, headers: extraHeaders });
}

export const unauthorized = (ctx: ResponseContext) =>
  // Deliberately flat: never distinguish missing / expired / revoked to the
  // client. The reason is logged, not returned.
  error(401, 'unauthorized', 'Sign in to continue.', ctx);

export const forbidden = (ctx: ResponseContext) => error(403, 'forbidden', 'Not allowed.', ctx);

export const notFound = (ctx: ResponseContext) => error(404, 'not_found', 'Not found.', ctx);
