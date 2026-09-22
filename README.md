# Ballast

A read-only, Plaid-connected, multi-entity business cash-allocation PWA for the
Praeclarus Ventures entities. It reads real bank balances and transactions,
classifies the money, and helps the operator allocate it into purpose-labeled
envelopes — so "what's actually free to spend" is always honest.

**Ballast never holds or moves money.** It labels the real balance; it can
suggest a transfer, never execute one. The bank is the vault; Ballast is the
brain.

**Built (v3.0.0):** Phase 0 (Worker, cookie sessions, D1, PWA shell,
Atelier/Graphite themes, the `LedgerSource` boundary, both spikes); the money
model and Canvas v1 (envelopes, the ledger, the conservation invariant,
tap-to-fund); and the **staging model + Needs You queue** — proposals that
touch no balance until you approve them, checked against your real balance at
the moment you approve rather than when they were suggested.

**Not built:** the triggers that GENERATE proposals from activity (income
detection, unassigned spend, the waterfall) — they need transaction data, so
they need Plaid. Until then the queue is fed by the preview seed. Also the
variable-income engine, obligations + projects, receipts, push + onboarding,
hardening, and the Plaid Link flow — the sync plumbing exists, the connect UI
does not. See [`docs/PHASE0.md`](docs/PHASE0.md) for the detail.

---

## Where things stand

Two files carry the state of this project across sessions and machines, so
nothing depends on a conversation still being open:

- **[`docs/STATE.md`](docs/STATE.md)** — what is built, what is blocked, what
  the next move is, and the defects this codebase keeps producing.
- **[`docs/DEPLOY.md`](docs/DEPLOY.md)** — how it gets live and stays live,
  verified against the live Cloudflare account.

Read [`CLAUDE.md`](CLAUDE.md) before changing anything.

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

## Verifying

Two suites, and they answer different questions:

```bash
npm test          # 235 tests in workerd — the money model, the Worker, the ledger
npm run test:e2e  # 36 tests in a real browser — iPhone size, both themes, real D1
npm run test:all  # typecheck + both
```

`npm test` runs inside **workerd**: no browser, no layout engine, no CSS. It is
the right tool for the ledger and structurally blind to anything visual. The
Now-Bar was off-screen in every build for the life of the project while 234 of
those tests passed. That is what `test:e2e` is for; it builds, migrates, seeds
and serves by itself.

Both run in CI on every push (`.github/workflows/ci.yml`) — the browser job
across Chromium and **WebKit**, which is the engine Ballast actually runs in on
the iOS Home Screen.

To look at the app rather than assert on it:

```bash
node scripts/capture-preview.mjs   # screenshots both themes into preview/
node scripts/build-artifact.mjs    # one self-contained page for sharing
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
  money/                 envelopes, the ledger, the conservation invariant
  routes/                auth, me, health, webhook, envelopes + transfers
web/                     PWA shell (Vite, vanilla TS)
  public/fonts/          the three design-system faces, self-hosted
  src/styles/            Alongside tokens + shared component layer
  src/lib/               pure logic — no DOM, so it is testable in workerd
  src/components/        tiles, zone grid, fund sheet, Now-Bar, focal alert
migrations/              D1 schema
spikes/                  the two Phase 0 spikes
scripts/                 seeding, screenshots, the shareable demo page
test/                    unit + Worker (real D1 via Miniflare)
e2e/                     Playwright — the only suite that can see the app
docs/                    Phase 0 notes, security decisions, spike results
```

## A note on `.npmrc`

`legacy-peer-deps=true` is set deliberately. npm 10's resolver crashes
(`Cannot read properties of null (reading 'edgesOut')`) on
`@cloudflare/vitest-pool-workers` + vitest 4, because vitest declares optional
peers that npm resolves to their v5 line. The conflict is spurious — none of
those packages are installed — and it is not fixable with `overrides`
(verified). The comment in `.npmrc` records this.

## Deploying

D1, KV and R2 are provisioned and wired into `wrangler.jsonc`. Before the first
deploy:

`npm run deploy` refuses to run while `wrangler.jsonc` still carries
development values — see `scripts/check-deploy-config.mjs`.

```bash
wrangler login
wrangler queues create ballast-sync
wrangler queues create ballast-sync-dlq
npm run gen:key && wrangler secret put FIELD_ENCRYPTION_KEY   # NOT the .dev.vars value
wrangler secret put PLAID_CLIENT_ID
wrangler secret put PLAID_SECRET
npm run db:migrate:remote

# APP_ORIGIN in wrangler.jsonc must be the https:// origin this Worker serves.
# Left as http://localhost, the Worker treats itself as local development and
# ships session cookies WITHOUT the Secure flag. The predeploy check blocks it.
npm run deploy
```

`FIELD_ENCRYPTION_KEY` encrypts stored Plaid access tokens. Rotating it makes
every stored token undecryptable and the recovery path is re-linking each
institution, so generate it once and keep it somewhere durable.

## Source of truth

`MAIN_Ballast-Build-Blueprint.md` v3.0 is the specification. Section references
throughout the code (§4, §9, A.5, …) point at it. Where this build deviates
from the blueprint, the deviation is stated and justified in
[`docs/PHASE0.md`](docs/PHASE0.md) — there is exactly one.
