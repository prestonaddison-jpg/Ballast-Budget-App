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
  /** Current balance in minor units. Derived from the ledger, never stored. */
  balanceMinor: number;
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

/** Whole dollars: cents are noise on a glanceable surface. */
export function formatMoney(minor: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}

/** Cents included, for the detail view and accessible names. */
export function formatMoneyExact(minor: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

/**
 * Funded fraction, clamped to [0,1].
 *
 * Returns null when there is no target — an envelope without one is not "0%
 * funded", it simply has no notion of progress, and rendering an empty bar
 * would imply a goal the operator never set.
 */
export function fundedFraction(balanceMinor: number, targetMinor: number | null): number | null {
  if (targetMinor == null || targetMinor <= 0) return null;
  const raw = balanceMinor / targetMinor;
  return raw < 0 ? 0 : raw > 1 ? 1 : raw;
}
