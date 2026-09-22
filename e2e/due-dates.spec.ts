/**
 * Obligations: a deadline the app actually tells you about.
 *
 * Before this, `target_date` existed in the schema, was returned by the API,
 * was carried all the way into the tile model — and was rendered nowhere.
 * `duePhrase` was exported with zero call sites. An operator could have a bill
 * with a date in the database and the app would never once mention it.
 *
 * Seeded relative to the real clock, so "due in 12 days" means twelve days
 * forever rather than drifting into the past as the seed ages.
 */

import { test, expect } from './fixtures';

test('a deadline reaches the Canvas, alongside how full the envelope is', async ({ app }) => {
  const rack = app.locator('.tile', { hasText: 'Alignment rack' });
  await expect(rack).toBeVisible();
  // Two facts, one line. The exact arithmetic is pinned by the unit suite with
  // an injected clock; what is proved HERE is that it reaches the screen.
  await expect(rack).toContainText('37% of $7,500');
  await expect(rack).toContainText(/due in \d+ days/);
});

test('progress stays percentage-of-target, never a shortfall', async ({ app }) => {
  // §14. Same arithmetic, opposite emotional register — and the shortfall
  // framing is the one that makes people stop opening the app.
  const captions = await app.evaluate(() =>
    [...document.querySelectorAll('.tile')].map((t) => t.textContent ?? ''),
  );
  expect(captions.join(' ')).not.toMatch(/short by|behind by|you need|you're late|overdue by/i);
});

test('an envelope with no date says nothing about one', async ({ app }) => {
  // Buffer is seeded without a deadline. A tile inventing "due —" or an empty
  // separator would be noise on the surface an operator scans.
  const buffer = app.locator('.tile', { hasText: 'Buffer' });
  await expect(buffer).toContainText('38% of $12,000');
  await expect(buffer).not.toContainText('due');
});

test('a due date can be set with ONE TAP and no typing (§13)', async ({ app }) => {
  await app.evaluate(() => document.querySelector('.scroll')!.scrollTo(0, 99_999));
  await app.getByRole('button', { name: '+ New envelope' }).click();

  await app.fill('#new-env-name', 'Franchise tax');
  await app.getByRole('radio', { name: 'Tax' }).click();
  await app.fill('#new-env-target', '1200');

  // The chip, not the date field. §13: "one-tap relative chips... never
  // date-typing."
  await app.getByRole('button', { name: 'End of next month' }).click();
  // Read back in the words the tile will use, BEFORE committing.
  await expect(app.locator('.sheet-note')).toContainText(/Shows as "due in \d+ days"/);

  await app.getByRole('button', { name: 'Create it' }).click();

  const tile = app.locator('.tile', { hasText: 'Franchise tax' });
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('0% of $1,200');
  await expect(tile).toContainText(/due in \d+ days/);
});

test('tapping the chosen chip again clears it', async ({ app }) => {
  // Otherwise the only way to undo a mis-tap is to clear a date field by hand,
  // which is exactly the typing the chips exist to avoid.
  await app.evaluate(() => document.querySelector('.scroll')!.scrollTo(0, 99_999));
  await app.getByRole('button', { name: '+ New envelope' }).click();

  const chip = app.getByRole('button', { name: 'In 30 days' });
  await chip.click();
  await expect(app.locator('#new-env-due')).not.toHaveValue('');
  await chip.click();
  await expect(app.locator('#new-env-due')).toHaveValue('');
  await expect(app.locator('.sheet-note')).toHaveText('');
});

test('an envelope can still be created with no deadline at all', async ({ app }) => {
  await app.evaluate(() => document.querySelector('.scroll')!.scrollTo(0, 99_999));
  await app.getByRole('button', { name: '+ New envelope' }).click();
  await app.fill('#new-env-name', 'Shop rags');
  await app.getByRole('button', { name: 'Create it' }).click();

  const tile = app.locator('.tile', { hasText: 'Shop rags' });
  await expect(tile).toBeVisible();
  await expect(tile).not.toContainText('due');
});

test('the new-envelope sheet traps focus, because aria-modal says the page is gone', async ({
  app,
}) => {
  // It declared aria-modal="true" and had NO containment at all: Tab walked
  // straight out into a Canvas assistive technology had been told was
  // unavailable. Third sheet in the app, third time — which is why the trap is
  // now one shared implementation.
  await app.evaluate(() => document.querySelector('.scroll')!.scrollTo(0, 99_999));
  await app.getByRole('button', { name: '+ New envelope' }).click();
  await expect(app.locator('.sheet')).toBeVisible();

  const inSheet = () =>
    app.evaluate(() => document.querySelector('.sheet')!.contains(document.activeElement));

  for (let i = 0; i < 16; i++) await app.keyboard.press('Tab');
  expect(await inSheet(), 'Tab escaped the dialog').toBe(true);

  for (let i = 0; i < 20; i++) await app.keyboard.press('Shift+Tab');
  expect(await inSheet(), 'Shift+Tab escaped the dialog').toBe(true);

  await app.keyboard.press('Escape');
  await expect(app.locator('.sheet')).toHaveCount(0);
});

test('a sheet taller than the phone scrolls, and its primary action is reachable', async ({
  app,
}) => {
  // Adding the due-date row made this sheet taller than an iPhone viewport.
  // The CSS caps it at 88svh and scrolls it internally — a deliberate choice,
  // but one nothing had ever verified. The Now-Bar was "capped and scrollable"
  // in theory too, and rendered several hundred pixels below the fold in every
  // build for the life of the project.
  await app.evaluate(() => document.querySelector('.scroll')!.scrollTo(0, 99_999));
  await app.getByRole('button', { name: '+ New envelope' }).click();
  await expect(app.locator('.sheet')).toBeVisible();

  const box = await app.evaluate(() => {
    const sheet = document.querySelector('.sheet')!;
    return {
      scrolls: sheet.scrollHeight > sheet.clientHeight,
      withinViewport: sheet.getBoundingClientRect().height <= window.innerHeight + 1,
    };
  });
  // Capped, so it cannot run off the bottom of the screen...
  expect(box.withinViewport, 'the sheet is taller than the viewport').toBe(true);
  // ...and genuinely a scrollport, not content silently clipped.
  expect(box.scrolls, 'the sheet is capped but does not scroll').toBe(true);

  // And the button that commits is reachable by that scroll.
  await app.evaluate(() => document.querySelector('.sheet')!.scrollTo(0, 99_999));
  await expect(app.getByRole('button', { name: 'Create it' })).toBeInViewport({ ratio: 1 });
});
