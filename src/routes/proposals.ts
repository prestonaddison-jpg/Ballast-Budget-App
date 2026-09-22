/**
 * Proposal routes — the Needs You queue (Blueprint §4).
 *
 * Same BOLA discipline as envelopes.ts: every route is scoped to the session's
 * user AND an entity taken from the path, and the entity is re-verified on
 * each request because an id in a URL is caller-supplied data.
 *
 * One thing here is deliberate and worth reading twice. The queue endpoint
 * returns `affordableNow` alongside each proposal, computed from the live
 * source balance. It is NOT a permission — approveProposal re-checks the
 * balance inside the statement that commits, and that check is the only one
 * that decides anything. This flag exists so the operator can be told "this no
 * longer fits" BEFORE they tap, instead of tapping and being refused. A screen
 * that offers an action it will then reject teaches people to distrust it.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import { isLocalDev } from '../env';
import type { AppVariables } from '../http/middleware';
import { requireSession } from '../http/middleware';
import { error, json } from '../http/responses';
import {
  approveProposal,
  dismissProposal,
  listPendingProposals,
  type ProposalRow,
} from '../money/proposals';
import { audit } from '../db/repos/audit';

export const proposalRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

proposalRoutes.use('*', requireSession);

async function ownsEntity(db: D1Database, userId: string, entityId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM entities WHERE id = ? AND user_id = ? AND archived_at IS NULL')
    .bind(entityId, userId)
    .first<{ ok: number }>();
  return row != null;
}

interface EnvelopeLabel {
  id: string;
  name: string;
  type: string;
  balance_minor: number | null;
}

/** Every envelope of one entity, by id, with its live balance. */
async function labelsFor(
  db: D1Database,
  userId: string,
  entityId: string,
): Promise<Map<string, EnvelopeLabel>> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.name, e.type, b.balance_minor
         FROM envelopes e
         JOIN envelope_balances b ON b.envelope_id = e.id
        WHERE e.user_id = ? AND e.entity_id = ?`,
    )
    .bind(userId, entityId)
    .all<EnvelopeLabel>();
  return new Map((results ?? []).map((r) => [r.id, r]));
}

function present(row: ProposalRow, labels: Map<string, EnvelopeLabel>) {
  const from = labels.get(row.from_envelope_id);
  const to = labels.get(row.to_envelope_id);
  const sourceBalance = from?.balance_minor ?? null;

  return {
    id: row.id,
    kind: row.kind,
    amountMinor: row.amount_minor,
    memo: row.memo,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    from: { id: row.from_envelope_id, name: from?.name ?? null, type: from?.type ?? null },
    to: { id: row.to_envelope_id, name: to?.name ?? null, type: to?.type ?? null },
    // NULL source balance means the bank has reported nothing. Not affordable
    // and not unaffordable — UNKNOWN, and the UI must say so rather than pick
    // one. `?? 0` here would be the exact bug CLAUDE.md names.
    sourceBalanceMinor: sourceBalance,
    affordableNow: sourceBalance == null ? null : sourceBalance >= row.amount_minor,
  };
}

proposalRoutes.get('/:entityId/proposals', async (c) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const session = c.get('session');
  const entityId = c.req.param('entityId');
  const now = Math.floor(Date.now() / 1000);

  if (!(await ownsEntity(c.env.DB, session.userId, entityId))) {
    return error(404, 'not_found', 'Not found.', ctx);
  }

  const [rows, labels] = await Promise.all([
    listPendingProposals(c.env.DB, session.userId, entityId, now),
    labelsFor(c.env.DB, session.userId, entityId),
  ]);

  return json({ entityId, proposals: rows.map((r) => present(r, labels)) }, ctx);
});

proposalRoutes.post('/:entityId/proposals/:proposalId/approve', async (c) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const session = c.get('session');
  const entityId = c.req.param('entityId');
  const proposalId = c.req.param('proposalId');
  const now = Math.floor(Date.now() / 1000);

  if (!(await ownsEntity(c.env.DB, session.userId, entityId))) {
    return error(404, 'not_found', 'Not found.', ctx);
  }

  const result = await approveProposal(c.env.DB, { userId: session.userId, proposalId, now });

  if (result.ok) {
    await audit(c.env.DB, {
      userId: session.userId,
      action: 'proposal.approve',
      subjectType: 'proposal',
      subjectId: proposalId,
      detail: { entityId, amountMinor: result.amountMinor, entryId: result.entryId },
      now,
    });
    return json({ entryId: result.entryId, amountMinor: result.amountMinor }, ctx, { status: 201 });
  }

  switch (result.reason) {
    case 'not_found':
      return error(404, 'not_found', 'Not found.', ctx);
    case 'not_pending':
      // Already decided. Almost always a retry or a second tap, so it is
      // reported as a conflict rather than dressed up as a failure.
      return error(409, 'not_pending', 'That was already decided.', ctx);
    case 'expired':
      return error(409, 'expired', 'That suggestion is out of date. Sync and try again.', ctx);
    case 'insufficient_funds':
      return error(
        409,
        'insufficient_funds',
        'That no longer fits — the balance moved since this was suggested.',
        ctx,
      );
    default:
      return error(409, 'rejected', 'That cannot be approved right now.', ctx);
  }
});

proposalRoutes.post('/:entityId/proposals/:proposalId/dismiss', async (c) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const session = c.get('session');
  const entityId = c.req.param('entityId');
  const proposalId = c.req.param('proposalId');
  const now = Math.floor(Date.now() / 1000);

  if (!(await ownsEntity(c.env.DB, session.userId, entityId))) {
    return error(404, 'not_found', 'Not found.', ctx);
  }

  const { ok } = await dismissProposal(c.env.DB, { userId: session.userId, proposalId, now });
  if (!ok) {
    return error(409, 'not_pending', 'That was already decided.', ctx);
  }

  await audit(c.env.DB, {
    userId: session.userId,
    action: 'proposal.dismiss',
    subjectType: 'proposal',
    subjectId: proposalId,
    detail: { entityId },
    now,
  });
  return json({ dismissed: true }, ctx);
});
