/**
 * Sync pagination discipline.
 *
 * Paging /transactions/sync looks trivial and has four ways to lose data
 * permanently. Each is encoded here so no call site has to remember it.
 *
 *   1. NEVER PERSIST A MID-PAGINATION CURSOR. Only the cursor returned by the
 *      page where `hasMore === false` is durable ("valid for at least 1 year").
 *      Storing a mid-loop cursor and then crashing skips every update between
 *      that page and the end of the loop, silently and permanently.
 *
 *   2. NEVER STORE AN EMPTY CURSOR. `next_cursor` is "" when transactions are
 *      not yet available (Item just created). Persisting "" is
 *      indistinguishable from "no cursor", so the next sync replays the entire
 *      history as if it were new.
 *
 *   3. ON MUTATION-DURING-PAGINATION, RESTART FROM THE ORIGINAL CURSOR and
 *      discard everything accumulated. Retrying only the failed request
 *      re-triggers the same error forever, because the underlying data keeps
 *      moving under the old page boundary.
 *
 *   4. NEVER MIX ACCOUNT-SCOPED AND ITEM-SCOPED CURSORS. Passing an account id
 *      forks a separate cursor stream; interleaving the two corrupts
 *      pagination. Ballast only ever syncs Item-wide.
 */

import { LedgerSourceError } from './types';
import type { SourceAccount, SourceTransaction, RemovedRef, SyncPage } from './types';

export const MUTATION_DURING_PAGINATION = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';

export interface AccumulatedSync {
  added: SourceTransaction[];
  modified: SourceTransaction[];
  removed: RemovedRef[];
  accounts: SourceAccount[];
  /**
   * The cursor to persist — ONLY ever from the final page. Null when the
   * provider returned an empty cursor, meaning "nothing to store yet".
   */
  finalCursor: string | null;
  pages: number;
  historyStatus: SyncPage['historyStatus'];
}

export interface SyncLoopOptions {
  /** Guards against an unbounded loop if the provider never sets hasMore=false. */
  maxPages?: number;
  /** How many times to restart the whole loop on a mutation error. */
  maxRestarts?: number;
}

/**
 * Drain every page for one Item.
 *
 * Returns the ACCUMULATED changes plus the one durable cursor. The caller
 * applies the changes and persists the cursor in a SINGLE atomic write — D1
 * has no interactive transactions, so that means one `db.batch([...])`.
 */
export async function drainSync(
  fetchPage: (cursor: string | null) => Promise<SyncPage>,
  startCursor: string | null,
  opts: SyncLoopOptions = {},
): Promise<AccumulatedSync> {
  const maxPages = opts.maxPages ?? 200;
  const maxRestarts = opts.maxRestarts ?? 3;

  for (let restart = 0; restart <= maxRestarts; restart++) {
    // Every restart begins from the ORIGINAL cursor, never from where the
    // failed attempt got to.
    const acc: AccumulatedSync = {
      added: [],
      modified: [],
      removed: [],
      accounts: [],
      finalCursor: null,
      pages: 0,
      historyStatus: 'unknown',
    };

    let cursor = startCursor;
    let mutated = false;

    try {
      for (let page = 0; page < maxPages; page++) {
        const result = await fetchPage(cursor);
        acc.pages++;
        acc.added.push(...result.added);
        acc.modified.push(...result.modified);
        acc.removed.push(...result.removed);
        acc.accounts = result.accounts.length ? result.accounts : acc.accounts;
        acc.historyStatus = result.historyStatus;

        if (!result.hasMore) {
          // Rule 2: an empty cursor means "not ready", not "start over".
          acc.finalCursor = result.nextCursor === '' ? null : result.nextCursor;
          return acc;
        }
        cursor = result.nextCursor;
      }
      throw new LedgerSourceError(
        'SYNC_PAGE_LIMIT',
        `Sync exceeded ${maxPages} pages without completing`,
        false,
      );
    } catch (err) {
      if (err instanceof LedgerSourceError && err.code === MUTATION_DURING_PAGINATION) {
        mutated = true;
      } else {
        throw err;
      }
    }

    if (mutated && restart === maxRestarts) {
      throw new LedgerSourceError(
        MUTATION_DURING_PAGINATION,
        `Transactions kept changing across ${maxRestarts + 1} sync attempts`,
        true,
      );
    }
  }

  // Unreachable: the loop either returns, throws, or exhausts maxRestarts.
  throw new LedgerSourceError('SYNC_FAILED', 'Sync did not complete', true);
}
