# Ballast

A read-only, Plaid-connected, multi-entity business cash-allocation PWA for the
Praeclarus Ventures entities. It reads real bank balances and transactions,
classifies the money, and helps the operator allocate it into purpose-labeled
envelopes — so "what's actually free to spend" is always honest.

**Ballast never holds or moves money.** It labels the real balance; it can
suggest a transfer, never execute one. The bank is the vault; Ballast is the
brain.

This repository currently contains **Phase 0** — the skeleton and the spikes.
See [`docs/PHASE0.md`](docs/PHASE0.md) for exactly what is and is not built.

---

## Quick start

```bash
npm install                      # see the note on .npmrc below
npm run gen:key                  # generate FIELD_ENCRYPTION_KEY
cp .dev.vars.example .dev.vars   # then fill in Plaid credentials + the key

npm run db:migrate:local         # apply migrations to the local D1
npm run build                    # build the PWA shell into dist/client
npm run dev                      # wrangler dev, serving API + shell on one origin
```

Verify everything:

```bash
npm run typecheck                # Worker, web, and test projects
npm test                         # 130 tests, incl. real-D1 Worker tests
npm run build
```

## The two Phase 0 spikes

```bash
# A — does the Plaid plumbing work, and do our assumptions hold?
export PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox
npm run spike:plaid
npm run spike:plaid -- --webhook https://<your-worker>.workers.dev/api/webhooks/plaid

# B — per-institution go/no-go for the real banks (blueprint §18.3)
export PLAID_ENV=production
npm run spike:coverage -- --banks "Chase,Frost Bank"
```

Record the outcomes in [`docs/SPIKE-RESULTS.md`](docs/SPIKE-RESULTS.md).

## Layout

```
src/                     Cloudflare Worker (BFF)
  auth/                  cookie-only sessions, PBKDF2 passwords
  crypto/                Web Crypto only — random, AES-GCM, hashing
  db/repos/              D1 access, every query scoped to user + entity
  http/                  routing middleware, CSRF, security headers
  ledger-source/         THE provider boundary
    types.ts             the interface + normalized domain types
    txn-key.ts           stable transaction identity + reconcile planning
    sync-loop.ts         pagination + cursor discipline
    plaid/               the sole implementation
  routes/                auth, me, health, webhook
web/                     PWA shell (Vite, vanilla TS)
  src/styles/            Alongside tokens + shared component layer
  src/components/        gauge, Now-Bar, focal alert, freshness, collapsible
migrations/              D1 schema
spikes/                  the two Phase 0 spikes
test/                    unit + Worker (real D1 via Miniflare)
docs/                    Phase 0 notes, security decisions, spike results
```

## A note on `.npmrc`

`legacy-peer-deps=true` is set deliberately. npm 10's resolver crashes
(`Cannot read properties of null (reading 'edgesOut')`) on
`@cloudflare/vitest-pool-workers` + vitest 4, because vitest declares optional
peers that npm resolves to their v5 line. The conflict is spurious — none of
those packages are installed — and it is not fixable with `overrides`
(verified). The comment in `.npmrc` records this.

## Source of truth

`MAIN_Ballast-Build-Blueprint.md` v3.0 is the specification. Section references
throughout the code (§4, §9, A.5, …) point at it. Where this build deviates
from the blueprint, the deviation is stated and justified in
[`docs/PHASE0.md`](docs/PHASE0.md) — there is exactly one.
