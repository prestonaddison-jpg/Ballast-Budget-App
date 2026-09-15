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

  it('lets a cross-page posting win over an earlier removal of the same key', () => {
    // The pending removal and the posted arrival are not guaranteed to land in
    // the same page. When they do coincide, the upsert must win.
    const plan = planReconcile(
      {
        added: [txn({ txnKey: 'p2', sourceTransactionId: 'x10', supersedesSourceId: 'other' })],
        modified: [],
        removed: [{ sourceTransactionId: 'p2_provider_id', sourceAccountId: 'acc_1' }],
      },
      (id) => (id === 'p2_provider_id' ? 'p2' : undefined),
    );
    expect(plan.tombstones).toHaveLength(0);
    expect(plan.supersededPendingIds).toEqual(['p2_provider_id']);
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
