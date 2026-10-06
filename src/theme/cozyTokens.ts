/**
 * The Cozy storybook design tokens - the single machine-readable source of truth
 * for Phase 8 (`docs/plans/001-cozy-pixi-rebuild.md`).
 *
 * Every visual decision in the Cozy visual system is declared here and nowhere
 * else. React DOM reads it as CSS custom properties (emitted by `cozyCss.ts`,
 * checked into `src/styles/cozy.css` and verified byte-for-byte by the token
 * test). A future PixiJS host reads the same numbers through `cozyColor.ts`
 * (`cozyHexToNumber` / `cozyHexToUnitArray`), and the non-colour tables below
 * carry a second, numeric face for it: `COZY_RADIUS_PX` and its siblings are
 * derived from the CSS string tables at module scope by `cozyNumbers.ts`, so
 * the two spellings cannot drift and neither consumer has to parse a unit.
 *
 * RENDERER-NEUTRAL BY CONTRACT
 * ----------------------------
 * This file - and every module listed in {@link RENDERER_NEUTRAL_THEME_MODULES}
 * - must not import React, a renderer, or touch `document`/`window`/`globalThis`.
 * The Phase 8 token test walks the transitive first-party import graph and fails
 * if any of that changes, so the boundary cannot rot silently.
 *
 * The five named families from the plan Scope are {@link COZY_COLOR_FAMILIES}:
 * warm parchment, moss, berry, ink, and firelight. A theme is a *recipe* over
 * those families; `COZY_THEMES` holds the four recipes the existing persisted
 * preferences map onto, and {@link COZY_CONTRAST_VARIANTS} holds the two
 * high-contrast overlays layered on top of them.
 *
 * Two properties make this source *shared* rather than merely common, and both
 * are asserted by `tests/phase8/cozy-token-integrity.test.ts`:
 *
 * 1. **Frozen.** Every exported data literal is frozen at module scope, nested
 *    objects included, so no consumer can edit the token source in place. One
 *    host writing `colors.accent = '#ff0000'` used to repaint the React DOM for
 *    the rest of the session, because {@link resolveCozyColors} returned the
 *    live module constant rather than a copy. A mutating consumer now either
 *    throws (module code is strict) or changes nothing; it can never reach
 *    anyone else. That is also why the resolver hands back the shared frozen
 *    recipe instead of a per-call copy: identity is the cheapest way to be sure
 *    there is no second mutable copy to go stale, and a caller that wants a
 *    mutable map of its own already gets one from `cozyColorVariables()`.
 * 2. **Total.** {@link resolveCozyColors} normalises whatever a host holds - a
 *    Cozy theme name, a persisted legacy colour-theme string, an unknown
 *    string, `null`, `undefined` - to a defined theme, so reading the
 *    preference and casting it is not a crash.
 *
 * Accessibility contract (plan 10.1). Ratios below were computed with
 * `cozyContrastRatio` in `cozyColor.ts` - the same function the shipped test
 * uses - and the per-pair minimums are enforced by `tests/phase8/cozy-tokens.test.ts`:
 *
 * - Text at 4.5:1 minimum; the high-contrast variants target 7:1.
 * - Non-text at 3:1 minimum; the high-contrast variants target 4.5:1.
 * - `borderHairline` is classified `decorative`: it is a panel divider that
 *   carries no information, which WCAG 1.4.11 exempts. Every boundary a learner
 *   must see to identify a control uses `borderControl` (>= 3:1, enforced).
 * - A token's role is the role it is *used* in, not the role it was first
 *   given: `accentSoft` is read as 11-15 pixel text by the existing stylesheet,
 *   so it is classified `text` and owes 4.5:1 even where nothing reaches it
 *   today.
 * - No state may be signalled by colour alone; see `COZY_STATE_SIGNALS`. Those
 *   two shapes are delivered by an unscoped stylesheet
 *   (`src/styles/state-signals.css`) as well as by the Cozy-scoped one, because
 *   the phase exit criterion is about the artifact that actually ships, and
 *   `VITE_COZY_VISUALS` is false by default.
 */

import type { CozyHex } from './cozyColor';
// Phase 9: the numeric face of the scale tables below. A *value* import, and the
// only one Phase 9 adds, because a renderer reads these tokens as numbers and the
// conversion is derived from the string tables rather than written out twice. The
// module has no imports of its own, so this edge cannot introduce a cycle.
import { cozyPxMirror, cozyUnitlessMirror } from './cozyNumbers';
// The one dependency the token source takes, and it is a *value* import: the
// migration table is the only place that knows which strings a persisted
// preference can hold, so {@link resolveCozyColors} reads it rather than
// re-deriving the aliases. The direction is one-way - `legacyThemeMap.ts`
// imports only *types* from this module, so there is no cycle to reason about,
// and both files stay renderer-neutral plain data.
import { cozyThemeForColorTheme } from './legacyThemeMap';

/** Bumped whenever a token value or name changes, so CSS drift is detectable. */
export const COZY_TOKEN_SCHEMA_VERSION = '1.0.0' as const;

/**
 * The modules in `src/theme/` that make up the renderer-neutral token core.
 *
 * `index.ts` is the barrel and is deliberately not listed: it re-exports the
 * listed modules and nothing else. Every *other* file directly in `src/theme/`
 * must appear here. A new module that needs the DOM has to be added deliberately
 * and the token test updated, rather than smuggled in - the inventory test in
 * `tests/phase8/cozy-tokens.test.ts` fails on an unclassified file.
 */
export const RENDERER_NEUTRAL_THEME_MODULES = Object.freeze([
  'cozyColor.ts',
  'cozyCss.ts',
  'cozyNumbers.ts',
  'cozyScope.ts',
  'cozyTokens.ts',
  'colors.ts',
  'icons.ts',
  'legacyThemeMap.ts',
  'motion.ts',
  'typography.ts',
] as const);

/** Barrel modules excluded from {@link RENDERER_NEUTRAL_THEME_MODULES}. */
export const THEME_BARREL_MODULES = Object.freeze(['index.ts'] as const);

export type RendererNeutralThemeModule = (typeof RENDERER_NEUTRAL_THEME_MODULES)[number];

/* -------------------------------------------------------------------------- */
/* Colour families                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Raw art-direction shades per family. These are the *inputs* to a theme recipe
 * and are intentionally not emitted as CSS custom properties: a renderer draws
 * a scene, it does not paint a specific parchment swatch. The derived semantic
 * tokens below are what both consumers read.
 *
 * `paletteFamilies` in `public/assets/asset-licenses.json` holds the provisional
 * placeholder-art colours the CC0 generator reads. Those are art values, not
 * tokens; this object is the token source of truth.
 */
export const COZY_COLOR_FAMILIES = Object.freeze({
  /** Warm parchment: paper, cards, light surfaces. */
  parchment: Object.freeze({
    base: '#f7ecd8',
    shade: '#eddfc3',
    deep: '#e0cda6',
    line: '#b39a72',
    ink: '#241a11',
  }),
  /** Moss: growth, confirmation, "you may proceed". */
  moss: Object.freeze({
    deep: '#2c4a1c',
    base: '#4b6f30',
    light: '#87ac5c',
  }),
  /** Berry: ripe accent, error, danger. */
  berry: Object.freeze({
    deep: '#6d1c2b',
    base: '#9c2f42',
    light: '#dd8e9a',
  }),
  /** Ink: the dark neutral family, and the dark reading surface. */
  ink: Object.freeze({
    deep: '#191410',
    base: '#241d18',
    soft: '#2f2620',
    raised: '#3a2f27',
    sunken: '#120e0b',
    line: '#4c4034',
    text: '#f4eee3',
  }),
  /** Firelight: lantern warmth, accent, focus, selection. */
  firelight: Object.freeze({
    ember: '#c9691f',
    glow: '#e08a3c',
    spark: '#f5c563',
  }),
} as const satisfies Readonly<Record<string, Readonly<Record<string, CozyHex>>>>);

/* -------------------------------------------------------------------------- */
/* Semantic colour tokens                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How each semantic colour token is used, which is what makes the contrast
 * obligations derivable instead of hand-listed.
 *
 * - `surface`     - a background; other tokens are measured against it.
 * - `text`        - foreground text, >= 4.5:1 against every non-selection surface.
 * - `nonText`     - a meaningful boundary or indicator, >= 3:1 against the
 *                   surfaces it is drawn on, plus its declared partner.
 * - `onFill`      - foreground for a filled control; measured against the fills
 *                   named in {@link COZY_FILL_PARTNER_TOKENS}.
 * - `fill`        - a control background. It carries no obligation of its own;
 *                   the `onFill` partner covers it.
 * - `decorative`  - carries no information, so WCAG 1.4.11 exempts it.
 */
export type CozyTokenKind = 'surface' | 'text' | 'nonText' | 'onFill' | 'fill' | 'decorative';

export const COZY_COLOR_TOKEN_KINDS = Object.freeze({
  surfacePage: 'surface',
  surfacePanel: 'surface',
  surfacePanelSoft: 'surface',
  surfaceRaised: 'surface',
  surfaceSunken: 'surface',
  selectionBg: 'surface',

  borderHairline: 'decorative',
  borderControl: 'nonText',
  borderStrong: 'nonText',
  borderFocus: 'nonText',
  focusHalo: 'nonText',
  selectionBorder: 'nonText',

  textPrimary: 'text',
  textSecondary: 'text',
  textMuted: 'text',
  accent: 'text',
  good: 'text',
  bad: 'text',
  warning: 'text',
  info: 'text',

  /**
   * `text`, not `nonText`, and the distinction is load-bearing rather than
   * tidy: `src/styles.css` reads `var(--accent-soft)` as a `color:` value at
   * eleven sites, at 11 to 15 CSS pixels, and bold 11 pixels is still WCAG
   * *normal* text. Classified as `nonText` the token only owed 3:1, which
   * `cozy-parchment` duly met at 3.33:1 - and would then have failed as text
   * the moment `light`/`sepia` reached the theme picker or a later phase
   * rendered a parchment surface. The obligation follows the role the token is
   * actually used in.
   */
  accentSoft: 'text',

  textOnAccent: 'onFill',
  textOnSelection: 'onFill',
  accentDeep: 'fill',
} as const satisfies Readonly<Record<string, CozyTokenKind>>);

export type CozyColorToken = keyof typeof COZY_COLOR_TOKEN_KINDS;

/** Every semantic colour token, in emission order. */
export const COZY_COLOR_TOKENS: readonly CozyColorToken[] = Object.freeze(
  Object.keys(COZY_COLOR_TOKEN_KINDS) as CozyColorToken[],
);

/** Tokens that other colour tokens are contrast-measured against. */
export const COZY_SURFACE_TOKENS: readonly CozyColorToken[] = Object.freeze(
  COZY_COLOR_TOKENS.filter((token) => COZY_COLOR_TOKEN_KINDS[token] === 'surface'),
);

/**
 * Text-on-fill tokens and the fills each one must be readable against.
 *
 * The reason `COZY_LEGACY_VARIABLE_BRIDGE` carries two "text on a filled control" entries rather
 * than one: the obligation follows the **fill**, and a stylesheet rule that puts text on the accent
 * fill is asking a different question than one that puts it on the selection plate. See
 * `--control-text-on-accent` for the violation that made the distinction observable.
 */
export const COZY_FILL_PARTNER_TOKENS = Object.freeze({
  textOnAccent: Object.freeze(['accent', 'accentDeep'] as const),
  textOnSelection: Object.freeze(['selectionBg'] as const),
} as const satisfies Readonly<Record<string, readonly CozyColorToken[]>>);

/**
 * Non-surface pairs a `nonText` token must clear, beyond "every surface".
 *
 * `focusHalo` and `selectionBorder` are drawn *inside* a fill, so their job is
 * to separate from that fill - not to stand out from the page behind it.
 */
export const COZY_NON_TEXT_PARTNER_TOKENS = Object.freeze({
  focusHalo: 'borderFocus',
  selectionBorder: 'selectionBg',
} as const satisfies Readonly<Record<string, CozyColorToken>>);

/** The WCAG thresholds per contrast variant, from plan 10.1. */
export const COZY_CONTRAST_MINIMUMS = Object.freeze({
  default: Object.freeze({ text: 4.5, nonText: 3 } as const),
  highContrast: Object.freeze({ text: 7, nonText: 4.5 } as const),
} as const);

export type CozyContrastVariant = keyof typeof COZY_CONTRAST_MINIMUMS;

export type CozyThemeColors = Readonly<Record<CozyColorToken, CozyHex>>;

/* -------------------------------------------------------------------------- */
/* Theme recipes                                                              */
/* -------------------------------------------------------------------------- */

export const COZY_THEMES = Object.freeze({
  /**
   * The default Cozy theme. Warm ink surfaces, firelight accents, moss for
   * confirmation. This is the recipe the legacy `dark` preference lands on.
   *
   * Measured: worst text 4.81:1 (textOnAccent on accentDeep), worst non-text
   * 3.60:1 (borderControl on surfaceRaised).
   */
  'cozy-ink': Object.freeze({
    surfacePage: '#191410',
    surfacePanel: '#241d18',
    surfacePanelSoft: '#2f2620',
    surfaceRaised: '#3a2f27',
    surfaceSunken: '#120e0b',
    selectionBg: '#8f4316',
    // decorative divider: no information, no minimum
    borderHairline: '#4c4034', // 1.65:1 vs surfacePanel - decorative only
    borderControl: '#96846c', // min 3.60:1 vs surfaceRaised
    borderStrong: '#ab9887', // min 4.69:1 vs surfaceRaised
    borderFocus: '#f5c563', // min 8.08:1 vs surfaceRaised
    focusHalo: '#120e0b', // 11.93:1 vs borderFocus
    selectionBorder: '#f5c563', // 4.38:1 vs selectionBg
    textPrimary: '#f4eee3', // min 11.25:1 vs surfaceRaised
    textSecondary: '#c9bdab', // min 7.02:1 vs surfaceRaised
    textMuted: '#b0a390', // min 5.25:1 vs surfaceRaised
    accent: '#f5c563', // min 8.08:1 vs surfaceRaised
    good: '#87ac5c', // min 5.00:1 vs surfaceRaised
    bad: '#dd8e9a', // min 5.20:1 vs surfaceRaised
    warning: '#f0a355', // min 6.24:1 vs surfaceRaised
    info: '#e8d7b4', // min 9.17:1 vs surfaceRaised
    accentSoft: '#f8d894', // min 9.43:1 vs surfaceRaised
    textOnAccent: '#191410', // min 4.81:1 vs accentDeep
    textOnSelection: '#fdf6e8', // 6.55:1 vs selectionBg
    accentDeep: '#c9691f', // fill; covered by textOnAccent
  }),

  /**
   * Warm paper. The recipe the legacy `light` and `sepia` preferences land on.
   *
   * Measured: worst text 4.66:1 (textMuted on surfaceSunken), worst non-text
   * 3.21:1 (borderControl on surfaceSunken). surfaceSunken is the binding
   * constraint for every light-theme token - the darkest light surface.
   */
  'cozy-parchment': Object.freeze({
    surfacePage: '#e0cda6',
    surfacePanel: '#f9f0dd',
    surfacePanelSoft: '#f0e5cd',
    surfaceRaised: '#fdf8ee',
    surfaceSunken: '#d6c199',
    selectionBg: '#241a11',
    borderHairline: '#b39a72', // 2.38:1 vs surfacePanel - decorative only
    borderControl: '#7a6440', // min 3.21:1 vs surfaceSunken
    borderStrong: '#4a3a22', // min 6.22:1 vs surfaceSunken
    borderFocus: '#7f370c', // min 4.87:1 vs surfaceSunken
    focusHalo: '#fdf8ee', // 8.08:1 vs borderFocus
    selectionBorder: '#fdf8ee', // 16.12:1 vs selectionBg
    textPrimary: '#241a11', // min 9.71:1 vs surfaceSunken
    textSecondary: '#4e3f2c', // min 5.77:1 vs surfaceSunken
    textMuted: '#5b4d38', // min 4.66:1 vs surfaceSunken
    accent: '#7f370c', // min 4.87:1 vs surfaceSunken
    good: '#2c4a1c', // min 5.68:1 vs surfaceSunken
    bad: '#6d1c2b', // min 6.45:1 vs surfaceSunken
    warning: '#6e420a', // min 4.88:1 vs surfaceSunken
    info: '#241a11', // min 9.71:1 vs surfaceSunken
    // Text role (see COZY_COLOR_TOKEN_KINDS), so 4.5:1 and not 3:1. The
    // parchment polarity leaves almost no room for a *soft* accent: the darkest
    // light surface is surfaceSunken, and #a54a12 measured 3.33:1 there. The
    // lightest amber in this family that clears 4.5:1 with real headroom sits
    // within one step of `accent` (4.87:1), which is the honest trade: on a
    // light surface "soft accent" can no longer mean "washed out".
    accentSoft: '#7a360d', // min 5.06:1 vs surfaceSunken
    textOnAccent: '#fdf8ee', // min 8.08:1 vs accent
    textOnSelection: '#fdf8ee', // 16.12:1 vs selectionBg
    accentDeep: '#6b2c0a', // fill; covered by textOnAccent
  }),

  /**
   * Deep berry. The recipe the legacy `colorful` preference lands on.
   *
   * Measured: worst text 4.99:1 (textOnAccent on accentDeep), worst non-text
   * 4.01:1 (borderControl on surfaceRaised).
   */
  'cozy-berry': Object.freeze({
    surfacePage: '#190d12',
    surfacePanel: '#241419',
    surfacePanelSoft: '#311b22',
    surfaceRaised: '#3f242c',
    surfaceSunken: '#120809',
    selectionBg: '#8f4316',
    borderHairline: '#5c3b44', // 1.82:1 vs surfacePanel - decorative only
    borderControl: '#ab7d88', // min 4.01:1 vs surfaceRaised
    borderStrong: '#c4a3aa', // min 6.11:1 vs surfaceRaised
    borderFocus: '#f5c563', // min 8.70:1 vs surfaceRaised
    focusHalo: '#120809', // 12.26:1 vs borderFocus
    selectionBorder: '#f5c563', // 4.38:1 vs selectionBg
    textPrimary: '#fbeef0', // min 12.39:1 vs surfaceRaised
    textSecondary: '#e3c8cd', // min 8.94:1 vs surfaceRaised
    textMuted: '#c6a7ad', // min 6.35:1 vs surfaceRaised
    accent: '#f5c563', // min 8.70:1 vs surfaceRaised
    good: '#87ac5c', // min 5.39:1 vs surfaceRaised
    bad: '#e58d99', // min 5.73:1 vs surfaceRaised
    warning: '#f0a355', // min 6.72:1 vs surfaceRaised
    info: '#efdcc4', // min 10.47:1 vs surfaceRaised
    accentSoft: '#f8d894', // min 10.16:1 vs surfaceRaised
    textOnAccent: '#190d12', // min 4.99:1 vs accentDeep
    textOnSelection: '#fdf6e8', // 6.55:1 vs selectionBg
    accentDeep: '#c9691f', // fill; covered by textOnAccent
  }),

  /**
   * Lantern warmth. The recipe the legacy `aurora` preference lands on.
   *
   * Measured: worst text 4.94:1 (textOnAccent on accentDeep), worst non-text
   * 4.14:1 (borderControl on surfaceRaised).
   */
  'cozy-firelight': Object.freeze({
    surfacePage: '#1c1310',
    surfacePanel: '#271c16',
    surfacePanelSoft: '#33261d',
    surfaceRaised: '#403023',
    surfaceSunken: '#140d0a',
    selectionBg: '#8f4316',
    borderHairline: '#5b4632', // 1.87:1 vs surfacePanel - decorative only
    borderControl: '#ad8e72', // min 4.14:1 vs surfaceRaised
    borderStrong: '#cbab86', // min 5.83:1 vs surfaceRaised
    borderFocus: '#ffc87a', // min 8.28:1 vs surfaceRaised
    focusHalo: '#140d0a', // 12.64:1 vs borderFocus
    selectionBorder: '#ffc87a', // 4.63:1 vs selectionBg
    textPrimary: '#f9ecda', // min 10.83:1 vs surfaceRaised
    textSecondary: '#dfc7a8', // min 7.73:1 vs surfaceRaised
    textMuted: '#c2a988', // min 5.60:1 vs surfaceRaised
    accent: '#ffc87a', // min 8.28:1 vs surfaceRaised
    good: '#93b86a', // min 5.59:1 vs surfaceRaised
    bad: '#e78d88', // min 5.14:1 vs surfaceRaised
    warning: '#f0a355', // min 6.05:1 vs surfaceRaised
    info: '#eedcc2', // min 9.40:1 vs surfaceRaised
    accentSoft: '#ffddad', // min 9.73:1 vs surfaceRaised
    textOnAccent: '#1c1310', // min 4.94:1 vs accentDeep
    textOnSelection: '#fdf6e8', // 6.55:1 vs selectionBg
    accentDeep: '#c0722a', // fill; covered by textOnAccent
  }),
} as const satisfies Readonly<Record<string, CozyThemeColors>>);

export type CozyTheme = keyof typeof COZY_THEMES;

/** The default recipe, used for the pre-render page surface. */
export const COZY_DEFAULT_THEME: CozyTheme = 'cozy-ink';

/** Which high-contrast overlay each theme takes. Two, not four: the HC values
 *  depend on the surface polarity, not on the accent hue. */
export const COZY_THEME_CONTRAST_POLARITY = Object.freeze({
  'cozy-ink': 'dark',
  'cozy-berry': 'dark',
  'cozy-firelight': 'dark',
  'cozy-parchment': 'light',
} as const satisfies Readonly<Record<CozyTheme, 'dark' | 'light'>>);

export type CozyContrastPolarity = (typeof COZY_THEME_CONTRAST_POLARITY)[CozyTheme];

/**
 * High-contrast overlays. Each is a *complete* token set, not a partial patch,
 * so a renderer can read one map without composing two.
 *
 * `dark` is shared by cozy-ink, cozy-berry, and cozy-firelight.
 * Measured: worst text 9.15:1, worst non-text 6.81:1 (both vs surfaceRaised) -
 * comfortably above the 7:1 / 4.5:1 high-contrast targets.
 */
export const COZY_CONTRAST_VARIANTS = Object.freeze({
  dark: Object.freeze({
    surfacePage: '#000000',
    surfacePanel: '#151009',
    surfacePanelSoft: '#241c14',
    surfaceRaised: '#33291e',
    surfaceSunken: '#000000',
    selectionBg: '#6e2f0b',
    borderHairline: '#5a4a3a', // 2.23:1 vs surfacePanel - decorative only
    borderControl: '#c3b198', // min 6.81:1 vs surfaceRaised
    borderStrong: '#f0e0c8', // min 10.97:1 vs surfaceRaised
    borderFocus: '#ffd782', // min 10.36:1 vs surfaceRaised
    focusHalo: '#000000', // 15.29:1 vs borderFocus
    selectionBorder: '#ffd782', // 7.37:1 vs selectionBg
    textPrimary: '#ffffff', // min 14.22:1 vs surfaceRaised
    textSecondary: '#f4e9d8', // min 11.85:1 vs surfaceRaised
    textMuted: '#e0cdb0', // min 9.16:1 vs surfaceRaised
    accent: '#ffd782', // min 10.36:1 vs surfaceRaised
    good: '#c2e59a', // min 10.14:1 vs surfaceRaised
    bad: '#ffc0c8', // min 9.23:1 vs surfaceRaised
    warning: '#ffc48a', // min 9.15:1 vs surfaceRaised
    info: '#f4e6cd', // min 11.54:1 vs surfaceRaised
    accentSoft: '#ffe9bd', // min 11.95:1 vs surfaceRaised
    textOnAccent: '#000000', // min 10.49:1 vs accentDeep
    textOnSelection: '#ffffff', // 10.12:1 vs selectionBg
    accentDeep: '#ffa23c', // fill; covered by textOnAccent
  }),
  light: Object.freeze({
    surfacePage: '#ffffff',
    surfacePanel: '#ffffff',
    surfacePanelSoft: '#f7f0e2',
    surfaceRaised: '#ffffff',
    surfaceSunken: '#eae0cc',
    selectionBg: '#2b2118',
    borderHairline: '#b39a72', // 2.38:1 vs surfacePanel - decorative only
    borderControl: '#5c4526', // min 6.87:1 vs surfaceSunken
    borderStrong: '#2b2118', // min 12.02:1 vs surfaceSunken
    borderFocus: '#7a2c00', // min 7.33:1 vs surfaceSunken
    focusHalo: '#ffffff', // 9.60:1 vs borderFocus
    selectionBorder: '#ffffff', // 15.75:1 vs selectionBg
    textPrimary: '#000000', // min 16.03:1 vs surfaceSunken
    textSecondary: '#2e2418', // min 11.60:1 vs surfaceSunken
    textMuted: '#463726', // min 8.74:1 vs surfaceSunken
    accent: '#7a2c00', // min 7.33:1 vs surfaceSunken
    good: '#1b3410', // min 10.38:1 vs surfaceSunken
    bad: '#6e0f1e', // min 9.16:1 vs surfaceSunken
    warning: '#573000', // min 8.77:1 vs surfaceSunken
    info: '#1a1207', // min 14.14:1 vs surfaceSunken
    // Text role, and the high-contrast light variant owes 7:1. #8a3603 measured
    // 6.14:1 against surfaceSunken, which is the one surface in this polarity
    // dark enough to bind.
    accentSoft: '#6e2b02', // min 7.98:1 vs surfaceSunken
    textOnAccent: '#ffffff', // min 9.60:1 vs accent
    textOnSelection: '#ffffff', // 15.75:1 vs selectionBg
    accentDeep: '#3d1600', // fill; covered by textOnAccent
  }),
} as const satisfies Readonly<Record<CozyContrastPolarity, CozyThemeColors>>);

/**
 * Anything a host may legitimately hold where a theme is expected.
 *
 * A host that reads the persisted preference itself holds a *legacy* string -
 * `dark`, `light`, `sepia`, `colorful`, `aurora` - not a {@link CozyTheme}, and
 * the natural line to write is `resolveCozyColors(stored as CozyTheme, ...)`.
 * That cast is exactly the kind written without thinking, so the parameter type
 * admits the real value instead: `string & {}` keeps the Cozy theme literals in
 * editor completion while accepting any other string, and `null | undefined`
 * admits an absent preference. Typed callers are unaffected - every existing
 * argument still typechecks - and an untyped one gets a defined token set
 * instead of a `TypeError` on the next property read.
 */
export type CozyThemeInput = CozyTheme | (string & {}) | null | undefined;

/**
 * The Cozy theme a caller means, for any value a caller can hold.
 *
 * A Cozy theme name resolves to itself. Everything else goes through the
 * migration table, so a persisted legacy value lands on the theme it mapped to
 * and an unknown or absent value lands on the fallback rather than on
 * `undefined`. The order matters: a Cozy theme name is checked first, because
 * `'cozy-parchment'` is not a legacy value and would otherwise fall through to
 * the fallback and silently render ink.
 *
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a corrupt
 * `'toString'` would be reported as a key of the table and handed back as the
 * "token set".
 */
function cozyThemeForInput(value: CozyThemeInput): CozyTheme {
  if (typeof value === 'string' && Object.hasOwn(COZY_THEMES, value)) return value as CozyTheme;
  return cozyThemeForColorTheme(value);
}

/**
 * The full token set for a theme and contrast variant.
 *
 * This is the single read a renderer needs. React turns it into CSS custom
 * properties; a PixiJS host turns it into numeric colours.
 *
 * Total over {@link CozyThemeInput}: a Cozy theme name, any persisted legacy
 * colour-theme string, an unknown string, `null`, and `undefined` all return a
 * defined token set. The returned recipe is the shared frozen literal, so a
 * caller that mutates it cannot reach anyone else - see the integrity contract
 * in this module's header.
 */
export function resolveCozyColors(
  theme: CozyThemeInput,
  variant: CozyContrastVariant = 'default',
): CozyThemeColors {
  const resolved = cozyThemeForInput(theme);
  if (variant === 'default') return COZY_THEMES[resolved];
  return COZY_CONTRAST_VARIANTS[COZY_THEME_CONTRAST_POLARITY[resolved]];
}

/**
 * {@link resolveCozyColors} for a host that has a *preference* rather than a
 * theme, which is what a renderer reading storage actually has.
 *
 * The two are the same function; this name exists so the call site says what it
 * is doing. `resolveCozyColors(storedPreference)` and
 * `resolveCozyColorsForPreference(storedPreference)` are pinned to agree for
 * every input, so neither can become the wrong one to reach for.
 */
export function resolveCozyColorsForPreference(
  value: CozyThemeInput,
  variant: CozyContrastVariant = 'default',
): CozyThemeColors {
  return resolveCozyColors(value, variant);
}

/* -------------------------------------------------------------------------- */
/* Non-colour tokens                                                          */
/* -------------------------------------------------------------------------- */

/** Rounded storybook geometry, in CSS pixels. */
export const COZY_RADIUS = Object.freeze({
  none: '0px',
  sm: '6px',
  md: '10px',
  lg: '16px',
  xl: '22px',
  panel: '18px',
  pill: '999px',
} as const);

/**
 * {@link COZY_RADIUS} as numbers, for a renderer host (Phase 9).
 *
 * Derived from the string table at module scope, never written out a second time.
 * The two therefore cannot disagree: there is one authored value per token, and
 * the only way to change one is to change {@link COZY_RADIUS}.
 */
export const COZY_RADIUS_PX = cozyPxMirror(COZY_RADIUS, 'COZY_RADIUS');

/** A 4-pixel base scale. `COZY_SPACE` values are emitted as CSS lengths. */
export const COZY_SPACE = Object.freeze({
  '0': '0px',
  '1': '4px',
  '2': '8px',
  '3': '12px',
  '4': '16px',
  '5': '20px',
  '6': '24px',
  '7': '28px',
  '8': '32px',
  '10': '40px',
  '12': '48px',
} as const);

/**
 * {@link COZY_SPACE} as numbers, for a renderer host (Phase 9).
 *
 * The keys are the same numeric *strings* the CSS uses, so a host reads
 * `COZY_SPACE_PX['4']` and a stylesheet reads `--cozy-s-space-4`: there is no
 * second key scheme to translate between.
 */
export const COZY_SPACE_PX = cozyPxMirror(COZY_SPACE, 'COZY_SPACE');

/** Border weights. The focus ring is deliberately heavier than any state border. */
export const COZY_BORDER_WIDTH = Object.freeze({
  hairline: '1px',
  state: '2px',
  focus: '3px',
} as const);

/** {@link COZY_BORDER_WIDTH} as numbers, for a renderer host (Phase 9). */
export const COZY_BORDER_WIDTH_PX = cozyPxMirror(COZY_BORDER_WIDTH, 'COZY_BORDER_WIDTH');

/**
 * Plan 10.1: minimum 44 by 44 CSS-pixel touch targets.
 *
 * A bare number rather than a CSS string, because it never had a CSS form to
 * keep: there is no authored `--cozy-s-target-min` value, and `cozyCss.ts`
 * composes that custom property *from* this number. So this token is the source
 * rather than a mirror, and it needs no `_PX` twin of its own.
 */
export const COZY_TOUCH_TARGET_MIN = 44 as const;

/**
 * The pre-Phase-9 name for {@link COZY_TOUCH_TARGET_MIN}, kept because callers
 * import it.
 *
 * Two names for one value used to mean two literals that could drift apart; the
 * alias is now defined *from* the canonical constant, so a single number is
 * authored and the two can never disagree. The `_PX` suffix is a slight
 * misnomer - the value counts CSS pixels, it is not a CSS length - but renaming
 * it is a call-site change in modules this phase does not own, and the mismatch
 * is harmless. New code should read `COZY_TOUCH_TARGET_MIN`.
 */
export const COZY_TOUCH_TARGET_MIN_PX = COZY_TOUCH_TARGET_MIN;

/**
 * The storybook type scale, in CSS pixels. Long-form note body text uses
 * `md`; nothing in a learner's notes is forced into a display size.
 */
export const COZY_FONT_SIZE = Object.freeze({
  xs: '12px',
  sm: '13px',
  md: '14px',
  lg: '16px',
  xl: '20px',
  xxl: '26px',
  display: '32px',
} as const);

/**
 * {@link COZY_FONT_SIZE} as numbers, for a renderer host (Phase 9).
 *
 * `TextStyle.fontSize` is a number, so this is the value a canvas text object
 * takes rather than a string it has to be handed instead of one.
 */
export const COZY_FONT_SIZE_PX = cozyPxMirror(COZY_FONT_SIZE, 'COZY_FONT_SIZE');

export const COZY_LINE_HEIGHT = Object.freeze({
  tight: '1.25',
  snug: '1.4',
  normal: '1.5',
  relaxed: '1.7',
} as const);

/**
 * {@link COZY_LINE_HEIGHT} as numbers, for a renderer host (Phase 9).
 *
 * Named `_NUMBER` rather than `_PX` on purpose: a line height is a unitless
 * multiplier, and a `_PX` suffix would claim pixels that are not there.
 */
export const COZY_LINE_HEIGHT_NUMBER = cozyUnitlessMirror(
  COZY_LINE_HEIGHT,
  'COZY_LINE_HEIGHT',
);

export const COZY_FONT_WEIGHT = Object.freeze({
  regular: '400',
  medium: '600',
  bold: '700',
} as const);

/**
 * {@link COZY_FONT_WEIGHT} as numbers, for a renderer host (Phase 9).
 *
 * `TextStyle.fontWeight` is a number and not a CSS keyword, so the string table
 * forces a conversion at the call site. The suffix matches
 * {@link COZY_LINE_HEIGHT_NUMBER}: these two tables are already unitless, so
 * their mirrors are numbers rather than pixel counts.
 */
export const COZY_FONT_WEIGHT_NUMBER = cozyUnitlessMirror(
  COZY_FONT_WEIGHT,
  'COZY_FONT_WEIGHT',
);

/**
 * Focus treatment, in CSS pixels.
 *
 * The ring is an `outline` (a shape, not a tint) plus a 2px halo in
 * `focusHalo`, which is itself >= 4.5:1 against `borderFocus`. A learner who
 * cannot distinguish the ring colour still sees a 3px offset outline.
 */
export const COZY_FOCUS = Object.freeze({
  ringWidth: '3px',
  ringOffset: '2px',
  haloWidth: '2px',
} as const);

/** {@link COZY_FOCUS} as numbers, for a renderer host (Phase 9). */
export const COZY_FOCUS_PX = cozyPxMirror(COZY_FOCUS, 'COZY_FOCUS');

/**
 * The non-colour signal every Cozy state must carry, per plan 10.1
 * ("no color-only state communication") and the phase exit criterion
 * ("focus and state styling is visible without relying on color").
 *
 * `src/styles/cozy.css` implements these for the flag-on build and
 * `src/styles/state-signals.css` for both, so a selected or pressed control
 * carries the same two shapes whichever build renders it.
 * `tests/phase8/state-signal-parity.test.ts` parses both stylesheets and
 * compares the declarations against this table, because a constant that
 * describes signals the CSS does not deliver is worse than no constant: it is
 * read as a guarantee.
 */
export const COZY_STATE_SIGNALS = Object.freeze({
  /** Keyboard focus: a 3px offset outline plus a halo. */
  focus: '3px offset outline',
  /**
   * `aria-selected` / `aria-pressed="true"`: 700 weight and a 3px bar.
   *
   * These two are the whole contract because they are the two that *every*
   * selected control can carry. A border is deliberately not claimed: the
   * Welcome tab buttons are `border: none` in the legacy stylesheet, so a
   * `border-width` there computes to nothing, and giving them a border would
   * widen a `width: fit-content` flex strip - the one change that can
   * reintroduce horizontal overflow at 320 CSS pixels. Controls that already
   * have a border (`.phase-card`) do get the 2px state border on top of these
   * two, so the declared pair is a floor rather than a ceiling.
   */
  selected: '700 weight + 3px underline bar',
  /** Hover: surface raise only. Never the sole indicator of anything. */
  hover: 'surfaceRaised fill, no state meaning',
  /** Disabled: reduced opacity plus `not-allowed` cursor (set in the component). */
  disabled: '50% opacity',
  /** Checklist completion: a `✓` glyph, not just a green tint. */
  complete: 'leading ✓ glyph + border weight',
} as const);

/**
 * Token-to-legacy-variable bridge.
 *
 * The Cozy themes are delivered by remapping the semantic custom properties the
 * existing 5,900-line stylesheet already consumes, so the whole UI picks up the
 * palette without a component rewrite - Phase 8's "no wholesale React component
 * replacement" non-goal. `src/styles/cozy.css` emits this map inside the Cozy
 * scope; `src/theme/cozyCss.ts` is the source of truth for it.
 */
export const COZY_LEGACY_VARIABLE_BRIDGE = Object.freeze({
  '--bg-deep': 'surfacePage',
  '--bg-panel': 'surfacePanel',
  '--bg-panel-soft': 'surfacePanelSoft',
  '--border-soft': 'borderControl',
  '--text-primary': 'textPrimary',
  '--text-secondary': 'textSecondary',
  '--text-muted': 'textMuted',
  '--accent': 'accent',
  '--accent-soft': 'accentSoft',
  '--accent-cool': 'good',
  '--good': 'good',
  '--bad': 'bad',
  '--control-bg': 'surfacePanelSoft',
  '--control-border': 'borderControl',
  '--control-hover-bg': 'surfaceRaised',
  '--control-selected-bg': 'selectionBg',
  '--control-selected-text': 'textOnSelection',
  '--control-selected-border': 'selectionBorder',
  /*
   * Phase 21. Text that sits **directly on the accent fill**, which is a different obligation from
   * `textOnSelection` and the reason this entry exists.
   *
   * `--control-selected-text` maps to `textOnSelection`, and `TEXT_ROLE_BACKGROUNDS` below declares
   * that token's background to be `selectionBg` alone. So it is measured against a burnt-orange
   * selection plate, and it is measured to pass there. Three rules in the legacy stylesheet put it
   * on `--accent` instead - a pale warm gold - where the same near-white lands at 2.13:1 on the
   * default night theme. axe reported one of them (`serious: color-contrast` on `.active` in the
   * village); the other two are the same bug behind a different class name, and a third of the same
   * shape is behind a `linear-gradient` axe cannot measure at all.
   *
   * `textOnAccent` is the token whose declared backgrounds are `accent` and `accentDeep`
   * (`TEXT_ROLE_BACKGROUNDS` again), so bridging it is not a new colour and not a second token
   * system: it is the token system being read by the token that answers the question the rule is
   * actually asking. Every Cozy theme already measures it above 4.5:1 on both of its accent fills.
   */
  '--control-text-on-accent': 'textOnAccent',
  '--text-title': 'accent',
} as const);
