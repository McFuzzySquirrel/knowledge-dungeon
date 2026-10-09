/**
 * Phase 8: the shared Cozy token source.
 *
 * The plan's deliverable is a *single machine-readable source of truth* that
 * both React and a future PixiJS host read. This file is the enforceable half of
 * that claim. It checks:
 *
 * 1. Completeness - every declared token reaches a CSS custom property, and no
 *    CSS rule references a `--cozy-*` name the emitter cannot produce.
 * 2. The generated stylesheet matches `src/styles/cozy-tokens.css` byte-for-byte,
 *    so the checked-in CSS cannot drift from the numbers a renderer reads.
 * 3. Contrast - the plan's 4.5:1 text and 3:1 non-text thresholds, recomputed
 *    here from the same `cozyContrastRatio` the tokens were authored with, for
 *    the default Cozy theme *and* the high-contrast variant. The pairs are
 *    derived from the machine-readable token classification rather than listed
 *    by hand, so a new token cannot quietly escape its obligation.
 * 4. The high-contrast variant is a real variant and is not any theme's values.
 * 5. Theme preference mapping is total over every legacy value, and the
 *    generated CSS selectors agree with the mapping table.
 * 6. Reduced motion: tokens exist, the contract is coherent, and the React CSS
 *    honours `prefers-reduced-motion`.
 * 7. The flag is a real gate - the stylesheet carries no unscoped selector, and
 *    `index.html` carries the build-time substitution the scope depends on.
 * 8. No remote font request can be produced by the token or CSS path.
 *
 * Privacy: this file reads only repository source. It records no learner data.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COZY_COLOR_FAMILIES,
  COZY_COLOR_TOKEN_KINDS,
  COZY_COLOR_TOKENS,
  COZY_CONTRAST_MINIMUMS,
  COZY_CONTRAST_VARIANTS,
  COZY_DEFAULT_THEME,
  COZY_FILL_PARTNER_TOKENS,
  COZY_LEGACY_VARIABLE_BRIDGE,
  COZY_NON_TEXT_PARTNER_TOKENS,
  COZY_STATE_SIGNALS,
  COZY_SURFACE_TOKENS,
  COZY_THEMES,
  COZY_THEME_CONTRAST_POLARITY,
  COZY_TOKEN_SCHEMA_VERSION,
  COZY_TOUCH_TARGET_MIN,
  RENDERER_NEUTRAL_THEME_MODULES,
  THEME_BARREL_MODULES,
  COZY_TOUCH_TARGET_MIN_PX,
  resolveCozyColors,
  type CozyColorToken,
  type CozyContrastVariant,
  type CozyTheme,
  type CozyThemeColors,
  type CozyTokenKind,
} from '@/theme/cozyTokens';
import { cozyContrastRatio } from '@/theme/cozyColor';
import {
  COZY_COLOR_PREFIX,
  COZY_CONTRAST_ATTRIBUTE,
  COZY_CONTRAST_HIGH_VALUE,
  COZY_SCALE_PREFIX,
  COZY_VISUALS_ATTRIBUTE,
  COZY_VISUALS_ENABLED_VALUE,
  COZY_VISUALS_ENV_KEY,
  cozyAllVariableNames,
  cozyColorVariable,
  cozyColorVariables,
  cozyGeneratedStyleSheet,
  cozyHighContrastScope,
  cozyScaleVariables,
  cozyScope,
} from '@/theme/cozyCss';
import {
  COZY_MOTION_DURATION_MS,
  COZY_MOTION_TRAVEL_PX,
  FULL_MOTION_SCALE,
  REDUCED_MOTION_DURATION_MS,
  REDUCED_MOTION_SCALE,
  REDUCED_MOTION_TRAVEL_PX,
  resolveMotionProfile,
} from '@/theme/motion';
import { TYPOGRAPHY } from '@/theme/typography';
import {
  COZY_FALLBACK_THEME,
  LEGACY_COLOR_THEME_TO_COZY_THEME,
  LEGACY_COLOR_THEME_VALUES,
  cozyPageSurfaceSelectors,
  cozyThemeForColorTheme,
  cozyThemeSelectors,
} from '@/theme/legacyThemeMap';
import { parseRuntimeConfig } from '@/config/runtimeConfig';

const REPO_ROOT = process.cwd();
const GENERATED_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles', 'cozy-tokens.css');
const COZY_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles', 'cozy.css');
const LEGACY_CSS_PATH = path.join(REPO_ROOT, 'src', 'styles.css');
const INDEX_HTML_PATH = path.join(REPO_ROOT, 'index.html');

const THEMES = Object.keys(COZY_THEMES) as CozyTheme[];
const VARIANTS: readonly CozyContrastVariant[] = ['default', 'highContrast'];

function read(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* Contrast pairs, derived from the token classification                      */
/* -------------------------------------------------------------------------- */

type ContrastKind = 'text' | 'non-text';

interface ContrastPair {
  readonly theme: CozyTheme;
  readonly variant: CozyContrastVariant;
  readonly kind: ContrastKind;
  readonly foreground: CozyColorToken;
  readonly background: CozyColorToken;
  readonly minimum: number;
}

/**
 * Surfaces a foreground token is measured against.
 *
 * `selectionBg` is excluded because the text drawn on a selected control is
 * `textOnSelection` by contract; a generic text token landing on a selection
 * fill is a bug the token roles already prevent.
 */
function backgroundsFor(token: CozyColorToken, kind: CozyTokenKind): CozyColorToken[] {
  if (kind === 'text') {
    return COZY_SURFACE_TOKENS.filter((surface) => surface !== 'selectionBg');
  }
  if (kind === 'nonText') {
    const partner = COZY_NON_TEXT_PARTNER_TOKENS[token as keyof typeof COZY_NON_TEXT_PARTNER_TOKENS];
    // `focusHalo` and `selectionBorder` are drawn inside a fill, so their job is
    // to separate from that fill - not to stand out from the page behind it.
    if (partner) return [partner];
    return COZY_SURFACE_TOKENS.filter((surface) => surface !== 'selectionBg');
  }
  return [];
}

function derivedContrastPairs(): readonly ContrastPair[] {
  const pairs: ContrastPair[] = [];
  for (const theme of THEMES) {
    for (const variant of VARIANTS) {
      const minimums = COZY_CONTRAST_MINIMUMS[variant];
      for (const token of COZY_COLOR_TOKENS) {
        const kind = COZY_COLOR_TOKEN_KINDS[token];
        let foregrounds: ReadonlyArray<{ token: CozyColorToken; kind: ContrastKind }> = [];
        if (kind === 'text' || kind === 'nonText') {
          foregrounds = [{ token, kind: kind === 'text' ? 'text' : 'non-text' }];
        } else if (kind === 'onFill') {
          foregrounds = [{ token, kind: 'text' }];
        }
        for (const foreground of foregrounds) {
          const minimum =
            foreground.kind === 'text' ? minimums.text : minimums.nonText;
          const backgrounds =
            kind === 'onFill'
              ? COZY_FILL_PARTNER_TOKENS[
                  token as keyof typeof COZY_FILL_PARTNER_TOKENS
                ]
              : backgroundsFor(token, kind);
          for (const background of backgrounds) {
            pairs.push({
              theme,
              variant,
              kind: foreground.kind,
              foreground: foreground.token,
              background,
              minimum,
            });
          }
        }
      }
    }
  }
  return pairs;
}

const CONTRAST_PAIRS = derivedContrastPairs();

/* -------------------------------------------------------------------------- */

describe('Phase 8 Cozy token source', () => {
  it('declares a schema version and the five named families from the plan', () => {
    expect(COZY_TOKEN_SCHEMA_VERSION).toBe('1.0.0');
    expect(Object.keys(COZY_THEMES)).toHaveLength(4);
    // warm parchment, moss, berry, ink, firelight - read from the token source
    // rather than grepped out of it, so freezing or reformatting a family cannot
    // make this pass or fail for a reason that has nothing to do with the claim.
    expect(Object.keys(COZY_COLOR_FAMILIES).sort()).toEqual([
      'berry',
      'firelight',
      'ink',
      'moss',
      'parchment',
    ]);
    const families = read(path.join(REPO_ROOT, 'src', 'theme', 'cozyTokens.ts'));
    for (const family of ['parchment', 'moss', 'berry', 'ink', 'firelight']) {
      expect(families).toContain(family);
    }
  });

  it('classifies every semantic colour token exactly once', () => {
    expect(COZY_COLOR_TOKENS.length).toBeGreaterThanOrEqual(24);
    expect(new Set(COZY_COLOR_TOKENS).size).toBe(COZY_COLOR_TOKENS.length);
    for (const token of COZY_COLOR_TOKENS) {
      expect(COZY_COLOR_TOKEN_KINDS[token], token).toBeDefined();
    }
    // Every key of the classification is emitted; nothing is declared twice.
    expect(Object.keys(COZY_COLOR_TOKEN_KINDS).sort()).toEqual([...COZY_COLOR_TOKENS].sort());
  });

  it('gives every theme and every high-contrast variant a complete token set', () => {
    for (const theme of THEMES) {
      for (const variant of VARIANTS) {
        const colors = resolveCozyColors(theme, variant);
        expect(Object.keys(colors).sort(), `${theme}/${variant}`).toEqual(
          [...COZY_COLOR_TOKENS].sort(),
        );
        for (const token of COZY_COLOR_TOKENS) {
          expect(colors[token], `${theme}/${variant}/${token}`).toMatch(
            /^#[0-9a-f]{6}$/i,
          );
        }
      }
    }
    for (const [polarity, colors] of Object.entries(COZY_CONTRAST_VARIANTS)) {
      expect(Object.keys(colors).sort(), polarity).toEqual([...COZY_COLOR_TOKENS].sort());
    }
  });
});

describe('Cozy token emission to CSS custom properties', () => {
  it('emits every declared colour token to a namespaced custom property', () => {
    for (const theme of THEMES) {
      const variables = cozyColorVariables(resolveCozyColors(theme, 'default'));
      for (const token of COZY_COLOR_TOKENS) {
        const name = cozyColorVariable(token);
        expect(name.startsWith(`${COZY_COLOR_PREFIX}-`), name).toBe(true);
        expect(variables[name], `${theme}/${token}`).toBe(resolveCozyColors(theme)[token]);
      }
      expect(Object.keys(variables)).toHaveLength(COZY_COLOR_TOKENS.length);
    }
  });

  it('emits the non-colour scales: panel radius, spacing, type, focus, motion, target', () => {
    const scales = cozyScaleVariables();
    for (const expected of [
      `${COZY_SCALE_PREFIX}-radius-panel`,
      `${COZY_SCALE_PREFIX}-radius-md`,
      `${COZY_SCALE_PREFIX}-space-4`,
      `${COZY_SCALE_PREFIX}-border-hairline`,
      `${COZY_SCALE_PREFIX}-border-state`,
      `${COZY_SCALE_PREFIX}-border-focus`,
      `${COZY_SCALE_PREFIX}-font-size-md`,
      `${COZY_SCALE_PREFIX}-line-height-normal`,
      `${COZY_SCALE_PREFIX}-font-weight-bold`,
      `${COZY_SCALE_PREFIX}-duration-base`,
      `${COZY_SCALE_PREFIX}-easing-standard`,
      `${COZY_SCALE_PREFIX}-focus-ring-width`,
      `${COZY_SCALE_PREFIX}-focus-halo-width`,
      `${COZY_SCALE_PREFIX}-target-min`,
      `${COZY_SCALE_PREFIX}-motion-scale`,
    ]) {
      expect(scales, expected).toHaveProperty(expected);
    }
    expect(scales[`${COZY_SCALE_PREFIX}-target-min`]).toBe(`${COZY_TOUCH_TARGET_MIN_PX}px`);
    expect(COZY_TOUCH_TARGET_MIN_PX).toBeGreaterThanOrEqual(44);
    expect(COZY_TOUCH_TARGET_MIN).toBe(COZY_TOUCH_TARGET_MIN_PX);
  });

  it('gives the colour and scale namespaces disjoint names', () => {
    const names = cozyAllVariableNames();
    expect(new Set(names).size, 'duplicate custom property name').toBe(names.length);
    const colorNames = new Set(
      THEMES.flatMap((theme) => Object.keys(cozyColorVariables(COZY_THEMES[theme]))),
    );
    for (const name of colorNames) expect(name.startsWith(`${COZY_COLOR_PREFIX}-`)).toBe(true);
    for (const name of Object.keys(cozyScaleVariables())) {
      expect(name.startsWith(`${COZY_SCALE_PREFIX}-`)).toBe(true);
      expect(colorNames.has(name)).toBe(false);
    }
  });

  it('bridges every legacy semantic variable the existing stylesheet consumes', () => {
    const legacyCss = read(LEGACY_CSS_PATH);
    for (const variable of Object.keys(COZY_LEGACY_VARIABLE_BRIDGE)) {
      expect(legacyCss, `legacy stylesheet no longer defines ${variable}`).toContain(
        `${variable}:`,
      );
    }
    // The bridge must not reach the legacy `--kd-*` aliases: those belong to the
    // pre-Cozy Phaser palette in src/theme/colors.ts and are not Phase 8's to change.
    for (const variable of Object.keys(COZY_LEGACY_VARIABLE_BRIDGE)) {
      expect(variable.startsWith('--kd-'), variable).toBe(false);
    }
  });

  it('references no --cozy-* custom property the emitter cannot produce', () => {
    const declared = new Set(cozyAllVariableNames());
    const allReferenced = new Set<string>();
    for (const filePath of [GENERATED_CSS_PATH, COZY_CSS_PATH]) {
      const css = read(filePath);
      for (const match of css.matchAll(/var\(\s*(--cozy-[\w-]+)/g)) {
        allReferenced.add(match[1]);
        expect(
          declared.has(match[1]),
          `${path.basename(filePath)} references undeclared ${match[1]}`,
        ).toBe(true);
      }
    }
    // Sanity: the scan itself is looking at something.
    expect(allReferenced.size).toBeGreaterThan(10);
  });

  it('generates src/styles/cozy-tokens.css byte-for-byte', () => {
    const expected = cozyGeneratedStyleSheet(cozyThemeSelectors(), cozyPageSurfaceSelectors());
    const actual = read(GENERATED_CSS_PATH);
    // The banner comment is hand-written; everything after it is generated.
    const generatedStart = actual.indexOf('/* Document-level Cozy defaults');
    expect(generatedStart, 'generated section marker missing').toBeGreaterThan(-1);
    const banner = actual.slice(0, generatedStart);
    expect(banner).toContain(COZY_VISUALS_ATTRIBUTE);
    expect(banner).toContain(COZY_VISUALS_ENV_KEY);
    expect(actual.slice(generatedStart)).toBe(expected);
  });
});

describe('Cozy token contrast', () => {
  it('derives a non-empty pair list that covers text and non-text obligations', () => {
    expect(CONTRAST_PAIRS.length).toBeGreaterThan(200);
    expect(CONTRAST_PAIRS.some((pair) => pair.kind === 'text')).toBe(true);
    expect(CONTRAST_PAIRS.some((pair) => pair.kind === 'non-text')).toBe(true);
  });

  it.each(
    CONTRAST_PAIRS.map(
      (pair) =>
        `${pair.theme} ${pair.variant} ${pair.kind} ${pair.foreground} on ${pair.background}` as const,
    ),
  )('meets WCAG AA for %s', (_label, ...rest) => {
    const index = CONTRAST_PAIRS.findIndex(
      (pair) =>
        `${pair.theme} ${pair.variant} ${pair.kind} ${pair.foreground} on ${pair.background}` ===
        _label,
    );
    const pair = CONTRAST_PAIRS[index];
    const colors: CozyThemeColors = resolveCozyColors(pair.theme, pair.variant);
    const ratio = cozyContrastRatio(colors[pair.foreground], colors[pair.background]);
    expect(
      ratio,
      `${pair.foreground} ${colors[pair.foreground]} on ${pair.background} ${colors[pair.background]} = ${ratio.toFixed(2)}:1, needs ${pair.minimum}:1`,
    ).toBeGreaterThanOrEqual(pair.minimum);
    void rest;
  });

  it('applies the plan thresholds, and stricter ones to the high-contrast variant', () => {
    expect(COZY_CONTRAST_MINIMUMS.default).toEqual({ text: 4.5, nonText: 3 });
    expect(COZY_CONTRAST_MINIMUMS.highContrast.text).toBeGreaterThanOrEqual(7);
    expect(COZY_CONTRAST_MINIMUMS.highContrast.nonText).toBeGreaterThanOrEqual(4.5);
  });

  it('treats only borderHairline as decorative, and never on a control boundary', () => {
    const decorative = COZY_COLOR_TOKENS.filter(
      (token) => COZY_COLOR_TOKEN_KINDS[token] === 'decorative',
    );
    expect(decorative).toEqual(['borderHairline']);

    // The hand-written Cozy layer must use the >= 3:1 token, not the decorative
    // one, for anything a learner has to identify.
    const cozyCss = read(COZY_CSS_PATH);
    const decorativeUses = [...cozyCss.matchAll(/var\((--cozy-c-border-hairline)\)/g)];
    for (const match of decorativeUses) {
      const line = cozyCss
        .slice(0, match.index)
        .split('\n')
        .slice(-6)
        .join('\n');
      expect(line, 'borderHairline is decorative and must not bound a control').not.toMatch(
        /button|input|select|\[aria-(selected|pressed|expanded)\]|:focus-visible/,
      );
    }
  });
});

describe('Cozy high-contrast variant', () => {
  it('is a real variant, not a copy of any theme', () => {
    for (const [polarity, colors] of Object.entries(COZY_CONTRAST_VARIANTS)) {
      for (const theme of THEMES) {
        const differs = COZY_COLOR_TOKENS.filter(
          (token) => colors[token] !== COZY_THEMES[theme][token],
        );
        expect(differs.length, `${polarity} vs ${theme}`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('is reachable from every theme and from both the attribute and the media query', () => {
    for (const theme of THEMES) {
      const colors = resolveCozyColors(theme, 'highContrast');
      const polarity = COZY_THEME_CONTRAST_POLARITY[theme];
      expect(colors).toEqual(COZY_CONTRAST_VARIANTS[polarity]);
    }
    const css = read(GENERATED_CSS_PATH);
    expect(css).toContain(`[${COZY_CONTRAST_ATTRIBUTE}='${COZY_CONTRAST_HIGH_VALUE}']`);
    expect(css).toContain('@media (prefers-contrast: more)');
    expect(cozyHighContrastScope()).toContain(`[${COZY_VISUALS_ATTRIBUTE}='true']`);
  });

  it('reaches the stricter high-contrast thresholds for all four themes', () => {
    const minimums = COZY_CONTRAST_MINIMUMS.highContrast;
    for (const theme of THEMES) {
      const colors = resolveCozyColors(theme, 'highContrast');
      for (const surface of COZY_SURFACE_TOKENS) {
        if (surface === 'selectionBg') continue;
        for (const token of COZY_COLOR_TOKENS) {
          if (COZY_COLOR_TOKEN_KINDS[token] !== 'text') continue;
          const ratio = cozyContrastRatio(colors[token], colors[surface]);
          expect(
            ratio,
            `${theme} high-contrast ${token} on ${surface} = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(minimums.text);
        }
      }
    }
  });
});

describe('Cozy theme preference mapping', () => {
  it('maps every legacy colour-theme value, aliases included, onto a defined theme', () => {
    expect([...LEGACY_COLOR_THEME_VALUES].sort()).toEqual(
      ['aurora', 'colorful', 'dark', 'light', 'sepia'],
    );
    for (const value of LEGACY_COLOR_THEME_VALUES) {
      const theme = cozyThemeForColorTheme(value);
      expect(THEMES, `${value} -> ${theme}`).toContain(theme);
      expect(cozyThemeForColorTheme(value)).toBe(LEGACY_COLOR_THEME_TO_COZY_THEME[value]);
    }
  });

  it('reaches every Cozy theme from some persisted preference', () => {
    const reached = new Set(Object.values(LEGACY_COLOR_THEME_TO_COZY_THEME));
    for (const theme of THEMES) expect(reached, theme).toContain(theme);
  });

  it('never throws on an absent, unknown, or corrupt preference', () => {
    for (const input of [null, undefined, '', 'sepia-dark', 'CINZEL', 0 as unknown as string]) {
      expect(cozyThemeForColorTheme(input)).toBe(COZY_FALLBACK_THEME);
    }
    expect(COZY_FALLBACK_THEME).toBe(COZY_DEFAULT_THEME);
  });

  it('keeps the legacy alias behaviour byte-for-byte: light and sepia still resolve to dark', async () => {
    const { resolveInitialColorTheme, resolveInitialCozyTheme } = await import(
      '@/store/preferencesStore'
    );
    for (const value of ['light', 'sepia'] as const) {
      expect(resolveInitialColorTheme({ colorTheme: value })).toBe('dark');
    }
    for (const value of ['dark', 'colorful', 'aurora'] as const) {
      expect(resolveInitialColorTheme({ colorTheme: value })).toBe(value);
    }
    expect(resolveInitialColorTheme(null)).toBe('dark');
    // The Cozy mapping is derived from the *persisted* value, so a restored
    // `sepia` still lands on parchment rather than inheriting dark's ink.
    expect(resolveInitialCozyTheme({ colorTheme: 'sepia' })).toBe('cozy-parchment');
    expect(resolveInitialCozyTheme({ colorTheme: 'light' })).toBe('cozy-parchment');
    expect(resolveInitialCozyTheme({ colorTheme: 'colorful' })).toBe('cozy-berry');
    expect(resolveInitialCozyTheme({ colorTheme: 'aurora' })).toBe('cozy-firelight');
    expect(resolveInitialCozyTheme(null)).toBe(COZY_FALLBACK_THEME);
  });

  it('generates the CSS theme selectors from the mapping table, not by hand', () => {
    const selectors = cozyThemeSelectors();
    const generated = read(GENERATED_CSS_PATH);
    for (const value of LEGACY_COLOR_THEME_VALUES) {
      const theme = LEGACY_COLOR_THEME_TO_COZY_THEME[value];
      expect(selectors[theme], value).toContain(`.ui-skin[data-theme='${value}']`);
      expect(generated).toContain(`.ui-skin[data-theme='${value}']`);
    }
    for (const theme of THEMES) {
      expect(selectors[theme].length, theme).toBeGreaterThan(0);
    }
    const pageSurfaces = cozyPageSurfaceSelectors();
    for (const theme of THEMES) {
      expect(pageSurfaces[theme].length, theme).toBeGreaterThan(0);
      for (const selector of pageSurfaces[theme]) expect(selector).toContain(':has(');
    }
  });
});

describe('Cozy flag gate', () => {
  it('defaults true after the cutover, with a documented false rollback', () => {
    // Phase 23 makes the Cozy visual system the production default; `false` is the
    // one-release rollback to the legacy renderer themes.
    const parsed = parseRuntimeConfig({});
    expect(parsed.cozyVisuals).toBe(true);
    expect(parseRuntimeConfig({ VITE_COZY_VISUALS: 'false' }).cozyVisuals).toBe(false);
    expect(parseRuntimeConfig({ VITE_COZY_VISUALS: 'true' }).cozyVisuals).toBe(true);
  });

  it('scopes every rule in both Cozy stylesheets so the flag-off build renders legacy', () => {
    for (const filePath of [GENERATED_CSS_PATH, COZY_CSS_PATH]) {
      const css = read(filePath);
      // Strip comments, then every selector must sit under the flag scope.
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const selectors = [...withoutComments.matchAll(/^([^{}@]+)\{/gm)].map((m) => m[1].trim());
      expect(selectors.length, filePath).toBeGreaterThan(0);
      for (const selector of selectors) {
        for (const part of selector.split(',').map((s) => s.trim())) {
          expect(part, `${path.basename(filePath)}: ${part}`).toContain(
            `${COZY_VISUALS_ATTRIBUTE}='${COZY_VISUALS_ENABLED_VALUE}'`,
          );
        }
      }
    }
  });

  it('derives the scope selector from the one the stylesheet uses', () => {
    expect(cozyScope()).toBe(`[${COZY_VISUALS_ATTRIBUTE}='${COZY_VISUALS_ENABLED_VALUE}']`);
    expect(read(GENERATED_CSS_PATH)).toContain(cozyScope());
  });

  it('has index.html carry the build-time substitution the scope depends on', () => {
    const html = read(INDEX_HTML_PATH);
    expect(html).toContain(`${COZY_VISUALS_ATTRIBUTE}="%${COZY_VISUALS_ENV_KEY}%"`);
    expect(html).toMatch(/<html[^>]*\sdata-cozy-visuals=/);
  });
});

describe('Cozy reduced motion', () => {
  it('defines the token set and the numeric contract a renderer reads', () => {
    expect(FULL_MOTION_SCALE).toBe(1);
    expect(REDUCED_MOTION_SCALE).toBe(0);
    expect(REDUCED_MOTION_DURATION_MS).toBe(0);
    expect(REDUCED_MOTION_TRAVEL_PX).toBe(0);
    expect(COZY_MOTION_DURATION_MS.base).toBeGreaterThan(0);
    expect(COZY_MOTION_TRAVEL_PX.medium).toBeGreaterThan(0);
  });

  it('zeroes every duration and distance under reduced motion, and keeps them otherwise', () => {
    const reduced = resolveMotionProfile(true);
    const full = resolveMotionProfile(false);
    expect(reduced.reduced).toBe(true);
    expect(reduced.reduceAll).toBe(true);
    expect(reduced.scale).toBe(REDUCED_MOTION_SCALE);
    expect(full.reduced).toBe(false);
    expect(full.scale).toBe(FULL_MOTION_SCALE);
    for (const name of Object.keys(COZY_MOTION_DURATION_MS) as (keyof typeof COZY_MOTION_DURATION_MS)[]) {
      expect(reduced.durationMs(name), name).toBe(0);
      expect(full.durationMs(name), name).toBe(COZY_MOTION_DURATION_MS[name]);
    }
    for (const name of Object.keys(COZY_MOTION_TRAVEL_PX) as (keyof typeof COZY_MOTION_TRAVEL_PX)[]) {
      expect(reduced.travelPx(name), name).toBe(0);
      expect(full.travelPx(name), name).toBe(COZY_MOTION_TRAVEL_PX[name]);
    }
    // Immutable, so a host cannot mutate the shared profile for everyone else.
    expect(Object.isFrozen(reduced)).toBe(true);
    expect(Object.isFrozen(reduced.serialized)).toBe(true);
  });

  it('honours prefers-reduced-motion in the React CSS', () => {
    const cozyCss = read(COZY_CSS_PATH);
    const block = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(cozyCss);
    expect(block, 'no prefers-reduced-motion block in the Cozy layer').not.toBeNull();
    const body = block?.[0] ?? '';
    expect(body).toContain(`${COZY_SCALE_PREFIX}-motion-scale: 0`);
    expect(body).toContain(`${COZY_SCALE_PREFIX}-duration-base: 0ms`);
    expect(body).toContain('animation-duration: 0.01ms !important');
    expect(body).toContain('transition-duration: 0.01ms !important');
    expect(body).toContain(`${COZY_VISUALS_ATTRIBUTE}='${COZY_VISUALS_ENABLED_VALUE}'`);
  });

  it('does not remove the reduced-motion handling that predates Phase 8', () => {
    const legacyCss = read(LEGACY_CSS_PATH);
    expect(legacyCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(legacyCss).toContain('.migration-backdrop');
    expect(legacyCss).toContain('.migration-progress::after');
  });
});

describe('Cozy focus and state signals', () => {
  it('gives every state a non-colour signal', () => {
    expect(Object.keys(COZY_STATE_SIGNALS).sort()).toEqual(
      ['complete', 'disabled', 'focus', 'hover', 'selected'].sort(),
    );
    for (const [name, signal] of Object.entries(COZY_STATE_SIGNALS)) {
      expect(signal.length, name).toBeGreaterThan(0);
    }
  });

  it('implements focus as an outline plus a halo, not a tint', () => {
    const cozyCss = read(COZY_CSS_PATH);
    expect(cozyCss).toContain(':focus-visible {');
    expect(cozyCss).toMatch(
      /outline: var\(--cozy-s-focus-ring-width\) solid var\(--cozy-c-border-focus\);/,
    );
    expect(cozyCss).toContain('outline-offset: var(--cozy-s-focus-ring-offset)');
    expect(cozyCss).toContain('box-shadow: 0 0 0 var(--cozy-s-focus-halo-width)');
    // A halo that is not itself distinguishable from the ring is decoration.
    for (const theme of THEMES) {
      const colors = COZY_THEMES[theme];
      expect(
        cozyContrastRatio(colors.focusHalo, colors.borderFocus),
        `${theme} focus halo vs ring`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('implements selection with border weight, text weight, and a bar', () => {
    const cozyCss = read(COZY_CSS_PATH);
    const block = cozyCss.slice(cozyCss.indexOf("button[aria-selected='true']"));
    const section = block.slice(0, block.indexOf('/*', 5));
    expect(section).toContain('border-width: var(--cozy-s-border-state)');
    expect(section).toContain('font-weight: var(--cozy-s-font-weight-bold)');
    expect(section).toContain('inset 0 -3px 0 0');
  });

  it('keeps the Phase 1 recorded contrast defect from getting worse under Cozy', () => {
    const cozyCss = read(COZY_CSS_PATH);
    expect(cozyCss).toContain('.welcome-checklist-status--done');
    // The Cozy rule must not keep the 10% transparent tint the legacy rule uses;
    // a solid surface is what lets `good` clear 4.5:1.
    const block = cozyCss.slice(cozyCss.indexOf('[data-cozy-visuals=\'true\'] .welcome-checklist-status--done'));
    const section = block.slice(0, block.indexOf('}'));
    expect(section).toContain('background: var(--cozy-c-surface-panel-soft)');
    expect(section).not.toContain('10%, transparent');
    for (const theme of THEMES) {
      const colors = COZY_THEMES[theme];
      const ratio = cozyContrastRatio(colors.good, colors.surfacePanelSoft);
      expect(ratio, `${theme} good on surfacePanelSoft`).toBeGreaterThanOrEqual(4.5);
    }
    // The legacy rule itself is untouched, so the flag-off build still shows the
    // recorded defect that Phase 21 owns.
    expect(read(LEGACY_CSS_PATH)).toContain('color-mix(in srgb, var(--good) 10%, transparent)');
  });
});

describe('Cozy font path', () => {
  it('produces no remote font request from the token or CSS path', () => {
    for (const filePath of [
      GENERATED_CSS_PATH,
      COZY_CSS_PATH,
      LEGACY_CSS_PATH,
      INDEX_HTML_PATH,
      path.join(REPO_ROOT, 'src', 'theme', 'typography.ts'),
      path.join(REPO_ROOT, 'src', 'theme', 'cozyTokens.ts'),
      path.join(REPO_ROOT, 'src', 'theme', 'cozyCss.ts'),
      path.join(REPO_ROOT, 'src', 'theme', 'cozyColor.ts'),
      path.join(REPO_ROOT, 'src', 'theme', 'motion.ts'),
      path.join(REPO_ROOT, 'src', 'theme', 'legacyThemeMap.ts'),
      path.join(REPO_ROOT, 'src', 'theme', 'colors.ts'),
      path.join(REPO_ROOT, 'src', 'theme', 'icons.ts'),
    ]) {
      // Comments are prose about the removal; the claim is about declarations.
      const contents = read(filePath)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/<!--[\s\S]*?-->/g, '');
      expect(contents, `${path.basename(filePath)} references a remote font host`).not.toMatch(
        /fonts\.googleapis\.com|fonts\.gstatic\.com|@font-face|@import\s+url\(/i,
      );
    }
  });

  it('resolves every font stack to locally available families', () => {
    // Each role's first entry is a CSS generic or a platform UI font, so the
    // stack never depends on a face that would have to be downloaded.
    const expectedGeneric: Readonly<Record<keyof typeof TYPOGRAPHY, string>> = {
      primary: 'ui-rounded',
      body: 'system-ui',
      mono: 'ui-monospace',
    };
    for (const [name, stack] of Object.entries(TYPOGRAPHY) as [
      keyof typeof TYPOGRAPHY,
      string,
    ][]) {
      expect(stack, `${name} must not name a remotely loaded face`).not.toMatch(
        /Cinzel|Inter|JetBrains/,
      );
      expect(stack, `${name} must end in a generic family`).toMatch(
        /(serif|sans-serif|monospace)\s*$/,
      );
      expect(stack.split(',')[0].trim(), `${name} first entry`).toBe(
        expectedGeneric[name],
      );
    }
  });

  it('keeps the legacy stylesheet font variables in step with the token module', () => {
    const legacyCss = read(LEGACY_CSS_PATH);
    expect(legacyCss).toContain(`--font-game: ${TYPOGRAPHY.primary};`);
    expect(legacyCss).toContain(`--font-mono: ${TYPOGRAPHY.mono};`);
    expect(legacyCss).toContain(`font-family: ${TYPOGRAPHY.body};`);
    const scales = cozyScaleVariables();
    expect(scales[`${COZY_SCALE_PREFIX}-font-game`]).toBe(TYPOGRAPHY.primary);
    expect(scales[`${COZY_SCALE_PREFIX}-font-mono`]).toBe(TYPOGRAPHY.mono);
    expect(scales[`${COZY_SCALE_PREFIX}-font-body`]).toBe(TYPOGRAPHY.body);
  });

  it('leaves no hardcoded remote-font family anywhere in the stylesheet', () => {
    const legacyCss = read(LEGACY_CSS_PATH).replace(/\/\*[\s\S]*?\*\//g, '');
    const stacks = Object.values(TYPOGRAPHY);
    // Every declaration that names a family must name one of the token stacks,
    // so the stylesheet and the renderer-facing values cannot drift apart.
    for (const declaration of legacyCss.matchAll(/font-family:\s*([^;]+);/g)) {
      const value = declaration[1].trim();
      if (value.startsWith('var(')) continue;
      expect(stacks, `font-family: ${value}`).toContain(value);
    }
  });

  it('reaches the Cozy stylesheets from the legacy entry point', () => {
    const legacyCss = read(LEGACY_CSS_PATH);
    expect(legacyCss).toContain("@import './styles/cozy.css';");
    expect(read(COZY_CSS_PATH)).toContain("@import './cozy-tokens.css';");
  });
});

describe('Cozy token module inventory', () => {
  it('declares every file that lives directly in src/theme', () => {
    const declared = new Set<string>([...RENDERER_NEUTRAL_THEME_MODULES, ...THEME_BARREL_MODULES]);
    const onDisk = readdirSync(path.join(REPO_ROOT, 'src', 'theme'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
    expect(onDisk, 'an unclassified module exists in src/theme').toEqual([...declared].sort());
  });
});
