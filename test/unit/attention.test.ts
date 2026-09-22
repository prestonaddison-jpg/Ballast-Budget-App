/**
 * What earns the one card the whole screen emphasises.
 *
 * The focal alert is Von Restorff isolation: ONE thing, or nothing. Its value
 * comes entirely from being right — a card that fires on things needing no
 * action teaches the operator that it means "a date is near" rather than "do
 * something", and then it is worth nothing on the day it matters.
 */

import { describe, expect, it } from 'vitest';
import { ATTENTION_WINDOW_DAYS, nextObligation, obligationCopy } from '../../web/src/lib/attention';
import type { EnvelopeTileModel } from '../../web/src/lib/envelope-math';

/** 2026-03-15, mid-afternoon local. */
const NOW = new Date(2026, 2, 15, 14, 30);

const env = (over: Partial<EnvelopeTileModel>): EnvelopeTileModel => ({
  id: 'e1',
  name: 'Q1 insurance',
  type: 'spend',
  balanceMinor: 100_00,
  targetMinor: 1000_00,
  targetDate: '2026-03-18',
  currency: 'USD',
  ...over,
});

describe('nextObligation', () => {
  it('raises an underfunded bill inside the window', () => {
    const found = nextObligation([env({})], NOW);
    expect(found?.envelope.name).toBe('Q1 insurance');
    expect(found?.daysUntilDue).toBe(3);
    expect(found?.percentFunded).toBe(10);
    expect(found?.tone).toBe('soon');
  });

  it('says nothing about a bill that is already FULL', () => {
    // A funded bill due tomorrow is a success. Putting it on the focal card
    // would be the app raising an alarm about something going right.
    expect(nextObligation([env({ balanceMinor: 1000_00 })], NOW)).toBeNull();
    expect(nextObligation([env({ balanceMinor: 1200_00 })], NOW)).toBeNull();
  });

  it('says nothing about a date beyond the window', () => {
    const justInside = nextObligation([env({ targetDate: '2026-03-29' })], NOW);
    expect(justInside?.daysUntilDue).toBe(ATTENTION_WINDOW_DAYS);
    expect(nextObligation([env({ targetDate: '2026-03-30' })], NOW)).toBeNull();
  });

  it('says nothing when there is no date or no target', () => {
    // Without both there is no notion of being behind, and inventing one
    // would put a demand on screen the operator never agreed to.
    expect(nextObligation([env({ targetDate: null })], NOW)).toBeNull();
    expect(nextObligation([env({ targetMinor: null })], NOW)).toBeNull();
  });

  it('says nothing when the BALANCE is unknown', () => {
    // "You are 0% funded" is not what a null balance means. Claiming someone
    // is behind on a figure the bank has not reported is the same lie as
    // rendering an unknown as $0.
    expect(nextObligation([env({ balanceMinor: null })], NOW)).toBeNull();
  });

  it('never raises unallocated', () => {
    // The residual is not a goal and can never be behind.
    expect(nextObligation([env({ type: 'unallocated', name: 'Unallocated' })], NOW)).toBeNull();
  });

  it('picks the SOONEST, so an overdue bill outranks one due tomorrow', () => {
    const found = nextObligation(
      [
        env({ id: 'a', name: 'Tomorrow', targetDate: '2026-03-16' }),
        env({ id: 'b', name: 'Overdue', targetDate: '2026-03-10' }),
        env({ id: 'c', name: 'Next week', targetDate: '2026-03-22' }),
      ],
      NOW,
    );
    expect(found?.envelope.name).toBe('Overdue');
    expect(found?.daysUntilDue).toBe(-5);
    expect(found?.tone).toBe('past');
  });

  it('breaks a tie on how far behind it is', () => {
    // Same day, so the one with further to go is the one worth naming.
    const found = nextObligation(
      [
        env({ id: 'a', name: 'Nearly there', balanceMinor: 900_00 }),
        env({ id: 'b', name: 'Barely started', balanceMinor: 50_00 }),
      ],
      NOW,
    );
    expect(found?.envelope.name).toBe('Barely started');
  });

  it('returns null for an empty Canvas rather than throwing', () => {
    expect(nextObligation([], NOW)).toBeNull();
  });

  it('ignores an unreadable stored date instead of guessing', () => {
    expect(nextObligation([env({ targetDate: 'next tuesday' })], NOW)).toBeNull();
  });
});

describe('obligationCopy', () => {
  it('states the deadline and the progress, and blames nobody', () => {
    const copy = obligationCopy(nextObligation([env({})], NOW)!);
    expect(copy.title).toBe('Q1 insurance is due in 3 days');
    // Percentage-of-target, never a shortfall. This is the more dangerous
    // place to break that rule than the tile, because it is the one thing the
    // screen emphasises.
    expect(copy.detail).toBe('10% of $1,000 set aside so far.');
    expect(copy.detail).not.toMatch(/short|behind|need|only|must/i);
    expect(`${copy.title} ${copy.detail}`).not.toMatch(/\byou('| a)?re\b|late|failed|should/i);
  });

  it('reads calmly when it is already overdue', () => {
    const copy = obligationCopy(nextObligation([env({ targetDate: '2026-03-13' })], NOW)!);
    expect(copy.title).toBe('Q1 insurance is overdue 2d');
    expect(copy.title).not.toMatch(/you|late|missed/i);
  });

  it('offers an action phrased as the thing to do', () => {
    // An implementation intention: a concrete action, one tap to commit.
    expect(obligationCopy(nextObligation([env({})], NOW)!).action).toBe('Set aside');
  });
});
