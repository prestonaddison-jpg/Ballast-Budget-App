import { describe, expect, it } from 'vitest';
import { computeFreshness, relativeAge } from '../../web/src/components/freshness';

const NOW = 1_800_000_000_000; // ms

describe('relativeAge', () => {
  it('externalizes time in plain units', () => {
    expect(relativeAge(30_000)).toBe('just now');
    expect(relativeAge(4 * 60_000)).toBe('4m ago');
    expect(relativeAge(3 * 3_600_000)).toBe('3h ago');
    expect(relativeAge(2 * 86_400_000)).toBe('2d ago');
  });
});

describe('computeFreshness — the "green but dead" rule', () => {
  it('reports a recent sync as fresh', () => {
    const f = computeFreshness({ lastSyncedAt: NOW - 4 * 60_000, connection: 'ok', now: NOW });
    expect(f.state).toBe('fresh');
    expect(f.text).toBe('synced 4m ago');
  });

  it('treats a DISCONNECTED item as its own state even with a recent sync', () => {
    // This is the whole point: a fresh timestamp on a dead connection is a
    // dangerous lie. Connection state must dominate recency.
    const f = computeFreshness({
      lastSyncedAt: NOW - 60_000,
      connection: 'reauth_required',
      now: NOW,
    });
    expect(f.state).toBe('disconnected');
    expect(f.text).toBe('reconnect needed');
    expect(f.detail).toBeTruthy();
  });

  it('never folds a stale sync into a balance-like state', () => {
    const f = computeFreshness({
      lastSyncedAt: NOW - 8 * 3_600_000,
      connection: 'ok',
      staleAfterMinutes: 180,
      now: NOW,
    });
    expect(f.state).toBe('stale');
    expect(f.text).toContain('8h ago');
  });

  it('warns ahead of a pending disconnect without scolding', () => {
    const f = computeFreshness({ lastSyncedAt: NOW, connection: 'pending_disconnect', now: NOW });
    expect(f.state).toBe('stale');
    expect(f.text).toBe('reconnect soon');
    // No-shame microcopy: never an accusation.
    expect(f.detail?.toLowerCase()).not.toMatch(/you (failed|forgot|must)/);
  });

  it('says "not synced yet" rather than implying zero', () => {
    const f = computeFreshness({ lastSyncedAt: null, connection: 'never', now: NOW });
    expect(f.state).toBe('stale');
    expect(f.text).toBe('not synced yet');
  });

  it('shows a syncing state while a sync is in flight', () => {
    const f = computeFreshness({
      lastSyncedAt: NOW - 1000,
      connection: 'ok',
      syncing: true,
      now: NOW,
    });
    expect(f.state).toBe('syncing');
  });

  it('never produces a negative age from clock skew', () => {
    const f = computeFreshness({ lastSyncedAt: NOW + 60_000, connection: 'ok', now: NOW });
    expect(f.text).toBe('synced just now');
  });
});
