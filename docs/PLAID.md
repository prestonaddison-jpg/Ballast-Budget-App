# Connecting Plaid

Every fact in here was checked against Plaid's own docs and help centre on
**23 September 2026**, not recalled. Where something could not be confirmed it
says so instead of guessing. Sources are at the bottom.

**Your part is about 20 minutes and it is all in two browser tabs.** Nothing
here needs a terminal.

---

## The headline, because it changes the plan

Plaid now has a **free Trial plan** for US teams created on or after 15 April 2026. It uses **real production data** — your actual bank balances, not fake
ones — costs nothing, and is **auto-approved for most developers**. It is
capped at **10 Production Items** (an Item = one bank login), and it includes
the **Transactions** product, which is the one Ballast needs.

You have a handful of LLCs. Ten is plenty.

So there is no multi-day approval standing between you and real data. The only
slow thing is the **Recurring Transactions add-on**, and that is only needed
for v5.0.0's "this subscription hits on the 3rd" detection — everything else
(balances, transactions, the envelopes, the whole Canvas) works without it.
That is why step 5 is "start the clock and walk away".

One cost warning, verified: **`/item/remove` does not free up a slot** against
the 10-Item cap. Connecting the same bank twice by accident burns two of ten
permanently. Connect deliberately.

---

## Step 1 — Create the Plaid account (3 min)

1. Go to **<https://dashboard.plaid.com/signup>**
2. Sign up with your email. Use a business address you will keep — this
   becomes the owner of the API keys.
3. When it asks for a **company name**, use the legal entity you want on the
   account. This is a naming decision that is yours, not mine: it appears on
   the account and in some institution-facing screens. If you are unsure,
   **Praeclarus Ventures** is the umbrella and is the safe answer.
4. Verify the email it sends you.

Sandbox access is live immediately. No approval, no card.

---

## Step 2 — Copy the two sandbox keys (2 min)

1. In the Plaid dashboard, open **Developers → Keys**
   (direct link: **<https://dashboard.plaid.com/developers/keys>**)
2. You will see:
   - **Client ID** — one value, shared across all environments
   - **Sandbox secret** — a _different_ value from your production secret
3. Copy both somewhere temporary. You are about to paste them into Cloudflare.

**Do not paste them into a chat message, including to me.** They go into
Cloudflare's secret store and nowhere else. I never need to see them; the
Worker reads them at runtime.

---

## Step 3 — Put them into Cloudflare (5 min)

Exact clicks, because this screen has a trap in it.

1. Go to **<https://dash.cloudflare.com>**
2. Left sidebar → **Compute (Workers)** → **Workers & Pages**
3. Click the Worker named **`ballast`**
4. Top tabs → **Settings**
5. Find **Variables and Secrets** → click **+ Add**

Add these **two**, and for each one set **Type = Secret**, not Text:

| Name              | Value                              |
| ----------------- | ---------------------------------- |
| `PLAID_CLIENT_ID` | the Client ID from step 2          |
| `PLAID_SECRET`    | the **Sandbox** secret from step 2 |

6. Click **Deploy** / **Save** when it offers.

**THE TRAP, and it has bitten this project before.** Secrets set in the
dashboard survive every future deploy. Plain **Text** variables are **wiped and
rewritten from `wrangler.jsonc` on every deploy**. If you add these as Text,
they will silently vanish the next time I push, and Plaid will start returning
401s for no visible reason.

**Also do NOT add `PLAID_ENV` here.** It already lives in `wrangler.jsonc` and
is currently `"sandbox"`. Setting it in the dashboard does nothing — the next
deploy overwrites it. When you are ready to point at real banks, I change that
one word in the file and push. That is my job, not yours.

### While you are on that screen — check `FIELD_ENCRYPTION_KEY`

Look at the list of existing secrets. There should already be one called
`FIELD_ENCRYPTION_KEY`. If it is there, **leave it alone and do not regenerate
it, ever.** It encrypts the Plaid access tokens in the database. Rotating it
makes every connected bank permanently undecryptable, and the only recovery is
re-linking every institution by hand.

If it is **missing**, tell me and I will generate one before you connect
anything — it must exist before the first bank is linked, not after.

---

## Step 4 — Apply for the Trial plan (5 min)

This is what gets you real bank data, free.

1. In the Plaid dashboard, click **Request production access**
   (it is usually a banner or a button in the top-right of the dashboard home)
2. You will get a four-section form:

   **(a) Describe your business.** Business type, details, industry, app
   details. Use the real LLC. Industry is closest to _Personal finance_ or
   _Business financial management_.

   **(b) Select your products.** Tick **Transactions**. That is the only one
   Ballast requires. Do **not** tick Auth, Transfer, or anything that moves
   money — Ballast never moves money and asking for those invites questions you
   do not need to answer.

   For the use-case description, this is accurate and you can paste it:

   > Internal cash-allocation tool for our own business entities. Read-only.
   > We connect our own business bank accounts to label available balances
   > against budget envelopes. The application never initiates transfers or
   > payments of any kind.

   **(c) Ownership details.** Beneficial owner information. This is standard
   KYC for a financial-data account — have your LLC formation details to hand.

   **(d) Select your plan.** Choose the **Trial** plan. It is the free one.

3. Submit.

Trial plans are **auto-approved for most developers**, so expect this to clear
quickly rather than in days. If it does get held for manual review, Plaid says
to allow a couple of business days, and they email you either way.

**You do not need to do anything with the production secret yet.** When Trial
access lands, the production secret appears in the same Developers → Keys
screen, and swapping it in is a repeat of step 3 plus one word from me in
`wrangler.jsonc`.

---

## Step 5 — Request the Recurring Transactions add-on (3 min)

Do this now even though nothing needs it yet, because it is the only slow part.

1. Still in the Plaid dashboard, submit a **product access request** for
   **Recurring Transactions**, or email your account contact if you have one.
2. Plaid's own guidance: **allow at least one week** for a product access
   request to be processed.

What it unlocks: `/transactions/recurring/get`, which is how v5.0.0 spots
"this $340 insurance payment recurs monthly" and proposes an envelope for it.
Without it, everything else still works — you just place those envelopes by
hand.

**What I could not verify:** whether the Recurring Transactions add-on is free
while you are on the Trial plan. Plaid's docs are explicit that Transactions
and the Recurring add-on are both billed on a subscription model, and explicit
that the Trial bundle contains eight core products — but Recurring is described
as an _optional add-on_, and I could not find a statement either way about it
during Trial. **Ask Plaid directly when you submit the request, and do not
assume it is free.** If it carries a cost, say no for now: it is a v5.0.0
nicety, not a blocker, and this project has already paid $5 for an unverified
assumption.

---

## What happens after you have done that

Tell me the two secrets are in Cloudflare and I will, next session:

1. Build the **Connect a bank** button and the Plaid Link flow
   (`/link/token/create` → Link → `/item/public_token/exchange`).
2. Wire the webhook. **You do not configure this anywhere** — Ballast sends its
   own webhook URL when it creates the Link token. For the record it will be:
   `https://ballast-finance-app.praeclarusventures.com/api/webhooks/plaid`
3. Connect Plaid's fake **First Platypus Bank** in sandbox and prove the whole
   loop in a browser before a single real credential is typed.
4. Switch `PLAID_ENV` to `production` and push, once you have Trial access and
   have seen it work with fake money.

### The one-shot decision I will need an answer on

`transactions.days_requested` can be set **once per Item, at link time, and
never changed** without disconnecting and relinking the bank. Ballast clamps it
to a maximum of 730 days.

More history means better recurring detection — the code notes that annual
streams need at least 180 days to be found at all. I intend to request **730**,
the maximum, unless you object. Flagging it because it is genuinely
irreversible per bank, not because it is a close call.

---

## Reference: exactly what Ballast asks Plaid for

So nothing in the application form is a guess.

| Endpoint                        | What for                            |
| ------------------------------- | ----------------------------------- |
| `/link/token/create`            | opening the Link dialog             |
| `/accounts/get`                 | which accounts exist                |
| `/accounts/balance/get`         | the available balance — the hero    |
| `/transactions/sync`            | incremental transaction updates     |
| `/transactions/recurring/get`   | **add-on** — recurring streams      |
| `/institutions/get_by_id`       | the bank's name and logo            |
| `/item/remove`                  | disconnecting a bank                |
| `/webhook_verification_key/get` | verifying webhooks are really Plaid |

Products array: **`['transactions']`**. Country codes: `['US']`. Language:
`en`. Ballast has **no** money-movement endpoint anywhere in it, by design.

---

## Sources

Checked 23 September 2026.

- [Plaid Quickstart](https://plaid.com/docs/quickstart/) — keys live under
  Developers → Keys
- [Sandbox overview](https://plaid.com/docs/sandbox/) — sandbox is free and
  fully featured
- [What is the Plaid Trial plan?](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan)
  — 10 Production Items, eight core products incl. Transactions, auto-approved
  for most developers, `/item/remove` does not free slots
- [Can I use Plaid for free?](https://support.plaid.com/hc/en-us/articles/16194695660311-Can-I-use-Plaid-for-free)
  — free Trial for US/Canada teams created on or after 15 April 2026
- [Sandbox, Production, Trial and Limited Production compared](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different)
- [Pricing and billing](https://plaid.com/docs/account/billing/) — Transactions
  and the Recurring add-on are subscription-billed
- [Introduction to Transactions](https://plaid.com/docs/transactions/) —
  Recurring Transactions access is requested via a product access request;
  ≥180 days of history recommended
- [Transactions webhooks](https://plaid.com/docs/transactions/webhooks/) — the
  webhook URL is passed to `/link/token/create`, not set in the dashboard
- [Launch checklist](https://plaid.com/docs/launch-checklist/) — allow at least
  one week for a product access request

`plaid.com` is blocked by this container's network policy for direct page
fetches, so these were read through search result summaries rather than by
loading each page. Treat the Trial-plan figures as high confidence — three
independent queries agreed — and re-read the pricing page yourself before
accepting any charge.
