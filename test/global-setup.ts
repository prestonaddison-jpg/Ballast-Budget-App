import { readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Runs in Node BEFORE the worker pool starts.
 *
 * Reads the real migration files and hands them to the in-worker setup, so
 * tests run against the SAME schema that ships — not a hand-maintained test
 * fixture that silently drifts from migrations/.
 *
 * NOTE: `readD1Migrations` is exported from the PACKAGE ROOT in v0.22. The
 * doc comment in the bundled types still points at
 * `@cloudflare/vitest-pool-workers/config`, a subpath that no longer exists.
 */
export default async function setup(project: TestProject) {
  const migrations = await readD1Migrations(resolve(here, '../migrations'));
  project.provide('migrations', migrations);
}

declare module 'vitest' {
  interface ProvidedContext {
    migrations: Awaited<ReturnType<typeof readD1Migrations>>;
  }
}
