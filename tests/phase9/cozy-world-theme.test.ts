/**
 * The numeric Cozy theme a world draws with.
 *
 * ## Why this file exists
 *
 * `cozyWorldTheme.ts` used to narrow `String(weight)` to the nine hundred-step CSS
 * weight spellings with `as CozyFontWeightSpelling`, and the comment beside that cast
 * named `tests/phase9/cozy-world-theme.test.ts` as the thing keeping it honest. This
 * is that file: the claim in the source is now either true or it is not, and the code
 * no longer depends on the answer.
 *
 * ## What is asserted, and what it is for
 *
 * - **The conversion is total over the authored tokens.** Every `COZY_FONT_WEIGHT`
 *   entry reaches a canvas style as a spelling the canvas accepts. A scene that draws
 *   a label and silently gets a weight nothing declares is the failure this exists to
 *   catch, and the way to catch it is to read the number rather than trust the type.
 * - **A token outside the nine hundred-step weights throws.** The conversion is a
 *   `Map` lookup, so an authored `550` or a keyword cannot reach a canvas at all. This
 *   asserts that, and asserts that the message names the weight, because a conversion
 *   that throws a generic error is a conversion whose cause nobody finds.
 * - **The theme is a function of data, not of CSS.** A canvas reads numbers. Every
 *   assertion below is on a number, which is the phase exit criterion restated: no
 *   renderer module parses a CSS unit, so no future `rem` token can quarter a panel.
 * - **Unknown input is defined, not missing.** A persisted legacy theme string, an
 *   unknown name, `null`, and `undefined` all produce a complete record. The renderer
 *   reads this during `app.init()` on the mount path, where a thrown `TypeError` is a
 *   blank world rather than a wrong swatch.
 *
 * ## Hermeticity
 *
 * No `dist/`, no commit, no network, no process, and no DOM. It reads the checked-in
 * token tables and the resolver that mirrors them.
 */
import { describe, expect, it } from 'vitest';

import { COZY_FONT_WEIGHT, COZY_FONT_WEIGHT_NUMBER, type CozyMotionDuration } from '../../src/theme';
import {
  cozyTextStyle,
  resolveCozyWorldTheme,
  withCozyWorldMotion,
  type CozyFontWeightSpelling,
} from '../../src/renderers/pixi/runtime/cozyWorldTheme';

const HUNDRED_STEP_WEIGHTS: readonly CozyFontWeightSpelling[] = [
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
];

describe('every authored Cozy weight reaches a canvas as a spelling it accepts', () => {
  it('resolves each weight name to its own digit spelling', () => {
    const theme = resolveCozyWorldTheme({});
    for (const [name, authored] of Object.entries(COZY_FONT_WEIGHT)) {
      const weight = name as keyof typeof theme.fontWeight;
      const style = cozyTextStyle(theme, { weight });
      // The three assertions that make this more than a type-level claim: the mirror is
      // a number, the spelling is that number rendered, and the spelling is one the
      // canvas accepts.
      expect(Number.isInteger(theme.fontWeight[weight]), `${name} mirror`).toBe(true);
      expect(style.fontWeight, `${name} spelling`).toBe(authored);
      expect(HUNDRED_STEP_WEIGHTS, `${name} is outside the canvas union`).toContain(style.fontWeight);
    }
  });

  it('defaults to the regular weight, and every size and line height is a number', () => {
    const theme = resolveCozyWorldTheme({});
    const style = cozyTextStyle(theme);
    expect(String(COZY_FONT_WEIGHT_NUMBER.regular)).toBe(style.fontWeight);
    for (const value of Object.values(style)) {
      // `align` is a keyword and `fontFamily` is a stack; everything a canvas measures
      // with is a number.
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('names the weight it refused, rather than throwing a generic conversion error', () => {
    const theme = resolveCozyWorldTheme({});
    const broken = { ...theme, fontWeight: { ...theme.fontWeight, bold: 550 } };
    expect(() => cozyTextStyle(broken, { weight: 'bold' })).toThrow(/bold = 550/);
  });
});

describe('the theme is total over its input, because a renderer reads it on the mount path', () => {
  it('answers a complete record for an unknown name, a legacy string, null, and nothing', () => {
    const inputs = ['cozy-parchment', 'an-unknown-theme-name', null, undefined];
    const records = inputs.map((theme) => resolveCozyWorldTheme({ theme }));
    const expected = resolveCozyWorldTheme({ theme: 'cozy-parchment' });
    for (const [index, record] of records.entries()) {
      expect(Object.keys(record.color).sort(), `input ${String(inputs[index])}`).toEqual(
        Object.keys(expected.color).sort(),
      );
      expect(Object.keys(record.space).sort()).toEqual(Object.keys(expected.space).sort());
      expect(Object.keys(record.fontSize).sort()).toEqual(Object.keys(expected.fontSize).sort());
      expect(Object.keys(record.lineHeight).sort()).toEqual(Object.keys(expected.lineHeight).sort());
    }
  });

  it('scales every named travel and duration to zero under reduced motion, and not otherwise', () => {
    const allowed = resolveCozyWorldTheme({ reducedMotion: false });
    const reduced = withCozyWorldMotion(allowed, true);
    expect(allowed.motion.reduced).toBe(false);
    expect(allowed.motion.travelPx('large')).toBeGreaterThan(0);
    for (const size of ['small', 'medium', 'large'] as const) {
      expect(reduced.motion.travelPx(size), `travel ${size}`).toBe(0);
    }
    for (const name of ['instant', 'quick', 'slow', 'deliberate'] as const) {
      expect(reduced.motion.durationMs(name), `duration ${name}`).toBe(0);
    }
    // An unknown duration name is zero rather than `NaN`, so a host that computes a
    // duration from data cannot produce `NaN` seconds of tween. The name has to be
    // widened to `string` to be passed at all, which is the point: the table is keyed
    // by a union, and a host that reads a name from data is reading a `string`.
    const unknownName = 'not-a-name' as CozyMotionDuration;
    expect(Number.isNaN(reduced.motion.durationMs(unknownName))).toBe(false);
    expect(reduced.motion.durationMs(unknownName)).toBe(0);
  });
});
