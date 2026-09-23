# Working on Ballast

Read this before you touch anything. It exists because of a specific failure,
described below, that cost the owner real money.

## The rule that matters

**A passing test suite does not mean the app works. Run it and look at it.**

`npm test` runs inside **workerd** — a server runtime. No browser, no layout
engine, no CSS, no `document`. Anything visual is structurally invisible to it.

This is not hypothetical. For most of Phase 0 and Slice 1, `.screen` had
`min-height` and no flex context, so `.scroll` was never a scroll container and
the Now-Bar — all four destinations plus the one status pill the whole design
hangs off — rendered several hundred pixels below the fold and was **never
visible in any build**. 234 tests passed the entire time. It was found by
opening the app in a browser, which nobody had done.

So there are two suites, and they answer different questions:

```bash
npm test          # workerd: the money model, the Worker, the ledger
npm run test:e2e  # real browser, iPhone size, both themes, real Worker + D1
npm run test:all  # typecheck + both
```

`npm run test:e2e` builds, migrates, seeds and serves by itself — no setup
steps to remember. Each test re-seeds, so every one starts from the same
figures ($18,420 available, $16,900 spoken for, $1,520 free) and can assert
exact amounts. Auth is a seeded session cookie, not the login form, because the
login route is rate limited to 10 per window and would 429 the eleventh test.

`npm run test:e2e:ui` opens the Playwright UI for stepping through a failure.

**Both suites run in CI on every push** (`.github/workflows/ci.yml`), the
browser job across Chromium and WebKit. WebKit is the one that matters — Ballast
is installed to the iOS Home Screen, so Safari's engine is the real target.

**You cannot run WebKit in this container.** The Playwright CDN is blocked by
the network policy, so `npx playwright install webkit` fails with a 403 and
`npm run test:e2e` locally means Chromium only. CI is the sole WebKit signal —
so a local green is a partial result, and a push is not finished until the
WebKit job reports.

It has already caught one engine-specific defect. `page.route()` does NOT
intercept requests that pass through a controlling service worker in WebKit,
only in Chromium — and `sw.ts` calls `clients.claim()`, so it controls the page
after the first load. A `route.abort()` on `/api/…` silently did nothing: the
request went to the network, the app loaded fine, and the test measured a
healthy app while claiming to measure a broken one. `test.use({ serviceWorkers:
'block' })` takes the worker out of the path. If you inject a fault, assert
that the injection fired.

When you find a defect this suite would have missed, add a test for that class
of defect before you fix it.

For looking at the app rather than asserting on it:

```bash
node scripts/capture-preview.mjs   # screenshots both themes into preview/
node scripts/build-artifact.mjs    # one self-contained page for sharing
```

## Cost discipline

`npm run usage` reads the current session's own transcript and prints exactly
what it has cost — turns, input, cache reads, output. Do not estimate token
usage or ask the owner to read a progress bar; run it.

MEASURED ON THIS REPO, and it is the whole argument for short sessions: the
build session that produced Phase 0 and Slice 1 ran **540 turns and
212,021,785 tokens**. Output — the actual work — was **695,952** of that.
**203,186,908 was cache_read: the same conversation re-sent to itself, over
and over.** A 300:1 ratio.

Every turn resends the whole thread, which is where that ratio comes from.

CORRECTION, measured later in the same transcript. An earlier version of this
paragraph said "turn 400 costs orders of magnitude more than turn 4". That is
wrong, and it was wrong when it was written. At 777 turns the transcript read
280,614,174 tokens — so the stretch from turn 540 to turn 777 cost 68,592,389
across 237 turns, or **289k per turn against the 393k lifetime average**.
LOWER, not higher, because the session was compacted partway through and the
context reset.

So context growth is bounded by compaction, and a long session does not
compound the way that sentence implied. What IS true is the ratio: 96% of
every session is the conversation re-sent to itself, which makes a turn
expensive regardless of where in the session it falls. Fewer, better turns is
the lever. A fresh session per version still helps — a compaction is a lossy
summary, and starting clean beats working from one — but it is a preference,
not the two-orders-of-magnitude emergency this file used to claim.

Measure before repeating any of this. `npm run usage` is right there, and the
first version of this paragraph is what guessing looks like.

The owner pays per turn. Two things to avoid:

- **Don't ship unverified and fix it later.** That bills the same work two or
  three times. Verify, then report.
- **Don't reach for a multi-agent review when opening the app would do.** A
  large review pass was run on this repo and most of its important findings
  were things a single browser screenshot showed. Use the cheap check first.

## Naming is the owner's call

ASK before naming anything the owner will have to live with or type: a Worker,
a repo, a branch, a custom domain, a database, a queue. Offer a suggestion,
then wait. Do not pick one and present it as a step.

This is here because of a specific mess. Claude told the owner to create a
Worker called `ballast` — without asking, and without noticing they had already
built `ballast-finance-app` for exactly this purpose a few hours earlier. It
also said "Import a repository" without naming WHICH repository. The result was
two Workers, two repos and a custom domain with two things pointed at it, and
the owner reasonably asking why they were being told to rebuild from scratch
what they had already set up.

None of that was a hard problem. It was three unasked questions.

Related, and the same root cause: when the owner has already set something up,
find out what it is before routing around it. A resource that looks unrelated
may be the thing they made for this, named the way they wanted it.

## Say it when it's broken

Report a defect when you find it, not bundled into the commit that fixes it.
The owner should hear "the nav was never on screen" as news, not as a line item
in a changelog.

## Before you tell the owner to spend money

This rule cost $5 and a good deal of trust, so it is written down.

Production login was failing. PBKDF2 was measured at 281ms against a
documented 10ms CPU limit on the free plan. That was a real finding — and it
was reported as _the_ cause. The owner upgraded to Workers Paid. Login still
failed.

Three separate errors, each avoidable:

1. **"This is a real problem" was collapsed into "this is the problem."** A
   confirmed blocker on one path says nothing about whether it is the one
   currently firing. Say which it is.
2. **An inference was preferred over a log.** Cloudflare prints the actual
   exception under Workers & Pages → the Worker → **Logs**, and Metrics shows
   `exceededResources` directly. Both are free and neither had been read.
   Read the log before reasoning about what the log would say.
3. **A purchase was recommended before the free diagnostic was run.** Never
   again. If a fix costs money, the evidence for it must be something
   observed, not something derived.

Report confidence honestly: "this is a blocker we will hit" and "this is what
is happening right now" are different sentences.

## Architecture: the three things that will bite you

1. **D1 has no interactive transactions.** Only a single statement or
   `db.batch([...])` is atomic. Never read a balance and then write based on it
   — fold the check into the write. See `src/money/ledger.ts`; the pattern is
   pinned by `test/worker/d1-atomic-guard.test.ts`.

2. **`unallocated` is a residual, not a ledger sum.** It is defined as
   `SUM(budgetable available) − SUM(named envelopes)`, which makes conservation
   an algebraic identity rather than something a reconciliation job maintains.
   Read the header of `migrations/0002_slice1_money_model.sql` before changing
   anything about balances.

3. **Never render an unknown as a number.** A balance the bank has not reported
   is `null` all the way to the screen and renders as an em dash. Coercing it to
   `0` is the single most dangerous bug this app can have — it tells the operator
   they have nothing when the truth is that we do not know. `?? 0` on a
   `balanceMinor` is always wrong.

## Conventions

- Money is **integer minor units**, never a float. `parseMoneyToMinor` converts
  by string, because `12.34 * 100` is `1233.9999999999998`.
- No dead controls. If there is nothing behind a button, do not render it.
- Progress uses the brand accent, never `--bad`. "Not yet full" is not a failure.
- Percentage-of-target framing ("62% of $4,000"), never shortfall.

## Local setup

`.dev.vars` is gitignored. Copy `.dev.vars.example` and fill it; for local
preview the Plaid values can be dummies, but `FIELD_ENCRYPTION_KEY` must be a
real 32-byte key (`npm run gen:key`). Changing `database_id` in `wrangler.jsonc`
gives you a **fresh empty local D1** — re-run migrations and the seed.
