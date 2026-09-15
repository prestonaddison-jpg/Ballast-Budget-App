import { describe, expect, it } from 'vitest';
import { planReconcile, resolveTxnKey } from '../../src/ledger-source/txn-key';
import type { SourceTransaction } from '../../src/ledger-source/types';

function txn(
  over: Partial<SourceTransaction> & { txnKey: string; sourceTransactionId: string },
): SourceTransaction {
  return {
    supersedesSourceId: null,
    sourceAccountId: 'acc_1',
    amountMinor: -1000,
    currency: 'USD',
    date: '2026-09-01',
    authorizedDate: null,
    description: 'COFFEE',
    merchantName: null,
    counterparty: null,
    pending: false,
    categoryHint: null,
    ...over,
  };
}

describe('resolveTxnKey', () => {
  it('uses the transaction id when there is no pending ancestor', () => {
    expect(
      resolveTxnKey({ transactionId: 't1', pendingTransactionId: null }, () => undefined),
    ).toBe('t1');
  });

  it('inherits the stored key of the pending ancestor', () => {
    const stored = new Map([['pending_1', 'pending_1']]);
    const key = resolveTxnKey(
      { transactionId: 'posted_1', pendingTransactionId: 'pending_1' },
      (id) => stored.get(id),
    );
    expect(key).toBe('pending_1');
  });

  it('falls back to the ancestor id when the ancestor was never stored', () => {
    // If the posted transaction arrives before we ever saw the pending one,
    // using the ancestor id still yields the key the pending version WOULD
    // have had, so a later out-of-order arrival converges instead of forking.
    const key = resolveTxnKey(
      { transactionId: 'posted_1', pendingTransactionId: 'pending_1' },
      () => undefined,
    );
    expect(key).toBe('pending_1');
  });

  it('is stable across the pending -> posted swap', () => {
    const pendingKey = resolveTxnKey(
      { transactionId: 'p1', pendingTransactionId: null },
      () => undefined,
    );
    const stored = new Map([['p1', pendingKey]]);
    const postedKey = resolveTxnKey({ transactionId: 'x9', pendingTransactionId: 'p1' }, (id) =>
      stored.get(id),
    );
    expect(postedKey).toBe(pendingKey);
  });
});

describe('planReconcile', () => {
  it('treats a pending->posted transition as an UPDATE, not a delete', () => {
    // This is the bug that would silently destroy an envelope assignment every
    // time a charge settles.
    const plan = planReconcile(
      {
        added: [txn({ txnKey: 'p1', sourceTransactionId: 'x9', supersedesSourceId: 'p1' })],
        modified: [],
        removed: [{ sourceTransactionId: 'p1', sourceAccountId: 'acc_1' }],
      },
      (id) => (id === 'p1' ? 'p1' : undefined),
    );

    expect(plan.tombstones).toHaveLength(0);
    expect(plan.supersededPendingIds).toEqual(['p1']);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0].txnKey).toBe('p1');
    expect(plan.upserts[0].supersedesPending).toBe(true);
  });

  it('tombstones a genuine removal so the ledger can reverse it', () => {
    const plan = planReconcile(
      {
        added: [],
        modified: [],
        removed: [{ sourceTransactionId: 'gone', sourceAccountId: 'acc_1' }],
      },
      (id) => (id === 'gone' ? 'gone' : undefined),
    );
    expect(plan.tombstones).toEqual([{ txnKey: 'gone', sourceTransactionId: 'gone' }]);
    expect(plan.supersededPendingIds).toHaveLength(0);
  });

  it('ignores a removal for a transaction it never stored', () => {
    const plan = planReconcile(
      {
        added: [],
        modified: [],
        removed: [{ sourceTransactionId: 'never_seen', sourceAccountId: 'acc_1' }],
      },
      () => undefined,
    );
    expect(plan.tombstones).toHaveLength(0);
  });

  it('tombstones a genuine removal even when another upsert shares its key', () => {
    // REGRESSION. An earlier version suppressed any removal whose key was also
    // being upserted, on the theory that it was a cross-page posting catching
    // up. That silently swallowed GENUINE removals: a deposit added on page 1
    // of a drain and reversed on page 3 would be upserted and never
    // tombstoned, leaving reversed money in the ledger as real.
    //
    // Only the explicit pending back-pointer may suppress a removal.
    const plan = planReconcile(
      {
        added: [txn({ txnKey: 'k1', sourceTransactionId: 'x10', supersedesSourceId: 'other' })],
        modified: [],
        removed: [{ sourceTransactionId: 'k1_provider_id', sourceAccountId: 'acc_1' }],
      },
      (id) => (id === 'k1_provider_id' ? 'k1' : undefined),
    );
    expect(plan.tombstones).toEqual([{ txnKey: 'k1', sourceTransactionId: 'k1_provider_id' }]);
    expect(plan.supersededPendingIds).toHaveLength(0);
  });

  it('still suppresses a cross-page posting, via the back-pointer', () => {
    // drainSync accumulates every page before reconciling, so the posted
    // transaction from a later page is visible when the earlier page's removal
    // is considered. The back-pointer alone is enough; no key-collision
    // heuristic is needed.
    const plan = planReconcile(
      {
        added: [txn({ txnKey: 'p9', sourceTransactionId: 'posted_9', supersedesSourceId: 'p9' })],
        modified: [],
        removed: [{ sourceTransactionId: 'p9', sourceAccountId: 'acc_1' }],
      },
      (id) => (id === 'p9' ? 'p9' : undefined),
    );
    expect(plan.tombstones).toHaveLength(0);
    expect(plan.supersededPendingIds).toEqual(['p9']);
  });

  it('emits BOTH an upsert and a tombstone when a drain adds then removes', () => {
    // The apply order (upserts, then tombstones) is what makes the final state
    // "removed". Both operations must be present for that to be possible.
    const plan = planReconcile(
      {
        added: [txn({ txnKey: 'z1', sourceTransactionId: 'z1' })],
        modified: [],
        removed: [{ sourceTransactionId: 'z1', sourceAccountId: 'acc_1' }],
      },
      (id) => (id === 'z1' ? 'z1' : undefined),
    );
    expect(plan.upserts.map((u) => u.txnKey)).toEqual(['z1']);
    expect(plan.tombstones.map((t) => t.txnKey)).toEqual(['z1']);
  });

  it('is idempotent — replaying the same page yields the same plan', () => {
    const page = {
      added: [txn({ txnKey: 'a', sourceTransactionId: 'a' })],
      modified: [txn({ txnKey: 'b', sourceTransactionId: 'b' })],
      removed: [{ sourceTransactionId: 'c', sourceAccountId: 'acc_1' }],
    };
    const resolver = (id: string) => (id === 'c' ? 'c' : undefined);
    expect(planReconcile(page, resolver)).toEqual(planReconcile(page, resolver));
  });

  it('handles added and modified together without losing either', () => {
    const plan = planReconcile(
      {
        added: [txn({ txnKey: 'a', sourceTransactionId: 'a' })],
        modified: [txn({ txnKey: 'b', sourceTransactionId: 'b' })],
        removed: [],
      },
      () => undefined,
    );
    expect(plan.upserts.map((u) => u.txnKey).sort()).toEqual(['a', 'b']);
  });
});
