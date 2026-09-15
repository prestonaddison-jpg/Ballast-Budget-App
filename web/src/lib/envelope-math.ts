/**
 * Envelope presentation math. PURE — no DOM.
 *
 * Kept separate from the tile component so it can be unit-tested without a
 * browser environment, and so the rules below live somewhere a reader can find
 * them without wading through element construction.
 */

export type EnvelopeType = 'unallocated' | 'buffer' | 'tax' | 'spend' | 'save';

export interface EnvelopeTileModel {
  id: string;
  name: string;
  type: EnvelopeType;
  /**
   * Current balance in minor units, or NULL when it is genuinely unknown.
   *
   * Only `unallocated` can be null, and only when a budgetable account has not
   * reported an available balance. It MUST NOT be coerced to 0 for display:
   * "we don't know" and "you have nothing" are different facts, and the second
   * one is a lie told in the dangerous direction (§14). Everything downstream
   * of this type branches on the null rather than defaulting it away.
   */
  balanceMinor: number | null;
  /** Target in minor units, or null for an envelope with no target. */
  targetMinor: number | null;
  targetDate?: string | null;
  currency: string;
}

export const TYPE_LABEL: Record<EnvelopeType, string> = {
  unallocated: 'Unallocated',
  buffer: 'Buffer',
  tax: 'Tax',
  spend: 'Spend',
  save: 'Save',
};

/**
 * The one rendering of an unknown amount. An em dash, never "$0.00".
 *
 * Exported so the tile, the hero and the sheet cannot drift into three
 * different ways of admitting the same thing.
 */
export const UNKNOWN_AMOUNT = '\u2014';

/** Whole dollars: cents are noise on a glanceable surface. */
export function formatMoney(minor: number | null, currency = 'USD'): string {
  if (minor == null) return UNKNOWN_AMOUNT;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}

/** Cents included, for the detail view and accessible names. */
export function formatMoneyExact(minor: number | null, currency = 'USD'): string {
  if (minor == null) return UNKNOWN_AMOUNT;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

/**
 * Funded fraction, clamped to [0,1].
 *
 * Returns null when there is no target — an envelope without one is not "0%
 * funded", it simply has no notion of progress, and rendering an empty bar
 * would imply a goal the operator never set.
 */
export function fundedFraction(
  balanceMinor: number | null,
  targetMinor: number | null,
): number | null {
  // An unknown balance has no known progress either. Drawing an empty bar
  // would read as "0% funded", which is a claim we cannot make.
  if (balanceMinor == null) return null;
  if (targetMinor == null || targetMinor <= 0) return null;
  const raw = balanceMinor / targetMinor;
  return raw < 0 ? 0 : raw > 1 ? 1 : raw;
}

/* -------------------------------------------------------------------------
 * Tile presentation
 *
 * Extracted from the component so the RULES below are unit-testable. The tests
 * run inside workerd, where there is no `document`, so anything expressed as
 * element construction is effectively untested — and these particular rules
 * are too important to leave that way.
 * ---------------------------------------------------------------------- */

/**
 * Whether the small uppercase type chip is worth showing.
 *
 * "Unallocated / UNALLOCATED" printed the same word twice across one narrow
 * tile and pushed the NAME into an ellipsis — "Unall…" — so the redundant
 * label survived and the real one was the casualty.
 */
export function showsTypeChip(envelope: EnvelopeTileModel): boolean {
  return envelope.name.trim().toLowerCase() !== TYPE_LABEL[envelope.type].toLowerCase();
}

export interface TilePresentation {
  /** The big number. */
  amountText: string;
  /** The same thing said out loud, for the accessible name. */
  amountLabel: string;
  /** 0-100, or null to draw NO bar at all. */
  progressPercent: number | null;
  /** The line under the amount, or null for none. */
  captionText: string | null;
}

/**
 * Everything the tile renders, decided in one place.
 *
 * The visual and the accessible name are derived together here rather than
 * built twice in the component, because the one time they drifted apart the
 * screen-reader version was the one that went wrong and nobody noticed.
 */
export function presentTile(envelope: EnvelopeTileModel): TilePresentation {
  const { balanceMinor, targetMinor, currency, type } = envelope;
  const fraction = fundedFraction(balanceMinor, targetMinor);

  if (balanceMinor == null) {
    return {
      amountText: UNKNOWN_AMOUNT,
      // An em dash is announced as nothing at all, so a screen-reader user
      // would hear the envelope's name and no amount whatsoever and have no
      // way to tell that from a zero. Spell it out.
      amountLabel: 'amount not reported by your bank',
      // No bar. A 0% bar is a claim about how full the envelope is, and that
      // is precisely the claim we cannot make.
      progressPercent: null,
      captionText: 'waiting on your bank',
    };
  }

  return {
    amountText: formatMoney(balanceMinor, currency),
    amountLabel: formatMoneyExact(balanceMinor, currency),
    progressPercent: fraction == null ? null : Math.round(fraction * 100),
    captionText:
      fraction != null && targetMinor != null
        ? // Percentage-of-target, never "short by". Same arithmetic, opposite
          // emotional register — and the shortfall framing is the one that
          // makes people avoid opening the app.
          `${Math.round(fraction * 100)}% of ${formatMoney(targetMinor, currency)}`
        : type === 'unallocated'
          ? 'ready to allocate'
          : null,
  };
}
