/**
 * Phase 8: the integrity contract of the shared Cozy token source.
 *
 * `cozy-tokens.test.ts` proves the token source is *complete* - every token
 * reaches a custom property, the contrast obligations hold, the generated CSS
 * matches the file. This file proves the two properties that make it *shared*
 * rather than merely common, which are also the only two ways a shared source
 * can quietly break:
 *
 * 1. **Nothing can edit it.** A token literal is a module-level constant read by
 *    React and by every renderer host. `resolveCozyColors` handed back the live
 *    constant, so one host writing `colors.accent = '#ff0000'` silently repainted
 *    the whole application for the rest of the session. No value-comparing test
 *    could have seen that, because nothing about the *values* changed. These
 *    tests assert the mechanism - every exported literal is frozen, nested
 *    objects included - and then the observable consequence: after a consumer has
 *    tried to mutate what it was handed, the emitter and the next reader see the
 *    same tokens they saw before.
 * 2. **Nothing can starve it.** The value a host actually holds is the persisted
 *    *legacy* string (`dark`, `light`, `sepia`, `colorful`, `aurora`), not a
 *    `CozyTheme`, and `resolveCozyColors` indexed straight into `COZY_THEMES` -
 *    so `resolveCozyColors('sepia', 'default').surfacePage` threw a `TypeError` on
 *    a legal stored value. These tests assert totality over every value a host
 *    can hold, and that the result agrees with the migration table rather than
 *    with a second, drifting copy of it.
 *
 * The mutation tests are written against the *observable* guarantee rather than
 * against one particular defence: a consumer that tries to mutate is allowed to
 * throw, and would be allowed to succeed, as long as nothing anyone else can
 * observe changes. Pinning the mechanism separately is what keeps the two apart.
 *
 * Privacy: this file reads no persisted state, no learner data, and no network.
 * It calls the token source with literal inputs only.
 */

import { describe, expect, it } from 'vitest';

import * as cozyCss from '@/theme/cozyCss';
import * as cozyTokens from '@/theme/cozyTokens';
import * as legacyThemeMap from '@/theme/legacyThemeMap';
import * as motion from '@/theme/motion';
import * as typography from '@/theme/typography';
import {
  COZY_BORDER_WIDTH,
  COZY_COLOR_FAMILIES,
  COZY_COLOR_TOKEN_KINDS,
  COZY_COLOR_TOKENS,
  COZY_CONTRAST_VARIANTS,
  COZY_DEFAULT_THEME,
  COZY_FALLBACK_THEME,
  COZY_FOCUS,
  COZY_FONT_SIZE,
  COZY_FONT_WEIGHT,
  COZY_LEGACY_VARIABLE_BRIDGE,
  COZY_LINE_HEIGHT,
  COZY_MOTION_DURATION_MS,
  COZY_MOTION_EASING,
  COZY_MOTION_TRAVEL_PX,
  COZY_RADIUS,
  COZY_SCALE_PREFIX,
  COZY_SPACE,
  COZY_THEME_COLOR_SCHEME,
  COZY_THEME_CONTRAST_POLARITY,
  COZY_THEMES,
  LEGACY_COLOR_THEME_TO_COZY_THEME,
  TYPOGRAPHY,
  cozyGeneratedStyleSheet,
  cozyPageSurfaceSelectors,
  cozyScaleVariables,
  cozyThemeForColorTheme,
  cozyThemeSelectors,
  resolveCozyColors,
  resolveCozyColorsForPreference,
  type CozyContrastVariant,
  type CozyTheme,
} from '@/theme';

const THEMES = Object.keys(COZY_THEMES) as CozyTheme[];
const VARIANTS: readonly CozyContrastVariant[] = ['default', 'highContrast'];

/**
 * The Cozy token modules whose exported literals must be frozen.
 *
 * `colors.ts` and `icons.ts` are absent deliberately: they are the pre-Cozy
 * palette and icon set rather than the Phase 8 token source, and were not part
 * of the reported defect. The sweep covers the token core, which is what a
 * renderer host is expected to import.
 */
const TOKEN_MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'cozyTokens.ts': cozyTokens,
  'cozyCss.ts': cozyCss,
  'legacyThemeMap.ts': legacyThemeMap,
  'motion.ts': motion,
  'typography.ts': typography,
};

/** A colour a mutating consumer might reach for, and that no real token uses. */
const NOT_A_TOKEN_COLOUR = '#ff0000';

/**
 * Every value a host can hold in a *preference* slot: the five persisted
 * colour-theme values, values that are not preferences at all, and the two
 * absences. A Cozy theme name is deliberately not in this list - it is not a
 * persisted value, so it is held to the other rule and tested separately.
 */
const PREFERENCE_INPUTS: Readonly<Record<string, string | null | undefined>> = {
  ...Object.fromEntries(
    (['dark', 'light', 'sepia', 'colorful', 'aurora'] as const).map((value) => [value, value]),
  ),
  'cozy-nope': 'cozy-nope',
  'wrong case': 'Cozy-Ink',
  // Inherited object keys: `in` walks the prototype chain, so a table lookup
  // that used it would report these as known values and hand back a function.
  'inherited toString': 'toString',
  'inherited constructor': 'constructor',
  empty: '',
  null: null,
  undefined: undefined,
};

function generatedSheet(): string {
  return cozyGeneratedStyleSheet(cozyThemeSelectors(), cozyPageSurfaceSelectors());
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null || Array.isArray(value);
}

/** Dotted paths of every object in the tree that is not frozen. */
function unfrozenPaths(value: object, trail: readonly string[]): string[] {
  const unfrozen = Object.isFrozen(value) ? [] : [trail.join('.')];
  for (const [key, child] of Object.entries(value)) {
    if (!isPlainContainer(child)) continue;
    unfrozen.push(...unfrozenPaths(child, [...trail, key]));
  }
  return unfrozen;
}

/**
 * Attempt a write and report what happened, without failing the test on the
 * throw itself.
 *
 * `Object.assign` performs the same property write as the reported line
 * (`colors.accent = '#ff0000'`) without a type-level cast, and throws in strict
 * mode - which all module code is - when the target is frozen. A
 * copy-returning resolver would report `applied`; both are acceptable, and the
 * assertions that follow hold either way.
 */
function attemptWrite(target: object, source: Record<string, unknown>): 'applied' | 'rejected' {
  try {
    Object.assign(target, source);
    return 'applied';
  } catch {
    return 'rejected';
  }
}

describe('Cozy token literals are frozen', () => {
  it('freezes every exported data literal in the token core, nested objects included', () => {
    const unfrozen: string[] = [];
    for (const [moduleName, moduleExports] of Object.entries(TOKEN_MODULES)) {
      for (const [name, value] of Object.entries(moduleExports)) {
        if (!isPlainContainer(value)) continue;
        unfrozen.push(...unfrozenPaths(value, [moduleName, name]));
      }
    }
    expect(
      unfrozen,
      `a shared token literal is not frozen, so any consumer can edit it:\n${unfrozen.join('\n')}`,
    ).toEqual([]);
  });

  it('freezes the literals a renderer host reads directly', () => {
    // Spelled out as well as swept above, because these are the ones the
    // reported defect named: a host holds these references, and the freeze
    // exists for the host.
    for (const literal of [
      COZY_THEMES,
      COZY_CONTRAST_VARIANTS,
      COZY_COLOR_FAMILIES,
      COZY_COLOR_TOKEN_KINDS,
      COZY_RADIUS,
      COZY_SPACE,
      COZY_BORDER_WIDTH,
      COZY_FONT_SIZE,
      COZY_LINE_HEIGHT,
      COZY_FONT_WEIGHT,
      COZY_FOCUS,
      COZY_MOTION_DURATION_MS,
      COZY_MOTION_EASING,
      COZY_MOTION_TRAVEL_PX,
      TYPOGRAPHY,
    ]) {
      expect(Object.isFrozen(literal)).toBe(true);
    }
    // The nested level is where a host actually writes: one theme recipe, one
    // contrast variant, one colour family.
    for (const recipe of Object.values(COZY_THEMES)) {
      expect(Object.isFrozen(recipe)).toBe(true);
    }
    for (const variant of Object.values(COZY_CONTRAST_VARIANTS)) {
      expect(Object.isFrozen(variant)).toBe(true);
    }
    for (const family of Object.values(COZY_COLOR_FAMILIES)) {
      expect(Object.isFrozen(family)).toBe(true);
    }
  });

  it('hands back the shared frozen recipe rather than a copy that could go stale', () => {
    for (const theme of THEMES) {
      for (const variant of VARIANTS) {
        const colors = resolveCozyColors(theme, variant);
        const expected =
          variant === 'default'
            ? COZY_THEMES[theme]
            : COZY_CONTRAST_VARIANTS[COZY_THEME_CONTRAST_POLARITY[theme]];
        expect(Object.isFrozen(colors), `${theme}/${variant}`).toBe(true);
        expect(colors, `${theme}/${variant}`).toBe(expected);
      }
    }
  });
});

describe('A consumer cannot edit the shared token source', () => {
  it('leaves the emitter and the next reader unchanged after an in-place edit', () => {
    const sheetBefore = generatedSheet();
    const accentsBefore = THEMES.map((theme) => COZY_THEMES[theme].accent);

    for (const theme of THEMES) {
      for (const variant of VARIANTS) {
        const colors = resolveCozyColors(theme, variant);
        const expected =
          variant === 'default'
            ? COZY_THEMES[theme]
            : COZY_CONTRAST_VARIANTS[COZY_THEME_CONTRAST_POLARITY[theme]];

        attemptWrite(colors, { accent: NOT_A_TOKEN_COLOUR });

        expect(
          resolveCozyColors(theme, variant).accent,
          `${theme}/${variant} was changed through the object it handed out`,
        ).toBe(expected.accent);
        expect(generatedSheet(), `${theme}/${variant} changed the generated CSS`).toBe(
          sheetBefore,
        );
      }
    }

    expect(THEMES.map((theme) => COZY_THEMES[theme].accent)).toEqual(accentsBefore);
    expect(sheetBefore).not.toContain(NOT_A_TOKEN_COLOUR);
    expect(sheetBefore).toContain(`--cozy-c-accent: ${COZY_THEMES[COZY_DEFAULT_THEME].accent};`);
  });

  it('keeps an edit to one token set out of the other sets', () => {
    // The overlay and the recipe are separate frozen literals, so a write to one
    // cannot bleed into the other. The defect was a shared *mutable* source, not
    // a shared value.
    const sheetBefore = generatedSheet();
    const highContrast = resolveCozyColors('cozy-ink', 'highContrast');
    const surfacePage = highContrast.surfacePage;

    attemptWrite(highContrast, { surfacePage: NOT_A_TOKEN_COLOUR });

    expect(resolveCozyColors('cozy-ink', 'highContrast').surfacePage).toBe(surfacePage);
    expect(COZY_CONTRAST_VARIANTS[COZY_THEME_CONTRAST_POLARITY['cozy-ink']].surfacePage).toBe(
      surfacePage,
    );
    expect(generatedSheet()).toBe(sheetBefore);
  });

  it('does not let an edit to a scale, motion, or font table change what CSS is emitted', () => {
    const sheetBefore = generatedSheet();
    const scalesBefore = cozyScaleVariables();

    attemptWrite(COZY_RADIUS, { md: '0px' });
    attemptWrite(COZY_MOTION_DURATION_MS, { base: 0 });
    attemptWrite(TYPOGRAPHY, { body: 'Comic Sans MS' });
    attemptWrite(COZY_COLOR_TOKEN_KINDS, { accent: 'decorative' });

    expect(COZY_RADIUS.md).toBe('10px');
    expect(COZY_MOTION_DURATION_MS.base).toBe(200);
    expect(TYPOGRAPHY.body).not.toBe('Comic Sans MS');
    expect(COZY_COLOR_TOKEN_KINDS.accent).toBe('text');
    expect(cozyScaleVariables()).toEqual(scalesBefore);
    expect(cozyScaleVariables()[`${COZY_SCALE_PREFIX}-radius-md`]).toBe('10px');
    expect(generatedSheet()).toBe(sheetBefore);
  });

  it('does not let an edit to the migration table, bridge, or colour scheme apply', () => {
    const sheetBefore = generatedSheet();

    attemptWrite(LEGACY_COLOR_THEME_TO_COZY_THEME, { sepia: 'cozy-berry' });
    attemptWrite(COZY_LEGACY_VARIABLE_BRIDGE, { '--accent': 'good' });
    attemptWrite(COZY_THEME_COLOR_SCHEME, { 'cozy-ink': 'light' });

    expect(LEGACY_COLOR_THEME_TO_COZY_THEME.sepia).toBe('cozy-parchment');
    expect(COZY_LEGACY_VARIABLE_BRIDGE['--accent']).toBe('accent');
    expect(COZY_THEME_COLOR_SCHEME['cozy-ink']).toBe('dark');
    expect(generatedSheet()).toBe(sheetBefore);
  });
});

describe('resolveCozyColors is total over anything a host can hold', () => {
  it('returns a defined, complete token set for every persisted legacy value', () => {
    const inputs: Readonly<Record<string, string | null | undefined>> = {
      ...PREFERENCE_INPUTS,
      ...Object.fromEntries(THEMES.map((theme) => [theme, theme])),
    };
    for (const [label, value] of Object.entries(inputs)) {
      for (const variant of VARIANTS) {
        const colors = resolveCozyColors(value, variant);
        expect(colors, `${label} resolved to ${String(colors)}`).toBeDefined();
        expect(Object.keys(colors).sort(), `${label}/${variant}`).toEqual(
          [...COZY_COLOR_TOKENS].sort(),
        );
        // The exact failure the defect report reproduced: reading a token off an
        // unresolved set. A host that only ever does this must never see it fail.
        expect(typeof colors.surfacePage, `${label}/${variant}`).toBe('string');
        expect(colors.surfacePage, `${label}/${variant}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('agrees with the migration table for every legacy, unknown, and absent value', () => {
    for (const [label, value] of Object.entries(PREFERENCE_INPUTS)) {
      const expected = COZY_THEMES[cozyThemeForColorTheme(value)];
      expect(resolveCozyColors(value, 'default'), label).toEqual(expected);
      expect(resolveCozyColorsForPreference(value, 'default'), label).toEqual(expected);
    }
    // Every legacy alias is actually in the list, so the loop above cannot pass by
    // covering nothing: five persisted values, five unrecognised ones, and the
    // two absences.
    expect(Object.keys(PREFERENCE_INPUTS)).toHaveLength(12);
  });

  it('resolves a Cozy theme name to itself, through either entry point', () => {
    // A Cozy theme name is not a persisted value, so a resolver that consulted
    // only the migration table would hand back ink and silently repaint a
    // parchment preference. The two entry points must also agree on it.
    for (const theme of THEMES) {
      expect(resolveCozyColors(theme, 'default'), theme).toBe(COZY_THEMES[theme]);
      expect(resolveCozyColorsForPreference(theme, 'default'), theme).toBe(COZY_THEMES[theme]);
      for (const variant of VARIANTS) {
        expect(resolveCozyColorsForPreference(theme, variant), `${theme}/${variant}`).toEqual(
          resolveCozyColors(theme, variant),
        );
      }
    }
    expect(resolveCozyColors('cozy-parchment', 'highContrast')).toBe(
      COZY_CONTRAST_VARIANTS[COZY_THEME_CONTRAST_POLARITY['cozy-parchment']],
    );
  });

  it('falls back to a defined theme rather than resolving to nothing', () => {
    for (const value of [
      'cozy-nope',
      'sepia-dark',
      'Cozy-Ink',
      'toString',
      'constructor',
      '',
      null,
      undefined,
    ]) {
      expect(resolveCozyColors(value, 'default'), String(value)).toBe(
        COZY_THEMES[COZY_FALLBACK_THEME],
      );
      expect(resolveCozyColorsForPreference(value), String(value)).toBe(
        COZY_THEMES[COZY_FALLBACK_THEME],
      );
    }
    expect(COZY_FALLBACK_THEME).toBe(COZY_DEFAULT_THEME);
  });

  it('resolves the persisted value a host actually reads, end to end', () => {
    // The `sepia` alias is the case the defect report reproduced: a legal stored
    // value that used to resolve to `undefined`.
    const stored = 'sepia' as string;
    expect(resolveCozyColors(stored, 'default')).toBe(
      COZY_THEMES[cozyThemeForColorTheme(stored)],
    );
    expect(COZY_THEMES[cozyThemeForColorTheme(stored)]).toBe(COZY_THEMES['cozy-parchment']);
    expect(resolveCozyColors(stored, 'default').surfacePage).toBe('#e0cda6');
  });
});
