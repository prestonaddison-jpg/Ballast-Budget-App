# Phase 0 — skeleton & spike

> **Blueprint §19:** "Worker + custom cookie session + D1 tables + PWA shell +
> Alongside/Atelier-Graphite theme + the `LedgerSource` boundary + a Plaid
> **sandbox** spike, and the **real-bank coverage spike** (§18.3)."

Everything in that sentence is built. This document says what that means
concretely, what was deliberately left out, and what the spikes found.

---

## 1. What is built

| Deliverable | Where | Notes |
|---|---|---|
| Worker (BFF) | `src/index.ts` | Hono router; serves API and the PWA shell from **one origin** |
| Custom cookie session | `src/auth/` | 256-bit opaque token, SHA-256 at rest, `__Host-` prefix, idle + absolute timeouts, rotation on auth, server-side revocation |
| D1 tables | `migrations/0001_phase0_init.sql` | identity, entities, connections, webhook intake, sync runs, audit log |
| PWA shell | `web/` | manifest, service worker, iOS home-screen meta, safe-area insets |
| Atelier / Graphite theme | `web/src/styles/` | token contract + shared component layer verbatim from Appendix A, plus the Praeclarus signature |
| The five components | `web/src/components/` | gauge-done-right, Now-Bar, focal alert, freshness, collapsible |
| `LedgerSource` boundary | `src/ledger-source/` | interface + normalized types; Plaid as the sole implementation |
| Plaid sandbox spike | `spikes/plaid-sandbox/` | exercises the lifecycle and **asserts the boundary's assumptions** |
| Real-bank coverage spike | `spikes/bank-coverage/` | automated metadata pass + manual protocol (see §4) |

Verification: `npm run typecheck` (3 projects), `npm test` (130 tests, including
Worker tests against a real D1 in Miniflare), `npm run build`.

## 2. What is deliberately NOT built

Phase 0 is a skeleton. These are named so their absence reads as a decision
rather than an omission:

- **No money model.** No envelopes, ledger entries, conservation invariant, or
  proposals. That is Slice 1, and inventing the tables now would bake in
  guesses about the invariant before anything has been built against it.
- **No placeholder balances in the UI.** The shell renders honest empty states.
  A fabricated "safe to spend" is the same class of lie as a stale sync (§14),
  except the operator cannot see that it is fake.
- **The sync queue consumer is plumbing only.** The queue, job shape, and
  ack/retry discipline ship; applying a sync page needs a ledger to apply it
  to.
- **No Plaid Link UI.** Link token creation exists on the boundary; the
  client-side Link handoff lands with onboarding (Slice 6).
- **No lint config.** A `lint` script that does not work is worse than none.
  Linting and SCA are Slice 7 ("hardening + maintenance automation").

## 3. The one deviation from the blueprint

**§15 says "Cloudflare Pages + Worker". This ships as a single Worker with
static assets.**

Reasons, in order of weight:

1. **Same origin is a security property, not a convenience.** One origin means
   the session cookie is same-origin by construction, so `SameSite=Strict`
   stays viable and there is no CORS surface. Splitting the PWA and API across
   origins would force `SameSite=None` — the opposite of what a finance app
   wants.
2. **Pages cannot host the rest of the stack.** §15 lists Queues and Cron.
   Pages Functions supports neither.
3. **Cloudflare has stopped recommending Pages for new projects.** Every Pages
   docs page now banners "Start new projects with Workers."

Nothing else in §15 changes: still TypeScript + Vite, still D1 + KV + Queues +
Cron + R2, still a custom cookie-only session, still Plaid behind
`LedgerSource`.

## 4. What the spikes established

### Spike A — Plaid sandbox

The spike is written as a set of **assertions about assumptions the code already
depends on**, so a future Plaid change surfaces as a failing spike rather than
as wrong numbers. It checks seven (A1–A7 in the file header); three matter most:

- **A1 — the sign convention.** Plaid reports *money out as positive and money
  in as negative*. A deposit is a **negative** number. `mapper.ts` negates it so
  the rest of Ballast can use the intuitive convention. Had this gone
  unnoticed, the tax skim would have run on spending and income would have read
  as an outflow.
- **A3 — transaction identity.** `transaction_id` changes when a pending
  transaction posts. The pending one appears in `removed`, the posted one in
  `added`, *never* in `modified`. Hence the `txn_key` surrogate.
- **A6 — recurring entitlement.** `/transactions/recurring/get` is a **paid
  add-on** on top of Transactions. Having Transactions in Production does not
  grant it. §9 (the forward-obligations engine) is mandatory, so this
  entitlement must be requested before Slice 4. **This is an action item, not a
  code task.**

**Status: code-complete, not yet executed against live Plaid.** No Plaid
credentials were available in the build environment, and outbound access to
`plaid.com` was blocked by network policy. The spike runs end to end the moment
credentials are supplied.

### Spike B — real-bank coverage (§18.3)

This spike **changed the shape of the answer to §18.3**, which is its most
valuable output:

> The Plaid `Institution` object carries **no business/commercial signal of any
> kind**. There is no field saying an institution supports business accounts.

So the per-institution go/no-go **cannot be fully automated**. It splits:

- **Automated** — does the institution support the `transactions` product, and
  is it OAuth (which determines whether ~12-month consent expiry and the
  update-mode re-auth flow apply)? `Institution.products` *is* reliable for
  `transactions`.
- **Manual** — does Plaid see *this entity's business accounts*, and is
  recurring detection good enough on them? Only linking the real account
  answers this. The closest signal, `account.holder_category`, is beta,
  requires account-manager enablement, is nullable, and often returns
  `unrecognized` — treating null as "personal" systematically misclassifies
  business accounts.

The spike prints a six-step manual protocol and GO criteria. Results go in
[`SPIKE-RESULTS.md`](SPIKE-RESULTS.md).

Two further limits: institution **status** is unavailable in Sandbox entirely
and null in Production for low-traffic institutions; and
`recurring_transactions` is not a filterable institution product, so
`transactions` is the correct proxy.

## 5. Decisions worth knowing before Slice 1

These were settled during Phase 0 and constrain what comes next.

- **`transactions.days_requested` is a one-shot decision.** It can only be set
  when Transactions is initialized on an Item and **cannot be changed
  afterwards** without `/item/remove` and a full re-Link. Default is 90 days,
  which would be actively harmful: §8 needs a trailing 12 months, §9 wants ≥180
  days to find annual streams. Ballast requests **730** (Plaid's max, and the
  blueprint's "~24 months"). `clampDaysRequested()` enforces the floor and
  ceiling server-side, because the 730 maximum appears only in Plaid's prose
  docs and is *not* in the SDK types.
- **D1 has no interactive transactions.** `BEGIN`/`COMMIT` error out. The only
  atomic unit is a single `db.batch([...])`. Slice 1's "approve a proposal
  commits atomically" requirement has to be built around one batch call.
- **Only the final sync cursor is durable.** Persisting a mid-pagination cursor
  and then crashing skips every update between that page and the end of the
  loop, silently and permanently. `sync-loop.ts` encodes this, along with: an
  empty cursor must never be stored (it is indistinguishable from "no cursor"
  and triggers a full-history replay), and a mutation-during-pagination error
  must restart from the **original** cursor with the accumulated arrays
  discarded.
- **Removals are tombstoned, never deleted.** Nothing guarantees the pending
  removal and the posted arrival land in the same page. Hard-deleting destroys
  the operator's envelope assignment. Tombstones must stay queryable for at
  least 14 days (Plaid: pending→posted "up to fourteen days in rare
  situations").
- **`pending_transaction_id` can be null even when a pending version existed.**
  Plaid matches the two with an ML model that can fail, and some institutions
  never expose pending transactions. Heuristic matching on amount is *not* the
  fallback and is deliberately not attempted — Plaid's own example is that a
  restaurant's pending charge excludes the tip while the posted one includes
  it, so a heuristic would mis-merge unrelated transactions.
- **Quarterly has no Plaid cadence.** The frequency enum has no `QUARTERLY` and
  no `DAILY`; quarterly bills — including the quarterly estimated-tax payment —
  land in `UNKNOWN`. Anything consuming cadence must treat `unknown` as a
  common, real case.
- **`available` is nullable and is not zero.** The invariant and "safe to
  spend" are pinned to available (§4). An institution that does not report it
  is a real problem, and null must never render as spendable.

## 6. Before this can run for real

1. **Provision infrastructure** and paste the ids into `wrangler.jsonc`
   (they are `PLACEHOLDER_*` today):
   ```bash
   wrangler d1 create ballast-db
   wrangler kv namespace create CACHE
   wrangler r2 bucket create ballast-receipts
   wrangler queues create ballast-sync
   wrangler queues create ballast-sync-dlq
   ```
2. **Set secrets:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `FIELD_ENCRYPTION_KEY`.
3. **Set `APP_ORIGIN`** to the real origin — the CSRF check compares against it.
4. **Create the operator user.** There is no self-service signup by design
   (single-operator app). Insert one row with a PBKDF2 hash from
   `hashPassword()`.
5. **Request the Recurring Transactions add-on** from Plaid (see §4 above).
6. **Run both spikes** and record the results.

## 6a. Adversarial review

Phase 0 was reviewed by five independent reviewers (auth/session, cryptography,
ledger correctness, Workers platform, PWA front end), and every finding was then
handed to a separate agent whose job was to **refute** it against the real code.
Roughly two thirds did not survive that step.

What the surviving findings changed, in rough order of how badly they would
have hurt:

- **Webhook replay suppression was keyed on the raw body digest.** A Plaid
  `SYNC_UPDATES_AVAILABLE` body carries no nonce and no timestamp, so two
  genuinely different sync events for the same Item are byte-identical. The
  unique index would have swallowed every sync notification after the first,
  permanently — Ballast would have stopped seeing new deposits while looking
  completely healthy. The key is now the signed delivery token.
- **A failed webhook could never be retried.** The intake row was written
  before the work and left in place on failure, so the 500 that asks Plaid to
  retry was answered by a retry the dedup index rejected.
- **The PWA document had no security headers at all.** The assets binding
  returns files unmodified, so `index.html` — the only response where CSP and
  `frame-ancestors` do anything — shipped bare.
- **Rate limiting did not limit under concurrency.** KV read-modify-write meant
  a parallel burst all read the same value and all passed. Now an atomic D1
  statement, with a test that fires 20 concurrent requests at a limit of 3.
- **The session cookie never slid**, so an actively-used session was dropped by
  the browser 14 days after login regardless of use.
- **Every focal alert rendered red**, because `data-tone` was written but no CSS
  read it — a "connect an account" prompt was styled as a failure, which is
  exactly the shame UI §14 forbids.
- **The theme was applied after first paint**, so dark-pole users got a white
  flash on every launch and the iOS chrome stayed tinted for the wrong pole.

Two findings were real but **latent**: `drainSync`/`planReconcile` and
`createLinkSession` have no callers until Slice 1 and Slice 6 respectively, so
neither could misbehave today. Both were fixed anyway, because they are exactly
the kind of defect that is invisible until the code that depends on them is
written.

## 7. Open items from the blueprint

§18 named three. Phase 0 moved one:

1. **Tax-reserve mechanic** — still the CPA's call. Untouched.
2. **Co-owner access / multi-user** — still deferred (Tier B). The schema
   carries `user_id` throughout and every query is scoped to it, so multi-user
   is an access-control change rather than a migration.
3. **Plaid business-account coverage** — **reframed.** Now known to be
   un-automatable from institution metadata; the spike splits it into an
   automated part and a manual protocol (§4 above). Still needs the real banks
   run through it.
