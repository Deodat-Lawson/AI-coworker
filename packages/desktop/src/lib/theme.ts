/**
 * Applying the theme in the renderer.
 *
 * The resolution rules live in `@ai-coworker/shared`; this is the part that
 * touches the DOM. Two things matter here beyond stamping an attribute:
 *
 *  - The chosen appearance is owned by the main process (it is in `config.json`
 *    next to the relay URL), so it survives a reinstall of the renderer and can
 *    colour the window before a page exists. But waiting for the first IPC round
 *    trip would paint one frame of the wrong theme, so the last resolved value
 *    is mirrored into `localStorage` and applied synchronously at import time.
 *  - "Match system" has to keep matching. The media query stays subscribed for
 *    as long as the app is open, not just sampled once at startup.
 */

import {
  type Appearance,
  type ResolvedTheme,
  normalizeAppearance,
  resolveTheme,
} from '@ai-coworker/shared';

const MIRROR_KEY = 'stead.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(DARK_QUERY).matches
    : true;
}

/** Stamp the resolved theme on <html>, where every selector in the CSS looks. */
export function stampTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(MIRROR_KEY, theme);
  } catch {
    // Private mode, or a hostile storage policy. The attribute is what counts.
  }
}

/**
 * The theme the last session ended on. Applied before React mounts so the first
 * frame is already right; the authoritative value replaces it milliseconds
 * later and usually agrees.
 */
export function applyMirroredTheme(): void {
  let mirrored: string | null = null;
  try {
    mirrored = localStorage.getItem(MIRROR_KEY);
  } catch {
    mirrored = null;
  }
  stampTheme(mirrored === 'light' || mirrored === 'dark' ? mirrored : systemPrefersDark() ? 'dark' : 'light');
}

export function currentTheme(appearance: Appearance): ResolvedTheme {
  return resolveTheme(normalizeAppearance(appearance), systemPrefersDark());
}

/**
 * Keep <html data-theme> in step with the chosen appearance, following the OS
 * while the choice is "system". Returns an unsubscribe.
 */
export function watchAppearance(
  appearance: Appearance,
  onResolved?: (theme: ResolvedTheme) => void,
): () => void {
  const choice = normalizeAppearance(appearance);
  const apply = () => {
    const theme = resolveTheme(choice, systemPrefersDark());
    stampTheme(theme);
    onResolved?.(theme);
  };
  apply();

  if (choice !== 'system' || typeof window === 'undefined' || !window.matchMedia) {
    return () => {};
  }
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
