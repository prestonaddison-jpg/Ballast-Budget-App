/**
 * Worker API client.
 *
 * Cookie-only session: the browser attaches the __Host-ballast_session cookie
 * automatically and JS never sees it (HttpOnly). We therefore only ever need
 * `credentials: 'same-origin'` — there is no token to store, which is the
 * whole point of the cookie-only design (§15).
 *
 * CSRF: the Worker requires a same-origin Sec-Fetch-Site / Origin on every
 * state-changing request, plus SameSite=Strict on the cookie. We additionally
 * send X-Requested-With so the Worker can reject any request that did not come
 * from fetch() (a cross-origin form post cannot set a custom header).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('X-Requested-With', 'ballast');
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
  }

  const res = await fetch(path, { ...init, method, headers, credentials: 'same-origin' });

  if (res.status === 204) return undefined as T;

  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const err = (payload ?? {}) as { code?: string; message?: string };
    throw new ApiError(
      res.status,
      err.code ?? 'unknown',
      err.message ?? `Request failed (${res.status})`,
    );
  }
  return payload as T;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  time: string;
}

export interface SessionUser {
  userId: string;
  email: string;
}

export interface ConnectionSummary {
  itemId: string;
  institutionName: string | null;
  status: 'ok' | 'reauth_required' | 'pending_disconnect';
  lastSyncedAt: string | null;
  accountCount: number;
}

export interface MeResponse {
  user: SessionUser;
  entities: Array<{ id: string; name: string; state: string }>;
  connections: ConnectionSummary[];
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  me: () => request<MeResponse>('/api/me'),
  login: (email: string, password: string) =>
    request<{ user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
};

/* -------------------------------------------------------------------------
 * Envelopes (Slice 1)
 * ---------------------------------------------------------------------- */

export interface ApiEnvelope {
  id: string;
  name: string;
  type: 'unallocated' | 'buffer' | 'tax' | 'spend' | 'save';
  /** NULL when the bank has not reported an available balance. */
  balanceMinor: number | null;
  targetMinor: number | null;
  targetDate: string | null;
  zone: string | null;
}

export interface EnvelopesResponse {
  entityId: string;
  envelopes: ApiEnvelope[];
  /** NULL means "we don't know", never a confident zero. */
  safeToSpendMinor: number | null;
  /** Positive when allocations exceed the cash actually available. */
  overAllocatedMinor: number;
  invariant: 'balanced' | 'cash_ahead' | 'envelopes_ahead' | 'indeterminate';
}

export const envelopeApi = {
  list: (entityId: string) =>
    request<EnvelopesResponse>(`/api/entities/${encodeURIComponent(entityId)}/envelopes`),

  create: (
    entityId: string,
    body: { name: string; type: ApiEnvelope['type']; targetMinor?: number | null },
  ) =>
    request<{ id: string }>(`/api/entities/${encodeURIComponent(entityId)}/envelopes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Tap-to-fund. `idempotencyKey` is generated per ATTEMPT, not per retry, so
   * a dropped response that the client retries cannot allocate twice.
   */
  transfer: (
    entityId: string,
    body: {
      fromEnvelopeId: string;
      toEnvelopeId: string;
      amountMinor: number;
      memo?: string;
      idempotencyKey?: string;
    },
  ) =>
    request<{ entryId?: string; duplicate?: boolean }>(
      `/api/entities/${encodeURIComponent(entityId)}/transfers`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  complete: (entityId: string, envelopeId: string) =>
    request<{ sweptMinor: number }>(
      `/api/entities/${encodeURIComponent(entityId)}/envelopes/${encodeURIComponent(envelopeId)}/complete`,
      { method: 'POST' },
    ),
};

/* -------------------------------------------------------------------------
 * Proposals — the Needs You queue (v3)
 * ---------------------------------------------------------------------- */

export type ProposalKind =
  | 'income_allocation'
  | 'salary_draw'
  | 'buffer_action'
  | 'unassigned_spend'
  | 'tax_skim'
  | 'waterfall';

export interface ApiProposal {
  id: string;
  kind: ProposalKind;
  amountMinor: number;
  memo: string | null;
  createdAt: number;
  expiresAt: number | null;
  from: { id: string; name: string | null; type: string | null };
  to: { id: string; name: string | null; type: string | null };
  /** NULL when the bank has not reported the source balance. */
  sourceBalanceMinor: number | null;
  /**
   * Advisory. The server re-checks the live balance inside the statement that
   * commits, so this decides nothing — it exists so the screen can say "this
   * no longer fits" before the operator taps, rather than after.
   *
   * NULL means unknown, and unknown is neither true nor false.
   */
  affordableNow: boolean | null;
}

export interface ProposalsResponse {
  entityId: string;
  proposals: ApiProposal[];
}

export const proposalApi = {
  list: (entityId: string) =>
    request<ProposalsResponse>(`/api/entities/${encodeURIComponent(entityId)}/proposals`),

  approve: (entityId: string, proposalId: string) =>
    request<{ entryId: string; amountMinor: number }>(
      `/api/entities/${encodeURIComponent(entityId)}/proposals/${encodeURIComponent(proposalId)}/approve`,
      { method: 'POST' },
    ),

  /**
   * Change the amount before approving. Moves no money — the proposal is still
   * a suggestion afterwards, just a different one.
   */
  edit: (entityId: string, proposalId: string, amountMinor: number) =>
    request<{ amountMinor: number }>(
      `/api/entities/${encodeURIComponent(entityId)}/proposals/${encodeURIComponent(proposalId)}`,
      { method: 'PATCH', body: JSON.stringify({ amountMinor }) },
    ),

  dismiss: (entityId: string, proposalId: string) =>
    request<{ dismissed: boolean }>(
      `/api/entities/${encodeURIComponent(entityId)}/proposals/${encodeURIComponent(proposalId)}/dismiss`,
      { method: 'POST' },
    ),
};
