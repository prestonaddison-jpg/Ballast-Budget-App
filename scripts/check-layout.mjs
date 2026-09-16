/**
 * Layout assertions against the RUNNING app, in a real browser at iPhone size.
 *
 * These exist because the unit suite runs inside workerd, where there is no
 * layout engine — so the defects that only appear once something is on screen
 * are exactly the ones nothing was catching. The Now-Bar check is here because
 * it did in fact regress: `.screen` had `min-height` and no flex context, so
 * `.scroll` was never a scroll container, `position: sticky` had no scrollport,
 * and the primary navigation plus the one status pill rendered several hundred
 * pixels below the fold in every build for the life of the project.
 */

import { chromium, devices } from 'playwright';

const BASE = process.env.BALLAST_URL ?? 'http://localhost:8787';
const fails = [];
const ok = [];
const check = (name, pass, detail) =>
  (pass ? ok : fails).push(detail ? `${name} — ${detail}` : name);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#email', 'demo@ballast.local');
  await page.fill('#password', 'ballast-preview');
  await page.click('button[type=submit]');
  await page.waitForSelector('.canvas', { timeout: 20_000 });
  await page.waitForTimeout(500);

  const vh = page.viewportSize().height;

  /* --- The Now-Bar must be ON SCREEN at rest, before any scrolling. ------ */
  const bar = await page.locator('.nowbar').boundingBox();
  check(
    `[${scheme}] Now-Bar is visible at rest`,
    bar != null && bar.y >= 0 && bar.y + bar.height <= vh + 1,
    bar ? `y=${Math.round(bar.y)} h=${Math.round(bar.height)} viewport=${vh}` : 'not rendered',
  );

  /* --- .scroll must be the scroll container, not the document. ---------- */
  const scrolls = await page.evaluate(() => {
    const el = document.querySelector('.scroll');
    return {
      inner: el ? el.scrollHeight > el.clientHeight : false,
      doc: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    };
  });
  check(`[${scheme}] the document itself does not scroll`, !scrolls.doc);
  check(`[${scheme}] .scroll is the scrollport`, scrolls.inner);

  /* --- Every tap target meets the 44pt minimum. ------------------------- */
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button, a[href], input')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        label: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 28),
        h: el.getBoundingClientRect().height,
      }))
      .filter((b) => b.h > 0 && b.h < 44),
  );
  check(
    `[${scheme}] all tap targets >= 44px`,
    small.length === 0,
    small.map((s) => `${s.label}:${Math.round(s.h)}px`).join(', '),
  );

  /* --- The fund sheet must be an OPAQUE surface. ------------------------ */
  await page.locator('.tile', { hasText: 'Tax' }).first().click();
  await page.waitForSelector('.sheet');
  await page.waitForTimeout(400);
  const alpha = await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector('.sheet')).backgroundColor;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return 0;
    const parts = m[1].split(',').map((n) => parseFloat(n));
    return parts.length < 4 ? 1 : parts[3];
  });
  check(`[${scheme}] fund sheet is opaque`, alpha >= 0.98, `alpha=${alpha}`);

  /* --- The primary action must separate from the sheet it sits on. ------ */
  const sep = await page.evaluate(() => {
    const srgb = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = (s) => {
      const [r, g, b] = s.match(/\d+/g).map(Number);
      return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
    };
    const ratio = (x, y) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    const btn = getComputedStyle(document.querySelector('.btn-primary'));
    const sheet = lum(getComputedStyle(document.querySelector('.sheet')).backgroundColor);
    // A filled button's visual boundary is its FILL; an outlined one's is its
    // border. Either may carry the separation, so take whichever does — this
    // is 1.4.11's "visual information required to identify a control", not a
    // rule about borders specifically.
    return Math.max(ratio(lum(btn.backgroundColor), sheet), ratio(lum(btn.borderTopColor), sheet));
  });
  // WCAG 1.4.11 non-text contrast, on the one control that commits money.
  check(
    `[${scheme}] primary button is distinguishable from the sheet`,
    sep >= 3,
    `${sep.toFixed(2)}:1`,
  );

  await ctx.close();
}

await browser.close();

for (const line of ok) console.log(`  ok   ${line}`);
for (const line of fails) console.log(`  FAIL ${line}`);
console.log(`\n${ok.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
