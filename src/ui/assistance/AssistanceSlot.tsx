/**
 * The eager half of Phase 19's DOM integration, and the whole of its cost in the Welcome closure.
 *
 * ## Why this module is thirty lines and imports three things
 *
 * `check:budget:welcome` measures the assets `dist/index.html` names. `RoomPanel`,
 * `GameScreen`, and therefore every study workspace are statically reachable from the entry, so
 * **any** eager import added at an integration point is paid for by a learner sitting on the
 * Welcome screen.
 *
 * This module's imports are: React, and `runtimeConfig`. That is the entire list, and it is
 * load-bearing rather than incidental:
 *
 * - It does **not** import `@/store/assistanceStore`. Reading `mode` from the store to gate the
 *   render is the obvious way to write this, and it costs kilobytes of Welcome budget: a static
 *   edge from an entry-reachable module to the store puts the assistance lane in the entry
 *   document's **static closure**, which the budget gate counts whether or not the code ever runs.
 *   The mode therefore lives in the lazy half, and the gate that costs nothing is the **flag**,
 *   which is a build-time constant already in the closure.
 * - It does not import the engine, the catalogue, or the card.
 *
 * ## This is now enforced, not just intended
 *
 * `vite.config.ts` runs a module-membership plus reachability census over the assistance lane and
 * **fails the build** if any lane module is statically reachable from the entry. So "keep this
 * import dynamic" is a constraint the toolchain checks, not a convention this comment asks for: the
 * correct response to a lane-module-in-static-closure failure is to change an import, never to relax
 * the census.
 *
 * Measured after the census landed: `dist/index.html` contains **zero** references to any
 * assistance chunk, and `npm run check:budget:welcome` counts none of them.
 *
 * ## What that costs, stated rather than hidden
 *
 * The flag gate is free and synchronous. The **mode** gate is one lazy chunk fetch away, so on a
 * build with `VITE_ADAPTIVE_ASSISTANCE=true` and a learner who has chosen `off`, the chunk is
 * fetched and then renders nothing. That is a network request, not a visible thing: the DOM is
 * byte-identical to a build where the feature does not exist, which is what the requirement is
 * about. {@link AssistanceRegion} states the same trade from the other side.
 *
 * The alternative - paying ten kilobytes of the Welcome budget to save one fetch on a
 * non-default build - is the wrong side of the trade, and the budget is the hard constraint.
 *
 * ## The states that must be indistinguishable, and how they are
 *
 * `flagEnabled: false` and `mode: 'off'` both yield no suggestions, and a learner must not be able
 * to tell that a feature exists but is silent. Three things make that true:
 *
 * 1. **The flag check is before the `lazy()` boundary**, not inside it. Checking inside would mean
 *    the chunk is still fetched on the production default build.
 * 2. **`null`, not a placeholder.** No wrapper element, no heading, no `role="status"` carrying an
 *    empty string, no `data-assistance-*` attribute. There is no element to inspect.
 * 3. **No `Suspense` fallback that renders.** `fallback={null}`, because a fallback is an element,
 *    and an element that exists only to be replaced is still an element.
 *
 * ## The four integration points, and the fifth
 *
 * `creator`, `scribe`, `archaeologist`, and `fishing` are the plan's four surfaces. `device` is the
 * engine's fifth: its one suggestion (`device.due-today`) is about reviews across the whole subject
 * rather than one room, so it is offered on the Archaeologist review surface, which is where a
 * learner goes to decide what to review next. It is a **filter**, not a fifth card, and
 * {@link AssistanceSlotSurface} is the union of all five.
 */
import { Suspense, lazy, type ReactNode } from 'react';

import { runtimeConfig } from '@/config/featureFlags';
import type { SubjectSnapshot } from '@/core/validation/persistence';

/** Every surface a card can be asked for. Matches the engine's `AssistanceSurface`. */
export type AssistanceSlotSurface = 'creator' | 'scribe' | 'archaeologist' | 'fishing' | 'device';

/** The fishing lane's own facts, for the engine's `fishing` input. */
export interface AssistanceFishingFacts {
  readonly subjectId: string;
  readonly lastMissedRoomId: string | null;
  readonly missedThisVisit: number;
}

/**
 * The lazy half: it reads the mode, gates on it, and renders the card.
 *
 * Module scope, so `lazy()` itself performs no import and the binding costs nothing until React
 * tries to render it. In the body it would build a new component type every render and remount
 * the card each time.
 */
const AssistanceRegion = lazy(
  async () => ({ default: (await import('./AssistanceRegion')).AssistanceRegion }),
);

export interface AssistanceSlotProps {
  /** Which surface this is. Suggestions for other surfaces are dropped by the card's model. */
  readonly surface: AssistanceSlotSurface;
  /** The subject snapshot the caller already holds, used only to build the engine input. */
  readonly snapshot: SubjectSnapshot | null;
  /** The fishing lane's facts, when this is the fishing surface. */
  readonly fishing?: AssistanceFishingFacts | null;
  /**
   * Whether this build has the flag on.
   *
   * A prop rather than a direct read of `runtimeConfig`, for the same reason `RoomPanel` reads its
   * own flags into module constants: a test needs to render both lanes in one process, and a
   * build-time constant cannot be changed at runtime. The default is the real flag, so a caller
   * that forgets the prop gets production behaviour rather than a card on a build that has the
   * feature switched off.
   */
  readonly flagEnabled?: boolean;
}

/**
 * Render the suggestion card for this surface, or nothing at all.
 *
 * `null` is the whole contract for the production build, and it is reached without a store read, an
 * engine call, a locale lookup, or a network request.
 */
export function AssistanceSlot({
  surface,
  snapshot,
  fishing = null,
  flagEnabled = runtimeConfig.adaptiveAssistance,
}: AssistanceSlotProps): ReactNode {
  // The gate, and the only synchronous decision this module makes. See the header for why this is
  // the flag and not the mode.
  if (!flagEnabled) return null;

  return (
    <Suspense fallback={null}>
      <AssistanceRegion surface={surface} snapshot={snapshot} fishing={fishing} flagEnabled />
    </Suspense>
  );
}