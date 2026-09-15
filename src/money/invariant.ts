/**
 * The conservation invariant (Blueprint §4).
 *
 *   "Conservation invariant (per entity): Σ(envelopes) = Σ(budgetable
 *    accounts), with `unallocated` absorbing slack."
 *
 * Pure arithmetic, deliberately separated from storage so the rule can be
 * tested exhaustively without a database and so there is exactly ONE
 * definition of what "in balance" means.
 *
 * WHY THE INVARIANT IS THE WHOLE APP: every envelope balance is a claim about
 * real money. If the envelopes sum to more than the bank actually holds, then
 * "safe to spend" is a lie in the most dangerous direction — the operator
 * spends money that is already committed. The invariant is what makes the
 * hero number honest.
 *
 * AND WHY IT IS PER-ENTITY: §3 forbids commingling. Each entity is a separate
 * legal person with its own bank accounts, so a global sum that happened to
 * balance while one entity was over and another under would be exactly the
 * error the all-LLC structure exists to prevent.
 */

import type { Minor } from './types';

export interface AccountCash {
  accountId: string;
  /**
   * AVAILABLE balance (posted minus holds), per §4 — never current, never
   * pending. NULL means the institution did not report one, which is UNKNOWN
   * and emphatically not zero.
   */
  availableMinor: Minor | null;
  budgetable: boolean;
}

export type InvariantStatus =
  /** Envelopes and cash agree exactly. */
  | 'balanced'
  /** Cash exceeds envelopes: new money has landed and needs allocating. */
  | 'cash_ahead'
  /** Envelopes exceed cash: money left the account after being allocated. */
  | 'envelopes_ahead'
  /**
   * At least one budgetable account did not report an available balance, so
   * the comparison cannot be made at all. This is its own state, not a
   * failure — treating unknown cash as zero would make every envelope look
   * over-allocated and trigger a spurious correction.
   */
  | 'indeterminate';

export interface InvariantCheck {
  status: InvariantStatus;
  /** Sum of every envelope balance for the entity. */
  envelopeTotalMinor: Minor;
  /** Sum of available balances across budgetable accounts, or null. */
  cashTotalMinor: Minor | null;
  /**
   * cash − envelopes. Positive means unallocated should absorb it; negative
   * means it must be taken back out. Null when indeterminate.
   */
  driftMinor: Minor | null;
  /** Accounts that could not be counted, by id. */
  unknownAccountIds: string[];
}

export function sumEnvelopeBalances(balances: readonly { balanceMinor: Minor }[]): Minor {
  return balances.reduce((total, b) => total + b.balanceMinor, 0);
}

/**
 * Compare envelope claims against real cash for ONE entity.
 *
 * Callers must pass only that entity's envelopes and only that entity's
 * accounts; mixing entities here would silently net one against another.
 */
/**
 * DIAGNOSTIC, not a gate.
 *
 * Under the residual design (migrations/0002) conservation is an algebraic
 * identity, so `balanced` is the only outcome this can report when the data is
 * consistent — which makes it a useful CANARY: a 'cash_ahead' or
 * 'envelopes_ahead' result means something upstream is broken, not that a
 * routine reconciliation is due.
 *
 * `envelopes_ahead` is the one case an operator will genuinely see, and it is
 * not a bug: it means cash fell below what has already been allocated, so
 * unallocated has gone negative. That is real and must be SHOWN — "you are
 * over-allocated by $300" — rather than smoothed away.
 */
export function checkInvariant(
  envelopeBalances: readonly { balanceMinor: Minor }[],
  accounts: readonly AccountCash[],
): InvariantCheck {
  const envelopeTotalMinor = sumEnvelopeBalances(envelopeBalances);
  const budgetable = accounts.filter((a) => a.budgetable);

  const unknownAccountIds = budgetable
    .filter((a) => a.availableMinor == null)
    .map((a) => a.accountId);

  if (unknownAccountIds.length > 0) {
    return {
      status: 'indeterminate',
      envelopeTotalMinor,
      cashTotalMinor: null,
      driftMinor: null,
      unknownAccountIds,
    };
  }

  const cashTotalMinor = budgetable.reduce((total, a) => total + (a.availableMinor ?? 0), 0);
  const driftMinor = cashTotalMinor - envelopeTotalMinor;

  return {
    status: driftMinor === 0 ? 'balanced' : driftMinor > 0 ? 'cash_ahead' : 'envelopes_ahead',
    envelopeTotalMinor,
    cashTotalMinor,
    driftMinor,
    unknownAccountIds,
  };
}

/**
 * "Safe to spend" — the honest hero number (§14).
 *
 *   balance − reserved
 *
 * Which, given the invariant, is exactly the `unallocated` balance: every
 * other envelope is by definition money with a job. Expressed as a named
 * function rather than inlined so that the definition lives in one place and
 * cannot quietly drift into "current balance" somewhere in the UI.
 *
 * Returns null when the invariant is indeterminate: if the bank has not told
 * us what is available, the honest answer is "we don't know", never a
 * confident figure computed from stale cash.
 */
export function safeToSpend(check: InvariantCheck, unallocatedBalanceMinor: Minor): Minor | null {
  if (check.status === 'indeterminate') return null;
  // Never present a negative as spendable; below zero the honest figure is 0
  // plus an over-allocation warning, which the caller surfaces separately.
  return Math.max(0, unallocatedBalanceMinor);
}
