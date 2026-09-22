/**
 * Every custom property a stylesheet USES must actually be DEFINED.
 *
 * THE DEFECT THIS EXISTS FOR, which shipped and was invisible to 285 tests:
 * `--ctrlln` was referenced by the money input and the quick-amount chips and
 * defined nowhere. An undefined custom property inside a shorthand makes the
 * whole declaration invalid at computed-value time, so `border: 1px solid
 * var(--ctrlln)` computes to `none`. The chips had NO visible boundary in
 * every build — four tappable controls rendering as floating text.
 *
 * Nothing catches this. It is not a parse error, so the build is happy. It has
 * no runtime symptom, so the console is clean. The existing contrast test only
 * looks at `.btn-primary`, and the tap-target test only measures height, so
 * both pass on a control with no edge at all.
 *
 * This is deliberately a CLASS test rather than an assertion about --ctrlln:
 * the next undefined token, wherever it is added, fails here.
 */

import { describe, expect, inject, it } from 'vitest';

/**
 * Read from disk by test/global-setup.ts, NOT by `import '...css?raw'` —
 * Vite's CSS plugin intercepts that and returns an empty string, so the first
 * version of this file passed while examining nothing at all.
 *
 * Whatever is in web/src/styles, so a stylesheet added later is covered
 * without anyone remembering to list it here.
 */
const SHEETS = inject('stylesheets');
const tokens = SHEETS['tokens.css'];

/** Strip comments so a token named in prose is not mistaken for a usage. */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const defined = new Set(
  [...strip(Object.values(SHEETS).join('\n')).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
);

describe('CSS custom properties', () => {
  it('defines every token any stylesheet reads', () => {
    const missing: string[] = [];

    for (const [name, css] of Object.entries(SHEETS)) {
      for (const match of strip(css).matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
        const [, token, next] = match;
        // `var(--x, fallback)` is a deliberate optional read — the fallback is
        // the author saying "this may not exist". A bare `var(--x)` is not.
        if (next === ',') continue;
        if (!defined.has(token)) missing.push(`${name} reads ${token}`);
      }
    }

    expect(missing, 'custom properties used but never defined').toEqual([]);
  });

  it('defines the same tokens in BOTH themes', () => {
    // A token defined only in Atelier is a control that vanishes in Graphite —
    // which is precisely how the fund sheet shipped fully transparent in dark.
    const themeBlock = (selector: string) => {
      const start = strip(tokens).indexOf(selector);
      expect(start, `${selector} block not found`).toBeGreaterThan(-1);
      const body = strip(tokens).slice(start, strip(tokens).indexOf('}', start));
      return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    };

    const atelier = themeBlock("[data-theme='atelier']");
    const graphite = themeBlock("[data-theme='graphite']");

    expect(
      [...atelier].filter((t) => !graphite.has(t)),
      'missing from Graphite',
    ).toEqual([]);
    expect(
      [...graphite].filter((t) => !atelier.has(t)),
      'missing from Atelier',
    ).toEqual([]);
  });
});
