-- Ballast · no budgetable account means UNKNOWN, never zero
--
-- THE DEFECT, found live in production on the first deployment. The cash half
-- of the `unallocated` residual was computed as:
--
--     CASE WHEN COUNT(*) FILTER (WHERE sa.available_minor IS NULL) > 0
--          THEN NULL
--          ELSE COALESCE(SUM(sa.available_minor), 0)
--     END
--
-- which correctly propagates an unknown when a LINKED account has not reported
-- a balance — but over ZERO rows the filtered count is 0, the CASE falls to
-- the ELSE, and COALESCE(SUM(...) over nothing, 0) returns a confident 0.
--
-- So a brand-new entity with no bank connected reported that it holds $0: one
-- entity, one unallocated envelope, no source_accounts, balance_minor = 0.
-- CLAUDE.md names this as the single most dangerous bug this app can have. It
-- tells the operator they have nothing when the truth is that nobody has asked
-- their bank yet.
--
-- WHY THE TEST IS "NO BUDGETABLE, OPEN ACCOUNTS" rather than "no account rows
-- at all". The narrower version is tempting: if an account exists and the
-- operator marked it non-budgetable, the bank DID answer and they themself
-- excluded it, so budgetable cash is arguably a known 0.
--
-- It is not, and the arithmetic shows why. Take $18,420 in one account with
-- $16,900 funded into Tax. Mark that account non-budgetable. Under the
-- "known 0" reading the residual becomes 0 − 16,900 = -$16,900, and the app
-- announces "over-allocated by $16,900" — a crisis invented out of a
-- bookkeeping flag. There is no budgetable pool to be over-allocated against.
-- The question is not answered zero; it is not answerable.
--
-- This also makes the view agree EXACTLY with checkInvariant, which has always
-- treated an empty budgetable set as 'indeterminate' (see the comment in
-- src/money/invariant.ts). Two definitions of "can we compare?" that disagree
-- is how the tile came to say $0 while the hero figure said "—".
--
-- A NAMED envelope is untouched: it is a plain ledger sum and is genuinely 0
-- when empty. Only the residual depends on what the bank says.
--
-- A view holds no data, so recreating it changes no rows and the previous
-- release still reads the same column names. Rolling back is re-running the
-- old definition.

DROP VIEW IF EXISTS envelope_balances;

CREATE VIEW envelope_balances AS
SELECT
  e.id        AS envelope_id,
  e.user_id   AS user_id,
  e.entity_id AS entity_id,
  e.type      AS type,
  CASE
    WHEN e.type = 'unallocated' THEN
      (
        -- Cash: SUM(available) over budgetable, non-closed accounts.
        --
        -- NULL when any one of them is unknown, AND NULL when there are none.
        -- The second clause is the fix: an empty pool has no figure, and
        -- "no answer" must not render the same as "no money".
        SELECT CASE
                 WHEN COUNT(*) = 0 THEN NULL
                 WHEN COUNT(*) FILTER (WHERE sa.available_minor IS NULL) > 0 THEN NULL
                 ELSE COALESCE(SUM(sa.available_minor), 0)
               END
          FROM source_accounts sa
         WHERE sa.entity_id = e.entity_id
           AND sa.user_id = e.user_id
           AND sa.budgetable = 1
           AND sa.closed_at IS NULL
      )
      - (
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
      -- A NAMED envelope is a plain ledger sum and is genuinely 0 when empty.
      -- Nothing unknown about it: no entries means no money was ever put in.
      (SELECT COALESCE(SUM(x.amount_minor), 0)
         FROM ledger_entries x WHERE x.to_envelope_id = e.id)
      - (SELECT COALESCE(SUM(x.amount_minor), 0)
           FROM ledger_entries x WHERE x.from_envelope_id = e.id)
  END AS balance_minor
FROM envelopes e;
