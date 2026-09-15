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
