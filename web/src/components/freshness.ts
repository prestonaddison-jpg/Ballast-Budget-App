/**
 * Freshness indicator — rendering.
 *
 * The state machine is in lib/freshness-state.ts; this only paints it.
 */

import { computeFreshness, type FreshnessInput } from '../lib/freshness-state';

export * from '../lib/freshness-state';

export function createFreshness(input: FreshnessInput): HTMLElement {
  const f = computeFreshness(input);
  const node = document.createElement('div');
  node.className = 'freshness';
  node.dataset.state = f.state;

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.textContent = f.text;

  node.append(dot, text);
  // The state is in the accessible name as a word, not just the dot color.
  node.setAttribute('role', 'status');
  node.setAttribute('aria-label', `${f.state}: ${f.text}${f.detail ? `. ${f.detail}` : ''}`);
  if (f.detail) node.title = f.detail;
  return node;
}
