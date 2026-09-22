/**
 * The Needs You queue, in a real browser, against the real Worker.
 *
 * The unit suite proves approveProposal commits against the live balance. What
 * is proved here is that a person can get to it: that the queue is on screen,
 * that the button that commits money is reachable and legible, and — the one
 * that matters most — that a proposal the balance no longer covers does NOT
 * render an Approve button at all.
 *
 * Seeded: $18,420 available, $16,900 spoken for, $1,520 free, and two pending
 * proposals — $480 to Tax (fits) and $2,400 to Buffer (does not).
 */

import { test, expect, contrast } from './fixtures';

test.beforeEach(async ({ app }) => {
  await app.click('.nowbar .nb[data-key="needs"]');
  await expect(app.locator('.proposal').first()).toBeVisible();
});

test('the queue shows what was staged, in the operator’s terms', async ({ app }) => {
  const cards = app.locator('.proposal');
  await expect(cards).toHaveCount(2);

  const income = cards.filter({ hasText: 'Income landed' });
  await expect(income).toContainText('$480');
  await expect(income).toContainText('Unallocated → Tax');
  await expect(income).toContainText('Deposit landed Friday');
});

test('a proposal the balance no longer covers offers NO Approve button', async ({ app }) => {
  // The rule, on screen: a control the server is going to refuse is worse than
  // no control, because it fails after the operator has committed to it.
  const waterfall = app.locator('.proposal', { hasText: 'Waterfall' });
  await expect(waterfall).toHaveAttribute('data-affordability', 'short');
  await expect(waterfall.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  // And it says why, rather than leaving a hole where a button was.
  await expect(waterfall).toContainText('$1,520');
  await expect(waterfall).toContainText('no longer fits');
  // Declining is never blocked by the balance.
  await expect(waterfall.getByRole('button', { name: /^Dismiss/ })).toBeVisible();
});

test('approving moves the money, and both figures agree afterwards', async ({ app }) => {
  await app
    .locator('.proposal', { hasText: 'Income landed' })
    .getByRole('button', {
      name: /^Approve/,
    })
    .click();

  // The queue loses it...
  await expect(app.locator('.proposal', { hasText: 'Income landed' })).toHaveCount(0);
  await expect(app.locator('.proposal')).toHaveCount(1);

  // ...and the Canvas shows the money where it went. $6,200 + $480, and the
  // residual $1,520 − $480. Conservation, visible on two screens.
  await app.click('.nowbar .nb[data-key="canvas"]');
  await expect(app.locator('.tile', { hasText: 'Tax' })).toContainText('$6,680');
  await expect(app.locator('.safe-figure')).toHaveText('$1,040');
});

test('dismissing removes it and moves nothing', async ({ app }) => {
  await app
    .locator('.proposal', { hasText: 'Waterfall' })
    .getByRole('button', {
      name: /^Dismiss/,
    })
    .click();

  await expect(app.locator('.proposal', { hasText: 'Waterfall' })).toHaveCount(0);

  await app.click('.nowbar .nb[data-key="canvas"]');
  await expect(app.locator('.safe-figure')).toHaveText('$1,520');
  await expect(app.locator('.tile', { hasText: 'Buffer' })).toContainText('$4,500');
});

test('the Now-Bar pill counts the queue, and keeps counting it down', async ({ app }) => {
  // A pill that disagrees with the screen under it teaches the operator that
  // the pill is decoration.
  await expect(app.locator('.nowbar')).toContainText('2 need you');

  await app
    .locator('.proposal', { hasText: 'Waterfall' })
    .getByRole('button', {
      name: /^Dismiss/,
    })
    .click();
  await expect(app.locator('.nowbar')).toContainText('1 needs you');

  await app
    .locator('.proposal', { hasText: 'Income landed' })
    .getByRole('button', {
      name: /^Approve/,
    })
    .click();
  await expect(app.locator('.nowbar')).toContainText('Nothing needs you');
});

test('the queue never claims all-clear when it could not be loaded', async ({ app }) => {
  // "Nothing needs you" is a CLAIM. Making it out of a request that failed is
  // the same lie as a fabricated balance, and it is the exact defect the
  // three-state money model was introduced to kill.
  await app.route('**/api/entities/*/proposals', (route) => route.abort('failed'));
  // Navigation between views repaints from state; only a boot refetches.
  await app.reload();
  await expect(app.locator('.canvas')).toBeVisible();

  // The pill is the claim that is visible from every screen, so it is the one
  // that must not say all-clear.
  await expect(app.locator('.nowbar')).not.toContainText('Nothing needs you');
  await expect(app.locator('.nowbar')).toContainText("Couldn't load the queue");

  await app.click('.nowbar .nb[data-key="needs"]');
  await expect(app.getByText("Couldn't load what needs you")).toBeVisible();
  // And no empty queue pretending to be an empty queue.
  await expect(app.locator('.proposal')).toHaveCount(0);
});

test('the screen has exactly one heading, and it says where you are', async ({ app }) => {
  // The Canvas's h1 is its hero figure. This screen had no heading element at
  // all, which leaves a screen-reader user with no landmark to orient on.
  const headings = app.locator('main h1');
  await expect(headings).toHaveCount(1);
  await expect(headings).toHaveText('2 need you');
});

test('the Needs You screen obeys the shell rules too', async ({ app }) => {
  // Every layout assertion in layout.spec.ts is made on the Canvas. The
  // Now-Bar was missing on EVERY screen, and a check that only ever looks at
  // one of them would have missed it on the other three.
  await expect(app.locator('.nowbar')).toBeInViewport({ ratio: 1 });

  const small = await app.evaluate(() =>
    [...document.querySelectorAll('button, a[href], input')]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => ({
        label: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30),
        height: el.getBoundingClientRect().height,
      }))
      .filter((b) => b.height > 0 && b.height < 44),
  );
  expect(small, 'controls below the 44px minimum').toEqual([]);

  const overflows = await app.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflows).toBe(false);
});

test('Approve is distinguishable from the card it sits on (WCAG 1.4.11)', async ({ app }) => {
  // The same check the fund sheet gets, on the other control that commits
  // money. In Graphite a navy fill on a near-navy surface is about 1.2:1 and
  // the button shape effectively disappears.
  const fill = await contrast(
    app,
    '.proposal .btn-primary',
    'backgroundColor',
    '.proposal',
    'backgroundColor',
  );
  const edge = await contrast(
    app,
    '.proposal .btn-primary',
    'borderTopColor',
    '.proposal',
    'backgroundColor',
  );
  expect(Math.max(fill, edge)).toBeGreaterThanOrEqual(3);
});
