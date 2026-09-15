import { describe, expect, it } from 'vitest';
import {
  checkInvariant,
  safeToSpend,
  sumEnvelopeBalances,
  type AccountCash,
} from '../../src/money/invariant';

const acct = (over: Partial<AccountCash> = {}): AccountCash => ({
  accountId: 'a1',
  availableMinor: 100_000,
  budgetable: true,
  ...over,
});

const bal = (...amounts: number[]) => amounts.map((balanceMinor) => ({ balanceMinor }));

describe('checkInvariant', () => {
  it('is balanced when envelopes equal budgetable cash', () => {
    const check = checkInvariant(bal(60_000, 40_000), [acct()]);
    expect(check.status).toBe('balanced');
    expect(check.driftMinor).toBe(0);
  });

  it('reports cash_ahead when new money has landed', () => {
    const check = checkInvariant(bal(60_000), [acct()]);
    expect(check.status).toBe('cash_ahead');
    expect(check.driftMinor).toBe(40_000);
  });

  it('reports envelopes_ahead when money left after being allocated', () => {
    const check = checkInvariant(bal(150_000), [acct()]);
    expect(check.status).toBe('envelopes_ahead');
    expect(check.driftMinor).toBe(-50_000);
  });

  it('EXCLUDES non-budgetable accounts from the cash side', () => {
    // A credit card is a liability. Counting it as cash would inflate what the
    // entity appears to hold and let envelopes claim money that does not exist.
    const check = checkInvariant(bal(100_000), [
      acct(),
      acct({ accountId: 'card', availableMinor: 500_000, budgetable: false }),
    ]);
    expect(check.status).toBe('balanced');
    expect(check.cashTotalMinor).toBe(100_000);
  });

  it('is INDETERMINATE when an account reports no available balance', () => {
    // Treating unknown as zero would make every envelope look over-allocated
    // and trigger a correction that drains unallocated for no reason.
    const check = checkInvariant(bal(100_000), [acct({ availableMinor: null })]);
    expect(check.status).toBe('indeterminate');
    expect(check.cashTotalMinor).toBeNull();
    expect(check.driftMinor).toBeNull();
    expect(check.unknownAccountIds).toEqual(['a1']);
  });

  it('ignores an unknown balance on a NON-budgetable account', () => {
    const check = checkInvariant(bal(100_000), [
      acct(),
      acct({ accountId: 'card', availableMinor: null, budgetable: false }),
    ]);
    expect(check.status).toBe('balanced');
  });

  it('handles an entity with no accounts and no envelopes', () => {
    const check = checkInvariant([], []);
    expect(check.status).toBe('balanced');
    expect(check.cashTotalMinor).toBe(0);
  });

  it('flags envelopes against an entity with no cash at all', () => {
    const check = checkInvariant(bal(5_000), []);
    expect(check.status).toBe('envelopes_ahead');
    expect(check.driftMinor).toBe(-5_000);
  });
});

describe('sumEnvelopeBalances', () => {
  it('sums exactly in minor units', () => {
    // Integer arithmetic throughout: 0.1 + 0.2 problems would break the
    // invariant by a cent at a time, forever.
    expect(sumEnvelopeBalances(bal(1, 2, 3))).toBe(6);
    expect(sumEnvelopeBalances([])).toBe(0);
  });
});

describe('there is nothing to reconcile', () => {
  it('reports drift as a CANARY, not as routine work', () => {
    // Under the residual design (migrations/0002) conservation is an algebraic
    // identity, so a non-zero drift here means something upstream is broken —
    // not that a reconciliation job is due. There is deliberately no
    // planReconcilingMove: the earlier design needed one, this one cannot.
    const check = checkInvariant(bal(60_000), [acct()]);
    expect(check.status).toBe('cash_ahead');
    expect(check.driftMinor).toBe(40_000);
  });

  it('treats envelopes_ahead as a real, showable state', () => {
    // The one case an operator genuinely sees: cash fell below what was
    // already allocated, so unallocated has gone negative. That must be SHOWN
    // ("over-allocated by $500"), never smoothed away by draining reserves.
    const check = checkInvariant(bal(150_000), [acct()]);
    expect(check.status).toBe('envelopes_ahead');
    expect(check.driftMinor).toBe(-50_000);
  });
});

describe('safeToSpend', () => {
  it('is the unallocated balance — every other envelope has a job', () => {
    const check = checkInvariant(bal(40_000, 60_000), [acct()]);
    expect(safeToSpend(check, 40_000)).toBe(40_000);
  });

  it('is NULL when the bank has not said what is available', () => {
    // The honest answer is "we don't know", never a confident figure computed
    // from stale cash. This is the "green but dead" rule applied to the hero.
    const check = checkInvariant(bal(40_000), [acct({ availableMinor: null })]);
    expect(safeToSpend(check, 40_000)).toBeNull();
  });

  it('never presents a negative as spendable', () => {
    const check = checkInvariant(bal(100_000), [acct()]);
    expect(safeToSpend(check, -2_000)).toBe(0);
  });
});
