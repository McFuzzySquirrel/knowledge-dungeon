/**
 * Feature-detecting bridge from the capability port to the village's DOM surfaces.
 *
 * ## The problem
 *
 * `readNpcSnapshot` and `invokeAction` are *optional* on
 * `VillageRendererCapabilities` while both adapters are being wired. The DOM must
 * work against a renderer that has them and against one that has not, and it must
 * be obvious which one it is talking to.
 *
 * So this hook never assumes. Each sample asks the *currently mounted* handle
 * whether it can answer, and reports two independent booleans rather than one
 * "is the world ready" flag, because the two are genuinely different states with
 * different user-visible consequences (see `NearbyActionList.tsx`'s table).
 *
 * ## Why a throttled sample rather than an event
 *
 * The honest answer is that a `readNpcSnapshot()` call *is* the contract's own
 * answer to "how does React watch the world", and the frozen port has no subscribe
 * form. So the sample is throttled - the same answer Phase 11 reached for the
 * compass - with one important difference from that: **what is sampled is data, not
 * a scene reference, and only a change in the selected rows reaches React.**
 *
 * `snapshot.nearby` is at most two rows (one structure, one NPC) derived by a pure
 * function, and it is compared field by field before anything is committed. So
 * walking around a village that has no `onStructureApproached` event for every
 * building costs a comparison every `sampleIntervalMs` and **zero renders**, while
 * crossing a proximity boundary costs exactly one. The old compass comparison
 * could not do this, because it was comparing a continuously-varying measurement.
 *
 * A renderer that *does* emit `village:npc-approached` / `village:npc-left`
 * short-circuits the wait: the screen passes a `probe` signal that is the
 * conversation's identity, and a change to it samples immediately instead of
 * waiting out the interval. The event is a nudge, never the source of truth - the
 * snapshot read still is, so the DOM can never show a row for an NPC that has
 * already left.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  VillageActionInvocation,
  VillageNpcSnapshot,
  VillageNearbyTarget,
} from '@/application/contracts/villageNpc';

const DEFAULT_SAMPLE_INTERVAL_MS = 200;

/** A shared empty list, so "nothing nearby" is a stable identity, not a new `[]`. */
const NO_TARGETS: readonly VillageNearbyTarget[] = Object.freeze([]);

export interface VillageNpcSurfaceOptions {
  /**
   * The mounted handle's snapshot read, or `undefined` when none is available.
   *
   * A function rather than a handle, so this module names no renderer type and no
   * capability port: the screen does the feature detection and hands over either
   * the call or nothing.
   */
  readonly readNpcSnapshot?: () => VillageNpcSnapshot | undefined;
  /**
   * The live route from a DOM control to a world action, or `undefined` when the
   * screen has no renderer mounted at all.
   *
   * An **object with a probe**, and not a plain callback, because "the world
   * cannot act" is a fact about the *currently mounted* adapter and not about
   * whether the screen managed to hand down a function. A stable callback that
   * quietly did nothing when the adapter behind it had no `invokeAction` is
   * precisely the silent no-op the exit criterion forbids - the rows would be
   * enabled, the learner would press one, and nothing would happen. So the screen
   * passes a bridge that answers `canInvoke()` from the live handle on every
   * sample, and this hook turns that into an honest `invokeAvailable`.
   */
  readonly action?: VillageActionBridge;
  /**
   * A value that changes whenever the village reports an NPC event.
   *
   * Purely an optimisation - see this file's header. `null` means "no renderer is
   * reporting NPC events", which is the state a not-yet-wired adapter is in.
   */
  readonly conversationKey?: string | null;
  /** Milliseconds between samples. Tests pass a small value. */
  readonly sampleIntervalMs?: number;
}

/**
 * The two questions a DOM control needs answered about the world.
 *
 * Both are asked of the *live* handle, so a route that becomes available when an
 * adapter mounts is picked up by the next sample without the screen having to
 * re-render - which matters because the Pixi path fills its handle through a ref
 * during the child's commit, i.e. after the parent's last render.
 */
export interface VillageActionBridge {
  /** `true` when the mounted adapter can currently perform an action. */
  canInvoke(): boolean;
  /** Performs it. Returns whether an adapter actually took it. */
  invoke(invocation: VillageActionInvocation): boolean;
}

export interface VillageNpcSurface {
  /** The contract's selected rows, in its order. Empty when there are none. */
  readonly targets: readonly VillageNearbyTarget[];
  /** `true` once a snapshot capability has answered at least once. */
  readonly listAvailable: boolean;
  /** `true` when the mounted adapter can currently perform an action. */
  readonly invokeAvailable: boolean;
  /**
   * The dispatcher, or `null`.
   *
   * `null` is a *disabled* signal, not an error: it is what makes the rows
   * disabled and the list explain itself. It is derived from `invokeAvailable`
   * rather than from the bridge's mere existence, so a screen that always has a
   * callback still reports the truth about the adapter behind it.
   */
  readonly invoke: ((invocation: VillageActionInvocation) => boolean) | null;
}

/** Field-wise equality over at most two rows. */
function sameTargets(
  left: readonly VillageNearbyTarget[],
  right: readonly VillageNearbyTarget[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a === undefined ||
      b === undefined ||
      a.kind !== b.kind ||
      a.id !== b.id ||
      a.label !== b.label ||
      a.actionId !== b.actionId ||
      a.distance !== b.distance
    ) {
      return false;
    }
  }
  return true;
}

interface NpcSurfaceState {
  readonly targets: readonly VillageNearbyTarget[];
  readonly listAvailable: boolean;
  readonly invokeAvailable: boolean;
}

const INITIAL_STATE: NpcSurfaceState = Object.freeze({
  targets: NO_TARGETS,
  listAvailable: false,
  invokeAvailable: false,
});

function sameState(left: NpcSurfaceState, right: NpcSurfaceState): boolean {
  return (
    left.listAvailable === right.listAvailable &&
    left.invokeAvailable === right.invokeAvailable &&
    sameTargets(left.targets, right.targets)
  );
}

export function useVillageNpcSurface({
  readNpcSnapshot,
  action,
  conversationKey = null,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
}: VillageNpcSurfaceOptions): VillageNpcSurface {
  const [state, setState] = useState<NpcSurfaceState>(INITIAL_STATE);
  // The last committed state, so a sample that changes nothing can decide *that*
  // before calling `setState` at all.
  //
  // This is not belt-and-braces. React does bail out when an updater returns the
  // identical state object, but "may bail out" is a weaker claim than "never
  // asks", and the phase's deliverable is about what reaches React at all. A
  // ref-guarded comparison makes the "walking costs a comparison, not a render"
  // statement structural, which is what `tests/phase12/` asserts.
  const stateRef = useRef<NpcSurfaceState>(INITIAL_STATE);
  stateRef.current = state;

  // Latest-value refs, so the sampling effect and the returned `invoke` are both
  // created exactly once for the life of the screen.
  const readRef = useRef(readNpcSnapshot);
  readRef.current = readNpcSnapshot;
  const actionRef = useRef(action);
  actionRef.current = action;

  const sample = useCallback((): void => {
    const invokeAvailable = actionRef.current?.canInvoke() === true;
    const snapshot = readRef.current?.();
    const next: NpcSurfaceState =
      snapshot === undefined
        ? { targets: NO_TARGETS, listAvailable: false, invokeAvailable }
        : { targets: snapshot.nearby, listAvailable: true, invokeAvailable };
    if (sameState(stateRef.current, next)) return;
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    sample();
    const timer = window.setInterval(sample, Math.max(1, sampleIntervalMs));
    return () => window.clearInterval(timer);
  }, [sample, sampleIntervalMs]);

  // An NPC event is a nudge: it makes the next read happen now rather than at the
  // end of the current interval. The snapshot is still what is rendered, so an
  // event that arrives after the NPC has already left cannot resurrect its row.
  useEffect(() => {
    if (conversationKey === null) return;
    sample();
  }, [conversationKey, sample]);

  const invoke = useCallback(
    (invocation: VillageActionInvocation): boolean => {
      return actionRef.current?.invoke(invocation) === true;
    },
    [],
  );

  return {
    targets: state.targets,
    listAvailable: state.listAvailable,
    invokeAvailable: state.invokeAvailable,
    invoke: state.invokeAvailable ? invoke : null,
  };
}
