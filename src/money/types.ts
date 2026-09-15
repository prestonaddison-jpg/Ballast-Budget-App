/**
 * The money model — domain types (Blueprint §4).
 *
 * Pure. No database, no Plaid, no Worker. Everything here is arithmetic over
 * minor units that can be reasoned about and tested in isolation, which is
 * what §4 means by "core operations (pure, testable)".
 */

import type { Minor } from '../ledger-source/types';

export type { Minor };

/** "Everything is an envelope." (§4) */
export type EnvelopeType = 'unallocated' | 'buffer' | 'tax' | 'spend' | 'save';

export const ENVELOPE_TYPES: readonly EnvelopeType[] = [
  'unallocated',
  'buffer',
  'tax',
  'spend',
  'save',
];

export interface Envelope {
  id: string;
  entityId: string;
  name: string;
  type: EnvelopeType;
  /** Target in minor units, or null for an envelope with no goal. */
  targetMinor: Minor | null;
  /** ISO yyyy-mm-dd. Only meaningful alongside a target. */
  targetDate: string | null;
  /** Canvas grouping. Null falls back to the type's default zone. */
  zone: string | null;
  sortOrder: number;
  archivedAt: number | null;
  completedAt: number | null;
}

/**
 * An envelope with its DERIVED balance.
 *
 * Kept as a separate type from `Envelope` on purpose: §4 says "balances are
 * derived from a ledger, never stored". Making the balance absent from the
 * envelope record itself means no code path can accidentally read a stale
 * stored figure — there is nowhere to read it from.
 */
export interface EnvelopeBalance {
  envelopeId: string;
  balanceMinor: Minor;
}

export type EnvelopeWithBalance = Envelope & { balanceMinor: Minor };

/**
 * Why a ledger movement happened.
 *
 * `external_*` kinds are the ONLY ones that change an entity's total, because
 * they are the only ones where money actually entered or left the real bank
 * accounts. Everything else is the operator relabelling money that is already
 * there — which is the whole of §3: "Reserves are labels, by design. Ballast
 * labels the real balance; it never segregates or moves cash."
 */
export type MovementKind =
  /** Money landed in a real account. Enters at `unallocated`. */
  | 'external_in'
  /** Money left a real account. Leaves from wherever it was allocated. */
  | 'external_out'
  /** Operator moved money between two envelopes (tap-to-fund, moveBetween). */
  | 'allocation'
  /** completeEnvelope sweeping a remainder back to unallocated (§12). */
  | 'sweep'
  /** Reconciliation absorbing drift into unallocated. */
  | 'reconcile'
  /** Compensating entry that reverses an earlier movement (§4 self-heal). */
  | 'reversal';

/** Kinds that change the entity total, i.e. that mirror real cash movement. */
export const EXTERNAL_KINDS: readonly MovementKind[] = ['external_in', 'external_out'];

export function isExternalKind(kind: MovementKind): boolean {
  return EXTERNAL_KINDS.includes(kind);
}

/**
 * One ledger movement.
 *
 * BOTH LEGS ON ONE ROW. `fromEnvelopeId` and `toEnvelopeId` with a strictly
 * POSITIVE amount, rather than two signed rows.
 *
 * This is not a stylistic choice — it is what makes the operation atomic on
 * D1, which has no interactive transactions. The balance check can be folded
 * into the same INSERT that performs the move, so there is no window between
 * reading the balance and spending it. With one row per leg, the guard on the
 * second leg would read a balance the first leg had already changed, and the
 * two legs could not be made to fire or not fire together.
 *
 * `null` on a side means "outside the envelope system": money arriving from a
 * bank account (`from` null) or leaving to one (`to` null).
 */
export interface Movement {
  id: string;
  entityId: string;
  fromEnvelopeId: string | null;
  toEnvelopeId: string | null;
  /** ALWAYS positive. Direction is carried by from/to, never by a sign. */
  amountMinor: Minor;
  kind: MovementKind;
  /** Links the movement to the bank transaction that caused it, when any. */
  txnKey: string | null;
  memo: string | null;
  createdAt: number;
  /** Set when a later movement reverses this one. */
  reversedByMovementId: string | null;
}

export class MoneyError extends Error {
  constructor(
    readonly code:
      | 'invalid_amount'
      | 'insufficient_funds'
      | 'same_envelope'
      | 'cross_entity'
      | 'unknown_envelope'
      | 'archived_envelope'
      | 'invariant_violation',
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}
