import { describe, expect, it } from 'vitest';
import { parseMoneyToMinor } from '../../web/src/lib/money-input';
import { suggestAmounts } from '../../web/src/lib/fund-suggest';

describe('parseMoneyToMinor', () => {
  it('parses plain and decorated amounts', () => {
    expect(parseMoneyToMinor('12.34')).toEqual({ ok: true, minor: 1234 });
    expect(parseMoneyToMinor('$1,250')).toEqual({ ok: true, minor: 125_000 });
    expect(parseMoneyToMinor(' 7 ')).toEqual({ ok: true, minor: 700 });
    expect(parseMoneyToMinor('0.05')).toEqual({ ok: true, minor: 5 });
    expect(parseMoneyToMinor('.5')).toEqual({ ok: true, minor: 50 });
  });

  it('is EXACT where float maths would not be', () => {
    // 12.34 * 100 is 1233.9999999999998. This is the one place a typed decimal
    // becomes an integer, and it does it by string, not by multiplication.
    expect(parseMoneyToMinor('12.34').ok && parseMoneyToMinor('12.34')).toEqual({
      ok: true,
      minor: 1234,
    });
    expect(parseMoneyToMinor('1234567.89')).toEqual({ ok: true, minor: 123_456_789 });
  });

  it('refuses more precision than money has', () => {
    // Ballast must not silently round the operator's money for them.
    expect(parseMoneyToMinor('1.234')).toEqual({ ok: false, reason: 'too_precise' });
  });

  it('refuses nonsense and non-positive amounts', () => {
    expect(parseMoneyToMinor('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseMoneyToMinor('abc')).toEqual({ ok: false, reason: 'not_a_number' });
    expect(parseMoneyToMinor('1.2.3')).toEqual({ ok: false, reason: 'not_a_number' });
    expect(parseMoneyToMinor('-5')).toEqual({ ok: false, reason: 'not_a_number' });
    expect(parseMoneyToMinor('0')).toEqual({ ok: false, reason: 'not_positive' });
    expect(parseMoneyToMinor('0.00')).toEqual({ ok: false, reason: 'not_positive' });
  });
});

describe('suggestAmounts', () => {
  it('offers the remaining-to-target first, because "fill it" is the usual intent', () => {
    const chips = suggestAmounts(1000_00, 250_00, 400_00);
    expect(chips).toContain(150_00);
  });

  it('NEVER offers more than is available', () => {
    // A chip that fails on tap is a small dishonesty that erodes trust in
    // every other number on the screen.
    const chips = suggestAmounts(75_00, 0, 900_00);
    expect(chips.every((c) => c <= 75_00)).toBe(true);
    expect(chips).toContain(75_00);
  });

  it('offers nothing when there is nothing to give', () => {
    expect(suggestAmounts(0, 0, 100_00)).toEqual([]);
    expect(suggestAmounts(-5_00, 0, 100_00)).toEqual([]);
  });

  it('offers nothing when the balance is unknown', () => {
    expect(suggestAmounts(null, 0, 100_00)).toEqual([]);
  });

  it('skips remaining-to-target on an already-full envelope', () => {
    const chips = suggestAmounts(500_00, 400_00, 400_00);
    expect(chips).not.toContain(0);
    expect(chips.every((c) => c > 0)).toBe(true);
  });

  it('deduplicates and stays short enough to scan', () => {
    const chips = suggestAmounts(100_00, 0, 100_00);
    expect(new Set(chips).size).toBe(chips.length);
    expect(chips.length).toBeLessThanOrEqual(4);
  });
});
