# Where Ballast actually is

**Read this first in any new session.** It is the continuity record: what exists,
what is blocked, and what the next move is. It lives in the repo on purpose, so
it survives a session ending, a sandbox being reclaimed, or a laptop dying — it
is on GitHub and on any machine that has ever pulled.

Keep it current. A stale STATE.md is worse than none, because the next session
will believe it.

_Last updated: live in production; migration 0004 applied remotely; login still failing and undiagnosed._

---

## Redundancy — where everything lives

Nothing important should exist in only one place.

| What                 | Where                                                      | Notes                                                                                                  |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| All code and history | This repo, branch `claude/phase-0-build-foundation-9hxw0l` | Also the GitHub **default** branch. There is no `main`.                                                |
| Remote copy          | `github.com/prestonaddison-jpg/Ballast-Budget-App`         | **Public.** See "Open risks".                                                                          |
| Local copy           | Any machine that pulls it (GitHub Desktop)                 | The sandbox Claude works in is **ephemeral** — nothing there survives.                                 |
| Working agreement    | `CLAUDE.md`                                                | How to work on this. Read before touching anything.                                                    |
| This record          | `docs/STATE.md`                                            |                                                                                                        |
| Deploy runbook       | `docs/DEPLOY.md`                                           | Verified against the live account, not from memory.                                                    |
| Task list            | TickTick                                                   | Second channel, for things the owner must do.                                                          |
| Version tags         | **Local only — `v3.0.0`…`v4.1.0` never reached GitHub**    | The web sandbox's git proxy returns 403 on tag refs. Push them from a real machine: `git push --tags`. |

---

## What is built

Every version below was verified in a real browser in both themes and is green
on CI across Chromium **and WebKit**. WebKit is the one that counts — Ballast
installs to the iOS Home Screen.

| Version         | What it added                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Phase 0         | Worker, cookie sessions, D1, PWA shell, Atelier/Graphite themes, the `LedgerSource` boundary, two spikes    |
| Slice 1         | The money model: envelopes, the closed ledger, the conservation invariant, Canvas v1, tap-to-fund           |
| **v3.0.0**      | Proposals staging model + the Needs You queue. Nothing moves without approval.                              |
| **v3.1.0**      | Edit a proposal's amount before approving. Also defined `--ctrlln`, which had been read and never defined.  |
| **v3.1.1**      | Entity isolation proved in a browser (a second seeded LLC). Also: `e2e/` is now typechecked.                |
| **v4.0.0**      | Obligations — due dates that reach the screen.                                                              |
| **v4.1.0**      | The focal alert points at the deadline that needs money.                                                    |
| _(unversioned)_ | Fixed a 21px tap target on "Mark complete"; brought the shareable demo generator back in sync with the app. |
| _(unversioned)_ | **Deployed.** Split `assertEnv` so the app runs without Plaid; login errors now say which thing went wrong. |
| _(unversioned)_ | **Migration 0004** — an entity with nothing budgetable is UNKNOWN, not $0. Found live. See below.           |

**Counts at `607a7b7`: 398 unit tests, 120 browser tests.**

Browser tests here are **Chromium only** — the Playwright CDN is blocked by this
container's network policy, so WebKit cannot be installed locally. CI is the
only WebKit signal, and WebKit is the engine that matters.

Run them with `npm run test:all`. The two suites answer different questions —
`CLAUDE.md` explains why, and why a green unit suite means very little on its
own.

---

## What is NOT built, and why

| Thing                                                                                    | Blocked on                                                                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Proposal triggers** (income detection, unassigned spend, tax skim, waterfall) → v5.0.0 | **Plaid.** They read transaction data. Until then the Needs You queue is fed by the preview seed. |
| Plaid Link flow (connect a bank from the UI)                                             | **Plaid account.** The sync plumbing exists; the connect button does not.                         |
| Variable-income engine, runway gauge                                                     | Needs income history → Plaid                                                                      |
| Receipts                                                                                 | R2 exists; the capture flow is unbuilt                                                            |
| Push notifications, onboarding                                                           | Not started                                                                                       |
| **First deploy**                                                                         | One OAuth click + the fixes in `docs/DEPLOY.md`                                                   |

Plaid is the single gate on most of the remaining roadmap. Everything reachable
without it, on the proposals and obligations side, is built.

---

## Cloudflare resources

Verified present in the account. IDs match `wrangler.jsonc`.

| Resource | Name                               | ID / note                                                                                                                                                                             |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1       | `ballast-db`                       | `e005e79c-2719-40d2-9837-eb0cdb6738c2` — **MIGRATED through 0004**, applied remotely by hand through the D1 connector. One user, one entity, one unallocated envelope, zero accounts. |
| KV       | `ballast-cache`                    | `c8581f3bdedf465d9c79ac957ca8546a`                                                                                                                                                    |
| R2       | `ballast-receipts`                 | exists                                                                                                                                                                                |
| Queues   | `ballast-sync`, `ballast-sync-dlq` | **Existence unconfirmed, and now PARKED** — the bindings are commented out of `wrangler.jsonc` until Plaid, because a deploy fails on a queue that does not exist.                    |
| Worker   | `ballast`                          | **LIVE**, deployed by Workers Builds on every push to this branch. Also at `ballast-finance-app.praeclarusventures.com`.                                                              |

---

## Open risks

1. **The repo is public.** No credentials are committed (`.dev.vars` is
   gitignored and none were found in the tree), but the LLC names, the seeded
   figures and the entire security design are world-readable. For a
   personal-finance app across real business entities, private is the safer
   default.
2. **The version tags exist only locally.** Push them from a real machine or
   they are lost when the sandbox is reclaimed.
3. **`FIELD_ENCRYPTION_KEY` must be generated fresh for production** and never
   reused from `.dev.vars`. Rotating it later makes every stored Plaid access
   token permanently undecryptable — the only recovery is re-linking every
   institution by hand.
4. ~~There is no way to create the first user.~~ **Done** — the first account
   exists in production. There is still no sign-up route and no
   password-change screen, so a second user, or a new password, means another
   direct insert until that is built.
5. **LOGIN IS BROKEN IN PRODUCTION AND UNDIAGNOSED.** The seeded user cannot
   sign in. `rate_limits` has rows, so requests reach the handler;
   `audit_log` is empty, so it dies before the user lookup. The exact same
   row replayed locally returns 200 + `login.success`, so the code is right
   and the failure is environmental. **The next step is Cloudflare dashboard →
   Workers & Pages → `ballast` → Logs**, which prints the actual exception.
   Do not guess again: $5 was already spent on a Workers Paid upgrade
   recommended off an inference rather than off that log.
6. **CI does not gate deploys.** GitHub Actions and Cloudflare do not talk to
   each other, so a red test suite will not stop a deploy.

---

## The defects this project keeps producing

Worth knowing, because the pattern repeats and the next session will hit it too.
Every one of these shipped, passed every test, and was found by _opening the app
and looking at it_:

- **An entity with nothing budgetable reported `$0`.** Live in production on
  the day of the first deploy: no bank linked, and the app said the operator
  holds nothing. `COALESCE(SUM(...) over nothing, 0)` is a confident zero.
  Worse, the same empty-pool path made a funded entity read
  "over-allocated by $16,900" the moment its only account was marked
  non-budgetable. Fixed by migration 0004; the class is now pinned by
  `test/worker/unknown-is-not-zero.test.ts`. **Every fixture in the suite
  seeded an account first**, which is why 361 tests never saw it — the one
  state a first deploy is guaranteed to be in was the one nothing exercised.
- The **Now-Bar rendered below the fold in every build** for the life of Phase 0
  and Slice 1. 234 tests passed throughout.
- **`--ctrlln` was read by two rules and defined nowhere**, so the quick-amount
  chips had no visible border — tappable controls rendering as plain text.
- **`.sheet-secondary` had no CSS rule at all**, so "Mark complete" — which
  archives an envelope — was a 21px tap target.
- The **due date was accepted and silently discarded** by the API, because its
  entire validation was `typeof x === 'string'`.
- The **new-envelope sheet claimed `aria-modal` with no focus trap**, so Tab
  walked out into a page assistive tech had been told was gone.

The shape is always the same: no parse error, no console warning, nothing a
server-side test can see. `npm test` runs in **workerd** — no browser, no layout
engine, no CSS. Anything visual is structurally invisible to it.

Two guards now exist for the _class_ rather than the instance — `css-tokens`
(every `var()` must be defined, in both themes) and the dialog tap-target checks
(the 44px rule now follows every sheet). When you find another of these, add the
class test before the fix.

---

## Picking this up in a new session

1. Read `CLAUDE.md`. It is the working agreement and it exists because of a
   specific, expensive failure.
2. Read this file.
3. `npm run test:all` — confirm the baseline is green before changing anything.
4. `node scripts/capture-preview.mjs` — look at the app. Do not skip this.
5. For a deploy, `docs/DEPLOY.md`.

**Cost note:** `npm run usage` prints what the current session has actually
cost, read from its own transcript. Do not estimate, and do not ask the owner to
read a progress bar. See `CLAUDE.md` — including the correction to the claim
this repo used to make about it.
