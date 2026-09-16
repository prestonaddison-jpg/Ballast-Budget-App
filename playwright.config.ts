/**
 * End-to-end tests — the only suite that can see the app.
 *
 * `npm test` runs inside workerd: a server runtime with no browser, no layout
 * engine and no CSS. It is the right tool for the money model and the Worker,
 * and structurally incapable of noticing that a button is off-screen. That gap
 * is not theoretical — the Now-Bar was invisible in every build for the life of
 * the project while 234 workerd tests passed.
 *
 * So these run in real Chromium, at real iPhone dimensions, against the real
 * Worker and a real local D1.
 */

import { existsSync, readdirSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Use a preinstalled browser when the environment ships one.
 *
 * Some dev containers bake browsers in at a pinned build and block the
 * postinstall download, so @playwright/test looks for a build number it will
 * never find. On CI, where `playwright install` runs normally, this resolves to
 * undefined and Playwright picks its own.
 */
function preinstalledChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.env.CI || !root || !existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  if (!dir) return undefined;
  const bin = `${root}/${dir}/chrome-linux/chrome`;
  return existsSync(bin) ? bin : undefined;
}

const executablePath = preinstalledChromium();

/**
 * Ballast is iOS-only, so WEBKIT is the real target engine and CI runs it.
 * Only Chromium is preinstalled in the dev container, so that is the default
 * here; override with BALLAST_BROWSER=webkit once `npx playwright install
 * webkit` has run.
 */
const BROWSER = (process.env.BALLAST_BROWSER ?? 'chromium') as 'chromium' | 'webkit';

const PORT = 8788;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // The app is single-operator and the suite mutates one seeded database, so
  // parallel workers would fight over the same envelopes.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    // A trace on the first retry is what makes a CI failure diagnosable without
    // reproducing it locally.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath, args: executablePath ? ['--no-sandbox'] : [] },
  },

  projects: [
    {
      name: 'iphone-atelier',
      // The device descriptor defaults to WebKit; browserName overrides it.
      use: { ...devices['iPhone 15 Pro'], browserName: BROWSER, colorScheme: 'light' },
    },
    {
      name: 'iphone-graphite',
      // Both themes, every run. Graphite shipped with a fully transparent fund
      // sheet because only the light theme was ever looked at.
      use: { ...devices['iPhone 15 Pro'], browserName: BROWSER, colorScheme: 'dark' },
    },
  ],

  // Builds, migrates, seeds and serves in one command, so `npm run test:e2e`
  // needs no setup steps a contributor has to remember.
  webServer: {
    // Seeding happens per test (see e2e/fixtures.ts), so this only has to
    // build, migrate and serve.
    // APP_ORIGIN must match the port this serves on, or every state-changing
    // request is refused by the CSRF origin check — reads succeed, writes 403,
    // and the failure looks like a broken form rather than a misconfiguration.
    command:
      `npm run build && npx wrangler d1 migrations apply ballast-db --local && ` +
      `npx wrangler dev --port ${PORT} --local --var APP_ORIGIN:${BASE_URL}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
