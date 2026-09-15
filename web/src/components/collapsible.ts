/**
 * Progressive-disclosure collapsible (Blueprint A.5, A.7).
 *
 * One reusable section; secondary detail folded by default; <=2 levels deep.
 * Built on <details>/<summary> so keyboard, screen-reader and find-in-page
 * behaviour come from the platform rather than from re-implemented ARIA.
 */

export interface CollapsibleOptions {
  summary: string;
  /** Rendered into the body when first opened. */
  body: Node | (() => Node);
  open?: boolean;
  /** Nesting depth guard — the system caps disclosure at 2 levels. */
  level?: 1 | 2;
}

export function createCollapsible(opts: CollapsibleOptions): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'disclose';
  details.dataset.level = String(opts.level ?? 1);
  if (opts.open) details.open = true;

  const summary = document.createElement('summary');
  summary.textContent = opts.summary;
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'disclose-body';
  details.appendChild(body);

  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    body.appendChild(typeof opts.body === 'function' ? opts.body() : opts.body);
  };

  if (details.open) fill();
  else
    details.addEventListener(
      'toggle',
      () => {
        if (details.open) fill();
      },
      { once: true },
    );

  return details;
}
