/**
 * The one place a Cozy token string becomes a number (Phase 9).
 *
 * ## Why the token source needs a numeric face
 *
 * The Cozy scale tokens are CSS *strings* - `COZY_RADIUS.md` is `'10px'` - because
 * the stylesheet is a first-class consumer and `--cozy-s-radius-md: 10px` has to be
 * a length to survive a cascade. A renderer is the other first-class consumer, and
 * it cannot use a string: `Graphics.roundRect` takes a number, a tween takes
 * milliseconds, and a `TextStyle` takes a numeric `fontSize` and `fontWeight`. A
 * host that reached for `Number.parseFloat('10px')` would work today, and that is
 * exactly the problem: the parsing lives in renderer code, where it hard-codes a
 * CSS unit assumption that nothing checks.
 *
 * Phase 8 recorded the gap rather than hiding it (`tests/phase8/pixi-token-consumption.test.ts`,
 * "exposes six of seven scale families as CSS strings, not numbers"), and Phase 9
 * closes it. The mirrors in `cozyTokens.ts` and `motion.ts` are *derived* from the
 * string tables by the functions here, so there is one authored value per token and
 * no second list to fall out of step.
 *
 * ## Why this module refuses to guess
 *
 * `Number.parseFloat('1rem')` is `1`. That single fact is the failure mode this
 * module exists to make impossible: a token authored in `rem` or `em` - the natural
 * next step for a spacing scale, since rem is what most design systems reach for -
 * would become a silently wrong pixel number, and a renderer would faithfully draw
 * a quarter of the intended panel. Nothing about the wrong value looks wrong: it is
 * a finite number in range, so every plausibility check a consumer might write
 * (`Number.isFinite`, `> 0`, `< 1000`) passes.
 *
 * So the conversion is strict, and it fails **loudly**:
 *
 * - `cozyPxNumber` accepts `<signed decimal>px` and nothing else. A `rem`, `em`,
 *   `%`, `vh`, `calc()`, a bare number, a `var()` reference, or a typo such as
 *   `'10 px'` throws a `TypeError` naming the token and the value.
 * - The mirrors are built at module scope, so a token that cannot be converted
 *   fails when the module is evaluated - in the token test, in CI, in the dev
 *   server, and in a shipped bundle. There is no build flag and no dev-only branch
 *   that could strip the check, because the check *is* the conversion.
 * - `cozyUnitlessNumber` is the mirror-image rule for the tables that are already
 *   unitless (`COZY_LINE_HEIGHT`, `COZY_FONT_WEIGHT`): a bare number converts, and
 *   a stray unit - `'1.5px'` as a line height - throws, because the unit would be a
 *   different mistake with the same consequence.
 * - `cozyEasingCurve` accepts exactly `cubic-bezier(a, b, c, d)` with four finite
 *   numbers whose x control points lie in 0..1, which is what CSS requires. The y
 *   control points are deliberately *un*constrained beyond finiteness: a
 *   `cubic-bezier(0.68, -0.55, 0.27, 1.55)` is a valid overshoot curve, and
 *   rejecting it here would be stricter than the stylesheet.
 *
 * This is the same policy `parseCozyHex` in `cozyColor.ts` already applies to
 * colour: a malformed token throws at conversion rather than rendering as a
 * plausible wrong value. The difference is that a wrong colour is visible, while a
 * wrong pixel count usually is not.
 *
 * ## The decision this module encodes, stated plainly
 *
 * "A Cozy scale token is authored in `px`, or it is not authored yet." A future
 * token that wants `rem` must be added as a `px` token plus an explicit
 * documented conversion, so the arithmetic a renderer performs is visible in this
 * repository rather than assumed inside a tween.
 *
 * Renderer-neutral by contract: string and number arithmetic, no DOM, no renderer
 * import, no I/O. See `RENDERER_NEUTRAL_THEME_MODULES` in `cozyTokens.ts`.
 */

/**
 * The numeric mirror of a CSS-string token table: the same keys, as numbers.
 *
 * A mapped type over the string table rather than `Record<string, number>`, so
 * `COZY_RADIUS_PX.md` is a number *and* `COZY_RADIUS_PX.nonexistent` is a compile
 * error. Adding a token to the string table widens the mirror's type at the same
 * time, which is what keeps the two from drifting apart in the type system as well
 * as at runtime.
 */
export type CozyNumberMirror<T> = { readonly [K in keyof T]: number };

/**
 * A `cubic-bezier()` control-point quadruple, in the order CSS defines them:
 * `(x1, y1, x2, y2)`.
 *
 * The shape a tween library wants. `COZY_MOTION_EASING` remains the CSS spelling,
 * and the two are derived from each other rather than authored twice.
 */
export type CozyEasingCurve = readonly [number, number, number, number];

/**
 * A CSS length in `px`: a signed decimal followed by `px`, and nothing else.
 *
 * Deliberately *not* a `parseFloat`-shaped pattern. `/^-?[\d.]+/` would accept
 * `1rem` and hand back `1`, which is the exact silent-wrong-number failure this
 * module exists to prevent.
 */
const PX_LENGTH = /^(-?(?:\d+|\d*\.\d+))px$/;

/**
 * A unitless CSS number: a line-height multiplier, a font weight, an easing point.
 *
 * A trailing unit is rejected rather than stripped, so a `px` that has appeared in
 * `COZY_LINE_HEIGHT` is a hard error instead of a number that happens to be right.
 */
const UNITLESS_NUMBER = /^-?(?:\d+|\d*\.\d+)$/;

/**
 * A `cubic-bezier()` argument list of exactly four numbers.
 *
 * `[^,()]+` rather than `[^,]+`: parentheses are excluded so a nested
 * `cubic-bezier(...)` or a `calc(...)` argument cannot match, and `+` rather than
 * `*` so `cubic-bezier(,,,)` cannot match either - `Number('')` is `0`, and four
 * empty arguments would otherwise become the perfectly valid-looking
 * `[0, 0, 0, 1]`.
 */
const CUBIC_BEZIER = /^cubic-bezier\(([^,()]+),([^,()]+),([^,()]+),([^,()]+)\)$/;

/**
 * Report a token that cannot be converted, and why the rule exists.
 *
 * `never` return, so a call site reads as the guard it is rather than as a
 * statement that happens to be followed by a return.
 */
function unconvertible(value: string, label: string, expected: string): never {
  throw new TypeError(
    `cozyNumbers: ${label} is "${value}", which is not ${expected}. ` +
      'A renderer host reads Cozy tokens as numbers, so a token that cannot be ' +
      'converted without a CSS unit assumption fails here rather than becoming a ' +
      'plausible wrong number.',
  );
}

/**
 * The number of CSS pixels in a `px` token value.
 *
 * @param value The authored token value, e.g. `'10px'`.
 * @param label How to name the token in a failure, e.g. `'COZY_RADIUS.md'`.
 * @throws TypeError on anything that is not `<signed decimal>px`.
 */
export function cozyPxNumber(value: string, label: string): number {
  const digits = PX_LENGTH.exec(value)?.[1];
  if (digits === undefined) {
    unconvertible(value, label, 'a bare number of CSS pixels, such as "10px"');
  }
  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) {
    unconvertible(value, label, 'a finite number of CSS pixels');
  }
  return parsed;
}

/**
 * A unitless token value as a number, for the tables CSS also treats as unitless.
 *
 * @param value The authored token value, e.g. `'400'`.
 * @param label How to name the token in a failure, e.g. `'COZY_FONT_WEIGHT.bold'`.
 * @throws TypeError on a value carrying any unit, including `px`.
 */
export function cozyUnitlessNumber(value: string, label: string): number {
  const digits = UNITLESS_NUMBER.exec(value)?.[0];
  if (digits === undefined) {
    unconvertible(value, label, 'a unitless number, such as "400" or "1.5"');
  }
  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) {
    unconvertible(value, label, 'a finite unitless number');
  }
  return parsed;
}

/**
 * Build a frozen numeric mirror of a string token table.
 *
 * Frozen because these are read by a renderer per frame and shared with React,
 * exactly like the string tables they mirror; see the integrity contract in
 * `cozyTokens.ts`. The freeze is unconditional and deep-by-construction: every
 * value is a primitive number, so freezing the record is the whole job.
 */
function mirror<T extends Readonly<Record<string, string>>>(
  table: T,
  label: string,
  convert: (value: string, label: string) => number,
): CozyNumberMirror<T> {
  const converted: Record<string, number> = {};
  for (const [name, value] of Object.entries(table)) {
    converted[name] = convert(value, `${label}.${name}`);
  }
  // The cast is the price of deriving the key set at run time rather than writing
  // it out: `Object.entries` widens the literal keys to `string`, and the mapped
  // type is the compiler's view of a record that provably has exactly those keys.
  // Nothing is asserted about the values here - the conversion above produced each
  // one, and it throws rather than guessing - and
  // `tests/phase9/themeNumericMirrors.test.ts` pins the key set against the string
  // table, so a dropped or renamed token fails there rather than at a call site.
  return Object.freeze(converted) as CozyNumberMirror<T>;
}

/** A frozen numeric mirror of a `px` length table, e.g. `COZY_RADIUS`. */
export function cozyPxMirror<T extends Readonly<Record<string, string>>>(
  table: T,
  label: string,
): CozyNumberMirror<T> {
  return mirror(table, label, cozyPxNumber);
}

/** A frozen numeric mirror of a unitless table, e.g. `COZY_FONT_WEIGHT`. */
export function cozyUnitlessMirror<T extends Readonly<Record<string, string>>>(
  table: T,
  label: string,
): CozyNumberMirror<T> {
  return mirror(table, label, cozyUnitlessNumber);
}

/**
 * The four control-point numbers of a `cubic-bezier()` token.
 *
 * @param value The authored token value, e.g. `'cubic-bezier(0.2, 0, 0, 1)'`.
 * @param label How to name the token in a failure, e.g. `'COZY_MOTION_EASING.standard'`.
 * @throws TypeError on any other spelling, on a non-finite argument, or on an x
 *   control point outside 0..1, which is not a valid CSS easing.
 */
export function cozyEasingCurve(value: string, label: string): CozyEasingCurve {
  const groups = CUBIC_BEZIER.exec(value.trim());
  const points = groups?.slice(1, 5).map((group) => Number(group.trim()));
  if (!points || points.some((point) => !Number.isFinite(point))) {
    unconvertible(value, label, 'four finite cubic-bezier arguments, such as "cubic-bezier(0.2, 0, 0, 1)"');
  }
  const [x1, y1, x2, y2] = points;
  if (!(x1 >= 0 && x1 <= 1) || !(x2 >= 0 && x2 <= 1)) {
    unconvertible(
      value,
      label,
      'a cubic-bezier whose first and third arguments lie in 0..1, as CSS requires',
    );
  }
  const curve: [number, number, number, number] = [x1, y1, x2, y2];
  return Object.freeze(curve);
}
