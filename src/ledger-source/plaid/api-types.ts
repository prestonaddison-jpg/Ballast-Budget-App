/**
 * Plaid wire types — the subset Ballast touches.
 *
 * Mirrored from the official `plaid` SDK TypeScript definitions (v47) so the
 * Worker bundle carries no SDK dependency. These types describe Plaid's wire
 * format EXACTLY, including its sign convention and its nullability. They are
 * confined to this directory: the mapper converts them into Ballast's domain
 * types and nothing outside ./plaid/ ever sees them.
 */

export interface PlaidAccountBalance {
  /** Posted minus holds. Null when the institution does not report it. */
  available: number | null;
  current: number | null;
  limit: number | null;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  last_updated_datetime?: string | null;
}

export interface PlaidAccount {
  account_id: string;
  balances: PlaidAccountBalance;
  mask: string | null;
  name: string;
  official_name: string | null;
  type: 'investment' | 'credit' | 'depository' | 'loan' | 'brokerage' | 'other';
  subtype: string | null;
  persistent_account_id?: string;
}

/**
 * NOTE: this mirrors Plaid's `TransactionCounterparty`, NOT its `Counterparty`.
 * Both exist in the SDK with similar shapes; `Transaction.counterparties` is
 * typed as `Array<TransactionCounterparty>`. Importing the other one compiles
 * and then lies at runtime.
 */
export interface PlaidTransactionCounterparty {
  name: string;
  entity_id?: string | null;
  type: string;
  website: string | null;
  logo_url: string | null;
  confidence_level?: string | null;
}

export interface PlaidPersonalFinanceCategory {
  primary: string;
  detailed: string;
  confidence_level?: string | null;
}

export interface PlaidTransaction {
  account_id: string;
  /**
   * PLAID'S SIGN CONVENTION, verbatim from the SDK docs:
   * "Positive values when money moves out of the account; negative values when
   * money moves in. For example, debit card purchases are positive; credit
   * card payments, direct deposits, and refunds are negative."
   * The mapper NEGATES this. Nothing else may.
   */
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  date: string;
  authorized_date?: string | null;
  datetime?: string | null;
  /**
   * Marked @deprecated by Plaid but ALWAYS present on /transactions/sync
   * results, unlike merchant_name which is nullable.
   */
  name: string;
  merchant_name?: string | null;
  /**
   * Only returned when `options.include_original_description: true` is sent on
   * the sync request. Otherwise the field is ABSENT (not null) — Ballast
   * always requests it, because the raw bank descriptor is what the Square
   * payout match keys on (§6).
   */
  original_description?: string | null;
  payment_channel?: string;
  pending: boolean;
  /** The pending transaction this posted one supersedes, if any. */
  pending_transaction_id: string | null;
  transaction_id: string;
  transaction_code?: string | null;
  counterparties?: PlaidTransactionCounterparty[];
  personal_finance_category?: PlaidPersonalFinanceCategory | null;
}

export interface PlaidRemovedTransaction {
  transaction_id: string;
  account_id: string;
}

export type PlaidTransactionsUpdateStatus =
  | 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN'
  | 'NOT_READY'
  | 'INITIAL_UPDATE_COMPLETE'
  | 'HISTORICAL_UPDATE_COMPLETE';

export interface PlaidTransactionsSyncResponse {
  accounts: PlaidAccount[];
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemovedTransaction[];
  next_cursor: string;
  has_more: boolean;
  transactions_update_status: PlaidTransactionsUpdateStatus;
  request_id: string;
}

export interface PlaidAccountsGetResponse {
  accounts: PlaidAccount[];
  item: PlaidItem;
  request_id: string;
}

export interface PlaidItem {
  item_id: string;
  institution_id: string | null;
  institution_name?: string | null;
  webhook: string | null;
  error: PlaidError | null;
  available_products: string[];
  billed_products: string[];
  consent_expiration_time?: string | null;
  update_type?: string;
}

export interface PlaidError {
  error_type: string;
  /** Safe for programmatic use. Branch on this plus error_type, never on text. */
  error_code: string;
  /** NOT safe for programmatic use — Plaid may reword it at any time. */
  error_message: string;
  display_message: string | null;
  /** Omitted in errors delivered via webhooks. */
  request_id?: string;
  causes?: unknown[];
  /** Only populated when the error arrived via a webhook. */
  status?: number | null;
  suggested_action?: string | null;
}

export interface PlaidLinkTokenCreateResponse {
  link_token: string;
  expiration: string;
  request_id: string;
}

export interface PlaidItemPublicTokenExchangeResponse {
  access_token: string;
  item_id: string;
  request_id: string;
}

export type PlaidRecurringFrequency =
  'UNKNOWN' | 'WEEKLY' | 'BIWEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY' | 'ANNUALLY';

export type PlaidStreamStatus = 'UNKNOWN' | 'MATURE' | 'EARLY_DETECTION' | 'TOMBSTONED';

/**
 * Stream amounts are OBJECTS, not numbers, and `amount` itself is optional.
 * `iso_currency_code` is null whenever `unofficial_currency_code` is set.
 */
export interface PlaidTransactionStreamAmount {
  amount?: number;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
}

export interface PlaidTransactionStream {
  account_id: string;
  stream_id: string;
  category?: string[] | null;
  category_id?: string | null;
  description: string;
  merchant_name: string | null;
  personal_finance_category?: PlaidPersonalFinanceCategory | null;
  first_date: string;
  last_date: string;
  frequency: PlaidRecurringFrequency;
  transaction_ids: string[];
  average_amount: PlaidTransactionStreamAmount;
  last_amount: PlaidTransactionStreamAmount;
  is_active: boolean;
  status: PlaidStreamStatus;
  /** Deprecated by Plaid: documented to ALWAYS be false. Do not build on it. */
  is_user_modified?: boolean;
  /** Deprecated alongside is_user_modified. */
  last_user_modified_datetime?: string | null;
  predicted_next_date?: string | null;
}

export interface PlaidTransactionsRecurringGetResponse {
  inflow_streams: PlaidTransactionStream[];
  outflow_streams: PlaidTransactionStream[];
  updated_datetime: string | null;
  request_id: string;
}

export interface PlaidJwkPublicKey {
  alg: string;
  crv: string;
  kid: string;
  kty: string;
  use: string;
  x: string;
  y: string;
  created_at: number;
  expired_at: number | null;
}

export interface PlaidWebhookVerificationKeyGetResponse {
  key: PlaidJwkPublicKey;
  request_id: string;
}

export interface PlaidInstitution {
  institution_id: string;
  name: string;
  products: string[];
  country_codes: string[];
  oauth: boolean;
  routing_numbers?: string[];
  status?: unknown;
  url?: string | null;
}

export interface PlaidInstitutionsGetByIdResponse {
  institution: PlaidInstitution;
  request_id: string;
}

/** The generic webhook envelope. Fields vary by type; all are optional here. */
export interface PlaidWebhookPayload {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: PlaidError | null;
  new_transactions?: number;
  initial_update_complete?: boolean;
  historical_update_complete?: boolean;
  account_ids?: string[];
  /** PENDING_EXPIRATION (EU/UK) only. */
  consent_expiration_time?: string | null;
  /** PENDING_DISCONNECT (US/CA) only. */
  disconnect_time?: string | null;
  /** PENDING_DISCONNECT (US/CA) only. */
  reason?: string | null;
  /** LOWERCASE ('sandbox' | 'production') while type/code are UPPERCASE. */
  environment?: string;
}
