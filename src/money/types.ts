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
 * Why a ledger entry was written.
 *
 * NOTE WHAT IS ABSENT: there is no `external_in` / `external_out`. THE LEDGER
 * IS CLOSED — every entry moves money between two envelopes of one entity, and
 * a bank event cannot reach it at all. Money arriving or leaving is reflected
 * automatically because `unallocated` is the residual of cash minus the named
 * envelopes (see migrations/0002). That is §3 expressed structurally:
 * "Ballast labels the real balance; it never segregates or moves cash" — there
 * is no cash in this ledger to move.
 */
export type EntryKind =
  /** Operator moved money from unallocated into a purpose envelope. */
  | 'fund'
  /** Operator moved money between two named envelopes. */
  | 'move'
  /** completeEnvelope returning a remainder to unallocated (§12). */
  | 'sweep'
  /** Compensating entry reversing an earlier one (§4 "reversals self-heal"). */
  | 'reversal'
  /** Written by approveProposal in Slice 2. */
  | 'proposal';

/**
 * One ledger entry.
 *
 * BOTH LEGS ON ONE ROW, with a strictly POSITIVE amount and direction carried
 * by from/to rather than by a sign.
 *
 * This is what makes the write atomic on D1, which has no interactive
 * transactions: the balance guard folds into the same INSERT that performs the
 * move, so there is no window between reading a balance and spending it. With
 * one row per signed leg, the guard on the second leg would read a balance the
 * first leg had already changed, and the two legs could not be made to fire or
 * not fire together.
 *
 * Both endpoints are NON-NULL and belong to the same entity — enforced by
 * composite foreign key, so a cross-entity transfer is unrepresentable.
 */
export interface LedgerEntry {
  id: string;
  entityId: string;
  fromEnvelopeId: string;
  toEnvelopeId: string;
  /** ALWAYS positive. Direction is from/to, never a sign. */
  amountMinor: Minor;
  kind: EntryKind;
  /** The bank transaction that motivated this, if any. Advisory only. */
  txnKey: string | null;
  /** Makes a retried request a no-op rather than a double allocation. */
  idempotencyKey: string | null;
  memo: string | null;
  createdAt: number;
  /** Set on the COMPENSATING entry, pointing at what it reverses. */
  reversesEntryId: string | null;
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
      | 'not_completable'
      | 'invariant_violation',
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}
