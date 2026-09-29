/**
 * The Cozy tokens as a renderer reads them, and the quality policy.
 *
 * ## The claim under test
 *
 * Phase 9's exit criterion: "the host reads Cozy geometry, typography, and motion as
 * numbers, with no CSS-unit parsing in renderer code".
 *
 * `tests/phase9/pixi-host-boundary.test.ts` proves the *negative* half by scanning the
 * source for `parseFloat`, a unit regex, and a read of a CSS string table. This file
 * proves the *positive* half: that every number a scene needs is a finite number
 * derived from the authored token, that a token authored in a unit the mirrors cannot
 * convert fails loudly rather than becoming a plausible wrong number, and that the
 * motion profile is total and free.
 *
 * ## The trap this exists for
 *
 * `Number.parseFloat('1rem')` is `1`. Every check a consumer might plausibly write -
 * `Number.isFinite`, `> 0`, `< 1000` - passes, and a renderer would faithfully draw a
 * quarter of the intended panel. So the assertions here are not "the number is
 * sensible" but "the number is the token's own value, and the conversion refuses
 * anything it cannot read without assuming".
 *
 * ## Hermeticity
 *
 * Reads the theme source and the runtime modules in the checkout. No `dist/`, no
 * commit, no process, no network.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COZY_WORLD_TOKEN_KINDS,
  cozyTextStyle,
  resolveCozyWorldTheme,
  withCozyWorldMotion,
} from '../../src/renderers/pixi/runtime/cozyWorldTheme';
import {
  DEFAULT_WORLD_QUALITY_SIGNALS,
  WORLD_QUALITY_MEDIA_QUERIES,
  readWorldQuality,
  readWorldQualitySignals,
  resolveWorldQuality,
  useWorldQuality,
} from '../../src/renderers/pixi/runtime/useWorldQuality';
import {
  DEFAULT_WORLD_QUALITY_ID,
  WORLD_QUALITY_PROFILES,
  resolveWorldQualityProfile,
} from '../../src/renderers/pixi/runtime/types';
import {
  COZY_BORDER_WIDTH,
  COZY_BORDER_WIDTH_PX,
  COZY_COLOR_TOKENS,
  COZY_FOCUS,
  COZY_FOCUS_PX,
  COZY_FONT_SIZE,
  COZY_FONT_SIZE_PX,
  COZY_FONT_WEIGHT,
  COZY_FONT_WEIGHT_NUMBER,
  COZY_LINE_HEIGHT,
  COZY_LINE_HEIGHT_NUMBER,
  COZY_MOTION_DURATION_MS,
  COZY_MOTION_EASING_CURVE,
  COZY_MOTION_TRAVEL_PX,
  COZY_MOTION_UNKNOWN_VALUE,
  COZY_RADIUS,
  COZY_RADIUS_PX,
  COZY_SPACE,
  COZY_SPACE_PX,
  COZY_THEMES,
  COZY_TOUCH_TARGET_MIN,
  resolveMotionProfile,
  cozyHexToNumber,
} from '../../src/theme';
import { REPO_ROOT, sourceOf, stripComments } from './support/phase9Build';

describe('every Cozy token a renderer reads is a finite number', () => {
  const theme = resolveCozyWorldTheme({ theme: 'cozy-ink' });

  it('the mirrors are the authored string tables, digit for digit', () => {
    // The relationship Phase 8 established and this phase depends on: one authored
    // value per token, with the numeric face derived rather than written out again.
    // Asserted value by value rather than by a deep equal, so a failure names the
    // token that drifted.
    for (const [name, value] of Object.entries(COZY_RADIUS)) {
      expect(COZY_RADIUS_PX[name as keyof typeof COZY_RADIUS_PX], `COZY_RADIUS.${name}`).toBe(
        Number.parseFloat(value),
      );
    }
    for (const [name, value] of Object.entries(COZY_SPACE)) {
      expect(COZY_SPACE_PX[name as keyof typeof COZY_SPACE_PX], `COZY_SPACE.${name}`).toBe(
        Number.parseFloat(value),
      );
    }
    for (const [name, value] of Object.entries(COZY_BORDER_WIDTH)) {
      expect(COZY_BORDER_WIDTH_PX[name as keyof typeof COZY_BORDER_WIDTH_PX], name).toBe(
        Number.parseFloat(value),
      );
    }
    for (const [name, value] of Object.entries(COZY_FOCUS)) {
      expect(COZY_FOCUS_PX[name as keyof typeof COZY_FOCUS_PX], name).toBe(Number.parseFloat(value));
    }
    for (const [name, value] of Object.entries(COZY_FONT_SIZE)) {
      expect(COZY_FONT_SIZE_PX[name as keyof typeof COZY_FONT_SIZE_PX], name).toBe(
        Number.parseFloat(value),
      );
    }
    for (const [name, value] of Object.entries(COZY_LINE_HEIGHT)) {
      expect(COZY_LINE_HEIGHT_NUMBER[name as keyof typeof COZY_LINE_HEIGHT_NUMBER], name).toBe(
        Number(value),
      );
    }
    for (const [name, value] of Object.entries(COZY_FONT_WEIGHT)) {
      expect(COZY_FONT_WEIGHT_NUMBER[name as keyof typeof COZY_FONT_WEIGHT_NUMBER], name).toBe(
        Number(value),
      );
    }
  });

  it('no length value carries a unit, and every one is finite', () => {
    const lengths: Record<string, unknown> = {
      ...COZY_RADIUS_PX,
      ...COZY_SPACE_PX,
      ...COZY_BORDER_WIDTH_PX,
      ...COZY_FOCUS_PX,
      ...COZY_FONT_SIZE_PX,
    };
    for (const [name, value] of Object.entries(lengths)) {
      expect(typeof value, name).toBe('number');
      expect(Number.isFinite(value as number), name).toBe(true);
      expect(value as number, name).toBeGreaterThanOrEqual(0);
      expect(String(value), name).not.toMatch(/[a-z]/i);
    }
    // The one token that is a floor rather than a mirror, so it needs no twin.
    expect(COZY_TOUCH_TARGET_MIN).toBe(44);
  });

  it('the resolved theme exposes every colour token as a number, total over the table', () => {
    for (const token of COZY_COLOR_TOKENS) {
      const value = theme.color[token];
      expect(typeof value, token).toBe('number');
      expect(Number.isInteger(value), token).toBe(true);
      expect(value, token).toBeGreaterThanOrEqual(0);
      expect(value, token).toBeLessThanOrEqual(0xffffff);
      const unit = theme.colorUnit[token];
      expect(unit, token).toHaveLength(4);
      for (const channel of unit) {
        expect(channel, token).toBeGreaterThanOrEqual(0);
        expect(channel, token).toBeLessThanOrEqual(1);
      }
    }
    expect(COZY_WORLD_TOKEN_KINDS).toBeTypeOf('object');
  });

  it('is frozen at every level, because a shared record a scene edited would leak', () => {
    expect(Object.isFrozen(resolveCozyWorldTheme({}))).toBe(true);
    expect(Object.isFrozen(theme.color)).toBe(true);
    expect(Object.isFrozen(theme.colorUnit)).toBe(true);
    expect(Object.isFrozen(theme.fontFamily)).toBe(true);
    expect(Object.isFrozen(theme.easing)).toBe(true);
  });
});

describe('the resolver is total, so a mount never fails on a preference string', () => {
  it('accepts a Cozy name, a legacy preference, a nonsense string, and nothing at all', () => {
    const inputs: (string | null | undefined)[] = [
      'cozy-parchment',
      'light',
      'sepia',
      'colorful',
      'aurora',
      'dark',
      'not-a-theme',
      'toString',
      null,
      undefined,
    ];
    for (const input of inputs) {
      const resolved = resolveCozyWorldTheme({ theme: input as string });
      // A wrong swatch is a bug; a thrown `TypeError` on the mount path is a blank
      // screen, which is why totality matters more here than it does in the DOM.
      expect(typeof resolved.color.surfacePage, String(input)).toBe('number');
      expect(typeof resolved.color.textPrimary, String(input)).toBe('number');
      expect(Number.isInteger(resolved.color.surfacePage), String(input)).toBe(true);
    }
    // And the two ways it can differ are the ones that matter: the theme recipe and
    // the contrast variant.
    expect(resolveCozyWorldTheme({ theme: 'cozy-parchment' }).color.surfacePage).not.toBe(
      resolveCozyWorldTheme({ theme: 'cozy-ink' }).color.surfacePage,
    );
    expect(
      resolveCozyWorldTheme({ theme: 'cozy-ink', contrast: 'highContrast' }).color.surfacePage,
    ).toBe(0x000000);
    // `Object.hasOwn` rather than an index, so an inherited key is not a "theme":
    // `'constructor'` and `'toString'` resolve to the fallback, not to a function.
    const fallback = resolveCozyWorldTheme({}).color.surfacePage;
    expect(resolveCozyWorldTheme({ theme: 'constructor' }).color.surfacePage).toBe(fallback);
    expect(resolveCozyWorldTheme({ theme: 'toString' }).color.surfacePage).toBe(fallback);
    expect(fallback).toBe(cozyHexToNumber(COZY_THEMES['cozy-ink'].surfacePage));
  });

  it('gives every Cozy theme a defined record, and each a distinct page surface', () => {
    const surfaces = new Set<number>();
    for (const name of Object.keys(COZY_THEMES)) {
      const resolved = resolveCozyWorldTheme({ theme: name });
      expect(Object.keys(resolved.color)).toHaveLength(COZY_COLOR_TOKENS.length);
      surfaces.add(resolved.color.surfacePage);
    }
    // Four recipes, and they are four different pages rather than four names for one.
    expect(surfaces.size).toBe(Object.keys(COZY_THEMES).length);
  });
});

describe('a canvas text style is numbers, and the weight is the digit spelling', () => {
  it('spells each weight as the digits of the number, which is what a `TextStyle` takes', () => {
    const theme = resolveCozyWorldTheme({});
    for (const name of Object.keys(COZY_FONT_WEIGHT) as (keyof typeof COZY_FONT_WEIGHT)[]) {
      const style = cozyTextStyle(theme, { weight: name });
      // PixiJS 8 types `TextStyle.fontWeight` as a string union, so the conversion is
      // `String(number)` - a widening of a number, never a parse of a token. The cast
      // behind it is what this assertion holds honest.
      expect(style.fontWeight, name).toBe(String(COZY_FONT_WEIGHT_NUMBER[name]));
      expect(/^[1-9]00$/.test(style.fontWeight), name).toBe(true);
    }
  });

  it('reads size, weight, line height, family, and fill from the token tables', () => {
    const theme = resolveCozyWorldTheme({ theme: 'cozy-parchment' });
    const style = cozyTextStyle(theme, {
      role: 'display',
      size: 'xl',
      weight: 'bold',
      lineHeight: 'snug',
      color: 'accent',
      align: 'center',
    });
    expect(style.fontSize).toBe(COZY_FONT_SIZE_PX.xl);
    expect(style.fontWeight).toBe('700');
    expect(style.lineHeight).toBe(COZY_LINE_HEIGHT_NUMBER.snug);
    expect(style.fontFamily).toBe(theme.fontFamily.display);
    // The system stacks, with no web font and therefore no network request - Phase 8's
    // "the app renders without remote font requests" still holds on a canvas.
    expect(style.fontFamily).toContain('system-ui');
    expect(style.fontFamily).not.toMatch(/https?:/);
    expect(style.fill).toBe(theme.color.accent);
    expect(style.align).toBe('center');
    expect(Object.isFrozen(style)).toBe(true);
  });
});

describe('the motion profile is total, and reduced motion is a number', () => {
  it('scales every named duration and travel to zero, and keeps the action working', () => {
    const reduced = resolveMotionProfile(true);
    for (const name of Object.keys(COZY_MOTION_DURATION_MS) as (keyof typeof COZY_MOTION_DURATION_MS)[]) {
      expect(reduced.durationMs(name), name).toBe(0);
    }
    for (const name of Object.keys(COZY_MOTION_TRAVEL_PX) as (keyof typeof COZY_MOTION_TRAVEL_PX)[]) {
      expect(reduced.travelPx(name), name).toBe(0);
    }
    expect(reduced.scale).toBe(0);
    expect(reduced.reduceAll).toBe(true);
    // A host computing seconds from this gets 0, not `NaN`: the reason an unknown
    // name answers `0` rather than `undefined` is exactly this arithmetic.
    expect(reduced.durationMs('slow') / 1000).toBe(0);
    expect(Number.isNaN(reduced.durationMs('slow') / 1000)).toBe(false);
  });

  it('leaves the full-motion profile at the authored values', () => {
    const full = resolveMotionProfile(false);
    expect(full.scale).toBe(1);
    expect(full.durationMs('base')).toBe(COZY_MOTION_DURATION_MS.base);
    expect(full.travelPx('large')).toBe(COZY_MOTION_TRAVEL_PX.large);
    for (const name of Object.keys(COZY_MOTION_DURATION_MS) as (keyof typeof COZY_MOTION_DURATION_MS)[]) {
      expect(full.durationMs(name), name).toBe(COZY_MOTION_DURATION_MS[name]);
    }
  });

  it('answers a name it does not know with a number, never a function', () => {
    // `Object.hasOwn` rather than an index: the duration tables are built with
    // `Object.fromEntries`, so they carry `Object.prototype`, and `durations['toString']`
    // is a *function*. A host that multiplied a function by a delta would move a
    // sprite by `NaN` and never notice.
    for (const profile of [resolveMotionProfile(true), resolveMotionProfile(false)]) {
      for (const name of ['toString', 'constructor', 'nope', '', '__proto__'] as never[]) {
        expect(typeof profile.durationMs(name), name).toBe('number');
        expect(typeof profile.travelPx(name), name).toBe('number');
        expect(profile.durationMs(name), name).toBe(COZY_MOTION_UNKNOWN_VALUE);
        expect(profile.travelPx(name), name).toBe(COZY_MOTION_UNKNOWN_VALUE);
      }
    }
  });

  it('exposes each easing curve as four numbers a tween can use', () => {
    for (const [name, curve] of Object.entries(COZY_MOTION_EASING_CURVE)) {
      expect(curve, name).toHaveLength(4);
      for (const point of curve) {
        expect(Number.isFinite(point), name).toBe(true);
      }
      // The x control points are the ones CSS constrains to 0..1; the y points are
      // deliberately unconstrained so an overshoot curve stays valid.
      expect(curve[0], name).toBeGreaterThanOrEqual(0);
      expect(curve[0], name).toBeLessThanOrEqual(1);
      expect(curve[2], name).toBeGreaterThanOrEqual(0);
      expect(curve[2], name).toBeLessThanOrEqual(1);
      expect(Object.isFrozen(curve), name).toBe(true);
    }
  });

  it('rebinds a theme to a new profile, and returns the same object when nothing changed', () => {
    const theme = resolveCozyWorldTheme({ reducedMotion: false });
    // Identity, so a `setReducedMotion` call that matches the current state does not
    // allocate or force a re-render.
    expect(withCozyWorldMotion(theme, false)).toBe(theme);
    const reduced = withCozyWorldMotion(theme, true);
    expect(reduced).not.toBe(theme);
    expect(reduced.motion.travelPx('large')).toBe(0);
    // And every other token is carried across untouched, because nothing else about
    // the theme can have changed.
    expect(reduced.color).toBe(theme.color);
    expect(reduced.radius).toBe(theme.radius);
    expect(reduced.touchTargetMin).toBe(theme.touchTargetMin);
  });
});

describe('the quality policy is a decision, not a measurement', () => {
  it('names three profiles and defaults to the middle one', () => {
    expect(Object.keys(WORLD_QUALITY_PROFILES).sort()).toEqual(['balanced', 'constrained', 'high']);
    expect(DEFAULT_WORLD_QUALITY_ID).toBe('balanced');
    for (const [id, profile] of Object.entries(WORLD_QUALITY_PROFILES)) {
      expect(profile.id, id).toBe(id);
      expect(profile.resolution, id).toBeGreaterThan(0);
      expect(profile.maxFps, id).toBeGreaterThanOrEqual(0);
      expect(['webgl', 'webgpu', 'canvas'], id).toContain(profile.preference);
      expect(Object.isFrozen(profile), id).toBe(true);
    }
    // The constrained profile is the one that costs fewer pixels, and its frame cap is
    // a real ceiling rather than a division by zero.
    expect(WORLD_QUALITY_PROFILES.constrained.resolution).toBeLessThan(
      WORLD_QUALITY_PROFILES.balanced.resolution,
    );
    expect(WORLD_QUALITY_PROFILES.constrained.antialias).toBe(false);
    expect(WORLD_QUALITY_PROFILES.balanced.maxFps).toBe(0);
  });

  it('is total over a name a caller can hold, using `Object.hasOwn`', () => {
    for (const name of ['high', 'constrained', 'balanced', 'ultra', 'toString', '', null, undefined]) {
      const profile = resolveWorldQualityProfile(name as string);
      expect(typeof profile.id, String(name)).toBe('string');
      expect(Object.values(WORLD_QUALITY_PROFILES), String(name)).toContain(profile);
    }
    expect(resolveWorldQualityProfile('ultra')).toBe(WORLD_QUALITY_PROFILES.balanced);
  });

  it('picks constrained for a touch-only device or a small one, whatever the pixel ratio', () => {
    const constrained = [
      { ...DEFAULT_WORLD_QUALITY_SIGNALS, coarsePointer: true, devicePixelRatio: 3 },
      { ...DEFAULT_WORLD_QUALITY_SIGNALS, hardwareConcurrency: 2, devicePixelRatio: 3 },
      { ...DEFAULT_WORLD_QUALITY_SIGNALS, hardwareConcurrency: 3 },
      { ...DEFAULT_WORLD_QUALITY_SIGNALS, hardwareConcurrency: 1, coarsePointer: true },
    ];
    for (const signals of constrained) {
      expect(resolveWorldQuality(signals).id, JSON.stringify(signals)).toBe('constrained');
    }
  });

  it('picks high only for a capable, dense display, and balanced otherwise', () => {
    expect(
      resolveWorldQuality({ coarsePointer: false, hardwareConcurrency: 8, devicePixelRatio: 2, reducedMotion: false })
        .id,
    ).toBe('high');
    // A dense display with reported parallelism, at any ratio above the threshold.
    expect(
      resolveWorldQuality({ coarsePointer: false, hardwareConcurrency: 8, devicePixelRatio: 3, reducedMotion: false })
        .id,
    ).toBe('high');
    // A capable, non-dense display is not upgraded for a reason it has not given.
    expect(
      resolveWorldQuality({ coarsePointer: false, hardwareConcurrency: 16, devicePixelRatio: 1, reducedMotion: false })
        .id,
    ).toBe('balanced');
    // A 3x phone is still a phone: the pixel ratio alone never reaches `high`.
    expect(
      resolveWorldQuality({ coarsePointer: false, hardwareConcurrency: null, devicePixelRatio: 3, reducedMotion: false })
        .id,
    ).toBe('balanced');
    expect(
      resolveWorldQuality({ coarsePointer: false, hardwareConcurrency: null, devicePixelRatio: 1, reducedMotion: false })
        .id,
    ).toBe('balanced');
    // A ratio that is zero, negative, or `NaN` is read as 1 rather than propagated.
    for (const dpr of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveWorldQuality({ coarsePointer: false, hardwareConcurrency: 8, devicePixelRatio: dpr, reducedMotion: false })
          .id,
        String(dpr),
      ).toBe('balanced');
    }
  });

  it('reads a realm without throwing, and reports motion from the same query list', () => {
    expect(readWorldQualitySignals(undefined)).toEqual({
      coarsePointer: false,
      hardwareConcurrency: null,
      devicePixelRatio: 1,
      reducedMotion: false,
    });
    const original = window.matchMedia;
    try {
      window.matchMedia = ((text: string) => ({
        matches: text === WORLD_QUALITY_MEDIA_QUERIES.reducedMotion,
      })) as typeof window.matchMedia;
      const signals = readWorldQualitySignals(window);
      expect(signals.reducedMotion).toBe(true);
      expect(signals.coarsePointer).toBe(false);
      // A webview that throws on an unknown query has told us nothing, and answering
      // "coarse pointer" on its say-so would put a desktop on the phone profile.
      expect(readWorldQuality().reducedMotion).toBe(true);
      window.matchMedia = (() => {
        throw new Error('unsupported query');
      }) as typeof window.matchMedia;
      const refused = readWorldQualitySignals(window);
      expect(refused.coarsePointer).toBe(false);
      expect(refused.reducedMotion).toBe(false);
    } finally {
      window.matchMedia = original;
    }
  });

  it('names the two media queries it reads, and neither carries anything but a feature', () => {
    expect(WORLD_QUALITY_MEDIA_QUERIES.coarsePointer).toBe('(pointer: coarse)');
    expect(WORLD_QUALITY_MEDIA_QUERIES.reducedMotion).toBe('(prefers-reduced-motion: reduce)');
    for (const query of Object.values(WORLD_QUALITY_MEDIA_QUERIES)) {
      // A media query is a static string. Nothing a learner owns may ever reach one,
      // because a query string is readable by the page and would turn a preference
      // into a channel.
      expect(query).not.toMatch(/[?&=]/);
      expect(query.length).toBeLessThan(60);
    }
  });

  it('is exported as a hook without a DOM, so the module is importable in a worker', () => {
    // The hook is a function declaration, so importing the module evaluates no DOM
    // global - which is what lets `useWorldQuality` be read by a Phase 11 scene that
    // might not be a component at all.
    expect(useWorldQuality).toBeTypeOf('function');
    // Structural rather than textual: a DOM global may appear *inside* a function
    // that takes an optional `Window` - that is the point of the parameter - but a
    // module-scope read of one would make the module unusable in a worker, and
    // `readWorldQualitySignals(undefined)` above already runs that code path.
    const source = stripComments(sourceOf('src/renderers/pixi/runtime/useWorldQuality.ts'));
    const moduleScopeReads = source
      .split('\n')
      .filter((line) => /^(?:document|window|navigator|globalThis)\b/.test(line));
    expect(moduleScopeReads, 'a DOM global is read at module scope').toEqual([]);
  });
});

describe('the theme source refuses to guess a unit', () => {
  const themeDir = path.join(REPO_ROOT, 'src', 'theme');

  it('is walked, so the scan below is not an empty one', () => {
    const files = readdirSync(themeDir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('builds the mirrors at module scope, so an unconvertible token fails at load', () => {
    // Phase 8's `cozyNumbers` throws rather than guessing. The reason that is safe is
    // that the mirrors are built while the module is evaluated - in the token test, in
    // CI, in the dev server, and in a shipped bundle - so there is no build flag and no
    // dev-only branch that could strip the check, because the check *is* the conversion.
    const source = stripComments(readFileSync(path.join(themeDir, 'cozyNumbers.ts'), 'utf8'));
    expect(source).toContain("const PX_LENGTH = /^(-?(?:\\d+|\\d*\\.\\d+))px$/");
    // Deliberately not a `parseFloat`-shaped pattern: `/^-?[\\d.]+/` would accept
    // `1rem` and hand back `1`, which is the silent-wrong-number failure.
    expect(source).not.toMatch(/parseFloat/);
    expect(source).toContain('cozyPxNumber');
    expect(source).toContain('cozyUnitlessNumber');
    expect(source).toContain('cozyEasingCurve');
  });
});
