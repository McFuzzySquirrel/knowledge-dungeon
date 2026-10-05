/**
 * Which settings tabs a build shows.
 *
 * ## Why this is a function and not a constant
 *
 * The tablist is `SETTINGS_TABS` in `SettingsModal.tsx`, and the Phase 19 entry used to be an
 * unconditional member of it. That is the defect this module exists to fix, and the shape of the
 * fix matters as much as the fix:
 *
 * `runtimeConfig` is a **build-time** frozen constant, so a component that reads it directly is
 * only ever testable in one configuration - the one the test process was built with. Reading it
 * into a module constant (`const ASSISTANCE_ON = runtimeConfig.adaptiveAssistance`, the pattern
 * `RoomPanel` uses for its own flags) has the same limit. Both would force a flagged-configuration
 * test to mock `@/config/featureFlags`, which makes the test assert against a mock rather than
 * against the product.
 *
 * A pure function taking the flag as a parameter is testable in **both** directions in one process,
 * with no module mock and no global state, so "absent when off" and "present when on" are two
 * ordinary assertions rather than one assertion and one unreachable branch.
 *
 * ## Why the flag is a parameter here and a prop in {@link AssistanceSlot}
 *
 * `AssistanceSlot` takes `flagEnabled` as a prop because it sits four component trees deep and
 * threading a provider through all of them to satisfy a test would be a worse change than the prop.
 * `SettingsModal` renders the list itself, so the same seam is one argument wide. One rule: **the
 * flag arrives from somewhere a test can reach, and the decision is made by a pure function.**
 *
 * ## There is deliberately no `activeTab` clamp here
 *
 * An earlier revision of this module also exported `resolveActiveSettingsTab`, which mapped a
 * selection naming a hidden tab back to the first visible one. Two non-vacuity probes (G5 and G6 in
 * `/tmp/opencode/kd19/gate-probes.sh`) removed it and removed the render-time use of it, and
 * **nothing went red** in either direction.
 *
 * That is the correct result, and the reason is structural rather than a missing test: `activeTab`
 * is `useState('theme')` and is only ever written by a click on a **rendered** tab, so it cannot
 * name a tab this build does not show. The clamp guarded an unreachable state, so it was deleted
 * rather than left in place with a test written to cover a branch no input can reach. An
 * unobservable branch that *looks* defensive is worse than no branch.
 *
 * ## What this function must not do
 *
 * It must not drop a tab the flag does not own, and it must not reorder or rename what survives.
 * Both are covered by an exact-list assertion in
 * `tests/phase19/assistanceUiSettingsGate.test.tsx` in each configuration, which is why the return
 * is the list rather than a count.
 */
import type { SupportedLocale } from '@/i18n';

/** One settings tab, as the modal's own `TabDef` describes it. */
export interface SettingsTabDescriptor {
  readonly id: string;
  readonly label: string;
  readonly labelKey: string;
}

/**
 * The tab id Phase 19 owns.
 *
 * A single constant rather than a literal in three places, so the id the gate filters on and the id
 * the modal renders and the id the panel switches on cannot drift apart. Written out because
 * `SettingsModal`'s `SettingsTab` union is its own type and importing it would make this module
 * depend on the file it exists to keep honest.
 */
export const ASSISTANCE_TAB_ID = 'assistance';

/**
 * The tabs to render, given the Phase 19 flag.
 *
 * `flagEnabled: false` - the production default, `VITE_ADAPTIVE_ASSISTANCE` unset - removes the
 * Assistance tab and changes nothing else. That is the whole behaviour: a learner on the default
 * build opens Settings, sees the four tabs they have always seen, and cannot set a mode for a
 * feature this build cannot produce, so the promise the tab makes is never made.
 *
 * `flagEnabled: true` keeps the list as declared, order included.
 *
 * ## Why the id rather than a predicate
 *
 * A predicate (`tabs.filter((tab) => tab.id !== 'assistance' || on)`) puts the condition at the
 * call site, where a later edit can widen it. Naming the one id this module may remove makes the
 * blast radius of a mistake a *missing* tab rather than a wrongly-removed one - and the missing tab
 * is what the exact-list assertions in both configurations would catch.
 */
export function visibleSettingsTabs<T extends SettingsTabDescriptor>(
  tabs: readonly T[],
  flagEnabled: boolean,
): readonly T[] {
  if (flagEnabled) return tabs;
  return tabs.filter((tab) => tab.id !== ASSISTANCE_TAB_ID);
}

/** Re-exported so a caller of {@link visibleSettingsTabs} can type its locale without a second import. */
export type { SupportedLocale };