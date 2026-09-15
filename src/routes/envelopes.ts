/**
 * Envelope + transfer routes (Slice 1).
 *
 * Every route is scoped to the authenticated user AND an entity taken from the
 * path, and the entity is re-verified as belonging to that user on each
 * request. An entity id from the URL is caller-supplied data, so trusting it
 * would be exactly the BOLA failure §16 names as the #1 API risk.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import { isLocalDev } from '../env';
import type { AppVariables } from '../http/middleware';
import { requireSession } from '../http/middleware';
import { error, json } from '../http/responses';
import {
  completeEnvelope,
  createEnvelope,
  findUnallocated,
  listEnvelopesWithBalances,
  transfer,
} from '../money/ledger';
import { ENVELOPE_TYPES, MoneyError, type EnvelopeType } from '../money/types';
import { checkInvariant, safeToSpend } from '../money/invariant';
import { audit } from '../db/repos/audit';

export const envelopeRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

envelopeRoutes.use('*', requireSession);

/** Confirms the entity in the path belongs to the session's user. */
async function ownsEntity(db: D1Database, userId: string, entityId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM entities WHERE id = ? AND user_id = ? AND archived_at IS NULL')
    .bind(entityId, userId)
    .first<{ ok: number }>();
  return row != null;
}

interface AccountCashRow {
  id: string;
  available_minor: number | null;
  budgetable: number;
}

envelopeRoutes.get('/:entityId/envelopes', async (c) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const session = c.get('session');
  const entityId = c.req.param('entityId');

  if (!(await ownsEntity(c.env.DB, session.userId, entityId))) {
    // 404 rather than 403: whether an entity exists is itself information.
    return error(404, 'not_found', 'Not found.', ctx);
  }

  const envelopes = await listEnvelopesWithBalances(c.env.DB, session.userId, entityId);

  const { results: accounts } = await c.env.DB.prepare(
    `SELECT id, available_minor, budgetable FROM source_accounts
      WHERE user_id = ? AND entity_id = ? AND closed_at IS NULL`,
  )
    .bind(session.userId, entityId)
    .all<AccountCashRow>();

  const check = checkInvariant(
    // Unallocated is the residual, so including it here would double-count the
    // cash it already represents. The invariant compares NAMED claims + the
    // residual against cash, which is exactly the full envelope list.
    envelopes.map((e) => ({ balanceMinor: e.balance_minor ?? 0 })),
    (accounts ?? []).map((a) => ({
      accountId: a.id,
      availableMinor: a.available_minor,
      budgetable: a.budgetable === 1,
    })),
  );

  const unallocated = envelopes.find((e) => e.type === 'unallocated');
  const unallocatedBalance = unallocated?.balance_minor ?? null;

  return json(
    {
      entityId,
      envelopes: envelopes.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        balanceMinor: e.balance_minor,
        targetMinor: e.target_minor,
        targetDate: e.target_date,
        zone: e.zone,
      })),
      // NULL, not 0, when the bank has not reported an available balance. The
      // UI must say "we don't know", never a confident figure (§14).
      safeToSpendMinor: unallocatedBalance == null ? null : safeToSpend(check, unallocatedBalance),
      // Surfaced so the Canvas can show "over-allocated by $X" honestly rather
      // than hiding a negative residual behind a floor of zero.
      overAllocatedMinor:
        unallocatedBalance != null && unallocatedBalance < 0 ? -unallocatedBalance : 0,
      invariant: check.status,
    },
    ctx,
  );
});

interface CreateBody {
  name?: unknown;
  type?: unknown;
  targetMinor?: unknown;
  targetDate?: unknown;
  zone?: unknown;
}

envelopeRoutes.post('/:entityId/envelopes', async (c) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const session = c.get('session');
  const entityId = c.req.param('entityId');
  const now = Math.floor(Date.now() / 1000);

  if (!(await ownsEntity(c.env.DB, session.userId, entityId))) {
    return error(404, 'not_found', 'Not found.', ctx);
  }

  let body: CreateBody;
  try {
    body = await c.req.json<CreateBody>();
  } catch {
    return error(400, 'bad_request', 'Expected JSON.', ctx);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const type = body.type as EnvelopeType;
  if (!name || name.length > 80) {
    return error(400, 'bad_request', 'A name is required.', ctx);
  }
  if (!ENVELOPE_TYPES.includes(type)) {
    return error(400, 'bad_request', 'Unknown envelope type.', ctx);
  }
  if (type === 'unallocated') {
    // The residual is defined in terms of "the entity's unallocated"; a second
    // one would make the definition — and therefore the invariant — ambiguous.
    return error(400, 'bad_request', 'Unallocated is created with the entity.', ctx);
  }

  const targetMinor =
    body.targetMinor == null
      ? null
      : Number.isInteger(body.targetMinor) && (body.targetMinor as number) > 0
        ? (body.targetMinor as number)
        : undefined;
  if (targetMinor === undefined) {
    return error(400, 'bad_request', 'A target must be a positive whole number of cents.', ctx);
  }

  const { id } = await createEnvelope(c.env.DB, {
    userId: session.userId,
    entityId,
    name,
    type,
    targetMinor,
    targetDate: typeof body.targetDate === 'string' ? body.targetDate : null,
    zone: typeof body.zone === 'string' ? body.zone : null,
    now,
  });

  return json({ id }, ctx, { status: 201 });
});

interface TransferBody {
  fromEnvelopeId?: unknown;
  toEnvelopeId?: unknown;
  amountMinor?: unknown;
  memo?: unknown;
  idempotencyKey?: unknown;
}

/** Tap-to-fund and moveBetween are the same operation with different ends. */
envelopeRoutes.post('/:entityId/transfers', async (c) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const session = c.get('session');
  const entityId = c.req.param('entityId');
  const now = Math.floor(Date.now() / 1000);

  if (!(await ownsEntity(c.env.DB, session.userId, entityId))) {
    return error(404, 'not_found', 'Not found.', ctx);
  }

  let body: TransferBody;
  try {
    body = await c.req.json<TransferBody>();
  } catch {
    return error(400, 'bad_request', 'Expected JSON.', ctx);
  }

  const fromEnvelopeId = typeof body.fromEnvelopeId === 'string' ? body.fromEnvelopeId : '';
  const toEnvelopeId = typeof body.toEnvelopeId === 'string' ? body.toEnvelopeId : '';
  const amountMinor = body.amountMinor;

  if (!fromEnvelopeId || !toEnvelopeId) {
    return error(400, 'bad_request', 'Both envelopes are required.', ctx);
  }
  if (!Number.isInteger(amountMinor) || (amountMinor as number) <= 0) {
    return error(400, 'bad_request', 'Amount must be a positive whole number of cents.', ctx);
  }

  try {
    const result = await transfer(c.env.DB, {
      userId: session.userId,
      entityId,
      fromEnvelopeId,
      toEnvelopeId,
      amountMinor: amountMinor as number,
      // The source being unallocated is what makes it a "fund" rather than a
      // "move"; both are the same guarded statement underneath.
      kind: 'fund',
      memo: typeof body.memo === 'string' ? body.memo.slice(0, 200) : null,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
      now,
    });

    if (result.ok) {
      await audit(c.env.DB, {
        userId: session.userId,
        action: 'envelope.transfer',
        subjectType: 'ledger_entry',
        subjectId: result.entryId,
        detail: { entityId, amountMinor },
        now,
      });
      return json({ entryId: result.entryId }, ctx, { status: 201 });
    }

    if (result.reason === 'duplicate') {
      // A retry of a request that already succeeded. Not an error: report it
      // as a no-op so the client stops retrying.
      return json({ duplicate: true }, ctx, { status: 200 });
    }
    if (result.reason === 'insufficient_funds') {
      return error(409, 'insufficient_funds', 'That envelope does not have enough to move.', ctx);
    }
    return error(400, 'rejected', 'That transfer is not allowed.', ctx);
  } catch (err) {
    if (err instanceof MoneyError) {
      return error(400, err.code, err.message, ctx);
    }
    throw err;
  }
});

/** completeEnvelope (§12): sweep the remainder to unallocated and archive. */
envelopeRoutes.post('/:entityId/envelopes/:envelopeId/complete', async (c) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const session = c.get('session');
  const entityId = c.req.param('entityId');
  const envelopeId = c.req.param('envelopeId');
  const now = Math.floor(Date.now() / 1000);

  if (!(await ownsEntity(c.env.DB, session.userId, entityId))) {
    return error(404, 'not_found', 'Not found.', ctx);
  }

  const unallocated = await findUnallocated(c.env.DB, session.userId, entityId);
  if (!unallocated) {
    return error(409, 'no_unallocated', 'This entity has no unallocated envelope.', ctx);
  }

  try {
    const result = await completeEnvelope(c.env.DB, {
      userId: session.userId,
      entityId,
      envelopeId,
      unallocatedId: unallocated.id,
      now,
    });
    if (!result.ok) {
      // The balance moved under us mid-sweep. Leaving the envelope open is the
      // safe outcome: archiving it would hide money that still exists.
      return error(409, 'conflict', 'That envelope changed. Try again.', ctx);
    }
    return json({ sweptMinor: result.sweptMinor }, ctx);
  } catch (err) {
    if (err instanceof MoneyError) {
      return error(400, err.code, err.message, ctx);
    }
    throw err;
  }
});
