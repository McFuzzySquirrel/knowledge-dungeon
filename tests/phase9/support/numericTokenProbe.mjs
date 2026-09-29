/**
 * The DOM-free numeric-token probe (Phase 9).
 *
 * Runs in a plain Node process - no bundler, no Vite, no jsdom, no React, no
 * renderer - against a bundled `src/theme/index.ts`, whose path arrives as argv[2].
 * Every global a renderer-neutral module could reach for is replaced by a
 * throwing getter first, so a reach-through fails here loudly instead of passing
 * because the outer runner happens to be jsdom.
 *
 * ## What it records, and why it is a separate process
 *
 * `tests/phase8/support/pixiHostProbe.mjs` established the technique and the
 * reason for it: the interesting claim is not "the module returns a number" - any
 * test in the jsdom suite can see that - but "the module returns a number in a
 * realm with no DOM and no React, so a worker-hosted or bare-canvas host can read
 * it". Phase 8's probe recorded the pre-Phase-9 shape of that problem: six of
 * seven scale families arrived as CSS strings, and a host recovered numbers with
 * `Number.parseFloat`. This probe records the shape Phase 9 delivers - every scale
 * family a number, every easing curve four numbers, and a defined answer for a
 * motion name that does not exist - through the same boot sequence a host would
 * use, with the arguments written into the JSON rather than described in prose.
 *
 * The report is written to stdout as JSON and nothing else is printed, so the
 * caller can parse it directly. It contains no path, no file name, and nothing
 * derived from where the checkout lives: the caller asserts on values only, which
 * is what keeps the gate identical from any directory and from any clean clone.
 *
 * Privacy: no learner data, no network, no storage, no filesystem access beyond
 * loading the bundle given on the command line.
 */

const bundlePath = process.argv[2];
if (!bundlePath) {
  throw new Error('usage: node numericTokenProbe.mjs <bundlePath>');
}

// A worker-hosted renderer has no DOM. So does a Node process, and so does the
// renderer-neutrality claim. Every one of these throws if it is touched.
for (const name of [
  'document',
  'window',
  'self',
  'navigator',
  'matchMedia',
  'localStorage',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'Image',
  'documentElement',
  'HTMLElement',
  'PIXI',
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`renderer-neutral theme module touched ${name}`);
    },
  });
}

const theme = await import(bundlePath);

const full = theme.resolveMotionProfile(false);
const reduced = theme.resolveMotionProfile(true);

// Names a host can genuinely hold: a typo, a stale content key, a JSON payload, an
// inherited object key, and a non-string. The cast is what a host that reads a
// name out of data effectively does.
const UNKNOWN_NAMES = ['typo', 'BASE', 'toString', 'constructor', '__proto__', 'nope'];

process.stdout.write(
  JSON.stringify({
    schemaVersion: theme.COZY_TOKEN_SCHEMA_VERSION,

    // The scale mirrors, whole, so the caller checks every token rather than a
    // sample. `typeof` alongside them records the shape a renderer receives.
    mirrors: {
      radius: theme.COZY_RADIUS_PX,
      space: theme.COZY_SPACE_PX,
      borderWidth: theme.COZY_BORDER_WIDTH_PX,
      fontSize: theme.COZY_FONT_SIZE_PX,
      focus: theme.COZY_FOCUS_PX,
      lineHeight: theme.COZY_LINE_HEIGHT_NUMBER,
      fontWeight: theme.COZY_FONT_WEIGHT_NUMBER,
    },
    mirrorTypes: {
      radius: typeof theme.COZY_RADIUS_PX.md,
      space: typeof theme.COZY_SPACE_PX['4'],
      borderWidth: typeof theme.COZY_BORDER_WIDTH_PX.focus,
      fontSize: typeof theme.COZY_FONT_SIZE_PX.lg,
      focus: typeof theme.COZY_FOCUS_PX.ringWidth,
      lineHeight: typeof theme.COZY_LINE_HEIGHT_NUMBER.normal,
      fontWeight: typeof theme.COZY_FONT_WEIGHT_NUMBER.bold,
    },
    stringTables: {
      radius: theme.COZY_RADIUS,
      space: theme.COZY_SPACE,
      borderWidth: theme.COZY_BORDER_WIDTH,
      fontSize: theme.COZY_FONT_SIZE,
      focus: theme.COZY_FOCUS,
      lineHeight: theme.COZY_LINE_HEIGHT,
      fontWeight: theme.COZY_FONT_WEIGHT,
    },
    touchTarget: theme.COZY_TOUCH_TARGET_MIN,

    // The host boot sequence, with no CSS-unit parsing anywhere in it.
    panel: {
      width: theme.COZY_SPACE_PX['12'],
      height: theme.COZY_SPACE_PX['10'],
      radius: theme.COZY_RADIUS_PX.panel,
      borderWidth: theme.COZY_BORDER_WIDTH_PX.focus,
      focusRingWidth: theme.COZY_FOCUS_PX.ringWidth,
    },
    label: {
      fontSize: theme.COZY_FONT_SIZE_PX.lg,
      fontWeight: theme.COZY_FONT_WEIGHT_NUMBER.bold,
      lineHeight: theme.COZY_LINE_HEIGHT_NUMBER.normal,
    },
    tint: theme.cozyHexToNumber(theme.resolveCozyColors('cozy-ink', 'default').accent),

    // Easing: the CSS string a stylesheet would use, and the four numbers a
    // tween would use, for the same token.
    easingStrings: theme.COZY_MOTION_EASING,
    easingCurves: theme.COZY_MOTION_EASING_CURVE,

    // Motion: every declared name, then the unknown ones.
    durationTable: theme.COZY_MOTION_DURATION_MS,
    fullDurations: full.serialized.durations,
    reducedDurations: reduced.serialized.durations,
    unknownDurationMs: Object.fromEntries(UNKNOWN_NAMES.map((name) => [name, full.durationMs(name)])),
    unknownReducedDurationMs: Object.fromEntries(
      UNKNOWN_NAMES.map((name) => [name, reduced.durationMs(name)]),
    ),
    unknownTravelPx: Object.fromEntries(UNKNOWN_NAMES.map((name) => [name, full.travelPx(name)])),
    unknownNameTypes: Object.fromEntries(
      UNKNOWN_NAMES.map((name) => [name, typeof full.durationMs(name)]),
    ),
    unknownValue: theme.COZY_MOTION_UNKNOWN_VALUE,

    // Frozen plain data, a host reads it every frame.
    profileFrozen: Object.isFrozen(full),
    profileIdentityStable: full === theme.resolveMotionProfile(false),
    reducedIdentityStable: reduced === theme.resolveMotionProfile(true),
    mirrorFrozen: Object.isFrozen(theme.COZY_RADIUS_PX),
    easingFrozen: Object.isFrozen(theme.COZY_MOTION_EASING_CURVE),
    easingTupleFrozen: Object.isFrozen(theme.COZY_MOTION_EASING_CURVE.standard),
  }),
);
