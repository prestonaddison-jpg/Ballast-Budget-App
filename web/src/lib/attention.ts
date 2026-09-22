/**
 * What actually needs the operator, derived from the envelopes. PURE.
 *
 * A date on a tile is information. The focal alert is the app pointing at ONE
 * thing and saying do this next — Von Restorff isolation (§13) plus an
 * implementation intention (Gollwitzer & Sheeran 2006): a concrete action with
 * a concrete when, one tap to commit.
 *
 * WHAT COUNTS AND WHAT DOES NOT. An obligation earns the card only when all
 * three are true:
 *
 *   · it has a target AND a date — without both there is no notion of "behind"
 *   · it is not yet full — a funded bill needs nothing, however close it is
 *   · it lands inside the window in which acting is still possible
 *
 * A fully funded bill due tomorrow is a SUCCESS, and putting it on the one
 * card the whole screen emphasises would teach the operator that the card
 * means "a date is near" rather than "do something". They would stop reading
 * it, and then it would be worth nothing on the day it mattered.
 */

import { daysUntil, dueTone, duePhrase, type DueTone } from './due-date';
import { fundedFraction, formatMoney, type EnvelopeTileModel } from './envelope-math';

/**
 * How far ahead an obligation is worth raising.
 *
 * Two weeks: long enough that a business with weekly deposits has a real
 * chance to act, short enough that the card is not permanently occupied by
 * something three months out. Past that a date belongs on the tile, which is
 * where it already is.
 */
export const ATTENTION_WINDOW_DAYS = 14;

export interface Obligation {
  envelope: EnvelopeTileModel;
  daysUntilDue: number;
  tone: DueTone;
  /** 0-100. Always defined: an obligation without progress is not one. */
  percentFunded: number;
}

/**
 * The single most pressing underfunded obligation, or null.
 *
 * Ordered by date, soonest first, so an overdue bill outranks one due
 * tomorrow. Ties break on how far behind it is — between two bills due on the
 * same day, the one with further to go is the one worth naming.
 */
export function nextObligation(
  envelopes: readonly EnvelopeTileModel[],
  now: Date = new Date(),
): Obligation | null {
  const candidates: Obligation[] = [];

  for (const envelope of envelopes) {
    // Unallocated is the residual, not a goal. It has no deadline and can
    // never be "behind".
    if (envelope.type === 'unallocated') continue;

    const days = daysUntil(envelope.targetDate, now);
    if (days == null || days > ATTENTION_WINDOW_DAYS) continue;

    const fraction = fundedFraction(envelope.balanceMinor, envelope.targetMinor);
    // Null covers both "no target" and "balance unknown". Neither supports a
    // claim that the operator is behind on it.
    if (fraction == null || fraction >= 1) continue;

    candidates.push({
      envelope,
      daysUntilDue: days,
      tone: dueTone(days),
      percentFunded: Math.round(fraction * 100),
    });
  }

  candidates.sort((a, b) => a.daysUntilDue - b.daysUntilDue || a.percentFunded - b.percentFunded);
  return candidates[0] ?? null;
}

export interface ObligationCopy {
  title: string;
  detail: string;
  action: string;
}

/**
 * The words on the card.
 *
 * Percentage-of-target, never a shortfall — same rule as the tile, and the
 * card is the more dangerous place to break it because it is the one thing the
 * screen emphasises. "You're $4,700 short, due in 12 days" is the sentence
 * that makes someone close the app and not open it again until it is too late.
 */
export function obligationCopy(obligation: Obligation): ObligationCopy {
  const { envelope, percentFunded, daysUntilDue } = obligation;
  return {
    title: `${envelope.name} is ${duePhrase(daysUntilDue)}`,
    detail: `${percentFunded}% of ${formatMoney(envelope.targetMinor, envelope.currency)} set aside so far.`,
    action: 'Set aside',
  };
}
