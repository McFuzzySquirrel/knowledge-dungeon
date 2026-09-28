/**
 * The DOM-free probe for the renderer-neutrality gate.
 *
 * Runs in a plain Node process - no bundler, no Vite, no jsdom - against the
 * bundled token core, whose path arrives as argv[2]. Every DOM global a
 * renderer-neutral module could reach for is replaced by a throwing getter, so a
 * reach-through fails here loudly instead of passing because the outer test
 * runner happens to be jsdom.
 *
 * The result is written to stdout as JSON and nothing else is printed, so the
 * caller can parse it directly. The token core is bundled into a single chunk
 * with a flat export surface precisely so this probe needs no path juggling.
 *
 * No learner data, no network, no filesystem access beyond loading the bundle.
 */

const bundlePath = process.argv[2];
if (!bundlePath) {
  throw new Error('usage: node domFreeProbe.mjs <bundlePath>');
}

for (const name of ['document', 'window', 'matchMedia', 'navigator', 'localStorage']) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`renderer-neutral token module touched ${name}`);
    },
  });
}

const tokenCore = await import(bundlePath);

const ink = tokenCore.resolveCozyColors('cozy-ink', 'default');
const high = tokenCore.resolveCozyColors('cozy-parchment', 'highContrast');
const stylesheet = tokenCore.cozyGeneratedStyleSheet(
  tokenCore.cozyThemeSelectors(),
  tokenCore.cozyPageSurfaceSelectors(),
);

process.stdout.write(
  JSON.stringify({
    contrast: tokenCore.cozyContrastRatio(ink.textPrimary, ink.surfacePanel),
    highContrast: tokenCore.cozyContrastRatio(high.textPrimary, high.surfaceSunken),
    tint: tokenCore.cozyHexToNumber(ink.accent),
    unit: tokenCore.cozyHexToUnitArray(ink.good, 0.5),
    luminance: tokenCore.cozyRelativeLuminance(ink.surfacePanel),
    mix: tokenCore.cozyMixHex(ink.surfacePanel, ink.accent, 0.25),
    variable: tokenCore.cozyColorVariable('surfacePanel'),
    stylesheetHead: stylesheet.slice(0, 44),
    stylesheetScoped: stylesheet.includes("data-cozy-visuals='true'"),
    reducedScale: tokenCore.resolveMotionProfile(true).scale,
    reducedDuration: tokenCore.resolveMotionProfile(true).durationMs('base'),
    reducedTravel: tokenCore.resolveMotionProfile(true).travelPx('medium'),
    fullScale: tokenCore.resolveMotionProfile(false).scale,
    font: tokenCore.TYPOGRAPHY.primary,
    canvasFont: tokenCore.canvasFontFamily('code'),
    theme: tokenCore.cozyThemeForColorTheme('sepia'),
    fallback: tokenCore.cozyThemeForColorTheme('not-a-theme'),
    tokenCount: tokenCore.COZY_COLOR_TOKENS.length,
    schema: tokenCore.COZY_TOKEN_SCHEMA_VERSION,
  }),
);
