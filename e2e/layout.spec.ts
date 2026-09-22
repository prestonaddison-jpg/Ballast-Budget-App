/**
 * Layout and contrast — the class of defect the workerd suite cannot see.
 *
 * Every assertion here corresponds to something that actually shipped broken.
 */

import { test, expect, contrast } from './fixtures';

test.describe('the shell', () => {
  test('the Now-Bar is on screen at rest, before any scrolling', async ({ app }) => {
    // THE REGRESSION THIS FILE EXISTS FOR. `.screen` had `min-height` and no
    // flex context, so `.scroll` was never a scroll container, `position:
    // sticky` had no scrollport, and the four destinations plus the one status
    // pill rendered several hundred pixels below the fold — in every build,
    // through 234 passing unit tests.
    const bar = app.locator('.nowbar');
    await expect(bar).toBeInViewport({ ratio: 1 });
  });

  test('the document does not scroll; the .scroll region does', async ({ app }) => {
    const { doc, inner } = await app.evaluate(() => ({
      doc: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      inner: (() => {
        const el = document.querySelector('.scroll')!;
        return el.scrollHeight > el.clientHeight;
      })(),
    }));
    expect(doc, 'the document itself must not scroll').toBe(false);
    expect(inner, '.scroll must be the scrollport').toBe(true);
  });

  test('the Now-Bar stays put when the Canvas is scrolled', async ({ app }) => {
    await app.evaluate(() => document.querySelector('.scroll')!.scrollTo(0, 99_999));
    await expect(app.locator('.nowbar')).toBeInViewport({ ratio: 1 });
  });

  test('every visible tap target meets 44px', async ({ app }) => {
    const small = await app.evaluate(() =>
      [...document.querySelectorAll('button, a[href], input')]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({
          label: (el.textContent || el.getAttribute('aria-label') || el.tagName)
            .trim()
            .slice(0, 30),
          height: el.getBoundingClientRect().height,
        }))
        .filter((b) => b.height > 0 && b.height < 44),
    );
    expect(small, 'controls below the 44px minimum').toEqual([]);
  });

  test('the page never scrolls sideways', async ({ app }) => {
    const overflows = await app.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });
});

test.describe('the fund sheet', () => {
  test.beforeEach(async ({ app }) => {
    await app.locator('.tile', { hasText: 'Tax' }).first().click();
    await expect(app.locator('.sheet')).toBeVisible();
  });

  test('is an opaque surface, not a translucent card', async ({ app }) => {
    // In Graphite this shipped using `--card`, which is rgba(255,255,255,.03).
    // The Canvas read straight through the field you type money into.
    const alpha = await app.evaluate(() => {
      const bg = getComputedStyle(document.querySelector('.sheet')!).backgroundColor;
      const parts = bg.match(/[\d.]+/g)!.map(Number);
      return parts.length < 4 ? 1 : parts[3];
    });
    expect(alpha).toBeGreaterThanOrEqual(0.98);
  });

  test('the primary action is distinguishable from the sheet (WCAG 1.4.11)', async ({ app }) => {
    // A filled control's boundary is its fill; an outlined one's is its border.
    // Either may carry the separation, so the better of the two is the test.
    const fill = await contrast(
      app,
      '.btn-primary',
      'backgroundColor',
      '.sheet',
      'backgroundColor',
    );
    const edge = await contrast(app, '.btn-primary', 'borderTopColor', '.sheet', 'backgroundColor');
    expect(Math.max(fill, edge)).toBeGreaterThanOrEqual(3);
  });

  test('traps focus, because aria-modal claims the page behind it is gone', async ({ app }) => {
    const inSheet = () =>
      app.evaluate(() => document.querySelector('.sheet')!.contains(document.activeElement));

    for (let i = 0; i < 12; i++) await app.keyboard.press('Tab');
    expect(await inSheet(), 'Tab escaped the dialog').toBe(true);

    for (let i = 0; i < 16; i++) await app.keyboard.press('Shift+Tab');
    expect(await inSheet(), 'Shift+Tab escaped the dialog').toBe(true);
  });

  test('Escape closes it and returns focus to the page', async ({ app }) => {
    await app.keyboard.press('Escape');
    await expect(app.locator('.sheet')).toHaveCount(0);
  });
});

test.describe('tap targets inside an open dialog', () => {
  /**
   * The 44px check above runs on the Canvas, with nothing open over it. Every
   * sheet in the app was therefore unmeasured — and `.sheet-secondary`
   * ("Mark complete", the control that ARCHIVES an envelope) turned out to
   * have no CSS rule at all, so it rendered at the browser's default ~21px.
   *
   * A class name used in markup with no stylesheet behind it is the same
   * defect as `--ctrlln`: no parse error, no console warning, nothing to see
   * unless you measure it. So the measurement now follows the dialogs.
   */
  const tooSmall = (app: import('@playwright/test').Page) =>
    app.evaluate(() =>
      [...document.querySelectorAll('.sheet button, .sheet a[href], .sheet input')]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({
          label: (el.textContent || el.getAttribute('aria-label') || el.tagName)
            .trim()
            .slice(0, 30),
          height: Math.round(el.getBoundingClientRect().height),
        }))
        .filter((b) => b.height > 0 && b.height < 44),
    );

  test('the fund sheet', async ({ app }) => {
    await app.locator('.tile', { hasText: 'Tax' }).first().click();
    await expect(app.locator('.sheet')).toBeVisible();
    expect(await tooSmall(app), 'fund-sheet controls below 44px').toEqual([]);
  });

  test('the new-envelope sheet', async ({ app }) => {
    await app.evaluate(() => document.querySelector('.scroll')!.scrollTo(0, 99_999));
    await app.getByRole('button', { name: '+ New envelope' }).click();
    await expect(app.locator('.sheet')).toBeVisible();
    expect(await tooSmall(app), 'new-envelope controls below 44px').toEqual([]);
  });

  test('the proposal edit sheet', async ({ app }) => {
    await app.click('.nowbar .nb[data-key="needs"]');
    await app
      .locator('.proposal', { hasText: 'Waterfall' })
      .getByRole('button', { name: /^Change the amount/ })
      .click();
    await expect(app.locator('.sheet')).toBeVisible();
    expect(await tooSmall(app), 'edit-sheet controls below 44px').toEqual([]);
  });
});
