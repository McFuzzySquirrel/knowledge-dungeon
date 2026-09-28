/**
 * Cozy token -> CSS custom property mapping and emitters.
 *
 * Renderer-neutral by contract: this module builds strings and plain objects.
 * It never reads `document`, never creates a `CSSStyleSheet`, and never writes
 * to a style attribute. A PixiJS host is free to import it for the numeric
 * accessors without dragging a DOM shim into a worker.
 *
 * The emitted text is checked into `src/styles/cozy-tokens.css` so React gets
 * the tokens from the stylesheet (no first-paint flash, no JavaScript in the
 * critical path). `tests/phase8/cozy-tokens.test.ts` compares this emitter's
 * output with the file byte-for-byte, so the two cannot drift.
 *
 * The scope contract - which attribute, which value, which flag - lives in
 * ./cozyScope and is re-exported at the bottom of this file, so
 * `@/theme` stays the single import surface.
 */

import {
  COZY_BORDER_WIDTH,
  COZY_CONTRAST_VARIANTS,
  COZY_FOCUS,
  COZY_FONT_SIZE,
  COZY_FONT_WEIGHT,
  COZY_LEGACY_VARIABLE_BRIDGE,
  COZY_LINE_HEIGHT,
  COZY_RADIUS,
  COZY_SPACE,
  COZY_THEME_CONTRAST_POLARITY,
  COZY_THEMES,
  COZY_TOUCH_TARGET_MIN_PX,
  COZY_DEFAULT_THEME,
  resolveCozyColors,
  type CozyColorToken,
  type CozyContrastPolarity,
  type CozyContrastVariant,
  type CozyTheme,
  type CozyThemeColors,
} from './cozyTokens';
import {
  COZY_COLOR_PREFIX,
  COZY_SCALE_PREFIX,
  cozyHighContrastScope,
  cozyScope,
} from './cozyScope';
import {
  COZY_MOTION_DURATION_MS,
  COZY_MOTION_EASING,
  FULL_MOTION_SCALE,
} from './motion';
import { TYPOGRAPHY } from './typography';

/** The CSS custom property name for a semantic colour token. */
export function cozyColorVariable(token: CozyColorToken): string {
  return `${COZY_COLOR_PREFIX}-${kebabCase(token)}`;
}

/** `surfacePanelSoft` -> `surface-panel-soft`. */
export function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

/** The CSS custom property name for a legacy bridged variable. */
export function cozyBridgedVariable(legacyVariable: string): string {
  return legacyVariable;
}

/**
 * The colour custom properties for one resolved token set, in emission order.
 *
 * This is the React-facing view of a token set. A renderer-facing view is the
 * same map read through `cozyHexToNumber` in `cozyColor.ts`.
 */
export function cozyColorVariables(colors: CozyThemeColors): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [token, value] of Object.entries(colors)) {
    out[cozyColorVariable(token as CozyColorToken)] = value;
  }
  return Object.freeze(out);
}

/** The non-colour custom properties: geometry, type, focus, and motion. */
export function cozyScaleVariables(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(COZY_RADIUS)) {
    out[`${COZY_SCALE_PREFIX}-radius-${name}`] = value;
  }
  for (const [name, value] of Object.entries(COZY_SPACE)) {
    out[`${COZY_SCALE_PREFIX}-space-${name}`] = value;
  }
  for (const [name, value] of Object.entries(COZY_BORDER_WIDTH)) {
    out[`${COZY_SCALE_PREFIX}-border-${name}`] = value;
  }
  for (const [name, value] of Object.entries(COZY_FONT_SIZE)) {
    out[`${COZY_SCALE_PREFIX}-font-size-${name}`] = value;
  }
  for (const [name, value] of Object.entries(COZY_LINE_HEIGHT)) {
    out[`${COZY_SCALE_PREFIX}-line-height-${name}`] = value;
  }
  for (const [name, value] of Object.entries(COZY_FONT_WEIGHT)) {
    out[`${COZY_SCALE_PREFIX}-font-weight-${name}`] = value;
  }
  for (const [name, value] of Object.entries(COZY_MOTION_EASING)) {
    out[`${COZY_SCALE_PREFIX}-easing-${name}`] = value;
  }
  for (const [name, ms] of Object.entries(COZY_MOTION_DURATION_MS)) {
    out[`${COZY_SCALE_PREFIX}-duration-${name}`] = `${ms}ms`;
  }
  out[`${COZY_SCALE_PREFIX}-font-game`] = TYPOGRAPHY.primary;
  out[`${COZY_SCALE_PREFIX}-font-body`] = TYPOGRAPHY.body;
  out[`${COZY_SCALE_PREFIX}-font-mono`] = TYPOGRAPHY.mono;
  out[`${COZY_SCALE_PREFIX}-focus-ring-width`] = COZY_FOCUS.ringWidth;
  out[`${COZY_SCALE_PREFIX}-focus-ring-offset`] = COZY_FOCUS.ringOffset;
  out[`${COZY_SCALE_PREFIX}-focus-halo-width`] = COZY_FOCUS.haloWidth;
  out[`${COZY_SCALE_PREFIX}-target-min`] = `${COZY_TOUCH_TARGET_MIN_PX}px`;
  out[`${COZY_SCALE_PREFIX}-motion-scale`] = String(FULL_MOTION_SCALE);
  return Object.freeze(out);
}

/** The bridge that makes the existing stylesheet consume the Cozy palette. */
export function cozyBridgedVariables(colors: CozyThemeColors): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [legacyVariable, token] of Object.entries(COZY_LEGACY_VARIABLE_BRIDGE)) {
    out[cozyBridgedVariable(legacyVariable)] = colors[token];
  }
  return Object.freeze(out);
}

function declarations(variables: Readonly<Record<string, string>>): string {
  return Object.entries(variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}

function selectorList(selectors: readonly string[]): string {
  return selectors.join(',\n');
}

function rule(selector: string, variables: Readonly<Record<string, string>>): string {
  return `${selector} {\n${declarations(variables)}\n}`;
}

/**
 * The generated content of `src/styles/cozy-tokens.css`, minus its hand-written
 * banner comment.
 *
 * Structure, in cascade order:
 *  1. Document-level defaults from the default theme, so the page surface is
 *     already Cozy before React renders and nothing flashes the legacy palette.
 *  2. Per-theme colour blocks on the existing `.ui-skin[data-theme]` hooks, so
 *     no component has to change to pick up a Cozy palette. Each block carries
 *     the legacy-variable bridge, which is how the existing stylesheet ends up
 *     consuming Cozy colours without a component rewrite.
 *  3. Page-surface rules. The document background cannot inherit a custom
 *     property from the descendant that carries `data-theme`, so each legacy
 *     value gets an explicit `:has()` bridge. The value is a literal rather than
 *     `var(--cozy-c-surface-page)` precisely because it has to resolve on
 *     `<body>`, not on the descendant.
 *  4. High-contrast overlays, addressed by the `data-cozy-contrast="high"`
 *     attribute on the scope element, and by `prefers-contrast: more`. Grouped
 *     by surface polarity, so four themes cost two blocks, not four.
 */
export function cozyGeneratedStyleSheet(
  themeSelectors: Readonly<Record<CozyTheme, readonly string[]>>,
  pageSurfaceSelectors: Readonly<Record<CozyTheme, readonly string[]>>,
): string {
  const scope = cozyScope();
  const lines: string[] = [];

  lines.push('/* Document-level Cozy defaults: the page surface before React renders. */');
  const defaultTheme = COZY_THEMES[COZY_DEFAULT_THEME];
  lines.push(
    rule(`${scope}, ${scope} body, ${scope} #root`, {
      ...cozyColorVariables(defaultTheme),
      ...cozyBridgedVariables(defaultTheme),
      ...cozyScaleVariables(),
    }),
  );

  const themeEntries = Object.entries(themeSelectors) as [CozyTheme, readonly string[]][];

  for (const [theme, selectors] of themeEntries) {
    const colors = COZY_THEMES[theme];
    lines.push(
      `/* ${theme} */`,
      rule(
        selectorList(selectors.map((selector) => `${scope} ${selector}`)),
        { ...cozyColorVariables(colors), ...cozyBridgedVariables(colors) },
      ),
      `/* ${theme} page surface. */`,
      `${selectorList(pageSurfaceSelectors[theme] ?? [])} {\n  background: ${colors.surfacePage};\n  color-scheme: ${COZY_THEME_COLOR_SCHEME[theme]};\n}`,
    );
  }

  const byPolarity = new Map<CozyContrastPolarity, string[]>();
  for (const [theme, selectors] of themeEntries) {
    const polarity = COZY_THEME_CONTRAST_POLARITY[theme];
    const bucket = byPolarity.get(polarity) ?? [];
    bucket.push(...selectors.map((selector) => `${scope} ${selector}`));
    byPolarity.set(polarity, bucket);
  }
  for (const [polarity, selectors] of byPolarity) {
    const colors = COZY_CONTRAST_VARIANTS[polarity];
    const variables = { ...cozyColorVariables(colors), ...cozyBridgedVariables(colors) };
    const explicit = selectors
      .map((selector) => selector.replace(scope, cozyHighContrastScope()))
      .join(',\n');
    lines.push(
      `/* High contrast (${polarity} surfaces): explicit attribute, or the platform preference. */`,
      rule(explicit, variables),
      `@media (prefers-contrast: more) {\n${rule(selectorList(selectors), variables)}\n}`,
    );
  }

  return `${lines.join('\n\n')}\n`;
}

/** `color-scheme` per theme, so native controls and scrollbars match the surface. */
export const COZY_THEME_COLOR_SCHEME = Object.freeze({
  'cozy-ink': 'dark',
  'cozy-parchment': 'light',
  'cozy-berry': 'dark',
  'cozy-firelight': 'dark',
} as const satisfies Readonly<Record<CozyTheme, 'light' | 'dark'>>);

/** Every custom property name the Cozy system can emit, for drift tests. */
export function cozyAllVariableNames(): readonly string[] {
  const names = new Set<string>();
  for (const theme of Object.keys(COZY_THEMES) as CozyTheme[]) {
    for (const name of Object.keys(cozyColorVariables(resolveCozyColors(theme, 'default')))) {
      names.add(name);
    }
  }
  for (const colors of Object.values(COZY_CONTRAST_VARIANTS)) {
    for (const name of Object.keys(cozyColorVariables(colors))) names.add(name);
  }
  for (const name of Object.keys(cozyScaleVariables())) names.add(name);
  for (const name of Object.keys(COZY_LEGACY_VARIABLE_BRIDGE)) names.add(name);
  return Object.freeze([...names].sort());
}

/** The contrast variants, exposed so consumers need not re-derive the union. */
export const COZY_CONTRAST_VARIANT_NAMES: readonly CozyContrastVariant[] = Object.freeze([
  'default',
  'highContrast',
] as const);

// The scope contract lives in ./cozyScope so the preferences store can depend on
// it without dragging the token graph into the Welcome bundle; it is re-exported
// here so `@/theme` remains the single import surface for consumers.
export {
  COZY_COLOR_PREFIX,
  COZY_CONTRAST_ATTRIBUTE,
  COZY_CONTRAST_HIGH_VALUE,
  COZY_CSS_PREFIX,
  COZY_SCALE_PREFIX,
  COZY_VISUALS_ATTRIBUTE,
  COZY_VISUALS_ENABLED_VALUE,
  COZY_VISUALS_ENV_KEY,
  cozyHighContrastScope,
  cozyScope,
} from './cozyScope';
