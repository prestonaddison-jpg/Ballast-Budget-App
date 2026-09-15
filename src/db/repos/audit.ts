/**
 * Append-only audit log.
 *
 * RULE: `detail` must never carry a secret — no tokens, no password material,
 * no full account numbers. The log exists to answer "what happened", not to
 * become a second copy of the data it describes.
 */

import { randomId } from '../../crypto/random';

export type AuditAction =
  | 'login.success'
  | 'login.failure'
  | 'logout'
  | 'session.revoked'
  | 'envelope.transfer'
  | 'envelope.completed'
  | 'item.linked'
  | 'item.reauth_required'
  | 'item.removed'
  | 'webhook.received'
  | 'webhook.rejected'
  | 'sync.completed'
  | 'sync.failed';

export async function audit(
  db: D1Database,
  entry: {
    userId: string | null;
    action: AuditAction;
    subjectType?: string;
    subjectId?: string;
    detail?: Record<string, unknown>;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, user_id, action, subject_type, subject_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      randomId(),
      entry.userId,
      entry.action,
      entry.subjectType ?? null,
      entry.subjectId ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
      entry.now,
    )
    .run();
}
