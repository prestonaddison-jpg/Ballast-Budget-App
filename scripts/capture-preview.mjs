/**
 * Screenshots the running app at iPhone size, in both themes.
 *
 * Preview tooling — it drives the REAL Worker against the REAL local D1, so
 * what comes out is the app, not a mockup of it.
 */

import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BALLAST_URL ?? 'http://127.0.0.1:8787';
const OUT = '/home/user/Ballast-Budget-App/preview';
mkdirSync(OUT, { recursive: true });

const iphone = devices['iPhone 15 Pro'];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

async function session(colorScheme) {
  const ctx = await browser.newContext({ ...iphone, colorScheme });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('  console.error:', m.text()));
  page.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message));
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ✓ ${name}.png`);
}

async function signIn(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#email', 'demo@ballast.local');
  await page.fill('#password', 'ballast-preview');
  await page.click('button[type=submit]');
  await page.waitForSelector('.canvas', { timeout: 20_000 });
  // Let the tide bars finish their transition before capturing.
  await page.waitForTimeout(700);
}

/* --- Sign-in, light ---------------------------------------------------- */
{
  const { ctx, page } = await session('light');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#email');
  await page.waitForTimeout(400);
  await shot(page, '01-signin-atelier');
  await ctx.close();
}

/* --- Canvas, Atelier (light) ------------------------------------------- */
{
  const { ctx, page } = await session('light');
  await signIn(page);
  await shot(page, '02-canvas-atelier');

  // Scrolled down: the grouped vitals + progressive disclosure.
  await page.evaluate(() => document.querySelector('.scroll')?.scrollTo(0, 99_999));
  await page.waitForTimeout(500);
  await shot(page, '03-canvas-atelier-scrolled');

  // Tap-to-fund on the part-funded reserve.
  await page.evaluate(() => document.querySelector('.scroll')?.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const tile = page.locator('.tile', { hasText: 'Alignment rack' });
  await tile.click();
  await page.waitForSelector('.sheet', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot(page, '04-fund-sheet-atelier');
  await ctx.close();
}

/* --- The other three Now-Bar destinations ------------------------------ */
{
  const { ctx, page } = await session('light');
  await signIn(page);
  for (const [key, name] of [
    ['needs', '07-needs-you'],
    ['accounts', '08-accounts'],
    ['settings', '09-settings'],
  ]) {
    await page.click(`.nowbar .nb[data-key="${key}"]`);
    await page.waitForTimeout(400);
    await shot(page, name);
  }
  await ctx.close();
}

/* --- Canvas, Graphite (dark) ------------------------------------------- */
{
  const { ctx, page } = await session('dark');
  await signIn(page);
  await shot(page, '05-canvas-graphite');

  const tile = page.locator('.tile', { hasText: 'Tax' }).first();
  await tile.click();
  await page.waitForSelector('.sheet', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot(page, '06-fund-sheet-graphite');
  await ctx.close();
}

await browser.close();
console.log('\ndone');
