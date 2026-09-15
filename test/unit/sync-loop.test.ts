import { describe, expect, it, vi } from 'vitest';
import { drainSync, MUTATION_DURING_PAGINATION } from '../../src/ledger-source/sync-loop';
import { LedgerSourceError, type SyncPage } from '../../src/ledger-source/types';

function page(over: Partial<SyncPage> = {}): SyncPage {
  return {
    added: [],
    modified: [],
    removed: [],
    accounts: [],
    nextCursor: 'c1',
    hasMore: false,
    historyStatus: 'historical_complete',
    ...over,
  };
}

describe('drainSync', () => {
  it('returns the cursor from the FINAL page only', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page({ nextCursor: 'mid', hasMore: true }))
      .mockResolvedValueOnce(page({ nextCursor: 'final', hasMore: false }));

    const result = await drainSync(fetchPage, null);
    // Persisting 'mid' and then crashing would skip every later update.
    expect(result.finalCursor).toBe('final');
    expect(result.pages).toBe(2);
  });

  it('never returns an empty cursor as something to persist', async () => {
    // "" means transactions are not ready. Storing it is indistinguishable
    // from "no cursor" and replays the whole history next sync.
    const result = await drainSync(async () => page({ nextCursor: '', hasMore: false }), null);
    expect(result.finalCursor).toBeNull();
  });

  it('accumulates changes across pages', async () => {
    const mk = (id: string) => ({ sourceTransactionId: id, sourceAccountId: 'a' });
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page({ removed: [mk('r1')], nextCursor: 'm', hasMore: true }))
      .mockResolvedValueOnce(page({ removed: [mk('r2')], nextCursor: 'f', hasMore: false }));

    const result = await drainSync(fetchPage, null);
    expect(result.removed.map((r) => r.sourceTransactionId)).toEqual(['r1', 'r2']);
  });

  it('restarts from the ORIGINAL cursor on mutation-during-pagination', async () => {
    const seen: Array<string | null> = [];
    let attempt = 0;
    const fetchPage = async (cursor: string | null): Promise<SyncPage> => {
      seen.push(cursor);
      attempt++;
      // First attempt: one page, then the mutation error.
      if (attempt === 1) return page({ nextCursor: 'mid', hasMore: true });
      if (attempt === 2) {
        throw new LedgerSourceError(MUTATION_DURING_PAGINATION, 'changed', true);
      }
      return page({ nextCursor: 'final', hasMore: false });
    };

    const result = await drainSync(fetchPage, 'start');
    expect(result.finalCursor).toBe('final');
    // Restart goes back to 'start', NOT to 'mid'. Retrying the failed request
    // from 'mid' would re-trigger the same error indefinitely.
    expect(seen).toEqual(['start', 'mid', 'start']);
  });

  it('discards everything accumulated before a restart', async () => {
    const mk = (id: string) => ({ sourceTransactionId: id, sourceAccountId: 'a' });
    let attempt = 0;
    const fetchPage = async (): Promise<SyncPage> => {
      attempt++;
      if (attempt === 1) return page({ removed: [mk('stale')], nextCursor: 'mid', hasMore: true });
      if (attempt === 2) throw new LedgerSourceError(MUTATION_DURING_PAGINATION, 'changed', true);
      return page({ removed: [mk('fresh')], nextCursor: 'final', hasMore: false });
    };

    const result = await drainSync(fetchPage, 'start');
    // 'stale' came from the abandoned attempt and must not be applied twice.
    expect(result.removed.map((r) => r.sourceTransactionId)).toEqual(['fresh']);
  });

  it('gives up after repeated mutation errors rather than looping forever', async () => {
    const fetchPage = async (): Promise<SyncPage> => {
      throw new LedgerSourceError(MUTATION_DURING_PAGINATION, 'changed', true);
    };
    await expect(drainSync(fetchPage, null, { maxRestarts: 1 })).rejects.toThrow(/kept changing/);
  });

  it('propagates a non-mutation error instead of retrying it', async () => {
    const fetchPage = async (): Promise<SyncPage> => {
      throw new LedgerSourceError('ITEM_LOGIN_REQUIRED', 'reauth', false);
    };
    // Retrying a re-auth error would just burn provider quota.
    await expect(drainSync(fetchPage, null)).rejects.toThrow(/reauth/);
  });

  it('stops at the page limit rather than looping unbounded', async () => {
    const fetchPage = async (): Promise<SyncPage> => page({ hasMore: true, nextCursor: 'x' });
    await expect(drainSync(fetchPage, null, { maxPages: 3 })).rejects.toThrow(/exceeded 3 pages/);
  });
});
