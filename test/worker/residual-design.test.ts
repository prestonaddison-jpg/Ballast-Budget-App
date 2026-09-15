import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * DESIGN RATIONALE TEST — why `unallocated` is a residual, not a ledger sum.
 *
 * This proves the property the whole money model is chosen for, against a
 * miniature of the real schema. It is kept permanently because the design is
 * counter-intuitive: a future reader will reasonably want to "fix" unallocated
 * into a normal summed envelope, and these six tests say exactly what that
 * would cost.
 *
 * The claim: define unallocated as `cash - SUM(named envelopes)` rather than
 * as a ledger sum, and SUM(envelopes) = SUM(budgetable accounts) becomes an
 * algebraic identity no database state can violate — tracking a bank balance
 * change with ZERO writes.
 *
 * The risk this test was written to settle: the atomic guarded insert was
 * proven for a source whose balance is a simple ledger SUM. Here the source is
 * a COMPUTED residual over two tables. If the guard could not be expressed as
 * one statement the design would collapse. It can — 20 concurrent moves of 100
 * against a residual of 600 yield exactly 6 successes and floor at exactly 0.
 *
 * WHY THIS BEAT THE ALTERNATIVES: the spec pins the invariant to AVAILABLE,
 * and available moves whenever a hold appears or clears — with no transaction
 * behind it and nothing for Ballast to intercept. Any design that sums
 * unallocated from the ledger is therefore WRONG between syncs, by an
 * unbounded amount, until a reconciliation job catches up. The residual is
 * right at every instant, with no reconciliation job to run, fail, or forget.
 */
beforeAll(async () => {
  await env.DB.exec('DROP VIEW IF EXISTS r_balances');
  await env.DB.exec('DROP TABLE IF EXISTS r_entries');
  await env.DB.exec('DROP TABLE IF EXISTS r_env');
  await env.DB.exec('DROP TABLE IF EXISTS r_cash');

  await env.DB.exec(
    'CREATE TABLE r_cash (id TEXT PRIMARY KEY, entity TEXT NOT NULL, available INTEGER, budgetable INTEGER NOT NULL DEFAULT 1)',
  );
  await env.DB.exec(
    'CREATE TABLE r_env (id TEXT PRIMARY KEY, entity TEXT NOT NULL, kind TEXT NOT NULL)',
  );
  await env.DB.exec(
    'CREATE TABLE r_entries (id TEXT PRIMARY KEY, entity TEXT NOT NULL, frm TEXT NOT NULL, dst TEXT NOT NULL, amt INTEGER NOT NULL CHECK (amt > 0), CHECK (frm <> dst))',
  );

  // Named-envelope balance is a plain ledger sum. Unallocated is the residual.
  //
  // NOTE: D1.exec() splits on NEWLINES and runs each line as its own
  // statement, so multi-line DDL must go through prepare().run().
  await env.DB.prepare(
    `CREATE VIEW r_balances AS
     SELECT e.id AS env_id, e.entity AS entity,
            CASE WHEN e.kind = 'unallocated' THEN
              (SELECT COALESCE(SUM(c.available),0) FROM r_cash c
                WHERE c.entity = e.entity AND c.budgetable = 1)
              - (
                  (SELECT COALESCE(SUM(x.amt),0) FROM r_entries x
                     JOIN r_env n ON n.id = x.dst
                    WHERE n.entity = e.entity AND n.kind <> 'unallocated')
                - (SELECT COALESCE(SUM(x.amt),0) FROM r_entries x
                     JOIN r_env n ON n.id = x.frm
                    WHERE n.entity = e.entity AND n.kind <> 'unallocated')
                )
            ELSE
              (SELECT COALESCE(SUM(x.amt),0) FROM r_entries x WHERE x.dst = e.id)
              - (SELECT COALESCE(SUM(x.amt),0) FROM r_entries x WHERE x.frm = e.id)
            END AS balance
       FROM r_env e`,
  ).run();

  await env.DB.batch([
    env.DB.prepare("INSERT INTO r_cash (id,entity,available) VALUES ('c1','E1',600)"),
    env.DB.prepare("INSERT INTO r_env (id,entity,kind) VALUES ('u','E1','unallocated')"),
    env.DB.prepare("INSERT INTO r_env (id,entity,kind) VALUES ('tax','E1','tax')"),
    env.DB.prepare("INSERT INTO r_env (id,entity,kind) VALUES ('buf','E1','buffer')"),
  ]);
});

const bal = async (id: string) => {
  const r = await env.DB.prepare('SELECT balance FROM r_balances WHERE env_id = ?')
    .bind(id)
    .first<{ balance: number }>();
  return r?.balance ?? 0;
};

const total = async () => {
  const r = await env.DB.prepare(
    "SELECT COALESCE(SUM(balance),0) AS t FROM r_balances WHERE entity = 'E1'",
  ).first<{ t: number }>();
  return r?.t ?? 0;
};

/** Guarded move: the residual balance check lives INSIDE the insert. */
async function move(id: string, frm: string, dst: string, amt: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT INTO r_entries (id, entity, frm, dst, amt)
     SELECT ?1, 'E1', ?2, ?3, ?4
      WHERE ?4 > 0
        AND (SELECT balance FROM r_balances WHERE env_id = ?2) >= ?4`,
  )
    .bind(id, frm, dst, amt)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

describe('residual unallocated', () => {
  it('makes conservation an identity from the start', async () => {
    expect(await bal('u')).toBe(600);
    expect(await total()).toBe(600);
  });

  it('holds after allocating', async () => {
    expect(await move('m1', 'u', 'tax', 250)).toBe(true);
    expect(await bal('tax')).toBe(250);
    expect(await bal('u')).toBe(350);
    expect(await total()).toBe(600);
  });

  it('TRACKS A BANK BALANCE CHANGE WITH ZERO LEDGER WRITES', async () => {
    // The decisive property. A hold clears, `available` moves, and no
    // transaction exists to intercept. Approaches that sum unallocated from
    // the ledger are simply WRONG until a reconciliation job runs.
    await env.DB.prepare("UPDATE r_cash SET available = 900 WHERE id = 'c1'").run();
    expect(await bal('tax')).toBe(250); // the operator's allocation is untouched
    expect(await bal('u')).toBe(650); // the residual absorbed it
    expect(await total()).toBe(900); // invariant holds instantly
  });

  it('goes NEGATIVE rather than lying when cash drops below allocations', async () => {
    await env.DB.prepare("UPDATE r_cash SET available = 100 WHERE id = 'c1'").run();
    expect(await bal('tax')).toBe(250);
    expect(await bal('u')).toBe(-150); // visible over-allocation, not a hidden one
    expect(await total()).toBe(100);
  });

  it('refuses to allocate from an overdrawn residual', async () => {
    expect(await move('m2', 'u', 'buf', 50)).toBe(false);
    expect(await total()).toBe(100);
  });

  it('CANNOT be overdrawn by a concurrent burst against the RESIDUAL', async () => {
    // The real question: does the guard stay atomic when the source balance is
    // a computed residual over two tables rather than a simple ledger sum?
    await env.DB.prepare("UPDATE r_cash SET available = 850 WHERE id = 'c1'").run();
    expect(await bal('u')).toBe(600); // 850 - 250 allocated

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => move(`burst-${i}`, 'u', 'buf', 100)),
    );
    const ok = results.filter(Boolean).length;
    console.log(`[residual] ${ok}/20 succeeded, unallocated=${await bal('u')}`);
    expect(ok).toBe(6);
    expect(await bal('u')).toBe(0);
    expect(await total()).toBe(850);
  });
});
