/**
 * A workspace's colour, applied to the whole app.
 *
 * The failure mode of "pick your own accent" is never that it does not apply.
 * It is that one colour in the palette turns out to be unreadable under white
 * text, or that the tints behind a hand-picked orange stay the stock blue. Both
 * are checked here, for every colour the app offers and both themes, because
 * neither is visible until somebody happens to pick that colour.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCENT_TOKEN_NAMES,
  ON_ACCENT_DARK,
  ON_ACCENT_LIGHT,
  WORKSPACE_COLORS,
  accentTokens,
  contrastRatio,
  parseHexColor,
  relativeLuminance,
} from '../packages/shared/dist/index.js';

const THEMES = ['dark', 'light'];

test('every offered workspace colour parses', () => {
  for (const color of WORKSPACE_COLORS) {
    assert.ok(parseHexColor(color), `${color} is not a six-digit hex colour`);
  }
});

test('a colour the app does not understand changes nothing', () => {
  assert.equal(accentTokens('not-a-colour', 'dark'), null);
  assert.equal(accentTokens('', 'dark'), null);
  assert.equal(accentTokens('#12345', 'dark'), null);
});

test('the whole accent family is derived, not just the headline colour', () => {
  const tokens = accentTokens('#fb923c', 'dark');
  assert.deepEqual(Object.keys(tokens).sort(), [...ACCENT_TOKEN_NAMES].sort());

  // Every tint carries the chosen colour's channels, so nothing is left blue.
  for (const name of ACCENT_TOKEN_NAMES) {
    if (!name.includes('tint')) continue;
    assert.match(tokens[name], /^rgba\(251, 146, 60, /, `${name} was not derived from the accent`);
  }
});

test('text on a filled accent stays readable, whatever colour was picked', () => {
  for (const color of WORKSPACE_COLORS) {
    for (const theme of THEMES) {
      const tokens = accentTokens(color, theme);
      const onAccent = tokens['--text-on-accent'];
      assert.ok(
        onAccent === ON_ACCENT_DARK || onAccent === ON_ACCENT_LIGHT,
        `${color}: unexpected text colour ${onAccent}`,
      );
      const ratio = contrastRatio(color, onAccent);
      assert.ok(
        ratio >= 4.5,
        `${color} in ${theme}: text on the accent is only ${ratio.toFixed(2)}:1 — needs 4.5:1`,
      );
    }
  }
});

test('the pairing chosen is always the better of the two', () => {
  for (const color of WORKSPACE_COLORS) {
    const chosen = accentTokens(color, 'dark')['--text-on-accent'];
    const other = chosen === ON_ACCENT_DARK ? ON_ACCENT_LIGHT : ON_ACCENT_DARK;
    assert.ok(
      contrastRatio(color, chosen) >= contrastRatio(color, other),
      `${color}: the other text colour would have been more readable`,
    );
  }
});

test('hover brightens on a dark ground and deepens on a light one', () => {
  for (const color of WORKSPACE_COLORS) {
    const base = relativeLuminance(parseHexColor(color));
    const onDark = relativeLuminance(parseHexColor(accentTokens(color, 'dark')['--accent-hover']));
    const onLight = relativeLuminance(parseHexColor(accentTokens(color, 'light')['--accent-hover']));

    assert.ok(onDark > base, `${color}: hover should be brighter than the accent in the dark theme`);
    assert.ok(onLight < base, `${color}: hover should be deeper than the accent in the light theme`);
  }
});

test('the dim and border derivations stay inside the theme they were made for', () => {
  for (const color of WORKSPACE_COLORS) {
    const base = relativeLuminance(parseHexColor(color));
    const dimDark = relativeLuminance(parseHexColor(accentTokens(color, 'dark')['--accent-dim']));
    const dimLight = relativeLuminance(parseHexColor(accentTokens(color, 'light')['--accent-dim']));

    // A "dim" accent recedes towards the page it sits on: darker in the dark
    // theme, lighter in the light one. Getting this backwards is what makes a
    // custom accent look like a bug rather than a choice.
    assert.ok(dimDark < base, `${color}: dim should recede towards the dark ground`);
    assert.ok(dimLight > base, `${color}: dim should recede towards the light ground`);
  }
});

test('token names are complete, so clearing an accent really clears it', () => {
  const tokens = accentTokens(WORKSPACE_COLORS[0], 'dark');
  for (const name of Object.keys(tokens)) {
    assert.ok(
      ACCENT_TOKEN_NAMES.includes(name),
      `${name} is set but not listed for removal — it would survive a workspace switch`,
    );
  }
});
