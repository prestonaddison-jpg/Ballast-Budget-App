/**
 * The LedgerSource boundary (§15).
 *
 * "A thin `LedgerSource` normalization boundary keeps Plaid as the sole
 * implementation (not a multi-adapter)."
 *
 * The point of this boundary is NOT provider portability for its own sake —
 * Plaid is the only implementation and no second one is planned. The point is
 * that every provider quirk is converted EXACTLY ONCE, here, so the money
 * model downstream never has to know about them. Three quirks in particular
 * would otherwise leak into the allocation waterfall and corrupt it silently:
 *
 *   1. SIGN. Plaid states: "Positive values when money moves out of the
 *      account; negative values when money moves in... direct deposits and
 *      refunds are negative." Ballast's domain uses the opposite, intuitive
 *      convention: POSITIVE IS MONEY IN. Every deposit the waterfall sees is a
 *      positive number. The mapper negates; nothing else ever does.
 *   2. IDENTITY. Plaid's `transaction_id` changes when a pending transaction
 *      posts. Ballast assigns a `txnKey` that survives the swap, so receipts
 *      and envelope assignments stay attached.
 *   3. BALANCE. The invariant and "safe to spend" are pinned to AVAILABLE
 *      (posted minus holds), never current or pending — you cannot fund an
 *      envelope with money you cannot spend. Available is nullable at some
 *      institutions, and that must be surfaced, not silently coerced to zero.
 */

/** Currency minor units (cents). Money is never a float in Ballast. */
export type Minor = number;

export type AccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'other';

export type AccountSubtype =
  'checking' | 'savings' | 'money_market' | 'cd' | 'credit_card' | 'line_of_credit' | 'other';

export interface SourceAccount {
  /** Provider account id, stable for the life of the connection. */
  sourceAccountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: AccountType;
  subtype: AccountSubtype;
  /**
   * AVAILABLE balance in minor units — posted minus holds.
   * `null` means the institution did not report one. Callers MUST treat null
   * as "unknown", never as zero: a zero available balance and an unknown one
   * lead to opposite decisions.
   */
  availableMinor: Minor | null;
  /** Current/posted balance. Recorded for reconciliation, not for spending. */
  currentMinor: Minor | null;
  /** Credit limit, for liability accounts (dormant in Phase 0, §11). */
  limitMinor: Minor | null;
  currency: string;
  /** True when this account can hold budgetable business cash. */
  budgetable: boolean;
}

/** Inflow classification (§6). Assigned downstream; carried here as a slot. */
export type InflowType = 'income' | 'transfer' | 'financing' | 'refund' | 'injection';

export interface SourceTransaction {
  /**
   * Ballast's stable surrogate key. Survives the pending -> posted id swap.
   * This — not the provider id — is what receipts and envelope assignments
   * reference.
   */
  txnKey: string;
  /** The provider's id for THIS version of the transaction. Changes on post. */
  sourceTransactionId: string;
  /** The pending transaction this one superseded, if any. */
  supersedesSourceId: string | null;
  sourceAccountId: string;
  /**
   * Signed minor units, NORMALIZED: positive = money into the account.
   * (Plaid's own convention is the reverse; see the file header.)
   */
  amountMinor: Minor;
  currency: string;
  /** Posting date, ISO yyyy-mm-dd. */
  date: string;
  /** When the transaction was authorized, if reported. */
  authorizedDate: string | null;
  /** Raw descriptor as the bank wrote it — the classifier's main signal. */
  description: string;
  /** Provider-cleaned merchant name, when available. */
  merchantName: string | null;
  /** Normalized counterparty name, used for counterparty learning (§6). */
  counterparty: string | null;
  pending: boolean;
  /** Provider's category hint. Advisory only — never authoritative. */
  categoryHint: string | null;
}

export interface SyncPage {
  added: SourceTransaction[];
  modified: SourceTransaction[];
  /** Provider ids only — the provider does not resend the body on removal. */
  removed: RemovedRef[];
  accounts: SourceAccount[];
  nextCursor: string;
  hasMore: boolean;
  /** Whether the provider has finished backfilling history. */
  historyStatus: 'unknown' | 'not_ready' | 'initial_complete' | 'historical_complete';
}

export interface RemovedRef {
  sourceTransactionId: string;
  sourceAccountId: string;
}

/** Cadence of a detected recurring stream (§9). */
export type StreamCadence =
  'unknown' | 'weekly' | 'biweekly' | 'semi_monthly' | 'monthly' | 'annually';

/**
 * Maturity of a detected stream. `early_detection` means the provider has seen
 * fewer than the usual three occurrences — worth proposing to the operator,
 * but flagged as provisional rather than treated as a known obligation.
 */
export type StreamMaturity = 'unknown' | 'mature' | 'early_detection' | 'tombstoned';

export interface RecurringStream {
  streamId: string;
  sourceAccountId: string;
  description: string;
  merchantName: string | null;
  /** Normalized: positive = money in. An obligation is therefore negative. */
  lastAmountMinor: Minor;
  averageAmountMinor: Minor;
  currency: string;
  cadence: StreamCadence;
  maturity: StreamMaturity;
  isActive: boolean;
  firstDate: string;
  lastDate: string;
  /** Provider's predicted next occurrence, if it offers one. */
  predictedNextDate: string | null;
  /** True when the operator edited the stream at the provider. */
  userModified: boolean;
}

export interface RecurringStreams {
  /** Regular money in. A one-off credit OUTSIDE any stream is the §6 flag. */
  inflows: RecurringStream[];
  /** Regular money out — the forward-obligations engine's raw material. */
  outflows: RecurringStream[];
  updatedAt: string | null;
}

/** Health of a linked connection (§14, the "green but dead" rule). */
export type ConnectionStatus =
  | 'ok'
  /** Consent expired or credentials changed: re-auth via update mode. */
  | 'reauth_required'
  /** Provider has warned the connection will drop (~7 days' notice). */
  | 'pending_disconnect'
  | 'revoked_by_user';

export interface LinkedItem {
  sourceItemId: string;
  institutionId: string | null;
  institutionName: string | null;
  status: ConnectionStatus;
  accounts: SourceAccount[];
}

export interface LinkSession {
  /** Short-lived token the client hands to the provider's link UI. */
  linkToken: string;
  expiresAt: string;
}

/** A provider webhook, normalized to the events Ballast acts on. */
export type WebhookEvent =
  | {
      kind: 'sync_available';
      sourceItemId: string;
      initialComplete: boolean;
      historicalComplete: boolean;
    }
  | { kind: 'recurring_updated'; sourceItemId: string; accountIds: string[] }
  | { kind: 'reauth_required'; sourceItemId: string }
  | { kind: 'pending_disconnect'; sourceItemId: string; disconnectsAt: string | null }
  | { kind: 'user_revoked'; sourceItemId: string }
  | { kind: 'connection_repaired'; sourceItemId: string }
  | { kind: 'accounts_available'; sourceItemId: string }
  | { kind: 'error'; sourceItemId: string | null; code: string; message: string }
  | { kind: 'ignored'; type: string; code: string };

export class LedgerSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
  ) {
    // Pass the cause through Error's own option rather than shadowing the
    // inherited `cause` property with a parameter property.
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerSourceError';
  }
}

/**
 * The boundary itself.
 *
 * Every method is defined in Ballast's vocabulary. No provider type crosses
 * this interface in either direction.
 */
export interface LedgerSource {
  /** Begin a new connection, or re-auth an existing one (update mode). */
  createLinkSession(input: {
    userId: string;
    /** Present for re-auth: repairs this item instead of adding a new one. */
    reauthItemId?: string;
    webhookUrl: string;
    redirectUri?: string;
    /** History to request on first link — up to ~24 months, bank-dependent. */
    daysRequested?: number;
  }): Promise<LinkSession>;

  /** Exchange the client's short-lived token for a durable connection. */
  completeLink(publicToken: string): Promise<{ sourceItemId: string; accessToken: string }>;

  /** Describe a connection and its accounts. */
  describeItem(accessToken: string): Promise<LinkedItem>;

  /** Balances only. Costs a provider call — use sparingly. */
  listAccounts(accessToken: string): Promise<SourceAccount[]>;

  /**
   * Pull one page of changes. Pass the last persisted cursor, or null for a
   * first sync. The caller must keep paging while `hasMore` is true and only
   * persist `nextCursor` once a page is fully applied.
   */
  syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage>;

  /** Detected recurring streams — the forward-obligations engine's input. */
  getRecurring(accessToken: string, accountIds?: string[]): Promise<RecurringStreams>;

  /**
   * Verify and normalize an inbound webhook.
   * MUST be given the RAW request body bytes: the signature covers the exact
   * bytes sent, and re-serializing parsed JSON will not reproduce them.
   */
  verifyWebhook(
    rawBody: ArrayBuffer,
    headers: Headers,
  ): Promise<WebhookEvent & { deliveryDigest: string; bodyDigest: string }>;

  /** Disconnect at the provider. Best-effort; local state is removed anyway. */
  removeItem(accessToken: string): Promise<void>;
}
