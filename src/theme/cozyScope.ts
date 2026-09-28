/**
 * The Cozy scope contract: which attribute, which value, which flag.
 *
 * Split out from `cozyCss.ts` on purpose. The scope is a *contract* between
 * `index.html` (which carries the attribute) and every Cozy stylesheet (which is
 * qualified by it) - not an implementation detail of the CSS emitter. Keeping it
 * in its own dependency-free module means the preferences store, which needs the
 * theme mapping, does not pull the whole token graph - colour data, the emitter,
 * and the motion tables - into the Welcome bundle when the Cozy flag is off and
 * nothing reads those values.
 *
 * Renderer-neutral by contract: four string constants and two string builders.
 * See `RENDERER_NEUTRAL_THEME_MODULES` in `cozyTokens.ts`.
 */

import { RUNTIME_FLAG_ENV_KEYS } from '../config/runtimeConfig';

/** Every Cozy custom property is prefixed so it cannot collide with `--kd-*`. */
export const COZY_CSS_PREFIX = '--cozy';

/**
 * Two disjoint sub-prefixes.
 *
 * `c` is a colour token, `s` is a scale/metric token. The split exists because
 * the flat spellings collide: colour token `borderFocus` and border-width token
 * `focus` both want `--cozy-border-focus`. Keeping the groups in separate
 * namespaces makes a collision impossible by construction, and
 * `cozyAllVariableNames()` lets the token test assert it.
 */
export const COZY_COLOR_PREFIX = `${COZY_CSS_PREFIX}-c`;
export const COZY_SCALE_PREFIX = `${COZY_CSS_PREFIX}-s`;

/** The build-time flag that turns the Cozy visual system on. */
export const COZY_VISUALS_ENV_KEY = RUNTIME_FLAG_ENV_KEYS.cozyVisuals;

/** The attribute `index.html` carries, substituted from `VITE_COZY_VISUALS`. */
export const COZY_VISUALS_ATTRIBUTE = 'data-cozy-visuals';

/** The value that attribute must have for any Cozy rule to match. */
export const COZY_VISUALS_ENABLED_VALUE = 'true';

/** The attribute a future settings surface sets to force the high-contrast map. */
export const COZY_CONTRAST_ATTRIBUTE = 'data-cozy-contrast';

/** The value that attribute must have to force the high-contrast map. */
export const COZY_CONTRAST_HIGH_VALUE = 'high';

/**
 * The Cozy scope prefix, applied to every selector in both Cozy stylesheets.
 *
 * With `VITE_COZY_VISUALS=false` - the production default for this phase - the
 * attribute carries the unsubstituted placeholder from `index.html`, this
 * selector matches nothing, and the legacy stylesheet is what renders.
 *
 * The scope is the `<html>` element, which is also where a future settings
 * surface sets {@link COZY_CONTRAST_ATTRIBUTE}, so the high-contrast overlay
 * inherits down to every `.ui-skin` without each screen having to know.
 */
export function cozyScope(): string {
  return `[${COZY_VISUALS_ATTRIBUTE}='${COZY_VISUALS_ENABLED_VALUE}']`;
}

/** The scope plus the high-contrast attribute, for a forced-high-contrast rule. */
export function cozyHighContrastScope(): string {
  return `${cozyScope()}[${COZY_CONTRAST_ATTRIBUTE}='${COZY_CONTRAST_HIGH_VALUE}']`;
}
