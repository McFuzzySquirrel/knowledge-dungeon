/**
 * Mapping from the pre-Cozy persisted theme preference onto the Cozy themes
 * (Phase 8: "Map existing theme preferences to the Cozy theme during migration").
 *
 * Two rules govern this module:
 *
 * 1. **Nothing existing may break.** `light` and `sepia` are persisted legacy
 *    aliases that `resolveInitialColorTheme` already collapses to `dark`. They
 *    are handled here too so the mapping is total over the union type and a
 *    future fix that stops collapsing them does not silently fall through.
 * 2. **No component may have to change.** Theme reaches the DOM as
 *    `data-theme={colorTheme}` on `.ui-skin` elements. The Cozy CSS therefore
 *    keys off that same attribute (see `cozyThemeSelectors` and
 *    `src/styles/cozy.css`) instead of a new `data-cozy-theme`, so the mapping
 *    needs no JSX edits - Phase 8's "no wholesale React component replacement"
 *    non-goal.
 *
 * Renderer-neutral by contract: plain data and string building, no DOM, no
 * renderer imports. `src/store/preferencesStore.ts` re-exports the mapping so a
 * caller has one import for "which Cozy theme does this preference mean".
 */

import type { CozyTheme } from './cozyTokens';
import { cozyScope } from './cozyScope';

/** Every value a persisted `colorTheme` may hold, including the legacy aliases. */
export const LEGACY_COLOR_THEME_VALUES = Object.freeze([
  'dark',
  'colorful',
  'aurora',
  'light',
  'sepia',
] as const);

export type LegacyColorThemeValue = (typeof LEGACY_COLOR_THEME_VALUES)[number];

/**
 * The migration table.
 *
 * - `dark`   -> `cozy-ink`: both are the dark neutral reading surface; ink is
 *   the Cozy family for it.
 * - `light`  -> `cozy-parchment`, and `sepia` -> `cozy-parchment` too: both
 *   legacy aliases described a warm paper surface, which is what parchment is.
 * - `colorful` -> `cozy-berry`: the saturated, high-chroma dark palette.
 * - `aurora` -> `cozy-firelight`: the cool-glow palette maps onto the Cozy glow
 *   family, firelight.
 *
 * Every value maps to a defined theme, and no Cozy theme is unreachable from a
 * persisted preference, so a rollback build and a Cozy build show the same
 * number of distinct looks.
 */
export const LEGACY_COLOR_THEME_TO_COZY_THEME = Object.freeze({
  dark: 'cozy-ink',
  light: 'cozy-parchment',
  sepia: 'cozy-parchment',
  colorful: 'cozy-berry',
  aurora: 'cozy-firelight',
} as const satisfies Readonly<Record<LegacyColorThemeValue, CozyTheme>>);

/**
 * The Cozy theme for a persisted colour-theme value.
 *
 * Total over {@link LEGACY_COLOR_THEME_VALUES}. An unrecognised value - a
 * hand-edited or corrupted `localStorage` entry - resolves to
 * {@link COZY_FALLBACK_THEME} rather than throwing, because a theme preference
 * must never be able to stop the app from rendering.
 *
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a stored
 * `'toString'` would be reported as a key of the table and handed back as a
 * theme. The migration table is frozen, so this is the whole of the check.
 */
export function cozyThemeForColorTheme(
  value: LegacyColorThemeValue | string | null | undefined,
): CozyTheme {
  if (typeof value === 'string' && Object.hasOwn(LEGACY_COLOR_THEME_TO_COZY_THEME, value)) {
    return LEGACY_COLOR_THEME_TO_COZY_THEME[value as LegacyColorThemeValue];
  }
  return COZY_FALLBACK_THEME;
}

/** What an absent or unrecognised preference resolves to. Matches the legacy default. */
export const COZY_FALLBACK_THEME: CozyTheme = 'cozy-ink';

/**
 * The DOM selectors that carry each Cozy theme, grouped by the legacy attribute
 * value that selects it.
 *
 * This is what `src/styles/cozy.css` is generated from, so the CSS and the
 * migration table cannot disagree: the token test regenerates the stylesheet
 * from {@link cozyThemeSelectors} and compares it with the file.
 *
 * The selector matches the shape every screen already uses - a `.ui-skin`
 * element carrying `data-theme` - and deliberately does not assume a particular
 * parent, because screens differ (Welcome is a single card, the Village nests
 * one `.ui-skin` inside another).
 */
export function cozyThemeSelectors(): Readonly<Record<CozyTheme, readonly string[]>> {
  const byTheme = new Map<CozyTheme, string[]>();
  for (const value of LEGACY_COLOR_THEME_VALUES) {
    const theme = LEGACY_COLOR_THEME_TO_COZY_THEME[value];
    const bucket = byTheme.get(theme) ?? [];
    bucket.push(`.ui-skin[data-theme='${value}']`);
    byTheme.set(theme, bucket);
  }
  return Object.freeze(
    Object.fromEntries(
      [...byTheme.entries()].map(([theme, selectors]) => [theme, Object.freeze(selectors)]),
    ) as Record<CozyTheme, readonly string[]>,
  );
}

/**
 * The page-surface rules.
 *
 * `html` carries `data-cozy-visuals` but not `data-theme` - the theme lives on
 * the `.ui-skin` descendant - and custom properties inherit downward, so the
 * document background cannot see the descendant's value. These `:has()` rules
 * are the bridge. They are progressive enhancement on purpose: every target
 * browser in the plan's matrix (Chrome/Firefox >= 120, Safari >= 17,
 * Edge >= 120) supports `:has()`, and a browser that does not simply keeps the
 * document-level default Cozy page surface from `cozyGeneratedStyleSheet`.
 *
 * Every rule is emitted for every legacy value, including the aliases, so a
 * restored `sepia` preference gets parchment rather than falling back.
 */
export function cozyPageSurfaceSelectors(): Readonly<Record<CozyTheme, readonly string[]>> {
  const scope = cozyScope();
  const byTheme = new Map<CozyTheme, string[]>();
  for (const value of LEGACY_COLOR_THEME_VALUES) {
    const theme = LEGACY_COLOR_THEME_TO_COZY_THEME[value];
    const bucket = byTheme.get(theme) ?? [];
    bucket.push(`${scope} body:has(.ui-skin[data-theme='${value}'])`);
    byTheme.set(theme, bucket);
  }
  return Object.freeze(
    Object.fromEntries(
      [...byTheme.entries()].map(([theme, selectors]) => [theme, Object.freeze(selectors)]),
    ) as Record<CozyTheme, readonly string[]>,
  );
}
