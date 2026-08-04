/**
 * The two themes, checked the way you would check them by eye if you had
 * infinite patience: every colour in the stylesheet comes from a token, every
 * token exists in both themes, and every pairing of text against the surface it
 * actually sits on clears WCAG.
 *
 * This is a real test of the light theme rather than a smoke test, because the
 * failure mode of a second theme is never "it does not load" — it is one label
 * that turned out to be grey-on-grey in a dialog nobody opened.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  APPEARANCES,
  DEFAULT_APPEARANCE,
  THEME_BACKGROUNDS,
  nextAppearance,
  normalizeAppearance,
  resolveTheme,
} from '../packages/shared/dist/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = path.join(root, 'packages/desktop/src/styles.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Reading the stylesheet
// ---------------------------------------------------------------------------

/** Pull one `selector { ... }` block's declarations out as a name -> value map. */
function tokenBlock(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block in styles.css`);
  const end = css.indexOf('\n}', start);
  const body = css.slice(start, end);
  const out = new Map();
  for (const line of body.split('\n')) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (match) out.set(match[1], match[2].trim());
  }
  return out;
}

const DARK = tokenBlock(':root');
const LIGHT = tokenBlock(":root[data-theme='light']");

/** Where the token definitions stop and the rules begin. */
const RULES_FROM = css.indexOf('\n* {\n  box-sizing: border-box;\n}');

/**
 * Colours that are the same in both themes on purpose: an avatar gradient is an
 * identity, and the appearance picker has to draw both themes at once.
 */
const CONSTANTS = new Set([
  '--avatar-from',
  '--avatar-to',
  '--preview-dark-bg',
  '--preview-dark-rail',
  '--preview-light-bg',
  '--preview-light-rail',
]);

const NOT_COLOURS = new Set(['--radius', '--mono', '--shadow', '--shadow-sm']);

const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/;

/** Resolve a token to a literal, following `var()` indirection within a theme. */
function resolve(name, theme, seen = new Set()) {
  assert.ok(!seen.has(name), `circular token ${name}`);
  seen.add(name);
  const table = theme === 'light' ? LIGHT : DARK;
  const raw = table.get(name) ?? DARK.get(name);
  assert.ok(raw !== undefined, `undefined token ${name}`);
  const indirect = /^var\((--[a-z0-9-]+)\)$/.exec(raw.trim());
  return indirect ? resolve(indirect[1], theme, seen) : raw;
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

function parseColour(value) {
  const text = value.trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
    const int = Number.parseInt(digits.slice(0, 6), 16);
    const alpha = digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1;
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: alpha };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  assert.ok(rgb, `cannot parse colour "${value}"`);
  const parts = rgb[1].split(/[,/]/).map((p) => Number.parseFloat(p.trim()));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

/** Lay `top` over `bottom` and return the flat colour a screen would show. */
function over(top, bottom) {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The colour a token actually renders as, given the stack of surfaces beneath
 * it. Washes are translucent by design, so "is --text-dim readable" only means
 * anything once you say what it is sitting on.
 */
function flatten(theme, tokens) {
  let colour = { r: 0, g: 0, b: 0, a: 1 };
  for (const token of tokens) {
    const next = parseColour(resolve(token, theme));
    colour = next.a >= 1 ? next : over(next, colour);
  }
  return colour;
}

function ratio(theme, foreground, surfaces) {
  return contrast(flatten(theme, [...surfaces, foreground]), flatten(theme, surfaces));
}

// ---------------------------------------------------------------------------

describe('theme tokens', () => {
  it('no rule below the token block sets a colour literal', () => {
    const strays = [...css.slice(RULES_FROM).matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map(
      (m) => m[0],
    );
    assert.deepEqual(
      [...new Set(strays)],
      [],
      'colours must come from a token so both themes can override them',
    );
  });

  it('every colour token defined in dark is redefined in light', () => {
    const missing = [...DARK.entries()]
      .filter(([name, value]) => !NOT_COLOURS.has(name) && !CONSTANTS.has(name) && LITERAL.test(value))
      .map(([name]) => name)
      .filter((name) => !LIGHT.has(name));
    assert.deepEqual(missing, [], 'these tokens would keep their dark value in the light theme');
  });

  it('light defines nothing dark has not', () => {
    const extra = [...LIGHT.keys()].filter((name) => !DARK.has(name));
    assert.deepEqual(extra, [], 'a light-only token has no dark counterpart to fall back to');
  });

  it('the constants really are constant', () => {
    for (const name of CONSTANTS) {
      assert.equal(LIGHT.has(name), false, `${name} is meant to be the same in both themes`);
    }
  });

  it('every var() used in a rule resolves to a defined token', () => {
    const used = new Set(
      [...css.slice(RULES_FROM).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
    );
    // The vault owns this one; it is set on <html> at runtime, with a fallback.
    used.delete('--vault-accent');
    const undefinedTokens = [...used].filter((name) => !DARK.has(name));
    assert.deepEqual(undefinedTokens, [], 'these tokens are used but never defined');
  });

  it('the appearance preview swatches match the themes they claim to show', () => {
    assert.equal(resolve('--preview-dark-bg', 'dark'), resolve('--bg', 'dark'));
    assert.equal(resolve('--preview-dark-rail', 'dark'), resolve('--rail', 'dark'));
    assert.equal(resolve('--preview-light-bg', 'dark'), resolve('--bg', 'light'));
    assert.equal(resolve('--preview-light-rail', 'dark'), resolve('--rail', 'light'));
  });

  it('the window background the main process paints matches --bg', () => {
    assert.equal(THEME_BACKGROUNDS.dark.toLowerCase(), resolve('--bg', 'dark').toLowerCase());
    assert.equal(THEME_BACKGROUNDS.light.toLowerCase(), resolve('--bg', 'light').toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

/**
 * Every surface a person reads text off, and what it is stacked on.
 *
 * `only` narrows the check where a surface genuinely carries one weight of
 * text: an outgoing chat bubble holds the message and nothing else, so holding
 * its fill to a ratio against metadata grey would be inventing a requirement.
 */
const SURFACES = {
  page: { stack: ['--bg'] },
  raised: { stack: ['--bg', '--bg-raised'] },
  elevated: { stack: ['--bg', '--bg-elevated'] },
  sunken: { stack: ['--bg', '--bg-sunken'] },
  input: { stack: ['--bg', '--bg-input'] },
  button: { stack: ['--bg', '--bg-button'] },
  'button hover': { stack: ['--bg', '--bg-button-hover'] },
  sidebar: { stack: ['--sidebar'] },
  rail: { stack: ['--rail'] },
  badge: { stack: ['--bg', '--badge-bg'] },
  'hovered row': { stack: ['--bg', '--hover'] },
  'faintly hovered row': { stack: ['--bg', '--hover-faint'] },
  'inline code': { stack: ['--bg', '--code-bg'] },
  'active channel': { stack: ['--sidebar', '--active'] },
  banner: { stack: ['--bg', '--accent-tint-mid'] },
  'good banner': { stack: ['--bg', '--good-tint'] },
  'bad banner': { stack: ['--bg', '--bad-tint'] },
  'warn banner': { stack: ['--bg', '--warn-tint'] },
  'mentioning message': { stack: ['--bg', '--warn-tint'] },
  'selected persona': { stack: ['--bg-raised', '--accent-tint'] },
  'own bubble': { stack: ['--bg', '--accent-dim'], only: ['--text'] },
};

/**
 * AA for anything you read as prose. `--text-faint` is timestamps, placeholders
 * and metadata — the WCAG floor for incidental text — so it is held to 3:1.
 */
const FOREGROUNDS = [
  { token: '--text', floor: 4.5 },
  { token: '--text-dim', floor: 4.5 },
  { token: '--text-faint', floor: 3 },
];

/**
 * Hairlines are deliberately quiet, so an absolute floor is the wrong tool —
 * pick one high enough to mean anything and the dark theme fails it too. What
 * matters is that the light theme's separators are no fainter than the dark
 * theme's, which is exactly the way a second theme usually goes wrong.
 */
const BORDER_PAIRS = [
  ['--border', ['--bg']],
  ['--border', ['--bg', '--bg-raised']],
  ['--border-strong', ['--bg']],
  ['--border-stronger', ['--bg']],
  ['--border-soft', ['--bg']],
  ['--border', ['--sidebar']],
];

describe('contrast', () => {
  it('light separators are as present as dark ones', () => {
    for (const [token, stack] of BORDER_PAIRS) {
      const dark = ratio('dark', token, stack);
      const light = ratio('light', token, stack);
      assert.ok(
        light >= dark * 0.85,
        `${token} on ${stack.join(' over ')}: ${light.toFixed(2)}:1 in light vs ${dark.toFixed(2)}:1 in dark`,
      );
    }
  });

  for (const theme of ['dark', 'light']) {
    for (const [name, { stack, only }] of Object.entries(SURFACES)) {
      it(`${theme}: text on the ${name} surface`, () => {
        for (const { token, floor } of FOREGROUNDS) {
          if (only && !only.includes(token)) continue;
          const value = ratio(theme, token, stack);
          assert.ok(
            value >= floor,
            `${token} on ${name} is ${value.toFixed(2)}:1, needs ${floor}:1`,
          );
        }
      });
    }

    it(`${theme}: text sitting on a filled colour`, () => {
      const pairs = [
        ['--text-on-accent', ['--accent'], 4.5],
        ['--text-on-accent', ['--accent-hover'], 4.5],
        ['--text-on-solid', ['--mention'], 4.5],
        ['--text-on-solid', ['--avatar-from'], 4.5],
        ['--text-on-solid', ['--avatar-to'], 4.5],
      ];
      for (const [token, stack, floor] of pairs) {
        const value = ratio(theme, token, stack);
        assert.ok(
          value >= floor,
          `${token} on ${stack.join(' over ')} is ${value.toFixed(2)}:1, needs ${floor}:1`,
        );
      }
    });

    it(`${theme}: state colours used as text`, () => {
      // Tag labels, link text and error copy are all a state colour on a
      // surface, and all of them are small.
      const pairs = [
        ['--accent', ['--bg']],
        ['--accent', ['--bg', '--bg-raised']],
        ['--accent', ['--sidebar']],
        ['--good', ['--bg']],
        ['--good', ['--bg', '--bg-raised']],
        ['--warn', ['--bg']],
        ['--warn', ['--bg', '--bg-raised']],
        ['--bad', ['--bg']],
        ['--bad', ['--bg', '--bg-raised']],
        ['--text-bad', ['--bg']],
        ['--mention-text', ['--bg']],
      ];
      for (const [token, stack] of pairs) {
        const value = ratio(theme, token, stack);
        assert.ok(value >= 4.5, `${token} on ${stack.join(' over ')} is ${value.toFixed(2)}:1`);
      }
    });

    it(`${theme}: borders and dividers are visible against their surface`, () => {
      for (const [token, stack] of BORDER_PAIRS) {
        const value = ratio(theme, token, stack);
        assert.ok(value >= 1.1, `${token} on ${stack.join(' over ')} is only ${value.toFixed(2)}:1`);
      }
    });

    it(`${theme}: hover and selection states are distinguishable from rest`, () => {
      const pairs = [
        [['--bg'], ['--bg', '--hover']],
        [['--bg'], ['--bg', '--hover-faint']],
        [['--sidebar'], ['--sidebar', '--active']],
        [['--bg-button'], ['--bg-button-hover']],
      ];
      for (const [restStack, hoverStack] of pairs) {
        const rest = flatten(theme, restStack);
        const hover = flatten(theme, hoverStack);
        const delta = Math.abs(luminance(rest) - luminance(hover));
        assert.ok(
          delta > 0.0025,
          `${hoverStack.join('+')} is indistinguishable from ${restStack.join('+')} (Δ${delta.toFixed(5)})`,
        );
      }
    });

    it(`${theme}: surfaces stack in the right order`, () => {
      // Coming forward should mean getting lighter in light, and lighter in
      // dark too — a raised card that is darker than the page reads as a hole.
      const page = luminance(flatten(theme, ['--bg']));
      const raised = luminance(flatten(theme, ['--bg-raised']));
      const sunken = luminance(flatten(theme, ['--bg-sunken']));
      if (theme === 'dark') {
        assert.ok(raised > page, 'a raised surface should be lighter than the page in dark');
        assert.ok(sunken < page, 'a sunken surface should be darker than the page in dark');
      } else {
        assert.ok(raised < page, 'a raised surface reads as tinted against white');
        assert.ok(sunken < raised, 'a sunken surface should be deeper than a raised one');
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Resolution rules
// ---------------------------------------------------------------------------

describe('appearance', () => {
  it('resolves the three choices', () => {
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme('dark', true), 'dark');
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('light', false), 'light');
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
  });

  it('falls back rather than throwing on a value it does not know', () => {
    for (const bad of [undefined, null, '', 'sepia', 42, {}]) {
      assert.equal(normalizeAppearance(bad), DEFAULT_APPEARANCE);
    }
    assert.equal(normalizeAppearance('light'), 'light');
  });

  it('the toggle cycles through every choice and comes back', () => {
    let current = 'dark';
    const seen = [];
    for (let i = 0; i < APPEARANCES.length; i++) {
      current = nextAppearance(current);
      seen.push(current);
    }
    assert.equal(seen.length, APPEARANCES.length);
    assert.deepEqual([...seen].sort(), [...APPEARANCES].sort());
    assert.equal(current, 'dark', 'cycling all the way round returns to where it started');
  });

  it('the toggle recovers from a corrupt stored value', () => {
    assert.ok(APPEARANCES.includes(nextAppearance('nonsense')));
  });
});
