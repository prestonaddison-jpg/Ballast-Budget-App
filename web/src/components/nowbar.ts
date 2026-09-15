/**
 * Now-Bar nav (Blueprint A.5, §14).
 *
 * 4 destinations + ONE living centre status pill that always shows the single
 * most urgent thing, color-coded via --good/--watch/--bad. On desktop the bar
 * becomes a left rail (handled in CSS, not here — the toggle flips tone and
 * layout, never structure).
 *
 * The pill is the second half of Ballast's Von Restorff budget: the focal
 * alert on the page, and this pill in the chrome. Nothing else competes.
 */

export type NavKey = 'canvas' | 'needs' | 'accounts' | 'settings';

export interface NavDestination {
  key: NavKey;
  label: string;
  /** Inline SVG path data, drawn at 24x24. */
  icon: string;
}

export interface StatusPill {
  /** The single most urgent thing, in plain words. */
  text: string;
  status: 'good' | 'watch' | 'bad';
  onSelect?: () => void;
}

export const DESTINATIONS: NavDestination[] = [
  { key: 'canvas', label: 'Canvas', icon: 'M4 5h7v6H4zM13 5h7v4h-7zM4 13h7v6H4zM13 11h7v8h-7z' },
  { key: 'needs', label: 'Needs You', icon: 'M12 3l9 16H3zM12 9v5M12 16.5v.5' },
  {
    key: 'accounts',
    label: 'Accounts',
    icon: 'M3 7l9-4 9 4v2H3zM5 11h2v6H5zM11 11h2v6h-2zM17 11h2v6h-2zM3 19h18v2H3z',
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'M12 9a3 3 0 100 6 3 3 0 000-6zM4 12l-1.5-1 1-3 1.8.4 1.6-1.6L6.5 5l3-1 1 1.5h2L13.5 4l3 1-.4 1.8 1.6 1.6L19.5 8l1 3-1.5 1v2l1.5 1-1 3-1.8-.4-1.6 1.6.4 1.8-3 1-1-1.5h-2L9.5 20l-3-1 .4-1.8-1.6-1.6L3.5 16l-1-3L4 12z',
  },
];

function iconSvg(path: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

export interface NowBarOptions {
  active: NavKey;
  pill: StatusPill;
  onNavigate?: (key: NavKey) => void;
}

export function createNowBar(opts: NowBarOptions): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'nowbar';
  nav.setAttribute('aria-label', 'Primary');

  // Destinations 1-2, pill, destinations 3-4 — the pill sits centre on phone.
  const mk = (d: NavDestination) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nb';
    b.dataset.key = d.key;
    if (d.key === opts.active) b.setAttribute('aria-current', 'page');
    b.appendChild(iconSvg(d.icon));
    const span = document.createElement('span');
    span.textContent = d.label;
    b.appendChild(span);
    if (opts.onNavigate) b.addEventListener('click', () => opts.onNavigate!(d.key));
    return b;
  };

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'pill';
  pill.dataset.status = opts.pill.status;
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = opts.pill.text;
  pill.append(dot, label);
  // Status is in the accessible name, not only the dot color (A.8).
  pill.setAttribute('aria-label', `Most urgent (${opts.pill.status}): ${opts.pill.text}`);
  if (opts.pill.onSelect) pill.addEventListener('click', opts.pill.onSelect);

  nav.append(
    mk(DESTINATIONS[0]),
    mk(DESTINATIONS[1]),
    pill,
    mk(DESTINATIONS[2]),
    mk(DESTINATIONS[3]),
  );
  return nav;
}
