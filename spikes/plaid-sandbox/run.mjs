#!/usr/bin/env node
/**
 * Phase 0 spike A — Plaid sandbox.
 *
 * PURPOSE: exercise the full connection lifecycle against the real Plaid API
 * and CHECK THE ASSUMPTIONS the LedgerSource boundary is built on. Every
 * assertion below corresponds to a decision already baked into src/.
 *
 * The assumptions under test:
 *   A1  Transaction.amount is POSITIVE for money OUT and NEGATIVE for money IN.
 *       (src/ledger-source/plaid/mapper.ts negates it. If this ever changed,
 *        every balance and the entire allocation waterfall would invert.)
 *   A2  /transactions/sync returns added / modified / removed, and `removed`
 *       is objects with transaction_id + account_id, not bare strings.
 *   A3  A posted transaction carries pending_transaction_id pointing back at
 *       its pending predecessor, and the ids DIFFER.
 *   A4  next_cursor is durable; an empty string means "not ready yet".
 *   A5  AccountBalance.available can be null and must not be read as zero.
 *   A6  /transactions/recurring/get is a SEPARATE entitlement on top of
 *       Transactions — having Transactions does not grant it.
 *   A7  /sandbox/item/reset_login drives an Item to ITEM_LOGIN_REQUIRED, and
 *       update mode (products: []) repairs it.
 *
 * SAFETY: read-only against a throwaway sandbox Item, which it removes at the
 * end. It never touches production data and never moves money.
 *
 * USAGE:
 *   export PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox
 *   npm run spike:plaid
 *   npm run spike:plaid -- --webhook https://your-worker.workers.dev/api/webhooks/plaid
 */

import {
  createReport,
  credentialsFromEnv,
  explainMissingCredentials,
  makeClient,
  PlaidSpikeError,
  sleep,
} from '../lib/plaid.mjs';

const args = process.argv.slice(2);
const webhookUrl = args.includes('--webhook') ? args[args.indexOf('--webhook') + 1] : undefined;
// ins_109508 is "First Platypus Bank", Plaid's standard sandbox institution.
const institutionId = args.includes('--institution')
  ? args[args.indexOf('--institution') + 1]
  : 'ins_109508';

const creds = credentialsFromEnv();
if (!creds.ok) {
  explainMissingCredentials(creds);
  process.exit(2);
}
if (creds.environment !== 'sandbox') {
  console.error(`\nRefusing to run: PLAID_ENV is '${creds.environment}'.`);
  console.error('This spike creates and destroys Items, so it only runs against sandbox.');
  process.exit(2);
}

const post = makeClient(creds);
const report = createReport('Ballast Phase 0 -- Plaid sandbox spike');

let accessToken = null;

try {
  /* ---------------------------------------------------------------- */
  report.section('1. Link token (the real onboarding path)');

  const linkToken = await post('/link/token/create', {
    client_name: 'Ballast',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: 'spike-user' },
    products: ['transactions'],
    // 730 is Plaid's documented maximum and is UNCHANGEABLE after link.
    // The blueprint's seasonal baseline (trailing 12 months) and annual
    // obligation detection both depend on getting this right first time.
    transactions: { days_requested: 730 },
    ...(webhookUrl ? { webhook: webhookUrl } : {}),
  });

  report.check('link/token/create succeeds', Boolean(linkToken.link_token));
  report.check(
    'link token has an expiry',
    Boolean(linkToken.expiration),
    `expires ${linkToken.expiration}`,
  );
  report.note(
    'days_requested: 730 accepted',
    'Cannot be changed later without /item/remove + re-Link.',
  );

  /* ---------------------------------------------------------------- */
  report.section('2. Sandbox Item + token exchange');

  const publicTokenResponse = await post('/sandbox/public_token/create', {
    institution_id: institutionId,
    // NOTE: the field is `initial_products`, NOT `products`, and it may not be
    // empty. Getting this wrong is a silent 400.
    initial_products: ['transactions'],
    options: {
      override_username: 'user_good',
      override_password: 'pass_good',
      ...(webhookUrl ? { webhook: webhookUrl } : {}),
    },
  });
  report.check('sandbox/public_token/create succeeds', Boolean(publicTokenResponse.public_token));

  const exchanged = await post('/item/public_token/exchange', {
    public_token: publicTokenResponse.public_token,
  });
  accessToken = exchanged.access_token;
  report.check(
    'item/public_token/exchange returns access_token + item_id',
    Boolean(exchanged.access_token && exchanged.item_id),
    `item_id ${exchanged.item_id}`,
  );

  /* ---------------------------------------------------------------- */
  report.section('3. Accounts and balances (assumption A5)');

  const accounts = await post('/accounts/balance/get', { access_token: accessToken });
  report.check(
    'accounts/balance/get returns accounts',
    accounts.accounts?.length > 0,
    `${accounts.accounts?.length ?? 0} accounts`,
  );

  const depository = accounts.accounts.filter((a) => a.type === 'depository');
  report.check('at least one depository account', depository.length > 0);

  const nullAvailable = accounts.accounts.filter((a) => a.balances.available === null);
  if (nullAvailable.length) {
    report.note(
      `${nullAvailable.length} account(s) report available = null`,
      'Confirms A5: available is nullable. Ballast stores null, never 0 - ' +
        '"unknown" and "no money" must not be conflated.',
    );
  } else {
    report.info('All sandbox accounts reported an available balance (A5 not exercised here).');
  }

  for (const a of depository.slice(0, 4)) {
    report.info(
      `${a.name} (${a.subtype}) available=${a.balances.available} current=${a.balances.current}`,
    );
  }

  /* ---------------------------------------------------------------- */
  report.section('4. transactions/sync (assumptions A1, A2, A4)');

  // Sandbox transactions are generated asynchronously; an immediate call
  // returns empty arrays and an empty cursor.
  let sync = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    sync = await post('/transactions/sync', {
      access_token: accessToken,
      count: 500,
      options: { include_original_description: true },
    });
    if (sync.added.length > 0) break;
    await sleep(2000);
  }

  report.check(
    'transactions/sync returns data',
    sync.added.length > 0,
    `${sync.added.length} added on first page`,
  );

  report.check(
    'A2: response has added / modified / removed',
    Array.isArray(sync.added) && Array.isArray(sync.modified) && Array.isArray(sync.removed),
  );

  report.check(
    'A4: next_cursor is a non-empty string once data exists',
    typeof sync.next_cursor === 'string' && sync.next_cursor.length > 0,
    'An empty cursor means "not ready" and must NOT be persisted.',
  );

  report.note('transactions_update_status', String(sync.transactions_update_status));
  if (sync.transactions_update_status !== 'HISTORICAL_UPDATE_COMPLETE') {
    report.info(
      'Only HISTORICAL_UPDATE_COMPLETE means the backfill finished. ' +
        'INITIAL_UPDATE_COMPLETE is ~30 days only.',
    );
  }

  // --- A1: THE SIGN CONVENTION. The single most consequential fact. ---
  const credits = sync.added.filter((t) => t.amount < 0);
  const debits = sync.added.filter((t) => t.amount > 0);
  report.check(
    'A1: Plaid reports money IN as a NEGATIVE amount',
    credits.length > 0,
    credits.length
      ? `e.g. "${credits[0].name}" amount=${credits[0].amount} (a deposit, negative)`
      : 'No negative amounts found - INVESTIGATE before trusting the mapper.',
  );
  report.check(
    'A1: Plaid reports money OUT as a POSITIVE amount',
    debits.length > 0,
    debits.length
      ? `e.g. "${debits[0].name}" amount=${debits[0].amount} (a purchase, positive)`
      : '',
  );
  report.info(
    'Ballast NEGATES this in mapper.ts so positive = money in. ' +
      'If these two checks ever fail, the allocation waterfall is inverted.',
  );

  // --- A3: pending -> posted identity ---
  const pending = sync.added.filter((t) => t.pending);
  const linked = sync.added.filter((t) => t.pending_transaction_id);
  report.note(
    'pending / posted population',
    `${pending.length} pending, ${linked.length} posted with a pending_transaction_id link`,
  );
  if (linked.length) {
    const sample = linked[0];
    report.check(
      'A3: posted transaction_id DIFFERS from its pending_transaction_id',
      sample.transaction_id !== sample.pending_transaction_id,
      `${sample.pending_transaction_id} -> ${sample.transaction_id}`,
    );
  } else {
    report.warn(
      'A3 not exercised: no posted transaction carried a pending link in this dataset',
      'The txn_key surrogate exists for exactly this case; it is unit-tested in ' +
        'test/unit/txn-key.test.ts. Re-run after sandbox transactions settle to see it live.',
    );
  }

  // --- Pagination ---
  let pages = 1;
  let cursor = sync.next_cursor;
  let hasMore = sync.has_more;
  while (hasMore && pages < 20) {
    const next = await post('/transactions/sync', {
      access_token: accessToken,
      cursor,
      count: 500,
      options: { include_original_description: true },
    });
    pages++;
    cursor = next.next_cursor;
    hasMore = next.has_more;
  }
  report.check('pagination terminates', !hasMore, `${pages} page(s)`);
  report.info('Only the cursor from the final page (has_more=false) is durable.');

  const withOriginal = sync.added.filter((t) => t.original_description).length;
  report.check(
    'include_original_description populates the raw bank descriptor',
    withOriginal > 0,
    `${withOriginal}/${sync.added.length} carried original_description. ` +
      'Absent (not null) without the option - the Square payout match needs it.',
  );

  /* ---------------------------------------------------------------- */
  report.section('5. Recurring transactions (assumption A6)');

  try {
    const recurring = await post('/transactions/recurring/get', { access_token: accessToken });
    const inflows = recurring.inflow_streams?.length ?? 0;
    const outflows = recurring.outflow_streams?.length ?? 0;
    report.check(
      'recurring/get is ENTITLED on this client',
      true,
      `${inflows} inflow, ${outflows} outflow streams`,
    );

    const cadences = new Set(
      [...(recurring.inflow_streams ?? []), ...(recurring.outflow_streams ?? [])].map(
        (s) => s.frequency,
      ),
    );
    report.note('cadences observed', [...cadences].join(', ') || 'none');
    if (cadences.has('ANNUALLY')) {
      report.info('ANNUALLY present - this is the cadence that catches forgotten yearly premiums.');
    }

    const mature = [...(recurring.outflow_streams ?? [])].filter((s) => s.status === 'MATURE');
    report.note(
      'outflow stream maturity',
      `${mature.length}/${outflows} MATURE. EARLY_DETECTION streams are provisional ` +
        'and can become TOMBSTONED - do not treat them as confirmed obligations.',
    );

    const amountShape = (recurring.outflow_streams ?? [])[0]?.last_amount;
    if (amountShape) {
      report.check(
        'last_amount is an OBJECT, not a number',
        typeof amountShape === 'object',
        `keys: ${Object.keys(amountShape).join(', ')}`,
      );
    }
  } catch (err) {
    if (err instanceof PlaidSpikeError) {
      report.warn(
        'A6: recurring/get is NOT entitled on this client',
        `${err.errorCode}: ${err.message}\n       ` +
          'Recurring Transactions is a PAID ADD-ON on top of Transactions. ' +
          'Section 9 (the forward-obligations engine) is mandatory, so this ' +
          'entitlement must be requested from Plaid before Slice 4.',
      );
    } else {
      throw err;
    }
  }

  /* ---------------------------------------------------------------- */
  report.section('6. Re-auth lifecycle (assumption A7)');

  await post('/sandbox/item/reset_login', { access_token: accessToken });
  const itemAfterReset = await post('/item/get', { access_token: accessToken });
  const resetCode = itemAfterReset.item?.error?.error_code ?? null;
  report.check(
    'A7: reset_login drives the Item to ITEM_LOGIN_REQUIRED',
    resetCode === 'ITEM_LOGIN_REQUIRED',
    `item.error.error_code = ${resetCode}`,
  );

  const updateLinkToken = await post('/link/token/create', {
    client_name: 'Ballast',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: 'spike-user' },
    access_token: accessToken,
    // UPDATE MODE: products MUST be empty. Re-sending the original product
    // array is the classic bug here.
    products: [],
  });
  report.check(
    'update-mode link token issues with products: []',
    Boolean(updateLinkToken.link_token),
    `expires ${updateLinkToken.expiration} (update-mode tokens last 30 MINUTES, not 4 hours)`,
  );
  report.info('After update mode completes the SAME access_token works - do not exchange again.');

  if (webhookUrl) {
    report.section('7. Webhook delivery');
    const fired = await post('/sandbox/item/fire_webhook', {
      access_token: accessToken,
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
    });
    report.check('fire_webhook accepted', fired.webhook_fired === true, `sent to ${webhookUrl}`);
    report.info('Check the Worker logs: the JWT must verify and the body digest must match.');
    report.info(
      'Note: fire_webhook CANNOT produce ITEM_LOGIN_REQUIRED - use reset_login for that.',
    );
  } else {
    report.note(
      'Webhook delivery not tested',
      'Re-run with --webhook <public-url> to exercise it.',
    );
  }
} catch (err) {
  if (err instanceof PlaidSpikeError) {
    report.check(`Unexpected Plaid error (${err.errorCode})`, false, err.message);
  } else {
    report.check('Unexpected error', false, err?.stack ?? String(err));
  }
} finally {
  if (accessToken) {
    try {
      await post('/item/remove', { access_token: accessToken });
      console.log('\nCleaned up: sandbox Item removed.');
    } catch {
      console.log('\nWARNING: could not remove the sandbox Item. Remove it from the dashboard.');
    }
  }
}

const { ok } = report.summary();
console.log(
  '\nThis spike answers "does the plumbing work". The per-institution go/no-go\n' +
    'for the real banks is the SEPARATE coverage spike: npm run spike:coverage\n',
);
process.exit(ok ? 0 : 1);
