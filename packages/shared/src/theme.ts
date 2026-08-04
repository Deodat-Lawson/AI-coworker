/**
 * Appearance: which of the two themes the app is wearing.
 *
 * The choice a person makes is one of three things — dark, light, or "whatever
 * the machine is doing". The stylesheet only ever knows about two, so the third
 * is resolved before it reaches the DOM. Keeping that resolution here, as a
 * pure function of (choice, what the OS says), is what lets it be tested
 * without a browser and reused by the main process, which has to pick a window
 * background colour before a renderer exists to ask.
 */

/** What the person chose. */
export type Appearance = 'dark' | 'light' | 'system';

/** What the stylesheet is told. `system` never reaches this. */
export type ResolvedTheme = 'dark' | 'light';

export const APPEARANCES: readonly Appearance[] = ['dark', 'light', 'system'] as const;

export const APPEARANCE_LABELS: Record<Appearance, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'Match system',
};

export const DEFAULT_APPEARANCE: Appearance = 'system';

/** Anything unrecognised — an old config, a hand-edited file — falls back. */
export function normalizeAppearance(value: unknown): Appearance {
  return value === 'dark' || value === 'light' || value === 'system' ? value : DEFAULT_APPEARANCE;
}

export function resolveTheme(appearance: Appearance, systemPrefersDark: boolean): ResolvedTheme {
  if (appearance === 'dark') return 'dark';
  if (appearance === 'light') return 'light';
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * What the toggle shortcut does. It cycles rather than flips, because "match
 * system" is a real answer and a two-state toggle would strand anyone who
 * chose it.
 */
export function nextAppearance(current: Appearance): Appearance {
  const index = APPEARANCES.indexOf(normalizeAppearance(current));
  return APPEARANCES[(index + 1) % APPEARANCES.length]!;
}

/**
 * The window background, needed before the first paint so launching into the
 * light theme does not flash a dark rectangle (and the reverse). These two are
 * `--bg` from each theme block in `styles.css`, and a test keeps them honest.
 */
export const THEME_BACKGROUNDS: Record<ResolvedTheme, string> = {
  dark: '#0f1115',
  light: '#ffffff',
};
