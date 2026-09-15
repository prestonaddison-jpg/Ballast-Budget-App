/**
 * Minimal Plaid client for the spikes.
 *
 * The spikes are deliberately self-contained .mjs rather than importing the
 * Worker's TypeScript: their job is to interrogate the REAL API and confirm
 * the assumptions the LedgerSource boundary is built on. Re-running our own
 * mapper would only prove that the mapper agrees with itself.
 *
 * Output is plain ASCII with no ANSI colour, because the whole point of these
 * scripts is to be redirected into docs/SPIKE-RESULTS.md as evidence.
 */

const BASE = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export class PlaidSpikeError extends Error {
  constructor(status, body) {
    super(body?.error_message ?? `Plaid returned ${status}`);
    this.name = 'PlaidSpikeError';
    this.status = status;
    this.errorCode = body?.error_code ?? null;
    this.errorType = body?.error_type ?? null;
    this.body = body;
  }
}

export function credentialsFromEnv() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const environment = process.env.PLAID_ENV ?? 'sandbox';

  const missing = ['PLAID_CLIENT_ID', 'PLAID_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) return { ok: false, missing };

  if (!BASE[environment]) {
    return {
      ok: false,
      reason:
        `PLAID_ENV must be 'sandbox' or 'production' (got '${environment}'). ` +
        `Plaid's 'development' environment was decommissioned on 2024-06-20.`,
    };
  }
  return { ok: true, clientId, secret, environment };
}

export function makeClient({ clientId, secret, environment }) {
  return async function post(path, body = {}) {
    const res = await fetch(`${BASE[environment]}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
        'Plaid-Version': '2020-09-14',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) throw new PlaidSpikeError(res.status, parsed);
    return parsed;
  };
}

/* --- reporting -------------------------------------------------------- */

export function createReport(title) {
  const rows = [];
  console.log(`\n${title}\n${'='.repeat(title.length)}\n`);

  const emit = (status, name, detail) => {
    rows.push({ name, status, detail });
    console.log(`[${status}] ${name}`);
    if (detail) console.log(`       ${detail}`);
  };

  return {
    check(name, condition, detail = '') {
      emit(condition ? 'PASS' : 'FAIL', name, detail);
      return condition;
    },
    warn: (name, detail = '') => emit('WARN', name, detail),
    note: (name, detail = '') => emit('NOTE', name, detail),
    info: (message) => console.log(`       ${message}`),
    section(heading) {
      console.log(`\n-- ${heading} ${'-'.repeat(Math.max(0, 56 - heading.length))}`);
    },
    summary() {
      const failed = rows.filter((r) => r.status === 'FAIL');
      const warned = rows.filter((r) => r.status === 'WARN');
      const passed = rows.filter((r) => r.status === 'PASS');
      console.log(`\n${'-'.repeat(60)}`);
      console.log(`${passed.length} passed, ${failed.length} failed, ${warned.length} warnings`);
      if (failed.length) {
        console.log('\nFailures:');
        for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
      }
      return { rows, ok: failed.length === 0 };
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Print the "you need credentials" message consistently across spikes. */
export function explainMissingCredentials(creds) {
  console.error('\nCannot run: Plaid credentials are not configured.\n');
  if (creds.missing) {
    console.error(`Missing environment variable(s): ${creds.missing.join(', ')}`);
  }
  if (creds.reason) console.error(creds.reason);
  console.error(
    [
      '',
      'Set them and re-run:',
      '',
      '  export PLAID_CLIENT_ID=...',
      '  export PLAID_SECRET=...        # the SANDBOX secret for the sandbox spike',
      '  export PLAID_ENV=sandbox',
      '',
      'Credentials come from the Plaid dashboard (Team Settings -> Keys).',
      'Nothing here writes them to disk.',
      '',
    ].join('\n'),
  );
}
