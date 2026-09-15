-- Ballast · Phase 0 schema
--
-- SCOPE: identity, entities, and the provider-connection surface. The money
-- model (envelopes, ledger entries, proposals) is deliberately ABSENT — it
-- belongs to Slice 1, and inventing its tables now would bake in guesses about
-- the conservation invariant before it has been built against.
--
-- CONVENTIONS
--   * Timestamps are INTEGER unix SECONDS (UTC). SQLite has no date type and
--     storing ISO strings invites lexical-vs-chronological comparison bugs.
--   * Money is INTEGER minor units (cents). Never REAL: binary floating point
--     cannot represent 0.10, and a cash-allocation app that loses cents to
--     rounding breaks its own conservation invariant.
--   * Every table holding user data carries user_id, and every query scopes to
--     it. BOLA is the #1 API risk (§16); scoping at the schema level makes the
--     safe query the natural one to write.
--   * Secrets are stored ONLY as encrypted envelopes (see src/crypto).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  -- pbkdf2$sha256$<iterations>$<salt>$<hash> — parameters travel with the hash
  -- so the cost can be raised without invalidating existing credentials.
  password_hash     TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- Soft disable, so revoking access never orphans audit history.
  disabled_at       INTEGER
);

-- Case-insensitive uniqueness: Ballast must not allow Preston@ and preston@ to
-- become two accounts.
CREATE UNIQUE INDEX idx_users_email ON users (lower(email));

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256(token), base64url. The raw token is never stored, so a dump of
  -- this table yields no usable session.
  token_hash          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  -- Slides forward on use; drives the idle timeout.
  last_seen_at        INTEGER NOT NULL,
  -- Hard cap, independent of activity.
  absolute_expires_at INTEGER NOT NULL,
  revoked_at          INTEGER
);

CREATE UNIQUE INDEX idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX idx_sessions_user ON sessions (user_id);
-- Supports the cron sweep that deletes dead sessions. Both clocks are
-- indexed: a session can die by the IDLE timeout long before its absolute
-- expiry, and sweeping only on the latter leaves idle-dead rows for months.
CREATE INDEX idx_sessions_expiry ON sessions (absolute_expires_at);
CREATE INDEX idx_sessions_last_seen ON sessions (last_seen_at);

-- ---------------------------------------------------------------------------
-- Entities (§1: multi-entity, per-entity conservation)
-- ---------------------------------------------------------------------------

CREATE TABLE entities (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- Two-letter US state. Drives the tax rate automatically (§7: "rate follows
  -- the account/entity/state automatically — no per-deposit tagging").
  state         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER
);

CREATE INDEX idx_entities_user ON entities (user_id);

-- ---------------------------------------------------------------------------
-- Provider connections
-- ---------------------------------------------------------------------------

CREATE TABLE source_items (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'plaid' is the only value today. Present so a second provider would be a
  -- migration rather than a schema redesign — matching the LedgerSource
  -- boundary, which is a normalization seam, not a multi-adapter framework.
  provider            TEXT NOT NULL DEFAULT 'plaid',
  source_item_id      TEXT NOT NULL,
  institution_id      TEXT,
  institution_name    TEXT,
  -- AES-256-GCM envelope: v1.<iv>.<ciphertext>, AAD-bound to this row.
  access_token_enc    TEXT NOT NULL,
  -- ok | reauth_required | pending_disconnect | revoked_by_user
  status              TEXT NOT NULL DEFAULT 'ok',
  -- When the provider says consent lapses (~12 months at many US OAuth banks).
  consent_expires_at  INTEGER,
  -- /transactions/sync cursor. Persisted ONLY after a page is fully applied.
  sync_cursor         TEXT,
  -- Whether the provider has finished its historical backfill.
  history_status      TEXT NOT NULL DEFAULT 'unknown',
  last_synced_at      INTEGER,
  last_error_code     TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  removed_at          INTEGER
);

CREATE UNIQUE INDEX idx_source_items_provider_id ON source_items (provider, source_item_id);
CREATE INDEX idx_source_items_user ON source_items (user_id);

CREATE TABLE source_accounts (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_id            TEXT NOT NULL REFERENCES source_items (id) ON DELETE CASCADE,
  -- Each account maps to exactly ONE entity. This is what makes the per-entity
  -- conservation invariant well-defined (§4), and the all-LLC structure
  -- enforces it in the real world. NULL until the operator assigns it.
  entity_id          TEXT REFERENCES entities (id) ON DELETE SET NULL,
  source_account_id  TEXT NOT NULL,
  name               TEXT NOT NULL,
  official_name      TEXT,
  mask               TEXT,
  type               TEXT NOT NULL,
  subtype            TEXT NOT NULL,
  -- AVAILABLE is the balance the invariant and "safe to spend" are pinned to
  -- (§4). NULL means the institution did not report one — which is NOT zero,
  -- and must never be rendered as spendable.
  available_minor    INTEGER,
  current_minor      INTEGER,
  limit_minor        INTEGER,
  currency           TEXT NOT NULL DEFAULT 'USD',
  -- Only depository checking/savings/money-market hold budgetable cash.
  budgetable         INTEGER NOT NULL DEFAULT 0,
  balance_updated_at INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  closed_at          INTEGER
);

CREATE UNIQUE INDEX idx_source_accounts_provider_id ON source_accounts (item_id, source_account_id);
CREATE INDEX idx_source_accounts_user ON source_accounts (user_id);
CREATE INDEX idx_source_accounts_entity ON source_accounts (entity_id);

-- ---------------------------------------------------------------------------
-- Webhook intake
-- ---------------------------------------------------------------------------

-- Every VERIFIED webhook is recorded before it is acted on. Two jobs:
--   1. Replay/duplicate suppression. Plaid retries, and a delivery we have
--      already processed must not drive a second sync.
--   2. An audit trail for "why did the app think it was up to date?".
--
-- THE DEDUP KEY IS THE SIGNED DELIVERY, NOT THE BODY.
-- Deduplicating on the body digest looks right and is badly wrong: a Plaid
-- SYNC_UPDATES_AVAILABLE body carries no nonce and no timestamp, so two
-- genuinely different sync events for the same Item are BYTE-IDENTICAL. A
-- unique index on the body digest would therefore swallow every sync
-- notification after the first one, permanently, and Ballast would silently
-- stop seeing new deposits.
--
-- The JWT in the Plaid-Verification header is unique per DELIVERY (it carries
-- an `iat`, and the signature covers it), while a genuine Plaid RETRY re-sends
-- the very same JWT. Hashing it gives exactly the semantics wanted: retries
-- collapse, distinct events do not.
CREATE TABLE webhook_events (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL DEFAULT 'plaid',
  source_item_id  TEXT,
  webhook_type    TEXT,
  webhook_code    TEXT,
  -- Hex SHA-256 of the signed delivery token (the Plaid-Verification JWT).
  delivery_digest TEXT NOT NULL,
  -- Hex SHA-256 of the raw body. Audit only — NOT unique, see above.
  body_sha256     TEXT NOT NULL,
  received_at     INTEGER NOT NULL,
  processed_at    INTEGER,
  -- received | processed | ignored | failed
  status          TEXT NOT NULL DEFAULT 'received',
  error_detail    TEXT
);

CREATE UNIQUE INDEX idx_webhook_events_delivery ON webhook_events (provider, delivery_digest);
CREATE INDEX idx_webhook_events_body ON webhook_events (body_sha256);
CREATE INDEX idx_webhook_events_item ON webhook_events (source_item_id);
CREATE INDEX idx_webhook_events_received ON webhook_events (received_at);

-- ---------------------------------------------------------------------------
-- Sync runs — operational visibility behind the freshness indicator
-- ---------------------------------------------------------------------------

CREATE TABLE sync_runs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL REFERENCES source_items (id) ON DELETE CASCADE,
  -- webhook | cron | manual | initial
  trigger         TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  -- running | ok | failed
  status          TEXT NOT NULL DEFAULT 'running',
  pages           INTEGER NOT NULL DEFAULT 0,
  added_count     INTEGER NOT NULL DEFAULT 0,
  modified_count  INTEGER NOT NULL DEFAULT 0,
  removed_count   INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT
);

CREATE INDEX idx_sync_runs_item ON sync_runs (item_id, started_at);
CREATE INDEX idx_sync_runs_user ON sync_runs (user_id);

-- ---------------------------------------------------------------------------
-- Rate limiting
-- ---------------------------------------------------------------------------

-- Fixed-window counters, in D1 rather than KV.
--
-- KV cannot do this correctly: a read-modify-write across three awaited steps
-- is not atomic, so a burst of concurrent logins all read the same
-- pre-increment value and all pass. D1 can increment and read in ONE
-- statement (INSERT ... ON CONFLICT DO UPDATE ... RETURNING), which is
-- atomic, so a concurrent burst is counted correctly.
CREATE TABLE rate_limits (
  bucket        TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Supports the cron sweep of elapsed windows.
CREATE INDEX idx_rate_limits_window ON rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  -- login.success | login.failure | session.revoked | item.linked | ...
  action        TEXT NOT NULL,
  subject_type  TEXT,
  subject_id    TEXT,
  -- JSON. MUST NOT contain secrets, tokens, or full account numbers.
  detail        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_audit_log_user ON audit_log (user_id, created_at);
CREATE INDEX idx_audit_log_action ON audit_log (action, created_at);
