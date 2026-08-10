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

// ---------------------------------------------------------------------------
// A workspace's own colour
// ---------------------------------------------------------------------------

/**
 * The two text colours that ride on a filled accent. They are the same values
 * the stylesheet uses, restated here because the choice between them is made at
 * runtime from whatever colour a workspace picked.
 */
export const ON_ACCENT_DARK = '#0b1220';
export const ON_ACCENT_LIGHT = '#ffffff';

export function parseHexColor(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** WCAG relative luminance. */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (raw: number) => {
    const value = raw / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const left = parseHexColor(a);
  const right = parseHexColor(b);
  if (!left || !right) return 1;
  const high = Math.max(relativeLuminance(left), relativeLuminance(right));
  const low = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (high + 0.05) / (low + 0.05);
}

function mixTowards([r, g, b]: [number, number, number], towards: number, amount: number): string {
  const blend = (channel: number) => Math.round(channel + (towards - channel) * amount);
  return `#${[blend(r), blend(g), blend(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Every token that depends on the accent, derived from one colour.
 *
 * A workspace colour applied as a headline colour alone reads as a rendering
 * bug: the button turns orange and everything tinted behind it stays blue. So
 * the whole family is derived together, and the text that rides on a filled
 * accent is chosen by contrast rather than assumed — a workspace on yellow
 * needs dark text where one on indigo needs white.
 *
 * Pure, so the light and dark derivations can be checked for contrast in a test
 * rather than by eye.
 */
export function accentTokens(color: string, theme: ResolvedTheme): Record<string, string> | null {
  const rgb = parseHexColor(color);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const tint = (alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
  const dark = theme === 'dark';

  return {
    '--theme-accent': color.startsWith('#') ? color : `#${color}`,
    // "More prominent" is a different direction on each ground: brighter in the
    // dark theme, deeper in the light one.
    '--accent-hover': mixTowards(rgb, dark ? 255 : 0, 0.18),
    '--accent-dim': mixTowards(rgb, dark ? 0 : 255, 0.55),
    '--accent-border': mixTowards(rgb, dark ? 0 : 255, 0.35),
    '--focus-border': mixTowards(rgb, dark ? 0 : 255, 0.45),
    '--accent-tint-soft': tint(0.04),
    '--accent-tint': tint(0.09),
    '--accent-tint-mid': tint(0.12),
    '--accent-tint-hi': tint(0.16),
    '--accent-tint-max': tint(0.3),
    '--text-on-accent':
      contrastRatio(color, ON_ACCENT_DARK) >= contrastRatio(color, ON_ACCENT_LIGHT)
        ? ON_ACCENT_DARK
        : ON_ACCENT_LIGHT,
  };
}

/** The token names `accentTokens` sets, for clearing them again. */
export const ACCENT_TOKEN_NAMES: readonly string[] = [
  '--theme-accent',
  '--accent-hover',
  '--accent-dim',
  '--accent-border',
  '--focus-border',
  '--accent-tint-soft',
  '--accent-tint',
  '--accent-tint-mid',
  '--accent-tint-hi',
  '--accent-tint-max',
  '--text-on-accent',
];
