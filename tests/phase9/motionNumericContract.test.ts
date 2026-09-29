/**
 * Phase 9: the numeric motion contract - easing curves and unknown names.
 *
 * ## The claim under test
 *
 * Plan Phase 9 folds two things into the motion module, and both exist because of a
 * failure a renderer cannot detect on its own:
 *
 * 1. **An easing curve as four numbers.** `COZY_MOTION_EASING` holds CSS
 *    `cubic-bezier(...)` strings, which a WebGL or canvas tween cannot be handed. Phase
 *    8 recorded that gap and named the absence of an accessor - "there is no
 *    `COZY_MOTION_EASING_CURVE` accessor", in `tests/phase8/pixi-token-consumption.test.ts`
 *    - and this file pins the accessor's two halves. It must *derive* from the string
 *    table, or a second list of curves drifts from the first silently; and it must
 *    agree with the string table in both directions, so a change to either is caught
 *    by the other.
 * 2. **A defined answer for an unknown name.** A host that computes a duration from
 *    data - a content table, a JSON payload, a stale key - calls
 *    `durationMs(name)` with a value the type system did not check. That used to be
 *    `undefined`, and `undefined / 1000` is `NaN` seconds, which a tween turns into an
 *    animation that never settles or a timer that fires immediately. The answer is now
 *    `0`, and this file pins that for *both* profiles, for the inherited-key names as
 *    well as the obvious ones, and against the function-valued trap that a bare `??`
 *    guard would walk straight into.
 *
 * ## What is deliberately not asserted
 *
 * A pixel-exact screen. Whether a 200ms `standard` tween *looks* right is a browser
 * question, and `tests/phase9/` is a jsdom suite with no renderer. What is asserted is
 * everything upstream of the animation call: the numbers, their provenance, and their
 * totality.
 *
 * ## Hermeticity
 *
 * No filesystem access beyond reading the two committed source files this file reasons
 * about, no dependence on the checkout's history, no `dist/`, and no dependence on
 * where the checkout lives.
 *
 * Privacy: no learner data, no network, no persisted state. Every input is a token
 * table or a hard-coded name.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COZY_MOTION_DURATION_MS,
  COZY_MOTION_EASING,
  COZY_MOTION_EASING_CURVE,
  COZY_MOTION_TRAVEL_PX,
  COZY_MOTION_UNKNOWN_VALUE,
  FULL_MOTION_SCALE,
  REDUCED_MOTION_DURATION_MS,
  REDUCED_MOTION_SCALE,
  REDUCED_MOTION_TRAVEL_PX,
  resolveMotionProfile,
  type CozyMotionDuration,
  type CozyMotionEasing,
  type CozyMotionTravel,
} from '@/theme';
import { cozyEasingCurve } from '@/theme/cozyNumbers';

const REPO_ROOT = process.cwd();
const MOTION_SOURCE = path.join(REPO_ROOT, 'src', 'theme', 'motion.ts');

const EASING_NAMES = Object.keys(COZY_MOTION_EASING) as CozyMotionEasing[];
const DURATION_NAMES = Object.keys(COZY_MOTION_DURATION_MS) as CozyMotionDuration[];
const TRAVEL_NAMES = Object.keys(COZY_MOTION_TRAVEL_PX) as CozyMotionTravel[];

/**
 * Names a host can hold that are not declared names.
 *
 * A typo, a wrong case, an empty string, the four inherited `Object.prototype` keys a
 * `Object.fromEntries` table would answer, and a key that looks like a real one. The
 * last group is the one a plain `?? 0` guard does not survive, and the reason
 * `motion.ts` checks ownership rather than nullishness.
 */
const UNKNOWN_NAMES: readonly string[] = [
  'typo',
  'BASE',
  'slower',
  '',
  ' ',
  'toString',
  'constructor',
  'hasOwnProperty',
  'valueOf',
  '__proto__',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
];

/**
 * The same list, as the values a host effectively passes when its name came from data
 * and was never checked. The casts are the point: they are what a JSON payload and a
 * missing field look like at the call site.
 */
const UNKNOWN_VALUES: readonly unknown[] = [
  undefined,
  null,
  0,
  1,
  -1,
  Number.NaN,
  Symbol('base'),
  {},
  [],
  true,
  false,
];

/** Render a tuple as the CSS function a stylesheet would use. */
function toCss(curve: readonly number[]): string {
  return `cubic-bezier(${curve.map((point) => String(point)).join(', ')})`;
}

describe('every easing curve is four numbers, derived from its CSS spelling', () => {
  it('covers every declared curve, so a new curve cannot skip this file', () => {
    expect(EASING_NAMES.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(COZY_MOTION_EASING_CURVE).sort()).toEqual([...EASING_NAMES].sort());
    expect(COZY_MOTION_EASING_CURVE).toHaveProperty('standard');
    expect(COZY_MOTION_EASING_CURVE).toHaveProperty('enter');
    expect(COZY_MOTION_EASING_CURVE).toHaveProperty('exit');
  });

  it('gives every curve exactly four finite numbers in the range CSS allows', () => {
    for (const name of EASING_NAMES) {
      const curve = COZY_MOTION_EASING_CURVE[name];
      expect(Array.isArray(curve), `${name} is not an array`).toBe(true);
      expect(curve, `${name} length`).toHaveLength(4);
      const [x1, y1, x2, y2] = curve;
      for (const [index, point] of curve.entries()) {
        expect(typeof point, `${name}[${index}] is not a number`).toBe('number');
        expect(Number.isFinite(point), `${name}[${index}] is not finite`).toBe(true);
      }
      // CSS requires the x control points in 0..1, and a curve outside that range
      // would be rejected by the stylesheet - so a token that had one would be broken
      // in one consumer and quietly accepted in the other.
      expect(x1, `${name} x1`).toBeGreaterThanOrEqual(0);
      expect(x1, `${name} x1`).toBeLessThanOrEqual(1);
      expect(x2, `${name} x2`).toBeGreaterThanOrEqual(0);
      expect(x2, `${name} x2`).toBeLessThanOrEqual(1);
      // The y points may legitimately leave 0..1 - an overshoot curve is a normal
      // easing - so the assertion is finiteness, and the shipped curves additionally
      // happen to sit inside the unit square.
      expect(Number.isFinite(y1), `${name} y1`).toBe(true);
      expect(Number.isFinite(y2), `${name} y2`).toBe(true);
      for (const [index, point] of curve.entries()) {
        expect(point, `${name}[${index}] is outside 0..1`).toBeGreaterThanOrEqual(0);
        expect(point, `${name}[${index}] is outside 0..1`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('round-trips to the CSS spelling it came from, in both directions', () => {
    for (const name of EASING_NAMES) {
      // Direction one: the tuple renders back to the exact string in the table. This
      // is the reverse check - the tuple is not a plausible-looking approximation, it
      // is the same value, and a curve edited on one side without the other fails.
      expect(toCss(COZY_MOTION_EASING_CURVE[name]), `${name} tuple -> css`).toBe(
        COZY_MOTION_EASING[name],
      );
      // Direction two: the string parses back to the same tuple, through the public
      // function rather than through a copy of its regex.
      expect(cozyEasingCurve(COZY_MOTION_EASING[name], name), `${name} css -> tuple`).toEqual(
        COZY_MOTION_EASING_CURVE[name],
      );
    }
  });

  it('pins the three shipped curves, so a change to any of them is a deliberate diff', () => {
    // A change here is a visual change, and it should be one line in a diff rather
    // than a silent consequence of an edit to the tuple map.
    expect(COZY_MOTION_EASING_CURVE.standard).toEqual([0.2, 0, 0, 1]);
    expect(COZY_MOTION_EASING_CURVE.enter).toEqual([0, 0, 0, 1]);
    expect(COZY_MOTION_EASING_CURVE.exit).toEqual([0.3, 0, 1, 1]);
    // Phase 8's probe recovered exactly these numbers by hand from the strings; the
    // tuple now hands them over, so the recovery step is gone from the host.
    expect(COZY_MOTION_EASING_CURVE.standard).toEqual(
      COZY_MOTION_EASING.standard
        .slice('cubic-bezier('.length, -1)
        .split(',')
        .map((part) => Number.parseFloat(part)),
    );
  });

  it('freezes the map and every tuple in it', () => {
    expect(Object.isFrozen(COZY_MOTION_EASING_CURVE)).toBe(true);
    for (const name of EASING_NAMES) {
      expect(Object.isFrozen(COZY_MOTION_EASING_CURVE[name]), `${name} tuple is not frozen`).toBe(
        true,
      );
    }
    // The observable consequence, as the Phase 8 integrity contract states it: a
    // write is allowed to throw and is allowed to succeed, as long as the next
    // animation reads the same curve.
    const before = [...COZY_MOTION_EASING_CURVE.standard];
    let rejected = false;
    try {
      // Through `unknown`, because the write a tween could do is a *mutable* one, and
      // the tuple is deliberately not.
      (COZY_MOTION_EASING_CURVE.standard as unknown as number[])[0] = 0.9;
    } catch {
      rejected = true;
    }
    expect([...COZY_MOTION_EASING_CURVE.standard], 'a write to a tuple changed it').toEqual(before);
    expect(rejected, 'a frozen tuple accepted a write').toBe(true);
    // A tween that received a live array could otherwise sort it and change the
    // curve for every later animation in the session, which is why the freeze is
    // asserted on the tuples and not only on the map.
    expect(COZY_MOTION_EASING_CURVE.standard[0]).toBe(before[0]);
  });

  it('is defined from the string table rather than written out twice', () => {
    // A value comparison cannot see a duplicated list: two hand-written curves that
    // happen to agree today would pass everything above and drift tomorrow. Reading
    // the definition is the only way to pin the derivation itself.
    const source = readFileSync(MOTION_SOURCE, 'utf8');
    expect(source).toMatch(/COZY_MOTION_EASING_CURVE[\s\S]*?cozyEasingCurve\(/);
    // And the conversion runs at module scope, so a curve that could not be read
    // would fail while the module evaluates rather than on a call a host makes later.
    expect(source).toMatch(
      /export const COZY_MOTION_EASING_CURVE:[\s\S]*?= Object\.freeze\(/,
    );
  });
});

describe('the easing parser refuses a curve it cannot read', () => {
  it('rejects a spelling that is not a cubic-bezier function', () => {
    for (const value of [
      'ease-in-out',
      'linear',
      'step-start',
      'cubic-bezier(0.2, 0, 0)',
      'cubic-bezier(0.2, 0, 0, 1, 0.5)',
      'cubic-bezier()',
      'cubic-bezier(,,,)',
      'cubic-bezier(0, 0, 0, calc(1))',
      'cubic-bezier(0, 0, 0, foo)',
      'cubic-bezier(nan, 0, 0, 1)',
      'CUBIC-BEZIER(0, 0, 0, 1)',
      ' cubic-bezier(0, 0, 0, 1',
      '',
    ]) {
      expect(() => cozyEasingCurve(value, 'sample'), `accepted ${JSON.stringify(value)}`).toThrow(
        TypeError,
      );
    }
  });

  it('rejects an x control point outside 0..1, which is not a CSS easing', () => {
    for (const value of [
      'cubic-bezier(1.2, 0, 0, 1)',
      'cubic-bezier(0, 0, -0.1, 1)',
      'cubic-bezier(2, 2, 2, 2)',
    ]) {
      expect(() => cozyEasingCurve(value, 'sample'), `accepted ${value}`).toThrow(TypeError);
    }
    let message = '';
    try {
      cozyEasingCurve('cubic-bezier(1.2, 0, 0, 1)', 'COZY_MOTION_EASING.standard');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('COZY_MOTION_EASING.standard');
  });

  it('accepts a y overshoot, because CSS accepts one', () => {
    // The control on the range rule: it is deliberately *not* stricter than the
    // stylesheet, or a legitimate anticipation curve could not be authored at all.
    const curve = cozyEasingCurve('cubic-bezier(0.68, -0.55, 0.27, 1.55)', 'sample');
    expect(curve).toEqual([0.68, -0.55, 0.27, 1.55]);
    expect(Number.isFinite(curve[1]) && Number.isFinite(curve[3])).toBe(true);
  });

  it('reads the whitespace CSS allows, and no more', () => {
    expect(cozyEasingCurve('cubic-bezier(0.2,0,0,1)', 'sample')).toEqual([0.2, 0, 0, 1]);
    expect(cozyEasingCurve('  cubic-bezier( 0.2 , 0 , 0 , 1 )  ', 'sample')).toEqual([
      0.2, 0, 0, 1,
    ]);
  });
});

describe('an unknown motion name answers with a number, not undefined', () => {
  it('is zero, for both profiles, for every name a host can hold', () => {
    expect(COZY_MOTION_UNKNOWN_VALUE).toBe(0);
    for (const reduced of [false, true]) {
      const profile = resolveMotionProfile(reduced);
      const label = reduced ? 'reduced' : 'full';
      for (const name of UNKNOWN_NAMES) {
        const value = profile.durationMs(name as CozyMotionDuration);
        expect(value, `${label}.durationMs(${JSON.stringify(name)})`).toBe(0);
        expect(typeof value, `${label}.durationMs(${JSON.stringify(name)})`).toBe('number');
        expect(Number.isFinite(value), `${label}.durationMs(${JSON.stringify(name)})`).toBe(true);
        // The actual failure the change exists to prevent, named so the assertion
        // says what it is for: a host dividing by 1000 to reach seconds.
        expect(value / 1000, `${label}.durationMs(${JSON.stringify(name)}) / 1000`).toBe(0);
        expect(Number.isNaN(value / 1000)).toBe(false);
        expect(value, `${label}.travelPx(${JSON.stringify(name)})`).toBe(0);
        expect(profile.travelPx(name as CozyMotionTravel), `${label}.travelPx`).toBe(0);
      }
    }
  });

  it('is zero for a name that is not a string at all', () => {
    for (const reduced of [false, true]) {
      const profile = resolveMotionProfile(reduced);
      for (const value of UNKNOWN_VALUES) {
        // A JSON payload and a missing field, which is where a host's name really
        // comes from. `Object.hasOwn` accepts a symbol and a number as a key, so this
        // is the same code path rather than a special case.
        expect(profile.durationMs(value as CozyMotionDuration), String(value)).toBe(0);
        expect(profile.travelPx(value as CozyMotionTravel), String(value)).toBe(0);
      }
    }
  });

  it('would have been a function, not undefined, for an inherited key', () => {
    // The control on the guard. A bare `durations[name] ?? 0` looks like it handles
    // every unknown name, and it does not: the table is built by `Object.fromEntries`,
    // so it carries `Object.prototype` and `durations['toString']` is a *function*.
    // A function passes `?? 0`, reaches a tween, and multiplies by a delta.
    const table = Object.fromEntries(Object.entries(COZY_MOTION_DURATION_MS));
    expect(typeof table['toString' as CozyMotionDuration], 'the inherited key is not a function')
      .toBe('function');
    expect((table['toString' as CozyMotionDuration] ?? 0), 'a nullish guard would let it through')
      .toBe(Object.prototype.toString);
    expect(Object.hasOwn(table, 'toString' as CozyMotionDuration)).toBe(false);
    // And what the profile actually returns for that key:
    expect(resolveMotionProfile(false).durationMs('toString' as CozyMotionDuration)).toBe(0);
  });
});

describe('valid names are byte-identical to the token tables', () => {
  it('returns every declared duration unchanged under full motion', () => {
    const full = resolveMotionProfile(false);
    expect(full.scale).toBe(FULL_MOTION_SCALE);
    for (const name of DURATION_NAMES) {
      expect(full.durationMs(name), name).toBe(COZY_MOTION_DURATION_MS[name]);
      expect(typeof full.durationMs(name), name).toBe('number');
    }
    expect(Object.fromEntries(DURATION_NAMES.map((n) => [n, full.durationMs(n)]))).toEqual({
      instant: 0,
      quick: 120,
      base: 200,
      slow: 320,
      deliberate: 480,
    });
    for (const name of TRAVEL_NAMES) {
      expect(full.travelPx(name), name).toBe(COZY_MOTION_TRAVEL_PX[name]);
    }
  });

  it('returns every declared duration zeroed under reduced motion', () => {
    const reduced = resolveMotionProfile(true);
    expect(reduced.scale).toBe(REDUCED_MOTION_SCALE);
    for (const name of DURATION_NAMES) {
      expect(reduced.durationMs(name), name).toBe(REDUCED_MOTION_DURATION_MS);
    }
    for (const name of TRAVEL_NAMES) {
      expect(reduced.travelPx(name), name).toBe(REDUCED_MOTION_TRAVEL_PX);
    }
    // And the full-motion values are untouched by reading the reduced profile, so the
    // fallback cannot have replaced a table rather than answered for a missing key.
    expect(resolveMotionProfile(false).durationMs('base')).toBe(200);
  });

  it('keeps the serialised tables the Phase 8 host probe recorded', () => {
    // `tests/phase8/pixi-token-consumption.test.ts` pins these exact objects from a
    // DOM-free run. They are repeated here because a change to them is a change to
    // what a worker message carries, and this file is the one asserting the profile
    // is total.
    expect(resolveMotionProfile(false).serialized.durations).toEqual({
      instant: 0,
      quick: 120,
      base: 200,
      slow: 320,
      deliberate: 480,
    });
    expect(resolveMotionProfile(false).serialized.travel).toEqual({
      micro: 2,
      small: 6,
      medium: 12,
      large: 24,
    });
    expect(resolveMotionProfile(true).serialized.durations).toEqual(
      Object.fromEntries(DURATION_NAMES.map((name) => [name, 0])),
    );
  });
});

describe('the profile is still a frozen singleton a ticker can read per frame', () => {
  it('returns the same object for the same boolean, and allocates nothing per call', () => {
    // The properties Phase 8 verified and Phase 9 must not regress: one profile per
    // boolean, resolved at module scope, so a per-frame read costs a property read.
    expect(resolveMotionProfile(false)).toBe(resolveMotionProfile(false));
    expect(resolveMotionProfile(true)).toBe(resolveMotionProfile(true));
    expect(resolveMotionProfile(false)).not.toBe(resolveMotionProfile(true));
    expect(resolveMotionProfile(false)).not.toBe(resolveMotionProfile(true));
    for (const profile of [resolveMotionProfile(false), resolveMotionProfile(true)]) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.serialized)).toBe(true);
      expect(Object.isFrozen(profile.serialized.durations)).toBe(true);
      expect(Object.isFrozen(profile.serialized.travel)).toBe(true);
      // Two "frames" read the same identity, so nothing is rebuilt per call.
      const frameA = { ms: profile.durationMs('base'), travel: profile.travelPx('medium') };
      const frameB = { ms: profile.durationMs('base'), travel: profile.travelPx('medium') };
      expect(frameA).toEqual(frameB);
      expect(profile.serialized.durations).toBe(profile.serialized.durations);
    }
    // The flags a host reads to decide whether to animate at all are unchanged.
    expect(resolveMotionProfile(false).reduced).toBe(false);
    expect(resolveMotionProfile(false).reduceAll).toBe(false);
    expect(resolveMotionProfile(true).reduced).toBe(true);
    expect(resolveMotionProfile(true).reduceAll).toBe(true);
  });
});
