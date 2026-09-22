import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionStore, createUser } from '../../src/db/repos/users';
import { hashPassword } from '../../src/auth/password';
import { issueSession } from '../../src/auth/session';
import { buildSessionCookie } from '../../src/auth/cookies';
import { createEnvelope } from '../../src/money/ledger';
import { randomId } from '../../src/crypto/random';

const NOW = 1_800_000_000;
const ORIGIN = 'https://example.com';
const PASSWORD = 'correct horse battery staple';

interface Actor {
  userId: string;
  entityId: string;
  accountId: string;
  unallocatedId: string;
  cookie: string;
}

/** A signed-in user with one entity, one funded account, one unallocated. */
async function actor(availableMinor: number | null = 1000_00): Promise<Actor> {
  const userId = randomId();
  const entityId = randomId();
  const accountId = randomId();
  const itemId = randomId();
  const email = `${userId}@example.test`;

  await createUser(env.DB, {
    id: userId,
    email,
    passwordHash: await hashPassword(PASSWORD, 1000),
    now: NOW,
  });
  await env.DB.prepare(
    'INSERT INTO entities (id,user_id,name,state,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  )
    .bind(entityId, userId, 'Entity', 'TX', NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO source_items (id,user_id,source_item_id,access_token_enc,created_at,updated_at)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(itemId, userId, randomId(), 'v1.x.y', NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO source_accounts
       (id,user_id,item_id,entity_id,source_account_id,name,type,subtype,
        available_minor,budgetable,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
  )
    .bind(
      accountId,
      userId,
      itemId,
      entityId,
      randomId(),
      'Checking',
      'depository',
      'checking',
      availableMinor,
      NOW,
      NOW,
    )
    .run();

  const { id: unallocatedId } = await createEnvelope(env.DB, {
    userId,
    entityId,
    name: 'Unallocated',
    type: 'unallocated',
    now: NOW,
  });

  // Mint the session DIRECTLY rather than logging in.
  //
  // These tests exercise the envelope routes, not authentication — and the
  // login route is rate limited to 10 attempts per window per IP. `SELF` sends
  // no CF-Connecting-IP, so every actor in the file shares the 'unknown'
  // bucket and the eleventh login onwards returns 429, leaving an empty cookie
  // and a confusing 401 in a test that has nothing to do with rate limiting.
  const session = await issueSession(createSessionStore(env.DB), userId, NOW, randomId());
  // Built with the app's own helper rather than a hardcoded name: APP_ORIGIN
  // is http:// in tests, so the Worker uses the dev cookie name, and a
  // hardcoded `__Host-` cookie would simply never be read.
  const cookie = buildSessionCookie(session.token, {
    maxAgeSeconds: session.maxAgeSeconds,
    insecureForLocalDev: true,
  }).split(';')[0];

  return { userId, entityId, accountId, unallocatedId, cookie };
}

const call = (a: Actor, path: string, init: RequestInit = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'ballast',
      Origin: 'http://localhost:8787',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: a.cookie,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

describe('GET envelopes', () => {
  let a: Actor;
  beforeEach(async () => {
    a = await actor(1000_00);
  });

  it('returns the unallocated residual as safe to spend', async () => {
    const res = await call(a, `/api/entities/${a.entityId}/envelopes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      envelopes: Array<{ type: string; balanceMinor: number }>;
      safeToSpendMinor: number | null;
      invariant: string;
    };
    expect(body.safeToSpendMinor).toBe(1000_00);
    expect(body.invariant).toBe('balanced');
    expect(body.envelopes.find((e) => e.type === 'unallocated')?.balanceMinor).toBe(1000_00);
  });

  it('reports safeToSpend as NULL when the bank reported nothing', async () => {
    // "We don't know" is the honest answer; a confident $0 is the dangerous
    // one. This is the "green but dead" rule applied to the hero number.
    const b = await actor(null);
    const res = await call(b, `/api/entities/${b.entityId}/envelopes`);
    const body = (await res.json()) as { safeToSpendMinor: number | null; invariant: string };
    expect(body.safeToSpendMinor).toBeNull();
    expect(body.invariant).toBe('indeterminate');
  });

  it('requires a session', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/entities/${a.entityId}/envelopes`);
    expect(res.status).toBe(401);
  });

  it('404s on ANOTHER user’s entity', async () => {
    // BOLA. The entity id comes from the URL, so it is caller-supplied data.
    // 404 rather than 403: whether an entity exists is itself information.
    const b = await actor();
    const res = await call(a, `/api/entities/${b.entityId}/envelopes`);
    expect(res.status).toBe(404);
  });
});

describe('POST transfers — tap-to-fund', () => {
  let a: Actor;
  let taxId: string;
  beforeEach(async () => {
    a = await actor(1000_00);
    taxId = (
      await createEnvelope(env.DB, {
        userId: a.userId,
        entityId: a.entityId,
        name: 'Tax',
        type: 'tax',
        targetMinor: 500_00,
        now: NOW,
      })
    ).id;
  });

  const fund = (amountMinor: number, extra: Record<string, unknown> = {}) =>
    call(a, `/api/entities/${a.entityId}/transfers`, {
      method: 'POST',
      body: JSON.stringify({
        fromEnvelopeId: a.unallocatedId,
        toEnvelopeId: taxId,
        amountMinor,
        ...extra,
      }),
    });

  it('funds an envelope', async () => {
    const res = await fund(300_00);
    expect(res.status).toBe(201);

    const list = (await (await call(a, `/api/entities/${a.entityId}/envelopes`)).json()) as {
      envelopes: Array<{ id: string; balanceMinor: number }>;
      safeToSpendMinor: number;
    };
    expect(list.envelopes.find((e) => e.id === taxId)?.balanceMinor).toBe(300_00);
    expect(list.safeToSpendMinor).toBe(700_00);
  });

  it('refuses to overdraw with 409, not 500', async () => {
    const res = await fund(5000_00);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('insufficient_funds');
  });

  it('rejects a non-integer or negative amount', async () => {
    expect((await fund(0)).status).toBe(400);
    expect((await fund(-100)).status).toBe(400);
    expect((await fund(10.5)).status).toBe(400);
  });

  it('treats a retried idempotency key as a no-op, not a second allocation', async () => {
    const key = randomId();
    expect((await fund(100_00, { idempotencyKey: key })).status).toBe(201);

    const retry = await fund(100_00, { idempotencyKey: key });
    expect(retry.status).toBe(200);
    expect((await retry.json()) as { duplicate: boolean }).toEqual({ duplicate: true });

    const list = (await (await call(a, `/api/entities/${a.entityId}/envelopes`)).json()) as {
      envelopes: Array<{ id: string; balanceMinor: number }>;
    };
    expect(list.envelopes.find((e) => e.id === taxId)?.balanceMinor).toBe(100_00);
  });

  it('will not move money into ANOTHER user’s envelope', async () => {
    const b = await actor();
    const bTax = (
      await createEnvelope(env.DB, {
        userId: b.userId,
        entityId: b.entityId,
        name: 'Tax',
        type: 'tax',
        now: NOW,
      })
    ).id;

    const res = await call(a, `/api/entities/${a.entityId}/transfers`, {
      method: 'POST',
      body: JSON.stringify({
        fromEnvelopeId: a.unallocatedId,
        toEnvelopeId: bTax,
        amountMinor: 100_00,
      }),
    });
    expect(res.status).toBe(400);

    const bList = (await (await call(b, `/api/entities/${b.entityId}/envelopes`)).json()) as {
      envelopes: Array<{ id: string; balanceMinor: number }>;
    };
    expect(bList.envelopes.find((e) => e.id === bTax)?.balanceMinor).toBe(0);
  });

  it('is CSRF-guarded', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/entities/${a.entityId}/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({
        fromEnvelopeId: a.unallocatedId,
        toEnvelopeId: taxId,
        amountMinor: 100,
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST envelopes', () => {
  let a: Actor;
  beforeEach(async () => {
    a = await actor();
  });

  it('creates a purpose envelope with a target', async () => {
    const res = await call(a, `/api/entities/${a.entityId}/envelopes`, {
      method: 'POST',
      body: JSON.stringify({ name: 'New van', type: 'save', targetMinor: 400_00 }),
    });
    expect(res.status).toBe(201);
  });

  it('refuses a SECOND unallocated envelope', async () => {
    // The residual is defined as "the entity's unallocated"; a second one makes
    // the definition, and therefore the invariant, ambiguous.
    const res = await call(a, `/api/entities/${a.entityId}/envelopes`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Another', type: 'unallocated' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown type and a missing name', async () => {
    const bad = await call(a, `/api/entities/${a.entityId}/envelopes`, {
      method: 'POST',
      body: JSON.stringify({ name: 'X', type: 'nonsense' }),
    });
    expect(bad.status).toBe(400);

    const noName = await call(a, `/api/entities/${a.entityId}/envelopes`, {
      method: 'POST',
      body: JSON.stringify({ name: '   ', type: 'save' }),
    });
    expect(noName.status).toBe(400);
  });

  it('rejects a non-positive target', async () => {
    const res = await call(a, `/api/entities/${a.entityId}/envelopes`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Bad', type: 'save', targetMinor: -1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST complete', () => {
  it('sweeps the remainder back to unallocated', async () => {
    const a = await actor(1000_00);
    const projectId = (
      await createEnvelope(env.DB, {
        userId: a.userId,
        entityId: a.entityId,
        name: 'Van',
        type: 'save',
        targetMinor: 400_00,
        now: NOW,
      })
    ).id;
    await call(a, `/api/entities/${a.entityId}/transfers`, {
      method: 'POST',
      body: JSON.stringify({
        fromEnvelopeId: a.unallocatedId,
        toEnvelopeId: projectId,
        amountMinor: 250_00,
      }),
    });

    const res = await call(a, `/api/entities/${a.entityId}/envelopes/${projectId}/complete`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { sweptMinor: number }).toEqual({ sweptMinor: 250_00 });

    const list = (await (await call(a, `/api/entities/${a.entityId}/envelopes`)).json()) as {
      envelopes: Array<{ id: string }>;
      safeToSpendMinor: number;
    };
    expect(list.envelopes.map((e) => e.id)).not.toContain(projectId);
    expect(list.safeToSpendMinor).toBe(1000_00);
  });

  it('refuses to complete unallocated', async () => {
    const a = await actor();
    const res = await call(a, `/api/entities/${a.entityId}/envelopes/${a.unallocatedId}/complete`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST envelopes · the due date', () => {
  let a: Actor;
  beforeEach(async () => {
    a = await actor();
  });

  const create = (body: Record<string, unknown>) =>
    call(a, `/api/entities/${a.entityId}/envelopes`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Q1 insurance', type: 'spend', ...body }),
    });

  const dateOf = async (id: string) =>
    (
      await env.DB.prepare('SELECT target_date FROM envelopes WHERE id = ?')
        .bind(id)
        .first<{ target_date: string | null }>()
    )?.target_date ?? null;

  it('stores a real date', async () => {
    const res = await create({ targetDate: '2026-03-15' });
    expect(res.status).toBe(201);
    expect(await dateOf(((await res.json()) as { id: string }).id)).toBe('2026-03-15');
  });

  it('REFUSES anything it could not read back', async () => {
    // THE DEFECT THIS EXISTS FOR. `typeof x === 'string'` was the whole check,
    // so "next tuesday" went into the column, nothing failed, and the date
    // simply never appeared on screen again: the operator set a deadline, the
    // app accepted it, and afterwards did not have it.
    for (const targetDate of [
      'next tuesday',
      '03/15/2026',
      '2026-3-5',
      '2026-02-30', // shape is fine; the day does not exist
      '2026-13-01',
      '2026-03-15T00:00:00Z',
      '',
      42,
    ]) {
      const res = await create({ targetDate });
      expect(res.status, JSON.stringify(targetDate)).toBe(400);
    }
  });

  it('refuses a date that Date() would silently roll over', async () => {
    // new Date('2026-02-30') becomes March 2nd. Accepting it would turn a typo
    // into a confident wrong deadline rather than a rejected one.
    expect((await create({ targetDate: '2026-02-30' })).status).toBe(400);
    expect((await create({ targetDate: '2028-02-29' })).status).toBe(201); // leap year
  });

  it('allows no date at all', async () => {
    expect((await create({})).status).toBe(201);
    expect((await create({ targetDate: null })).status).toBe(201);
  });

  it('allows a date with no target — "due on the 15th" is useful alone', async () => {
    const res = await create({ targetDate: '2026-03-15', targetMinor: null });
    expect(res.status).toBe(201);
  });

  it('returns the date to the client that will render it', async () => {
    await create({ targetDate: '2026-03-15' });
    const body = (await (await call(a, `/api/entities/${a.entityId}/envelopes`)).json()) as {
      envelopes: Array<{ name: string; targetDate: string | null }>;
    };
    expect(body.envelopes.find((e) => e.name === 'Q1 insurance')?.targetDate).toBe('2026-03-15');
  });
});
