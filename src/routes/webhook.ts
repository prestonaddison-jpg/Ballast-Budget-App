/**
 * Plaid webhook intake.
 *
 * This route is PUBLIC and UNAUTHENTICATED in the session sense — Cloudflare
 * Access was dropped precisely because it blocked these callbacks (§15). The
 * JWT signature is the authorization, and it is checked before the body is
 * parsed, let alone acted on.
 *
 * It is also deliberately NOT behind the CSRF guard: Plaid is a server, has no
 * Origin header, and cannot set a custom request header. Applying the browser
 * CSRF check here would reject every real webhook.
 *
 * SHAPE OF THE HANDLER:
 *   1. Read the raw body ONCE. It is a stream; consuming it twice throws, and
 *      re-serializing a parsed object changes the bytes the digest covers.
 *   2. Verify. On failure, log and return 4xx without touching the database.
 *   3. Deduplicate on the body digest — Plaid retries.
 *   4. Enqueue the real work and return 200 FAST. A slow webhook endpoint gets
 *      retried, which multiplies load exactly when the system is struggling.
 */

import { Hono } from 'hono';
import type { Env, SyncJob } from '../env';
import { isLocalDev } from '../env';
import { json, error } from '../http/responses';
import { PlaidClient, type PlaidEnvironment } from '../ledger-source/plaid/client';
import { PlaidLedgerSource } from '../ledger-source/plaid/source';
import { markWebhookProcessed, recordWebhook, releaseWebhookIntake } from '../db/repos/webhooks';
import { findItemByProviderId, updateItemStatus } from '../db/repos/connections';
import { audit } from '../db/repos/audit';
import { LedgerSourceError } from '../ledger-source/types';
import { WebhookVerificationError } from '../ledger-source/plaid/webhook-verify';
import { clientKey, rateLimit } from '../http/rate-limit';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post('/plaid', async (c) => {
  const env = c.env;
  const ctx = { secure: !isLocalDev(env) };
  const now = Math.floor(Date.now() / 1000);

  // 0. Rate limit. This route is public and unauthenticated, and verification
  //    costs a KV read plus (on a cache miss) an outbound call to Plaid. The
  //    limit is generous relative to real Plaid traffic but bounds how much an
  //    anonymous caller can make this Worker do.
  const limit = await rateLimit(env.DB, `webhook:${clientKey(c.req.raw)}`, now, {
    limit: 120,
    windowSeconds: 60,
  });
  if (!limit.allowed) {
    return error(429, 'rate_limited', 'Too many requests.', ctx, {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }

  // 1. Raw bytes, read exactly once.
  const rawBody = await c.req.arrayBuffer();

  const source = new PlaidLedgerSource({
    client: new PlaidClient({
      clientId: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      environment: (env.PLAID_ENV as PlaidEnvironment) ?? 'sandbox',
    }),
    jwkCache: env.CACHE,
    // No transactions are mapped on this path, so the resolver is never
    // consulted; the sync job loads real keys from D1 when it runs.
    resolveTxnKey: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  });

  // 2. Verify before anything else.
  let event;
  try {
    event = await source.verifyWebhook(rawBody, c.req.raw.headers);
  } catch (err) {
    const reason = err instanceof LedgerSourceError ? err.message : 'verification failed';

    // A VERIFICATION failure is an authorization failure: 401, and Plaid
    // should not retry a webhook we will never accept.
    //
    // A RETRYABLE failure is different in kind. If fetching the signing key
    // fails because Plaid itself is down, the webhook may well be perfectly
    // valid — returning 401 there would tell Plaid to stop, and a legitimate
    // sync notification would be lost permanently. Those get a 500 so the
    // provider's own retry machinery does its job.
    const retryable = err instanceof LedgerSourceError && err.retryable;
    if (retryable && !(err instanceof WebhookVerificationError)) {
      console.error('plaid_webhook_verify_unavailable', { reason });
      return error(503, 'unavailable', 'Could not verify right now.', ctx);
    }

    console.warn('plaid_webhook_rejected', { reason });
    await audit(env.DB, { userId: null, action: 'webhook.rejected', detail: { reason }, now });
    return error(401, 'unauthorized', 'Invalid signature.', ctx);
  }

  if (event.kind === 'ignored') {
    // 200 so Plaid stops retrying something we intentionally do not handle.
    return json({ ok: true, handled: false }, ctx);
  }

  // 3. Deduplicate on the SIGNED DELIVERY, not the body. Plaid retries, and a
  //    retry re-sends the same JWT — while two genuinely different sync
  //    events have byte-identical bodies and must both be processed.
  const intake = await recordWebhook(env.DB, {
    provider: 'plaid',
    sourceItemId: 'sourceItemId' in event ? event.sourceItemId : null,
    webhookType: null,
    webhookCode: event.kind,
    deliveryDigest: event.deliveryDigest,
    bodySha256: event.bodyDigest,
    receivedAt: now,
  });
  if (!intake.accepted) {
    return json({ ok: true, handled: false, duplicate: true }, ctx);
  }

  const sourceItemId = 'sourceItemId' in event ? event.sourceItemId : null;
  const item = sourceItemId ? await findItemByProviderId(env.DB, 'plaid', sourceItemId) : null;

  if (!item) {
    // A webhook for an Item we do not have. Acknowledge so Plaid stops, but
    // record it — this is what an item removed on one side and not the other
    // looks like.
    await markWebhookProcessed(env.DB, intake.id, 'ignored', now, 'unknown item');
    return json({ ok: true, handled: false }, ctx);
  }

  // 4. Act. Anything slow goes on the queue.
  try {
    switch (event.kind) {
      case 'sync_available': {
        const job: SyncJob = { itemId: item.id, userId: item.user_id, trigger: 'webhook' };
        await env.SYNC_QUEUE.send(job);
        break;
      }
      case 'recurring_updated': {
        // Slice 4 consumes this to propose obligations. Recorded now so the
        // signal is not silently dropped in the meantime.
        break;
      }
      case 'reauth_required':
        await updateItemStatus(env.DB, item.id, 'reauth_required', now, 'ITEM_LOGIN_REQUIRED');
        await audit(env.DB, {
          userId: item.user_id,
          action: 'item.reauth_required',
          subjectType: 'source_item',
          subjectId: item.id,
          now,
        });
        break;
      case 'pending_disconnect':
        await updateItemStatus(env.DB, item.id, 'pending_disconnect', now, null);
        break;
      case 'user_revoked':
        await updateItemStatus(env.DB, item.id, 'revoked_by_user', now, null);
        break;
      case 'connection_repaired':
        await updateItemStatus(env.DB, item.id, 'ok', now, null);
        break;
      case 'accounts_available':
        // Surfaced to the operator in a later slice; no state change.
        break;
      case 'error':
        await updateItemStatus(env.DB, item.id, item.status, now, event.code);
        break;
    }

    await markWebhookProcessed(env.DB, intake.id, 'processed', now);
    return json({ ok: true, handled: true }, ctx);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown';
    console.error('plaid_webhook_failed', { itemId: item.id, detail });

    // Record what happened, then RELEASE the intake row. The 500 below asks
    // Plaid to retry; without the release, the unique index would reject that
    // retry as a duplicate and the webhook would be lost forever having
    // explicitly asked to be resent.
    await audit(env.DB, {
      userId: item.user_id,
      action: 'webhook.rejected',
      subjectType: 'source_item',
      subjectId: item.id,
      detail: { stage: 'processing', reason: detail },
      now,
    });
    await releaseWebhookIntake(env.DB, intake.id);

    // 500 so Plaid DOES retry — the signature was valid and the work is owed.
    return error(500, 'internal', 'Could not process webhook.', ctx);
  }
});
