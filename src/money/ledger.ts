/**
 * Ledger writes and balance reads.
 *
 * THE ONE IMPORTANT FUNCTION IS `transfer`. Everything else is a thin wrapper
 * around it — fundEnvelope, moveBetween and the completeEnvelope sweep are the
 * same statement with different endpoints and a different `kind`.
 *
 * WHY IT IS SHAPED LIKE THIS. D1 has no interactive transactions, so this is
 * NOT safe:
 *
 *     const balance = await readBalance(from);   // <-- window opens here
 *     if (balance >= amount) await insertEntry(...);   // <-- and closes here
 *
 * Two concurrent requests both read the old balance, both pass the check, and
 * the envelope is overdrawn — money allocated twice. The fix is to fold the
 * check INTO the write so there is no window at all:
 *
 *     INSERT INTO ledger_entries (...)
 *     SELECT ... WHERE (SELECT balance ...) >= amount
 *
 * A single SQL statement is atomic. `meta.changes` then tells us whether it
 * applied. test/worker/d1-atomic-guard.test.ts and
 * test/worker/residual-design.test.ts both pin this behaviour, the second one
 * specifically for a source whose balance is the computed residual.
 */

import { randomId } from '../crypto/random';
import { MoneyError, type EntryKind, type EnvelopeType, type Minor } from './types';

export interface EnvelopeRow {
  id: string;
  user_id: string;
  entity_id: string;
  name: string;
  type: EnvelopeType;
  target_minor: number | null;
  target_date: string | null;
  zone: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  completed_at: number | null;
}

export interface EnvelopeWithBalanceRow extends EnvelopeRow {
  /** NULL when the bank has not reported an available balance (unallocated). */
  balance_minor: number | null;
}

/**
 * Every read is scoped to the authenticated user AND the entity. BOLA is the
 * #1 API risk (§16), and per-entity scoping is also what stops one entity's
 * envelopes appearing under another's roll-up.
 */
export async function listEnvelopesWithBalances(
  db: D1Database,
  userId: string,
  entityId: string,
): Promise<EnvelopeWithBalanceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.*, b.balance_minor
         FROM envelopes e
         JOIN envelope_balances b ON b.envelope_id = e.id
        WHERE e.user_id = ?1 AND e.entity_id = ?2 AND e.archived_at IS NULL
        ORDER BY e.sort_order, e.name`,
    )
    .bind(userId, entityId)
    .all<EnvelopeWithBalanceRow>();
  return results ?? [];
}

export async function findEnvelope(
  db: D1Database,
  userId: string,
  envelopeId: string,
): Promise<EnvelopeWithBalanceRow | null> {
  // Ownership is part of the lookup, never a follow-up check that a call site
  // can forget.
  return db
    .prepare(
      `SELECT e.*, b.balance_minor
         FROM envelopes e
         JOIN envelope_balances b ON b.envelope_id = e.id
        WHERE e.id = ?1 AND e.user_id = ?2`,
    )
    .bind(envelopeId, userId)
    .first<EnvelopeWithBalanceRow>();
}

export interface TransferInput {
  userId: string;
  entityId: string;
  fromEnvelopeId: string;
  toEnvelopeId: string;
  amountMinor: Minor;
  kind: EntryKind;
  memo?: string | null;
  txnKey?: string | null;
  /** Supply to make a retry a no-op rather than a second allocation. */
  idempotencyKey?: string | null;
  now: number;
}

export type TransferResult =
  | { ok: true; entryId: string }
  | { ok: false; reason: 'insufficient_funds' | 'duplicate' | 'rejected' };

/**
 * Move money between two envelopes of one entity, atomically.
 *
 * The guard covers, in a single statement:
 *   - the amount is positive;
 *   - both envelopes exist, belong to this user AND this entity, and are not
 *     archived;
 *   - the source balance covers the amount.
 *
 * NOTE THE NULL SEMANTICS. `balance_minor` is NULL for unallocated when a
 * budgetable account has not reported an available balance. `NULL >= ?` is
 * NULL, which is not true, so the INSERT does not fire — nothing can be
 * allocated out of a balance nobody knows. That is the intended behaviour and
 * it falls out of SQL's three-valued logic rather than needing a branch.
 */
export async function transfer(db: D1Database, input: TransferInput): Promise<TransferResult> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new MoneyError('invalid_amount', 'Amount must be a positive whole number of cents.');
  }
  if (input.fromEnvelopeId === input.toEnvelopeId) {
    throw new MoneyError('same_envelope', 'Cannot transfer an envelope to itself.');
  }

  const entryId = randomId();

  const result = await db
    .prepare(
      `INSERT INTO ledger_entries
         (id, user_id, entity_id, from_envelope_id, to_envelope_id,
          amount_minor, kind, txn_key, idempotency_key, memo, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
        WHERE ?6 > 0
          -- Source must exist, be this user's, be in THIS entity, and be live.
          AND EXISTS (SELECT 1 FROM envelopes s
                       WHERE s.id = ?4 AND s.user_id = ?2 AND s.entity_id = ?3
                         AND s.archived_at IS NULL)
          -- Destination likewise. Same-entity on both sides is the structural
          -- no-commingling rule, checked here as well as by composite FK so
          -- the failure is a clean "rejected" rather than an FK error.
          AND EXISTS (SELECT 1 FROM envelopes d
                       WHERE d.id = ?5 AND d.user_id = ?2 AND d.entity_id = ?3
                         AND d.archived_at IS NULL)
          -- THE GUARD. Reads the source balance INSIDE the write, so there is
          -- no window. NULL (unknown cash) fails this comparison, by design.
          AND (SELECT b.balance_minor FROM envelope_balances b
                WHERE b.envelope_id = ?4) >= ?6`,
    )
    .bind(
      entryId,
      input.userId,
      input.entityId,
      input.fromEnvelopeId,
      input.toEnvelopeId,
      input.amountMinor,
      input.kind,
      input.txnKey ?? null,
      input.idempotencyKey ?? null,
      input.memo ?? null,
      input.now,
    )
    .run()
    .catch((err: unknown) => {
      // The unique index on (user_id, idempotency_key) turns a retry into a
      // constraint error rather than a second allocation.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE') && message.includes('idempotency')) return null;
      throw err;
    });

  if (result === null) return { ok: false, reason: 'duplicate' };
  if ((result.meta.changes ?? 0) === 1) return { ok: true, entryId };

  // changes === 0 means a guard clause was false. Distinguish the common,
  // explainable case (not enough money) from a malformed request, so the UI
  // can say something true.
  const source = await db
    .prepare('SELECT b.balance_minor FROM envelope_balances b WHERE b.envelope_id = ?')
    .bind(input.fromEnvelopeId)
    .first<{ balance_minor: number | null }>();

  if (source && source.balance_minor != null && source.balance_minor < input.amountMinor) {
    return { ok: false, reason: 'insufficient_funds' };
  }
  return { ok: false, reason: 'rejected' };
}

/** Tap-to-fund: unallocated -> a purpose envelope (§13). */
export async function fundEnvelope(
  db: D1Database,
  input: Omit<TransferInput, 'kind' | 'fromEnvelopeId'> & { unallocatedId: string },
): Promise<TransferResult> {
  return transfer(db, { ...input, fromEnvelopeId: input.unallocatedId, kind: 'fund' });
}

/** moveBetween: any envelope -> any other envelope in the same entity (§4). */
export async function moveBetween(
  db: D1Database,
  input: Omit<TransferInput, 'kind'>,
): Promise<TransferResult> {
  return transfer(db, { ...input, kind: 'move' });
}

export async function findUnallocated(
  db: D1Database,
  userId: string,
  entityId: string,
): Promise<EnvelopeWithBalanceRow | null> {
  return db
    .prepare(
      `SELECT e.*, b.balance_minor
         FROM envelopes e
         JOIN envelope_balances b ON b.envelope_id = e.id
        WHERE e.user_id = ?1 AND e.entity_id = ?2 AND e.type = 'unallocated'`,
    )
    .bind(userId, entityId)
    .first<EnvelopeWithBalanceRow>();
}

export interface CreateEnvelopeInput {
  userId: string;
  entityId: string;
  name: string;
  type: EnvelopeType;
  targetMinor?: Minor | null;
  targetDate?: string | null;
  zone?: string | null;
  now: number;
}

export async function createEnvelope(
  db: D1Database,
  input: CreateEnvelopeInput,
): Promise<{ id: string }> {
  const id = randomId();
  await db
    .prepare(
      `INSERT INTO envelopes
         (id, user_id, entity_id, name, type, target_minor, target_date, zone,
          sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
               COALESCE((SELECT MAX(sort_order) + 1 FROM envelopes
                          WHERE entity_id = ?3), 0),
               ?9, ?9)`,
    )
    .bind(
      id,
      input.userId,
      input.entityId,
      input.name,
      input.type,
      input.targetMinor ?? null,
      input.targetDate ?? null,
      input.zone ?? null,
      input.now,
    )
    .run();
  return { id };
}

/**
 * completeEnvelope (§12): "sweep the remainder to `unallocated` and archive."
 *
 * ONE BATCH, TWO STATEMENTS, AND BOTH THE ORDER AND THE GUARDS ARE THE CONTRACT.
 *
 * The sweep runs first and moves whatever the envelope holds AT THAT MOMENT:
 * the amount is a subquery over `envelope_balances`, not a number this function
 * read a round-trip earlier and hoped was still true. The archive then applies
 * only if the envelope is now at exactly zero.
 *
 * Archiving first, or archiving unconditionally, strands money. Concretely: the
 * operator taps Complete while a fund request for the same envelope is already
 * in flight. Read-then-write would sweep the balance it read, the fund would
 * land, and the archive would then hide an envelope that still holds cash —
 * money that exists, is claimed by a named envelope, and that no screen shows.
 * The residual would go on counting it as spoken for, so the operator's safe-to-
 * spend would be quietly low forever with nothing on the Canvas to explain it.
 *
 * `db.batch()` is the only atomic unit D1 offers — there are no interactive
 * transactions — and statements within one see each other's writes, which is
 * exactly what lets the archive test the balance the sweep just zeroed.
 */
export async function completeEnvelope(
  db: D1Database,
  input: {
    userId: string;
    entityId: string;
    envelopeId: string;
    unallocatedId: string;
    now: number;
  },
): Promise<{ ok: boolean; sweptMinor: Minor }> {
  const envelope = await findEnvelope(db, input.userId, input.envelopeId);
  if (!envelope || envelope.entity_id !== input.entityId) {
    throw new MoneyError('unknown_envelope', 'No such envelope.');
  }
  if (envelope.type === 'unallocated') {
    // Completing unallocated would sweep the residual into itself and archive
    // the one envelope the entity's balance is defined against.
    throw new MoneyError('not_completable', 'Unallocated cannot be completed.');
  }

  const entryId = randomId();
  // ?2 is the envelope being completed in BOTH statements, so one fragment
  // serves both and the two can never drift apart.
  const balance = '(SELECT b.balance_minor FROM envelope_balances b WHERE b.envelope_id = ?2)';

  const [swept, archived] = await db.batch<{ amount_minor: number }>([
    db
      .prepare(
        `INSERT INTO ledger_entries
           (id, user_id, entity_id, from_envelope_id, to_envelope_id,
            amount_minor, kind, memo, created_at)
         SELECT ?1, ?3, ?4, ?2, ?5, ${balance}, 'sweep', ?6, ?7
          WHERE ${balance} > 0
            AND EXISTS (SELECT 1 FROM envelopes s
                         WHERE s.id = ?2 AND s.user_id = ?3 AND s.entity_id = ?4
                           AND s.archived_at IS NULL)
            AND EXISTS (SELECT 1 FROM envelopes d
                         WHERE d.id = ?5 AND d.user_id = ?3 AND d.entity_id = ?4
                           AND d.archived_at IS NULL)
         RETURNING amount_minor`,
      )
      .bind(
        entryId,
        input.envelopeId,
        input.userId,
        input.entityId,
        input.unallocatedId,
        `Completed: ${envelope.name}`,
        input.now,
      ),
    db
      .prepare(
        `UPDATE envelopes
            SET completed_at = COALESCE(completed_at, ?1),
                archived_at = ?1,
                updated_at = ?1
          WHERE id = ?2 AND user_id = ?3
            -- Only archive an envelope that is genuinely empty. If the sweep
            -- above was blocked, this is false and the envelope stays visible.
            AND ${balance} = 0`,
      )
      // COALESCE keeps the first completion's timestamp, so a retried request
      // after a dropped response is a no-op rather than a rewritten history.
      .bind(input.now, input.envelopeId, input.userId),
  ]);

  if ((archived.meta.changes ?? 0) === 0) {
    // The envelope is not empty and was not archived. Nothing was hidden; the
    // caller can show it again and the operator can retry.
    return { ok: false, sweptMinor: 0 };
  }

  return { ok: true, sweptMinor: swept.results?.[0]?.amount_minor ?? 0 };
}
