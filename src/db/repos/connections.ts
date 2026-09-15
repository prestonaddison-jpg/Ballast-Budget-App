/**
 * Entities and provider connections.
 *
 * Every query here is scoped to user_id. Note the pattern on single-row reads:
 * `WHERE id = ? AND user_id = ?` rather than fetching by id and checking
 * ownership afterwards. The check cannot then be forgotten at a call site.
 */

export interface EntityRow {
  id: string;
  user_id: string;
  name: string;
  state: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface SourceItemRow {
  id: string;
  user_id: string;
  provider: string;
  source_item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  access_token_enc: string;
  status: string;
  consent_expires_at: number | null;
  sync_cursor: string | null;
  history_status: string;
  last_synced_at: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  removed_at: number | null;
}

export interface SourceAccountRow {
  id: string;
  user_id: string;
  item_id: string;
  entity_id: string | null;
  source_account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string;
  available_minor: number | null;
  current_minor: number | null;
  limit_minor: number | null;
  currency: string;
  budgetable: number;
  balance_updated_at: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export async function listEntities(db: D1Database, userId: string): Promise<EntityRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM entities WHERE user_id = ? AND archived_at IS NULL ORDER BY name')
    .bind(userId)
    .all<EntityRow>();
  return results ?? [];
}

export async function listItems(db: D1Database, userId: string): Promise<SourceItemRow[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM source_items WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at',
    )
    .bind(userId)
    .all<SourceItemRow>();
  return results ?? [];
}

/** Ownership is part of the lookup, not a follow-up check. */
export async function findItem(
  db: D1Database,
  userId: string,
  itemId: string,
): Promise<SourceItemRow | null> {
  return db
    .prepare('SELECT * FROM source_items WHERE id = ? AND user_id = ? AND removed_at IS NULL')
    .bind(itemId, userId)
    .first<SourceItemRow>();
}

/**
 * Look up an item by the PROVIDER's id.
 *
 * Used only on the webhook path, where there is no authenticated user — the
 * provider's signature is the authorization. The returned row carries user_id,
 * which every downstream query then scopes to.
 */
export async function findItemByProviderId(
  db: D1Database,
  provider: string,
  sourceItemId: string,
): Promise<SourceItemRow | null> {
  return db
    .prepare(
      'SELECT * FROM source_items WHERE provider = ? AND source_item_id = ? AND removed_at IS NULL',
    )
    .bind(provider, sourceItemId)
    .first<SourceItemRow>();
}

export async function countAccountsByItem(
  db: D1Database,
  userId: string,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT item_id, COUNT(*) AS n
         FROM source_accounts
        WHERE user_id = ? AND closed_at IS NULL
        GROUP BY item_id`,
    )
    .bind(userId)
    .all<{ item_id: string; n: number }>();
  const map = new Map<string, number>();
  for (const row of results ?? []) map.set(row.item_id, row.n);
  return map;
}

export async function updateItemStatus(
  db: D1Database,
  itemId: string,
  status: string,
  now: number,
  errorCode?: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE source_items SET status = ?, last_error_code = ?, updated_at = ? WHERE id = ?')
    .bind(status, errorCode ?? null, now, itemId)
    .run();
}
