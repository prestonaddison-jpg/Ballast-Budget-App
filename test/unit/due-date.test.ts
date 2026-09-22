/**
 * Due-date arithmetic and phrasing.
 *
 * Every test injects a clock. A module that reads the wall clock cannot be
 * tested for "due tomorrow" without waiting a day, and a suite that can only
 * be run on certain dates is a suite nobody runs.
 *
 * The two bugs being guarded are both off-by-ones, and both are the kind that
 * make an operator stop believing the screen: a bill that says "due today" on
 * the day after it was due, and one that says "due in 0 days" across a
 * daylight-saving boundary because a day was 23 hours long.
 */

import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  duePhrase,
  dueText,
  dueTone,
  isValidDateString,
  relativeDateChoices,
  toDateString,
} from '../../web/src/lib/due-date';
import { isValidDateString as workerIsValidDateString } from '../../src/money/dates';

/** 2026-03-15, mid-afternoon local. */
const NOON = new Date(2026, 2, 15, 14, 30);

describe('daysUntil', () => {
  it('counts CALENDAR days, not elapsed milliseconds', () => {
    expect(daysUntil('2026-03-15', NOON)).toBe(0);
    expect(daysUntil('2026-03-16', NOON)).toBe(1);
    expect(daysUntil('2026-03-22', NOON)).toBe(7);
    expect(daysUntil('2026-03-14', NOON)).toBe(-1);
  });

  it('says TOMORROW at one minute to midnight, not today', () => {
    // The millisecond version divides ~4 minutes by 86,400,000 and floors to
    // 0. The operator is told a bill due tomorrow is due today — or worse, the
    // reverse — on every single evening.
    const lateTonight = new Date(2026, 2, 15, 23, 59);
    expect(daysUntil('2026-03-16', lateTonight)).toBe(1);
    expect(daysUntil('2026-03-15', lateTonight)).toBe(0);
  });

  it('is right across a 23-hour spring-forward day', () => {
    // US DST 2026 starts March 8. A day here is 23 hours long, so a
    // millisecond diff rounds one day short over any span containing it.
    const beforeShift = new Date(2026, 2, 7, 12, 0);
    expect(daysUntil('2026-03-08', beforeShift)).toBe(1);
    expect(daysUntil('2026-03-14', beforeShift)).toBe(7);
  });

  it('is right across a 25-hour fall-back day', () => {
    const beforeShift = new Date(2026, 9, 31, 12, 0); // 2026-10-31
    expect(daysUntil('2026-11-01', beforeShift)).toBe(1);
    expect(daysUntil('2026-11-08', beforeShift)).toBe(8);
  });

  it('crosses a year boundary and a leap day', () => {
    expect(daysUntil('2027-01-01', new Date(2026, 11, 31, 9, 0))).toBe(1);
    // 2028 is a leap year: Feb has 29 days.
    expect(daysUntil('2028-03-01', new Date(2028, 1, 28, 9, 0))).toBe(2);
  });

  it('returns NULL rather than NaN for anything it cannot read', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'next tuesday',
      '03/15/2026',
      '2026-3-5',
      '2026-02-30',
    ]) {
      expect(daysUntil(bad as string | null, NOON), String(bad)).toBeNull();
    }
  });
});

describe('duePhrase', () => {
  it('reads as calm fact, never as a telling-off', () => {
    expect(duePhrase(0)).toBe('due today');
    expect(duePhrase(1)).toBe('due tomorrow');
    expect(duePhrase(3)).toBe('due in 3 days');
    expect(duePhrase(-1)).toBe('overdue 1d');
    expect(duePhrase(-9)).toBe('overdue 9d');
  });

  it('never blames the operator', () => {
    // §14: no shame, no scolding. "overdue 2d" is a fact about a date;
    // "you're 2 days late" is a fact about a person.
    for (const days of [-30, -1, 0, 1, 30]) {
      expect(duePhrase(days)).not.toMatch(/you|late|missed|failed|should/i);
    }
  });
});

describe('dueText', () => {
  it('goes straight from a stored string to the words on the tile', () => {
    expect(dueText('2026-03-18', NOON)).toBe('due in 3 days');
    expect(dueText(null, NOON)).toBeNull();
    // An unreadable stored value is NOT a deadline we may assert.
    expect(dueText('whenever', NOON)).toBeNull();
  });
});

describe('dueTone', () => {
  it('treats a week as the window in which acting is still possible', () => {
    expect(dueTone(-1)).toBe('past');
    expect(dueTone(0)).toBe('today');
    expect(dueTone(7)).toBe('soon');
    expect(dueTone(8)).toBe('later');
  });
});

describe('isValidDateString', () => {
  const CASES: Array<[unknown, boolean]> = [
    ['2026-03-15', true],
    ['2026-02-28', true],
    ['2028-02-29', true], // leap year
    ['2026-02-29', false], // not a leap year
    ['2026-02-30', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-01-00', false],
    ['2026-01-32', false],
    ['2026-3-5', false],
    ['03/15/2026', false],
    ['next tuesday', false],
    ['', false],
    [null, false],
    [undefined, false],
    [20260315, false],
    ['2026-03-15T00:00:00Z', false],
  ];

  it('accepts real calendar dates and refuses everything else', () => {
    for (const [value, expected] of CASES) {
      expect(isValidDateString(value), JSON.stringify(value)).toBe(expected);
    }
  });

  it('agrees EXACTLY with the Worker-side copy', () => {
    // src/ and web/src/ are separate runtimes with separate builds, so the
    // rule is written twice on purpose. This is what stops the two copies
    // drifting: a date the browser offers and the Worker refuses is a form
    // that fails after the operator has filled it in.
    for (const [value] of CASES) {
      expect(workerIsValidDateString(value), JSON.stringify(value)).toBe(isValidDateString(value));
    }
  });
});

describe('relativeDateChoices', () => {
  it('offers one-tap choices rather than a date to type (§13)', () => {
    const choices = relativeDateChoices(NOON);
    expect(choices.length).toBeGreaterThanOrEqual(3);
    for (const c of choices) {
      expect(isValidDateString(c.value), c.value).toBe(true);
      expect(daysUntil(c.value, NOON)!).toBeGreaterThan(0);
    }
  });

  it('gets the end of a 31-day month right', () => {
    expect(relativeDateChoices(NOON)[0]).toEqual({ label: 'End of month', value: '2026-03-31' });
  });

  it('gets the end of February right, leap year and not', () => {
    const [feb2026] = relativeDateChoices(new Date(2026, 1, 10));
    expect(feb2026.value).toBe('2026-02-28');
    const [feb2028] = relativeDateChoices(new Date(2028, 1, 10));
    expect(feb2028.value).toBe('2028-02-29');
  });

  it('drops "End of month" when today IS the end of the month', () => {
    // Otherwise the form opens offering a deadline that has already arrived,
    // which reads as a bug on a screen about a future obligation.
    const choices = relativeDateChoices(new Date(2026, 2, 31, 10, 0));
    expect(choices.map((c) => c.label)).not.toContain('End of month');
    for (const c of choices) expect(daysUntil(c.value, new Date(2026, 2, 31))!).toBeGreaterThan(0);
  });

  it('never produces duplicate dates', () => {
    for (const day of [1, 15, 28, 30, 31]) {
      const choices = relativeDateChoices(new Date(2026, 0, day));
      expect(new Set(choices.map((c) => c.value)).size, `Jan ${day}`).toBe(choices.length);
    }
  });
});

describe('toDateString', () => {
  it('uses the LOCAL calendar day, never toISOString', () => {
    // toISOString() on a local late-evening date shifts to the next UTC day in
    // any western timezone — so "End of month" would offer the 1st.
    expect(toDateString(new Date(2026, 2, 15, 23, 30))).toBe('2026-03-15');
    expect(toDateString(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
  });
});
