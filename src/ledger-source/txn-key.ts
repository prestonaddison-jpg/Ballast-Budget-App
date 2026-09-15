/**
 * The `txn_key` surrogate and sync reconciliation (§4).
 *
 * THE PROBLEM
 * Plaid's `transaction_id` is NOT stable: when a pending transaction posts,
 * the posted transaction arrives with a NEW id, and the pending one shows up
 * in the sync page's `removed` array. A receipt or envelope assignment keyed
 * on `transaction_id` would be orphaned every time a charge settles.
 *
 * THE SURROGATE
 * `txnKey` is the id of the EARLIEST known member of a pending -> posted
 * chain. A posted transaction carries `pending_transaction_id` pointing back
 * at its pending ancestor, so:
 *
 *     txnKey(t) = txnKey(t.pending_transaction_id)   if we have seen the ancestor
 *               = t.pending_transaction_id           if we have not
 *               = t.transaction_id                   if there is no ancestor
 *
 * The middle case matters: if the posted transaction arrives before we ever
 * stored the pending one, using the ancestor's id still produces the key that
 * the pending version WOULD have had, so a later out-of-order arrival
 * converges on the same key instead of forking.
 *
 * THE RECONCILE HAZARD
 * A naive reconciler deletes everything in `removed`. That is wrong twice:
 *
 *   (a) When a pending transaction posts, its id appears in `removed` while
 *       the SAME logical transaction is being added under a new id. Deleting
 *       would destroy the envelope assignment the operator just made, and then
 *       re-create the transaction as if it were brand new and unallocated.
 *
 *   (b) The pending removal and the posted arrival are not guaranteed to land
 *       in the same page. If they split across pages, a hard delete in page 1
 *       loses the assignment before page 2 can reattach it.
 *
 * So removals are TOMBSTONED, never hard-deleted: the row and its txnKey
 * survive, the ledger reverses rather than erases (§4 "reversals self-heal"),
 * and a later posted transaction reattaches to the same key.
 *
 * WHAT MUST *NOT* SUPPRESS A REMOVAL: the fact that some upsert happens to
 * resolve to the same txnKey. That test looks like a safe way to let a
 * cross-page posting win, and it silently swallows GENUINE removals — a
 * transaction added on page 1 of a drain and reversed on page 3 would be
 * upserted and never tombstoned, leaving a reversed deposit sitting in the
 * ledger as real money. Only the explicit `pending_transaction_id`
 * back-pointer suppresses a removal. The cross-page posting case is already
 * covered by that same back-pointer, because the accumulated drain sees every
 * page's `added` before any removal is considered.
 *
 * RETENTION: a tombstoned row must stay QUERYABLE by its provider id for at
 * least 14 days. Plaid documents pending -> posted as "one to five business
 * days, although it can take up to fourteen days in rare situations", and the
 * posted transaction can only find its predecessor if that row is still
 * lookup-able. Ballast keeps them indefinitely, since they are also the
 * evidence behind a reversal in the CPA export (§17).
 *
 * WHAT THIS CANNOT FIX: `pending_transaction_id` can be null even when a
 * pending version existed. Plaid matches the two with an ML model, so the
 * match can simply fail, and some institutions never expose pending
 * transactions at all. An unlinked posted twin is therefore indistinguishable
 * from a genuine removal plus an unrelated new transaction, and will be
 * treated as such. Heuristic matching on (account, amount, name) is NOT the
 * answer and is deliberately not attempted: Plaid's own example is that "the
 * pending charge for a meal at a restaurant may not include a tip, but the
 * posted version will include the final amount" — the amounts and names
 * legitimately differ, so a heuristic would mis-merge unrelated transactions,
 * which is worse than an occasional duplicate the operator can reassign.
 * `date` is likewise unusable as a matching key: on the posted transaction it
 * means the POSTED date, while on the pending one it meant the authorization
 * date.
 */

import type { RemovedRef, SourceTransaction } from './types';

/** Looks up the stored txnKey for a provider transaction id. */
export type TxnKeyResolver = (sourceTransactionId: string) => string | undefined;

export interface RawTxnIdentity {
  transactionId: string;
  pendingTransactionId: string | null;
}

export function resolveTxnKey(txn: RawTxnIdentity, resolver: TxnKeyResolver): string {
  const ancestor = txn.pendingTransactionId;
  if (ancestor) {
    return resolver(ancestor) ?? ancestor;
  }
  return txn.transactionId;
}

export interface ReconcileUpsert {
  txnKey: string;
  transaction: SourceTransaction;
  /** True when this upsert replaces a pending version with a posted one. */
  supersedesPending: boolean;
}

export interface ReconcileTombstone {
  txnKey: string;
  sourceTransactionId: string;
}

/**
 * APPLY ORDER IS PART OF THE CONTRACT: upserts first, then tombstones.
 *
 * A page (or an accumulated drain) can legitimately contain both an upsert and
 * a tombstone for the same txnKey — a transaction added early in a drain and
 * genuinely removed later in it. Applying upserts first and tombstones second
 * leaves the final state as "removed", which is correct. The reverse order
 * would resurrect a deleted transaction.
 */
export interface ReconcilePlan {
  upserts: ReconcileUpsert[];
  /**
   * Genuinely removed transactions — a reversal, a chargeback, or a bank
   * correction. The ledger must REVERSE these, not erase them.
   */
  tombstones: ReconcileTombstone[];
  /**
   * Provider ids that appeared in `removed` purely because they were the
   * pending half of a posting. Recorded for auditing; no ledger effect.
   */
  supersededPendingIds: string[];
}

/**
 * Turn one sync page into an ordered, idempotent set of ledger operations.
 *
 * Pure and total: the same page plus the same resolver always yields the same
 * plan, so it can be replayed safely after a partial failure.
 */
export function planReconcile(
  page: { added: SourceTransaction[]; modified: SourceTransaction[]; removed: RemovedRef[] },
  resolver: TxnKeyResolver,
): ReconcilePlan {
  const upserts: ReconcileUpsert[] = [];

  // Every pending id superseded by something in THIS page.
  const supersededHere = new Set<string>();
  for (const txn of [...page.added, ...page.modified]) {
    if (txn.supersedesSourceId) supersededHere.add(txn.supersedesSourceId);
  }

  for (const txn of [...page.added, ...page.modified]) {
    upserts.push({
      txnKey: txn.txnKey,
      transaction: txn,
      supersedesPending: txn.supersedesSourceId != null,
    });
  }

  const tombstones: ReconcileTombstone[] = [];
  const supersededPendingIds: string[] = [];

  for (const ref of page.removed) {
    if (supersededHere.has(ref.sourceTransactionId)) {
      // The pending half of a posting that is being upserted right now.
      supersededPendingIds.push(ref.sourceTransactionId);
      continue;
    }
    const key = resolver(ref.sourceTransactionId);
    if (key == null) {
      // Never stored it — nothing to reverse. (Plaid can report a removal for
      // a transaction we never received, e.g. removed during initial backfill.)
      continue;
    }
    tombstones.push({ txnKey: key, sourceTransactionId: ref.sourceTransactionId });
  }

  return { upserts, tombstones, supersededPendingIds };
}
