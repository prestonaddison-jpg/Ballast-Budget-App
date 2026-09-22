/**
 * How a proposal reads.
 *
 * Pure strings, so they are tested here rather than in the browser — but the
 * rules being checked are the ones with money behind them, not styling: an
 * unknown balance is never presented as a number, and a proposal the balance
 * cannot cover never offers an action that would be refused.
 */

import { describe, expect, it } from 'vitest';
import { editSuggestions, presentProposal, queuePillText } from '../../web/src/lib/proposal-copy';
import type { ApiProposal } from '../../web/src/lib/api';

const base: ApiProposal = {
  id: 'prp_1',
  kind: 'income_allocation',
  amountMinor: 480_00,
  memo: 'Deposit landed Friday',
  createdAt: 1_800_000_000,
  expiresAt: null,
  from: { id: 'env_u', name: 'Unallocated', type: 'unallocated' },
  to: { id: 'env_t', name: 'Tax', type: 'tax' },
  sourceBalanceMinor: 1520_00,
  affordableNow: true,
};

const p = (over: Partial<ApiProposal> = {}): ApiProposal => ({ ...base, ...over });

describe('presentProposal', () => {
  it('states the amount and the route as a sentence', () => {
    const view = presentProposal(p());
    expect(view.kindLabel).toBe('Income landed');
    expect(view.amountText).toBe('$480');
    expect(view.routeText).toBe('Unallocated → Tax');
    expect(view.memoText).toBe('Deposit landed Friday');
  });

  it('offers Approve only when the source covers it', () => {
    expect(presentProposal(p()).canApprove).toBe(true);
    expect(presentProposal(p({ affordableNow: false })).canApprove).toBe(false);
  });

  it('explains a shortfall with the real balance, and without blame', () => {
    const view = presentProposal(p({ affordableNow: false, sourceBalanceMinor: 150_00 }));
    expect(view.affordability).toBe('short');
    expect(view.blockerText).toBe('Unallocated holds $150 — this no longer fits.');
    // The balance moved. That is not a mistake the operator made, and the copy
    // must not imply that it was.
    expect(view.blockerText).not.toMatch(/you |your |overspent|failed|error/i);
  });

  it('treats an unreported balance as UNKNOWN, not as a shortfall', () => {
    // `?? 0` here would turn "the bank has told us nothing" into "you have
    // nothing" — the single most dangerous bug this app can have.
    const view = presentProposal(p({ affordableNow: null, sourceBalanceMinor: null }));
    expect(view.affordability).toBe('unknown');
    expect(view.canApprove).toBe(false);
    expect(view.blockerText).toBe(
      "Unallocated hasn't reported a balance yet, so this can't be approved.",
    );
    // And it never renders a figure it does not have.
    expect(view.blockerText).not.toMatch(/\$/);
  });

  it('says nothing about a shortfall when there is none', () => {
    expect(presentProposal(p()).blockerText).toBeNull();
  });

  it('survives an envelope it cannot name rather than printing "null"', () => {
    const view = presentProposal(p({ to: { id: 'env_x', name: null, type: null } }));
    expect(view.routeText).toBe('Unallocated → another envelope');
    expect(view.routeText).not.toMatch(/null|undefined/);
  });

  it('labels every kind', () => {
    const kinds: ApiProposal['kind'][] = [
      'income_allocation',
      'salary_draw',
      'buffer_action',
      'unassigned_spend',
      'tax_skim',
      'waterfall',
    ];
    for (const kind of kinds) {
      const label = presentProposal(p({ kind })).kindLabel;
      expect(label, `${kind} has no label`).toBeTruthy();
      expect(label).not.toMatch(/_/);
    }
  });
});

describe('queuePillText', () => {
  it('agrees with itself in the singular and the plural', () => {
    expect(queuePillText(0)).toBe('Nothing needs you');
    expect(queuePillText(1)).toBe('1 needs you');
    expect(queuePillText(2)).toBe('2 need you');
    expect(queuePillText(12)).toBe('12 need you');
  });
});

describe('editSuggestions', () => {
  it('offers "All that fits" FIRST when the proposal is too big', () => {
    // The entire reason the edit sheet exists: one tap from a dead end to the
    // amount that works. A sort by size would bury it, which is the mistake
    // fund-suggest already made once with "all of it".
    const chips = editSuggestions(p({ amountMinor: 2400_00, sourceBalanceMinor: 1520_00 }));
    const fits = chips.find((c) => c.label === 'All that fits');
    expect(fits?.amountMinor).toBe(1520_00);
  });

  it('never suggests more than the source holds', () => {
    const chips = editSuggestions(p({ amountMinor: 2400_00, sourceBalanceMinor: 1520_00 }));
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) expect(c.amountMinor).toBeLessThanOrEqual(1520_00);
  });

  it('drops "All that fits" when the proposal already fits', () => {
    // On an affordable proposal it would mean "spend everything", which is not
    // what the operator asked about and not a neutral suggestion to make.
    const chips = editSuggestions(p({ amountMinor: 480_00, sourceBalanceMinor: 1520_00 }));
    expect(chips.map((c) => c.label)).not.toContain('All that fits');
  });

  it('offers nothing at all when the balance is unknown', () => {
    // Every candidate below is derived from the source balance. With none, the
    // honest output is no chips — the operator can still type an amount.
    expect(editSuggestions(p({ sourceBalanceMinor: null, affordableNow: null }))).toEqual([]);
    expect(editSuggestions(p({ sourceBalanceMinor: 0 }))).toEqual([]);
  });

  it('never repeats the amount already in the field', () => {
    const chips = editSuggestions(p({ amountMinor: 500_00, sourceBalanceMinor: 1520_00 }));
    expect(chips.map((c) => c.amountMinor)).not.toContain(500_00);
  });

  it('keeps every suggestion to whole cents', () => {
    const chips = editSuggestions(p({ amountMinor: 333_33, sourceBalanceMinor: 1520_00 }));
    for (const c of chips) expect(Number.isInteger(c.amountMinor)).toBe(true);
  });

  it('fits one row — at most three chips, ascending', () => {
    const chips = editSuggestions(p({ amountMinor: 9999_00, sourceBalanceMinor: 8000_00 }));
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.map((c) => c.amountMinor)).toEqual(
      [...chips.map((c) => c.amountMinor)].sort((x, y) => x - y),
    );
  });
});
