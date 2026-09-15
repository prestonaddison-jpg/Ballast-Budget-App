import type { Env as BallastEnv } from '../src/env';

/**
 * Give `env` in tests the same bindings the Worker has.
 *
 * The mechanism is declaration merging into `Cloudflare.Env`, which
 * @cloudflare/workers-types documents as the extension point:
 *   "The specific project can extend `Env` by redeclaring it in
 *    project-specific files. Typescript will merge all declarations."
 *
 * NOT `declare module 'cloudflare:test' { interface ProvidedEnv ... }` — that
 * was the older pattern and `ProvidedEnv` no longer exists in the package, so
 * the augmentation silently did nothing and every `env.DB` was typed `any`.
 */
declare global {
  namespace Cloudflare {
    interface Env extends BallastEnv {}
  }
}

export {};
