/**
 * The dungeon artifact marker: when it is drawn, when a pickup may happen, and the
 * words a DOM mirror says about it.
 *
 * ## Why this module exists
 *
 * Phase 13 drew an artifact marker and collected it by walking onto it, and the marker
 * was governed by `DungeonRendererCapabilities.setArtifactRooms(roomIds, visible)`.
 * `visible` is the *host's* answer to "may an artifact be picked up right now", and
 * Phase 15 made the question real: the Scribe phase is the phase in which a note clears
 * an encounter and an artifact is *generated*, so a pickup the renderer refused to offer
 * until the Archaeologist phase left the learner with a thing they had made and no way
 * to take it.
 *
 * Three facts were previously spread across three places and could disagree:
 *
 * - `RoomNodeState.artifactVisible` and `artifactCollected` were two booleans the scene
 *   filled in, so "the marker is drawn" was `a && !b` in one file and a separate
 *   recomputation of the same expression in `checkArtifactCollection`.
 * - The *words* for the state lived in a `✓` glyph appended to the room topic, which is
 *   a symbol and not a sentence, and which only existed for one of the three states.
 * - A DOM surface had no read at all: the only evidence a room's artifact had been
 *   collected was the `dungeon:artifact-collected` callback, so a control could not ask
 *   "may I collect this?" before offering itself.
 *
 * So the decision is made once, here, as a pure function, and both the drawing and the
 * pickup test call it. {@link resolveDungeonArtifactMarker} is the rule; nothing in
 * `src/renderers/**` is allowed to answer the question another way.
 *
 * ## What the rule is, and where each input comes from
 *
 * | Input | Source | Domain meaning |
 * | --- | --- | --- |
 * | `hasArtifact` | host, via `setArtifactRooms` | `room.artifactMarkdown` is non-empty, i.e. `encounter/note-submit` cleared the room |
 * | `collected` | host, via `setCollectedArtifactRooms`, **plus** the renderer's own record | a `${dungeonId}:${roomId}` journal entry exists |
 * | `pickupPermitted` | host, via the `visible` argument of `setArtifactRooms` | pickup is a live action in whatever phase the session is in |
 *
 * ## Why there is no phase in this file
 *
 * A renderer may not import the session store or compare a phase enum: `src/renderers/**`
 * is renderer-neutral by rule, and a `phase === 'scribe'` here would be the first place
 * the two renderers could diverge over the study flow's vocabulary. `pickupPermitted` is
 * the host pushing that decision in as data, exactly as `floor.visibleRoomIds` and
 * `playerClass` already are. The *domain* rule - pickup is permitted wherever an artifact
 * exists and has not been collected, which `StudyFlowController.collectArtifact` enforces
 * with no phase test of its own - is therefore the host's to express, and the renderer
 * honours whatever it is told, in every phase.
 *
 * ## What this module deliberately does not do
 *
 * It names no PixiJS type, no DOM global, and no store. It is the pure half, so a test
 * can assert the whole rule without a canvas, and so the DOM words have one home that the
 * canvas label, the drawn marker, and a React mirror all read rather than each writing
 * their own.
 */

/* ── The action ────────────────────────────────────────────────────────────── */

/**
 * The action id a DOM control passes to `activateFromDom` to ask for a pickup.
 *
 * ## Why it is not in `DUNGEON_ACTIONS`
 *
 * That table is the always-on mirror group, and every member of it is rendered as a
 * button beside the canvas. A pickup is *conditional*: in most rooms, at most moments,
 * there is nothing to collect, so a permanent control would spend the phase saying
 * "Unavailable: there is no artifact here" - plan 10.1's noise - while the surface that
 * actually owns the action, the Scribe encounter workspace, is the one that should show
 * it, and only when it applies. So the verb is declared here, is routed through the same
 * host dispatch as every other action (the host publishes once either way), and is
 * surfaced by whichever DOM surface owns the room.
 */
export const DUNGEON_ARTIFACT_ACTION_ID = 'dungeon-collect-artifact';

/** Accessible name for the pickup control, shared by the canvas label and the DOM. */
export const DUNGEON_ARTIFACT_ACTION_LABEL = 'Collect artifact';

/** Longer description, for the control's `aria-describedby`. */
export const DUNGEON_ARTIFACT_ACTION_HINT =
  'Puts the artifact waiting in this room into the journal. Picking it up is separate from writing the note that made it.';

/* ── The rule ──────────────────────────────────────────────────────────────── */

/**
 * What a room's artifact marker is doing.
 *
 * Three answers, not two booleans, because "has an artifact" and "can be collected" are
 * different facts and `artifactVisible = has && !collected` cannot say which one is false.
 * A learner who sees nothing needs to be told *which* nothing it is.
 *
 * - `'none'` - nothing to offer. Either no artifact was generated, or pickup is not
 *   permitted in the phase the session is in.
 * - `'collectible'` - an artifact is waiting here and may be picked up. The only state in
 *   which the marker is drawn and the only state in which a pickup is performed.
 * - `'collected'` - the artifact has already gone into the journal. Never re-offered.
 */
export type DungeonArtifactMarkerState = 'none' | 'collectible' | 'collected';

/** The three inputs the marker rule reads. */
export interface DungeonArtifactMarkerInput {
  /**
   * Whether the host currently permits a pickup at all.
   *
   * The host's decision, pushed in as data. This module never derives it, because the
   * only thing that knows the current phase is the session store.
   */
  readonly pickupPermitted: boolean;
  /** Whether an artifact has been generated for the room. */
  readonly hasArtifact: boolean;
  /** Whether that artifact is already in the journal. */
  readonly collected: boolean;
}

/**
 * Decide what a room's artifact marker is doing.
 *
 * ## The precedence, and why `collected` is checked first
 *
 * `collected` is a fact about the journal that holds no matter which phase the session
 * is in. Checking it first means a room that was picked up in the Scribe phase keeps
 * saying "artifact collected" in the Archaeologist phase rather than reverting to a
 * marker, and it means the collected label cannot be suppressed by a host that has
 * turned pickup off.
 *
 * The order is therefore:
 *
 * 1. `collected` -> `'collected'`. A collected artifact is never re-offered.
 * 2. `hasArtifact && pickupPermitted` -> `'collectible'`. The marker is drawn here and
 *    only here, so "the marker is visible" and "a pickup can happen" are the same
 *    statement rather than two expressions that agree today.
 * 3. otherwise `'none'`.
 *
 * Total and side-effect free, so it is safe to call from the drawing path, from the
 * per-frame pickup test, and from a DOM read with no risk of the three drifting apart.
 */
export function resolveDungeonArtifactMarker(
  input: DungeonArtifactMarkerInput,
): DungeonArtifactMarkerState {
  if (input.collected) return 'collected';
  if (input.hasArtifact && input.pickupPermitted) return 'collectible';
  return 'none';
}

/** Whether the marker is drawn at all. One place, so no caller re-derives it. */
export function isDungeonArtifactMarkerDrawn(state: DungeonArtifactMarkerState): boolean {
  return state === 'collectible';
}

/* ── The words ─────────────────────────────────────────────────────────────── */

/**
 * The words for a marker state, as a suffix on a room label.
 *
 * ## Why words and not a glyph
 *
 * The room label previously appended `✓` when an artifact had been collected. A tick is
 * a symbol: it says nothing to a screen reader, nothing to a learner who cannot
 * distinguish the hues, and nothing about the two states it did *not* cover. These are
 * sentences, so the same string serves the drawn `Text`, a room-navigation button's
 * accessible name, and the mirror's live region - and they are defined here so the three
 * cannot drift into three vocabularies for one fact.
 *
 * Empty for `'none'` rather than a third phrase: a room with nothing to offer should say
 * nothing about artifacts, so its label stays exactly the topic it had before artifacts
 * existed.
 */
export function describeDungeonArtifactMarkerSuffix(state: DungeonArtifactMarkerState): string {
  if (state === 'collectible') return ' · artifact ready to collect';
  if (state === 'collected') return ' · artifact collected';
  return '';
}

/** One room's artifact state, for a surface that renders a room list. */
export interface DungeonArtifactRoomView {
  readonly roomId: string;
  readonly topic: string;
  readonly state: DungeonArtifactMarkerState;
  /** The drawn label for this room: topic plus the artifact words, or topic alone. */
  readonly label: string;
}

/**
 * The whole artifact surface of a mounted dungeon, as one value.
 *
 * ## Why this read exists
 *
 * `onArtifactCollected` is a *notification*: it says a pickup happened and arrives after
 * the fact. A DOM control that wants to offer "Collect artifact" needs the other half -
 * a *read* it can consult before offering - and until this existed the only way a React
 * surface could learn a room's collection state was to be the callback's recipient.
 *
 * The shape is the village's Phase 12 `VillageNpcSnapshot`, deliberately: data out of a
 * renderer port, not a handle into a scene, and one value rather than several polls that
 * could be observed at different instants and disagree.
 */
export interface DungeonArtifactSnapshot {
  /**
   * The room the player is standing in, or `null` on a corridor or before mount.
   *
   * `null` is a real answer - it is what a mirror must render "walking the corridors"
   * from - rather than a missing object.
   */
  readonly roomId: string | null;
  /** The room's topic, or `''` when there is no room. */
  readonly topic: string;
  /** The marker state for that room. `'none'` when there is no room. */
  readonly state: DungeonArtifactMarkerState;
  /** An artifact has been generated for this room. */
  readonly exists: boolean;
  /** That artifact is already in the journal. */
  readonly collected: boolean;
  /** The host's current pickup-permitted gate. */
  readonly pickupPermitted: boolean;
  /**
   * Whether a pickup should be offered for this room right now.
   *
   * Exactly `state === 'collectible'`, published as its own field so a control never
   * re-derives the rule and never disagrees with what the canvas drew.
   */
  readonly canCollect: boolean;
  /**
   * Whether the player is standing on the marker itself.
   *
   * A canvas *gesture* measurement, reported so a surface can say "walk onto the marker"
   * instead of implying the pickup needs a specific step onto a spot. It is not a gate:
   * the DOM control names the room, exactly as the room-navigation buttons name a room
   * and teleport rather than walk.
   */
  readonly withinPickupRange: boolean;
  /** Whether the marker is currently drawn. */
  readonly markerVisible: boolean;
  /** The drawn room label: topic, then the artifact words. */
  readonly label: string;
  /** The one sentence a mirror announces for this room. */
  readonly sentence: string;
  /**
   * Every room on the visible floor that has an artifact or has had one collected, in map
   * order.
   *
   * Rooms with nothing to say are left out, so a mirror can suffix a room's accessible name
   * without carrying an entry per room. A room whose artifact exists but cannot be picked up
   * *is* included: "an artifact waits here and collecting is not available" is a fact a
   * surface should be able to state, and dropping it would leave the marker-less room looking
   * identical to a room that never had one.
   */
  readonly rooms: readonly DungeonArtifactRoomView[];
}

/** What {@link createDungeonArtifactSnapshot} needs, all of it already a renderer fact. */
export interface DungeonArtifactSnapshotInput {
  readonly roomId: string | null;
  readonly topic: string;
  readonly pickupPermitted: boolean;
  readonly hasArtifact: boolean;
  readonly collected: boolean;
  readonly withinPickupRange: boolean;
  readonly rooms: readonly DungeonArtifactRoomView[];
}

/**
 * The sentence a mirror announces for a room's artifact.
 *
 * Four answers, because "no artifact" and "an artifact you cannot collect yet" are
 * different facts and collapsing them would leave a learner who has just written a note
 * being told there is nothing there.
 */
function artifactSentence(
  roomLabel: string,
  state: DungeonArtifactMarkerState,
  hasArtifact: boolean,
): string {
  const where = roomLabel === '' ? 'here' : roomLabel;
  switch (state) {
    case 'collectible':
      return `Artifact ready to collect in ${where}.`;
    case 'collected':
      return `Artifact collected from ${where}.`;
    default:
      return hasArtifact
        ? `An artifact waits in ${where}. Collecting is not available in this view.`
        : `No artifact to collect in ${where}.`;
  }
}

/**
 * Build the snapshot, applying the marker rule exactly once.
 *
 * The two fields a control acts on - `state` and `canCollect` - are computed from the
 * same call, so a control cannot be enabled by one rule and described by another.
 *
 * Frozen, including the room array: a snapshot handed to React must not be mutable from
 * under it, and a `rooms` array that could be pushed into after publication would let a
 * mirror show a room the renderer has not drawn.
 */
export function createDungeonArtifactSnapshot(
  input: DungeonArtifactSnapshotInput,
): DungeonArtifactSnapshot {
  const state = resolveDungeonArtifactMarker({
    pickupPermitted: input.pickupPermitted,
    hasArtifact: input.hasArtifact,
    collected: input.collected,
  });
  const roomId = input.roomId;
  return Object.freeze({
    roomId,
    topic: input.topic,
    state,
    exists: input.hasArtifact,
    collected: input.collected,
    pickupPermitted: input.pickupPermitted,
    canCollect: state === 'collectible',
    withinPickupRange: input.withinPickupRange,
    markerVisible: isDungeonArtifactMarkerDrawn(state),
    label: `${input.topic}${describeDungeonArtifactMarkerSuffix(state)}`,
    sentence: artifactSentence(input.topic, state, input.hasArtifact),
    rooms: Object.freeze([...input.rooms]),
  });
}

/**
 * The snapshot a renderer reports before it has a world.
 *
 * Every field an answer, so a control that mounts before the scene is built renders
 * "no artifact to collect here" rather than branching on `undefined` - which is the
 * Phase 12 `readNpcSnapshot` rule restated for the dungeon.
 */
export const IDLE_DUNGEON_ARTIFACT_SNAPSHOT: DungeonArtifactSnapshot = Object.freeze(
  createDungeonArtifactSnapshot({
    roomId: null,
    topic: '',
    pickupPermitted: false,
    hasArtifact: false,
    collected: false,
    withinPickupRange: false,
    rooms: [],
  }),
);