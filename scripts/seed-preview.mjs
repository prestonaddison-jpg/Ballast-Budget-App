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
// Proposals reference both envelopes and ledger_entries, so they go first.
sql.push('DELETE FROM proposals;');
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

// Two staged proposals, so the Needs You queue is a real screen rather than an
// empty one.
//
// THESE ARE SEEDED, NOT GENERATED. The triggers that produce proposals from
// real activity (income detection, unassigned spend, the waterfall) need
// transaction data, which needs Plaid. Until then the queue is fed from here
// so the approve path is exercised by the browser suite end to end.
//
// The second one is deliberately larger than the $1,520 residual: a proposal
// that no longer fits is an ordinary, expected state — the balance moved after
// it was suggested — and the screen has to handle it without an error.
const proposals = [
  {
    kind: 'income_allocation',
    from: byKey.unalloc.id,
    to: byKey.tax.id,
    amount: 48_000,
    memo: 'Deposit landed Friday',
  },
  {
    kind: 'waterfall',
    from: byKey.unalloc.id,
    to: byKey.buffer.id,
    amount: 240_000,
    memo: 'Top the buffer toward one month of costs',
  },
];
for (const pr of proposals) {
  sql.push(
    `INSERT INTO proposals (id,user_id,entity_id,kind,from_envelope_id,to_envelope_id,amount_minor,status,memo,created_at)
     VALUES (${q(id('prp'))},${q(userId)},${q(entityId)},${q(pr.kind)},${q(pr.from)},${q(pr.to)},${pr.amount},'pending',${q(pr.memo)},${NOW});`,
  );
}

/* -------------------------------------------------------------------------
 * A SECOND ENTITY.
 *
 * Ballast's central claim is that the Praeclarus entities never commingle —
 * and until now the preview had exactly one entity, so that claim was proved
 * by unit tests and by nothing a browser had ever seen. One entity cannot mix
 * with anything.
 *
 * The figures are deliberately unmistakable ($2,500 free against $1,520) and
 * BOTH entities have an envelope called "Tax". A same-named envelope is
 * exactly what a commingling bug hides behind: a leak of the wrong entity's
 * tile is invisible when every name is unique, and glaring when one is not.
 *
 * Named to sort AFTER the repair shop, because listEntities is ORDER BY name
 * and the Canvas opens on entities[0] — reordering it would rewrite the
 * figures every other test asserts.
 * ---------------------------------------------------------------------- */
const entityBId = id('ent');
const itemBId = id('itm');
const HOLDINGS = 400_000; // $4,000.00

const envelopesB = [
  { key: 'unalloc', name: 'Unallocated', type: 'unallocated', target: null, funded: 0 },
  // Same name as the repair shop's. On purpose — see above.
  { key: 'tax', name: 'Tax', type: 'tax', target: 500_000, funded: 100_000 },
  { key: 'dist', name: 'Distributions', type: 'save', target: 2_000_000, funded: 50_000 },
];
for (const e of envelopesB) e.id = id('env');
const byKeyB = Object.fromEntries(envelopesB.map((e) => [e.key, e]));

sql.push(
  `INSERT INTO entities (id,user_id,name,state,created_at,updated_at) VALUES (${q(entityBId)},${q(userId)},${q('Praeclarus Holdings LLC')},'TX',${NOW},${NOW});`,
);
sql.push(
  `INSERT INTO source_items (id,user_id,source_item_id,access_token_enc,institution_name,status,last_synced_at,created_at,updated_at)
   VALUES (${q(itemBId)},${q(userId)},${q(id('plaid'))},'preview-not-a-real-token',${q('Frost')},'ok',${SYNCED},${NOW},${NOW});`,
);
sql.push(
  `INSERT INTO source_accounts (id,user_id,item_id,entity_id,source_account_id,name,type,subtype,available_minor,current_minor,budgetable,balance_updated_at,created_at,updated_at)
   VALUES (${q(id('acc'))},${q(userId)},${q(itemBId)},${q(entityBId)},${q(id('pacc'))},${q('Holdings operating')},'depository','checking',${HOLDINGS},${HOLDINGS},1,${SYNCED},${NOW},${NOW});`,
);

let orderB = 0;
for (const e of envelopesB) {
  sql.push(
    `INSERT INTO envelopes (id,user_id,entity_id,name,type,target_minor,sort_order,created_at,updated_at)
     VALUES (${q(e.id)},${q(userId)},${q(entityBId)},${q(e.name)},${q(e.type)},${e.target ?? 'NULL'},${orderB++},${NOW},${NOW});`,
  );
}
for (const e of envelopesB) {
  if (e.type === 'unallocated' || e.funded <= 0) continue;
  sql.push(
    `INSERT INTO ledger_entries (id,user_id,entity_id,from_envelope_id,to_envelope_id,amount_minor,kind,memo,created_at)
     VALUES (${q(id('led'))},${q(userId)},${q(entityBId)},${q(byKeyB.unalloc.id)},${q(e.id)},${e.funded},'fund',${q('Preview seed')},${NOW});`,
  );
}
// One proposal, so the queue count differs between the entities too — a pill
// that does not change on a switch is the same leak wearing a different hat.
sql.push(
  `INSERT INTO proposals (id,user_id,entity_id,kind,from_envelope_id,to_envelope_id,amount_minor,status,memo,created_at)
   VALUES (${q(id('prp'))},${q(userId)},${q(entityBId)},'tax_skim',${q(byKeyB.unalloc.id)},${q(byKeyB.tax.id)},31_000,'pending',${q('Quarterly estimate')},${NOW});`,
);

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

const namedB = envelopesB.reduce((n, e) => n + e.funded, 0);
console.log(`second entity ·  cash $${(HOLDINGS / 100).toLocaleString()}`);
console.log(
  `              ·  unallocated (residual) $${((HOLDINGS - namedB) / 100).toLocaleString()}`,
);
console.log(`login: ${EMAIL} / ${PASSWORD}`);
