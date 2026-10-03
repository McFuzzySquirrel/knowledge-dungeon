/**
 * Renderer-neutral application command contract.
 *
 * Commands are the application layer's request vocabulary: a renderer or a DOM
 * control asks for something (`room/interact`, `floor/change`, `village/return`)
 * and the application layer decides what actually happens. One discriminated
 * union member per command, with the payload map as the single source of truth.
 *
 * Phase 14: the map also carries the Creator graph mutations, which used to be
 * Zustand store actions the Creator workspace called directly. They are ordinary
 * commands here for the same reason the world actions are - a DOM control names
 * what it wants and the application layer decides what happens to the subject
 * graph. `src/application/creatorGraphCommands.ts` executes them, so no DOM
 * control performs a graph *mutation* by calling `src/core/graph` itself.
 *
 * Read-only graph queries are a separate matter and are deliberately left where
 * they are: `RoomPanel`, `FullMapView`, `GameScreen`, and `NoteEditorModal`
 * still import `deriveGraphHierarchy`, `getConnectedRoomIds`,
 * `isReachableViaSubtopics`, and `computeFloorVisibility` directly, because
 * those are pure derivations over a snapshot rather than mutations, and routing
 * them through a command would mean asking for data as if requesting an action.
 */
import type { EdgeRelationType } from '@/core/validation/persistence';
import type { FloorTransitionDirection } from './events';

/** Payload of every application command, keyed by command name. */
export interface WorldCommandPayloadMap {
  /** Load a subject and make it the active subject for session + progression. */
  'subject/activate': { subjectId: string };
  /** Player pressed interact on a dungeon room. */
  'room/interact': { roomId: string };
  /** Player pressed interact on a village structure. */
  'structure/interact': { structureId: string };
  /** Player used a portal: change the active floor from the room it stands on. */
  'floor/change': { fromRoomId: string; direction: FloorTransitionDirection };
  /** Travel to a room, switching the active floor when required. */
  'floor/travel': { roomId: string };
  /** Record an artifact produced by clearing a room. */
  'artifact/collect': { roomId: string };
  /** Finish the review of a room and award review progression. */
  'review/complete': { roomId: string };
  /** Leave the dungeon and return to the village. */
  'village/return': void;
  /** Start fishing at a village pond. */
  'fishing/enter': { pondId: string };
  /** Leave the fishing world and return to the village. */
  'fishing/exit': void;

  // ── Creator graph mutations (Phase 14) ──────────────────────────────────
  //
  // Every member below is the command form of a subject-store action that
  // existed before Phase 14. The outcome is the graph domain's own
  // `GraphDomainResult`, unchanged: the same codes, the same messages, the same
  // cascade and revalidation behavior. A caller learns *why* a mutation was
  // refused from the returned result rather than from a store's `lastError`
  // string after the fact.

  /**
   * Creator: create one or more child topics under a room, in one mutation.
   *
   * Blank topics are dropped before anything is created, and an all-blank list
   * is a no-op that reports zero created rooms - the behavior the pre-Phase-14
   * `addChildRooms` action had.
   */
  'graph/children-add': { parentRoomId: string; topics: readonly string[] };
  /**
   * Creator: add a non-hierarchical link between two rooms.
   *
   * `relationType` is optional and defaults to `related`, which is what the
   * pre-Phase-14 `addCrossLinkBetween` action produced.
   */
  'graph/cross-link-add': {
    fromRoomId: string;
    toRoomId: string;
    relationType?: EdgeRelationType;
  };
  /** Creator: move a room under a different parent. */
  'graph/room-reparent': { roomId: string; newParentRoomId: string };
  /**
   * Creator: remove a room. Descendants left unreachable from the root are
   * cascade-removed, and the root room itself cannot be removed.
   */
  'graph/room-remove': { roomId: string };
  /** Creator: replace a room's tag list. */
  'graph/tags-set': { roomId: string; tags: readonly string[] };
  /** Creator: add one tag to a room. */
  'graph/tag-add': { roomId: string; tag: string };
  /** Creator: remove one tag from a room. */
  'graph/tag-remove': { roomId: string; tag: string };
}

/** Every application command name. */
export type WorldCommandName = keyof WorldCommandPayloadMap;

/** Payload type for a single named command. */
export type WorldCommandPayload<C extends WorldCommandName> = WorldCommandPayloadMap[C];

/** A tagged command; `type` is the command name and `payload` its arguments. */
export type WorldCommand = {
  [C in WorldCommandName]: { type: C; payload: WorldCommandPayloadMap[C] };
}[WorldCommandName];

// ── Creator graph mutations ──────────────────────────────────────────────────
//
// The payload aliases below are *derived* from the map above rather than
// declared beside it, so the map stays the single source of truth: a change to
// a payload is a change to the name and to every consumer at once, and the
// controller's method signatures cannot drift away from the command union.

/** Every Creator graph-mutation command name. */
export type GraphCommandName = Extract<WorldCommandName, `graph/${string}`>;

/** Payload of `graph/children-add`. */
export type GraphAddChildTopicsPayload = WorldCommandPayload<'graph/children-add'>;
/** Payload of `graph/cross-link-add`. */
export type GraphAddCrossLinkPayload = WorldCommandPayload<'graph/cross-link-add'>;
/** Payload of `graph/room-reparent`. */
export type GraphReparentRoomPayload = WorldCommandPayload<'graph/room-reparent'>;
/** Payload of `graph/room-remove`. */
export type GraphRemoveRoomPayload = WorldCommandPayload<'graph/room-remove'>;
/** Payload of `graph/tags-set`. */
export type GraphSetRoomTagsPayload = WorldCommandPayload<'graph/tags-set'>;
/** Payload of `graph/tag-add`. */
export type GraphAddRoomTagPayload = WorldCommandPayload<'graph/tag-add'>;
/** Payload of `graph/tag-remove`. */
export type GraphRemoveRoomTagPayload = WorldCommandPayload<'graph/tag-remove'>;

/** The tagged form of every Creator graph mutation. */
export type GraphCommand = {
  [C in GraphCommandName]: { type: C; payload: WorldCommandPayloadMap[C] };
}[GraphCommandName];
