/**
 * Proposals — the staging model (Blueprint §4).
 *
 * "Nothing mutates a balance without approval. Triggers produce editable
 * proposals; approveProposal commits atomically."
 *
 * THE ONE RULE THAT SHAPES THIS FILE, quoted from §4 because getting it wrong
 * is the whole failure mode:
 *
 *   "Proposals are validated against the CURRENT balance at approve-time, not
 *    at generation-time (balances change between sync and approval; the
 *    invariant must hold at commit)."
 *
 * So `amount_minor` on a proposal row is an INTENT, not a reservation. It
 * reserves nothing, it counts toward no balance, and it is re-checked against
 * live cash at the moment the operator taps approve. A proposal generated when
 * unallocated held $900 must be REFUSED if a hold has since dropped it to $200
 * — silently committing it would overdraw the very envelope the app exists to
 * keep honest.
 *
 * HOW THAT IS ENFORCED. D1 has no interactive transactions, so this is not
 * safe:
 *
 *     const p = await readProposal(id);       // <-- window opens
 *     if (await balanceOf(p.from) >= p.amount) await commit(p);   // <-- closes
 *
 * Instead the proposal row, the expiry, the status and the live balance are
 * ALL read inside the same INSERT that writes the ledger entry. One statement,
 * atomic, no window. It is the same shape as `transfer` in ./ledger.ts — read
 * that first if this looks unusual.
 */

import { randomId } from '../crypto/random';
import { MoneyError, type EntryKind, type Minor } from './types';

export const PROPOSAL_KINDS = [
  'income_allocation',
  'salary_draw',
  'buffer_action',
  'unassigned_spend',
  'tax_skim',
  'waterfall',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export type ProposalStatus = 'pending' | 'approved' | 'dismissed' | 'expired';

export interface ProposalRow {
  id: string;
  user_id: string;
  entity_id: string;
  kind: ProposalKind;
  from_envelope_id: string;
  to_envelope_id: string;
  amount_minor: number;
  status: ProposalStatus;
  txn_key: string | null;
  memo: string | null;
  expires_at: number | null;
  created_at: number;
  decided_at: number | null;
  entry_id: string | null;
}

/**
 * Which ledger `kind` a committed proposal writes.
 *
 * Moving money out of unallocated is a `fund`; shuffling between two named
 * envelopes is a `move`. Nothing here writes `sweep` or `reversal` — those
 * belong to completeEnvelope and to compensating entries, not to approval.
 */
const ENTRY_KIND: Record<ProposalKind, EntryKind> = {
  income_allocation: 'fund',
  salary_draw: 'move',
  buffer_action: 'move',
  unassigned_spend: 'move',
  tax_skim: 'fund',
  waterfall: 'fund',
};

/**
 * The same mapping as a SQL expression, GENERATED from it.
 *
 * approveProposal never reads the proposal into JavaScript — the whole point
 * is that the row is consulted inside the insert — so the mapping has to exist
 * in SQL too. Writing it out twice is how the two quietly drift apart when a
 * seventh kind is added, so the CASE is built from the record above and there
 * is still exactly one place to change.
 *
 * Both sides are closed string-literal unions checked by the compiler, so no
 * caller-supplied text reaches this; it is a constant assembled at module load.
 */
const ENTRY_KIND_SQL = `CASE p.kind\n${(Object.entries(ENTRY_KIND) as [ProposalKind, EntryKind][])
  .map(([kind, entry]) => `                WHEN '${kind}' THEN '${entry}'`)
  .join('\n')}\n              END`;

export interface CreateProposalInput {
  userId: string;
  entityId: string;
  kind: ProposalKind;
  fromEnvelopeId: string;
  toEnvelopeId: string;
  amountMinor: Minor;
  txnKey?: string | null;
  memo?: string | null;
  /** Seconds. Past this the operator is shown a fresh proposal instead. */
  expiresAt?: number | null;
  now: number;
}

/**
 * Stage a suggestion. Deliberately does NOT check the balance.
 *
 * A proposal is allowed to be unaffordable the moment it is made — cash moves,
 * and the check that matters happens at approve time. Refusing to stage one
 * here would mean the operator never sees "you wanted to put $900 in tax and
 * there is only $200" — they would just see nothing, which is worse.
 */
export async function createProposal(
  db: D1Database,
  input: CreateProposalInput,
): Promise<{ id: string }> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new MoneyError('invalid_amount', 'Amount must be a positive whole number of cents.');
  }
  if (input.fromEnvelopeId === input.toEnvelopeId) {
    throw new MoneyError('same_envelope', 'A proposal cannot move an envelope to itself.');
  }

  const id = randomId();
  await db
    .prepare(
      `INSERT INTO proposals
         (id, user_id, entity_id, kind, from_envelope_id, to_envelope_id,
          amount_minor, status, txn_key, memo, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10, ?11)`,
    )
    .bind(
      id,
      input.userId,
      input.entityId,
      input.kind,
      input.fromEnvelopeId,
      input.toEnvelopeId,
      input.amountMinor,
      input.txnKey ?? null,
      input.memo ?? null,
      input.expiresAt ?? null,
      input.now,
    )
    .run();

  return { id };
}

/** One entity's pending queue, oldest first — the Needs You inbox. */
export async function listPendingProposals(
  db: D1Database,
  userId: string,
  entityId: string,
  now: number,
): Promise<ProposalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM proposals
        WHERE user_id = ?1 AND entity_id = ?2 AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > ?3)
        ORDER BY created_at`,
    )
    .bind(userId, entityId, now)
    .all<ProposalRow>();
  return results ?? [];
}

export async function findProposal(
  db: D1Database,
  userId: string,
  proposalId: string,
): Promise<ProposalRow | null> {
  // Ownership is part of the lookup, never a follow-up check a caller can skip.
  return db
    .prepare('SELECT * FROM proposals WHERE id = ?1 AND user_id = ?2')
    .bind(proposalId, userId)
    .first<ProposalRow>();
}

export type ApproveResult =
  | { ok: true; entryId: string; amountMinor: Minor }
  | {
      ok: false;
      reason: 'not_found' | 'not_pending' | 'expired' | 'insufficient_funds' | 'rejected';
    };

/**
 * Commit a proposal, atomically, against the balance as it is RIGHT NOW.
 *
 * Two statements in one `db.batch` — the only atomic unit D1 offers — and the
 * order is the contract:
 *
 *   1. INSERT the ledger entry, selecting the amount and endpoints FROM the
 *      proposal row, and firing only if the proposal is still pending, not
 *      expired, both envelopes are live, and the source balance covers it.
 *   2. UPDATE the proposal to approved, firing only if step 1 actually wrote
 *      its row.
 *
 * Nothing is read into JavaScript and acted on afterwards, so there is no
 * window in which the balance can move between the check and the commit.
 *
 * DOUBLE-APPROVE is prevented twice over: step 1 requires `status = 'pending'`,
 * and the entry carries `idempotency_key = 'proposal:<id>'`, which the unique
 * index on (user_id, idempotency_key) turns into a constraint error rather
 * than a second allocation. Belt and braces, because this is money.
 */
export async function approveProposal(
  db: D1Database,
  input: { userId: string; proposalId: string; now: number },
): Promise<ApproveResult> {
  const entryId = randomId();

  const insertEntry = db
    .prepare(
      `INSERT INTO ledger_entries
         (id, user_id, entity_id, from_envelope_id, to_envelope_id,
          amount_minor, kind, txn_key, idempotency_key, memo, created_at)
       SELECT ?1, p.user_id, p.entity_id, p.from_envelope_id, p.to_envelope_id,
              p.amount_minor,
              ${ENTRY_KIND_SQL},
              p.txn_key,
              'proposal:' || p.id,
              p.memo,
              ?3
         FROM proposals p
        WHERE p.id = ?2
          AND p.user_id = ?4
          -- Still open. An already-approved or dismissed proposal writes nothing.
          AND p.status = 'pending'
          -- Still fresh.
          AND (p.expires_at IS NULL OR p.expires_at > ?3)
          -- Both envelopes live, and in THIS entity (no commingling).
          AND EXISTS (SELECT 1 FROM envelopes s
                       WHERE s.id = p.from_envelope_id AND s.entity_id = p.entity_id
                         AND s.user_id = p.user_id AND s.archived_at IS NULL)
          AND EXISTS (SELECT 1 FROM envelopes d
                       WHERE d.id = p.to_envelope_id AND d.entity_id = p.entity_id
                         AND d.user_id = p.user_id AND d.archived_at IS NULL)
          -- THE GUARD. The balance AS IT IS NOW, read inside the write.
          -- NULL (bank has reported nothing) fails this comparison by design:
          -- nothing is committed out of a balance nobody knows.
          AND (SELECT b.balance_minor FROM envelope_balances b
                WHERE b.envelope_id = p.from_envelope_id) >= p.amount_minor`,
    )
    .bind(entryId, input.proposalId, input.now, input.userId);

  const markApproved = db
    .prepare(
      `UPDATE proposals
          SET status = 'approved', decided_at = ?3, entry_id = ?1
        WHERE id = ?2 AND user_id = ?4 AND status = 'pending'
          -- Only if the entry above actually landed. If the guard refused,
          -- this refuses too and the proposal stays pending and visible.
          AND EXISTS (SELECT 1 FROM ledger_entries e WHERE e.id = ?1)`,
    )
    .bind(entryId, input.proposalId, input.now, input.userId);

  const [entry] = await db.batch([insertEntry, markApproved]).catch((err: unknown) => {
    // The unique index on (user_id, idempotency_key) turns a concurrent second
    // approve into a constraint error rather than a duplicate allocation.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE') && message.includes('idempotency')) {
      return [{ meta: { changes: 0 } }] as unknown as D1Result[];
    }
    throw err;
  });

  if ((entry?.meta?.changes ?? 0) === 1) {
    const row = await findProposal(db, input.userId, input.proposalId);
    return { ok: true, entryId, amountMinor: row?.amount_minor ?? 0 };
  }

  // Nothing was written. Work out WHY, so the UI can say something true rather
  // than a generic failure.
  const row = await findProposal(db, input.userId, input.proposalId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
  if (row.expires_at != null && row.expires_at <= input.now) {
    return { ok: false, reason: 'expired' };
  }

  const source = await db
    .prepare('SELECT b.balance_minor FROM envelope_balances b WHERE b.envelope_id = ?')
    .bind(row.from_envelope_id)
    .first<{ balance_minor: number | null }>();

  if (source == null || source.balance_minor == null) {
    // Unknown cash. Not "insufficient" — we genuinely do not know.
    return { ok: false, reason: 'rejected' };
  }
  if (source.balance_minor < row.amount_minor) {
    return { ok: false, reason: 'insufficient_funds' };
  }
  return { ok: false, reason: 'rejected' };
}

/** Decline a proposal. Touches no balance — that is the entire point. */
export async function dismissProposal(
  db: D1Database,
  input: { userId: string; proposalId: string; now: number },
): Promise<{ ok: boolean }> {
  const result = await db
    .prepare(
      `UPDATE proposals SET status = 'dismissed', decided_at = ?3
        WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`,
    )
    .bind(input.proposalId, input.userId, input.now)
    .run();
  return { ok: (result.meta.changes ?? 0) === 1 };
}

/**
 * Mark elapsed proposals expired.
 *
 * Cosmetic only: approveProposal already refuses an elapsed proposal by its
 * own guard, so a proposal that slips past its expiry without this running is
 * refused anyway. This exists so the queue reads honestly rather than to
 * enforce anything.
 */
export async function expireProposals(db: D1Database, now: number): Promise<{ expired: number }> {
  const result = await db
    .prepare(
      `UPDATE proposals SET status = 'expired', decided_at = ?1
        WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?1`,
    )
    .bind(now)
    .run();
  return { expired: result.meta.changes ?? 0 };
}
