/**
 * Freshness indicator (Blueprint A.5, §14 "the green but dead rule").
 *
 * A runway or balance shown from a stale Plaid sync is a dangerous lie. So:
 *   - every connection stamps "synced 4m ago";
 *   - STALE and DISCONNECTED are their own states, never folded into a
 *     balance color. A disconnected item is not "low balance" — it is
 *     "we do not know", and the UI must say so in words.
 *
 * Plaid consent expires at ~12 months at many US OAuth banks, so
 * ITEM_LOGIN_REQUIRED / PENDING_DISCONNECT are ROUTINE, not exceptional.
 */

export type FreshnessState = 'fresh' | 'syncing' | 'stale' | 'disconnected';

export interface FreshnessInput {
  /** Epoch ms of the last successful sync, or null if never synced. */
  lastSyncedAt: number | null;
  /** Item-level connection health from the Worker. */
  connection: 'ok' | 'reauth_required' | 'pending_disconnect' | 'never';
  /** Minutes after which a sync is considered stale. */
  staleAfterMinutes?: number;
  syncing?: boolean;
  /** Injected for testability; defaults to Date.now. */
  now?: number;
}

export interface Freshness {
  state: FreshnessState;
  /** Human phrase, e.g. "synced 4m ago" or "reconnect needed". */
  text: string;
  /** Longer, calm explanation. Never scolding (§14 guardrails). */
  detail?: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeAge(deltaMs: number): string {
  if (deltaMs < MIN) return 'just now';
  if (deltaMs < HOUR) return `${Math.floor(deltaMs / MIN)}m ago`;
  if (deltaMs < DAY) return `${Math.floor(deltaMs / HOUR)}h ago`;
  return `${Math.floor(deltaMs / DAY)}d ago`;
}

export function computeFreshness(input: FreshnessInput): Freshness {
  const now = input.now ?? Date.now();
  const staleAfter = (input.staleAfterMinutes ?? 180) * MIN;

  // Connection state dominates. A fresh timestamp on a disconnected item is
  // exactly the "green but dead" lie this component exists to prevent.
  if (input.connection === 'reauth_required') {
    return {
      state: 'disconnected',
      text: 'reconnect needed',
      detail:
        'This bank needs you to sign in again before Ballast can see new activity. Balances below are the last known good figures.',
    };
  }
  if (input.connection === 'pending_disconnect') {
    return {
      state: 'stale',
      text: 'reconnect soon',
      detail:
        'This bank will stop sharing data shortly. Reconnecting now keeps the numbers honest.',
    };
  }
  if (input.connection === 'never' || input.lastSyncedAt == null) {
    return { state: 'stale', text: 'not synced yet' };
  }
  if (input.syncing) {
    return { state: 'syncing', text: 'syncing…' };
  }

  const age = Math.max(0, now - input.lastSyncedAt);
  if (age > staleAfter) {
    return {
      state: 'stale',
      text: `synced ${relativeAge(age)}`,
      detail: 'Older than usual — these figures may have moved.',
    };
  }
  return { state: 'fresh', text: `synced ${relativeAge(age)}` };
}

export function createFreshness(input: FreshnessInput): HTMLElement {
  const f = computeFreshness(input);
  const node = document.createElement('div');
  node.className = 'freshness';
  node.dataset.state = f.state;

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.textContent = f.text;

  node.append(dot, text);
  // The state is in the accessible name as a word, not just the dot color.
  node.setAttribute('role', 'status');
  node.setAttribute('aria-label', `${f.state}: ${f.text}${f.detail ? `. ${f.detail}` : ''}`);
  if (f.detail) node.title = f.detail;
  return node;
}
