/**
 * The Pixi fishing lane of the village screen: the flag, the chunk, and the mount.
 *
 * ## Why this is a module and not part of `VillageScreen.tsx`
 *
 * Three reasons, and the first is a gate rather than a preference.
 *
 * 1. **Phase 12's exit criterion.** "No Pixi object is required to understand or invoke a
 *    village action" is enforced as a graph property by
 *    `tests/phase12/village-shell-split.test.ts`, which refuses *any* `@/renderers` reach from
 *    `src/ui/village/**` - dynamic import included. So the flag and the chunk target cannot
 *    live in `src/ui/village/`, and `VillageScreen.tsx` is the only place left that already
 *    holds the two sibling switches.
 * 2. **The screen's own length gate.** `tests/phase12/village-shell-split.test.ts` holds
 *    `VillageScreen.tsx` under 900 lines, on the reasoning that "the composition root is the
 *    *small* thing". Wiring a second PixiJS `Application` into it added a hundred lines and
 *    broke that, which is the signal the gate exists to send: the lane is a unit, so it gets a
 *    unit.
 * 3. **It is a lane, not a panel.** It renders a world surface, the DOM controls that drive
 *    it, and an announcement. The fishing HUD, the catch panel, and the recall modal are
 *    `ui-engineer`'s; they are *composed* here, because this is the module that holds the
 *    `FishingWorld` handle, and nothing here decides what a fishing control looks like or what
 *    a catch is worth.
 *
 * ## What Phase 17's DOM work added to this lane
 *
 * Three things, all of them wiring rather than design:
 *
 * 1. **The pond's own identity.** `villageStudyFlow`'s fishing port already receives `pondId`
 *    from `studyFlow.enterFishing` and was dropping it on the floor. It is forwarded now, so
 *    the screen can mint the fishing session context *at pond entry* with a real pond id
 *    rather than a placeholder. `src/application/**` is not edited: the drop was in the
 *    adapter, and the adapter is this side of the boundary.
 * 2. **The cast number.** `FishingCatchReveal` carries the machine's one-based `castNumber`
 *    and the lane was discarding it while building `StudyFlowFishCaught`, which has no such
 *    field. The catch identity is (context, catalogue id, cast number) - a half-identical catch
 *    would have been deduplicated by the reward ledger and the fish would have vanished - so
 *    the lane records it in {@link takePendingCatch} and the screen reads it when the learner
 *    decides.
 * 3. **The HUD.** Rendered below the world, driven by a total adapter over the world's handle.
 *    The adapter is *total* rather than nullable: every method exists before the renderer has
 *    negotiated a GPU context and after it has been destroyed, so a control can never be
 *    rendered in a state where it would silently do nothing.
 *
 * ## Where the DOM half of fishing lives, and why it is not all in one tree
 *
 * The **components** - the HUD, the catch panel, the HUD's own port and copy, the catch
 * transaction, the recall-question route - are in `src/ui/fishing/**` and reach no renderer at
 * all; `tests/phase17/fishing-control-ids.test.ts` holds that, and `fishingHudPort.ts`
 * re-declares the renderer's capability port precisely because importing it is refused.
 *
 * The **wiring** - this lane, and `useVillageFishing.tsx`, which holds the session, the catch
 * context, and the four-outcome decision - is here, in `src/ui/screens/`, beside the village
 * screen that already holds a type-only `VillageWorldHandle`. `GameScreen.tsx` has the same shape
 * for `DungeonWorldHandle`, so this is the repository's existing answer to "where does a DOM
 * component drive a renderer" and not a third convention.
 *
 * ## Why this file names the chunk **nowhere**, statically
 *
 * `tests/phase17/fishing-flag-boundary.test.ts` walks every source file for the chunk specifier
 * and asserts exactly one reach, the `lazy()` one. It classifies a `import type` as a *static*
 * reach and fails on it - so this module cannot import `FishingWorldHandle` even type-only, which
 * is where the natural first draft put it.
 *
 * The handle's type is therefore **derived from the lazy value** rather than imported:
 * `ElementRef<typeof LazyPixiFishingWorld>` reads the ref type out of the component's own props.
 * That is the same type, from the same declaration, with no second specifier anywhere in the
 * source - so the flag gate's claim ("the lane reaches the chunk only through `lazy()`") stays
 * literally true rather than true modulo an erasure the gate does not model.
 *
 * ## The build-time switch, and why the comparison is against a literal
 *
 * `import.meta.env.VITE_PIXI_FISHING` is substituted as a string literal at build time, so a
 * *literal* `=== 'true'` lets the bundler fold the branch and delete the other arm - along with
 * the dynamic `import()` inside it, and therefore with the whole PixiJS fishing chunk that
 * import pulls in. A normalising call first (`String(raw).trim().toLowerCase()`) reads the same
 * at run time and defeats the folding, so the default build keeps a fishing chunk it would
 * never fetch. This is the identical pattern `VITE_PIXI_VILLAGE` and `VITE_PIXI_DUNGEON` use,
 * written out rather than cross-referenced because a comment that says "same as above" stops
 * being true when the line above is edited.
 *
 * The parsed run-time value is `runtimeConfig.pixiFishing`, for the reason the other two lanes
 * read theirs: a *defined* mismatch message instead of a silent Phaser fallback when the
 * environment value was not literally `true`.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementRef,
  type JSX,
} from 'react';

import { runtimeConfig } from '@/config/featureFlags';
import type { StudyFlowFishCaught } from '@/application/studyFlow';
import type { FishingWorldModel } from '@/application/contracts/world';
import type { VillageFishingHost } from '@/ui/village/villageStudyFlow';
import { FISH_CATALOG } from '@/core/fishing/fishingTypes';
import {
  FISHING_HUD_IDLE_READOUT,
  type FishingHudMoveIntent,
  type FishingHudPort,
  type FishingHudReadout,
} from '@/ui/fishing/fishingHudPort';


/** The chunk target, named once so the flag gate and the test cannot drift apart. */
export const PIXI_FISHING_CHUNK = '@/renderers/pixi/fishing/FishingWorld';

const pixiFishingFactory =
  import.meta.env.VITE_PIXI_FISHING === 'true'
    ? () => import('@/renderers/pixi/fishing/FishingWorld')
    : null;

/**
 * The lazy Pixi fishing chunk, or `null` on a build that did not request it.
 *
 * Computed once at module scope: a `lazy()` inside a component would mint a new component type
 * on every render and remount the pond, which for a PixiJS world means destroying and
 * rebuilding the `Application`.
 */
const LazyPixiFishingWorld = pixiFishingFactory !== null ? lazy(pixiFishingFactory) : null;

/**
 * The world's imperative handle, **derived** rather than imported.
 *
 * `ElementRef` reads the ref type out of the lazy component's props, which is the handle
 * `FishingWorld`'s own `forwardRef` declares. It exists so this file can hold the handle
 * without naming the chunk specifier a second time - see the header's note on the flag gate.
 *
 * `NonNullable` because the component is `| null` on a build with no chunk, and the ref is only
 * ever attached in the branch that proves it is not.
 */
type PixiFishingWorldHandle = NonNullable<
  typeof LazyPixiFishingWorld
> extends never
  ? never
  : ElementRef<NonNullable<typeof LazyPixiFishingWorld>>;

/** Whether this build asked for the Pixi fishing world at all. */
export const pixiFishing = pixiFishingFactory !== null;

/**
 * The mismatch between the parsed flag and the built chunk.
 *
 * `runtimeConfig.pixiFishing && pixiFishingFactory === null` means the environment asked for
 * the pond and the artifact does not contain it.
 */
export const pixiFishingMismatch = runtimeConfig.pixiFishing && pixiFishingFactory === null;

/**
 * The catalogue entry for a canonical id, or `null`.
 *
 * One `Map` built once at module scope: the lane resolves a display name from a `catalogId` on
 * every catch, and `FISH_CATALOG.find` per catch would be a linear scan where the answer is a
 * map lookup. The **id** is the key and the display name is the *value*, which is the rule
 * Phase 17's renderer boundary holds and the reason the renderer forwards no name at all.
 */
const FISH_BY_ID: ReadonlyMap<string, (typeof FISH_CATALOG)[number]> = new Map(
  FISH_CATALOG.map((entry) => [entry.id, entry]),
);

/** The three handlers the study flow supplies for a fishing session. */
export interface PixiFishingHandlers {
  readonly onFishCaught: (data: StudyFlowFishCaught) => void;
  readonly onReturnToVillage: () => void;
  readonly onReady: () => void;
}

/** The session the screen is currently showing, or `null` when there is none. */
export interface PixiFishingSession {
  readonly model: FishingWorldModel;
  readonly handlers: PixiFishingHandlers;
  /**
   * The pond this session is for.
   *
   * Forwarded from `studyFlow.enterFishing`'s `pondId`, which the flow already resolves from the
   * structure the learner cast from. The screen needs it to mint the fishing session context,
   * and it is the *same* identifier the eligibility lookup used - so eligibility, recall
   * selection, and persistence are finally derived from one value, which is plan 5.3's whole
   * complaint.
   */
  readonly pondId: string;
}

/**
 * The one revealed catch the screen has not decided about yet.
 *
 * `castNumber` is the machine's own one-based number for the cast in flight. It is half of the
 * catch reward identity, and dropping it would make two catches of one species in one session
 * collide in the ledger - so the second would be deduplicated and its fish would vanish.
 */
export interface FishingPendingCatch {
  readonly catalogId: string;
  readonly castNumber: number;
}

/**
 * The lane as the screen drives it: a host to hand the study flow, and a session to render.
 *
 * ## Why the host is not a world, and why that distinction is load-bearing
 *
 * **A host handle exists before any session is entered.** That is the whole point of it: the
 * flow asks "is there somewhere I can start a fishing world?" *before* it calls `enter`, so a
 * host that only appeared after `enter` could never be reached by the only code that calls
 * `enter`. The earlier draft assigned the host inside the effect that ran when a session
 * existed, and `session` was set only by calling `hostRef.current.enter(...)` - a chicken-and-egg
 * in which the ref was never assigned, `enter` was never reachable, the effect never ran, and the
 * Pixi pond could not mount on any build. `build:web:pixi-fishing` leaves the village on Phaser,
 * so `resolveFishingHost`'s `??` fallback then always found the Phaser handle and the flagged
 * build silently ran the *rollback* lane. `tests/phase17/fishing-lane-host.test.ts` holds the
 * ordering.
 *
 * So a non-null {@link PixiFishingLane.readHost} means exactly one thing:
 *
 * > **This build has a Pixi fishing world host, and the host can start a pond.**
 *
 * It does **not** mean a pond is running, and the two must never be read as the same fact:
 *
 * | question | answer |
 * | --- | --- |
 * | Is there somewhere to start a fishing world? | `readHost() !== null` — what `fishing.isMounted()` asks |
 * | Is a pond on screen right now? | `session !== null` — what `PixiFishingLaneSurface` renders |
 *
 * The distinction is carried by **two separately named members** rather than by a comment, and it
 * mirrors the Phaser side exactly: `readPhaserHandle()?.fishing?.()` is likewise non-null whenever
 * the village game has mounted and not while `FishingScene` is the active scene, which is what
 * makes the two lanes' `isMounted()` answer the same question. A reader who conflates them would
 * conclude a build with no pond is "fishing", and `enterFishing`'s mount guard - which must return
 * before clearing any village UI state - would stop working.
 *
 * ## The rest of the shape
 *
 * Pixi is not symmetric with Phaser. Phaser enters fishing by swapping a scene *inside the
 * village's own game*, so its adapter is a facade over a running `Phaser.Game` and the screen
 * hands the flow a handle once. Pixi has no such shared game: the pond is a second PixiJS
 * `Application` in a second canvas, so "entering" it means *mounting* it, which is React state
 * rather than an imperative verb.
 *
 * So:
 *
 * - `enter` publishes the model and the handlers; the render below mounts the chunk, and the
 *   host was already there for the flow to find.
 * - `returnToVillage` clears the session, which unmounts the chunk, and the component's own
 *   cleanup calls `renderer.destroy()` - so "return to Village" is the same teardown the Phase
 *   17 exit criterion asks about.
 * - `exit` and the host's `returnToVillage` are **the same function**, because they are the same
 *   event. An earlier draft held two copies of the teardown, which is how the two could drift.
 */
export interface PixiFishingLane {
  /**
   * This build's Pixi fishing world host, or `null` when it has none.
   *
   * Hand to `createVillageStudyFlow`'s `readPixiFishingHost`. **Non-null does not mean a pond is
   * running** - see the interface's own header for the two questions and the two answers.
   */
  readonly readHost: () => VillageFishingHost | null;
  /** The session to render, or `null`. Non-null *is* "a pond is running". */
  readonly session: PixiFishingSession | null;
  /**
   * Leave the pond. Unmounts the chunk, so the release-side facts are the same either way.
   *
   * Identical to the host's `returnToVillage`, and deliberately the same object: the screen's
   * return control and the renderer's are one event, and two copies of a teardown is one more
   * thing that can disagree with `session`.
   */
  readonly exit: () => void;
  /**
   * Report that the lane's session opened or closed.
   *
   * Called with `false` by every route that ends a session on this lane - the renderer's own
   * return control and the flow's `fishing/exit` - so the screen's `data-world` attribute and its
   * live region cannot outlive the pond. The Pixi lane calls it with `true` never; the flag is
   * set by the flow's own `prepareFishingSession`, which runs only after its mount guard passed.
   */
  readonly onSessionChange: (active: boolean) => void;
  /**
   * Read **and consume** the revealed catch's identity, or `null` when there is none.
   *
   * Consuming rather than reading is what makes it correct: two catches in a row must not both
   * be told they are the first, and a screen that read without consuming would silently assign
   * the same cast number twice. The identity is recorded when the catch is *revealed*, not
   * when the learner decides, so the number describes the catch rather than the click order.
   *
   * Stable identity, deliberately - the flow's `setFishCaught` port closes over the lane object
   * it was created with, and a fresh function per render would have it reading a stale slot.
   */
  readonly takePendingCatch: () => FishingPendingCatch | null;
  /**
   * Record a revealed catch's identity, before the reveal is forwarded on.
   *
   * `castNumber` is `null` for the Phaser rollback lane, which reports no cast number; see the
   * lane's own note on the fallback counter for why a counter is correct and a constant is
   * not.
   */
  readonly recordPendingCatch: (catalogId: string, castNumber: number | null) => void;
  /**
   * The world published a session for `pondId`.
   *
   * `studyFlow.enterFishing` calls `prepareFishingSession()` *before* `fishing.enter(...)`, so
   * a screen has already begun a session by the time this fires. Re-running the begin with the
   * lane's own `pondId` - the value the flow resolved rather than one the screen guessed - is
   * how the two are made to agree rather than assumed to.
   *
   * Must have a **stable identity**. `VillageScreen` builds its study flow once, inside a ref
   * guard, so the `readPixiFishingHost` it keeps closes over whichever lane object that first
   * render returned; a fresh host per render would make the published host a moving target.
   */
  readonly onSessionStarted: (pondId: string) => void;
}

export function usePixiFishingLane(
  onSessionChange: (active: boolean) => void,
  onSessionStarted: (pondId: string) => void,
): PixiFishingLane {
  const [session, setSession] = useState<PixiFishingSession | null>(null);
  const pendingCatchRef = useRef<FishingPendingCatch | null>(null);
  /**
   * The cast number minted for a catch that reported none.
   *
   * The Pixi reveal always carries the machine's own one-based `castNumber`. The **Phaser**
   * rollback lane reports no cast number at all - `StudyFlowFishCaught` has no such field, and
   * `src/application/**` is not this phase's to edit - so a fallback sequence is minted here
   * instead. It is monotonic within a session, which is all the catch identity needs: the
   * requirement is that one cast produces one identity, and a counter satisfies that as well as
   * the machine's number does. A *constant* would not: two same-species catches in one session
   * would share an identity and the ledger would deduplicate the second, so the fish would
   * vanish.
   */
  const fallbackCastRef = useRef(0);

  const takePendingCatch = useCallback((): FishingPendingCatch | null => {
    const pending = pendingCatchRef.current;
    pendingCatchRef.current = null;
    return pending;
  }, []);

  /** Record a revealed catch's identity. Called before the reveal is forwarded. */
  const recordPendingCatch = useCallback((catalogId: string, castNumber: number | null) => {
    if (castNumber !== null && castNumber > 0) {
      pendingCatchRef.current = { catalogId, castNumber };
      return;
    }
    fallbackCastRef.current += 1;
    pendingCatchRef.current = { catalogId, castNumber: fallbackCastRef.current };
  }, []);

  /**
   * End the session, on every route that ends one.
   *
   * One function, reached from the renderer's own return control *and* from the host's
   * `returnToVillage`, which is what the flow's `fishing/exit` calls. Two copies of this
   * teardown is how `session` and the screen's `active` flag came to disagree.
   */
  const closeSession = useCallback(() => {
    setSession(null);
    // A catch nobody decided about must not be answerable after the pond has gone: its
    // identity belongs to a session that is closing.
    pendingCatchRef.current = null;
    fallbackCastRef.current = 0;
    onSessionChange(false);
  }, [onSessionChange]);

  /**
   * The published world host, or `null` on a build with no pond.
   *
   * ## Conditioned on the **build**, not on the session
   *
   * `pixiFishing` is a module constant and `LazyPixiFishingWorld` is `null` exactly when it is
   * false, so this is the *same* condition `PixiFishingLaneSurface` uses to decide whether it can
   * render a pond - "is there a pond to host" and "is there something to host it in" being one
   * fact rather than two that could drift.
   *
   * Publishing it while no session exists is deliberate and is what makes the lane reachable:
   * `studyFlow.enterFishing` calls `fishing.isMounted()` and only then `fishing.enter(...)`, so a
   * host published by `enter` is unreachable by construction. The alternative - publishing on
   * `enter` - is the chicken-and-egg this header exists to record.
   *
   * It is also the same condition `readPhaserHandle()?.fishing?.()` satisfies on the other lane,
   * which is why `isMounted()` still means one thing on both: *a world host is mounted and able
   * to start the fishing world*, not *a fishing world is running*.
   */
  const host = useMemo<VillageFishingHost | null>(() => {
    if (!pixiFishing || LazyPixiFishingWorld === null) return null;
    return {
      enter: (model, handlers) => {
        const pondId = handlers.pondId ?? '';
        setSession({ model, handlers, pondId });
        onSessionStarted(pondId);
      },
      returnToVillage: closeSession,
    };
  }, [closeSession, onSessionStarted]);

  /**
   * The published host, readable at any time after mount.
   *
   * Written during render and not in an effect, on purpose. The flow reads it from an imperative
   * call made by a pointer or key handler, and there is nothing to wait for: `host` depends on
   * no render-scoped value, so an effect would only add a window in which the first village
   * interaction found `null`. This is `VillageScreen`'s own `subjectsRef.current = subjects`
   * pattern, for the same reason.
   *
   * No unmount cleanup is needed because the ref dies with the hook, and "this lane exists" is a
   * property of the mounted hook rather than of a session.
   */
  const hostRef = useRef<VillageFishingHost | null>(host);
  hostRef.current = host;

  const readHost = useCallback((): VillageFishingHost | null => hostRef.current, []);

  return {
    readHost,
    session,
    exit: closeSession,
    onSessionChange,
    takePendingCatch,
    recordPendingCatch,
    onSessionStarted,
  };
}


export interface PixiFishingLaneProps {
  readonly lane: PixiFishingLane;
  readonly colorTheme?: string | null;
  /**
   * The DOM controls for the pond, or `null` to render none.
   *
   * A **factory**, not an element, and the reason is ordering. The controls need the world's
   * imperative handle, and that handle exists only after the lazy chunk has mounted - so
   * building the element during this component's render would hand it a `null` port on the
   * first frame. A factory is called after the commit, when the ref is populated.
   *
   * `null` is the honest "this build has no pond", and it is also what keeps the DOM controls
   * off a build that never asked for them.
   */
  readonly renderControls?: ((port: FishingHudPort) => JSX.Element) | null;
}

/**
 * The pond, rendered over the village it was entered from.
 *
 * ## Why both render at once
 *
 * The village behind it keeps its ticker running, which costs a second live PixiJS
 * application and is the honest price. The alternative - unmounting the village to show the
 * pond - destroys the village's camera, its NPC conversation, and its GPU context on every
 * fishing session, and `VITE_PIXI_FISHING=false` returns to the Phaser lane, which swaps a
 * scene inside one game and pays none of it. A fishing trip is short and the village is
 * somewhere the learner is coming back to.
 *
 * ## Teardown
 *
 * Unmounting this subtree runs `FishingWorld`'s cleanup, which calls `renderer.destroy()` -
 * host unmount (frame subscription, key listener, visibility and reduced-motion subscriptions,
 * size observer, scene destroy, `Application.destroy({releaseGlobalResources: true})`, canvas
 * removal) and then the asset bundle's `dispose`. `tests/phase17/fishing-scene-teardown.test.ts`
 * measures it.
 *
 * ## What "mounted" means here, and where it is decided
 *
 * This component is the *other half* of the lane's published host, and the two agree by
 * construction: `usePixiFishingLane` publishes a host exactly when
 * `pixiFishing && LazyPixiFishingWorld !== null`, and that is exactly the condition the `return
 * null` below tests. So a learner standing in the village has a world host (`readHost()` is
 * non-null) and no pond (`session === null`), which is the state this component renders nothing
 * for - and the flow's `isMounted()` guard answers "true" for the first question without ever
 * being asked the second. See {@link PixiFishingLane}'s header.
 *
 * ## The DOM controls, and why this component only wires them
 *
 * Plan 6.2 gives instructional text and accessible controls to React DOM, and the pond has six
 * learner-triggerable transitions. So the HUD is rendered here, below the canvas - and this
 * component **does not decide what it looks like**. It calls the caller's `renderControls`
 * factory with a total adapter over the world's handle, which is the whole of its
 * contribution.
 *
 * The adapter is total on purpose. `FishingWorld`'s handle is a `useImperativeHandle`, so it is
 * `null` before the lazy chunk mounts and `null` again after the renderer is destroyed; every
 * adapter method therefore reads `ref.current` and does nothing when it is absent. A port that
 * could be `null` would push a null check into every control, and the shape of the null check
 * would then be the thing a test has to cover - which is how `VillageWorld`'s handle once
 * compiled while silently omitting two members.
 *
 * ## Why "total" is not enough, and what the mount probe is for
 *
 * Eight of the nine members read `ref.current` **at call time**, so a port built before the chunk
 * mounted recovers on the next press. `onPhase` cannot: it subscribes **once**, and the fallback
 * for an absent handle is a no-op unsubscribe. A port built while the chunk was still suspended
 * therefore subscribed to nothing, forever.
 *
 * That was not hypothetical. The port's effect is keyed on `session`, so it ran in the very
 * commit that set `session` - and on that commit the `Suspense` boundary was still showing its
 * fallback, because the chunk had not resolved. The HUD then subscribed, got
 * `FISHING_HUD_IDLE_READOUT` (`eligible: false`, `phase: 'idle'`) from the fallback, and **stayed
 * there for the rest of the session**: the padlock sentence rendered, the charge button was
 * permanently disabled, and no cast could be made on an eligible pond. `hasClearedRooms` was
 * `true` the whole time. The pond was reachable, presented, ready, and unusable, and the only
 * symptom was a disabled button.
 *
 * {@link FishingChunkMounted} is the fix, and it is deliberately a component rather than a
 * subscription retry or a poll: it commits **inside** the boundary, so it exists exactly when
 * the chunk does, and React attaches every `useImperativeHandle` in the commit before it runs
 * any `useEffect`. `tests/phase17/fishing-lane-host.test.tsx` holds the ordering.
 *
 * ## What this component does not render
 *
 * **No control of its own, and no canvas action without a DOM route.** The canvas is
 * `aria-hidden` (Phase 9's host sets that before a renderer exists) and the pond's six actions
 * each have a button. If the caller's factory is `null` there are no DOM controls at all, which
 * is the state a `VITE_PIXI_FISHING=false` build is in and is why the screen passes the factory
 * only when the Pixi chunk is present.
 */
/**
 * A zero-output marker whose only job is to report that the lazy chunk has committed.
 *
 * ## Why a component and not a retry, a poll, or a subscription handshake
 *
 * It has to observe something only a commit can report: that `LazyPixiFishingWorld` is mounted,
 * and therefore that the `ref` on it holds a handle. Rendering it as a **sibling inside the same
 * `Suspense` boundary** is what makes the timing right, and the timing is the whole of it:
 *
 * - While the chunk is unresolved, React renders the boundary's fallback and commits **nothing
 *   inside the boundary** - so this component's effect does not run, and the port stays the one
 *   the pre-suspension path built.
 * - When the chunk resolves, the boundary commits its children in one pass. React attaches every
 *   `useImperativeHandle` in a commit during the layout phase, which precedes every `useEffect`,
 *   so by the time this effect runs the world's handle is attached.
 *
 * The alternative shapes each fail for a specific reason. A `setTimeout` retry is a race against
 * a network request. A polling loop burns frames for the life of the session. Handing the port an
 * explicit "re-subscribe when ready" method pushes the knowledge that the chunk is lazy down into
 * a component that would then have to know it.
 */
function FishingChunkMounted({ onMounted }: { readonly onMounted: () => void }): null {
  useEffect(() => {
    onMounted();
  }, [onMounted]);
  return null;
}

export function PixiFishingLaneSurface({
  lane,
  colorTheme,
  renderControls,
}: PixiFishingLaneProps): JSX.Element | null {
  const { session } = lane;
  const worldRef = useRef<PixiFishingWorldHandle | null>(null);
  const [port, setPort] = useState<FishingHudPort | null>(null);
  /**
   * Whether the lazy chunk has committed.
   *
   * A second key on the port effect below, and the reason the HUD can ever see a real phase. See
   * this component's header, "Why 'total' is not enough".
   */
  const [chunkMounted, setChunkMounted] = useState(false);
  const handleChunkMounted = useCallback(() => setChunkMounted(true), []);

  /**
   * One adapter per mounted world, recreated when the world's identity changes **or when the
   * chunk commits**.
   *
   * It is stored in state rather than read through a ref on every render because the HUD
   * *subscribes* to it: `onPhase` must be callable before the world has presented its first
   * frame, and a port that changed identity every render would resubscribe on every render.
   *
   * `chunkMounted` is in the dependency list for the reason this component's header sets out:
   * the first build of this adapter happens while the boundary is still suspended, and
   * `onPhase` is the one member that cannot recover on a later call. `FishingHud` re-subscribes
   * and re-reads whenever the port's identity changes, so the second build is what hands the HUD
   * a live subscription rather than a no-op one.
   */
  useEffect(() => {
    if (LazyPixiFishingWorld === null || session === null) {
      setPort(null);
      // A second trip to the pond must re-arm the probe: `chunkMounted` is cleared with the
      // session so the marker mounts again inside the boundary's next commit.
      setChunkMounted(false);
      return;
    }
    setPort({
      beginPower: () => worldRef.current?.beginPower(),
      release: () => worldRef.current?.release(),
      hook: () => worldRef.current?.hook(),
      reset: () => worldRef.current?.reset(),
      move: (intent: FishingHudMoveIntent) => worldRef.current?.move(intent),
      readReadout: (): FishingHudReadout => worldRef.current?.readReadout() ?? FISHING_HUD_IDLE_READOUT,
      returnToVillage: () => worldRef.current?.returnToVillage(),
      onPhase: (listener) => {
        const unsubscribe = worldRef.current?.onPhase(listener);
        if (unsubscribe !== undefined) return unsubscribe;
        // The world has not mounted yet - which, with `chunkMounted` above, is only true for a
        // HUD mounted during the frames while the chunk is still loading. Report the idle readout
        // immediately, so a control pressed in that window is told the state it is actually in
        // rather than nothing; the rebuilt port replaces this subscription.
        listener(FISHING_HUD_IDLE_READOUT);
        return () => {};
      },
    });
    return () => setPort(null);
  }, [session, chunkMounted]);

  if (!pixiFishing || LazyPixiFishingWorld === null || session === null) return null;

  return (
    <div
      className="village-fishing-overlay"
      /*
       * Inline styles rather than a stylesheet rule, and the reason is a gate rather than a
       * preference: `tests/phase8/qa-verification.test.ts` pins the exact line count of
       * `src/styles.css` below the Cozy theme blocks, so a stylesheet addition for a
       * single overlay is a line-count failure in a phase that has nothing to do with
       * fishing. `PixiCanvas` and both `*World.tsx` surfaces already carry their geometry
       * inline for the same reason.
       *
       * `position: absolute` inside `.village-game-area` (`position: relative`) for the
       * reason `.village-canvas` is: the overlay fills exactly that area without the pond's
       * mount changing the page's height. `zIndex: 1` puts it above the village canvas (0)
       * and leaves the HUD's own stacking alone.
       */
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        // The overlay owns the scroll, not the canvas: the pond fills the area the HUD
        // leaves, and when a narrow viewport cannot show both, the controls below the
        // pond scroll into view here instead of being clipped (the pre-fix
        // `overflow: hidden`). `overflowX` stays hidden so a wrapping control never
        // produces a horizontal scrollbar.
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      <Suspense
        fallback={
          <p role="status" className="village-renderer-status">
            Loading the fishing pond…
          </p>
        }
      >
        <LazyPixiFishingWorld
          ref={worldRef}
          world={session.model}
          colorTheme={colorTheme ?? null}
          onReturnToVillage={lane.exit}
          onReady={session.handlers.onReady}
          onCatchRevealed={(reveal) => {
            /*
             * The renderer forwards a canonical `catalogId`, a rarity, the one-based cast
             * number, and the catalogue description - and deliberately **no display name**, so
             * a renderer is never a place a species name is read from or keyed on.
             * `StudyFlowFishCaught` carries a `fishName` for the panel, so the name is resolved
             * here, from the catalogue, by id.
             *
             * A `catalogId` the catalogue does not hold falls back to the description rather
             * than to an empty label: an unfamiliar fish is then described, which is better than
             * a blank heading, and the id still reaches the panel so the catch transaction can
             * identify it exactly.
             *
             * The cast number is recorded **before** the reveal is forwarded, so the screen's
             * `onFishCaught` can take it. `StudyFlowFishCaught` has no cast-number field and
             * `src/application/**` is not this phase's to edit, so the identity travels on the
             * lane rather than on the flow's payload - see `takePendingCatch`.
             */
            lane.recordPendingCatch(reveal.catalogId, reveal.castNumber);
            session.handlers.onFishCaught({
              fishName: FISH_BY_ID.get(reveal.catalogId)?.name ?? reveal.description,
              rarity: reveal.rarity,
              catalogId: reveal.catalogId,
              description: reveal.description,
            });
          }}
        />
        {/*
         * Inside the boundary on purpose, and after the world on purpose. This is the commit that
         * proves the chunk mounted, which is what lets the HUD's port hold a real phase
         * subscription rather than the no-op fallback - see `FishingChunkMounted`.
         */}
        <FishingChunkMounted onMounted={handleChunkMounted} />
      </Suspense>

      {/*
        The DOM controls, below the canvas and inside the same overlay.

        Rendered outside the `Suspense` boundary on purpose: the controls are *this*
        module's callers' components and need nothing from the chunk, so a slow chunk load
        must not leave a learner standing at a pond with no way to cast and no way to know
        why. The port is `null` only until the chunk's commit, and the factory is not called
        at all when the caller passed `null`.
      */}
      {port !== null && renderControls !== null && renderControls !== undefined ? (
        <div className="village-fishing-controls">{renderControls(port)}</div>
      ) : null}
    </div>
  );
}