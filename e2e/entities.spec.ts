/**
 * Entities never commingle (Blueprint §3) — proved in a browser.
 *
 * This is the claim the whole app is built around: the Praeclarus entities are
 * separate businesses with separate books, and money labelled in one must
 * never appear under another. The money model enforces it structurally — the
 * composite foreign keys make a cross-entity entry unrepresentable — and the
 * unit suite proves that.
 *
 * What the unit suite CANNOT prove is that the screen obeys it. A view holding
 * the previous entity's figures, a queue that does not clear on a switch, a
 * pill still counting the other entity's proposals: every one of those shows
 * an operator one LLC's money under another LLC's name, with a database that
 * is perfectly correct underneath.
 *
 * Seeded:
 *   Concierge Car Repair DFW   $18,420 cash · $1,520 free · 2 pending
 *   Praeclarus Holdings LLC     $4,000 cash · $2,500 free · 1 pending
 *
 * BOTH have an envelope called "Tax", deliberately. A leaked tile is invisible
 * when every name is unique, and glaring when one is not.
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const SHOP = 'Concierge Car Repair DFW';
const HOLDINGS = 'Praeclarus Holdings LLC';

/** Switch via the Accounts screen, which is the only way to do it in the UI. */
async function switchTo(app: Page, name: string) {
  await app.click('.nowbar .nb[data-key="accounts"]');
  await app.getByRole('button', { name: new RegExp(name) }).click();
  await expect(app.locator('.canvas')).toBeVisible();
}

test('the Canvas opens on the first entity, with only its envelopes', async ({ app }) => {
  await expect(app.locator('.safe-figure')).toHaveText('$1,520');
  // Named in only one entity, so its presence is proof of which books are open.
  await expect(app.locator('.tile', { hasText: 'Alignment rack' })).toBeVisible();
  await expect(app.locator('.tile', { hasText: 'Distributions' })).toHaveCount(0);
  // "Tax" exists in BOTH. Exactly one tile, or the two sets have been merged.
  await expect(app.locator('.tile', { hasText: 'Tax' })).toHaveCount(1);
  await expect(app.locator('.tile', { hasText: 'Tax' })).toContainText('$6,200');
});

test('both entities are listed and both are selectable', async ({ app }) => {
  await app.click('.nowbar .nb[data-key="accounts"]');
  // Every entity SELECTABLE when there is more than one. The Canvas was once
  // hard-wired to entities[0], so the other LLCs were listed as text the
  // operator could never open — in an app whose premise is keeping them apart.
  await expect(app.getByRole('button', { name: new RegExp(SHOP) })).toBeVisible();
  await expect(app.getByRole('button', { name: new RegExp(HOLDINGS) })).toBeVisible();
});

test('switching entities replaces every figure on the Canvas', async ({ app }) => {
  await switchTo(app, HOLDINGS);

  await expect(app.locator('.safe-figure')).toHaveText('$2,500');
  await expect(app.locator('.tile', { hasText: 'Distributions' })).toBeVisible();
  // The other entity's envelopes are GONE, not merely further down.
  await expect(app.locator('.tile', { hasText: 'Alignment rack' })).toHaveCount(0);
  await expect(app.locator('.tile', { hasText: 'Buffer' })).toHaveCount(0);
  await expect(app.locator('.tile', { hasText: 'Q1 insurance' })).toHaveCount(0);

  // And the shared name resolves to THIS entity's figure, not the other's.
  await expect(app.locator('.tile', { hasText: 'Tax' })).toHaveCount(1);
  await expect(app.locator('.tile', { hasText: 'Tax' })).toContainText('$1,000');
});

test('the queue switches with it, and never shows the other entity’s work', async ({ app }) => {
  await app.click('.nowbar .nb[data-key="needs"]');
  await expect(app.locator('.proposal')).toHaveCount(2);
  await expect(app.getByText('Deposit landed Friday')).toBeVisible();

  await switchTo(app, HOLDINGS);
  await app.click('.nowbar .nb[data-key="needs"]');

  await expect(app.locator('.proposal')).toHaveCount(1);
  await expect(app.getByText('Quarterly estimate')).toBeVisible();
  // The repair shop's proposals are not merely below the fold.
  await expect(app.getByText('Deposit landed Friday')).toHaveCount(0);
  await expect(app.locator('.proposal', { hasText: 'Waterfall' })).toHaveCount(0);
});

test('the Now-Bar pill counts THIS entity’s queue', async ({ app }) => {
  // A pill that does not change on a switch is the same leak wearing a
  // different hat — and it is visible from every screen.
  await expect(app.locator('.nowbar')).toContainText('2 need you');
  await switchTo(app, HOLDINGS);
  await expect(app.locator('.nowbar')).toContainText('1 needs you');
});

test('approving in one entity leaves the other untouched', async ({ app }) => {
  await switchTo(app, HOLDINGS);
  await app.click('.nowbar .nb[data-key="needs"]');
  await app
    .locator('.proposal', { hasText: 'Tax set-aside' })
    .getByRole('button', { name: /^Approve/ })
    .click();
  await expect(app.locator('.proposal')).toHaveCount(0);

  // Holdings moved: $1,000 + $310, residual $2,500 − $310.
  await app.click('.nowbar .nb[data-key="canvas"]');
  await expect(app.locator('.tile', { hasText: 'Tax' })).toContainText('$1,310');
  await expect(app.locator('.safe-figure')).toHaveText('$2,190');

  // The repair shop did not. Same envelope name, entirely separate books.
  await switchTo(app, SHOP);
  await expect(app.locator('.safe-figure')).toHaveText('$1,520');
  await expect(app.locator('.tile', { hasText: 'Tax' })).toContainText('$6,200');
  await app.click('.nowbar .nb[data-key="needs"]');
  await expect(app.locator('.proposal')).toHaveCount(2);
});

test('funding in one entity leaves the other untouched', async ({ app }) => {
  await switchTo(app, HOLDINGS);
  await app.locator('.tile', { hasText: 'Distributions' }).click();
  await app.fill('#fund-amount', '500');
  await app.click('.btn-primary');
  await expect(app.locator('.sheet')).toHaveCount(0);
  await expect(app.locator('.safe-figure')).toHaveText('$2,000');

  await switchTo(app, SHOP);
  await expect(app.locator('.safe-figure')).toHaveText('$1,520');
});

test('an entity switch never leaves the previous entity’s figures on screen', async ({ app }) => {
  // The failure this guards is a render between the switch and the fetch: the
  // heading says Holdings while the numbers are still the repair shop's. In a
  // multi-entity app that is not a flicker, it is the wrong LLC's money shown
  // under the right LLC's name.
  await app.click('.nowbar .nb[data-key="accounts"]');
  await app.getByRole('button', { name: new RegExp(HOLDINGS) }).click();

  // Sampled repeatedly while the switch settles rather than once at the end.
  for (let i = 0; i < 12; i++) {
    const figure = await app.locator('.safe-figure').textContent();
    expect(figure, 'the previous entity’s residual was on screen mid-switch').not.toBe('$1,520');
    await app.waitForTimeout(40);
  }
  await expect(app.locator('.safe-figure')).toHaveText('$2,500');
});
