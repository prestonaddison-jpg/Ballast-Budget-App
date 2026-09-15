import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, inject } from 'vitest';

/**
 * Runs inside the Worker, once per test file, before any test.
 *
 * `isolatedStorage` (on by default) rolls back writes between test files, so
 * each file starts from the migrated-but-empty schema.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
});
