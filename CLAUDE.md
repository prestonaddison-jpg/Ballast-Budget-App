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

So, before reporting any UI work as done:

```bash
npm run build
npx wrangler dev --port 8787 --local &      # needs .dev.vars; see below
node scripts/seed-preview.mjs && npx wrangler d1 execute ballast-db --local --file=/tmp/ballast-seed.sql
node scripts/check-layout.mjs               # asserts layout in a real browser
node scripts/capture-preview.mjs            # screenshots both themes — LOOK AT THEM
```

`check-layout.mjs` is not optional and it is not a nice-to-have. It is the only
thing in this repo that can see a layout bug. Add to it when you find a class of
defect it would have missed.

## Cost discipline

The owner pays per turn. Two things to avoid:

- **Don't ship unverified and fix it later.** That bills the same work two or
  three times. Verify, then report.
- **Don't reach for a multi-agent review when opening the app would do.** A
  large review pass was run on this repo and most of its important findings
  were things a single browser screenshot showed. Use the cheap check first.

## Say it when it's broken

Report a defect when you find it, not bundled into the commit that fixes it.
The owner should hear "the nav was never on screen" as news, not as a line item
in a changelog.

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
