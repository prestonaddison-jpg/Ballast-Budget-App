import { readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  const index = resolve(here, '../dist/client/index.html');
  // EXISTS IS NOT ENOUGH. An interrupted build leaves index.html behind as
  // `<html></html>` — what an HTML parser emits for empty input — and the old
  // check saw a file and moved on. Three routing tests then failed with
  // `expected '<html></html>' to contain '<title>Ballast</title>'`, which reads
  // like a broken Worker rather than a broken build. So the check is for a
  // sentinel the real document always carries, not for a filename.
  const built = existsSync(index) && readFileSync(index, 'utf8').includes('<title>Ballast</title>');
  if (built) return;
  console.log('[global-setup] dist/client is missing or incomplete — rebuilding the shell');
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
/**
 * The stylesheet SOURCES, read in Node and handed to the worker tests.
 *
 * Not `import styles from '...css?raw'` — Vite's CSS plugin intercepts that
 * and hands back an EMPTY STRING, so a test asserting over it passes while
 * examining nothing. That is a test which cannot fail for the reason it
 * exists, which is worse than no test. Read from disk, where the bytes are.
 */
function readStylesheets(): Record<string, string> {
  const dir = resolve(here, '../web/src/styles');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.css'))
      .map((f) => [f, readFileSync(resolve(dir, f), 'utf8')]),
  );
}

/**
 * Source files the tests reason about as TEXT rather than by importing.
 *
 * Read in Node for the same reason the stylesheets are: Vite's `?raw` returns
 * an empty string for some of these, and build-artifact.mjs is a Node script
 * that cannot be imported into workerd at all.
 */
function readSources(): Record<string, string> {
  const wanted = [
    'web/src/lib/api.ts',
    'scripts/build-artifact.mjs',
    // The three files that together decide whether local development works.
    // They are read as TEXT because the defect is a DISAGREEMENT between
    // them, which no single file can be asked about.
    'package.json',
    'wrangler.jsonc',
    'playwright.config.ts',
  ];
  return Object.fromEntries(wanted.map((f) => [f, readFileSync(resolve(here, '..', f), 'utf8')]));
}

export default async function setup(project: TestProject) {
  ensureShellBuilt();
  const migrations = await readD1Migrations(resolve(here, '../migrations'));
  project.provide('migrations', migrations);
  project.provide('stylesheets', readStylesheets());
  project.provide('sources', readSources());
}

declare module 'vitest' {
  interface ProvidedContext {
    migrations: Awaited<ReturnType<typeof readD1Migrations>>;
    /** Every file under web/src/styles, by filename. */
    stylesheets: Record<string, string>;
    /** Selected source files, by repo-relative path. */
    sources: Record<string, string>;
  }
}
