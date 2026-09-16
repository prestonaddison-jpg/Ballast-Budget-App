/**
 * The things an operator actually does, end to end, through the real Worker.
 *
 * The unit suite proves the ledger is correct. These prove the app can reach
 * it — which is a different claim, and the one that was false: `envelopeApi
 * .create` had zero call sites for the life of Slice 1, so the money model was
 * unreachable from the only interface meant to reach it.
 */

import { test, expect } from './fixtures';

test('the hero shows the residual, and it is not a placeholder', async ({ app }) => {
  const figure = app.locator('.safe-figure');
  await expect(figure).toBeVisible();
  // Seeded: $18,420 available, $16,900 spoken for.
  await expect(figure).toHaveText('$1,520');
});

test('every Now-Bar destination goes somewhere', async ({ app }) => {
  // All four were rendered as live buttons wired to nothing.
  for (const [key, expected] of [
    ['needs', 'Needs you'],
    ['accounts', 'Entities'],
    ['settings', 'Appearance'],
  ] as const) {
    await app.click(`.nowbar .nb[data-key="${key}"]`);
    await expect(app.getByText(expected, { exact: false }).first()).toBeVisible();
  }
  await app.click('.nowbar .nb[data-key="canvas"]');
  await expect(app.locator('.canvas')).toBeVisible();
});

test('funding an envelope moves money and the residual falls by the same amount', async ({
  app,
}) => {
  await app.locator('.tile', { hasText: 'Alignment rack' }).click();
  await expect(app.locator('.sheet')).toBeVisible();

  await app.fill('#fund-amount', '120');
  await app.click('.btn-primary');

  await expect(app.locator('.sheet')).toHaveCount(0);
  // $2,800 + $120, and $1,520 − $120. Conservation, visible on screen.
  await expect(app.locator('.tile', { hasText: 'Alignment rack' })).toContainText('$2,920');
  await expect(app.locator('.safe-figure')).toHaveText('$1,400');
});

test('overdrawing is refused with a reason, not a crash', async ({ app }) => {
  await app.locator('.tile', { hasText: 'Buffer' }).click();
  await app.fill('#fund-amount', '999999');
  await app.click('.btn-primary');

  await expect(app.locator('.sheet-message')).toContainText('unallocated');
  // Nothing moved, and the sheet stays open so the amount can be corrected.
  await expect(app.locator('.sheet')).toBeVisible();
});

test('an amount with more precision than money has is refused, not rounded', async ({ app }) => {
  await app.locator('.tile', { hasText: 'Buffer' }).click();
  await app.fill('#fund-amount', '10.005');
  // The confirm button disables on an unparseable amount rather than silently
  // rounding the operator's money for them.
  await expect(app.locator('.btn-primary')).toBeDisabled();
});

test('an envelope can be created from the UI', async ({ app }) => {
  await app.evaluate(() => document.querySelector('.scroll')!.scrollTo(0, 99_999));
  await app.getByRole('button', { name: '+ New envelope' }).click();

  await app.fill('#new-env-name', 'Bay 3 lift');
  await app.getByRole('radio', { name: 'Save' }).click();
  await app.fill('#new-env-target', '5000');
  await app.getByRole('button', { name: 'Create it' }).click();

  await expect(app.locator('.tile', { hasText: 'Bay 3 lift' })).toBeVisible();
  await expect(app.locator('.tile', { hasText: 'Bay 3 lift' })).toContainText('0% of $5,000');
});

test('completing an envelope sweeps its balance back to unallocated', async ({ app }) => {
  const before = await app.locator('.safe-figure').textContent();

  await app.locator('.tile', { hasText: 'Q1 insurance' }).click();
  await app.getByRole('button', { name: 'Mark complete' }).click();
  // Armed by a second tap: the envelope leaves the Canvas, and that should not
  // happen on one stray press.
  await app.getByRole('button', { name: /Sweep it back/ }).click();

  await expect(app.locator('.tile', { hasText: 'Q1 insurance' })).toHaveCount(0);
  await expect(app.locator('.safe-figure')).not.toHaveText(before!);
});

test('unallocated is not a control — it is the source, never a destination', async ({ app }) => {
  const tile = app.locator('.tile', { hasText: 'Unallocated' });
  await expect(tile).toBeVisible();
  // Rendered as a plain element, not a disabled button: a disabled button dims
  // the most important tile on the screen and reads as "unavailable" to a
  // screen reader, when it is simply not something you tap.
  expect(await tile.evaluate((el) => el.tagName)).toBe('DIV');
});

test('signing out returns to the sign-in screen', async ({ app }) => {
  await app.click('.nowbar .nb[data-key="settings"]');
  await app.getByRole('button', { name: 'Sign out' }).click();
  await expect(app.locator('#email')).toBeVisible();
});
