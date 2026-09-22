/**
 * The Needs You queue over HTTP.
 *
 * The engine's own guarantees are proved in proposals.test.ts. What is proved
 * here is that the app can actually REACH them, and that the entity in the URL
 * is never trusted — the exact BOLA failure §16 names as the top API risk, and
 * the one that would let one LLC's queue be approved into another's books.
 */

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionStore, createUser } from '../../src/db/repos/users';
import { hashPassword } from '../../src/auth/password';
import { issueSession } from '../../src/auth/session';
import { buildSessionCookie } from '../../src/auth/cookies';
import { createEnvelope, transfer } from '../../src/money/ledger';
import { createProposal, findProposal } from '../../src/money/proposals';
import { randomId } from '../../src/crypto/random';

const NOW = 1_800_000_000;
const ORIGIN = 'https://example.com';
const CASH = 1000_00;

interface Actor {
  userId: string;
  entityId: string;
  unallocatedId: string;
  taxId: string;
  vanId: string;
  cookie: string;
}

async function actor(availableMinor: number | null = CASH): Promise<Actor> {
  const userId = randomId();
  const entityId = randomId();
  const itemId = randomId();

  await createUser(env.DB, {
    id: userId,
    email: `${userId}@example.test`,
    passwordHash: await hashPassword('correct horse battery staple', 1000),
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
     VALUES (?,?,?,?,?,'Checking','depository','checking',?,1,?,?)`,
  )
    .bind(randomId(), userId, itemId, entityId, randomId(), availableMinor, NOW, NOW)
    .run();

  const { id: unallocatedId } = await createEnvelope(env.DB, {
    userId,
    entityId,
    name: 'Unallocated',
    type: 'unallocated',
    now: NOW,
  });
  const { id: taxId } = await createEnvelope(env.DB, {
    userId,
    entityId,
    name: 'Tax',
    type: 'tax',
    now: NOW,
  });
  const { id: vanId } = await createEnvelope(env.DB, {
    userId,
    entityId,
    name: 'Van',
    type: 'save',
    targetMinor: 400_00,
    now: NOW,
  });

  // Minted directly. The login route is rate limited to 10 per window per IP
  // and SELF sends no CF-Connecting-IP, so every actor in the file shares one
  // bucket — see the same note in envelope-routes.test.ts.
  const session = await issueSession(createSessionStore(env.DB), userId, NOW, randomId());
  const cookie = buildSessionCookie(session.token, {
    maxAgeSeconds: session.maxAgeSeconds,
    insecureForLocalDev: true,
  }).split(';')[0];

  return { userId, entityId, unallocatedId, taxId, vanId, cookie };
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

const stage = (a: Actor, amountMinor: number, over: Record<string, unknown> = {}) =>
  createProposal(env.DB, {
    userId: a.userId,
    entityId: a.entityId,
    kind: 'income_allocation',
    fromEnvelopeId: a.unallocatedId,
    toEnvelopeId: a.taxId,
    amountMinor,
    now: NOW,
    ...over,
  });

const balanceOf = async (envelopeId: string) =>
  (
    await env.DB.prepare('SELECT balance_minor FROM envelope_balances WHERE envelope_id = ?')
      .bind(envelopeId)
      .first<{ balance_minor: number | null }>()
  )?.balance_minor ?? null;

interface QueueBody {
  proposals: Array<{
    id: string;
    amountMinor: number;
    from: { name: string | null };
    to: { name: string | null };
    sourceBalanceMinor: number | null;
    affordableNow: boolean | null;
  }>;
}

describe('GET the queue', () => {
  let a: Actor;
  beforeEach(async () => {
    a = await actor();
  });

  it('is empty until something is staged', async () => {
    const res = await call(a, `/api/entities/${a.entityId}/proposals`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as QueueBody).proposals).toEqual([]);
  });

  it('names both envelopes, so the screen needs no second request', async () => {
    await stage(a, 250_00);
    const body = (await (
      await call(a, `/api/entities/${a.entityId}/proposals`)
    ).json()) as QueueBody;

    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0].from.name).toBe('Unallocated');
    expect(body.proposals[0].to.name).toBe('Tax');
    expect(body.proposals[0].amountMinor).toBe(250_00);
  });

  it('says up front when a proposal no longer fits', async () => {
    // Advisory only — approve re-checks — but offering an action that will be
    // refused teaches the operator the screen is lying to them.
    await stage(a, 900_00);
    await transfer(env.DB, {
      userId: a.userId,
      entityId: a.entityId,
      fromEnvelopeId: a.unallocatedId,
      toEnvelopeId: a.vanId,
      amountMinor: 850_00,
      kind: 'fund',
      now: NOW,
    });

    const body = (await (
      await call(a, `/api/entities/${a.entityId}/proposals`)
    ).json()) as QueueBody;
    expect(body.proposals[0].affordableNow).toBe(false);
    expect(body.proposals[0].sourceBalanceMinor).toBe(150_00);
  });

  it('reports affordability as NULL when the bank has reported nothing', async () => {
    // Not false. False says "you cannot afford this"; the truth is that we do
    // not know what is there.
    const unknown = await actor(null);
    await stage(unknown, 100_00);

    const body = (await (
      await call(unknown, `/api/entities/${unknown.entityId}/proposals`)
    ).json()) as QueueBody;
    expect(body.proposals[0].sourceBalanceMinor).toBeNull();
    expect(body.proposals[0].affordableNow).toBeNull();
  });

  it('hides elapsed proposals', async () => {
    // Against the WALL CLOCK, not the fixture's NOW. The route reads
    // Date.now(), and NOW is a fixed point in 2027 — an expiry relative to it
    // is still in the future when the test runs, so the proposal would be
    // listed and the assertion would pass for the wrong reason.
    await stage(a, 100_00, { expiresAt: Math.floor(Date.now() / 1000) - 60 });
    const body = (await (
      await call(a, `/api/entities/${a.entityId}/proposals`)
    ).json()) as QueueBody;
    expect(body.proposals).toEqual([]);
  });

  it('requires a session', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/entities/${a.entityId}/proposals`);
    expect(res.status).toBe(401);
  });

  it('404s on ANOTHER user’s entity', async () => {
    const other = await actor();
    await stage(other, 500_00);
    const res = await call(a, `/api/entities/${other.entityId}/proposals`);
    // 404, not 403: whether that entity exists is itself information.
    expect(res.status).toBe(404);
  });
});

describe('POST approve', () => {
  let a: Actor;
  beforeEach(async () => {
    a = await actor();
  });

  const approve = (actorFor: Actor, entityId: string, proposalId: string) =>
    call(actorFor, `/api/entities/${entityId}/proposals/${proposalId}/approve`, { method: 'POST' });

  it('commits and reports the entry', async () => {
    const { id } = await stage(a, 250_00);
    const res = await approve(a, a.entityId, id);

    expect(res.status).toBe(201);
    expect((await res.json()) as { amountMinor: number }).toMatchObject({ amountMinor: 250_00 });
    expect(await balanceOf(a.taxId)).toBe(250_00);
    expect(await balanceOf(a.unallocatedId)).toBe(CASH - 250_00);
  });

  it('409s with a reason when the balance moved underneath it', async () => {
    const { id } = await stage(a, 900_00);
    await transfer(env.DB, {
      userId: a.userId,
      entityId: a.entityId,
      fromEnvelopeId: a.unallocatedId,
      toEnvelopeId: a.vanId,
      amountMinor: 850_00,
      kind: 'fund',
      now: NOW,
    });

    const res = await approve(a, a.entityId, id);
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'insufficient_funds' });
    expect(await balanceOf(a.taxId)).toBe(0);
  });

  it('409s on a second tap and does not double-apply', async () => {
    const { id } = await stage(a, 100_00);
    expect((await approve(a, a.entityId, id)).status).toBe(201);

    const again = await approve(a, a.entityId, id);
    expect(again.status).toBe(409);
    expect(await balanceOf(a.taxId)).toBe(100_00);
  });

  it('CANNOT be approved through another entity’s path', async () => {
    // The proposal is this user's, but the entity in the URL is not. Passing
    // an entity you own in the path does not make someone else's proposal
    // yours, and passing one you do not own is a 404 before anything is read.
    const other = await actor();
    const { id } = await stage(other, 100_00);

    expect((await approve(a, other.entityId, id)).status).toBe(404);
    expect((await approve(a, a.entityId, id)).status).toBe(404);
    expect(await balanceOf(other.taxId)).toBe(0);
  });

  it('rejects a cross-site POST', async () => {
    const { id } = await stage(a, 100_00);
    const res = await SELF.fetch(`${ORIGIN}/api/entities/${a.entityId}/proposals/${id}/approve`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', Cookie: a.cookie },
    });
    expect(res.status).toBe(403);
    expect(await balanceOf(a.taxId)).toBe(0);
  });

  it('requires a session', async () => {
    const { id } = await stage(a, 100_00);
    const res = await SELF.fetch(`${ORIGIN}/api/entities/${a.entityId}/proposals/${id}/approve`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:8787', 'X-Requested-With': 'ballast' },
    });
    expect(res.status).toBe(401);
  });
});

describe('PATCH the amount', () => {
  let a: Actor;
  beforeEach(async () => {
    a = await actor();
  });

  const patch = (actorFor: Actor, entityId: string, proposalId: string, body: unknown) =>
    call(actorFor, `/api/entities/${entityId}/proposals/${proposalId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

  it('changes the amount and moves nothing', async () => {
    const { id } = await stage(a, 900_00);
    const res = await patch(a, a.entityId, id, { amountMinor: 400_00 });

    expect(res.status).toBe(200);
    expect((await res.json()) as { amountMinor: number }).toEqual({ amountMinor: 400_00 });
    expect(await balanceOf(a.unallocatedId)).toBe(CASH);

    const body = (await (
      await call(a, `/api/entities/${a.entityId}/proposals`)
    ).json()) as QueueBody;
    expect(body.proposals[0].amountMinor).toBe(400_00);
    // And it now fits, so the screen will offer Approve.
    expect(body.proposals[0].affordableNow).toBe(true);
  });

  it('is the recovery path for a proposal that no longer fits', async () => {
    const { id } = await stage(a, 900_00);
    await transfer(env.DB, {
      userId: a.userId,
      entityId: a.entityId,
      fromEnvelopeId: a.unallocatedId,
      toEnvelopeId: a.vanId,
      amountMinor: 850_00,
      kind: 'fund',
      now: NOW,
    });

    expect(
      (await call(a, `/api/entities/${a.entityId}/proposals/${id}/approve`, { method: 'POST' }))
        .status,
    ).toBe(409);

    expect((await patch(a, a.entityId, id, { amountMinor: 150_00 })).status).toBe(200);
    expect(
      (await call(a, `/api/entities/${a.entityId}/proposals/${id}/approve`, { method: 'POST' }))
        .status,
    ).toBe(201);
    expect(await balanceOf(a.taxId)).toBe(150_00);
  });

  it('accepts an amount above the balance — a proposal reserves nothing', async () => {
    const { id } = await stage(a, 100_00);
    expect((await patch(a, a.entityId, id, { amountMinor: CASH * 10 })).status).toBe(200);
    // And approve still refuses it, which is the check that matters.
    expect(
      (await call(a, `/api/entities/${a.entityId}/proposals/${id}/approve`, { method: 'POST' }))
        .status,
    ).toBe(409);
  });

  it('refuses an amount that is not positive whole cents', async () => {
    const { id } = await stage(a, 100_00);
    for (const amountMinor of [0, -1, 10.5, '400', null]) {
      expect((await patch(a, a.entityId, id, { amountMinor })).status, `${amountMinor}`).toBe(400);
    }
    expect(await balanceOf(a.unallocatedId)).toBe(CASH);
  });

  it('409s once the proposal has been approved', async () => {
    const { id } = await stage(a, 100_00);
    await call(a, `/api/entities/${a.entityId}/proposals/${id}/approve`, { method: 'POST' });

    expect((await patch(a, a.entityId, id, { amountMinor: 900_00 })).status).toBe(409);
    expect(await balanceOf(a.taxId)).toBe(100_00);
  });

  it('404s on ANOTHER user’s proposal, through either entity', async () => {
    const other = await actor();
    const { id } = await stage(other, 100_00);

    expect((await patch(a, other.entityId, id, { amountMinor: 1 })).status).toBe(404);
    expect((await patch(a, a.entityId, id, { amountMinor: 1 })).status).toBe(404);
    expect((await findProposal(env.DB, other.userId, id))?.amount_minor).toBe(100_00);
  });

  it('rejects a cross-site PATCH', async () => {
    const { id } = await stage(a, 100_00);
    const res = await SELF.fetch(`${ORIGIN}/api/entities/${a.entityId}/proposals/${id}`, {
      method: 'PATCH',
      headers: { Origin: 'https://evil.example', Cookie: a.cookie },
      body: JSON.stringify({ amountMinor: 1 }),
    });
    expect(res.status).toBe(403);
    expect((await findProposal(env.DB, a.userId, id))?.amount_minor).toBe(100_00);
  });

  it('requires a session', async () => {
    const { id } = await stage(a, 100_00);
    const res = await SELF.fetch(`${ORIGIN}/api/entities/${a.entityId}/proposals/${id}`, {
      method: 'PATCH',
      headers: { Origin: 'http://localhost:8787', 'X-Requested-With': 'ballast' },
      body: JSON.stringify({ amountMinor: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST dismiss', () => {
  let a: Actor;
  beforeEach(async () => {
    a = await actor();
  });

  const dismiss = (actorFor: Actor, entityId: string, proposalId: string) =>
    call(actorFor, `/api/entities/${entityId}/proposals/${proposalId}/dismiss`, { method: 'POST' });

  it('closes the proposal and touches no balance', async () => {
    const { id } = await stage(a, 400_00);
    expect((await dismiss(a, a.entityId, id)).status).toBe(200);

    expect(await balanceOf(a.unallocatedId)).toBe(CASH);
    const body = (await (
      await call(a, `/api/entities/${a.entityId}/proposals`)
    ).json()) as QueueBody;
    expect(body.proposals).toEqual([]);
  });

  it('a dismissed proposal can never be approved afterwards', async () => {
    const { id } = await stage(a, 400_00);
    await dismiss(a, a.entityId, id);

    const res = await call(a, `/api/entities/${a.entityId}/proposals/${id}/approve`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(await balanceOf(a.taxId)).toBe(0);
  });

  it('404s on ANOTHER user’s proposal', async () => {
    const other = await actor();
    const { id } = await stage(other, 100_00);
    expect((await dismiss(a, other.entityId, id)).status).toBe(404);
  });
});
