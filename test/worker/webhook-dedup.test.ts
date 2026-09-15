import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { markWebhookProcessed, recordWebhook } from '../../src/db/repos/webhooks';

const NOW = 1_800_000_000;

const base = (deliveryDigest: string, bodySha256: string) => ({
  provider: 'plaid',
  sourceItemId: 'item_1',
  webhookType: 'TRANSACTIONS',
  webhookCode: 'sync_available',
  deliveryDigest,
  bodySha256,
  receivedAt: NOW,
});

describe('webhook replay suppression', () => {
  it('accepts a delivery once and rejects the identical retry', async () => {
    const delivery = crypto.randomUUID();
    const first = await recordWebhook(env.DB, base(delivery, 'body-a'));
    expect(first.accepted).toBe(true);

    const retry = await recordWebhook(env.DB, base(delivery, 'body-a'));
    expect(retry.accepted).toBe(false);
  });

  it('accepts two DIFFERENT deliveries that share an identical body', async () => {
    // THE bug this design exists to prevent. A Plaid SYNC_UPDATES_AVAILABLE
    // body carries no nonce and no timestamp, so two genuinely different sync
    // events for the same Item are byte-identical. Keying dedup on the body
    // would swallow every sync notification after the first, permanently, and
    // Ballast would silently stop seeing new deposits.
    const sharedBody = 'identical-body-digest';
    const first = await recordWebhook(env.DB, base(crypto.randomUUID(), sharedBody));
    const second = await recordWebhook(env.DB, base(crypto.randomUUID(), sharedBody));

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
  });

  it('survives a concurrent double delivery of the same retry', async () => {
    const delivery = crypto.randomUUID();
    const results = await Promise.all([
      recordWebhook(env.DB, base(delivery, 'b')),
      recordWebhook(env.DB, base(delivery, 'b')),
      recordWebhook(env.DB, base(delivery, 'b')),
    ]);
    // Exactly one may proceed; the unique index, not a read-then-write, is
    // what guarantees it.
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
  });

  it('records the outcome of processing', async () => {
    const delivery = crypto.randomUUID();
    const intake = await recordWebhook(env.DB, base(delivery, 'c'));
    expect(intake.accepted).toBe(true);
    if (!intake.accepted) return;

    await markWebhookProcessed(env.DB, intake.id, 'processed', NOW + 1);
    const row = await env.DB.prepare('SELECT status, processed_at FROM webhook_events WHERE id = ?')
      .bind(intake.id)
      .first<{ status: string; processed_at: number }>();
    expect(row?.status).toBe('processed');
    expect(row?.processed_at).toBe(NOW + 1);
  });
});
