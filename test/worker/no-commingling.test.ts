import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createUser } from '../../src/db/repos/users';
import { hashPassword } from '../../src/auth/password';
import { createEnvelope } from '../../src/money/ledger';
import { randomId } from '../../src/crypto/random';

const NOW = 1_800_000_000;

/**
 * No-commingling is STRUCTURAL, not just guarded.
 *
 * migrations/0002 claims a cross-entity transfer is "unrepresentable" via
 * composite foreign key. That claim rests on D1 actually enforcing foreign
 * keys — which is not a given, since SQLite defaults them OFF and the PRAGMA
 * is per-connection. If D1 ignored it, the only thing standing between two
 * entities would be the EXISTS clauses in transfer(), and a future code path
 * that wrote a ledger row by any other route would silently commingle money
 * belonging to two separate legal persons (§3).
 *
 * So this verifies the schema DIRECTLY, bypassing transfer() entirely.
 */
describe('D1 foreign key enforcement', () => {
  it('has foreign keys ON', async () => {
    const row = await env.DB.prepare('PRAGMA foreign_keys').first<Record<string, number>>();
    expect(row).toEqual({ foreign_keys: 1 });
  });

  it('REFUSES a cross-entity ledger row written directly', async () => {
    // Bypasses transfer()'s guarded INSERT entirely to test the SCHEMA alone.
    // If the composite FK is not enforced, this row lands and the "structural
    // no-commingling" claim in the migration header is false.
    const userId = randomId();
    const e1 = randomId();
    const e2 = randomId();
    await createUser(env.DB, {
      id: userId,
      email: `${userId}@x.test`,
      passwordHash: await hashPassword('pw', 1000),
      now: NOW,
    });
    for (const id of [e1, e2]) {
      await env.DB.prepare(
        'INSERT INTO entities (id,user_id,name,state,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
        .bind(id, userId, 'E', 'TX', NOW, NOW)
        .run();
    }
    const a = (
      await createEnvelope(env.DB, { userId, entityId: e1, name: 'A', type: 'tax', now: NOW })
    ).id;
    const b = (
      await createEnvelope(env.DB, { userId, entityId: e2, name: 'B', type: 'tax', now: NOW })
    ).id;

    let landed = false;
    try {
      await env.DB.prepare(
        `INSERT INTO ledger_entries
           (id,user_id,entity_id,from_envelope_id,to_envelope_id,amount_minor,kind,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
        .bind(randomId(), userId, e1, a, b, 100, 'move', NOW)
        .run();
      landed = true;
    } catch (err) {
      expect(err instanceof Error ? err.message : String(err)).toContain('FOREIGN KEY');
    }
    // Rejected by the composite FK, with the application guard bypassed
    // entirely. The no-commingling rule holds at the schema level.
    expect(landed).toBe(false);
  });
});
