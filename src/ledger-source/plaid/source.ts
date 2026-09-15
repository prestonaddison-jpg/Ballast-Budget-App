/**
 * PlaidLedgerSource — the sole implementation of the LedgerSource boundary.
 */

import {
  LedgerSourceError,
  type ConnectionStatus,
  type LedgerSource,
  type LinkedItem,
  type LinkSession,
  type RecurringStreams,
  type SourceAccount,
  type SyncPage,
  type WebhookEvent,
} from '../types';
import type { TxnKeyResolver } from '../txn-key';
import { PlaidClient } from './client';
import { mapAccount, mapStream, mapSyncPage } from './mapper';
import { cachedJwkFetcher, verifyPlaidWebhook } from './webhook-verify';
import type {
  PlaidAccountsGetResponse,
  PlaidInstitutionsGetByIdResponse,
  PlaidItemPublicTokenExchangeResponse,
  PlaidJwkPublicKey,
  PlaidLinkTokenCreateResponse,
  PlaidTransactionsRecurringGetResponse,
  PlaidTransactionsSyncResponse,
  PlaidWebhookPayload,
  PlaidWebhookVerificationKeyGetResponse,
} from './api-types';

/**
 * History requested at link time.
 *
 * THIS IS A ONE-SHOT DECISION. `transactions.days_requested` can only be set
 * when Transactions is initialized on an Item, and Plaid documents that it
 * "cannot be updated" afterwards — changing it later requires /item/remove and
 * a full re-Link. The default is 90 days, which would be actively harmful
 * here: §8 needs a trailing-TWELVE-MONTH baseline to be seasonally honest, and
 * §9's recurring detection wants >=180 days to find annual streams. 730 is
 * Plaid's maximum, and the blueprint's "up to ~24 months, institution
 * dependent" is exactly this number.
 */
const DAYS_REQUESTED_MAX = 730;
/** Plaid's Production floor. Below this, Link rejects the token. */
const DAYS_REQUESTED_MIN = 30;
/**
 * §9's recurring detection needs at least this much history to find streams
 * at all, and ANNUALLY streams need far more. Requesting less would quietly
 * cripple the forward-obligations engine with no error.
 */
const DAYS_REQUESTED_RECOMMENDED_MIN = 180;

/** Plaid's cap; asking for more is an error. */
const SYNC_PAGE_SIZE = 500;

export interface PlaidLedgerSourceDeps {
  client: PlaidClient;
  /** KV used only to cache webhook signing keys (public, non-request data). */
  jwkCache: KVNamespace;
  /**
   * Resolves an already-stored txnKey for a provider transaction id. The
   * caller pre-loads these from D1 so the mapper stays pure and synchronous.
   */
  resolveTxnKey: TxnKeyResolver;
  /** Injected so tests can pin time. Seconds since epoch. */
  now: () => number;
}

export class PlaidLedgerSource implements LedgerSource {
  constructor(private readonly deps: PlaidLedgerSourceDeps) {}

  async createLinkSession(input: {
    userId: string;
    reauthAccessToken?: string;
    webhookUrl: string;
    redirectUri?: string;
    daysRequested?: number;
  }): Promise<LinkSession> {
    const isUpdateMode = Boolean(input.reauthAccessToken);

    const body: Record<string, unknown> = {
      client_name: 'Ballast',
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: input.userId },
      webhook: input.webhookUrl,
    };
    if (input.redirectUri) body.redirect_uri = input.redirectUri;

    if (isUpdateMode) {
      // UPDATE MODE. `products` MUST be empty — re-sending the original
      // product list is a documented, common bug. The same access_token is
      // restored on completion, so there is no public token to exchange
      // afterwards. Note also that an update-mode link_token expires in 30
      // MINUTES rather than the usual 4 hours, so it must be minted
      // just-in-time rather than cached.
      body.access_token = input.reauthAccessToken;
      body.products = [];
    } else {
      // 'transactions' is the correct product string. 'recurring_transactions'
      // exists in the Products enum (so TypeScript accepts it) but is NOT a
      // valid link-token product and risks INVALID_PRODUCT. Recurring is an
      // add-on entitlement on top of Transactions, not a linkable product.
      // 'balance' is likewise invalid here — it is auto-initialized.
      body.products = ['transactions'];
      // Clamped server-side: the 730 maximum appears only in Plaid's prose
      // docs, NOT in the SDK's TypeScript definitions, so nothing upstream
      // validates it for us.
      body.transactions = { days_requested: clampDaysRequested(input.daysRequested) };
    }

    const res = await this.deps.client.post<PlaidLinkTokenCreateResponse>(
      '/link/token/create',
      body,
    );
    return { linkToken: res.link_token, expiresAt: res.expiration };
  }

  async completeLink(publicToken: string): Promise<{ sourceItemId: string; accessToken: string }> {
    const res = await this.deps.client.post<PlaidItemPublicTokenExchangeResponse>(
      '/item/public_token/exchange',
      { public_token: publicToken },
    );
    return { sourceItemId: res.item_id, accessToken: res.access_token };
  }

  async describeItem(accessToken: string): Promise<LinkedItem> {
    const res = await this.deps.client.post<PlaidAccountsGetResponse>('/accounts/get', {
      access_token: accessToken,
    });

    let institutionName: string | null = res.item.institution_name ?? null;
    if (!institutionName && res.item.institution_id) {
      institutionName = await this.lookupInstitutionName(res.item.institution_id);
    }

    return {
      sourceItemId: res.item.item_id,
      institutionId: res.item.institution_id,
      institutionName,
      status: statusFromItemError(res.item.error),
      accounts: res.accounts.map(mapAccount),
    };
  }

  private async lookupInstitutionName(institutionId: string): Promise<string | null> {
    try {
      const res = await this.deps.client.post<PlaidInstitutionsGetByIdResponse>(
        '/institutions/get_by_id',
        // country_codes is TOP-LEVEL in API version 2020-09-14, not inside
        // options (that was 2019-05-29 and earlier). Omitting it is a hard error.
        { institution_id: institutionId, country_codes: ['US'] },
      );
      return res.institution.name;
    } catch {
      // A missing display name must never fail a connection.
      return null;
    }
  }

  async listAccounts(accessToken: string): Promise<SourceAccount[]> {
    // NOTE: /accounts/balance/get takes AccountsBalanceGetRequest but returns
    // AccountsGetResponse — there is no AccountsBalanceGetResponse type.
    // It forces a live balance refresh at the institution, unlike
    // /accounts/get which may serve cached balances.
    const res = await this.deps.client.post<PlaidAccountsGetResponse>('/accounts/balance/get', {
      access_token: accessToken,
    });
    return res.accounts.map(mapAccount);
  }

  async syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage> {
    const body: Record<string, unknown> = {
      access_token: accessToken,
      count: SYNC_PAGE_SIZE,
      options: {
        // Without this the raw bank descriptor is ABSENT (not null), and the
        // Square payout match in §6 has nothing to key on.
        include_original_description: true,
      },
    };
    // A first sync omits `cursor` entirely rather than sending null.
    if (cursor) body.cursor = cursor;
    // DELIBERATELY NOT SET: options.account_id. Passing it forks a separate
    // cursor stream per account; mixing account-scoped and item-scoped cursors
    // causes pagination errors and silently missing transactions.

    const res = await this.deps.client.post<PlaidTransactionsSyncResponse>(
      '/transactions/sync',
      body,
    );
    return mapSyncPage(res, this.deps.resolveTxnKey);
  }

  async getRecurring(accessToken: string, accountIds?: string[]): Promise<RecurringStreams> {
    const body: Record<string, unknown> = { access_token: accessToken };
    if (accountIds && accountIds.length) body.account_ids = accountIds;

    const res = await this.deps.client.post<PlaidTransactionsRecurringGetResponse>(
      '/transactions/recurring/get',
      body,
    );
    return {
      inflows: res.inflow_streams.map(mapStream),
      outflows: res.outflow_streams.map(mapStream),
      updatedAt: res.updated_datetime,
    };
  }

  async verifyWebhook(
    rawBody: ArrayBuffer,
    headers: Headers,
  ): Promise<WebhookEvent & { deliveryDigest: string; bodyDigest: string }> {
    const fetchJwk = cachedJwkFetcher(this.deps.jwkCache, async (keyId) => {
      const res = await this.deps.client.post<PlaidWebhookVerificationKeyGetResponse>(
        '/webhook_verification_key/get',
        // The request field is `key_id`; the value comes from the JWT header's
        // `kid`. The names differ — sending `kid` is an INVALID_REQUEST.
        { key_id: keyId },
      );
      return res.key as PlaidJwkPublicKey;
    });

    const verified = await verifyPlaidWebhook(rawBody, headers, fetchJwk, this.deps.now());
    return {
      ...normalizeWebhook(verified.payload as PlaidWebhookPayload),
      deliveryDigest: verified.deliveryDigest,
      bodyDigest: verified.bodyDigest,
    };
  }

  async removeItem(accessToken: string): Promise<void> {
    await this.deps.client.post('/item/remove', { access_token: accessToken });
  }
}

/** Map an Item-level Plaid error onto connection health. */
export function clampDaysRequested(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) return DAYS_REQUESTED_MAX;
  const floored = Math.max(DAYS_REQUESTED_MIN, Math.floor(requested));
  if (floored < DAYS_REQUESTED_RECOMMENDED_MIN) {
    console.warn('days_requested_below_recommended', {
      requested: floored,
      recommended: DAYS_REQUESTED_RECOMMENDED_MIN,
      note: 'recurring-stream detection will be weak and this is unfixable without re-linking',
    });
  }
  return Math.min(DAYS_REQUESTED_MAX, floored);
}

/** Map an Item-level Plaid error onto connection health. */
export function statusFromItemError(
  error: { error_code?: string } | null | undefined,
): ConnectionStatus {
  if (!error) return 'ok';
  switch (error.error_code) {
    case 'ITEM_LOGIN_REQUIRED':
      return 'reauth_required';
    case 'USER_PERMISSION_REVOKED':
    case 'USER_ACCOUNT_REVOKED':
      return 'revoked_by_user';
    case 'PENDING_DISCONNECT':
    case 'PENDING_EXPIRATION':
      return 'pending_disconnect';
    default:
      return 'ok';
  }
}

/**
 * Normalize a verified webhook.
 *
 * ROUTING TRAP: RECURRING_TRANSACTIONS_UPDATE has webhook_type `TRANSACTIONS`,
 * not `RECURRING_TRANSACTIONS` — no such type exists. A router that switches
 * on webhook_type alone and expects a dedicated recurring type silently drops
 * every recurring update, which would quietly disable the whole
 * forward-obligations engine (§9).
 *
 * Type and code are UPPERCASE; `environment` is lowercase.
 */
export function normalizeWebhook(payload: PlaidWebhookPayload): WebhookEvent {
  const type = payload.webhook_type ?? '';
  const code = payload.webhook_code ?? '';
  const itemId = payload.item_id ?? null;

  if (type === 'TRANSACTIONS') {
    switch (code) {
      case 'SYNC_UPDATES_AVAILABLE':
        return {
          kind: 'sync_available',
          sourceItemId: requireItemId(itemId, code),
          initialComplete: payload.initial_update_complete ?? false,
          historicalComplete: payload.historical_update_complete ?? false,
        };
      case 'RECURRING_TRANSACTIONS_UPDATE':
        return {
          kind: 'recurring_updated',
          // This webhook carries no user_id, unlike SYNC_UPDATES_AVAILABLE.
          sourceItemId: requireItemId(itemId, code),
          accountIds: payload.account_ids ?? [],
        };
      default:
        return { kind: 'ignored', type, code };
    }
  }

  if (type === 'ITEM') {
    switch (code) {
      case 'ERROR': {
        const err = payload.error;
        if (err?.error_code === 'ITEM_LOGIN_REQUIRED') {
          return { kind: 'reauth_required', sourceItemId: requireItemId(itemId, code) };
        }
        return {
          kind: 'error',
          sourceItemId: itemId,
          code: err?.error_code ?? 'UNKNOWN',
          message: err?.error_message ?? 'Unknown item error',
        };
      }
      // US/CA consent expiry warning (~7 days' notice), carries disconnect_time.
      case 'PENDING_DISCONNECT':
        return {
          kind: 'pending_disconnect',
          sourceItemId: requireItemId(itemId, code),
          disconnectsAt: payload.disconnect_time ?? null,
        };
      // EU/UK equivalent, carries consent_expiration_time instead. Handling
      // only one of the pair leaves the other region silently disconnected.
      case 'PENDING_EXPIRATION':
        return {
          kind: 'pending_disconnect',
          sourceItemId: requireItemId(itemId, code),
          disconnectsAt: payload.consent_expiration_time ?? null,
        };
      case 'USER_PERMISSION_REVOKED':
      case 'USER_ACCOUNT_REVOKED':
        return { kind: 'user_revoked', sourceItemId: requireItemId(itemId, code) };
      case 'LOGIN_REPAIRED':
        return { kind: 'connection_repaired', sourceItemId: requireItemId(itemId, code) };
      case 'NEW_ACCOUNTS_AVAILABLE':
        // Every field of this webhook is optional in the SDK, item_id
        // included, so it must be validated at runtime rather than trusted.
        return { kind: 'accounts_available', sourceItemId: requireItemId(itemId, code) };
      default:
        return { kind: 'ignored', type, code };
    }
  }

  return { kind: 'ignored', type, code };
}

function requireItemId(itemId: string | null, code: string): string {
  if (!itemId) {
    throw new LedgerSourceError('WEBHOOK_MISSING_ITEM_ID', `Webhook ${code} had no item_id`, false);
  }
  return itemId;
}
