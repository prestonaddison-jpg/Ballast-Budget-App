# Where Ballast actually is

**Read this first in any new session.** It is the continuity record: what exists,
what is blocked, and what the next move is. It lives in the repo on purpose, so
it survives a session ending, a sandbox being reclaimed, or a laptop dying — it
is on GitHub and on any machine that has ever pulled.

Keep it current. A stale STATE.md is worse than none, because the next session
will believe it.

_Last updated: after v4.1.0 + the demo/tap-target fixes (commit `25e3670`)._

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

**Counts at `25e3670`: 361 unit tests, 114 browser tests.**

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

| Resource | Name                               | ID / note                                                                               |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| D1       | `ballast-db`                       | `e005e79c-2719-40d2-9837-eb0cdb6738c2` — **schema never applied remotely; it is empty** |
| KV       | `ballast-cache`                    | `c8581f3bdedf465d9c79ac957ca8546a`                                                      |
| R2       | `ballast-receipts`                 | exists                                                                                  |
| Queues   | `ballast-sync`, `ballast-sync-dlq` | **Existence unconfirmed** — no listing tool available. Likely absent.                   |
| Worker   | `ballast`                          | **Does not exist yet.** The account's `ballast-finance-app` is an unrelated Worker.     |

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
4. **There is no way to create the first user.** Even a perfect deploy has no
   account to log in with. The first `users` row has to be inserted directly
   (Claude can do this through the Cloudflare D1 connector).
5. **CI does not gate deploys.** GitHub Actions and Cloudflare do not talk to
   each other, so a red test suite will not stop a deploy.

---

## The defects this project keeps producing

Worth knowing, because the pattern repeats and the next session will hit it too.
Every one of these shipped, passed every test, and was found by _opening the app
and looking at it_:

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
