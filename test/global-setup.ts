import { readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build the PWA shell if it is not already built.
 *
 * Several tests fetch `/` through the ASSETS binding, which serves
 * `dist/client/`. On a clean checkout that directory does not exist, so the
 * response body is empty and those tests fail with `expected '' to contain
 * '<title>Ballast</title>'` — which reads like a broken Worker rather than a
 * missing build step. That is exactly how it failed the first time CI ran:
 * green locally, because a build happened to be sitting there.
 *
 * `npm test` should not depend on anyone having remembered to build first.
 */
function ensureShellBuilt() {
  if (existsSync(resolve(here, '../dist/client/index.html'))) return;
  console.log('[global-setup] dist/client is missing — building the shell first');
  execFileSync('npm', ['run', 'build'], { cwd: resolve(here, '..'), stdio: 'inherit' });
}

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
  ensureShellBuilt();
  const migrations = await readD1Migrations(resolve(here, '../migrations'));
  project.provide('migrations', migrations);
}

declare module 'vitest' {
  interface ProvidedContext {
    migrations: Awaited<ReturnType<typeof readD1Migrations>>;
  }
}
