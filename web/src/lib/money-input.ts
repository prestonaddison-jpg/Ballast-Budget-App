/**
 * Parsing a typed money amount. PURE — no DOM.
 *
 * Money is INTEGER minor units everywhere in Ballast, so the ONE place a
 * human-typed decimal becomes an integer is here. Doing it inline at a call
 * site is how `12.34 * 100 = 1233.9999999999998` gets into a ledger.
 */

export type ParseResult =
  | { ok: true; minor: number }
  | { ok: false; reason: 'empty' | 'not_a_number' | 'too_precise' | 'not_positive' };

export function parseMoneyToMinor(input: string): ParseResult {
  const trimmed = input.trim().replace(/[$,\s]/g, '');
  if (!trimmed) return { ok: false, reason: 'empty' };

  if (!/^\d*(\.\d*)?$/.test(trimmed)) return { ok: false, reason: 'not_a_number' };

  const [whole, fraction = ''] = trimmed.split('.');
  // More than two decimals is not a rounding decision Ballast should make
  // silently on the operator's behalf.
  if (fraction.length > 2) return { ok: false, reason: 'too_precise' };

  const cents = Number.parseInt(`${whole || '0'}${fraction.padEnd(2, '0')}`, 10);
  if (!Number.isFinite(cents)) return { ok: false, reason: 'not_a_number' };
  if (cents <= 0) return { ok: false, reason: 'not_positive' };
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: 'not_a_number' };

  return { ok: true, minor: cents };
}

export const PARSE_MESSAGE: Record<Exclude<ParseResult, { ok: true }>['reason'], string> = {
  empty: 'Enter an amount.',
  not_a_number: "That doesn't look like an amount.",
  too_precise: 'Amounts go to the cent.',
  not_positive: 'Enter an amount above zero.',
};
