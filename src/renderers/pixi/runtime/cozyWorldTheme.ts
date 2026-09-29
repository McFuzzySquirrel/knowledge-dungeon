/**
 * The Cozy design system as a renderer can use it: numbers, not CSS lengths.
 *
 * ## Why this module exists
 *
 * The Cozy token source is CSS-shaped on purpose - `--cozy-s-radius-md` has to be
 * the string `10px` to survive a cascade, and `COZY_RADIUS.md` is authored that
 * way. A canvas renderer is the other consumer and it cannot use a string:
 * `Graphics.roundRect` takes a number, a `TextStyle` takes a numeric `fontSize`
 * and `fontWeight`, and a tween takes milliseconds.
 *
 * The tempting fix is `Number.parseFloat(COZY_RADIUS.md)`. It works today and it is
 * the defect Phase 9's exit criterion names: `Number.parseFloat('1rem')` is `1`,
 * so the day a spacing token is authored in `rem` - the natural next step for most
 * design systems - a renderer would faithfully draw a quarter of the intended panel,
 * and nothing about the result would look wrong.
 *
 * So this module is the *only* place a Cozy token string becomes a number, and it
 * does that by reading the numeric mirrors Phase 8 derived from the string tables
 * (`COZY_RADIUS_PX`, `COZY_SPACE_PX`, `COZY_FONT_SIZE_PX`, and siblings). The
 * mirrors are generated from the authored strings, so there is one authored value
 * per token, and `cozyNumbers.ts` throws rather than guessing if a token is ever
 * authored in a unit it cannot convert. Nothing here parses a unit, and
 * `tests/phase9/pixi-host-boundary.test.ts` holds that with a source scan over
 * this tree.
 *
 * ## The policy for reduced motion lives here too
 *
 * `resolveMotionProfile` is Phase 8's, and this module is what *applies* it. The
 * caller supplies an observed boolean - `matchMedia` in a browser, a value carried
 * in a message in a worker, `false` in a test - and never a `MediaQueryList`, so
 * nothing in this file needs a DOM. That is the half of plan section 10.1's
 * "`prefers-reduced-motion` support in React and Pixi" that a renderer owns: the
 * profile is a plain frozen record, and a scene reads `theme.motion.travelPx(...)`
 * and gets `0` for every distance when motion is reduced.
 *
 * Renderer-neutral by contract: no React, no renderer, no DOM global at module
 * scope. It imports `@/theme`, which is itself renderer-neutral.
 */
import {
  COZY_BORDER_WIDTH_PX,
  COZY_COLOR_TOKEN_KINDS,
  COZY_COLOR_TOKENS,
  COZY_FOCUS_PX,
  COZY_FONT_SIZE_PX,
  COZY_FONT_WEIGHT_NUMBER,
  COZY_LINE_HEIGHT_NUMBER,
  COZY_MOTION_EASING_CURVE,
  COZY_RADIUS_PX,
  COZY_SPACE_PX,
  COZY_TOUCH_TARGET_MIN,
  canvasFontFamily,
  cozyHexToNumber,
  cozyHexToUnitArray,
  resolveCozyColors,
  resolveMotionProfile,
  type CozyColorToken,
  type CozyContrastVariant,
  type CozyEasingCurve,
  type CozyMotionDuration,
  type CozyMotionProfile,
  type CozyMotionTravel,
  type CozyThemeColors,
  type CozyThemeInput,
} from '@/theme';

/**
 * The Cozy tokens a canvas renderer reads, with the units already resolved.
 *
 * Grouped by role rather than flattened, because a scene that wants the panel
 * radius should say `radius.panel` and not `radius[4]`: the second form makes the
 * token table an implicit ordering, and a reordering would then be a silent
 * rendering change. Each group is the authored table under a stable name, so the
 * mapping is one-to-one and checkable.
 */
export interface CozyWorldTheme {
  /**
   * Semantic colours as `0xRRGGBB` numbers.
   *
   * Total and frozen, so a scene indexes a token it knows and a theme it does not
   * still yields a colour rather than `undefined`. Built from the same
   * `resolveCozyColors` call React DOM reads through `cozyCss.ts`, so the canvas
   * and the DOM around it cannot disagree about what "cozy ink" means.
   */
  readonly color: Readonly<Record<CozyColorToken, number>>;
  /** The same colours as `[r, g, b, a]` unit tuples, for APIs that want an array. */
  readonly colorUnit: Readonly<Record<CozyColorToken, readonly [number, number, number, number]>>;
  /** Corner radii in CSS pixels. */
  readonly radius: Readonly<Record<'none' | 'sm' | 'md' | 'lg' | 'xl' | 'panel' | 'pill', number>>;
  /** Spacing steps in CSS pixels, keyed by the same numeric strings the CSS uses. */
  readonly space: Readonly<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '10' | '12', number>>;
  /** Border weights in CSS pixels. */
  readonly border: Readonly<{ hairline: number; state: number; focus: number }>;
  /** Focus ring geometry in CSS pixels. */
  readonly focus: Readonly<{ ringWidth: number; ringOffset: number; haloWidth: number }>;
  /** The storybook type scale in CSS pixels. */
  readonly fontSize: Readonly<
    Record<'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'display', number>
  >;
  /** Line-height multipliers, already unitless. */
  readonly lineHeight: Readonly<Record<'tight' | 'snug' | 'normal' | 'relaxed', number>>;
  /** Font weights, already unitless numbers rather than CSS keywords. */
  readonly fontWeight: Readonly<Record<'regular' | 'medium' | 'bold', number>>;
  /** The system font stacks, as a `TextStyle.fontFamily` string wants them. */
  readonly fontFamily: Readonly<{ display: string; body: string; code: string }>;
  /**
   * Plan 10.1's minimum target size, in CSS pixels.
   *
   * Carried here so a scene can lay a pointer target out at the same size the DOM
   * mirror renders its control, rather than a renderer picking its own.
   */
  readonly touchTargetMin: number;
  /** Easing curves as four control-point numbers, ready for a tween. */
  readonly easing: Readonly<Record<'standard' | 'enter' | 'exit', CozyEasingCurve>>;
  /**
   * The resolved motion profile.
   *
   * Frozen and shared between every scene, and already scaled: at
   * `prefers-reduced-motion: reduce` every `travelPx` and every `durationMs` is `0`.
   */
  readonly motion: CozyMotionProfile;
  /** Which Cozy theme and contrast variant produced this record. */
  readonly source: Readonly<{ theme: CozyThemeColors; variant: CozyContrastVariant | 'default' }>;
}

/** A fully scaled Cozy colour, for the APIs that take a unit tuple. */
export type CozyWorldThemeColorUnit = readonly [number, number, number, number];

/** The observed motion preference, and the token tables to read beside it. */
export interface CozyWorldThemeInput {
  /** A Cozy theme name, a persisted legacy colour-theme string, or anything else. */
  readonly theme?: CozyThemeInput;
  readonly contrast?: CozyContrastVariant;
  /** The observed `prefers-reduced-motion` state. A plain boolean, never a query. */
  readonly reducedMotion?: boolean;
}

function numericColors(theme: CozyThemeColors): Readonly<Record<CozyColorToken, number>> {
  const result = {} as Record<CozyColorToken, number>;
  for (const token of COZY_COLOR_TOKENS) {
    result[token] = cozyHexToNumber(theme[token]);
  }
  // Frozen so a scene cannot edit the shared record in place and change what every
  // later scene in the session draws. See the integrity contract in
  // `src/theme/cozyTokens.ts`, which this inherits rather than re-decides.
  return Object.freeze(result);
}

function unitColors(theme: CozyThemeColors): Readonly<Record<CozyColorToken, CozyWorldThemeColorUnit>> {
  const result = {} as Record<CozyColorToken, CozyWorldThemeColorUnit>;
  for (const token of COZY_COLOR_TOKENS) {
    result[token] = cozyHexToUnitArray(theme[token], 1);
  }
  return Object.freeze(result);
}

/**
 * Build the numeric Cozy theme a canvas renderer draws with.
 *
 * Total over its input, in the same way every Phase 8 resolver is: a Cozy theme
 * name, a persisted legacy string, an unknown string, `null`, and `undefined` all
 * produce a defined record. That matters here more than it does in the DOM, because
 * a renderer reads this during `app.init()` on the mount path, where a thrown
 * `TypeError` becomes a blank screen rather than a wrong swatch.
 *
 * Total over `reducedMotion` for a different reason: the boolean arrives from a
 * media query, and a renderer in a worker or a test has no query at all. Passing
 * nothing means motion is allowed, which is the state a caller that cannot observe
 * the preference is in.
 */
export function resolveCozyWorldTheme(input: CozyWorldThemeInput = {}): CozyWorldTheme {
  const variant = input.contrast ?? 'default';
  const theme = resolveCozyColors(input.theme ?? null, variant);
  return Object.freeze({
    color: numericColors(theme),
    colorUnit: unitColors(theme),
    radius: COZY_RADIUS_PX,
    space: COZY_SPACE_PX,
    border: COZY_BORDER_WIDTH_PX,
    focus: COZY_FOCUS_PX,
    fontSize: COZY_FONT_SIZE_PX,
    lineHeight: COZY_LINE_HEIGHT_NUMBER,
    fontWeight: COZY_FONT_WEIGHT_NUMBER,
    fontFamily: Object.freeze({
      display: canvasFontFamily('display'),
      body: canvasFontFamily('body'),
      code: canvasFontFamily('code'),
    }),
    touchTargetMin: COZY_TOUCH_TARGET_MIN,
    easing: COZY_MOTION_EASING_CURVE,
    motion: resolveMotionProfile(input.reducedMotion ?? false),
    source: Object.freeze({ theme, variant }),
  });
}

/**
 * The same theme, rebuilt for a live `prefers-reduced-motion` change.
 *
 * A separate function rather than a parameter on the resolver because the caller
 * holds a resolved theme and the media query can change later: re-reading one
 * boolean is the whole update, and nothing else in the record can have changed.
 */
export function withCozyWorldMotion(theme: CozyWorldTheme, reducedMotion: boolean): CozyWorldTheme {
  if (theme.motion.reduced === reducedMotion) return theme;
  return Object.freeze({ ...theme, motion: resolveMotionProfile(reducedMotion) });
}

/* -------------------------------------------------------------------------- */
/* A CSS-free `TextStyle` recipe                                               */
/* -------------------------------------------------------------------------- */

/**
 * The digit spelling of a font weight, which is what a canvas `TextStyle` takes.
 *
 * PixiJS 8 types `TextStyle.fontWeight` as a *string* union (`'100'` .. `'900'`,
 * plus the `normal`/`bold` keywords), which is the one place in this file where a
 * Cozy token cannot be handed to a canvas as a number. It is still a number on the
 * way in: the value arrives from `COZY_FONT_WEIGHT_NUMBER`, and
 * {@link fontWeightSpelling} turns it into one of these by lookup, so the authored
 * token stays the single source and the conversion is arithmetic rather than a
 * second authored table.
 */
export type CozyFontWeightSpelling = '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';

/**
 * The spellings a canvas will accept, as a lookup rather than a type.
 *
 * This is the second of this phase's two unchecked casts, and it is here as a `Map`
 * so that **none remains**. The cast it replaces - `String(weight) as
 * CozyFontWeightSpelling` - was a `string` narrowed to a nine-member union on nothing
 * but the author's memory of the Cozy tokens, and the comment beside it cited
 * `tests/phase9/cozy-world-theme.test.ts` as the thing that kept it honest. That file
 * did not exist. A cast whose stated gate is not there is the same defect as the
 * `as unknown as` in the composition root, one layer down: it cannot fail, so nothing
 * reports it when the token table moves.
 *
 * The map is keyed by the numeric mirror's value and typed by the union, so a
 * successful lookup *is* the narrowing - no assertion, nothing to believe - and a
 * token authored outside the nine hundred-step weights throws the way every other
 * malformed Cozy token throws at conversion, rather than reaching a canvas as a
 * plausible wrong weight that no part of the design system declares.
 */
const COZY_FONT_WEIGHT_SPELLINGS: ReadonlyMap<number, CozyFontWeightSpelling> = new Map([
  [100, '100'],
  [200, '200'],
  [300, '300'],
  [400, '400'],
  [500, '500'],
  [600, '600'],
  [700, '700'],
  [800, '800'],
  [900, '900'],
]);

/**
 * The canvas spelling of a Cozy weight, or a `TypeError` naming the weight.
 *
 * @throws TypeError on a token outside `100`-`900` in hundred steps.
 */
function fontWeightSpelling(weight: number, weightName: string): CozyFontWeightSpelling {
  const spelling = COZY_FONT_WEIGHT_SPELLINGS.get(weight);
  if (spelling === undefined) {
    throw new TypeError(
      `The Cozy font-weight mirror gives ${weightName} = ${weight}, and a canvas text style accepts only ` +
        'the nine hundred-step weights from 100 to 900.',
    );
  }
  return spelling;
}

/**
 * The parts of a canvas `TextStyle` a Cozy world draws with, as numbers.
 *
 * Declared here rather than in a scene so the conversion is one authored list
 * instead of one per call site, and so `tests/phase9/pixi-host-boundary.test.ts`
 * can assert that no scene builds a style from a CSS string.
 */
export interface CozyTextStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
  /** The digit spelling, because a canvas `TextStyle` will not take a number here. */
  readonly fontWeight: CozyFontWeightSpelling;
  /** Multiplier rather than a computed line height, which is what the token is. */
  readonly lineHeight: number;
  readonly fill: number;
  readonly align: 'left' | 'center' | 'right';
}

/** Which stack, which size, and which weight a world label uses. */
export interface CozyTextStyleInput {
  readonly role?: 'display' | 'body' | 'code';
  readonly size?: keyof CozyWorldTheme['fontSize'];
  readonly weight?: keyof CozyWorldTheme['fontWeight'];
  readonly lineHeight?: keyof CozyWorldTheme['lineHeight'];
  readonly color?: CozyColorToken;
  readonly align?: 'left' | 'center' | 'right';
}

/**
 * Build a canvas text style from Cozy tokens.
 *
 * Frozen because a `TextStyle` is read on every text object and a shared record
 * that a scene edited would change every later label in the session - the same
 * integrity rule the token tables themselves follow.
 *
 * The weight conversion is a lookup in a typed map rather than a second authored
 * table, and rather than a cast: see {@link COZY_FONT_WEIGHT_SPELLINGS}. The authored
 * token stays the single source, the conversion is arithmetic, and a token outside
 * the nine hundred-step weights throws here rather than reaching a canvas as a
 * plausible wrong value.
 */
export function cozyTextStyle(theme: CozyWorldTheme, input: CozyTextStyleInput = {}): CozyTextStyle {
  const role = input.role ?? 'body';
  const weightName = input.weight ?? 'regular';
  return Object.freeze({
    fontFamily: theme.fontFamily[role],
    fontSize: theme.fontSize[input.size ?? 'md'],
    fontWeight: fontWeightSpelling(theme.fontWeight[weightName], weightName),
    lineHeight: theme.lineHeight[input.lineHeight ?? 'normal'],
    fill: theme.color[input.color ?? 'textPrimary'],
    align: input.align ?? 'left',
  });
}

/* -------------------------------------------------------------------------- */
/* Token-kind helper                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What a token is *used* for, which is what contrast obligations follow.
 *
 * Re-exported rather than re-declared so a renderer can ask "is this token text or
 * a boundary?" - the question behind plan 10.1's text and non-text contrast minima
 * and behind the "no colour-only state" rule - without keeping its own list that
 * could drift from the token source.
 */
export const COZY_WORLD_TOKEN_KINDS = COZY_COLOR_TOKEN_KINDS;

/** A named duration, in the vocabulary a scene reads it by. */
export type { CozyMotionDuration, CozyMotionTravel };
