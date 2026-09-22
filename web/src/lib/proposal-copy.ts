/**
 * How a proposal reads on screen (Blueprint §13, §14).
 *
 * Pure: strings in, strings out, no DOM. The component that draws the card is
 * a separate file so that the WORDING — which is the part with rules attached
 * — can be tested without a browser.
 *
 * The rules, restated because they are easy to lose under a deadline:
 *
 *   · No shame. "Unassigned spend", never "you forgot to categorise this".
 *   · Never render an unknown as a number. A source balance the bank has not
 *     reported is an em dash and a sentence, never a confident figure.
 *   · No dead controls, and no control the server will refuse. A proposal that
 *     no longer fits says so and offers Dismiss instead of Approve.
 */

import { formatMoney } from './envelope-math';
import type { ApiProposal } from './api';

/** What the operator is being asked about, in their words rather than ours. */
const KIND_LABEL: Record<ApiProposal['kind'], string> = {
  income_allocation: 'Income landed',
  salary_draw: 'Owner draw',
  buffer_action: 'Buffer',
  unassigned_spend: 'Unassigned spend',
  tax_skim: 'Tax set-aside',
  waterfall: 'Waterfall',
};

/**
 * Whether the source can cover it RIGHT NOW.
 *
 * Three states, not two. `unknown` exists because a null balance is not a
 * small "no" — it is the bank having told us nothing, and flattening it to
 * "can't afford" would be inventing a fact about the operator's money.
 */
export type Affordability = 'fits' | 'short' | 'unknown';

export interface ProposalPresentation {
  /** The chip above the headline. */
  kindLabel: string;
  /**
   * The money, large. Always known: a proposal without an amount cannot be
   * written, so this is the one figure on the screen that is never an em dash.
   */
  amountText: string;
  /** "Unallocated → Tax", as words. */
  routeText: string;
  /** The operator's own note, or the reason it was suggested. */
  memoText: string | null;
  affordability: Affordability;
  /** Present only when something stands in the way. Plain, never scolding. */
  blockerText: string | null;
  /** False hides Approve entirely rather than rendering it to be refused. */
  canApprove: boolean;
}

export function presentProposal(p: ApiProposal): ProposalPresentation {
  const affordability: Affordability =
    p.affordableNow == null ? 'unknown' : p.affordableNow ? 'fits' : 'short';

  const from = p.from.name ?? 'another envelope';
  const to = p.to.name ?? 'another envelope';

  let blockerText: string | null = null;
  if (affordability === 'short') {
    // States the gap as a fact about the balance, not a failure of the
    // operator, and names the figure so the next move is obvious.
    blockerText =
      p.sourceBalanceMinor == null
        ? null
        : `${from} holds ${formatMoney(p.sourceBalanceMinor)} — this no longer fits.`;
  } else if (affordability === 'unknown') {
    blockerText = `${from} hasn't reported a balance yet, so this can't be approved.`;
  }

  return {
    kindLabel: KIND_LABEL[p.kind],
    amountText: formatMoney(p.amountMinor),
    routeText: `${from} → ${to}`,
    memoText: p.memo,
    affordability,
    blockerText,
    // Only 'fits' offers the action. Drawing Approve on a proposal the server
    // will refuse is the "dead control" rule in its worst form: not a button
    // that does nothing, but one that does something and fails.
    canApprove: affordability === 'fits',
  };
}

/** The Now-Bar pill, which must agree with what the queue actually shows. */
export function queuePillText(pendingCount: number): string {
  if (pendingCount === 0) return 'Nothing needs you';
  return pendingCount === 1 ? '1 needs you' : `${pendingCount} need you`;
}
