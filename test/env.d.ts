import type { Env } from '../src/env';

declare module 'cloudflare:test' {
  // Gives `env` in tests the same type as the Worker's own bindings.
  interface ProvidedEnv extends Env {}
}
