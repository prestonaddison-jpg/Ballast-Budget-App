/**
 * Ballast Worker — the BFF.
 *
 * Serves the PWA shell (static assets) and the API from ONE origin, so the
 * session cookie is same-origin by construction and SameSite=Strict stays
 * viable.
 *
 * WORKER DISCIPLINE (§16), enforced by shape rather than by comment:
 *   - No request state at module scope. Everything per-request is built inside
 *     the handler and dies with it. Workers reuse isolates across requests, so
 *     a module-level mutable is a cross-request data leak — in this app, one
 *     entity's balances appearing under another's session.
 *   - All randomness and hashing is Web Crypto (see src/crypto).
 *   - Cloudflare bindings, never REST APIs, for D1/KV/R2/Queues.
 */

import { Hono } from 'hono';
import type { Env, SyncJob } from './env';
import { isLocalDev } from './env';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { webhookRoutes } from './routes/webhook';
import { csrfGuard, type AppVariables } from './http/middleware';
import { error, notFound } from './http/responses';
import { securityHeaders } from './http/security-headers';
import { createSessionStore } from './db/repos/users';
import { sweepRateLimits } from './http/rate-limit';

/**
 * Apply security headers to a static-asset response.
 *
 * The assets binding returns the file as-is, so without this the DOCUMENT —
 * the one response where CSP and anti-framing actually matter — would ship
 * with no Content-Security-Policy, no frame-ancestors and no HSTS, while the
 * JSON API responses (which a browser never renders) carried all of them.
 *
 * The Response from ASSETS is immutable, so it is rebuilt rather than mutated.
 */
function withSecurityHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders({ includeHsts: !isLocalDev(env) }))) {
    headers.set(key, value);
  }
  // The shell is content-hashed by the build, but index.html itself must not
  // be held by an intermediary — a stale shell pointing at deleted asset
  // hashes is a white screen the operator cannot refresh out of on iOS.
  const accept = response.headers.get('Content-Type') ?? '';
  if (accept.includes('text/html')) {
    headers.set('Cache-Control', 'no-cache');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * The webhook is mounted BEFORE the CSRF guard.
 *
 * Plaid is a server: it sends no Origin, no Sec-Fetch-Site, and no custom
 * header, so the browser-shaped CSRF check would reject every genuine
 * delivery. Its authorization is the ES256 signature over the raw body,
 * verified inside the route.
 */
app.route('/api/webhooks', webhookRoutes);

// Everything past here is browser traffic and must pass the CSRF check.
app.use('/api/*', csrfGuard);

app.route('/api/health', healthRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/me', meRoutes);

app.notFound((c) => notFound({ secure: !isLocalDev(c.env) }));

app.onError((err, c) => {
  // Log the detail; return none of it. An error body is a common source of
  // internal-path and dependency disclosure.
  console.error('unhandled_error', {
    message: err instanceof Error ? err.message : String(err),
    path: new URL(c.req.url).pathname,
  });
  return error(500, 'internal', 'Something went wrong.', { secure: !isLocalDev(c.env) });
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // API and webhooks are the Worker's. Everything else is the PWA shell,
    // served by the assets binding (with SPA fallback for deep links).
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request), env);
  },

  /**
   * Sync worker.
   *
   * Phase 0 ships the plumbing: the queue, the job shape, and the ack/retry
   * discipline. The transaction-applying body lands in Slice 1 with the money
   * model, because applying a sync page is meaningless without a ledger to
   * apply it to.
   */
  async queue(batch: MessageBatch<SyncJob>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        console.info('sync_job', {
          itemId: message.body.itemId,
          trigger: message.body.trigger,
          attempt: message.attempts,
        });
        // ACK ONLY AFTER the work is durably committed. Acking first marks the
        // message delivered even if the handler then throws, which loses it.
        message.ack();
      } catch (err) {
        console.error('sync_job_failed', {
          itemId: message.body.itemId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Retried with backoff; after max_retries it lands in the DLQ rather
        // than being silently discarded.
        message.retry({ delaySeconds: 30 });
      }
    }
  },

  /**
   * Cron.
   *
   * Two jobs: sweep dead sessions, and act as the safety net for a webhook
   * that never arrived. Webhooks are the real-time signal; cron is what stops
   * a missed one from turning into permanently stale data that the freshness
   * indicator would then have to report (§14).
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    // scheduledTime is epoch MILLISECONDS (a number, not a Date).
    console.info('cron', { cron: controller.cron, scheduledTime: controller.scheduledTime });

    ctx.waitUntil(
      (async () => {
        const removed = await createSessionStore(env.DB).deleteExpired(now);
        if (removed > 0) console.info('sessions_swept', { removed });

        // Elapsed fixed windows are dead weight; keep one extra window so an
        // in-flight request near a boundary still finds its row.
        const windows = await sweepRateLimits(env.DB, now - 3600);
        if (windows > 0) console.info('rate_limit_windows_swept', { windows });
      })(),
    );
  },
} satisfies ExportedHandler<Env, SyncJob>;
