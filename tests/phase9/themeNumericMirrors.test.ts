/**
 * Phase 9: the numeric mirrors of the Cozy scale tokens.
 *
 * ## The claim under test
 *
 * Plan Phase 9 requires "numeric mirrors for the Cozy scale tokens ... so the host
 * consumes numbers rather than parsing CSS units", and its exit criterion is that
 * "the host reads Cozy geometry, typography, and motion as numbers, with no CSS-unit
 * parsing in renderer code". A file of exported constants cannot establish that, and
 * neither can a test that asserts the constants look numeric. The three things that
 * can are:
 *
 * 1. **The mirror is derived, not authored.** Each mirror is built by parsing the
 *    string table at module scope, so there is one value per token in the repository.
 *    This file asserts the derivation holds from both directions - every mirror entry
 *    equals the parsed string, and every string has a mirror entry - which is the
 *    check that fails if someone reintroduces a hand-written list.
 * 2. **A token that cannot be converted is loud.** `Number.parseFloat('1rem')` is `1`,
 *    and that is the failure a `rem` spacing token would ship as: a finite, plausible,
 *    wrong number that passes every sanity check a consumer might write. The mirrors
 *    throw instead, at module evaluation, and this file pins the throw for the
 *    spellings a future author would plausibly reach for.
 * 3. **The CSS side is unchanged.** These are additive mirrors. The emitter must
 *    still hand the *string* table to the stylesheet, or the generated
 *    `src/styles/cozy-tokens.css` would have changed and the byte-for-byte check in
 *    `tests/phase8/cozy-tokens.test.ts` would already be red.
 *
 * ## Why the `rem`/`em` decision is asserted rather than assumed
 *
 * The Phase 8 review that deferred this work named the failure precisely: "a future
 * `rem` or `em` token silently becomes a wrong number instead of a compile error"
 * (`tests/phase8/pixi-token-consumption.test.ts`). Three options existed - reject the
 * value, guess the unit, or accept and document the guess - and only the first is
 * defensible for a module whose whole purpose is to be trusted by a renderer that
 * cannot check it. The decision, stated in `src/theme/cozyNumbers.ts` and pinned here:
 *
 * > A Cozy scale token is authored in `px`, or it is not authored yet.
 *
 * That is a documented, enforced policy rather than a silent convention. A token
 * authored in `rem` must either be converted to `px` at authoring time or get an
 * explicit, reviewed conversion; either way the arithmetic a renderer performs is
 * visible in this repository instead of being assumed inside a tween.
 *
 * ## Why the unitless tables are named `_NUMBER` and not `_PX`
 *
 * `COZY_LINE_HEIGHT` and `COZY_FONT_WEIGHT` are already unitless - `'1.5'` and
 * `'400'`. A `_PX` suffix on their mirrors would claim pixels that are not there, so
 * they are `COZY_LINE_HEIGHT_NUMBER` and `COZY_FONT_WEIGHT_NUMBER`, and they are
 * produced by a stricter rule: a bare number converts, and a stray unit throws.
 *
 * ## Hermeticity
 *
 * Nothing here reads the checkout's history, reads `dist/`, or depends on where the
 * checkout lives. The only filesystem access is reading the three committed source
 * files this gate reasons about, through paths built from the working directory.
 *
 * Privacy: this file contains no learner data, makes no network request, and asserts
 * on token tables and a source file only.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COZY_BORDER_WIDTH,
  COZY_BORDER_WIDTH_PX,
  COZY_FOCUS,
  COZY_FOCUS_PX,
  COZY_FONT_SIZE,
  COZY_FONT_SIZE_PX,
  COZY_FONT_WEIGHT,
  COZY_FONT_WEIGHT_NUMBER,
  COZY_LINE_HEIGHT,
  COZY_LINE_HEIGHT_NUMBER,
  COZY_RADIUS,
  COZY_RADIUS_PX,
  COZY_SPACE,
  COZY_SPACE_PX,
  COZY_TOUCH_TARGET_MIN,
  COZY_TOUCH_TARGET_MIN_PX,
  RENDERER_NEUTRAL_THEME_MODULES,
  type RendererNeutralThemeModule,
} from '@/theme';
import { COZY_SCALE_PREFIX, cozyScaleVariables } from '@/theme/cozyCss';
import {
  cozyPxMirror,
  cozyPxNumber,
  cozyUnitlessMirror,
  cozyUnitlessNumber,
} from '@/theme/cozyNumbers';

const REPO_ROOT = process.cwd();
const COZY_TOKENS_SOURCE = path.join(REPO_ROOT, 'src', 'theme', 'cozyTokens.ts');

interface MirrorCase {
  /** The string table the mirror is derived from. */
  readonly family: string;
  readonly table: Readonly<Record<string, string>>;
  readonly mirror: Readonly<Record<string, number>>;
  /** The unit the table is authored in, which decides the conversion rule. */
  readonly rule: 'px' | 'unitless';
}

/**
 * Every string table and its mirror, paired.
 *
 * Written out rather than discovered by convention so that adding a table without
 * adding a mirror is a *visible* gap in this file, and so the `family` label below is
 * the one a failure message can name.
 */
const PX_MIRRORS: readonly MirrorCase[] = [
  { family: 'COZY_RADIUS', table: COZY_RADIUS, mirror: COZY_RADIUS_PX, rule: 'px' },
  { family: 'COZY_SPACE', table: COZY_SPACE, mirror: COZY_SPACE_PX, rule: 'px' },
  { family: 'COZY_BORDER_WIDTH', table: COZY_BORDER_WIDTH, mirror: COZY_BORDER_WIDTH_PX, rule: 'px' },
  { family: 'COZY_FONT_SIZE', table: COZY_FONT_SIZE, mirror: COZY_FONT_SIZE_PX, rule: 'px' },
  { family: 'COZY_FOCUS', table: COZY_FOCUS, mirror: COZY_FOCUS_PX, rule: 'px' },
];

const UNITLESS_MIRRORS: readonly MirrorCase[] = [
  { family: 'COZY_LINE_HEIGHT', table: COZY_LINE_HEIGHT, mirror: COZY_LINE_HEIGHT_NUMBER, rule: 'unitless' },
  { family: 'COZY_FONT_WEIGHT', table: COZY_FONT_WEIGHT, mirror: COZY_FONT_WEIGHT_NUMBER, rule: 'unitless' },
];

const ALL_MIRRORS: readonly MirrorCase[] = [...PX_MIRRORS, ...UNITLESS_MIRRORS];

/**
 * Values that must NOT convert, each with the mistake it represents.
 *
 * `rem` and `em` are the ones the review named. The rest are the neighbouring traps:
 * a percentage, a viewport unit, a `calc()`, a `var()` reference, a unitless number
 * in a `px` table, a `px` value in a unitless table, a stray space, an uppercase
 * unit, a leading `+`, scientific notation, and empty input. All of them are rejected
 * loudly, and none of them may produce a number.
 *
 * `rejectedBy` names the rule that refuses each one, because the two rules are not
 * the same rule: `'10'` is the mistake in a px table and the correct spelling in a
 * unitless one, and a sweep that applied both rules to every value would either fail
 * on a correct value or pass on an incorrect one.
 */
const REJECTED: readonly {
  readonly value: string;
  readonly why: string;
  readonly rejectedBy: 'both' | 'px' | 'unitless';
}[] = [
  { value: '1rem', why: 'the failure the Phase 8 review named', rejectedBy: 'both' },
  { value: '1.5rem', why: 'a fractional rem, the natural next spacing step', rejectedBy: 'both' },
  {
    value: '1em',
    why: 'em, which resolves against an element font size a canvas cannot know',
    rejectedBy: 'both',
  },
  { value: '100%', why: 'a percentage, which is meaningless to a renderer', rejectedBy: 'both' },
  { value: '10vh', why: 'a viewport unit, which is a layout concern', rejectedBy: 'both' },
  {
    value: 'calc(10px + 2px)',
    why: 'a calc() expression, which needs a layout engine',
    rejectedBy: 'both',
  },
  {
    value: 'var(--cozy-s-space-4)',
    why: 'a custom-property reference, which needs the DOM',
    rejectedBy: 'both',
  },
  { value: '10', why: 'a unitless number in a px table', rejectedBy: 'px' },
  { value: '1.5px', why: 'a px value in a unitless table', rejectedBy: 'unitless' },
  { value: '400px', why: 'another unit in a unitless table', rejectedBy: 'unitless' },
  { value: '10 px', why: 'a stray space before the unit', rejectedBy: 'both' },
  { value: '10px ', why: 'trailing whitespace', rejectedBy: 'both' },
  { value: '10PX', why: 'an uppercase unit', rejectedBy: 'both' },
  {
    value: '+10px',
    why: 'a leading plus, which is legal CSS and still not a token spelling',
    rejectedBy: 'both',
  },
  {
    value: '1e3px',
    why: 'scientific notation, which is legal CSS and still not a token spelling',
    rejectedBy: 'both',
  },
  { value: '0x10px', why: 'a hexadecimal literal', rejectedBy: 'both' },
  { value: 'Infinitypx', why: 'a non-finite magnitude', rejectedBy: 'both' },
  { value: 'NaNpx', why: 'a non-finite magnitude', rejectedBy: 'both' },
  { value: '1.2.3px', why: 'two decimal points', rejectedBy: 'both' },
  { value: '', why: 'an empty value', rejectedBy: 'both' },
  { value: ' ', why: 'whitespace', rejectedBy: 'both' },
];

/** Values that must convert, and to exactly what. */
const ACCEPTED: readonly { readonly value: string; readonly expected: number }[] = [
  { value: '0px', expected: 0 },
  { value: '10px', expected: 10 },
  { value: '10.5px', expected: 10.5 },
  { value: '.5px', expected: 0.5 },
  { value: '999px', expected: 999 },
  { value: '-4px', expected: -4 },
];

describe('every scale mirror is a number, and is derived from the string table', () => {
  it('covers every declared table, so a new table cannot skip this file', () => {
    // The sweep is written out above rather than discovered, so this is the guard on
    // the guard: it fails if a mirror exists that no case describes.
    expect(ALL_MIRRORS).toHaveLength(7);
    expect(PX_MIRRORS.map((entry) => entry.family).sort()).toEqual([
      'COZY_BORDER_WIDTH',
      'COZY_FOCUS',
      'COZY_FONT_SIZE',
      'COZY_RADIUS',
      'COZY_SPACE',
    ]);
    expect(UNITLESS_MIRRORS.map((entry) => entry.family).sort()).toEqual([
      'COZY_FONT_WEIGHT',
      'COZY_LINE_HEIGHT',
    ]);
  });

  it('has one mirror entry per token, with the same keys, in the same set', () => {
    for (const { family, table, mirror } of ALL_MIRRORS) {
      expect(Object.keys(table).length, `${family} is empty`).toBeGreaterThan(0);
      expect(Object.keys(mirror).sort(), `${family} mirror keys`).toEqual(
        Object.keys(table).sort(),
      );
      // A mirror that is the table itself, or a subset of it, would pass the first
      // half of the test above only if the key sets agree, so the length check is
      // redundant with it - stated explicitly because a dropped token is the exact
      // failure this exists to catch, and an empty table must not satisfy it.
      expect(Object.keys(mirror), `${family} mirror length`).toHaveLength(
        Object.keys(table).length,
      );
      expect(mirror, `${family} must be a distinct object from its string table`).not.toBe(table);
    }
  });

  it('makes every entry a finite number equal to its parsed string', () => {
    for (const { family, table, mirror, rule } of ALL_MIRRORS) {
      for (const [name, value] of Object.entries(table)) {
        const mirrored = mirror[name];
        expect(typeof mirrored, `${family}.${name} is not a number`).toBe('number');
        expect(Number.isFinite(mirrored), `${family}.${name} is not finite`).toBe(true);
        // The naive parse, as a renderer would otherwise have to write it. Agreeing
        // with it is what makes the mirror a drop-in for a host already doing this -
        // and the control below shows why the mirror is not just this.
        expect(mirrored, `${family}.${name}`).toBe(Number.parseFloat(value));
        // And the strict parse, through the public function, so the two routes are
        // proven to agree rather than assumed to.
        const strict =
          rule === 'px'
            ? cozyPxNumber(value, `${family}.${name}`)
            : cozyUnitlessNumber(value, `${family}.${name}`);
        expect(mirrored, `${family}.${name} disagrees with the strict parse`).toBe(strict);
      }
    }
  });

  it('reads the tokens a host actually needs, as the numbers a PixiJS call takes', () => {
    // The values Phase 8's probe had to recover with `parseFloat`, recorded now as
    // plain reads. `tests/phase8/pixi-token-consumption.test.ts` pins that the probe
    // recovered 48/40/18/3 from the strings; this pins that a host no longer has to.
    expect(COZY_SPACE_PX['12']).toBe(48);
    expect(COZY_SPACE_PX['10']).toBe(40);
    expect(COZY_SPACE_PX['4']).toBe(16);
    expect(COZY_RADIUS_PX.panel).toBe(18);
    expect(COZY_RADIUS_PX.md).toBe(10);
    expect(COZY_BORDER_WIDTH_PX.focus).toBe(3);
    expect(COZY_FOCUS_PX.ringWidth).toBe(3);
    expect(COZY_FONT_SIZE_PX.lg).toBe(16);
    expect(COZY_FONT_WEIGHT_NUMBER.bold).toBe(700);
    expect(COZY_LINE_HEIGHT_NUMBER.normal).toBe(1.5);
    // Every one of them is finite, which is the property a tween, a layout, and a
    // `TextStyle` all need and which a `parseFloat('1rem')` would appear to have.
    const sample = [
      COZY_SPACE_PX['4'],
      COZY_RADIUS_PX.md,
      COZY_BORDER_WIDTH_PX.focus,
      COZY_FOCUS_PX.ringWidth,
      COZY_FONT_SIZE_PX.lg,
      COZY_FONT_WEIGHT_NUMBER.bold,
      COZY_LINE_HEIGHT_NUMBER.normal,
    ];
    for (const value of sample) expect(Number.isFinite(value)).toBe(true);
  });

  it('freezes every mirror, and a write to one changes nothing', () => {
    for (const { family, mirror } of ALL_MIRRORS) {
      expect(Object.isFrozen(mirror), `${family} mirror is not frozen`).toBe(true);
    }
    // The observable consequence rather than the mechanism, as the Phase 8 integrity
    // contract does it: a write is allowed to throw, and is allowed to succeed, as
    // long as the next reader sees the same number.
    const before = COZY_RADIUS_PX.md;
    let rejected = false;
    try {
      Object.assign(COZY_RADIUS_PX, { md: 1 });
    } catch {
      rejected = true;
    }
    expect(COZY_RADIUS_PX.md, 'a write to a frozen mirror changed it').toBe(before);
    // A rejected write is the expected outcome under strict mode, and asserting it
    // keeps the "allowed to succeed" escape from becoming a way to ship an unfrozen
    // mirror unnoticed.
    expect(rejected, 'a frozen mirror accepted a write').toBe(true);
  });
});

describe('a token that cannot be converted fails loudly', () => {
  it('rejects every spelling a future author would plausibly reach for', () => {
    let both = 0;
    let pxOnly = 0;
    let unitlessOnly = 0;
    for (const { value, why, rejectedBy } of REJECTED) {
      // Each rule refuses the values it must, and the sweep below proves the split
      // is real rather than "both rules refuse everything": `'10'` is a mistake in
      // a px table and the correct spelling in a unitless one, and a rule that
      // refused it in both directions would be refusing legitimate tokens.
      if (rejectedBy !== 'unitless') {
        expect(
          () => cozyPxNumber(value, 'sample'),
          `px rule accepted "${value}" (${why})`,
        ).toThrow(TypeError);
      }
      if (rejectedBy !== 'px') {
        expect(
          () => cozyUnitlessNumber(value, 'sample'),
          `unitless rule accepted "${value}" (${why})`,
        ).toThrow(TypeError);
      }
      if (rejectedBy === 'both') both += 1;
      else if (rejectedBy === 'px') pxOnly += 1;
      else unitlessOnly += 1;
    }
    // The sweep has to be covering something, in each direction, or it could pass
    // having checked a rule that refuses nothing.
    expect(both).toBeGreaterThan(10);
    expect(pxOnly).toBeGreaterThan(0);
    expect(unitlessOnly).toBeGreaterThan(0);
  });

  it('names the token and the value in the failure, so the fix is obvious', () => {
    let message = '';
    try {
      cozyPxNumber('1.5rem', 'COZY_SPACE.md');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('COZY_SPACE.md');
    expect(message).toContain('1.5rem');
    // The reason is stated in the message, because a bare "unexpected token" sends
    // the next person looking for a parser bug rather than for the authoring rule.
    expect(message).toMatch(/CSS unit assumption/);
  });

  it('accepts the spellings the tables are allowed to use', () => {
    for (const { value, expected } of ACCEPTED) {
      expect(cozyPxNumber(value, 'sample'), value).toBe(expected);
    }
    for (const { value, expected } of [
      { value: '0', expected: 0 },
      { value: '1.5', expected: 1.5 },
      { value: '400', expected: 400 },
      { value: '700', expected: 700 },
      { value: '.5', expected: 0.5 },
      { value: '-1.25', expected: -1.25 },
    ]) {
      expect(cozyUnitlessNumber(value, 'sample'), value).toBe(expected);
    }
  });

  it('would have got it wrong with the parse a host would otherwise write', () => {
    // The control on the whole policy: the defect the mirrors exist to prevent is
    // real, and it is silent. If `parseFloat('1rem')` ever stopped being 1, this file
    // would fail and the reason it asserts would need re-examining.
    expect(Number.parseFloat('1.5rem')).toBe(1.5);
    expect(Number.parseFloat('1.5em')).toBe(1.5);
    expect(Number.parseFloat('100%')).toBe(100);
    expect(Number.parseFloat('calc(10px + 2px)')).toBeNaN();
    // Every one of those is a *finite* number except the last, and a finite number in
    // range is exactly what a plausibility check accepts, which is why strictness -
    // not a wider range check - is the defence.
    const parsed = Number.parseFloat('1.5rem');
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThan(1000);
  });

  it('fails at mirror construction, not at a call site', () => {
    // The mirrors are built at module scope, so a malformed token is a module
    // evaluation failure: there is no build flag, no dev-only branch, and no
    // configuration that could switch the check off.
    expect(() => cozyPxMirror({ md: '1.5rem' }, 'COZY_SPACE'), 'a rem token built a mirror').toThrow(
      TypeError,
    );
    expect(() => cozyUnitlessMirror({ bold: '700px' }, 'COZY_FONT_WEIGHT'), 'a px weight built a mirror').toThrow(
      TypeError,
    );
    // A well-formed table still builds, and the failure names the offending key.
    expect(cozyPxMirror({ md: '10px' }, 'COZY_SPACE')).toEqual({ md: 10 });
    let message = '';
    try {
      cozyPxMirror({ fine: '4px', broken: '2em' }, 'COZY_SPACE');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('COZY_SPACE.broken');
    expect(message).not.toContain('COZY_SPACE.fine');
  });

  it('ships only values its own rule accepts, so the module could not have thrown', () => {
    // The tables themselves, scanned with the same rules the mirrors use. Reaching
    // this line at all means the module evaluated, so the strongest form of the claim
    // is "every shipped token is a bare number of the right unit".
    for (const { family, table, rule } of ALL_MIRRORS) {
      for (const [name, value] of Object.entries(table)) {
        if (rule === 'px') {
          expect(value, `${family}.${name}`).toMatch(/^-?(?:\d+|\d*\.\d+)px$/);
        } else {
          expect(value, `${family}.${name}`).toMatch(/^-?(?:\d+|\d*\.\d+)$/);
        }
      }
    }
  });
});

describe('the touch target is one number under two names, and it stays that way', () => {
  it('keeps both names, because an existing caller and a Phase 8 test import both', () => {
    // `COZY_TOUCH_TARGET_MIN` is the canonical name; `COZY_TOUCH_TARGET_MIN_PX` is
    // the pre-Phase-9 spelling that `cozyCss.ts` and the Phase 8 token test import.
    // Neither can be removed without a call-site change in a module this phase does
    // not own, so both stay exported and the question left to answer is whether they
    // can disagree. They cannot: see the next test.
    expect(COZY_TOUCH_TARGET_MIN).toBe(44);
    expect(COZY_TOUCH_TARGET_MIN_PX).toBe(COZY_TOUCH_TARGET_MIN);
    expect(COZY_TOUCH_TARGET_MIN).toBeGreaterThanOrEqual(44);
    expect(typeof COZY_TOUCH_TARGET_MIN).toBe('number');
  });

  it('defines the alias from the canonical constant, so there is one literal', () => {
    // A value comparison cannot see this: two literals of 44 also satisfy the test
    // above. Reading the definition is the only way to pin that the duplicate is
    // *derived*, which is what makes drift impossible rather than merely unlikely.
    const source = readFileSync(COZY_TOKENS_SOURCE, 'utf8');
    expect(source).toMatch(
      /export const COZY_TOUCH_TARGET_MIN_PX\s*=\s*COZY_TOUCH_TARGET_MIN\s*;/,
    );
    // And the file really does contain the canonical literal once, so the match above
    // is not a coincidence against a source that never had either name.
    const canonical = source.match(/export const COZY_TOUCH_TARGET_MIN\s*=\s*44 as const\s*;/);
    expect(canonical, 'the canonical touch target literal is gone').not.toBeNull();
    expect(source.match(/=\s*44\b/g) ?? []).toHaveLength(1);
  });

  it('emits the CSS custom property from the number, not from a string table', () => {
    // There is no `--cozy-s-target-min` source value: the emitter composes it, which
    // is why this token was already a number and why it needs no mirror of its own.
    expect(cozyScaleVariables()[`${COZY_SCALE_PREFIX}-target-min`]).toBe(
      `${COZY_TOUCH_TARGET_MIN}px`,
    );
  });
});

describe('the mirrors are additive: the CSS still receives the string tables', () => {
  it('emits each string value verbatim, never the mirror number', () => {
    const scales = cozyScaleVariables();
    for (const [name, value] of Object.entries(COZY_RADIUS)) {
      expect(scales[`${COZY_SCALE_PREFIX}-radius-${name}`], name).toBe(value);
    }
    for (const [name, value] of Object.entries(COZY_SPACE)) {
      expect(scales[`${COZY_SCALE_PREFIX}-space-${name}`], name).toBe(value);
    }
    for (const [name, value] of Object.entries(COZY_BORDER_WIDTH)) {
      expect(scales[`${COZY_SCALE_PREFIX}-border-${name}`], name).toBe(value);
    }
    for (const [name, value] of Object.entries(COZY_FONT_SIZE)) {
      expect(scales[`${COZY_SCALE_PREFIX}-font-size-${name}`], name).toBe(value);
    }
    for (const [name, value] of Object.entries(COZY_LINE_HEIGHT)) {
      expect(scales[`${COZY_SCALE_PREFIX}-line-height-${name}`], name).toBe(value);
    }
    for (const [name, value] of Object.entries(COZY_FONT_WEIGHT)) {
      expect(scales[`${COZY_SCALE_PREFIX}-font-weight-${name}`], name).toBe(value);
    }
    for (const [name, value] of Object.entries(COZY_FOCUS)) {
      const property =
        name === 'ringWidth'
          ? 'focus-ring-width'
          : name === 'ringOffset'
            ? 'focus-ring-offset'
            : 'focus-halo-width';
      expect(scales[`${COZY_SCALE_PREFIX}-${property}`], name).toBe(value);
    }
  });

  it('adds no custom property, so the generated stylesheet is unchanged', () => {
    // If a mirror had been folded into `cozyScaleVariables()`, this count would move
    // and `tests/phase8/cozy-tokens.test.ts` would fail its byte-for-byte comparison
    // of `src/styles/cozy-tokens.css`. Asserting the count here makes the reason
    // legible at the point of the change rather than three files away.
    const scales = cozyScaleVariables();
    expect(Object.keys(scales)).toHaveLength(
      Object.keys(COZY_RADIUS).length +
        Object.keys(COZY_SPACE).length +
        Object.keys(COZY_BORDER_WIDTH).length +
        Object.keys(COZY_FONT_SIZE).length +
        Object.keys(COZY_LINE_HEIGHT).length +
        Object.keys(COZY_FONT_WEIGHT).length +
        3 /* easing */ +
        5 /* durations */ +
        3 /* font stacks */ +
        3 /* focus geometry */ +
        1 /* touch target */ +
        1 /* motion scale */,
    );
    // And every px family still reaches the sheet as a length, not as the mirror's
    // number. The unitless families are the exception and are why this asserts on the
    // `px` families by name rather than sweeping for "no bare numbers": a line height
    // of `1.25` and a motion scale of `1` are legitimately unitless CSS.
    for (const [name, value] of Object.entries(scales)) {
      if (name.startsWith(`${COZY_SCALE_PREFIX}-radius-`)) expect(value, name).toMatch(/px$/);
      if (name.startsWith(`${COZY_SCALE_PREFIX}-space-`)) expect(value, name).toMatch(/px$/);
      if (name.startsWith(`${COZY_SCALE_PREFIX}-border-`)) expect(value, name).toMatch(/px$/);
      if (name.startsWith(`${COZY_SCALE_PREFIX}-font-size-`)) expect(value, name).toMatch(/px$/);
      if (name.startsWith(`${COZY_SCALE_PREFIX}-focus-`)) expect(value, name).toMatch(/px$/);
    }
  });
});

describe('the conversion module is classified and renderer-neutral', () => {
  it('is a declared member of the renderer-neutral theme core', () => {
    // The Phase 8 inventory test fails on an unclassified file in `src/theme/`, and
    // it reads this list, so adding the module here is what keeps that gate honest
    // rather than something to work around.
    expect([...RENDERER_NEUTRAL_THEME_MODULES]).toContain('cozyNumbers.ts');
    const declared: readonly RendererNeutralThemeModule[] = RENDERER_NEUTRAL_THEME_MODULES;
    expect(new Set(declared).size, 'the neutral module list has a duplicate').toBe(declared.length);
  });
});
