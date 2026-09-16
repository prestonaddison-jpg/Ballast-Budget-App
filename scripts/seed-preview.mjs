/**
 * Seeds the LOCAL D1 with a realistic entity so the UI can be looked at.
 *
 * Preview only. It writes plausible business numbers and one demo login; it
 * never touches a remote database and it is not part of any deploy path.
 *
 * The numbers are chosen to exercise the states that matter visually: a
 * part-funded reserve, a fully-funded one, a project barely started, and a
 * residual small enough to feel like a real operating week.
 */

import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function hashPassword(password, iterations = 600_000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return `pbkdf2$sha256$${iterations}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

// DETERMINISTIC ids. The e2e suite re-seeds before every test, and random ids
// would mean a saved session, a cached selector or a stored storageState went
// stale on each reset.
let counter = 0;
const id = (p) => `${p}_seed${String(counter++).padStart(4, '0')}`;

/** The seeded session token, so tests can authenticate without the login route
 *  — which is rate limited to 10 attempts per window per IP, and would 429 the
 *  eleventh test onwards. The login FORM gets its own dedicated test. */
export const SESSION_TOKEN = 'e2e-seeded-session-token-not-a-secret';

async function sha256b64url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(digest));
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Row timestamps are fixed so re-seeding is deterministic; the SYNC clock is
// real, because the freshness indicator is showing a genuine elapsed time and a
// frozen one just reads as a bug.
const NOW = 1_757_900_000;
const SYNCED = Math.floor(Date.now() / 1000) - 900; // 15 minutes ago

const EMAIL = 'demo@ballast.local';
const PASSWORD = 'ballast-preview';

const userId = id('usr');
const entityId = id('ent');
const itemId = id('itm');
const acctOperating = id('acc');
const acctSavings = id('acc');

// Cash: what the bank says is AVAILABLE (never current, never pending).
const OPERATING = 1_642_000; // $16,420.00
const SAVINGS = 200_000; //  $2,000.00
const CASH = OPERATING + SAVINGS; // $18,420.00

const envelopes = [
  { key: 'unalloc', name: 'Unallocated', type: 'unallocated', target: null, funded: 0 },
  { key: 'tax', name: 'Tax', type: 'tax', target: 900_000, funded: 620_000 },
  { key: 'buffer', name: 'Buffer', type: 'buffer', target: 1_200_000, funded: 450_000 },
  { key: 'rack', name: 'Alignment rack', type: 'save', target: 750_000, funded: 280_000 },
  { key: 'ins', name: 'Q1 insurance', type: 'spend', target: 340_000, funded: 340_000 },
];
for (const e of envelopes) e.id = id('env');
const byKey = Object.fromEntries(envelopes.map((e) => [e.key, e]));

const sql = [];
sql.push('DELETE FROM ledger_entries;');
sql.push('DELETE FROM envelopes;');
sql.push('DELETE FROM source_accounts;');
sql.push('DELETE FROM source_items;');
sql.push('DELETE FROM sessions;');
sql.push('DELETE FROM entities;');
sql.push('DELETE FROM users;');

const hash = await hashPassword(PASSWORD, 600_000);
sql.push(
  `INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES (${q(userId)},${q(EMAIL)},${q(hash)},${NOW},${NOW});`,
);
sql.push(
  `INSERT INTO entities (id,user_id,name,state,created_at,updated_at) VALUES (${q(entityId)},${q(userId)},${q('Concierge Car Repair DFW')},'TX',${NOW},${NOW});`,
);
sql.push(
  `INSERT INTO source_items (id,user_id,source_item_id,access_token_enc,institution_name,status,last_synced_at,created_at,updated_at)
   VALUES (${q(itemId)},${q(userId)},${q(id('plaid'))},'preview-not-a-real-token',${q('Chase')},'ok',${SYNCED},${NOW},${NOW});`,
);

const account = (aid, name, subtype, available) =>
  `INSERT INTO source_accounts (id,user_id,item_id,entity_id,source_account_id,name,type,subtype,available_minor,current_minor,budgetable,balance_updated_at,created_at,updated_at)
   VALUES (${q(aid)},${q(userId)},${q(itemId)},${q(entityId)},${q(id('pacc'))},${q(name)},'depository',${q(subtype)},${available},${available},1,${SYNCED},${NOW},${NOW});`;
sql.push(account(acctOperating, 'Operating', 'checking', OPERATING));
sql.push(account(acctSavings, 'Reserve savings', 'savings', SAVINGS));

let order = 0;
for (const e of envelopes) {
  sql.push(
    `INSERT INTO envelopes (id,user_id,entity_id,name,type,target_minor,sort_order,created_at,updated_at)
     VALUES (${q(e.id)},${q(userId)},${q(entityId)},${q(e.name)},${q(e.type)},${e.target ?? 'NULL'},${order++},${NOW},${NOW});`,
  );
}

// Fund each named envelope OUT OF unallocated — the same closed, two-legged
// entry the app itself writes. Unallocated is the residual, so it needs none.
for (const e of envelopes) {
  if (e.type === 'unallocated' || e.funded <= 0) continue;
  sql.push(
    `INSERT INTO ledger_entries (id,user_id,entity_id,from_envelope_id,to_envelope_id,amount_minor,kind,memo,created_at)
     VALUES (${q(id('led'))},${q(userId)},${q(entityId)},${q(byKey.unalloc.id)},${q(e.id)},${e.funded},'fund',${q('Preview seed')},${NOW});`,
  );
}

// A ready-made session, so the suite never touches the login route.
sql.push(
  `INSERT INTO sessions (id,user_id,token_hash,created_at,last_seen_at,absolute_expires_at)
   VALUES (${q(id('ses'))},${q(userId)},${q(await sha256b64url(SESSION_TOKEN))},${NOW},${SYNCED},${SYNCED + 86400},);`.replace(
    ',);',
    ');',
  ),
);

writeFileSync('/tmp/ballast-seed.sql', sql.join('\n'));

const named = envelopes.reduce((n, e) => n + e.funded, 0);
console.log(`seed written  ·  cash $${(CASH / 100).toLocaleString()}`);
console.log(`              ·  named $${(named / 100).toLocaleString()}`);
console.log(`              ·  unallocated (residual) $${((CASH - named) / 100).toLocaleString()}`);
console.log(`login: ${EMAIL} / ${PASSWORD}`);
