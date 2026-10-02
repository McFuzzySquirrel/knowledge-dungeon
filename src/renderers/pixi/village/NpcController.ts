/**
 * The village's NPC layer: wander movement, proximity, conversation state, and the
 * one snapshot a React panel reads.
 *
 * ## What this file decides and what it delegates
 *
 * The split is the whole point of Phase 12, so it is worth stating exactly:
 *
 * - **This file measures.** Where every NPC is, how far the player is from each of
 *   them, which one is nearest and inside the shared radius, where its dialogue
 *   anchors in CSS pixels.
 * - **The contract decides.** Which measurements become a nearby-action row
 *   (`selectVillageNearbyTargets`, via `createVillageNpcSnapshot`). This file never
 *   orders a list and never knows what a quest step is.
 * - **The application chooses the line.** `selectVillageNpcLine` is called by the
 *   application layer, not here, because it needs the learner's real quest step and a
 *   renderer does not have one. This file used to call it with an empty step and
 *   publish the result on the snapshot; nothing read that field, so it was a second
 *   answer to "what does this NPC say" that was wrong whenever the quest step
 *   mattered. Quest promotion is likewise the study flow's alone - a canvas that moved
 *   a learner forward from a frame would be a second source of quest truth.
 *
 * ## Parity with `VillageScene.checkNpcProximity`
 *
 * The Phaser scene is the behaviour contract and this file reproduces it exactly:
 * the nearest NPC strictly inside the radius wins, a change emits `onNpcLeft` for
 * the previous and `onNpcApproached` + `onNpcDialogPosition` for the new one, and
 * wander speed, arrival tolerance, and wait bounds are the Phaser scene's numbers.
 * The two differences are both deliberate and both one-directional:
 *
 * 1. The **snapshot anchor is recomputed every frame** while a conversation is open,
 *    where the Phaser scene emits `onNpcDialogPosition` once on approach. The
 *    *event* is still emitted exactly once per approach, so event parity holds; what
 *    changed is that a DOM dialog positioned from the snapshot follows a villager
 *    who keeps walking, instead of staying where she was when she said hello.
 * 2. Randomness is **injected** ({@link NpcRandomness}). The Phaser scene calls
 *    `Math.random()` inline for the opening wait and the between-waypoint wait; a
 *    renderer whose output depends on ambient randomness cannot be asserted, so the
 *    calls become a parameter with a `Math.random()`-backed default that is
 *    byte-for-byte the old behaviour.
 *
 * ## Why this file no longer chooses a line
 *
 * It used to. This controller called `selectVillageNpcLine` with `questStep: ''` and
 * published the result as the snapshot's `dialogue`, and the Phaser adapter did the
 * same independently - which meant two renderer-side copies of a selection rule that
 * neither could apply correctly, because a renderer is given a `VillageWorldModel`
 * (structures and a player class) and no quest state, and the Phase 9 rule is that it
 * does not reach into a store. For the Keeper that produced her greeting instead of
 * the tutorial script.
 *
 * Nothing read the field. `VillageNpcSurface` - the React bridge that consumes these
 * snapshots - has no `dialogue` member at all, and the bubble comes from application
 * state written by the `village:npc-*` handlers. So both copies were computing an
 * answer to a question nobody was asking, and the question they could not answer was
 * the one that mattered.
 *
 * The line is now chosen once, by the application layer, which holds the quest step.
 * This file still knows *who* is nearby and *where* their bubble attaches; that is
 * geometry it can answer, and it is all the snapshot now carries.
 */
import type { CozyMotionProfile } from '@/theme';

import type { CozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import { createVillageNpc, type VillageNpcVisual } from './VillageNpc';
import {
  createVillageNpcSnapshot,
  VILLAGE_NEARBY_RANGES,
  type VillageNearbyCandidate,
  type VillageNpcDialogAnchor,
  type VillageNpcSnapshot,
} from '@/application/contracts/villageNpc';
import { NPC_SPEED, type VillageNpc } from '@/data/villageLayout';
import type { Container } from 'pixi.js';

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The four NPC callbacks a village host reports through, all optional.
 *
 * Declared here rather than imported from `./VillageRenderer` so this module does not
 * depend on the renderer factory that constructs the scene: the scene passes its own
 * callback bag straight through, and the structural type is all that has to agree.
 */
export interface VillageNpcCallbacks {
  onNpcApproached?: (npcId: string) => void;
  onNpcLeft?: (npcId: string) => void;
  onNpcInteract?: (npcId: string) => void;
  onNpcDialogPosition?: (anchor: VillageNpcDialogAnchor) => void;
}

/** A point in world pixels. */
interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The one ambient-randomness decision a wandering NPC layer makes.
 *
 * A parameter rather than an inline `Math.random()` call, so a test can drive a walk
 * without a seed, a fake timer, or a tolerance. The default implementation is what
 * the Phaser scene does today, unchanged.
 *
 * ## Why there is no `quoteIndex` here any more
 *
 * There was one, and it is gone because a renderer no longer picks a line. Selecting
 * a wanderer's opening quote needs no quest state, so this controller used to do it
 * - and the application layer did the same thing independently, in two renderers, to
 * produce an answer no consumer read. The line is now chosen once, by the application
 * layer, which supplies the randomness itself. A renderer that cannot know the
 * learner's quest step should not be choosing the line at all, and the injection seam
 * for it belonged with whoever owns the choice.
 */
export interface NpcRandomness {
  /** A pause in `[minMs, maxMs]`, in milliseconds. */
  waitMs(minMs: number, maxMs: number): number;
}

/** The Phaser scene's ambient randomness, verbatim. */
export const DEFAULT_NPC_RANDOMNESS: NpcRandomness = Object.freeze<NpcRandomness>({
  waitMs(minMs: number, maxMs: number): number {
    return minMs + Math.random() * Math.max(0, maxMs - minMs);
  },
});

/** Everything the controller needs beyond the scene's own update loop. */
export interface CreateNpcControllerOptions {
  /** The world layer the NPC markers are parented to. */
  readonly parent: Container;
  /** The roster, in `VILLAGE_MAP.npcs` order. Order decides body colour and phase. */
  readonly npcs: readonly VillageNpc[];
  /** Pixels per grid tile, for the grid-to-world conversion. */
  readonly tile: number;
  /** Cozy tokens, already numbers. */
  readonly theme: CozyWorldTheme;
  /** Where proximity, interaction, and the dialog anchor are reported. */
  readonly callbacks: VillageNpcCallbacks;
  /** The player's world position this frame. Read, never cached. */
  readPlayerPosition(): WorldPoint;
  /**
   * Project a world point to CSS viewport pixels, for the dialog anchor.
   *
   * A callback because the projection is the *caller's* camera, and a controller that
   * did the maths itself would have to own a second copy of the camera rig. The NPC
   * id is passed in so the returned anchor is complete: the caller fills in geometry
   * and does not have to restate which villager the position belongs to.
   */
  projectToViewport(npcId: string, x: number, y: number): VillageNpcDialogAnchor;
  /**
   * Raw structure measurements, folded into the snapshot alongside the NPC ones.
   *
   * Structures are the scene's business - it owns the interactive-type table and the
   * dynamic portal list - so the controller asks rather than duplicating.
   */
  readStructureCandidates?(): readonly VillageNearbyCandidate[];
  /** Ambient randomness. Defaults to {@link DEFAULT_NPC_RANDOMNESS}. */
  readonly randomness?: NpcRandomness;
}

/** The controller the scene holds. */
export interface NpcController {
  /** The NPC currently in range, or `null`. */
  readonly currentNpcId: string | null;
  /** Wander, bob, and re-measure. `deltaMs` is milliseconds since the last frame. */
  update(deltaMs: number, motion: CozyMotionProfile): void;
  /**
   * Place every marker, then measure proximity, without advancing time.
   *
   * Used once at construction so the world is correct before the first frame - the
   * same discipline `updateStructureProximity` follows - and after a resize, where
   * the anchor has moved but nothing else has.
   */
  sync(motion: CozyMotionProfile): void;
  /**
   * Talk to the NPC in range, advancing the conversation to its next line.
   *
   * Returns whether an NPC was in range, so a caller that also has a structure to
   * act on can order the two without reading the controller's internals.
   */
  interact(): boolean;
  /** One coherent read: measurements, selected rows, dialogue, and its anchor. */
  readSnapshot(): VillageNpcSnapshot;
  /** Detach and release every marker. */
  destroy(): void;
}

/* -------------------------------------------------------------------------- */
/* Wander numbers, all of them the Phaser scene's                              */
/* -------------------------------------------------------------------------- */

/** Distance at which an NPC has arrived and starts its pause. */
const ARRIVAL_TOLERANCE_PX = 4;
/** First pause after the scene is built, so villagers do not all step off at once. */
const INITIAL_WAIT_MIN_MS = 0;
const INITIAL_WAIT_MAX_MS = 2000;
/** Pause at each waypoint. */
const WAYPOINT_WAIT_MIN_MS = 400;
const WAYPOINT_WAIT_MAX_MS = 1600;

/** One NPC's wander state. The Phaser scene's `NpcState` plus a visual reference. */
interface WanderState {
  readonly npc: VillageNpc;
  readonly visual: VillageNpcVisual;
  pathIndex: number;
  targetX: number;
  targetY: number;
  waiting: boolean;
  waitTimerMs: number;
}

/**
 * Build the village's NPC layer.
 *
 * Everything the controller creates hangs off `options.parent` and is released by
 * `destroy`, which is the discipline the mount/unmount memory gate measures.
 */
export function createNpcController(options: CreateNpcControllerOptions): NpcController {
  const { parent, npcs, tile, theme, callbacks } = options;
  const randomness = options.randomness ?? DEFAULT_NPC_RANDOMNESS;

  /** Grid coordinates to the centre of that tile, the conversion both scenes use. */
  function toWorldX(gridX: number): number {
    return gridX * tile + tile / 2;
  }

  function toWorldY(gridY: number): number {
    return gridY * tile + tile / 2;
  }

  const wanderers: WanderState[] = npcs.map((npc, index) => {
    const visual = createVillageNpc({ npc, theme, index });
    const startX = toWorldX(npc.gridX);
    const startY = toWorldY(npc.gridY);
    visual.moveTo(startX, startY);
    parent.addChild(visual.container);

    const path = npc.path;
    const state: WanderState = {
      npc,
      visual,
      pathIndex: 0,
      targetX: startX,
      targetY: startY,
      waiting: true,
      waitTimerMs: randomness.waitMs(INITIAL_WAIT_MIN_MS, INITIAL_WAIT_MAX_MS),
    };
    // A path-less NPC waits where it was placed and is skipped by the movement step,
    // which is what the Phaser scene does with `if (!npcData.path) continue`.
    if (path !== undefined && path.length > 0) {
      state.targetX = toWorldX(path[0]!.x);
      state.targetY = toWorldY(path[0]!.y);
      state.waiting = false;
      state.waitTimerMs = 0;
    }
    return state;
  });

  const byId = new Map<string, WanderState>(wanderers.map((entry) => [entry.npc.id, entry]));

  let elapsedMs = 0;
  let currentNpcId: string | null = null;

  /* ------------------------------------------------------------------ */
  /* Movement                                                             */
  /* ------------------------------------------------------------------ */

  function moveNpcs(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const state of wanderers) {
      const path = state.npc.path;
      if (path === undefined || path.length === 0) continue;

      if (state.waiting) {
        state.waitTimerMs -= deltaMs;
        if (state.waitTimerMs > 0) continue;
        state.waiting = false;
        state.pathIndex = (state.pathIndex + 1) % path.length;
        const next = path[state.pathIndex]!;
        state.targetX = toWorldX(next.x);
        state.targetY = toWorldY(next.y);
        continue;
      }

      const dx = state.targetX - state.visual.x;
      const dy = state.targetY - state.visual.y;
      const distance = Math.hypot(dx, dy);
      if (distance < ARRIVAL_TOLERANCE_PX) {
        state.waiting = true;
        state.waitTimerMs = randomness.waitMs(WAYPOINT_WAIT_MIN_MS, WAYPOINT_WAIT_MAX_MS);
        continue;
      }

      const step = NPC_SPEED * dt;
      state.visual.moveTo(
        state.visual.x + (dx / distance) * step,
        state.visual.y + (dy / distance) * step,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Measurement                                                          */
  /* ------------------------------------------------------------------ */

  /** Raw distance from the player to one NPC, using the shared NPC range. */
  function measure(state: WanderState): VillageNearbyCandidate {
    const player = options.readPlayerPosition();
    return {
      kind: 'npc',
      id: state.npc.id,
      label: state.npc.label,
      distance: Math.hypot(player.x - state.visual.x, player.y - state.visual.y),
      range: VILLAGE_NEARBY_RANGES.npc,
    };
  }

  /**
   * Every NPC's measurement, in range or not.
   *
   * Raw on purpose, and every NPC rather than only the nearest: the contract's job is
   * to decide which of these become rows, and a host that pre-filtered would make
   * that policy a per-renderer decision that can differ between Phaser and Pixi.
   */
  function npcCandidates(): readonly VillageNearbyCandidate[] {
    return wanderers.map(measure);
  }

  /**
   * The anchor for the open conversation, recomputed from the NPC's *current*
   * position rather than replayed from the approach.
   *
   * `null` when no conversation is open, so a panel never positions a dialog for
   * somebody who is no longer there.
   */
  function currentAnchor(): VillageNpcDialogAnchor | null {
    const npcId = currentNpcId;
    if (npcId === null) return null;
    const state = byId.get(npcId);
    if (state === undefined) return null;
    return options.projectToViewport(npcId, state.visual.x, state.visual.y);
  }

  /**
   * The nearest NPC strictly inside the shared radius, or `null`.
   *
   * Strictly inside because the Phaser scene seeds its search with the radius and
   * accepts only a strict improvement, so the boundary pixel is not interactive
   * there - and a `nearby` row that exists for a target the canvas refuses to act on
   * is exactly the inconsistency the contract's selection rules exist to prevent.
   */
  function nearestNpcId(): string | null {
    let nearestId: string | null = null;
    let nearestDistance = VILLAGE_NEARBY_RANGES.npc;
    for (const state of wanderers) {
      const candidate = measure(state);
      if (candidate.distance < nearestDistance) {
        nearestDistance = candidate.distance;
        nearestId = state.npc.id;
      }
    }
    return nearestId;
  }

  function setHighlight(npcId: string | null): void {
    for (const state of wanderers) {
      state.visual.setHighlighted(state.npc.id === npcId);
    }
  }

  /**
   * Re-measure proximity and emit the transition.
   *
   * The event order is the Phaser scene's: the previous NPC leaves, then the new one
   * is approached, then the dialog anchor is published. A listener that keeps its own
   * conversation state therefore ends each transition in the same state the Phaser
   * build would have left it in.
   */
  function updateProximity(): void {
    const nextId = nearestNpcId();
    // Only a change of identity is an event. The *anchor* still moves while the NPC
    // in range keeps walking, because `currentAnchor` recomputes it from the NPC's
    // current position on every read rather than replaying the approach position -
    // so a dialog positioned from the snapshot follows her, while the emit rate stays
    // at the Phaser scene's one-per-approach.
    if (nextId === currentNpcId) return;

    if (currentNpcId !== null) {
      callbacks.onNpcLeft?.(currentNpcId);
    }
    currentNpcId = nextId;
    setHighlight(nextId);

    if (nextId !== null) {
      callbacks.onNpcApproached?.(nextId);
      const anchor = currentAnchor();
      if (anchor !== null) callbacks.onNpcDialogPosition?.(anchor);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public surface                                                      */
  /* ------------------------------------------------------------------ */

  return {
    get currentNpcId(): string | null {
      return currentNpcId;
    },

    update(deltaMs: number, motion: CozyMotionProfile): void {
      if (deltaMs > 0) {
        elapsedMs += deltaMs;
        moveNpcs(deltaMs);
      }
      for (const state of wanderers) state.visual.update(elapsedMs, motion);
      updateProximity();
    },

    sync(motion: CozyMotionProfile): void {
      for (const state of wanderers) state.visual.update(elapsedMs, motion);
      updateProximity();
    },

    interact(): boolean {
      const npcId = currentNpcId;
      if (npcId === null) return false;
      callbacks.onNpcInteract?.(npcId);
      return true;
    },

    readSnapshot(): VillageNpcSnapshot {
      const structureCandidates = options.readStructureCandidates?.() ?? [];
      return createVillageNpcSnapshot({
        candidates: [...structureCandidates, ...npcCandidates()],
        anchor: currentAnchor(),
      });
    },

    destroy(): void {
      for (const state of wanderers) state.visual.destroy();
      wanderers.length = 0;
      byId.clear();
      currentNpcId = null;
    },
  };
}
