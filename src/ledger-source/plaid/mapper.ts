/**
 * Plaid -> Ballast normalization.
 *
 * This file is the ONLY place a Plaid quirk is allowed to be converted. If a
 * sign flip, a null coercion, or an enum translation appears anywhere else in
 * the codebase, it is a bug.
 */

import type {
  PlaidAccount,
  PlaidTransactionStreamAmount,
  PlaidRecurringFrequency,
  PlaidStreamStatus,
  PlaidTransaction,
  PlaidTransactionStream,
  PlaidTransactionsUpdateStatus,
} from './api-types';
import type {
  AccountSubtype,
  AccountType,
  Minor,
  RecurringStream,
  SourceAccount,
  SourceTransaction,
  StreamCadence,
  StreamMaturity,
  SyncPage,
} from '../types';
import { resolveTxnKey, type TxnKeyResolver } from '../txn-key';

/**
 * Convert a Plaid major-unit decimal into minor units.
 *
 * Plaid sends amounts as JSON numbers (IEEE-754 doubles), so 12.34 is not
 * exactly representable and `12.34 * 100` is 1233.9999999999998. Rounding —
 * not truncation — is therefore mandatory; truncating would lose a cent on a
 * large fraction of real transactions and quietly break the conservation
 * invariant over time.
 */
export function toMinor(amount: number): Minor {
  return Math.round(amount * 100);
}

/**
 * THE SIGN FLIP.
 *
 * Plaid: positive = money OUT of the account; negative = money IN.
 * Ballast: positive = money IN.
 *
 * Every deposit the allocation waterfall sees is positive because of this one
 * negation. Getting it backwards would make the tax skim run on spending and
 * treat income as an outflow.
 */
export function normalizeAmount(plaidAmount: number): Minor {
  const minor = toMinor(plaidAmount);
  // Negating 0 yields -0, which is === 0 but NOT Object.is-equal to it. That
  // difference leaks into sorting, Math.sign, grouping keys and test
  // assertions, so it is collapsed here rather than left to surprise a caller.
  return minor === 0 ? 0 : -minor;
}

function mapAccountType(type: PlaidAccount['type']): AccountType {
  switch (type) {
    case 'depository':
      return 'depository';
    case 'credit':
      return 'credit';
    case 'loan':
      return 'loan';
    case 'investment':
    case 'brokerage':
      return 'investment';
    default:
      return 'other';
  }
}

const SUBTYPES: ReadonlySet<string> = new Set([
  'checking',
  'savings',
  'money market',
  'cd',
  'credit card',
  'line of credit',
]);

function mapAccountSubtype(subtype: string | null): AccountSubtype {
  if (!subtype) return 'other';
  const normalized = subtype.toLowerCase();
  if (!SUBTYPES.has(normalized)) return 'other';
  return normalized.replace(/ /g, '_') as AccountSubtype;
}

/**
 * Which accounts can hold budgetable business cash.
 *
 * Only depository checking/savings/money-market count. Credit and loan
 * accounts are liabilities — including them would break the per-entity
 * conservation invariant, which sums envelopes against BUDGETABLE accounts
 * (§4). Card handling is dormant by design (§11).
 */
function isBudgetable(type: AccountType, subtype: AccountSubtype): boolean {
  return (
    type === 'depository' &&
    (subtype === 'checking' || subtype === 'savings' || subtype === 'money_market')
  );
}

export function mapAccount(account: PlaidAccount): SourceAccount {
  const type = mapAccountType(account.type);
  const subtype = mapAccountSubtype(account.subtype);
  const balances = account.balances;

  return {
    sourceAccountId: account.account_id,
    name: account.name,
    officialName: account.official_name,
    mask: account.mask,
    type,
    subtype,
    // Balances are NOT sign-flipped: a balance is a position, not a movement.
    // Null is preserved as null — "unknown available balance" must never be
    // silently rendered as $0.00 spendable.
    availableMinor: balances.available == null ? null : toMinor(balances.available),
    currentMinor: balances.current == null ? null : toMinor(balances.current),
    limitMinor: balances.limit == null ? null : toMinor(balances.limit),
    currency: balances.iso_currency_code ?? balances.unofficial_currency_code ?? 'USD',
    budgetable: isBudgetable(type, subtype),
  };
}

/**
 * Pick the counterparty used for §6 "counterparty learning".
 *
 * Preference order: Plaid's structured counterparty, then its cleaned merchant
 * name, then nothing. The raw descriptor is deliberately NOT used as a
 * fallback — descriptors carry trace ids and dates that differ per
 * transaction, so learning on them would never match twice.
 */
function pickCounterparty(txn: PlaidTransaction): string | null {
  const first = txn.counterparties?.[0]?.name;
  if (first) return first;
  return txn.merchant_name ?? null;
}

export function mapTransaction(txn: PlaidTransaction, resolver: TxnKeyResolver): SourceTransaction {
  return {
    txnKey: resolveTxnKey(
      { transactionId: txn.transaction_id, pendingTransactionId: txn.pending_transaction_id },
      resolver,
    ),
    sourceTransactionId: txn.transaction_id,
    supersedesSourceId: txn.pending_transaction_id,
    sourceAccountId: txn.account_id,
    amountMinor: normalizeAmount(txn.amount),
    currency: txn.iso_currency_code ?? txn.unofficial_currency_code ?? 'USD',
    date: txn.date,
    authorizedDate: txn.authorized_date ?? null,
    // original_description is the raw bank descriptor and the better
    // classifier signal; `name` is Plaid's cleaned version. Prefer raw, since
    // Square payout descriptors are matched on it (§6).
    description: txn.original_description ?? txn.name,
    merchantName: txn.merchant_name ?? null,
    counterparty: pickCounterparty(txn),
    pending: txn.pending,
    categoryHint: txn.personal_finance_category?.detailed ?? null,
  };
}

function mapHistoryStatus(status: PlaidTransactionsUpdateStatus): SyncPage['historyStatus'] {
  switch (status) {
    case 'NOT_READY':
      return 'not_ready';
    case 'INITIAL_UPDATE_COMPLETE':
      return 'initial_complete';
    case 'HISTORICAL_UPDATE_COMPLETE':
      return 'historical_complete';
    default:
      return 'unknown';
  }
}

const CADENCE: Record<PlaidRecurringFrequency, StreamCadence> = {
  UNKNOWN: 'unknown',
  WEEKLY: 'weekly',
  BIWEEKLY: 'biweekly',
  SEMI_MONTHLY: 'semi_monthly',
  MONTHLY: 'monthly',
  // The one that catches the annual insurance premium people forget (§9).
  ANNUALLY: 'annually',
};
// NOTE: Plaid has no DAILY and no QUARTERLY cadence. A quarterly bill — which
// for Ballast includes the quarterly estimated-tax payment — lands in UNKNOWN.
// Anything consuming `cadence` must therefore handle 'unknown' as a real,
// common case rather than an error, or quarterly obligations vanish from the
// forward view (§9).

const MATURITY: Record<PlaidStreamStatus, StreamMaturity> = {
  UNKNOWN: 'unknown',
  MATURE: 'mature',
  EARLY_DETECTION: 'early_detection',
  TOMBSTONED: 'tombstoned',
};

function streamCurrency(amount: PlaidTransactionStreamAmount): string | null {
  return amount.iso_currency_code ?? amount.unofficial_currency_code ?? null;
}

export function mapStream(stream: PlaidTransactionStream): RecurringStream {
  return {
    streamId: stream.stream_id,
    sourceAccountId: stream.account_id,
    description: stream.description,
    merchantName: stream.merchant_name,
    // Same sign flip as transactions: an obligation stream is money OUT, so it
    // normalizes negative.
    lastAmountMinor: normalizeAmount(stream.last_amount.amount ?? 0),
    averageAmountMinor: normalizeAmount(stream.average_amount.amount ?? 0),
    currency: streamCurrency(stream.last_amount) ?? streamCurrency(stream.average_amount) ?? 'USD',
    cadence: CADENCE[stream.frequency] ?? 'unknown',
    maturity: MATURITY[stream.status] ?? 'unknown',
    isActive: stream.is_active,
    firstDate: stream.first_date,
    lastDate: stream.last_date,
    // Doubly absent-able: `?: string | null`, and only set when Plaid can
    // predict the next occurrence at all.
    predictedNextDate: stream.predicted_next_date ?? null,
    // Plaid deprecated stream modification; this is documented to always be
    // false. Carried through so the field exists, never built upon.
    userModified: stream.is_user_modified ?? false,
  };
}

export function mapSyncPage(
  response: {
    accounts: PlaidAccount[];
    added: PlaidTransaction[];
    modified: PlaidTransaction[];
    removed: Array<{ transaction_id: string; account_id: string }>;
    next_cursor: string;
    has_more: boolean;
    transactions_update_status: PlaidTransactionsUpdateStatus;
  },
  resolver: TxnKeyResolver,
): SyncPage {
  return {
    added: response.added.map((t) => mapTransaction(t, resolver)),
    modified: response.modified.map((t) => mapTransaction(t, resolver)),
    removed: response.removed.map((r) => ({
      sourceTransactionId: r.transaction_id,
      sourceAccountId: r.account_id,
    })),
    accounts: response.accounts.map(mapAccount),
    nextCursor: response.next_cursor,
    hasMore: response.has_more,
    historyStatus: mapHistoryStatus(response.transactions_update_status),
  };
}
