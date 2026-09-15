# Spike results

Blueprint §18.3 — *"Plaid business-account coverage for the actual banks — a
per-institution go/no-go... Not answerable in advance."*

This file is where the answer gets recorded. It is a **template with nothing
filled in**, because neither spike has been run against live Plaid yet.

> **Status: NOT YET RUN.** No Plaid credentials were available in the build
> environment and outbound access to `plaid.com` was blocked by network policy.
> Both spikes are code-complete and run the moment credentials are supplied.

---

## Spike A — Plaid sandbox

```bash
export PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox
npm run spike:plaid 2>&1 | tee -a docs/spike-a-output.txt
```

| Assumption | Result | Notes |
|---|---|---|
| A1 — money IN is a NEGATIVE Plaid amount | ☐ | The single most consequential fact. If this fails, `mapper.ts` is inverted and so is the whole waterfall. |
| A2 — sync returns added / modified / removed; `removed` is objects | ☐ | |
| A3 — posted `transaction_id` differs from `pending_transaction_id` | ☐ | The premise for `txn_key`. |
| A4 — `next_cursor` durable; empty string means "not ready" | ☐ | |
| A5 — `available` can be null | ☐ | Must never render as spendable. |
| A6 — recurring/get entitlement | ☐ | **Paid add-on.** If not entitled, §9 is blocked before Slice 4. |
| A7 — `reset_login` → `ITEM_LOGIN_REQUIRED`; update mode repairs | ☐ | |

**Date run:**
**Plaid API version:** `2020-09-14`
**Outcome:**

---

## Spike B — real-bank coverage (§18.3)

### What this spike established about the question itself

**The Plaid `Institution` object carries no business/commercial signal of any
kind.** There is no field reporting whether an institution supports business
accounts. The go/no-go therefore **cannot be fully automated** — it splits into
an automated metadata pass and a manual, per-institution protocol.

Two further limits:

- Institution **status** is unavailable in Sandbox entirely, and null in
  Production for low-traffic institutions. A sandbox run yields zero health
  data — run Part 1 against Production.
- `recurring_transactions` is not a filterable institution product. Plaid
  documents recurring as supported wherever Transactions is (US/CA/UK), so
  `transactions` is the correct and only proxy.

### Part 1 — automated metadata

```bash
export PLAID_ENV=production
npm run spike:coverage -- --banks "<the real banks>" --markdown >> docs/SPIKE-RESULTS.md
```

| Institution | ID | Transactions | OAuth | Verdict |
|---|---|---|---|---|
| _(not yet run)_ | | | | |

> A "GO" in Part 1 means the institution supports the Transactions product. It
> does **not** confirm that Plaid can see this entity's business accounts.

### Part 2 — manual protocol, per institution

Run once per bank, in Production, with the entity's **real** business account.

For each institution, record:

1. **Did the business login work at all?** Some banks route business banking
   through a separate portal Plaid does not cover. This is the question §18.3
   is actually asking.
2. **Accounts** — `type`, `subtype`, `mask`, `holder_category` (if enabled),
   and **whether `available` is non-null**. Ballast pins the conservation
   invariant to available; an institution that never reports it is a real
   problem, not cosmetic.
3. **Transactions** — did `transactions_update_status` reach
   `HISTORICAL_UPDATE_COMPLETE`? How many days of history actually arrived
   (versus the 730 requested)? Do pending transactions appear at all? ("Not all
   institutions provide pending transactions.")
4. **Recurring** — inflow/outflow stream counts, how many are `MATURE` vs
   `EARLY_DETECTION`, and **whether the entity's known fixed obligations were
   actually found**. This is the real test of whether §9 can work here.
5. **OAuth?** If so, consent expires at ~12 months and `ITEM_LOGIN_REQUIRED` +
   update mode is a **routine** flow, not an error path.

**GO criteria — all four must hold:**

- the business account links at all;
- `available` balance is reported;
- at least ~180 days of history arrives;
- the entity's known fixed obligations show up as streams.

### Per-institution record

Copy this block per bank.

```
Institution:
  institution_id:
  Date tested:
  1. Business login worked:            yes / no
  2. Accounts returned:                     (types/subtypes)
     available reported:               yes / no
     holder_category:
  3. HISTORICAL_UPDATE_COMPLETE:       yes / no
     Days of history received:              (of 730 requested)
     Pending transactions present:     yes / no
  4. Inflow streams:            MATURE:
     Outflow streams:           MATURE:
     Known obligations detected:            (list)
  5. OAuth:                            yes / no
  VERDICT:                             GO / NO-GO
  Notes:
```

---

## Action items surfaced by the spikes

| Item | Owner | Blocking |
|---|---|---|
| Request the **Recurring Transactions add-on** from Plaid — it is a paid add-on and Transactions does not grant it | Operator | Slice 4 (§9 is mandatory) |
| Run Spike A with sandbox credentials | Operator | Confidence in the boundary |
| Run Spike B Part 1 + Part 2 for each real bank | Operator | Closing §18.3 |
| Confirm `days_requested: 730` is honored per institution | Spike B step 3 | Slice 3 (seasonal baseline) |
