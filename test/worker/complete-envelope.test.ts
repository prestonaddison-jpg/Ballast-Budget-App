/**
 * completeEnvelope's atomicity.
 *
 * The failure this file exists to prevent: the operator taps Complete while a
 * fund request for the same envelope is already in flight. A read-then-write
 * complete sweeps the balance it read, the fund lands, and the unconditional
 * archive then hides an envelope that still holds money. Nothing on the Canvas
 * shows it, but the residual keeps counting it as spoken for — so safe-to-spend
 * is quietly low forever with no visible cause.
 *
 * These tests assert the two properties that make that impossible: the sweep
 * takes the balance as it is at write time, and the archive only fires on an
 * envelope that is genuinely empty.
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { completeEnvelope, createEnvelope, findEnvelope, transfer } from '../../src/money/ledger';
import { MoneyError } from '../../src/money/types';
import { randomId } from '../../src/crypto/random';

const NOW = 1_800_000_000;

interface Fixture {
  userId: string;
  entityId: string;
  unallocatedId: string;
  projectId: string;
}

async function fixture(availableMinor: number | null = 1000_00): Promise<Fixture> {
  const userId = randomId();
  const entityId = randomId();
  const itemId = randomId();

  await env.DB.prepare(
    'INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)',
  )
    .bind(userId, `${userId}@example.test`, 'x', NOW, NOW)
    .run();
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
  const { id: projectId } = await createEnvelope(env.DB, {
    userId,
    entityId,
    name: 'Van',
    type: 'save',
    targetMinor: 400_00,
    now: NOW,
  });

  return { userId, entityId, unallocatedId, projectId };
}

const fund = (f: Fixture, amountMinor: number) =>
  transfer(env.DB, {
    userId: f.userId,
    entityId: f.entityId,
    fromEnvelopeId: f.unallocatedId,
    toEnvelopeId: f.projectId,
    amountMinor,
    kind: 'fund',
    now: NOW,
  });

const complete = (f: Fixture) =>
  completeEnvelope(env.DB, {
    userId: f.userId,
    entityId: f.entityId,
    envelopeId: f.projectId,
    unallocatedId: f.unallocatedId,
    now: NOW,
  });

const balanceOf = async (envelopeId: string) =>
  (
    await env.DB.prepare('SELECT balance_minor FROM envelope_balances WHERE envelope_id = ?')
      .bind(envelopeId)
      .first<{ balance_minor: number | null }>()
  )?.balance_minor ?? null;

describe('completeEnvelope', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture(1000_00);
  });

  it('sweeps the remainder back and archives', async () => {
    await fund(f, 250_00);

    const result = await complete(f);
    expect(result).toEqual({ ok: true, sweptMinor: 250_00 });

    // Conservation: the cash did not change, so the residual is whole again.
    expect(await balanceOf(f.unallocatedId)).toBe(1000_00);
    expect(await balanceOf(f.projectId)).toBe(0);
    expect((await findEnvelope(env.DB, f.userId, f.projectId))?.archived_at).toBe(NOW);
  });

  it('archives an already-empty envelope without writing an entry', async () => {
    const result = await complete(f);
    expect(result).toEqual({ ok: true, sweptMinor: 0 });

    const { results } = await env.DB.prepare(
      "SELECT id FROM ledger_entries WHERE kind = 'sweep' AND from_envelope_id = ?",
    )
      .bind(f.projectId)
      .all();
    // A zero-amount entry would violate `amount_minor > 0` anyway; this asserts
    // the guard skips it cleanly rather than the CHECK rejecting the batch.
    expect(results).toHaveLength(0);
  });

  it('leaves the envelope OPEN rather than archiving a fund that raced it', async () => {
    await fund(f, 100_00);

    // A genuine race: the fund is not awaited before the complete is issued.
    // Which one reaches D1 first is not ours to decide, so this asserts the
    // property rather than a winner — there are exactly two legal outcomes and
    // "archived while holding money" is not one of them.
    const [, result] = await Promise.all([fund(f, 150_00), complete(f)]);

    const row = await findEnvelope(env.DB, f.userId, f.projectId);
    if (result.ok) {
      // The complete won the ordering it needed: it took everything present.
      expect(row?.archived_at).toBe(NOW);
      expect(await balanceOf(f.projectId)).toBe(0);
    } else {
      // The fund landed mid-flight. The envelope stays visible, holding it.
      expect(row?.archived_at).toBeNull();
      expect(await balanceOf(f.projectId)).toBeGreaterThan(0);
    }
    // Either way the entity's cash is fully accounted for.
    expect(((await balanceOf(f.projectId)) ?? 0) + ((await balanceOf(f.unallocatedId)) ?? 0)).toBe(
      1000_00,
    );
  });

  it('NEVER archives an envelope that still holds money', async () => {
    // The property, stated directly: across twenty interleaved completes and
    // funds there must be no point at which an archived envelope has a balance.
    const work: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      work.push(fund(f, 10_00));
      work.push(complete(f).catch(() => undefined));
    }
    await Promise.all(work);

    const row = await findEnvelope(env.DB, f.userId, f.projectId);
    if (row?.archived_at != null) {
      expect(row.balance_minor).toBe(0);
    }

    // And whatever happened, no money left the entity.
    const named = await balanceOf(f.projectId);
    const unallocated = await balanceOf(f.unallocatedId);
    expect((named ?? 0) + (unallocated ?? 0)).toBe(1000_00);
  });

  it('is idempotent on retry and keeps the FIRST completed_at', async () => {
    await fund(f, 250_00);
    expect((await complete(f)).ok).toBe(true);

    const again = await completeEnvelope(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      envelopeId: f.projectId,
      unallocatedId: f.unallocatedId,
      now: NOW + 500,
    });
    // A dropped response must not sweep twice or rewrite history.
    expect(again).toEqual({ ok: true, sweptMinor: 0 });
    expect((await findEnvelope(env.DB, f.userId, f.projectId))?.completed_at).toBe(NOW);
    expect(await balanceOf(f.unallocatedId)).toBe(1000_00);
  });

  it('refuses to complete unallocated', async () => {
    await expect(
      completeEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        envelopeId: f.unallocatedId,
        unallocatedId: f.unallocatedId,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MoneyError);
  });

  it('refuses ANOTHER user’s envelope', async () => {
    const other = await fixture();
    await expect(
      completeEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        envelopeId: other.projectId,
        unallocatedId: f.unallocatedId,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MoneyError);
  });
});
