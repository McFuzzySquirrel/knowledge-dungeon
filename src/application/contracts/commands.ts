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
 *
 * Phase 15 adds the Scribe `encounter/*` commands: note submission (draft or
 * clear, reported as a discriminated outcome) and the three local-image
 * attachment commands. `src/application/encounterCommands.ts` executes them. Note
 * that artifact *pickup* is not one of them - it stays `artifact/collect`,
 * which the encounter controller forwards to rather than reimplements, because
 * generation and pickup being separate actions is plan exit criterion 5 and one
 * implementation is how that stays true.
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

  // ── Scribe encounter (Phase 15) ───────────────────────────────────────────
  //
  // The Scribe workspace used to reach into `useSubjectStore` and
  // `useProgressionStore` directly from a modal, which is how a valid note could
  // be awarded twice (see `src/core/progression/roomClearRewards.ts`). These are
  // the same operations as ordinary commands for the same reason the graph
  // mutations are: a DOM control names what it wants, and the application layer
  // decides what happens to the note, the artifact, and the reward.
  //
  // **Artifact pickup is deliberately *not* in this block.** It is already
  // `artifact/collect`, and `encounterCommands` forwards to that command rather
  // than reimplementing it - two implementations of one action is exactly the
  // drift this layer exists to remove. See `src/application/encounterCommands.ts`.
  //
  // There is deliberately no `encounter/*` command for *generating* an artifact
  // either: generation is a consequence of `encounter/note-submit`, which is why
  // plan exit criterion 5 ("artifact generation and pickup remain separate
  // actions") holds by construction - one command generates, the other collects.

  /**
   * Scribe: save a draft, or clear the encounter.
   *
   * The command is one because the *decision* is one: `submitNote` validates and
   * branches, and the command reports which branch ran. The outcome is
   * discriminated so a caller never has to re-read the note to find out whether
   * progression happened.
   */
  'encounter/note-submit': {
    roomId: string;
    /** Exactly what the composer holds; never inspected by the command layer. */
    noteText: string;
    /** The learner's own "these notes are mine" confirmation. */
    manualConfirmed: boolean;
  };
  /**
   * Scribe: store a picked image's bytes on this device and attach it.
   *
   * The file is bytes, not a URL, and the command layer never uploads: the
   * subject store's device-local path writes them to the device-local attachment
   * store. `Blob` is a **type-only** reference, the same one
   * `src/services/persistence/deviceAttachments.ts` takes, so the application
   * layer needs no DOM lib and no runtime global.
   */
  'encounter/attachment-add': {
    roomId: string;
    file: Blob & { readonly name?: string };
  };
  /**
   * Scribe: attach an image the learner already hosts somewhere.
   *
   * The URL is recorded as an external-only attachment and is never fetched, so
   * this command discloses a location rather than making a request.
   */
  'encounter/attachment-add-external': { roomId: string; url: string };
  /** Scribe: forget one attachment, its device-local bytes included. */
  'encounter/attachment-remove': { roomId: string; attachmentId: string };
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

// ── Scribe encounter ─────────────────────────────────────────────────────────
//
// Derived from the payload map, exactly as the `graph/*` aliases above are, so
// the map stays the single source of truth and a controller's method signatures
// cannot drift from the command union.

/** Every Scribe encounter command name. */
export type EncounterCommandName = Extract<WorldCommandName, `encounter/${string}`>;

/** Payload of `encounter/note-submit`. */
export type EncounterNoteSubmitPayload = WorldCommandPayload<'encounter/note-submit'>;
/** Payload of `encounter/attachment-add`. */
export type EncounterAttachmentAddPayload = WorldCommandPayload<'encounter/attachment-add'>;
/** Payload of `encounter/attachment-add-external`. */
export type EncounterAttachmentAddExternalPayload =
  WorldCommandPayload<'encounter/attachment-add-external'>;
/** Payload of `encounter/attachment-remove`. */
export type EncounterAttachmentRemovePayload =
  WorldCommandPayload<'encounter/attachment-remove'>;

/** The tagged form of every Scribe encounter command. */
export type EncounterCommand = {
  [C in EncounterCommandName]: { type: C; payload: WorldCommandPayloadMap[C] };
}[EncounterCommandName];

/**
 * The existing artifact-pickup command, named as a type.
 *
 * `EncounterController.artifactCollect` accepts this so the reuse is visible in
 * the contract rather than only in prose: the encounter controller cannot
 * dispatch anything except the pickup it forwards to.
 */
export type ArtifactCollectCommand = {
  type: 'artifact/collect';
  payload: WorldCommandPayload<'artifact/collect'>;
};
