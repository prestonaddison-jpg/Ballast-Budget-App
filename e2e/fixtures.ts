import { execFileSync } from 'node:child_process';
import { test as base, expect, type Page } from '@playwright/test';

export const DEMO = { email: 'demo@ballast.local', password: 'ballast-preview' };

/** Matches SESSION_TOKEN in scripts/seed-preview.mjs. */
const SESSION_TOKEN = 'e2e-seeded-session-token-not-a-secret';

/**
 * Reset the database to the seeded fixture.
 *
 * Every test starts from the same figures — $18,420 available, $16,900 spoken
 * for, $1,520 free — so a test can assert an exact amount without depending on
 * what ran before it. Tests that move money would otherwise leave the next one
 * asserting against a residual that had already changed.
 */
export function reseed() {
  execFileSync('node', ['scripts/seed-preview.mjs'], { stdio: 'pipe' });
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'ballast-db', '--local', '--file=/tmp/ballast-seed.sql'],
    { stdio: 'pipe' },
  );
}

/**
 * Signed in and sitting on the Canvas.
 *
 * Authentication is by SEEDED COOKIE, not by driving the login form. The login
 * route is rate limited to 10 attempts per window per IP — correct behaviour,
 * and it would 429 the eleventh test onwards, producing a wall of confusing
 * failures in specs that have nothing to do with auth. The form itself is
 * covered by its own test in auth.spec.ts.
 */
export const test = base.extend<{ app: Page }>({
  app: async ({ page, context, baseURL }, use) => {
    reseed();

    // APP_ORIGIN is http:// locally, so the Worker issues the dev cookie name
    // rather than the __Host- prefixed one. A hardcoded __Host- cookie would
    // simply never be read.
    await context.addCookies([
      {
        name: 'ballast_session_dev',
        value: SESSION_TOKEN,
        url: baseURL!,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);

    await page.goto('/');
    await expect(page.locator('.canvas')).toBeVisible();
    await use(page);
  },
});

export { expect };

/** Contrast ratio between two computed CSS colours, per WCAG 2.x. */
export async function contrast(
  page: Page,
  selA: string,
  propA: string,
  selB: string,
  propB: string,
) {
  return page.evaluate(
    ([a, pa, b, pb]) => {
      const channel = (c: number) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const lum = (colour: string) => {
        const [r, g, bl] = colour.match(/[\d.]+/g)!.map(Number);
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
      };
      const read = (sel: string, prop: string) =>
        lum(
          (getComputedStyle(document.querySelector(sel)!) as unknown as Record<string, string>)[
            prop
          ],
        );
      const x = read(a, pa);
      const y = read(b, pb);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    },
    [selA, propA, selB, propB] as const,
  );
}
