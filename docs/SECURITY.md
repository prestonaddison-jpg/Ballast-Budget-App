# Security decisions

Spine: **OWASP ASVS 5.0** — Level 2 app-wide, Level 3 on auth / session /
crypto / token paths (blueprint §16).

ASVS 5.0 deliberately specifies no numeric session timeouts: V7.3.1 (idle) and
V7.3.2 (absolute) defer to "risk analysis and documented security decisions",
and **V7.1.1 requires that the decision be documented**. This file is that
document.

---

## 1. Threat model, stated plainly

Ballast is **read-only and holds no custody**. It cannot move money, cannot
issue a card, and cannot decline a purchase. That removes the entire
custody-risk class by construction (§3) and shapes everything below.

What an attacker gains from a full compromise is therefore **visibility into
business cash position and transaction history** — commercially sensitive, but
not directly monetizable, and not a path to moving funds. The controls are
sized to that.

| Asset                  | Exposure if lost                               | Control                                                                                      |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Plaid access tokens    | Read access to bank transactions until revoked | Field-encrypted at rest (AES-256-GCM, AAD-bound), server-side only, never sent to the client |
| Session cookie         | Full app access as the operator                | HttpOnly (JS can never read it), `__Host-` prefix, `SameSite=Strict`, hashed at rest         |
| Operator password      | Account takeover                               | PBKDF2-HMAC-SHA256, 600k iterations, per-user salt                                           |
| D1 contents            | Balances, transaction history, audit trail     | AES-256-GCM at rest via Cloudflare KMS; secrets additionally field-encrypted                 |
| Receipts (R2, Slice 5) | Highest tier — may contain card numbers        | App-layer encryption, cookieless serving, attachment disposition                             |

**Explicitly out of scope:** a compromised Worker. Field encryption protects a
D1 dump, a backup, or a SQL export. It cannot protect against code running with
the key — that is stated so nobody over-trusts it.

## 2. Session design

| Property         | Value                                              | Why                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token            | 256 bits, `crypto.getRandomValues`                 | ASVS V7.2.3 requires ≥128 bits for reference tokens. (The Session Management Cheat Sheet still quotes 64; 5.0's 128 is the floor built to.)                                                                                                          |
| Format           | Opaque, not a JWT                                  | Nothing to parse, no algorithm to confuse, revocation is a row update rather than a blocklist                                                                                                                                                        |
| At rest          | SHA-256 of the token                               | A dump of `sessions` yields nothing usable. **Defence in depth — ASVS 5.0 has no requirement for this, so no requirement id is claimed.** A fast hash is correct here: the input already has 256 bits of entropy, so there is nothing to brute-force |
| Idle timeout     | 14 days                                            | See risk analysis below                                                                                                                                                                                                                              |
| Absolute timeout | 90 days                                            | Caps a stolen token that is kept warm by use                                                                                                                                                                                                         |
| Rotation         | New token on every authentication, old one revoked | ASVS V7.2.4 — both halves: mint new **and** terminate old. Kills session fixation                                                                                                                                                                    |
| Revocation       | Server-side, immediate                             | `revoked_at` checked on every validation                                                                                                                                                                                                             |

### Risk analysis for the timeout values (ASVS V7.1.1)

Ballast is single-operator, read-only, and installed to **one** iOS Home Screen
behind device biometrics. The dominant realistic threat to a live session is an
**unattended or stolen device** — which the OS lock screen already addresses,
and which no application-level timeout meaningfully improves on.

Against that, the cost of aggressive timeouts is concrete: this is a
_glanceable_ cash-allocation app whose whole purpose is to make "what's free to
spend" cheap to check. A login wall on every open trains the operator to stop
opening it, which defeats the application's reason to exist and pushes them
back to guessing at a bank balance — the exact failure mode described in §2 of
the blueprint.

14 days idle / 90 days absolute balances those. Both are enforced server-side
and independently. Revisit if the app ever gains write capability, a second
user, or consumer-facing exposure (Tier C), any of which invalidates this
reasoning.

### Cookie

```
__Host-ballast_session=<token>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=...
```

- **`__Host-` prefix** is browser-enforced: the cookie is only accepted with
  `Secure`, `Path=/`, and **no `Domain`**. That last part is the valuable one —
  it makes the cookie un-settable by a sibling subdomain, defeating
  cookie-tossing and cross-subdomain fixation.
- **`SameSite=Strict`** is safe here: same-origin `fetch()` from an installed
  standalone PWA always carries the cookie. Strict only withholds it on
  cross-site **top-level navigation**, and Ballast has no inbound-link flow —
  it is opened from the Home Screen.
- **Deployment constraint:** SameSite is scoped to the **registrable domain**,
  not the origin. Ballast must not be served from a subdomain of a parent
  domain shared with hosts outside this project; a sibling subdomain would
  count as same-site and a subdomain takeover would defeat SameSite entirely.

## 3. CSRF

Three layers, because each alone has a gap:

1. **`SameSite=Strict`** — the primary control.
2. **`Sec-Fetch-Site`, then `Origin`** — OWASP now treats fetch metadata as the
   primary signal but states an Origin/Referer fallback **"is a mandatory
   requirement"**, because legacy and embedded browsers omit `Sec-Fetch-*`.
   Enforced only on unsafe methods: `Origin` is absent on same-origin GET in
   most browsers, so treating its absence as an attack would break navigation.
3. **A required custom header** (`X-Requested-With: ballast`) — a cross-origin
   form, `<img>`, or `<script>` cannot set one without a preflight the Worker
   never approves.

Responses vary by `Sec-Fetch-Site` and `Origin`, so every response carries
`Vary: Sec-Fetch-Site, Origin, Cookie`. Without it a shared cache — Cloudflare's
own included — could serve one context's response into another.

**The webhook route is deliberately exempt.** Plaid is a server: no `Origin`,
no `Sec-Fetch-Site`, no custom header. Its authorization is the ES256
signature, verified before the body is parsed. It is mounted _before_ the CSRF
middleware in `src/index.ts`, which is load-bearing.

## 4. Cryptography

All Web Crypto. **Never `Math.random()`** — `src/crypto/random.ts` is the single
audit point for every secret value.

| Use                   | Construction                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords             | PBKDF2-HMAC-SHA256, 600,000 iterations (current OWASP recommendation), 16-byte salt, 256-bit output. Parameters travel with the hash, so cost can be raised and old hashes transparently upgraded on next login |
| Field encryption      | AES-256-GCM, **unique random 96-bit IV per encryption**, AAD bound to the row id, versioned envelope `v1.<iv>.<ct>`                                                                                             |
| Session tokens        | 256-bit CSPRNG, SHA-256 at rest                                                                                                                                                                                 |
| Webhook verification  | ECDSA P-256 / SHA-256 (ES256), raw r‖s signature                                                                                                                                                                |
| Constant-time compare | Native `crypto.subtle.timingSafeEqual` where available, portable XOR fallback otherwise                                                                                                                         |

Notes that are easy to get wrong and are therefore encoded in the code:

- **Argon2id would be the first choice** but Web Crypto offers only PBKDF2 from
  that family. Shipping a WASM Argon2 would add a large audited-dependency
  surface to the most security-critical path. PBKDF2 at 600k is the sanctioned
  fallback. _(Node's `crypto` is now available on Workers by default at
  compatibility dates ≥ 2026-08-04, but it does not implement argon2 either.)_
- **GCM IV reuse is worse than CTR IV reuse.** Besides revealing the plaintext
  XOR, a repeated `(key, IV)` leaks the GHASH subkey, allowing **tag forgery**
  under that key. With random 96-bit IVs the birthday bound caps safe use near
  2³² encryptions per key — unreachable here (one field per institution), but
  the reason key rotation is a documented procedure.
- **AAD prevents ciphertext relocation.** Without it, someone with write access
  to D1 could move a valid ciphertext between rows and the Worker would decrypt
  it happily.
- **`crypto.randomUUID()` is not a secret generator.** A v4 UUID carries 122
  bits, below ASVS V11.5.1's 128-bit floor, which calls UUIDs out by name. It
  is used only for non-secret identifiers (primary keys, audit ids).
- **Rate-limit before the KDF.** 600k PBKDF2 iterations is real billed CPU on
  every attempt, so an unthrottled login endpoint is a DoS amplifier as well as
  a credential-stuffing target. The limiter runs first.
- **The limiter is in D1, not KV, because it has to be atomic.** A KV
  implementation reads the counter, compares, and writes `count + 1` across
  three awaited steps. That is a read-modify-write with no atomic increment, so
  a burst of concurrent logins all observe the same pre-increment value and all
  pass — twenty parallel requests against a limit of three would every one of
  them succeed. D1 increments and reads in a single
  `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement, which is atomic.
  `test/worker/rate-limit.test.ts` fires twenty concurrent requests and asserts
  exactly three are allowed.

## 5. Authorization — BOLA

BOLA is the #1 API risk (§16). The defence is structural rather than
disciplinary:

- Every table holding user data carries `user_id`.
- Every repository function takes the **authenticated** `userId` and puts it in
  the `WHERE` clause.
- Single-row reads are `WHERE id = ? AND user_id = ?` — ownership is part of
  the lookup, not a follow-up check that can be forgotten at a call site.
- There is deliberately **no** `findById(id)` that trusts a caller-supplied id.

The one lookup keyed on a provider id (`findItemByProviderId`) exists solely for
the webhook path, where there is no authenticated user and the signature is the
authorization. It returns `user_id`, which every downstream query then scopes
to.

## 6. Worker discipline

- **No request state in module or global scope.** Workers reuse isolates across
  requests; a module-level mutable is a cross-request leak — here, one entity's
  balances under another's session. Per-request state lives in the Hono context
  only. The one module-scope cache (`CACHE` KV, Plaid signing keys) holds
  **public, non-request** data.
- **Cloudflare bindings, never REST APIs.**
- **Secrets via `wrangler secret put`**, redacted from logs. `.dev.vars` is
  gitignored. Use `.dev.vars` **or** `.env`, never both — if `.dev.vars` exists,
  wrangler excludes `.env` from `env` entirely.
- **Errors return no detail.** The reason a session was rejected (missing /
  expired / revoked) is logged; the client always sees a flat 401. Login
  returns an identical body for unknown-user and wrong-password, and burns
  comparable CPU in both cases so the two are indistinguishable by timing.

## 7. Response headers

`Content-Security-Policy`, `Strict-Transport-Security` (production only),
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
`Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Vary`, and
`Cache-Control: no-store, private` on anything derived from account data.

**These are applied to the DOCUMENT as well as the API.** That is not
automatic: the assets binding returns the built file unmodified, so an earlier
version of this code shipped `index.html` — the only response where CSP and
anti-framing actually do anything — with no headers at all, while the JSON
responses a browser never renders carried every one of them. `withSecurityHeaders`
in `src/index.ts` rebuilds the asset response, and `test/worker/routing.test.ts`
asserts it, so the gap cannot silently reopen.

CSP notes:

- No `'unsafe-inline'` for **scripts**. `style-src` keeps it as a narrow
  concession for the handful of inline styles the components set (gauge sweep
  offset, meter width); scripts, the actual XSS vector, stay strict.
- **`worker-src` and `manifest-src` are set explicitly.** They fall back through
  `child-src` → `script-src` → `default-src`, and a strict `script-src` would
  otherwise block the service worker and the manifest — on an installed PWA
  that means no offline shell and no install.
- `frame-ancestors 'none'` is the credited anti-framing control: **ASVS V3.4.6
  declares `X-Frame-Options` obsolete**. Both are sent; only the former counts.
- `connect-src 'self'` — the browser never talks to Plaid; all Plaid calls are
  server-side. **Adding Plaid Link (Slice 1+) will require widening this**, and
  the comment in the code says so, so widening is a conscious edit.

## 8. Service worker

The service worker **never caches anything under `/api/`**. Not
network-first, not stale-while-revalidate — it returns early without calling
`respondWith()`, so there is no code path on which a financial response can be
stored.

This is not paranoia: **Cache Storage is keyed by URL with no notion of user
identity.** A cached authenticated response is readable by the next person to
open the device, with no token. A cached "safe to spend" is also the same class
of lie as a stale sync (§14) — except the operator cannot see that it is stale.

## 9. Webhook verification

The webhook route is **public** — Cloudflare Access was dropped precisely
because it blocked Plaid's callbacks (§15). The ES256 signature is the only
thing between the open internet and the sync pipeline, so the order matters:

1. Read the raw body **once**. It is a stream, and re-serializing parsed JSON
   changes the bytes the digest covers — Plaid sends the body pretty-printed
   with two-space indentation.
2. Decode the JWT header **without** verifying; assert `alg === "ES256"` before
   any crypto. This is the algorithm-confusion guard.
3. Fetch the JWK by `kid` (the request field is `key_id` — the names differ).
   Reject outright if `expired_at` is non-null. Pass only `{kty, crv, x, y}` to
   `importKey`; Plaid's JWK carries non-standard members.
4. Verify the signature over `header.payload` exactly as received.
5. Reject if `iat` is older than 5 minutes (replay bound).
6. Compare the raw-body SHA-256 to `request_body_sha256` in **constant time**.
7. Only then parse.

Verifying the signature without also checking the body digest would let an
attacker replay a valid JWT against a swapped body. Note that
`crypto.subtle.verify` **resolves `false`** on a bad signature rather than
throwing — key-import failure and signature failure are logged as distinct
branches so a forged webhook is not mistaken for a key bug.

Verified webhooks are recorded and deduplicated because Plaid retries — but
**the dedup key is the signed delivery token, not the body**.

Keying on the body digest looks obviously right and is badly wrong: a
`SYNC_UPDATES_AVAILABLE` body carries no nonce and no timestamp, so two
genuinely different sync events for the same Item are **byte-identical**. A
unique index on the body digest would swallow every sync notification after the
first one, permanently, and Ballast would silently stop seeing new deposits —
while looking perfectly healthy. The JWT is unique per delivery (it carries an
`iat` the signature covers) and a genuine Plaid retry re-sends the same JWT, so
hashing it gives exactly the wanted semantics. Enforced by a unique index plus
`INSERT OR IGNORE` with `meta.changes` checked, so concurrent retries cannot
both proceed.

Verification failures return **401** (an authorization failure Plaid should not
retry). A _retryable_ failure — Plaid's own key endpoint being down — returns
**503** instead, because the webhook may be perfectly valid and a 401 there
would tell Plaid to stop, losing a legitimate sync notification for good.

## 10. Privacy stance

Business-only internal use → **not** a GLBA consumer-facing "financial
institution". The Safeguards-Rule technical controls are built as good
practice. A consumer-facing version (Tier C) would require an attorney and
invalidates the risk analysis in §2.

## 11. Known gaps

Honest list of what Phase 0 does **not** yet do:

- **No passkey / WebAuthn.** Password + PBKDF2 ships now; a passkey is the
  right long-term answer on iOS and is a Slice 7 candidate.
- **No MFA.** Single-operator app behind device biometrics; revisit with
  multi-user (Tier B).
- **No `Clear-Site-Data` on logout.** It would also wipe the service-worker
  shell cache, forcing a cold re-fetch. Worth adding with a considered UX cost.
- **No automated dependency scanning.** Dependabot + Socket.dev + SCA in CI are
  Slice 7 per §16.
- **The ASVS L2/L3 pass has not been formally run.** The controls are built to
  it; the audit itself is Slice 7.
