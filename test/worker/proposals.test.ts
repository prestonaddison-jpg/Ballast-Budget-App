/**
 * Proposals — the staging model (Blueprint §4), and the one rule it hangs on:
 *
 *   "Proposals are validated against the CURRENT balance at approve-time, not
 *    at generation-time."
 *
 * The failure this file exists to prevent is specific and expensive. A
 * proposal is generated on Monday's sync suggesting $900 of income go to Tax.
 * On Tuesday the operator funds a parts order and unallocated falls to $150.
 * On Wednesday they tap Approve. If the amount on the proposal row were
 * treated as a reservation — or checked against the balance that was true when
 * it was generated — the app would commit $900 out of $150 and then report,
 * with total confidence, a figure that is not the operator's money.
 *
 * So `amount_minor` reserves nothing. Every test below is some form of the
 * same assertion: the number on the proposal is an intent, and the number in
 * the ledger at the instant of approval is the truth.
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import migration0003 from '../../migrations/0003_v3_proposals.sql?raw';
import {
  PROPOSAL_KINDS,
  approveProposal,
  createProposal,
  dismissProposal,
  editProposal,
  expireProposals,
  findProposal,
  listPendingProposals,
} from '../../src/money/proposals';
import { createEnvelope, transfer } from '../../src/money/ledger';
import { checkInvariant, safeToSpend } from '../../src/money/invariant';
import { MoneyError } from '../../src/money/types';
import { randomId } from '../../src/crypto/random';

const NOW = 1_800_000_000;
const CASH = 1000_00;

interface Fixture {
  userId: string;
  entityId: string;
  unallocatedId: string;
  taxId: string;
  vanId: string;
}

async function fixture(availableMinor: number | null = CASH): Promise<Fixture> {
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

  return { userId, entityId, unallocatedId, taxId, vanId };
}

const balanceOf = async (envelopeId: string) =>
  (
    await env.DB.prepare('SELECT balance_minor FROM envelope_balances WHERE envelope_id = ?')
      .bind(envelopeId)
      .first<{ balance_minor: number | null }>()
  )?.balance_minor ?? null;

const fund = (f: Fixture, toEnvelopeId: string, amountMinor: number) =>
  transfer(env.DB, {
    userId: f.userId,
    entityId: f.entityId,
    fromEnvelopeId: f.unallocatedId,
    toEnvelopeId,
    amountMinor,
    kind: 'fund',
    now: NOW,
  });

const stage = (
  f: Fixture,
  amountMinor: number,
  over: Partial<Parameters<typeof createProposal>[1]> = {},
) =>
  createProposal(env.DB, {
    userId: f.userId,
    entityId: f.entityId,
    kind: 'income_allocation',
    fromEnvelopeId: f.unallocatedId,
    toEnvelopeId: f.taxId,
    amountMinor,
    now: NOW,
    ...over,
  });

const approve = (f: Fixture, proposalId: string, now = NOW) =>
  approveProposal(env.DB, { userId: f.userId, proposalId, now });

/** Every entry the ledger holds for one envelope pair, for counting commits. */
const entriesFor = async (proposalId: string) => {
  const { results } = await env.DB.prepare(
    'SELECT id, amount_minor FROM ledger_entries WHERE idempotency_key = ?',
  )
    .bind(`proposal:${proposalId}`)
    .all<{ id: string; amount_minor: number }>();
  return results ?? [];
};

describe('the 0003 migration', () => {
  it('applies to an empty D1 — the proposals table and its indexes exist', async () => {
    // The suite runs the real migrations/ directory against a fresh database
    // (test/global-setup.ts), so reaching this assertion at all means 0003
    // applied. What is asserted here is that it produced what it claims to.
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proposals'",
    ).first<{ name: string }>();
    expect(table?.name).toBe('proposals');

    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'proposals'",
    ).all<{ name: string }>();
    const names = (results ?? []).map((r) => r.name);
    expect(names).toContain('idx_proposals_queue');
    expect(names).toContain('idx_proposals_user');
    expect(names).toContain('idx_proposals_expiry');
  });

  it('is ADDITIVE ONLY, which is what makes rolling v3 back to v2 real', async () => {
    // Rollback safety is not a promise, it is a property of the SQL. If 0003
    // ever alters or drops something 0001/0002 created, the previous release's
    // code stops booting against this schema and "just redeploy the old one"
    // becomes a restore-from-backup instead.
    const statements = migration0003
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement, `not an additive statement: ${statement.slice(0, 60)}`).toMatch(
        /^CREATE (TABLE|INDEX|VIEW|TRIGGER)\b/i,
      );
    }
  });

  it('leaves the v2 money model working exactly as it did', async () => {
    // The other half of the rollback claim: v2's only write path still behaves
    // against the v3 schema, with no proposal involved anywhere.
    const f = await fixture();
    const result = await fund(f, f.vanId, 300_00);
    expect(result.ok).toBe(true);
    expect(await balanceOf(f.vanId)).toBe(300_00);
    expect(await balanceOf(f.unallocatedId)).toBe(CASH - 300_00);
  });
});

describe('staging a proposal', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it('moves no money — that is the entire point of staging', async () => {
    const { id } = await stage(f, 900_00);

    expect(await balanceOf(f.unallocatedId)).toBe(CASH);
    expect(await balanceOf(f.taxId)).toBe(0);
    expect(await entriesFor(id)).toHaveLength(0);
  });

  it('stages an amount the balance does not cover, on purpose', async () => {
    // Refusing here would mean the operator never learns that the suggestion
    // and their cash disagree — they would simply be shown nothing.
    const { id } = await stage(f, CASH * 5);
    expect((await findProposal(env.DB, f.userId, id))?.status).toBe('pending');
  });

  it('refuses an amount that is not positive whole cents', async () => {
    await expect(stage(f, 0)).rejects.toBeInstanceOf(MoneyError);
    await expect(stage(f, -100)).rejects.toBeInstanceOf(MoneyError);
    await expect(stage(f, 10.5)).rejects.toBeInstanceOf(MoneyError);
  });

  it('refuses an envelope proposing to itself', async () => {
    await expect(stage(f, 100_00, { toEnvelopeId: f.unallocatedId })).rejects.toBeInstanceOf(
      MoneyError,
    );
  });

  it('CANNOT be written across two entities', async () => {
    // Structural, not checked: the composite FK makes the row unrepresentable,
    // so a cross-entity proposal can never exist to be approved.
    const other = await fixture();
    await expect(stage(f, 100_00, { toEnvelopeId: other.taxId })).rejects.toBeTruthy();
  });

  it('lists one entity’s pending queue, oldest first, skipping elapsed ones', async () => {
    const a = await stage(f, 100_00);
    const b = await createProposal(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      kind: 'tax_skim',
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: f.taxId,
      amountMinor: 200_00,
      now: NOW + 1,
    });
    const stale = await stage(f, 300_00, { expiresAt: NOW - 1 });

    const queue = await listPendingProposals(env.DB, f.userId, f.entityId, NOW);
    expect(queue.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(queue.map((p) => p.id)).not.toContain(stale.id);
  });
});

describe('approving against the balance as it is NOW', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it('commits when the cash is there', async () => {
    const { id } = await stage(f, 250_00);
    const result = await approve(f, id);

    expect(result).toEqual({ ok: true, entryId: expect.any(String), amountMinor: 250_00 });
    expect(await balanceOf(f.taxId)).toBe(250_00);
    expect(await balanceOf(f.unallocatedId)).toBe(CASH - 250_00);

    const row = await findProposal(env.DB, f.userId, id);
    expect(row?.status).toBe('approved');
    expect(row?.decided_at).toBe(NOW);
    // The audit trail: from "you approved this" to "this is what moved".
    expect(row?.entry_id).toBe((result as { entryId: string }).entryId);
  });

  it('REFUSES a proposal the balance no longer covers', async () => {
    // THE TEST THIS FILE EXISTS FOR. $900 staged while $1,000 was free; $850
    // then goes to the van; the $900 must not commit out of the $150 left.
    const { id } = await stage(f, 900_00);
    await fund(f, f.vanId, 850_00);
    expect(await balanceOf(f.unallocatedId)).toBe(150_00);

    const result = await approve(f, id);

    expect(result).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(await balanceOf(f.taxId)).toBe(0);
    expect(await balanceOf(f.unallocatedId)).toBe(150_00);
    // Still pending, so the operator is shown it again rather than it silently
    // vanishing — they chose this allocation and it has not been resolved.
    expect((await findProposal(env.DB, f.userId, id))?.status).toBe('pending');
  });

  it('commits at exactly the balance, and refuses one cent past it', async () => {
    const exact = await stage(f, CASH);
    const over = await stage(f, CASH + 1);

    expect((await approve(f, over.id)).ok).toBe(false);
    expect((await approve(f, exact.id)).ok).toBe(true);
    expect(await balanceOf(f.unallocatedId)).toBe(0);
  });

  it('refuses to commit out of a balance NOBODY KNOWS', async () => {
    // A bank that has reported no available balance leaves unallocated NULL.
    // Null is unknown, never zero — and an unknown source commits nothing,
    // because "we think you can afford this" is a claim we cannot make.
    const unknown = await fixture(null);
    expect(await balanceOf(unknown.unallocatedId)).toBeNull();

    const { id } = await stage(unknown, 100_00);
    const result = await approve(unknown, id);

    expect(result.ok).toBe(false);
    // Not "insufficient" — that would be a statement about an amount we do
    // not have.
    expect(result).toEqual({ ok: false, reason: 'rejected' });
    expect(await balanceOf(unknown.taxId)).toBe(0);
  });

  it('refuses an elapsed proposal even if the cash is there', async () => {
    const { id } = await stage(f, 100_00, { expiresAt: NOW + 60 });
    const result = await approve(f, id, NOW + 61);

    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(await balanceOf(f.taxId)).toBe(0);
  });

  it('refuses a proposal whose destination has been archived', async () => {
    const { id } = await stage(f, 100_00);
    await env.DB.prepare('UPDATE envelopes SET archived_at = ? WHERE id = ?')
      .bind(NOW, f.taxId)
      .run();

    expect((await approve(f, id)).ok).toBe(false);
    expect(await balanceOf(f.unallocatedId)).toBe(CASH);
  });

  it('refuses ANOTHER user’s proposal, and reports it as not found', async () => {
    const other = await fixture();
    const { id } = await stage(other, 100_00);

    // Not "forbidden": confirming the id exists is itself a disclosure.
    expect(await approve(f, id)).toEqual({ ok: false, reason: 'not_found' });
    expect(await balanceOf(other.taxId)).toBe(0);
  });
});

describe('approving twice', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it('does not double-apply on a sequential retry', async () => {
    const { id } = await stage(f, 200_00);
    expect((await approve(f, id)).ok).toBe(true);

    // A dropped response and a re-tap are indistinguishable from the server.
    const again = await approve(f, id, NOW + 10);

    expect(again).toEqual({ ok: false, reason: 'not_pending' });
    expect(await balanceOf(f.taxId)).toBe(200_00);
    expect(await entriesFor(id)).toHaveLength(1);
    // The first decision stands; the retry does not rewrite when it happened.
    expect((await findProposal(env.DB, f.userId, id))?.decided_at).toBe(NOW);
  });

  it('does not double-apply under a CONCURRENT burst', async () => {
    // Ten taps racing each other, none awaited before the next is issued —
    // the shape a flaky connection and an impatient thumb actually produce.
    const { id } = await stage(f, 100_00);
    const results = await Promise.all(Array.from({ length: 10 }, () => approve(f, id)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await entriesFor(id)).toHaveLength(1);
    expect(await balanceOf(f.taxId)).toBe(100_00);
    expect(await balanceOf(f.unallocatedId)).toBe(CASH - 100_00);
  });

  it('cannot be raced past the balance by a burst of DIFFERENT proposals', async () => {
    // Six proposals at $250 against $1,000. Four fit. If the balance guard
    // were a read-then-write the extra two would commit and unallocated would
    // go negative — money allocated that does not exist.
    const staged = await Promise.all(Array.from({ length: 6 }, () => stage(f, 250_00)));
    const results = await Promise.all(staged.map((p) => approve(f, p.id)));

    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(await balanceOf(f.unallocatedId)).toBe(0);
    expect(await balanceOf(f.taxId)).toBe(CASH);
  });
});

describe('every proposal kind commits a legal ledger entry', () => {
  it('maps all six kinds, so adding a seventh cannot silently write NULL', async () => {
    // approveProposal picks the ledger `kind` with a SQL CASE built from the
    // ENTRY_KIND record. A kind added to one and not the other would make that
    // CASE fall through to NULL and the insert would die on NOT NULL — at
    // approve time, in front of the operator. This walks every kind so the
    // gap surfaces here instead.
    const f = await fixture();
    for (const kind of PROPOSAL_KINDS) {
      const { id } = await createProposal(env.DB, {
        userId: f.userId,
        entityId: f.entityId,
        kind,
        fromEnvelopeId: f.unallocatedId,
        toEnvelopeId: f.taxId,
        amountMinor: 10_00,
        now: NOW,
      });
      const result = await approve(f, id);
      expect(result.ok, `${kind} did not commit`).toBe(true);

      const entry = await env.DB.prepare(
        'SELECT kind FROM ledger_entries WHERE idempotency_key = ?',
      )
        .bind(`proposal:${id}`)
        .first<{ kind: string }>();
      expect(['fund', 'move'], `${kind} wrote ${entry?.kind}`).toContain(entry?.kind);
    }

    expect(await balanceOf(f.taxId)).toBe(10_00 * PROPOSAL_KINDS.length);
  });
});

describe('editing a pending proposal', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  const edit = (proposalId: string, amountMinor: number, now = NOW) =>
    editProposal(env.DB, { userId: f.userId, proposalId, amountMinor, now });

  it('changes the amount and moves nothing', async () => {
    const { id } = await stage(f, 900_00);
    expect(await edit(id, 400_00)).toEqual({ ok: true, amountMinor: 400_00 });

    expect((await findProposal(env.DB, f.userId, id))?.amount_minor).toBe(400_00);
    expect(await balanceOf(f.unallocatedId)).toBe(CASH);
    expect(await entriesFor(id)).toHaveLength(0);
  });

  it('is what makes an unaffordable proposal recoverable', async () => {
    // The point of the whole feature: $900 staged, cash falls to $150, and the
    // operator can take the part that fits instead of losing the intent.
    const { id } = await stage(f, 900_00);
    await fund(f, f.vanId, 850_00);
    expect((await approve(f, id)).ok).toBe(false);

    expect((await edit(id, 150_00)).ok).toBe(true);
    expect((await approve(f, id)).ok).toBe(true);
    expect(await balanceOf(f.taxId)).toBe(150_00);
    expect(await balanceOf(f.unallocatedId)).toBe(0);
  });

  it('ALLOWS an amount above the current balance', async () => {
    // Not an oversight. A proposal reserves nothing, and an operator expecting
    // a deposit tomorrow is entitled to stage against it. The only check that
    // decides anything is the one inside approve — which still refuses.
    const { id } = await stage(f, 100_00);
    expect(await edit(id, CASH * 10)).toEqual({ ok: true, amountMinor: CASH * 10 });
    expect(await approve(f, id)).toEqual({ ok: false, reason: 'insufficient_funds' });
    expect(await balanceOf(f.unallocatedId)).toBe(CASH);
  });

  it('refuses an amount that is not positive whole cents', async () => {
    const { id } = await stage(f, 100_00);
    await expect(edit(id, 0)).rejects.toBeInstanceOf(MoneyError);
    await expect(edit(id, -1)).rejects.toBeInstanceOf(MoneyError);
    await expect(edit(id, 10.5)).rejects.toBeInstanceOf(MoneyError);
    expect((await findProposal(env.DB, f.userId, id))?.amount_minor).toBe(100_00);
  });

  it('CANNOT rewrite what the ledger already committed', async () => {
    const { id } = await stage(f, 200_00);
    expect((await approve(f, id)).ok).toBe(true);

    expect(await edit(id, 999_00)).toEqual({ ok: false, reason: 'not_pending' });
    // The entry stands at what was actually approved.
    expect(await balanceOf(f.taxId)).toBe(200_00);
    expect((await entriesFor(id))[0].amount_minor).toBe(200_00);
  });

  it('refuses an elapsed proposal', async () => {
    const { id } = await stage(f, 100_00, { expiresAt: NOW + 60 });
    expect(await edit(id, 50_00, NOW + 61)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a dismissed proposal', async () => {
    const { id } = await stage(f, 100_00);
    await dismissProposal(env.DB, { userId: f.userId, proposalId: id, now: NOW });
    expect(await edit(id, 50_00)).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('refuses ANOTHER user’s proposal', async () => {
    const other = await fixture();
    const { id } = await stage(other, 100_00);
    expect(await edit(id, 50_00)).toEqual({ ok: false, reason: 'not_found' });
    expect((await findProposal(env.DB, other.userId, id))?.amount_minor).toBe(100_00);
  });

  it('treats re-saving the SAME amount as a success, not a refusal', async () => {
    // The UPDATE changes no rows, which is indistinguishable from a refusal at
    // the driver level. Reporting it as a failure would show an error for an
    // operator who simply confirmed the number already there.
    const { id } = await stage(f, 100_00);
    expect(await edit(id, 100_00)).toEqual({ ok: true, amountMinor: 100_00 });
  });
});

describe('conservation', () => {
  it('still holds after an approve — nothing is created or destroyed', async () => {
    const f = await fixture();

    const skim = await createProposal(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      kind: 'tax_skim',
      fromEnvelopeId: f.unallocatedId,
      toEnvelopeId: f.taxId,
      amountMinor: 300_00,
      now: NOW,
    });
    expect((await approve(f, skim.id)).ok).toBe(true);

    // And a named-to-named move, which never touches unallocated at all.
    const shuffle = await createProposal(env.DB, {
      userId: f.userId,
      entityId: f.entityId,
      kind: 'buffer_action',
      fromEnvelopeId: f.taxId,
      toEnvelopeId: f.vanId,
      amountMinor: 120_00,
      now: NOW,
    });
    expect((await approve(f, shuffle.id)).ok).toBe(true);

    expect(await balanceOf(f.taxId)).toBe(180_00);
    expect(await balanceOf(f.vanId)).toBe(120_00);
    expect(await balanceOf(f.unallocatedId)).toBe(CASH - 300_00);

    // The identity that makes this structural rather than maintained: every
    // envelope's balance, summed, is the cash the bank reported.
    const { results } = await env.DB.prepare(
      'SELECT balance_minor FROM envelope_balances WHERE entity_id = ?',
    )
      .bind(f.entityId)
      .all<{ balance_minor: number | null }>();
    const total = (results ?? []).reduce((sum, r) => sum + (r.balance_minor ?? 0), 0);
    expect(total).toBe(CASH);

    // Stated the other way round, through the invariant the app actually
    // reports: every envelope against the one budgetable account.
    const check = checkInvariant(
      [{ balanceMinor: 180_00 }, { balanceMinor: 120_00 }, { balanceMinor: CASH - 300_00 }],
      [{ accountId: 'checking', availableMinor: CASH, budgetable: true }],
    );
    expect(check.status).toBe('balanced');
    expect(check.driftMinor).toBe(0);
    // And the hero number is the residual, not a figure computed some other way.
    expect(safeToSpend(check, CASH - 300_00)).toBe(CASH - 300_00);
  });
});

describe('dismissing and expiring', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it('dismiss closes the proposal and touches no balance', async () => {
    const { id } = await stage(f, 400_00);
    expect(await dismissProposal(env.DB, { userId: f.userId, proposalId: id, now: NOW })).toEqual({
      ok: true,
    });

    expect((await findProposal(env.DB, f.userId, id))?.status).toBe('dismissed');
    expect(await balanceOf(f.unallocatedId)).toBe(CASH);
    expect(await entriesFor(id)).toHaveLength(0);
  });

  it('a dismissed proposal can never be approved afterwards', async () => {
    const { id } = await stage(f, 400_00);
    await dismissProposal(env.DB, { userId: f.userId, proposalId: id, now: NOW });

    expect(await approve(f, id)).toEqual({ ok: false, reason: 'not_pending' });
    expect(await balanceOf(f.taxId)).toBe(0);
  });

  it('dismiss refuses ANOTHER user’s proposal', async () => {
    const other = await fixture();
    const { id } = await stage(other, 100_00);

    expect(await dismissProposal(env.DB, { userId: f.userId, proposalId: id, now: NOW })).toEqual({
      ok: false,
    });
    expect((await findProposal(env.DB, other.userId, id))?.status).toBe('pending');
  });

  it('the expiry sweep is cosmetic — approve already refuses an elapsed one', async () => {
    const stale = await stage(f, 100_00, { expiresAt: NOW - 1 });
    // Refused BEFORE any sweep has run. The sweep only makes the queue read
    // honestly; it is not what enforces the expiry.
    expect(await approve(f, stale.id)).toEqual({ ok: false, reason: 'expired' });

    const { expired } = await expireProposals(env.DB, NOW);
    expect(expired).toBeGreaterThanOrEqual(1);
    expect((await findProposal(env.DB, f.userId, stale.id))?.status).toBe('expired');
  });

  it('the sweep leaves a still-fresh proposal alone', async () => {
    const live = await stage(f, 100_00, { expiresAt: NOW + 3600 });
    const open = await stage(f, 100_00);

    await expireProposals(env.DB, NOW);

    expect((await findProposal(env.DB, f.userId, live.id))?.status).toBe('pending');
    expect((await findProposal(env.DB, f.userId, open.id))?.status).toBe('pending');
  });
});
