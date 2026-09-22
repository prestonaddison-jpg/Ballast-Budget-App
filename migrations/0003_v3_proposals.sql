-- Ballast · v3.0.0 — proposals (staging)
--
-- ADDITIVE ONLY. Nothing here alters or drops anything from 0001/0002, which
-- is what makes v2.x code still boot against this schema and what makes
-- rolling v3 back to v2 a real option rather than a theory.
--
-- WHY PROPOSALS ARE NOT LEDGER ENTRIES. A proposal is a SUGGESTION about money
-- that has not happened. Writing it into ledger_entries would make it count
-- toward every balance the moment it was generated, which is exactly the thing
-- §4's staging model forbids: "nothing mutates a balance without approval."
-- So proposals live in their own table and touch no balance until approve
-- writes a real entry.
--
-- THE RULE THAT SHAPES THE WHOLE TABLE: a proposal is validated against the
-- CURRENT balance at approve time, never the balance when it was generated.
-- Between those two moments a sync can land, a hold can clear, and the
-- operator can fund something else. `amount_minor` here is therefore an
-- INTENT, not a reservation — see approveProposal in src/money/proposals.ts,
-- where the balance check is folded into the insert that commits it.

CREATE TABLE proposals (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entity_id         TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,

  -- Which engine suggested this. Mirrors the blueprint's core operations.
  kind              TEXT NOT NULL CHECK (kind IN
                      ('income_allocation', 'salary_draw', 'buffer_action',
                       'unassigned_spend', 'tax_skim', 'waterfall')),

  -- Both endpoints, same shape as ledger_entries: direction by from/to, never
  -- by a sign, and a strictly positive amount.
  from_envelope_id  TEXT NOT NULL,
  to_envelope_id    TEXT NOT NULL,
  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),

  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'dismissed', 'expired')),

  -- Advisory link to the bank transaction that motivated it, when there was one.
  txn_key           TEXT,
  memo              TEXT,

  -- A proposal about a balance from last week is not a proposal, it is a
  -- guess. Past this the operator must be shown a fresh one.
  expires_at        INTEGER,
  created_at        INTEGER NOT NULL,
  decided_at        INTEGER,

  -- The entry that committing it produced. NULL until approved, and the audit
  -- trail from "you approved this" back to "this is what moved".
  entry_id          TEXT REFERENCES ledger_entries (id),

  CHECK (from_envelope_id <> to_envelope_id),

  -- Same structural no-commingling rule as ledger_entries: both endpoints must
  -- belong to the SAME entity as the proposal. A cross-entity proposal cannot
  -- be written, so it can never be approved into one either.
  FOREIGN KEY (from_envelope_id, entity_id) REFERENCES envelopes (id, entity_id),
  FOREIGN KEY (to_envelope_id, entity_id) REFERENCES envelopes (id, entity_id)
);

-- The Needs You queue reads exactly this: one entity's pending proposals,
-- oldest first.
CREATE INDEX idx_proposals_queue ON proposals (entity_id, status, created_at);

-- Every read is scoped to user AND entity (BOLA, §16).
CREATE INDEX idx_proposals_user ON proposals (user_id, status);

-- Expiry sweeps scan this rather than the whole table.
CREATE INDEX idx_proposals_expiry ON proposals (status, expires_at)
  WHERE status = 'pending';
