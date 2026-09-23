/**
 * An entity with nothing budgetable has an UNKNOWN balance, never zero.
 *
 * THE DEFECT THIS EXISTS FOR, found live in production on the very first
 * deployment. The envelope_balances view guarded the case where a LINKED
 * account had not reported a balance — but over ZERO accounts the filtered
 * count is 0, the CASE fell through to its ELSE, and
 * `COALESCE(SUM(...) over nothing, 0)` returned a confident 0.
 *
 * So a brand-new entity reported that it holds $0. CLAUDE.md names this as the
 * single most dangerous bug this app can have: it tells the operator they have
 * nothing when the truth is that nobody has asked their bank yet.
 *
 * Nothing caught it because every fixture in the suite seeds a source_account
 * first. The one state a real first deploy is guaranteed to be in — no bank
 * connected yet — was the one state nothing exercised.
 *
 * THE SECOND HALF OF THE CLASS, which the first fix missed. An empty pool is
 * not only reached by "no accounts": marking the only account non-budgetable,
 * or closing it, empties it too. Under a confident zero the residual then goes
 * NEGATIVE by however much is already allocated, and the app announces an
 * over-allocation that nothing in the world caused. Those cases are asserted
 * here alongside the empty one, because they are the same defect wearing a
 * different hat.
 */

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionStore, createUser } from '../../src/db/repos/users';
import { hashPassword } from '../../src/auth/password';
import { issueSession } from '../../src/auth/session';
import { buildSessionCookie } from '../../src/auth/cookies';
import { createEnvelope, transfer } from '../../src/money/ledger';
import { randomId } from '../../src/crypto/random';

const NOW = 1_800_000_000;
const ORIGIN = 'https://example.com';

interface Fresh {
  userId: string;
  entityId: string;
  unallocatedId: string;
  cookie: string;
}

/** A brand-new entity: no source_items, no source_accounts. A real first run. */
async function freshEntity(): Promise<Fresh> {
  const userId = randomId();
  const entityId = randomId();
  await createUser(env.DB, {
    id: userId,
    email: `${userId}@example.test`,
    passwordHash: await hashPassword('correct horse battery staple', 1000),
    now: NOW,
  });
  await env.DB.prepare(
    'INSERT INTO entities (id,user_id,name,state,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  )
    .bind(entityId, userId, 'Concierge Car Repair DFW', 'TX', NOW, NOW)
    .run();
  const { id: unallocatedId } = await createEnvelope(env.DB, {
    userId,
    entityId,
    name: 'Unallocated',
    type: 'unallocated',
    now: NOW,
  });
  const session = await issueSession(createSessionStore(env.DB), userId, NOW, randomId());
  const cookie = buildSessionCookie(session.token, {
    maxAgeSeconds: session.maxAgeSeconds,
    insecureForLocalDev: true,
  }).split(';')[0];
  return { userId, entityId, unallocatedId, cookie };
}

/** Link one budgetable account reporting `availableMinor`. */
async function linkAccount(f: Fresh, availableMinor: number | null): Promise<string> {
  const itemId = randomId();
  const accountId = randomId();
  await env.DB.prepare(
    `INSERT INTO source_items (id,user_id,source_item_id,access_token_enc,created_at,updated_at)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(itemId, f.userId, randomId(), 'v1.x.y', NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO source_accounts
       (id,user_id,item_id,entity_id,source_account_id,name,type,subtype,
        available_minor,budgetable,created_at,updated_at)
     VALUES (?,?,?,?,?,'Checking','depository','checking',?,1,?,?)`,
  )
    .bind(accountId, f.userId, itemId, f.entityId, randomId(), availableMinor, NOW, NOW)
    .run();
  return accountId;
}

const residualOf = async (envelopeId: string) =>
  (
    await env.DB.prepare('SELECT balance_minor FROM envelope_balances WHERE envelope_id = ?')
      .bind(envelopeId)
      .first<{ balance_minor: number | null }>()
  )?.balance_minor ?? null;

interface Payload {
  tile: number | null;
  safeToSpendMinor: number | null;
  overAllocatedMinor: number;
  invariant: string;
}

async function payloadFor(f: Fresh): Promise<Payload> {
  const res = await SELF.fetch(`${ORIGIN}/api/entities/${f.entityId}/envelopes`, {
    headers: { Cookie: f.cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    envelopes: Array<{ type: string; balanceMinor: number | null }>;
    safeToSpendMinor: number | null;
    overAllocatedMinor: number;
    invariant: string;
  };
  return {
    tile: body.envelopes.find((e) => e.type === 'unallocated')?.balanceMinor ?? null,
    safeToSpendMinor: body.safeToSpendMinor,
    overAllocatedMinor: body.overAllocatedMinor,
    invariant: body.invariant,
  };
}

describe('an entity with no bank connected', () => {
  let f: Fresh;
  beforeEach(async () => {
    f = await freshEntity();
  });

  it('reports the unallocated balance as NULL, not 0', async () => {
    // The whole defect in one assertion. `0` here is the app telling the
    // operator they are broke.
    expect(await residualOf(f.unallocatedId)).toBeNull();
  });

  it('sends NULL to the client, so the tile can render an em dash', async () => {
    const p = await payloadFor(f);
    expect(p.tile).toBeNull();
    // And the hero figure, which was already correct via checkInvariant.
    expect(p.safeToSpendMinor).toBeNull();
    expect(p.invariant).toBe('indeterminate');
  });

  it('does not report an over-allocation out of an unknown balance', async () => {
    // A null balance is not a negative one. Reading "over-allocated by $0" (or
    // worse, some figure) out of "we do not know" would be inventing a problem.
    expect((await payloadFor(f)).overAllocatedMinor).toBe(0);
  });

  it('still reports a NAMED envelope as a genuine 0', async () => {
    // The distinction that makes the fix correct rather than blanket. A named
    // envelope with no entries really does hold nothing — nobody has put money
    // in it. Only the residual depends on what the bank says.
    const { id: taxId } = await createEnvelope(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      name: 'Tax',
      type: 'tax',
      now: NOW,
    });
    expect(await residualOf(taxId)).toBe(0);
  });

  it('goes back to a real figure the moment an account reports one', async () => {
    await linkAccount(f, 250_00);
    expect(await residualOf(f.unallocatedId)).toBe(250_00);
  });
});

/**
 * Emptying the budgetable pool must never manufacture a crisis.
 *
 * The scenario, with the seed's own figures: $18,420 in one account, $16,900
 * allocated to Tax, $1,520 free. Take the account out of the pool — close it,
 * or mark it non-budgetable — and a view that calls an empty pool "$0" makes
 * the residual 0 − 16,900 = -$16,900. The tile reads -$16,900 and the Canvas
 * announces "over-allocated by $16,900", caused by nothing but a flag.
 */
describe('emptying the budgetable pool', () => {
  let f: Fresh;
  let accountId: string;

  beforeEach(async () => {
    f = await freshEntity();
    accountId = await linkAccount(f, 18_420_00);
    const { id: taxId } = await createEnvelope(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      name: 'Tax',
      type: 'tax',
      now: NOW,
    });
    const r = await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: taxId,
      amountMinor: 16_900_00,
      kind: 'fund',
      memo: null,
      idempotencyKey: null,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it('starts from the seeded figures', async () => {
    const p = await payloadFor(f);
    expect(p.tile).toBe(1_520_00);
    expect(p.safeToSpendMinor).toBe(1_520_00);
    expect(p.overAllocatedMinor).toBe(0);
    expect(p.invariant).toBe('balanced');
  });

  it('closing the only account does not invent an over-allocation', async () => {
    await env.DB.prepare('UPDATE source_accounts SET closed_at = ? WHERE id = ?')
      .bind(NOW, accountId)
      .run();
    const p = await payloadFor(f);
    expect(p.tile).toBeNull();
    expect(p.safeToSpendMinor).toBeNull();
    expect(p.overAllocatedMinor).toBe(0);
    expect(p.invariant).toBe('indeterminate');
  });

  it('marking the only account non-budgetable does not invent one either', async () => {
    await env.DB.prepare('UPDATE source_accounts SET budgetable = 0 WHERE id = ?')
      .bind(accountId)
      .run();
    const p = await payloadFor(f);
    expect(p.tile).toBeNull();
    expect(p.safeToSpendMinor).toBeNull();
    expect(p.overAllocatedMinor).toBe(0);
    expect(p.invariant).toBe('indeterminate');
  });

  it('nor does the account simply going quiet', async () => {
    await env.DB.prepare('UPDATE source_accounts SET available_minor = NULL WHERE id = ?')
      .bind(accountId)
      .run();
    const p = await payloadFor(f);
    expect(p.tile).toBeNull();
    expect(p.safeToSpendMinor).toBeNull();
    expect(p.overAllocatedMinor).toBe(0);
    expect(p.invariant).toBe('indeterminate');
  });

  it('but a REAL over-allocation is still reported in full', async () => {
    // The converse, and the reason none of the above may be implemented by
    // suppressing the warning. Cash genuinely fell below what is allocated:
    // $16,000 available against $16,900 committed. That is real, the operator
    // must see it, and the invariant is determinate while it says so.
    await env.DB.prepare('UPDATE source_accounts SET available_minor = ? WHERE id = ?')
      .bind(16_000_00, accountId)
      .run();
    const p = await payloadFor(f);
    expect(p.tile).toBe(-900_00);
    expect(p.overAllocatedMinor).toBe(900_00);
    // 'balanced', not 'envelopes_ahead', and that is correct however it reads.
    // The residual is a RESIDUAL: it absorbed the shortfall by going to -$900,
    // so envelopes still sum to cash and the conservation identity holds. The
    // status answers "is the data consistent?", not "is the operator over-
    // committed?" — that second question is what overAllocatedMinor is for,
    // and reading the status instead would hide every real over-allocation.
    expect(p.invariant).toBe('balanced');
    // Never present a negative as spendable.
    expect(p.safeToSpendMinor).toBe(0);
  });
});
