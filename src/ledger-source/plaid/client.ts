/**
 * Minimal Plaid HTTP client.
 *
 * The official `plaid` npm SDK is deliberately NOT used at runtime:
 *   - it is an axios-based Node client, which pulls a large dependency tree
 *     into a Worker bundle for a handful of POSTs;
 *   - Ballast calls six endpoints in total.
 * The SDK's TypeScript definitions remain the reference for field shapes; the
 * response types in ./api-types.ts mirror them.
 *
 * Authentication: Plaid accepts credentials either as JSON body fields or as
 * `PLAID-CLIENT-ID` / `PLAID-SECRET` headers. Headers are used here so that
 * credentials never appear in a request body that might be logged or echoed
 * back in an error.
 */

import { LedgerSourceError } from '../types';

export type PlaidEnvironment = 'sandbox' | 'production';

const BASE_URL: Record<PlaidEnvironment, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export interface PlaidCredentials {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
}

export interface PlaidErrorBody {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
  request_id?: string;
}

/**
 * Errors worth retrying: transient provider problems and rate limits. An
 * ITEM_LOGIN_REQUIRED is emphatically NOT retryable — it needs the operator.
 */
const RETRYABLE_TYPES = new Set(['API_ERROR', 'RATE_LIMIT_EXCEEDED']);
const RETRYABLE_CODES = new Set([
  'INTERNAL_SERVER_ERROR',
  'PLANNED_MAINTENANCE',
  'INSTITUTION_DOWN',
  'INSTITUTION_NOT_RESPONDING',
  'RATE_LIMIT',
  'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
]);

export class PlaidApiError extends LedgerSourceError {
  constructor(
    readonly status: number,
    readonly body: PlaidErrorBody,
  ) {
    super(
      body.error_code ?? `HTTP_${status}`,
      body.error_message ?? `Plaid request failed with ${status}`,
      RETRYABLE_TYPES.has(body.error_type ?? '') || RETRYABLE_CODES.has(body.error_code ?? ''),
    );
    this.name = 'PlaidApiError';
  }
}

export class PlaidClient {
  constructor(private readonly credentials: PlaidCredentials) {}

  get baseUrl(): string {
    return BASE_URL[this.credentials.environment];
  }

  /**
   * POST a Plaid endpoint.
   *
   * No retry loop lives here. Retries belong to the caller (a Queue consumer
   * with backoff), because a Worker request must not sit blocking on a
   * provider outage.
   */
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': this.credentials.clientId,
          'PLAID-SECRET': this.credentials.secret,
          // Pinning the API version stops Plaid from changing response shapes
          // underneath a deployed Worker.
          'Plaid-Version': '2020-09-14',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new LedgerSourceError('NETWORK_ERROR', 'Could not reach Plaid', true, cause);
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LedgerSourceError('BAD_RESPONSE', 'Plaid returned a non-JSON response', true);
      }
    }

    if (!response.ok) {
      throw new PlaidApiError(response.status, (parsed ?? {}) as PlaidErrorBody);
    }
    return parsed as T;
  }

  /** Unauthenticated: the webhook verification key endpoint still needs auth. */
  async getWebhookVerificationKey<T>(keyId: string): Promise<T> {
    return this.post<T>('/webhook_verification_key/get', { key_id: keyId });
  }
}
