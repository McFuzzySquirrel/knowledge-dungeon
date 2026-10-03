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
 *
 * Phase 16 adds the Archaeologist `review/*` commands: explicit pass completion
 * with a learner recall rating, plus the save / resume / discard decision for a
 * review that was started and not finished.
 * `src/application/reviewCommands.ts` executes them. The award is idempotent per
 * (room, pass) through a durable ledger - see
 * `src/core/review/reviewPassRewards.ts` - which is what plan 5.2's "review
 * completion is recorded exactly once per room per pass" actually requires; the
 * old flow decided that with a live read against a counter an asynchronous writer
 * had not moved yet.
 *
 * ## The pre-existing `review/complete` command is dead, and stays dead
 *
 * `'review/complete': { roomId: string }` is declared by the map below and has
 * **no dispatcher, no payload reader, and no test** anywhere in `src/` or
 * `tests/` (grep-verified at b756d34: exactly one hit, the declaration itself).
 * It is the pre-Phase-16 shape of the operation - a room id and nothing else -
 * and it is exactly what Phase 16 cannot use: a pass-complete with no rating is
 * the behaviour the game guide describes and the application never delivered, and
 * a pass-complete with no reward identity is the double-count defect.
 *
 * It is **left in place** rather than deleted, and `ReviewCommandName` excludes it
 * explicitly below. Deleting a member of the shared payload map is a contract
 * change for every consumer of `WorldCommandName`, including the two hosts this
 * phase is not touching; leaving it declared costs nothing and keeps the map an
 * honest record of the Phase 2 world contract. The explicit exclusion is what
 * stops it from becoming a fifth review route, and it is written as a named
 * `Exclude` with the reason here rather than as a silent filter.
 */
import type { EdgeRelationType } from '@/core/validation/persistence';
import type { QualityRating } from '@/core/review/spacedRepetition';
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

  // ── Archaeologist review (Phase 16) ─────────────────────────────────────────
  //
  // `finalizePendingReview` used to compute `shouldAwardReviewXp` from a live
  // read and then call two stores, one of them unawaited, so a room's review pass
  // and its XP could be counted twice (see `src/core/review/reviewPassRewards.ts`).
  // These are the same operations as ordinary commands for the same reason the
  // `encounter/*` block above is: a control names what it wants, and the
  // application layer decides what happens to SM-2, the reward, and the marker.
  //
  // **The four commands are the interrupted-review decision**, which plan section
  // 5.3 called out as a defect ("Interrupted review state can be lost on exit").
  // A review that was started and not finished is either completed
  // (`pass-complete`), parked for later (`session-save`), abandoned
  // (`session-discard`), or picked back up (`session-resume`).
  //
  // **Artifact pickup is deliberately *not* in this block**, for the same reason it
  // is absent from `encounter/*`: it is already `artifact/collect`, owned by
  // whichever world flow is mounted, and `studyFlowController.collectArtifact`
  // implements it. Generation and pickup being separate actions is plan exit
  // criterion 5, and one implementation is how that stays true.

  /**
   * Archaeologist: finish a review pass, rate the recall, and take the reward.
   *
   * The **explicit-completion route**, and the only one that awards. The rating is
   * required because the learner answered it: `src/data/gameGuide.ts` has told
   * learners to "rate your recall on a 0-5 scale" since before the rating could be
   * supplied, and `subjectStore.recordReviewPass` defaulted it to 3.
   *
   * Idempotent for (room, pass) through the durable ledger, so a double dispatch,
   * a retried close, and a reload all award at most once.
   */
  'review/pass-complete': {
    roomId: string;
    /** The learner's own 0-5 recall rating. Never inferred. */
    qualityRating: QualityRating;
  };
  /**
   * Archaeologist: save an unfinished review and come back to it later.
   *
   * Writes a **resumable marker only**. It does **not** write an SM-2 update and
   * does not increment `reviewPassCount`: a review the learner did not finish has
   * not been recalled, so scheduling the next review from it would make SM-2
   * reward an unfinished session. See the header of
   * `src/application/reviewCommands.ts`.
   */
  'review/session-save': {
    roomId: string;
    /**
     * A rating the learner chose before leaving, or `null` for none.
     *
     * Recorded **beside** the marker for the surface to restore. Not applied to
     * SM-2, for the reason above.
     */
    qualityRating: QualityRating | null;
  };
  /** Archaeologist: abandon an unfinished review. Awards nothing, clears the marker. */
  'review/session-discard': { roomId: string };
  /** Archaeologist: re-enter an interrupted review. Reports whether one existed. */
  'review/session-resume': { roomId: string };
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

// ── Archaeologist review ─────────────────────────────────────────────────────
//
// Derived from the payload map, exactly as the `graph/*` and `encounter/*` aliases
// above are, so the map stays the single source of truth and a controller's
// method signatures cannot drift from the command union.

/**
 * Every Archaeologist review command name Phase 16 introduces.
 *
 * `review/complete` is excluded by name, and the exclusion is deliberate rather
 * than cosmetic: see the module header. Without it, `Extract<..., \`review/${string}\`>`
 * would sweep the dead Phase 2 declaration into this union and
 * `ReviewController.dispatch` would have to answer it.
 */
export type ReviewCommandName = Exclude<
  Extract<WorldCommandName, `review/${string}`>,
  'review/complete'
>;

/** Payload of `review/pass-complete`. */
export type ReviewPassCompletePayload = WorldCommandPayload<'review/pass-complete'>;
/** Payload of `review/session-save`. */
export type ReviewSessionSavePayload = WorldCommandPayload<'review/session-save'>;
/** Payload of `review/session-discard`. */
export type ReviewSessionDiscardPayload = WorldCommandPayload<'review/session-discard'>;
/** Payload of `review/session-resume`. */
export type ReviewSessionResumePayload = WorldCommandPayload<'review/session-resume'>;

/** The tagged form of every Archaeologist review command Phase 16 introduces. */
export type ReviewCommand = {
  [C in ReviewCommandName]: { type: C; payload: WorldCommandPayloadMap[C] };
}[ReviewCommandName];
