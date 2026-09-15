#!/usr/bin/env node
/**
 * Phase 0 spike B -- real-bank coverage (blueprint section 18.3).
 *
 * THE QUESTION: "Plaid business-account coverage for the actual banks -- a
 * per-institution go/no-go (connect real accounts, confirm Transactions +
 * Recurring coverage)."
 *
 * WHAT THIS SPIKE ESTABLISHED, AND IT CHANGES THE SHAPE OF THE ANSWER:
 *
 *   The Plaid Institution object carries NO business/commercial signal of any
 *   kind. There is no field that says "this institution supports business
 *   accounts". So the go/no-go CANNOT be fully automated against
 *   /institutions/*. It splits in two:
 *
 *     PART 1 (automated, below): does the institution support the
 *     `transactions` product at all, and does it use OAuth (which determines
 *     whether ~12-month consent expiry and the update-mode re-auth flow
 *     apply)? Institution.products IS reliable for `transactions`.
 *
 *     PART 2 (manual, protocol printed below): does Plaid see THIS ENTITY'S
 *     BUSINESS accounts, and is recurring-stream detection good enough on
 *     them? Only linking the real account answers this. account.holder_category
 *     is the closest signal and it is beta, needs account-manager enablement,
 *     is nullable, and frequently returns "unrecognized" -- treating a null as
 *     "personal" systematically misclassifies business accounts.
 *
 *   Two further limits worth knowing before trusting a green result:
 *     - Institution STATUS is unavailable in Sandbox entirely, and null in
 *       Production for low-traffic institutions. A sandbox run yields zero
 *       health data.
 *     - `recurring_transactions` is not a filterable institution product.
 *       Plaid documents recurring as supported wherever Transactions is in
 *       US/CA/UK, so `transactions` is the correct and only proxy.
 *
 * USAGE:
 *   export PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=production
 *   npm run spike:coverage -- --banks "Chase,Wells Fargo,Frost Bank"
 *   npm run spike:coverage -- --ids ins_56,ins_127989
 *   npm run spike:coverage -- --banks "Chase" --markdown >> docs/SPIKE-RESULTS.md
 */

import {
  createReport,
  credentialsFromEnv,
  explainMissingCredentials,
  makeClient,
  PlaidSpikeError,
} from '../lib/plaid.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const asMarkdown = args.includes('--markdown');

const bankNames = (flag('--banks') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const bankIds = (flag('--ids') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!bankNames.length && !bankIds.length) {
  console.error(
    [
      '',
      'Name the institutions to check.',
      '',
      '  npm run spike:coverage -- --banks "Chase,Frost Bank"',
      '  npm run spike:coverage -- --ids ins_56,ins_127989',
      '',
      'Use the real banks the Praeclarus entities actually hold accounts at --',
      'that is the whole point of blueprint section 18.3.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const creds = credentialsFromEnv();
if (!creds.ok) {
  explainMissingCredentials(creds);
  process.exit(2);
}

const post = makeClient(creds);
const report = createReport('Ballast Phase 0 -- real-bank coverage spike (18.3)');

if (creds.environment === 'sandbox') {
  report.warn(
    'Running against SANDBOX',
    'Sandbox institutions are fictional and institution status is unavailable. ' +
      'For a real go/no-go, run with PLAID_ENV=production.',
  );
}

const findings = [];

/** Institution.products IS reliable for `transactions` (unlike auth/signal/transfer). */
function assess(institution) {
  const products = institution.products ?? [];
  const supportsTransactions = products.includes('transactions');
  return {
    id: institution.institution_id,
    name: institution.name,
    supportsTransactions,
    oauth: Boolean(institution.oauth),
    products,
    // Plaid documents recurring as available wherever Transactions is, in
    // US/CA/UK. There is no separate institution-level recurring signal.
    recurringLikely: supportsTransactions,
    verdict: supportsTransactions ? 'GO (pending manual business-account check)' : 'NO-GO',
  };
}

report.section('Part 1 -- automated institution metadata');

for (const id of bankIds) {
  try {
    const res = await post('/institutions/get_by_id', {
      institution_id: id,
      // country_codes is TOP-LEVEL in API version 2020-09-14, NOT inside
      // options (that was 2019-05-29 and earlier). Omitting it is a hard error.
      country_codes: ['US'],
      options: { include_status: true },
    });
    const assessment = assess(res.institution);
    findings.push(assessment);
    report.check(
      `${assessment.name} (${assessment.id}) supports transactions`,
      assessment.supportsTransactions,
      `oauth=${assessment.oauth}; products: ${assessment.products.join(', ')}`,
    );
  } catch (err) {
    const message =
      err instanceof PlaidSpikeError ? `${err.errorCode}: ${err.message}` : String(err);
    report.check(`Look up ${id}`, false, message);
    findings.push({ id, name: id, supportsTransactions: false, verdict: 'ERROR', error: message });
  }
}

for (const name of bankNames) {
  try {
    const res = await post('/institutions/search', {
      query: name,
      products: ['transactions'],
      country_codes: ['US'],
    });
    const matches = res.institutions ?? [];
    if (!matches.length) {
      report.check(`Search "${name}"`, false, 'No institution supporting transactions matched.');
      findings.push({ id: '-', name, supportsTransactions: false, verdict: 'NO-GO (no match)' });
      continue;
    }
    // Prefer an exact-ish name match over search ranking.
    const best =
      matches.find((m) => m.name.toLowerCase() === name.toLowerCase()) ??
      matches.find((m) => m.name.toLowerCase().startsWith(name.toLowerCase())) ??
      matches[0];

    const assessment = assess(best);
    findings.push(assessment);
    report.check(
      `${assessment.name} (${assessment.id}) supports transactions`,
      assessment.supportsTransactions,
      `matched "${name}"; oauth=${assessment.oauth}` +
        (matches.length > 1 ? `; ${matches.length - 1} other match(es)` : ''),
    );
    if (matches.length > 1) {
      report.info(
        `Other matches: ${matches
          .slice(0, 5)
          .filter((m) => m.institution_id !== best.institution_id)
          .map((m) => `${m.name} (${m.institution_id})`)
          .join(', ')}`,
      );
      report.info(
        'Large banks list separate institutions for retail vs commercial portals -- ' +
          'pick the one the entity actually logs into.',
      );
    }
  } catch (err) {
    const message =
      err instanceof PlaidSpikeError ? `${err.errorCode}: ${err.message}` : String(err);
    report.check(`Search "${name}"`, false, message);
    findings.push({ id: '-', name, supportsTransactions: false, verdict: 'ERROR', error: message });
  }
}

/* ------------------------------------------------------------------ */
report.section('Part 2 -- what metadata CANNOT answer');

report.note(
  'Business-account coverage is NOT in the Institution object',
  'No field reports commercial/business support. A "GO" above means the bank ' +
    'supports Transactions for SOME accounts -- not that Plaid can see this ' +
    "entity's business accounts.",
);
report.note(
  'Recurring quality is per-account, not per-institution',
  'Stream detection depends on the actual transaction history. An institution ' +
    'that supports Transactions can still yield no MATURE streams for a ' +
    'low-volume entity.',
);
report.note(
  'account.holder_category is the closest signal, and it is weak',
  'Beta, requires account-manager enablement, nullable, often "unrecognized". ' +
    'Treating null as "personal" systematically misclassifies business accounts.',
);

console.log(
  [
    '',
    'MANUAL PROTOCOL -- run once per institution, in Production, to close 18.3',
    '--------------------------------------------------------------------------',
    "  1. Link the entity's REAL business account through Plaid Link.",
    '     Record: did the business/commercial login work at all? Some banks',
    '     route business banking through a separate portal Plaid does not cover.',
    '  2. /accounts/get -> record for each account: type, subtype, mask,',
    '     holder_category (if enabled), and whether `available` is non-null.',
    '     Ballast pins the conservation invariant to AVAILABLE; an institution',
    '     that never reports it is a real problem, not a cosmetic one.',
    '  3. /transactions/sync -> record: transactions_update_status reaching',
    '     HISTORICAL_UPDATE_COMPLETE, how many days of history actually arrived',
    '     (vs the 730 requested), and whether pending transactions appear at all.',
    '     "Not all institutions provide pending transactions."',
    '  4. /transactions/recurring/get -> record: inflow/outflow stream counts,',
    "     how many are MATURE vs EARLY_DETECTION, and whether the entity's known",
    '     fixed obligations (rent, insurance, loan service) were actually found.',
    '     This is the real test of whether section 9 can work for this entity.',
    '  5. Note whether the institution is OAuth. If so, consent expires at',
    '     ~12 months and ITEM_LOGIN_REQUIRED + update mode is a ROUTINE flow,',
    '     not an error path.',
    '  6. Record the verdict in docs/SPIKE-RESULTS.md against this institution.',
    '',
    'GO criteria (all four):',
    '  - the business account links at all;',
    '  - `available` balance is reported;',
    '  - at least ~180 days of history arrives;',
    "  - the entity's known fixed obligations show up as streams.",
    '',
  ].join('\n'),
);

if (asMarkdown) {
  console.log('\n### Automated institution metadata\n');
  console.log('| Institution | ID | Transactions | OAuth | Verdict |');
  console.log('|---|---|---|---|---|');
  for (const f of findings) {
    console.log(
      `| ${f.name} | \`${f.id}\` | ${f.supportsTransactions ? 'yes' : 'no'} | ` +
        `${f.oauth ? 'yes' : 'no'} | ${f.verdict} |`,
    );
  }
  console.log(
    '\n> A "GO" here means the institution supports the Transactions product. ' +
      'It does NOT confirm business-account coverage -- that requires the manual ' +
      'protocol above.\n',
  );
}

const { ok } = report.summary();
process.exit(ok ? 0 : 1);
