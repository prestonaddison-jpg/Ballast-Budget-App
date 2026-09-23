/**
 * Refuse to deploy with development configuration. Runs automatically as
 * npm's `predeploy` hook, so `npm run deploy` cannot skip it.
 *
 * WHY THIS EXISTS. `isLocalDev(env)` is defined as "the CANONICAL APP_ORIGIN
 * starts with http://", and it decides two things that matter: whether the
 * session cookie carries `Secure`, and which origins the CSRF check accepts.
 * Deployed with a development value, the Worker would hand out session
 * cookies with NO Secure flag over the public internet, and reject every
 * state-changing request as cross-origin. `wrangler deploy --dry-run` prints
 * APP_ORIGIN without complaint; nothing else catches it.
 *
 * CORRECTION, and it describes a bug this comment helped hide. This used to
 * say "wrangler.jsonc ships APP_ORIGIN as http://localhost:8787 so `wrangler
 * dev` works with no setup". That stopped being true when APP_ORIGIN became
 * a production origin list, and the consequence was not cosmetic: `npm run
 * dev` began answering 403 to every write, login included, because no
 * localhost origin was in the list any more.
 *
 * The local value now comes from the dev script (`--var APP_ORIGIN:...`),
 * which mirrors what playwright.config.ts already did. The shipped file is
 * production-only on purpose, and `test/unit/dev-config.test.ts` asserts the
 * two stay in step — because the failure was a disagreement BETWEEN files,
 * which no single file can be asked about.
 */

import { readFileSync } from 'node:fs';

const problems = [];

/**
 * Strip comments and trailing commas from JSONC.
 *
 * A scanner rather than a regex, because the obvious regex eats the `//` in
 * "http://localhost:8787" and leaves unparseable JSON. Tracking whether we are
 * inside a string is the whole job.
 */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));

const appOrigin = config.vars?.APP_ORIGIN ?? '';
// APP_ORIGIN may list several origins, comma-separated, first one canonical.
// Check EVERY entry: one http:// buried at the end still reaches production,
// and checking only the raw string would miss it the moment a second origin
// is added.
const origins = appOrigin
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const insecure = origins.filter((o) => o.startsWith('http://'));
if (!appOrigin) {
  problems.push('APP_ORIGIN is not set in wrangler.jsonc.');
} else if (insecure.length) {
  problems.push(
    `APP_ORIGIN contains an http:// origin: ${insecure.join(', ')}.\n` +
      '    Over http:// the Worker treats itself as local development: the session\n' +
      '    cookie ships WITHOUT the Secure flag, and the CSRF check accepts only\n' +
      '    that origin, so every write from the real site is refused.\n' +
      '    Set it to the https:// origin this Worker will actually serve.',
  );
}

for (const [binding, value] of Object.entries(config.d1_databases?.[0] ?? {})) {
  if (typeof value === 'string' && value.startsWith('PLACEHOLDER')) {
    problems.push(`d1_databases[0].${binding} is still a placeholder.`);
  }
}
for (const kv of config.kv_namespaces ?? []) {
  if (String(kv.id).startsWith('PLACEHOLDER')) {
    problems.push(`kv_namespaces "${kv.binding}" id is still a placeholder.`);
  }
}

if (problems.length) {
  console.error('\nRefusing to deploy — wrangler.jsonc still has development values:\n');
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  console.error('Fix these and run `npm run deploy` again.\n');
  process.exit(1);
}

console.log(`deploy config ok — APP_ORIGIN ${appOrigin}`);
