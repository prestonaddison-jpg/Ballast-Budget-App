/**
 * Quick-amount chips for the fund sheet. PURE — no DOM.
 */

/**
 * Amount chips worth offering.
 *
 * Only amounts the operator can actually afford are shown — offering a chip
 * that fails on tap is the kind of small dishonesty that erodes trust in the
 * numbers. Deduplicated and sorted so "fill it" does not appear twice.
 */
export function suggestAmounts(
  availableMinor: number | null,
  balanceMinor: number,
  targetMinor: number | null,
): number[] {
  if (availableMinor == null || availableMinor <= 0) return [];

  const candidates: number[] = [];
  if (targetMinor != null) {
    const remaining = targetMinor - balanceMinor;
    if (remaining > 0) candidates.push(Math.min(remaining, availableMinor));
  }
  for (const round of [50_00, 100_00, 250_00, 500_00]) {
    if (round <= availableMinor) candidates.push(round);
  }
  candidates.push(availableMinor);

  return [...new Set(candidates)]
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
    .slice(0, 4);
}
