import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_AMOUNT,
  formatMoney,
  formatMoneyExact,
  fundedFraction,
  type EnvelopeTileModel,
} from '../../web/src/lib/envelope-math';
import { presentTile } from '../../web/src/lib/envelope-math';
import { defaultZoneFor, groupIntoZones } from '../../web/src/lib/zones';

const env = (over: Partial<EnvelopeTileModel>): EnvelopeTileModel => ({
  id: 'e1',
  name: 'Tax',
  type: 'tax',
  balanceMinor: 0,
  targetMinor: null,
  currency: 'USD',
  ...over,
});

describe('money formatting', () => {
  it('shows whole dollars on a tile', () => {
    // Cents are noise at a glance; the Canvas is a glanceable surface.
    expect(formatMoney(452_300)).toBe('$4,523');
    expect(formatMoney(0)).toBe('$0');
  });

  it('shows cents where the exact figure matters', () => {
    expect(formatMoneyExact(452_312)).toBe('$4,523.12');
  });

  it('renders a negative balance rather than hiding it', () => {
    // An envelope should never go negative, but if the ledger ever produced
    // one the operator must SEE it, not be shown a soothing $0.
    expect(formatMoney(-2500)).toBe('-$25');
  });
});

describe('fundedFraction', () => {
  it('reports progress against a target', () => {
    expect(fundedFraction(2500, 10_000)).toBe(0.25);
    expect(fundedFraction(10_000, 10_000)).toBe(1);
  });

  it('returns null when there is NO target', () => {
    // An envelope without a target is not "0% funded" — it has no notion of
    // progress, and drawing an empty bar would imply a goal never set.
    expect(fundedFraction(5000, null)).toBeNull();
    expect(fundedFraction(5000, 0)).toBeNull();
  });

  it('clamps rather than overflowing the meter', () => {
    expect(fundedFraction(20_000, 10_000)).toBe(1);
    expect(fundedFraction(-500, 10_000)).toBe(0);
  });
});

describe('zone assignment', () => {
  it('separates money with a job from money without one', () => {
    expect(defaultZoneFor('unallocated')).toBe('available');
    expect(defaultZoneFor('tax')).toBe('reserved');
    expect(defaultZoneFor('buffer')).toBe('reserved');
    expect(defaultZoneFor('save')).toBe('purpose');
    expect(defaultZoneFor('spend')).toBe('purpose');
  });

  it('orders reserved money BEFORE discretionary', () => {
    // The whole point of the app is making "already spoken for" read first
    // (§2). If purpose envelopes sorted above reserves, the Canvas would lead
    // with the money the operator is most tempted to spend.
    const zones = groupIntoZones([
      env({ id: 'a', type: 'spend', name: 'Fuel' }),
      env({ id: 'b', type: 'tax', name: 'Tax' }),
      env({ id: 'c', type: 'unallocated', name: 'Unallocated' }),
    ]);
    expect(zones.map((z) => z.id)).toEqual(['available', 'reserved', 'purpose']);
  });

  it('omits a zone with no envelopes rather than rendering an empty heading', () => {
    const zones = groupIntoZones([env({ type: 'tax' })]);
    expect(zones.map((z) => z.id)).toEqual(['reserved']);
  });

  it('keeps every envelope — no 7-tile cap', () => {
    // Miller's 7±2 is about RECALL, not what may be visible. Capping the grid
    // would hide envelopes the operator needs while doing nothing for load.
    const many = Array.from({ length: 12 }, (_, i) =>
      env({ id: `e${i}`, type: 'spend', name: `Project ${i}` }),
    );
    const zones = groupIntoZones(many);
    expect(zones).toHaveLength(1);
    expect(zones[0].envelopes).toHaveLength(12);
  });

  it('returns no zones for no envelopes', () => {
    expect(groupIntoZones([])).toEqual([]);
  });
});

describe('the tile, when the bank has reported nothing', () => {
  it('shows an em dash and says why — never "$0"', () => {
    const view = presentTile(env({ type: 'unallocated', name: 'Unallocated', balanceMinor: null }));
    expect(view.amountText).toBe(UNKNOWN_AMOUNT);
    expect(view.amountText).not.toContain('0');
    expect(view.captionText).toBe('waiting on your bank');
  });

  it('spells the unknown out for a screen reader', () => {
    // An em dash is announced as nothing at all, so a blind operator would
    // hear "Unallocated, Unallocated" and learn less than a sighted one.
    const view = presentTile(env({ type: 'unallocated', balanceMinor: null }));
    expect(view.amountLabel).toBe('amount not reported by your bank');
  });

  it('draws no progress bar it cannot justify', () => {
    expect(
      presentTile(env({ balanceMinor: null, targetMinor: 400_00 })).progressPercent,
    ).toBeNull();
  });

  it('still renders a genuine zero as a zero', () => {
    // The whole point is the DISTINCTION. An envelope that really holds
    // nothing must not be hidden behind the same dash as an unknown one.
    const view = presentTile(env({ balanceMinor: 0, targetMinor: 400_00 }));
    expect(view.amountText).toBe('$0');
    expect(view.amountLabel).toBe('$0.00');
    expect(view.progressPercent).toBe(0);
    expect(view.captionText).toBe('0% of $400');
  });
});
