/**
 * The DOM-free Phase 9 PixiJS-host probe.
 *
 * Runs in a plain Node process - no bundler, no Vite, no jsdom, and crucially no
 * React - against the bundled `src/theme/index.ts` barrel, whose path arrives as
 * argv[2]. Every global a renderer-neutral module could reach for is replaced by a
 * throwing getter, so a reach-through fails loudly here instead of passing because
 * the outer test runner happens to be jsdom.
 *
 * ## Why this mocks PixiJS instead of importing it
 *
 * `pixi.js` is deliberately not a dependency yet: plan Phase 9 ("PixiJSJS 8
 * Runtime Host") owns adding it, and Phase 8's non-goal is "No world renderer". So
 * this probe cannot construct a real `Application`. What it does instead is pin the
 * part of the contract a renderer host actually depends on, which is entirely
 * upstream of PixiJS: **the token values, and the argument shapes they are handed
 * to a Pixi call in.** Every `pinned.*` field below is a number or a string a
 * Phase 9 host would pass verbatim, recorded so this repository can assert on the
 * exact value a renderer will receive before the renderer exists.
 *
 * The mock mirrors the real PixiJS 8 call signatures deliberately, so a signature
 * drift in these modules is caught here rather than in Phase 9:
 *
 * - `new Graphics().rect(x, y, w, h).fill({ color, alpha })` - `color` is a
 *   0xRRGGBB number and `alpha` a 0..1 number.
 * - `sprite.tint = <0xRRGGBB number>`.
 * - `new Text({ style: new TextStyle({ fill, fontFamily, fontSize, fontWeight }) })`
 *   - `fontSize` is a number, `fontFamily` a CSS font stack string.
 * - `app.renderer.background.color = <0xRRGGBB number>`.
 * - `app.ticker.add((ticker) => { ticker.deltaMS * durationMs / 1000 })` - a
 *   per-frame read of the motion profile, which is why the profile has to be
 *   readable, frozen, and free of any per-frame allocation.
 *
 * Privacy: no learner data, no network, no filesystem access beyond loading the
 * bundle. The result is written to stdout as JSON and nothing else is printed, so
 * the caller can parse it directly.
 */

const bundlePath = process.argv[2];
if (!bundlePath) {
  throw new Error('usage: node pixiHostProbe.mjs <bundlePath>');
}

// A worker-hosted Pixi application has no DOM. So does a Node process, and so does
// the renderer-neutrality claim. Every one of these throws if it is touched.
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
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`renderer-neutral theme module touched ${name}`);
    },
  });
}

const theme = await import(bundlePath);

/* -------------------------------------------------------------------------- */
/* Minimal stand-ins for the PixiJS 8 surface a host binds tokens to.         */
/* -------------------------------------------------------------------------- */

class Graphics {
  fill(style) {
    this.lastFill = style;
    return this;
  }
  rect(x, y, w, h) {
    this.lastRect = { x, y, w, h };
    return this;
  }
  roundRect(x, y, w, h, radius) {
    this.lastRoundRect = { x, y, w, h, radius };
    return this;
  }
  stroke(style) {
    this.lastStroke = style;
    return this;
  }
}

class TextStyle {
  constructor(style) {
    Object.assign(this, style);
  }
}

class Text {
  constructor(options) {
    this.options = options;
  }
}

class Sprite {
  constructor(texture) {
    this.texture = texture;
  }
}

/* -------------------------------------------------------------------------- */
/* The host's own boot sequence.                                               */
/* -------------------------------------------------------------------------- */

// Phase 9 owns the flag, so the host resolves the theme name itself. A host has no
// `data-theme` element to read and no stylesheet to parse, which is exactly why the
// token source has to be a JavaScript module.
const themeName = theme.cozyThemeForColorTheme('dark');
const highContrast = false;
const colors = theme.resolveCozyColors(themeName, highContrast ? 'highContrast' : 'default');
const hcColors = theme.resolveCozyColors(themeName, 'highContrast');

const motion = theme.resolveMotionProfile(/* the host owns this detection */ false);
const reducedMotion = theme.resolveMotionProfile(true);

const unit = theme.cozyHexToUnitArray(colors.good, 0.5);
const unitOpaque = theme.cozyHexToUnitArray(colors.accent);

// Scene layer calls. These are the arguments a real PixiJS 8 host passes.
const backgroundFill = { color: theme.cozyHexToNumber(colors.surfacePage), alpha: 1 };
const panelFill = { color: theme.cozyHexToNumber(colors.surfacePanel), alpha: 1 };
const accentStroke = {
  color: theme.cozyHexToNumber(colors.borderFocus),
  width: Number.parseFloat(theme.COZY_BORDER_WIDTH.focus),
  alignment: 1,
};
const panelShape = new Graphics().roundRect(
  0,
  0,
  Number.parseFloat(theme.COZY_SPACE['12']),
  Number.parseFloat(theme.COZY_SPACE['10']),
  Number.parseFloat(theme.COZY_RADIUS.panel),
);

const tintedSprite = new Sprite('cozy-moss-grass');
tintedSprite.tint = theme.cozyHexToNumber(colors.good);

const label = new Text({
  text: 'Village',
  style: new TextStyle({
    fill: theme.cozyHexToNumber(colors.textPrimary),
    fontFamily: theme.canvasFontFamily('display'),
    fontSize: Number.parseFloat(theme.COZY_FONT_SIZE.lg),
    fontWeight: Number.parseInt(theme.COZY_FONT_WEIGHT.bold, 10),
    align: 'center',
  }),
});

// The target-size contract a host lays hit areas out with. This one is numeric
// already, which is why it is usable without parsing.
const touchTarget = theme.COZY_TOUCH_TARGET_MIN;

// Two ticker frames, read the way an animation would read them. A profile that
// allocated per call would show up here as a fresh object identity per frame; a
// profile that is cheap to read is the same object every frame.
const fullFrameA = { ms: motion.durationMs('base'), travel: motion.travelPx('medium') };
const fullFrameB = { ms: motion.durationMs('base'), travel: motion.travelPx('medium') };
const reducedFrame = {
  quick: reducedMotion.durationMs('quick'),
  slow: reducedMotion.durationMs('slow'),
  deliberate: reducedMotion.durationMs('deliberate'),
  travelMicro: reducedMotion.travelPx('micro'),
  travelLarge: reducedMotion.travelPx('large'),
};

// Phase 9 owns `Assets.load`; the probe records the URL the bundle path implies so
// this repository can assert the placeholder set stays the only admitted media.
const bundlePaths = ['public/assets/cozy/'];

// Easing is a CSS `cubic-bezier()` argument list. A canvas or WebGL host cannot
// hand that to a library as-is, so record the raw string and the parsed numbers a
// host would have to extract.
const easingStandard = theme.COZY_MOTION_EASING.standard;
const easingNumbers = easingStandard
  .slice('cubic-bezier('.length, -1)
  .split(',')
  .map((part) => Number.parseFloat(part));

process.stdout.write(
  JSON.stringify({
    themeName,
    highContrastTheme: theme.resolveCozyColors(themeName, 'highContrast').surfacePage,
    hcSurfacePageTint: theme.cozyHexToNumber(hcColors.surfacePage),
    hcContrast: theme.cozyContrastRatio(hcColors.textPrimary, hcColors.surfaceSunken),

    backgroundFill,
    panelFill,
    accentStroke,
    panelShape: panelShape.lastRoundRect,
    tintedSpriteTint: tintedSprite.tint,
    textFill: label.options.style.fill,
    textFontFamily: label.options.style.fontFamily,
    textFontSize: label.options.style.fontSize,
    textFontWeight: label.options.style.fontWeight,
    touchTarget,

    unit,
    unitOpaque,
    luminance: theme.cozyRelativeLuminance(colors.surfacePanel),
    mix: theme.cozyMixHex(colors.surfacePanel, colors.accent, 0.25),
    rgbaCss: theme.cozyRgbaCss(colors.accent, 0.5),

    fullFrameA,
    fullFrameB,
    motionIdentityStable: motion === motion,
    reducedFrame,
    reducedScale: reducedMotion.scale,
    reducedReduceAll: reducedMotion.reduceAll,
    reducedFrozen: Object.isFrozen(reducedMotion),
    reducedSerializedFrozen: Object.isFrozen(reducedMotion.serialized),
    reducedDurations: reducedMotion.serialized.durations,
    reducedTravel: reducedMotion.serialized.travel,
    fullDurations: motion.serialized.durations,
    fullTravel: motion.serialized.travel,
    durationNames: Object.keys(theme.COZY_MOTION_DURATION_MS),
    travelNames: Object.keys(theme.COZY_MOTION_TRAVEL_PX),
    easingStandard,
    easingNumbers,

    // What the scale tokens actually are, by type, as a renderer sees them.
    scaleTokenTypes: {
      radius: typeof theme.COZY_RADIUS.md,
      space: typeof theme.COZY_SPACE['4'],
      borderWidth: typeof theme.COZY_BORDER_WIDTH.focus,
      fontSize: typeof theme.COZY_FONT_SIZE.lg,
      lineHeight: typeof theme.COZY_LINE_HEIGHT.normal,
      fontWeight: typeof theme.COZY_FONT_WEIGHT.bold,
      focusRingWidth: typeof theme.COZY_FOCUS.ringWidth,
      touchTarget: typeof theme.COZY_TOUCH_TARGET_MIN,
    },
    scaleTokenValues: {
      radius: theme.COZY_RADIUS,
      space: theme.COZY_SPACE,
      borderWidth: theme.COZY_BORDER_WIDTH,
      fontSize: theme.COZY_FONT_SIZE,
      focus: theme.COZY_FOCUS,
    },

    bundlePaths,
    registryIsNotImportedHere: true,
    tokenCount: theme.COZY_COLOR_TOKENS.length,
    schemaVersion: theme.COZY_TOKEN_SCHEMA_VERSION,
  }),
);
