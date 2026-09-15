/**
 * Webhook intake records — replay suppression and audit.
 */

import { randomId } from '../../crypto/random';

export interface WebhookRecordInput {
  provider: string;
  sourceItemId: string | null;
  webhookType: string | null;
  webhookCode: string | null;
  bodySha256: string;
  receivedAt: number;
}

export type WebhookIntake =
  | { accepted: true; id: string }
  /** The same body has already been recorded — a provider retry. */
  | { accepted: false; reason: 'duplicate' };

/**
 * Record a verified webhook, rejecting duplicates.
 *
 * The unique index on (provider, body_sha256) does the real work: the INSERT
 * either wins or is ignored, so two concurrent deliveries of the same retry
 * cannot both proceed. `meta.changes` tells us which happened — checking it is
 * the difference between deduplicating and merely hoping.
 */
export async function recordWebhook(
  db: D1Database,
  input: WebhookRecordInput,
): Promise<WebhookIntake> {
  const id = randomId();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO webhook_events
         (id, provider, source_item_id, webhook_type, webhook_code, body_sha256, received_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'received')`,
    )
    .bind(
      id,
      input.provider,
      input.sourceItemId,
      input.webhookType,
      input.webhookCode,
      input.bodySha256,
      input.receivedAt,
    )
    .run();

  if ((result.meta.changes ?? 0) === 0) return { accepted: false, reason: 'duplicate' };
  return { accepted: true, id };
}

export async function markWebhookProcessed(
  db: D1Database,
  id: string,
  status: 'processed' | 'ignored' | 'failed',
  now: number,
  errorDetail?: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE webhook_events SET status = ?, processed_at = ?, error_detail = ? WHERE id = ?',
    )
    .bind(status, now, errorDetail ?? null, id)
    .run();
}
