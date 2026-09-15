import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * PLATFORM CAPABILITY TEST: a guarded single-statement INSERT is atomic in D1.
 *
 * This is not a test of Ballast's code. It pins a property of the PLATFORM
 * that the entire money model is built on, so that if D1's behaviour ever
 * changes the failure surfaces here — loudly and in isolation — rather than as
 * money quietly allocated twice somewhere in the ledger.
 *
 * The whole money model depends on this. D1 has no interactive transactions,
 * so "read the balance, decide, then insert" can be interleaved by two
 * concurrent requests and both can pass the check — overdrawing an envelope.
 * The proposed fix is to fold the check INTO the insert:
 *
 *   INSERT INTO ledger (...) SELECT ... WHERE (SELECT balance...) >= amount
 *
 * A single SQL statement is atomic in SQLite. Verified here: 20 concurrent
 * attempts to spend 100 from a balance of 600 yield EXACTLY 6 successes and a
 * final balance of EXACTLY 0. So the overdraw is unrepresentable, not merely
 * guarded against — which is what lets the ledger be the single source of
 * truth without a lock or a Durable Object.
 */
beforeAll(async () => {
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS probe_ledger (id TEXT PRIMARY KEY, purse TEXT NOT NULL, delta INTEGER NOT NULL)',
  );
  await env.DB.exec('DELETE FROM probe_ledger');
  await env.DB.prepare('INSERT INTO probe_ledger (id, purse, delta) VALUES (?, ?, ?)')
    .bind('seed', 'p1', 1000)
    .run();
});

const balance = async (purse: string) => {
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(delta), 0) AS bal FROM probe_ledger WHERE purse = ?',
  )
    .bind(purse)
    .first<{ bal: number }>();
  return row?.bal ?? 0;
};

/** Spend `amount` from `purse`, but ONLY if the balance covers it. */
async function guardedSpend(purse: string, amount: number, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO probe_ledger (id, purse, delta)
     SELECT ?1, ?2, -?3
      WHERE (SELECT COALESCE(SUM(delta), 0) FROM probe_ledger WHERE purse = ?2) >= ?3`,
  )
    .bind(id, purse, amount)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

describe('D1 guarded insert', () => {
  it('permits a spend the balance covers', async () => {
    expect(await guardedSpend('p1', 400, 'a')).toBe(true);
    expect(await balance('p1')).toBe(600);
  });

  it('refuses a spend the balance does not cover', async () => {
    expect(await guardedSpend('p1', 10_000, 'b')).toBe(false);
    expect(await balance('p1')).toBe(600);
  });

  it('CANNOT be overdrawn by a concurrent burst', async () => {
    // THE question. 20 parallel attempts at 100 against a balance of 600:
    // if the guard is atomic exactly 6 succeed and the balance floors at 0.
    // If it is a read-then-write race, more succeed and the purse goes
    // negative — which in Ballast would be money allocated twice.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => guardedSpend('p1', 100, `burst-${i}`)),
    );
    const succeeded = attempts.filter(Boolean).length;
    const final = await balance('p1');

    console.log(`[probe] ${succeeded}/20 succeeded, final balance ${final}`);
    expect(final).toBeGreaterThanOrEqual(0);
    expect(succeeded).toBe(6);
    expect(final).toBe(0);
  });
});
