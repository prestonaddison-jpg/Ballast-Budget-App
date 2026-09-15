/**
 * Theme control — Atelier (light pole) / Graphite (dark pole).
 *
 * "The toggle flips tone, never structure: same components, same layout, same
 * card decisions; only the token block changes." Status colors stay constant
 * so meaning never shifts between poles.
 */

export type ThemeName = 'atelier' | 'graphite';
export type ThemePreference = ThemeName | 'system';

const STORAGE_KEY = 'ballast.theme';

/** Matches the --bgfade of each pole; drives the iOS status-bar / UI chrome. */
const THEME_COLOR: Record<ThemeName, string> = {
  atelier: '#f3f4f2',
  graphite: '#121416',
};

export function systemTheme(): ThemeName {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'graphite'
    : 'atelier';
}

export function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'atelier' || v === 'graphite' || v === 'system') return v;
  } catch {
    // Private mode / blocked storage — fall through to system.
  }
  return 'system';
}

export function resolve(pref: ThemePreference): ThemeName {
  return pref === 'system' ? systemTheme() : pref;
}

export function applyTheme(pref: ThemePreference): ThemeName {
  const theme = resolve(pref);
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme === 'graphite' ? 'dark' : 'light';

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);

  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Non-fatal: the theme still applies for this session.
  }
  return theme;
}

/** Re-resolve when the OS flips, but only while the preference is "system". */
export function watchSystemTheme(onChange: (t: ThemeName) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (readPreference() === 'system') onChange(applyTheme('system'));
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

export function initTheme(): ThemeName {
  return applyTheme(readPreference());
}
