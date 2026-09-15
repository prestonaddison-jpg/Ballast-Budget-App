/**
 * Quick-amount chips for the fund sheet. PURE — no DOM.
 */

/** Round amounts worth offering, smallest first. */
const ROUND_AMOUNTS = [50_00, 100_00, 250_00, 500_00, 1000_00, 2500_00, 5000_00];

/** Four is the most that fits one row at iPhone width without wrapping. */
const MAX_CHIPS = 4;

/**
 * Amount chips worth offering.
 *
 * Only amounts the operator can actually afford are shown — offering a chip
 * that fails on tap is the kind of small dishonesty that erodes trust in the
 * numbers.
 *
 * THE SELECTION IS BY USEFULNESS, NOT BY SIZE, and that is the whole point.
 * An earlier version collected candidates, sorted them ascending and took the
 * first four. With $15,000 available that returned $50, $100, $250 and $500 —
 * four chips, every one of them trivial against the balance, and "all of it"
 * dropped off the end by the sort. The chips exist so the common case is ONE
 * TAP and no typing (§13); a set like that guarantees typing, which is exactly
 * the friction an ADHD-first surface cannot afford.
 *
 * So the two chips that encode an INTENT — "fill it" and "all of it" — are
 * chosen first and can never be crowded out. Round amounts then fill whatever
 * room is left, and they are drawn from a ladder that reaches far enough up to
 * stay meaningful at a large balance.
 */
export function suggestAmounts(
  availableMinor: number | null,
  balanceMinor: number | null,
  targetMinor: number | null,
): number[] {
  if (availableMinor == null || availableMinor <= 0) return [];

  const chosen = new Set<number>();

  // 1. "Fill it" — usually the thing the operator actually means. Needs a
  //    known balance: without one the remainder is computed from a number we
  //    do not have.
  if (targetMinor != null && balanceMinor != null) {
    const remaining = Math.min(targetMinor - balanceMinor, availableMinor);
    if (remaining > 0) chosen.add(remaining);
  }

  // 2. "All of it" — the other intent, and the one the old ordering lost.
  chosen.add(availableMinor);

  // 3. Round amounts fill the remaining slots. Taken from the LARGEST
  //    affordable downwards, so they stay proportionate to the balance
  //    instead of clustering at the bottom of the ladder.
  const affordable = ROUND_AMOUNTS.filter((n) => n < availableMinor).reverse();
  for (const round of affordable) {
    if (chosen.size >= MAX_CHIPS) break;
    chosen.add(round);
  }

  // Ascending for display: the chips read as a ramp, and the intent chips land
  // wherever their magnitude puts them rather than in a special position.
  return [...chosen].sort((a, b) => a - b).slice(0, MAX_CHIPS);
}
