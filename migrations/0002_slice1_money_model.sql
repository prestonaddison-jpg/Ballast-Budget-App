-- Ballast · Slice 1 — the money model
--
-- ===========================================================================
-- THE CENTRAL DESIGN DECISION, AND WHY IT LOOKS WRONG AT FIRST
-- ===========================================================================
--
-- `unallocated` is NOT summed from the ledger. It is DEFINED as:
--
--     unallocated = SUM(budgetable account available) - SUM(named envelopes)
--
-- Every other envelope is a plain ledger sum. Unallocated is the residual.
--
-- WHY. Blueprint §4 pins the invariant to the AVAILABLE balance:
--
--     "Conservation invariant (per entity): Σ(envelopes) = Σ(budgetable
--      accounts), with `unallocated` absorbing slack."
--
-- Available moves whenever a hold appears or clears. There is no transaction
-- behind that and nothing for Ballast to intercept. So in any design where
-- unallocated is a ledger sum, the spec's invariant is FALSE between syncs by
-- an unbounded amount, and only becomes true again when a reconciliation job
-- writes a drift entry. That job can fail, lag, or be forgotten, and while it
-- is late the hero number is wrong in the dangerous direction.
--
-- As a residual, the invariant is an ALGEBRAIC IDENTITY:
--
--     SUM(envelopes) = SUM(named) + (cash - SUM(named)) = cash
--
-- ...which is true for every possible content of these tables, at every
-- instant, with no reconciliation job at all. "Unallocated absorbing slack"
-- stops being a policy about where to put slack and becomes the definition of
-- slack. test/worker/residual-design.test.ts proves it: a bank balance moving
-- 600 -> 900 is tracked with ZERO ledger writes.
--
-- THE ONE HONEST DEVIATION, stated plainly so a future reader does not have to
-- discover it. §4 also says "balances are derived from a ledger, never
-- stored". That is literally true of every named envelope and NOT literally
-- true of unallocated, which reads the stored column
-- `source_accounts.available_minor`. The defence: that column is not a
-- Ballast-computed balance that can drift from the ledger — it is Phase 0's
-- mirror of an external bank observation, carrying its own freshness clock
-- (`balance_updated_at`) which already drives the §14 staleness indicator. The
-- risk §4 guards against — a stored total silently disagreeing with the
-- entries that produced it — cannot arise here, because nothing computes it.
-- When the bank has reported no available balance the answer is NULL, and
-- safeToSpend() returns null rather than a confident figure (see
-- src/money/invariant.ts).
--
-- CONSEQUENCE, and the reason this design is safe: THE LEDGER IS CLOSED.
-- Every entry moves money between two envelopes OF THE SAME ENTITY. There are
-- no external legs, so a bank event cannot reach the ledger at all — a sync
-- can never disturb an allocation the operator made, and a reversal needs no
-- compensating ledger surgery. §3 ("reserves are labels, by design... Ballast
-- never segregates or moves cash") is expressed structurally rather than as a
-- convention: there is no cash in this ledger to move.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Envelopes
-- ---------------------------------------------------------------------------
--
-- §12: a project envelope is "a `save`/`spend` envelope with a target,
-- optional target date, optional zone, and a lifecycle... No new tables." So
-- target/zone/lifecycle are columns here, and Slice 4 adds no table.

CREATE TABLE envelopes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entity_id     TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('unallocated', 'buffer', 'tax', 'spend', 'save')),

  -- Money is INTEGER minor units. Never REAL: binary floating point cannot
  -- represent 0.10, and a cash app that loses cents breaks its own invariant.
  target_minor  INTEGER CHECK (target_minor IS NULL OR target_minor > 0),
  target_date   TEXT,
  zone          TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,

  -- Reserved so later slices are code, not migrations.
  priority      INTEGER NOT NULL DEFAULT 0,  -- Slice 3: waterfall order
  stream_id     TEXT,                        -- Slice 4: recurring stream link
  cadence       TEXT,                        -- Slice 4: obligation cadence

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER,
  completed_at  INTEGER,

  -- Composite-FK target: lets ledger_entries prove both endpoints belong to
  -- the same entity declaratively, so commingling is unrepresentable rather
  -- than merely checked (§3: per-entity conservation, no commingling).
  UNIQUE (id, entity_id)
);

-- EXACTLY ONE unallocated envelope per entity. Not hygiene: the residual is
-- defined in terms of "the entity's unallocated", so a second one would make
-- the definition ambiguous and the invariant meaningless.
CREATE UNIQUE INDEX idx_envelopes_unallocated
  ON envelopes (entity_id) WHERE type = 'unallocated';

CREATE INDEX idx_envelopes_entity ON envelopes (entity_id, archived_at);
CREATE INDEX idx_envelopes_user ON envelopes (user_id);

-- ---------------------------------------------------------------------------
-- Ledger entries — the only table holding money movement. Append-only.
-- ---------------------------------------------------------------------------
--
-- BOTH LEGS ON ONE ROW, with a strictly POSITIVE amount and direction carried
-- by from/to rather than by a sign.
--
-- This is what makes the operation atomic on D1, which has no interactive
-- transactions. The balance guard folds into the same INSERT that performs the
-- move (see src/money/ledger.ts), so there is no window between reading a
-- balance and spending it. With one row per signed leg, the guard on the
-- second leg would read a balance the first leg had already changed, and the
-- two legs could not be made to fire or not fire together — leaving a
-- half-written transfer in a ledger that is supposed to balance.
-- test/worker/d1-atomic-guard.test.ts pins the platform behaviour this relies
-- on.

CREATE TABLE ledger_entries (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entity_id         TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,

  -- BOTH NOT NULL: the ledger is closed. No external legs, ever.
  from_envelope_id  TEXT NOT NULL,
  to_envelope_id    TEXT NOT NULL,

  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),

  kind              TEXT NOT NULL CHECK (kind IN
                      ('fund', 'move', 'sweep', 'reversal', 'proposal')),

  -- Links an entry to the bank transaction that motivated it, when there was
  -- one. Advisory: the entry is still a pure envelope-to-envelope move.
  txn_key           TEXT,

  -- Makes a retried request a no-op instead of a double allocation. A retry
  -- after a dropped response is otherwise indistinguishable from a deliberate
  -- second identical transfer.
  idempotency_key   TEXT,

  memo              TEXT,
  created_at        INTEGER NOT NULL,

  -- Compensating entry (§4 "reversals self-heal"). Reversal is a NEW entry, so
  -- the ledger stays append-only and history is preserved for the CPA export.
  reverses_entry_id TEXT REFERENCES ledger_entries (id),

  -- A transfer to itself is a no-op that would still pass a balance guard.
  CHECK (from_envelope_id <> to_envelope_id),

  -- Both endpoints must belong to the SAME entity as the entry. This is the
  -- structural no-commingling rule: a cross-entity transfer cannot be written.
  FOREIGN KEY (from_envelope_id, entity_id) REFERENCES envelopes (id, entity_id),
  FOREIGN KEY (to_envelope_id, entity_id) REFERENCES envelopes (id, entity_id)
);

CREATE INDEX idx_ledger_entity_time ON ledger_entries (entity_id, created_at);
CREATE INDEX idx_ledger_from ON ledger_entries (from_envelope_id);
CREATE INDEX idx_ledger_to ON ledger_entries (to_envelope_id);
CREATE INDEX idx_ledger_txn_key ON ledger_entries (txn_key) WHERE txn_key IS NOT NULL;

-- One entry per idempotency key, per user. The guard against a double
-- allocation from a retried request.
CREATE UNIQUE INDEX idx_ledger_idempotency
  ON ledger_entries (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- An entry may be reversed AT MOST ONCE. Structural, so a retried reversal
-- cannot double-reverse.
CREATE UNIQUE INDEX idx_ledger_reverses
  ON ledger_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- envelope_balances — the ONE definition of an envelope's balance
-- ---------------------------------------------------------------------------
--
-- A view rather than application code, so that the guarded INSERT can consult
-- exactly the same definition the UI reads. If the guard and the display could
-- disagree, an envelope could be shown as funded and refuse to be spent from.
--
-- Named envelopes: a plain ledger sum.
-- Unallocated:     the residual (see the header).
--
-- `balance_minor` is NULL for unallocated when any budgetable account has not
-- reported an available balance. Null means UNKNOWN, never zero — and the
-- guarded write rejects a NULL comparison, so nothing can be allocated out of
-- an unknown balance.

CREATE VIEW envelope_balances AS
SELECT
  e.id        AS envelope_id,
  e.user_id   AS user_id,
  e.entity_id AS entity_id,
  e.type      AS type,
  CASE
    WHEN e.type = 'unallocated' THEN
      (
        -- Cash: SUM(available) over budgetable, non-closed accounts. NULL if
        -- ANY of them is unknown, so the unknown propagates rather than
        -- silently counting as zero.
        SELECT CASE
                 WHEN COUNT(*) FILTER (WHERE sa.available_minor IS NULL) > 0 THEN NULL
                 ELSE COALESCE(SUM(sa.available_minor), 0)
               END
          FROM source_accounts sa
         WHERE sa.entity_id = e.entity_id
           -- Defence in depth. An entity belongs to exactly one user, so
           -- entity_id alone SHOULD be sufficient — but nothing declaratively
           -- ties source_accounts.user_id to entities.user_id, and this is the
           -- one subquery that turns another table's rows into spendable cash.
           -- Note the direction: an over-strict filter here UNDERSTATES cash,
           -- which is the safe way to be wrong. The named-envelope sums below
           -- are deliberately NOT filtered this way, because dropping a named
           -- claim would INFLATE unallocated — wrong in the dangerous
           -- direction — and their composite FK already pins them to the
           -- entity.
           AND sa.user_id = e.user_id
           AND sa.budgetable = 1
           AND sa.closed_at IS NULL
      )
      - (
        -- SUM(named envelopes) for this entity.
        SELECT COALESCE(SUM(x.amount_minor), 0)
          FROM ledger_entries x
          JOIN envelopes n ON n.id = x.to_envelope_id
         WHERE n.entity_id = e.entity_id AND n.type <> 'unallocated'
      )
      + (
        SELECT COALESCE(SUM(x.amount_minor), 0)
          FROM ledger_entries x
          JOIN envelopes n ON n.id = x.from_envelope_id
         WHERE n.entity_id = e.entity_id AND n.type <> 'unallocated'
      )
    ELSE
      (SELECT COALESCE(SUM(x.amount_minor), 0)
         FROM ledger_entries x WHERE x.to_envelope_id = e.id)
      - (SELECT COALESCE(SUM(x.amount_minor), 0)
           FROM ledger_entries x WHERE x.from_envelope_id = e.id)
  END AS balance_minor
FROM envelopes e;
