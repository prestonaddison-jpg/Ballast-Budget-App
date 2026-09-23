import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  completeEnvelope,
  createEnvelope,
  findEnvelope,
  findUnallocated,
  listEnvelopesWithBalances,
  moveBetween,
  transfer,
} from '../../src/money/ledger';
import { MoneyError } from '../../src/money/types';
import { createUser } from '../../src/db/repos/users';
import { hashPassword } from '../../src/auth/password';
import { randomId } from '../../src/crypto/random';

const NOW = 1_800_000_000;

interface Fixture {
  userId: string;
  entityId: string;
  accountId: string;
  unallocatedId: string;
}

/** A user with one entity, one budgetable account, and an unallocated envelope. */
async function seed(availableMinor: number | null = 600_00): Promise<Fixture> {
  const userId = randomId();
  const entityId = randomId();
  const accountId = randomId();
  const itemId = randomId();

  await createUser(env.DB, {
    id: userId,
    email: `${userId}@example.test`,
    passwordHash: await hashPassword('pw', 1000),
    now: NOW,
  });
  await env.DB.prepare(
    'INSERT INTO entities (id, user_id, name, state, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  )
    .bind(entityId, userId, 'Test Entity', 'TX', NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO source_items (id, user_id, source_item_id, access_token_enc, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(itemId, userId, randomId(), 'v1.x.y', NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO source_accounts
       (id, user_id, item_id, entity_id, source_account_id, name, type, subtype,
        available_minor, budgetable, created_at, updated_at)
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

  return { userId, entityId, accountId, unallocatedId };
}

/**
 * A SECOND budgetable account on an existing fixture, so that "this account is
 * excluded" can be asserted against a pool that is not empty. Without it the
 * only observable of an exclusion is an empty set, which since migration 0004
 * reads as UNKNOWN rather than zero.
 */
async function addAccount(f: Fixture, availableMinor: number | null): Promise<string> {
  const itemId = randomId();
  const accountId = randomId();
  await env.DB.prepare(
    `INSERT INTO source_items (id, user_id, source_item_id, access_token_enc, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  )
    .bind(itemId, f.userId, randomId(), 'v1.x.y', NOW, NOW)
    .run();
  await env.DB.prepare(
    `INSERT INTO source_accounts
       (id, user_id, item_id, entity_id, source_account_id, name, type, subtype,
        available_minor, budgetable, created_at, updated_at)
     VALUES (?,?,?,?,?,'Savings','depository','savings',?,1,?,?)`,
  )
    .bind(accountId, f.userId, itemId, f.entityId, randomId(), availableMinor, NOW, NOW)
    .run();
  return accountId;
}

const balanceOf = async (userId: string, envelopeId: string) =>
  (await findEnvelope(env.DB, userId, envelopeId))?.balance_minor ?? null;

const entityTotal = async (userId: string, entityId: string) => {
  const rows = await listEnvelopesWithBalances(env.DB, userId, entityId);
  return rows.reduce((t, r) => t + (r.balance_minor ?? 0), 0);
};

describe('the residual: unallocated tracks cash with no ledger writes', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seed(600_00);
  });

  it('starts equal to available cash', async () => {
    expect(await balanceOf(f.userId, f.unallocatedId)).toBe(600_00);
  });

  it('follows a bank balance change with ZERO writes', async () => {
    // A hold clears. There is no transaction behind it and nothing for Ballast
    // to intercept — yet the invariant must hold at that instant.
    await env.DB.prepare('UPDATE source_accounts SET available_minor = ? WHERE id = ?')
      .bind(900_00, f.accountId)
      .run();
    expect(await balanceOf(f.userId, f.unallocatedId)).toBe(900_00);
  });

  it('is NULL when the bank reported no available balance', async () => {
    // Unknown is not zero. Treating it as zero would make every envelope look
    // over-allocated and would let "safe to spend" claim $0 with confidence.
    const g = await seed(null);
    expect(await balanceOf(g.userId, g.unallocatedId)).toBeNull();
  });

  it('EXCLUDES a non-budgetable account from cash', async () => {
    // Proven against a pool that still EXISTS, so the assertion is about
    // exclusion and nothing else. An earlier version of this test emptied the
    // pool entirely and asserted 0 — which quietly encoded "no budgetable
    // account means zero dollars", the exact lie migration 0004 removes.
    await addAccount(f, 250_00);
    await env.DB.prepare('UPDATE source_accounts SET budgetable = 0 WHERE id = ?')
      .bind(f.accountId)
      .run();
    // $600 excluded, $250 counted. Not $850, and not $0.
    expect(await balanceOf(f.userId, f.unallocatedId)).toBe(250_00);
  });

  it('excludes a closed account', async () => {
    await addAccount(f, 250_00);
    await env.DB.prepare('UPDATE source_accounts SET closed_at = ? WHERE id = ?')
      .bind(NOW, f.accountId)
      .run();
    expect(await balanceOf(f.userId, f.unallocatedId)).toBe(250_00);
  });

  it('is NULL, not 0, when every account is excluded', async () => {
    // The empty pool. Nothing is budgetable, so there is no figure to report —
    // exactly as when no bank has been linked at all. checkInvariant has always
    // called this 'indeterminate'; before 0004 the view called it $0.
    await env.DB.prepare('UPDATE source_accounts SET budgetable = 0 WHERE id = ?')
      .bind(f.accountId)
      .run();
    expect(await balanceOf(f.userId, f.unallocatedId)).toBeNull();
  });

  it('is NULL, not 0, when no account has ever been linked', async () => {
    // The production state on the day of the first deploy.
    await env.DB.prepare('DELETE FROM source_accounts WHERE id = ?').bind(f.accountId).run();
    expect(await balanceOf(f.userId, f.unallocatedId)).toBeNull();
  });
});

describe('funding and moving', () => {
  let f: Fixture;
  let taxId: string;
  let bufferId: string;

  beforeEach(async () => {
    f = await seed(600_00);
    taxId = (
      await createEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        name: 'Tax',
        type: 'tax',
        targetMinor: 300_00,
        now: NOW,
      })
    ).id;
    bufferId = (
      await createEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        name: 'Buffer',
        type: 'buffer',
        now: NOW,
      })
    ).id;
  });

  it('moves money and keeps the entity total constant', async () => {
    const before = await entityTotal(f.userId, f.entityId);
    const result = await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: taxId,
      amountMinor: 250_00,
      kind: 'fund',
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(await balanceOf(f.userId, taxId)).toBe(250_00);
    expect(await balanceOf(f.userId, f.unallocatedId)).toBe(350_00);
    // Conservation: relabelling money never changes how much there is.
    expect(await entityTotal(f.userId, f.entityId)).toBe(before);
  });

  it('refuses to overdraw', async () => {
    const result = await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: taxId,
      amountMinor: 900_00,
      kind: 'fund',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(await balanceOf(f.userId, taxId)).toBe(0);
  });

  it('CANNOT be overdrawn by a concurrent burst', async () => {
    // The property the whole design exists for. Without the guard folded into
    // the INSERT, every one of these reads 600_00 and every one succeeds.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        transfer(env.DB, {
          userId: f.userId,
          entityId: f.entityId,
          fromEnvelopeId: f.unallocatedId,
          toEnvelopeId: taxId,
          amountMinor: 100_00,
          kind: 'fund',
          now: NOW,
        }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(6);
    expect(await balanceOf(f.userId, f.unallocatedId)).toBe(0);
    expect(await balanceOf(f.userId, taxId)).toBe(600_00);
    expect(await entityTotal(f.userId, f.entityId)).toBe(600_00);
  });

  it('moves between two named envelopes', async () => {
    await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: taxId,
      amountMinor: 250_00,
      kind: 'fund',
      now: NOW,
    });
    const result = await moveBetween(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: taxId,
      toEnvelopeId: bufferId,
      amountMinor: 100_00,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(await balanceOf(f.userId, taxId)).toBe(150_00);
    expect(await balanceOf(f.userId, bufferId)).toBe(100_00);
    // Unallocated is untouched: moving between named envelopes does not change
    // SUM(named), so the residual cannot move.
    expect(await balanceOf(f.userId, f.unallocatedId)).toBe(350_00);
  });

  it('rejects a zero or negative amount', async () => {
    for (const amount of [0, -100, 1.5]) {
      await expect(
        transfer(env.DB, {
          userId: f.userId,
          entityId: f.entityId,
          fromEnvelopeId: f.unallocatedId,
          toEnvelopeId: taxId,
          amountMinor: amount,
          kind: 'fund',
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(MoneyError);
    }
  });

  it('rejects a transfer to itself', async () => {
    await expect(
      transfer(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        fromEnvelopeId: taxId,
        toEnvelopeId: taxId,
        amountMinor: 1,
        kind: 'move',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MoneyError);
  });

  it('refuses to allocate from an UNKNOWN balance', async () => {
    // NULL >= amount is NULL, not true, so the insert never fires. Nothing can
    // be allocated out of a balance nobody knows.
    const g = await seed(null);
    const gTax = (
      await createEnvelope(env.DB, {
        userId: g.userId,
        entityId: g.entityId,
        name: 'Tax',
        type: 'tax',
        now: NOW,
      })
    ).id;

    const result = await transfer(env.DB, {
      userId: g.userId,
      entityId: g.entityId,
      fromEnvelopeId: g.unallocatedId,
      toEnvelopeId: gTax,
      amountMinor: 1_00,
      kind: 'fund',
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(await balanceOf(g.userId, gTax)).toBe(0);
  });

  it('treats a retry with the same idempotency key as a no-op', async () => {
    const key = randomId();
    const first = await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: taxId,
      amountMinor: 100_00,
      kind: 'fund',
      idempotencyKey: key,
      now: NOW,
    });
    const retry = await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: taxId,
      amountMinor: 100_00,
      kind: 'fund',
      idempotencyKey: key,
      now: NOW,
    });

    expect(first.ok).toBe(true);
    expect(retry).toEqual({ ok: false, reason: 'duplicate' });
    // The money moved ONCE. A dropped response must not cost the operator a
    // second allocation.
    expect(await balanceOf(f.userId, taxId)).toBe(100_00);
  });
});

describe('isolation between users and entities', () => {
  it('will not transfer across entities', async () => {
    // §3: no commingling. Each entity is a separate legal person.
    const a = await seed(500_00);
    const b = await seed(500_00);
    const bTax = (
      await createEnvelope(env.DB, {
        userId: b.userId,
        entityId: b.entityId,
        name: 'Tax',
        type: 'tax',
        now: NOW,
      })
    ).id;

    const result = await transfer(env.DB, {
      userId: a.userId,
      entityId: a.entityId,
      fromEnvelopeId: a.unallocatedId,
      toEnvelopeId: bTax,
      amountMinor: 100_00,
      kind: 'fund',
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(await balanceOf(b.userId, bTax)).toBe(0);
  });

  it('does not leak another user’s envelopes', async () => {
    const a = await seed();
    const b = await seed();
    const rows = await listEnvelopesWithBalances(env.DB, a.userId, a.entityId);
    expect(rows.every((r) => r.user_id === a.userId)).toBe(true);
    expect(await findEnvelope(env.DB, a.userId, b.unallocatedId)).toBeNull();
  });
});

describe('completeEnvelope (§12)', () => {
  it('sweeps the remainder to unallocated and archives', async () => {
    const f = await seed(600_00);
    const projectId = (
      await createEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        name: 'New van',
        type: 'save',
        targetMinor: 400_00,
        now: NOW,
      })
    ).id;
    await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: projectId,
      amountMinor: 250_00,
      kind: 'fund',
      now: NOW,
    });

    const result = await completeEnvelope(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      envelopeId: projectId,
      unallocatedId: f.unallocatedId,
      now: NOW + 1,
    });

    expect(result).toEqual({ ok: true, sweptMinor: 250_00 });
    expect(await balanceOf(f.userId, f.unallocatedId)).toBe(600_00);
    // Archived envelopes leave the Canvas.
    const live = await listEnvelopesWithBalances(env.DB, f.userId, f.entityId);
    expect(live.map((r) => r.id)).not.toContain(projectId);
    expect(await entityTotal(f.userId, f.entityId)).toBe(600_00);
  });

  it('completes an empty envelope without a ledger entry', async () => {
    const f = await seed(600_00);
    const emptyId = (
      await createEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        name: 'Unused',
        type: 'spend',
        now: NOW,
      })
    ).id;

    expect(
      await completeEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        envelopeId: emptyId,
        unallocatedId: f.unallocatedId,
        now: NOW + 1,
      }),
    ).toEqual({ ok: true, sweptMinor: 0 });
  });

  it('refuses to complete unallocated', async () => {
    // Sweeping the residual into itself and archiving the envelope the
    // entity's balance is defined against.
    const f = await seed(600_00);
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

  it('will not transfer out of an archived envelope', async () => {
    const f = await seed(600_00);
    const oldId = (
      await createEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        name: 'Old',
        type: 'spend',
        now: NOW,
      })
    ).id;
    await env.DB.prepare('UPDATE envelopes SET archived_at = ? WHERE id = ?')
      .bind(NOW, oldId)
      .run();

    const result = await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: oldId,
      amountMinor: 1_00,
      kind: 'fund',
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe('over-allocation is shown, not hidden', () => {
  it('lets unallocated go NEGATIVE when cash falls below allocations', async () => {
    // A deposit bounces after the operator already allocated it. The honest
    // answer is "you are over-allocated by $150", not a quietly drained tax
    // envelope and a reassuring $0.
    const f = await seed(600_00);
    const taxId = (
      await createEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        name: 'Tax',
        type: 'tax',
        now: NOW,
      })
    ).id;
    await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: taxId,
      amountMinor: 400_00,
      kind: 'fund',
      now: NOW,
    });

    await env.DB.prepare('UPDATE source_accounts SET available_minor = ? WHERE id = ?')
      .bind(250_00, f.accountId)
      .run();

    expect(await balanceOf(f.userId, taxId)).toBe(400_00);
    expect(await balanceOf(f.userId, f.unallocatedId)).toBe(-150_00);
    // The invariant still holds exactly.
    expect(await entityTotal(f.userId, f.entityId)).toBe(250_00);
  });

  it('refuses further allocation while over-allocated', async () => {
    const f = await seed(600_00);
    const taxId = (
      await createEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        name: 'Tax',
        type: 'tax',
        now: NOW,
      })
    ).id;
    await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: taxId,
      amountMinor: 400_00,
      kind: 'fund',
      now: NOW,
    });
    await env.DB.prepare('UPDATE source_accounts SET available_minor = ? WHERE id = ?')
      .bind(250_00, f.accountId)
      .run();

    const result = await transfer(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: taxId,
      amountMinor: 1_00,
      kind: 'fund',
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_funds' });
  });
});

describe('findUnallocated', () => {
  it('finds the one unallocated envelope for an entity', async () => {
    const f = await seed(600_00);
    const found = await findUnallocated(env.DB, f.userId, f.entityId);
    expect(found?.id).toBe(f.unallocatedId);
  });

  it('cannot create a second unallocated envelope for one entity', async () => {
    // The residual is defined in terms of "the entity's unallocated"; a second
    // one would make the definition ambiguous and the invariant meaningless.
    const f = await seed(600_00);
    await expect(
      createEnvelope(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        name: 'Another',
        type: 'unallocated',
        now: NOW,
      }),
    ).rejects.toThrow();
  });
});
