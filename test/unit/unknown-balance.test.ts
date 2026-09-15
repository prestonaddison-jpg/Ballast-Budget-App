/**
 * "We don't know" must survive the whole way to the screen.
 *
 * Blueprint §14's central rule is that Ballast never renders an unknown as a
 * confident figure. The hero honoured it from the start; the Canvas did not.
 * `main.ts` mapped the API's `balanceMinor` through `?? 0`, so when a bank had
 * not reported an available balance the hero read "—  Your bank hasn't
 * reported an available balance" while the Unallocated tile two inches below
 * it read "$0" — a number nobody had supplied, contradicting the line above
 * it, and wrong in the direction that makes an operator stop trusting the app.
 *
 * These tests pin the null all the way through the presentation layer.
 */

import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_AMOUNT,
  formatMoney,
  formatMoneyExact,
  fundedFraction,
} from '../../web/src/lib/envelope-math';
import { suggestAmounts } from '../../web/src/lib/fund-suggest';

describe('an unknown amount', () => {
  it('formats as an em dash, never as zero', () => {
    expect(formatMoney(null)).toBe(UNKNOWN_AMOUNT);
    expect(formatMoneyExact(null)).toBe(UNKNOWN_AMOUNT);
    // The distinction that matters: a real zero still renders as a real zero.
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoneyExact(0)).toBe('$0.00');
  });

  it('has no progress, rather than zero progress', () => {
    // A 0% bar against a $4,000 target is a claim about how much is in the
    // envelope. With a null balance there is no such claim to make.
    expect(fundedFraction(null, 400_000)).toBeNull();
    expect(fundedFraction(0, 400_000)).toBe(0);
  });

  it('offers no fill-to-target chip computed from a balance we lack', () => {
    const known = suggestAmounts(1000_00, 100_00, 400_00);
    expect(known).toContain(300_00); // remaining to target

    const unknown = suggestAmounts(1000_00, null, 400_00);
    expect(unknown).not.toContain(300_00);
    // The round amounts and "all of it" are still honest offers: they depend
    // only on what is available, which IS known here.
    expect(unknown).toContain(1000_00);
  });
});
