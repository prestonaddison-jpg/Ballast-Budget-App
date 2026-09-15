import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Worker tests run inside workerd via Miniflare, so `env.DB` is a REAL D1
 * database and the session/auth code is exercised against real SQLite rather
 * than a mock. That matters here: the security-critical paths are exactly the
 * ones a hand-written mock would quietly get wrong.
 *
 * NOTE on the API: @cloudflare/vitest-pool-workers v0.22 exposes a Vite PLUGIN
 * (`cloudflareTest`). The older `defineWorkersConfig` from the
 * `@cloudflare/vitest-pool-workers/config` subpath no longer exists — that
 * subpath is not in the package's `exports` map at all.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Test-only configuration. The encryption key is a throwaway.
          PLAID_ENV: 'sandbox',
          APP_ORIGIN: 'http://localhost:8787',
          PLAID_CLIENT_ID: 'test-client-id',
          PLAID_SECRET: 'test-secret',
          FIELD_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
