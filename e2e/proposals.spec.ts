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

  // NOT "Nothing needs you", and this assertion changed deliberately when
  // obligations landed. The QUEUE is empty, but the seeded Alignment rack is
  // 37% funded and due inside the window, so all-clear would be false. The
  // pill falls through to the next true thing rather than to silence.
  await expect(app.locator('.proposal')).toHaveCount(0);
  await expect(app.locator('.nowbar')).not.toContainText('Nothing needs you');
  await expect(app.locator('.nowbar')).toContainText('Something is due');
});

test.describe('when the queue cannot be loaded', () => {
  /**
   * SERVICE WORKERS OFF FOR THESE TESTS ONLY, and the reason is not cosmetic.
   *
   * Ballast's service worker calls `clients.claim()`, so after the first load
   * it controls the page. Playwright does NOT intercept requests that pass
   * through a controlling service worker in WebKit — only in Chromium. So
   * `route.abort()` silently did nothing here: the request went to the network,
   * the queue loaded, and the pill read "2 need you".
   *
   * That is exactly the shape of failure this repo keeps paying for — green in
   * the engine that is convenient, broken in the one that ships. Ballast runs
   * on the iOS Home Screen, so WebKit IS the target, and a fault-injection
   * mechanism that only works in Chromium is not a test.
   *
   * Blocking the worker takes it out of the request path in both engines. It
   * is sound here because the service worker is not what is under test, and it
   * never touches /api/ anyway — `isNeverCacheable` passes every API request
   * straight through without `respondWith`, so the app's behaviour with the
   * worker blocked is the same behaviour, minus the interception blind spot.
   */
  test.use({ serviceWorkers: 'block' });

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

  test('the abort actually aborts — the mechanism itself is asserted', async ({ app }) => {
    // The bug above was NOT a wrong expectation: it was fault injection that
    // did nothing while the assertion quietly measured a healthy app. So the
    // interception is now verified directly, and this test fails loudly in any
    // engine where route() stops reaching the request.
    let intercepted = 0;
    await app.route('**/api/entities/*/proposals', (route) => {
      intercepted += 1;
      return route.abort('failed');
    });
    await app.reload();
    await expect(app.locator('.canvas')).toBeVisible();
    expect(intercepted, 'route() never saw the queue request').toBeGreaterThan(0);
  });
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

test.describe('changing the amount before deciding', () => {
  test('turns a proposal that no longer fits into one that does', async ({ app }) => {
    // The dead end this feature exists to remove: $2,400 against $1,520 free,
    // where declining something the operator wants was previously the only
    // move available to them.
    const card = app.locator('.proposal', { hasText: 'Waterfall' });
    await card.getByRole('button', { name: /^Change the amount/ }).click();
    await expect(app.locator('.sheet')).toBeVisible();

    // The field opens on the current amount, not empty — the common edit is a
    // different number, not a number typed from scratch.
    await expect(app.locator('#edit-amount')).toHaveValue('2400.00');

    await app.getByRole('button', { name: /^All that fits/ }).click();
    await app.getByRole('button', { name: 'Save amount' }).click();

    await expect(app.locator('.sheet')).toHaveCount(0);
    await expect(card).toContainText('$1,520');
    await expect(card).toHaveAttribute('data-affordability', 'fits');
    await expect(card.getByRole('button', { name: /^Approve/ })).toBeVisible();
  });

  test('saving an amount moves no money', async ({ app }) => {
    await app
      .locator('.proposal', { hasText: 'Income landed' })
      .getByRole('button', { name: /^Change the amount/ })
      .click();
    await app.fill('#edit-amount', '75');
    await app.getByRole('button', { name: 'Save amount' }).click();
    await expect(app.locator('.sheet')).toHaveCount(0);

    await app.click('.nowbar .nb[data-key="canvas"]');
    // Untouched: a proposal is a suggestion right up to the moment it is
    // approved, and this screen says so out loud.
    await expect(app.locator('.safe-figure')).toHaveText('$1,520');
    await expect(app.locator('.tile', { hasText: 'Tax' })).toContainText('$6,200');
  });

  test('accepts an amount larger than the balance, and approve still refuses it', async ({
    app,
  }) => {
    // Deliberate: a proposal reserves nothing, and an operator expecting a
    // deposit tomorrow is entitled to stage against it. The refusal belongs to
    // approve, which checks the live balance, not to the edit.
    const card = app.locator('.proposal', { hasText: 'Income landed' });
    await card.getByRole('button', { name: /^Change the amount/ }).click();
    await app.fill('#edit-amount', '9000');
    await app.getByRole('button', { name: 'Save amount' }).click();

    await expect(card).toContainText('$9,000');
    await expect(card).toHaveAttribute('data-affordability', 'short');
    await expect(card.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  });

  test('an amount with more precision than money has is refused, not rounded', async ({ app }) => {
    await app
      .locator('.proposal', { hasText: 'Income landed' })
      .getByRole('button', { name: /^Change the amount/ })
      .click();
    await app.fill('#edit-amount', '10.005');
    await expect(app.getByRole('button', { name: 'Save amount' })).toBeDisabled();
  });

  test('the sheet traps focus and Escape closes it', async ({ app }) => {
    await app
      .locator('.proposal', { hasText: 'Income landed' })
      .getByRole('button', { name: /^Change the amount/ })
      .click();

    const inSheet = () =>
      app.evaluate(() => document.querySelector('.sheet')!.contains(document.activeElement));
    for (let i = 0; i < 12; i++) await app.keyboard.press('Tab');
    expect(await inSheet(), 'Tab escaped the dialog').toBe(true);

    await app.keyboard.press('Escape');
    await expect(app.locator('.sheet')).toHaveCount(0);
  });
});

test.describe('controls look like controls', () => {
  test('every quick-amount chip has a visible boundary (WCAG 1.4.11)', async ({ app }) => {
    // `--ctrlln` was referenced by the chips and the money input and DEFINED
    // NOWHERE. An undefined custom property invalidates the whole `border`
    // shorthand, so it computed to `none` and four tappable controls rendered
    // as floating text — in every build, in both themes, while the contrast
    // test passed because it only ever looked at .btn-primary.
    await app
      .locator('.proposal', { hasText: 'Waterfall' })
      .getByRole('button', { name: /^Change the amount/ })
      .click();
    await expect(app.locator('.sheet')).toBeVisible();

    const edgeless = await app.evaluate(() =>
      [...document.querySelectorAll('.sheet .chip, .sheet .sheet-input')]
        .map((el) => {
          const s = getComputedStyle(el);
          return {
            label: (el.textContent || (el as HTMLInputElement).id || '?').trim().slice(0, 24),
            style: s.borderTopStyle,
            width: parseFloat(s.borderTopWidth),
            colour: s.borderTopColor,
          };
        })
        .filter((b) => b.style === 'none' || !(b.width > 0) || b.colour === 'rgba(0, 0, 0, 0)'),
    );
    expect(edgeless, 'controls with no visible edge').toEqual([]);
  });

  test('the chip boundary actually meets 3:1 against the sheet', async ({ app }) => {
    // A border that exists but is invisible is the same defect with extra
    // steps, so the ratio is asserted rather than the declaration.
    await app
      .locator('.proposal', { hasText: 'Waterfall' })
      .getByRole('button', { name: /^Change the amount/ })
      .click();
    const ratio = await contrast(
      app,
      '.sheet .chip',
      'borderTopColor',
      '.sheet',
      'backgroundColor',
    );
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});
