/**
 * Scribe encounter application layer.
 *
 * The note editor used to live in one modal that reached into
 * `useSubjectStore` and `useProgressionStore` directly. Two things were wrong
 * with that, and both are fixed here rather than in the component:
 *
 * 1. The modal called `awardRoomClear` after *any* `submitNote` result with
 *    `finalPass`, so a resubmission, a StrictMode double dispatch, or a retried
 *    write awarded XP, loot, and a `roomsCleared` increment again. This module
 *    asks the reward transaction for a (room, clear generation) identity - see
 *    `src/core/progression/roomClearRewards.ts` - and reports whether the award
 *    happened, so a caller can never announce a reward that did not occur.
 * 2. A caller had to re-read the note to find out whether the submission saved a
 *    draft or cleared the encounter. The outcome is a discriminated union, so
 *    "which branch ran" is in the type.
 *
 * Plain TypeScript, like `creatorGraphCommands.ts` and `studyFlow.ts`: no React,
 * no renderer, no DOM, no store import. Every side effect - read the snapshot,
 * submit the note, write the reward, mint a badge, hand over an artifact pickup -
 * is an injected port, so the whole surface is testable without a browser.
 *
 * ## Semantics are the pre-Phase-15 modal's, deliberately
 *
 * - The draft branch is untouched: `NotesDrafted`, `artifactMarkdown: null`, no
 *   progression of any kind.
 * - The clear branch is untouched: artifact generated, `phaseState` promoted by
 *   `submitNote` itself, then the room clear, then the 120-word badge. The order
 *   is the modal's order and is not rearranged.
 * - The badge-progress numbers are computed from the **pre-submit** snapshot,
 *   which is what the modal did: its `snapshot` was a render-time closure value,
 *   so `cleared + 1` counted the room being cleared. Deriving them afterwards
 *   would silently change `scribeClearedRooms`, which feeds badge unlocks.
 * - A persistence failure **rejects**, exactly as `await persist(next)` rejecting
 *   did inside `submitNote`. The command does not wrap the port call in a
 *   `try`; turning an I/O failure into a typed result would be a typed lie, and
 *   the modal's own `catch` is what surfaces it today.
 * - The two conditions `submitNote` *throws* for - no active subject, unknown
 *   room - are answered as typed refusals instead, carrying `submitNote`'s own
 *   message strings rather than new ones. `submitNote` never wrote `lastError`
 *   on either path, so this module writes nothing either.
 * - Nothing here fetches, uploads, or forms a request. The local attachment path
 *   goes through the subject store's device-local write, which is the Phase 4
 *   boundary; the external path records a URL and never resolves it.
 *
 * Domain messages are passed through verbatim and never restated, so they cannot
 * drift from the domain's own wording.
 */
import { deriveGraphHierarchy } from '@/core/graph';
import { isBossFloor } from '@/core/layout/bossRooms';
import { NOTE_BADGE_WORD_COUNT, type NoteValidationOutput } from '@/core/validation/notes';
import { deriveRoomClearIdentity } from '@/core/progression/roomClearRewards';
import { SCRIBE_CENTURY_120_BADGE_ID } from '@/core/progression/types';
import type { CanonicalLootItem } from '@/core/progression/canonicalProgression';
import type { RankTier } from '@/core/progression/types';
import type { RoomAttachment, SubjectSnapshot } from '@/core/validation/persistence';
import type {
  ArtifactCollectCommand,
  EncounterAttachmentAddExternalPayload,
  EncounterAttachmentAddPayload,
  EncounterAttachmentRemovePayload,
  EncounterCommand,
  EncounterCommandName,
  EncounterNoteSubmitPayload,
} from './contracts/commands';

// ── Ports ───────────────────────────────────────────────────────────────────

/**
 * What `submitNote` resolves to.
 *
 * Mirrored rather than imported so the application layer depends on the *shape*
 * it needs, not on the store action's declared return type; the discriminated
 * `artifactMarkdown` is the whole reason the branch is reportable.
 */
export type EncounterNoteSubmissionResult = NoteValidationOutput & {
  artifactMarkdown: string | null;
};

/**
 * The subject store, as this module is allowed to see it.
 *
 * Four operations, no more. `submitNote` is called exactly as the modal called
 * it, so the draft/clear branch, the artifact generation, the room status, and
 * the `phaseState` promotion all remain the store's business.
 */
export interface EncounterSubjectStorePort {
  /** Live subject snapshot, or `null` when no subject is loaded. */
  readSnapshot(): SubjectSnapshot | null;
  /**
   * Validate and save a note. Resolves with the validation outcome; rejects when
   * the write fails, exactly as it did in the modal.
   */
  submitNote(
    roomId: string,
    noteText: string,
    manualConfirmed: boolean,
  ): Promise<EncounterNoteSubmissionResult>;
  /** Store picked bytes on this device and attach them. Never uploads. */
  addDeviceLocalAttachment(
    roomId: string,
    file: Blob & { readonly name?: string },
  ): Promise<RoomAttachment | null>;
  /** Record an externally hosted image. Never fetches the URL. */
  addExternalAttachment(roomId: string, url: string): Promise<RoomAttachment | null>;
  /** Forget an attachment, and its device-local bytes when it has them. */
  removeAttachment(roomId: string, attachmentId: string): Promise<void>;
}

/** The reward transaction, as this module is allowed to see it. */
export interface EncounterProgressionPort {
  /**
   * Award a room clear. `clear` is what makes the award idempotent; the store's
   * own refusal and no-subject answers come back with `awarded: false`.
   */
  awardRoomClear(input: {
    qualityBonus: number;
    totalRooms: number;
    creatorMappedRooms: number;
    scribeClearedRooms: number;
    archaeologistFullReviewPasses: number;
    isBossEncounter?: boolean;
    bossMinLootRarity?: 'rare' | 'epic';
    clear?: { roomId: string; clearIdentity: string };
  }): {
    xpGained: number;
    newRank: RankTier;
    rankChanged: boolean;
    unlockedBadges: string[];
    loot: CanonicalLootItem | null;
    unlockedAchievements: string[];
    awarded: boolean;
    duplicate: boolean;
  };
  /**
   * Award a badge. Already idempotent (it returns `false` for a badge already
   * held), which is why this module can call it on every clear - including a
   * suppressed one - without changing behaviour.
   */
  awardBadge(badgeId: string): boolean;
}

/**
 * The world flow that owns artifact pickup.
 *
 * A narrow port rather than a generic command bus on purpose: the encounter
 * controller's only non-encounter dispatch is the pickup, and saying so in a
 * type is what keeps it from growing into a second bus.
 */
export interface EncounterArtifactCollectionPort {
  /**
   * Run the existing `artifact/collect` command.
   *
   * `studyFlowController.collectArtifact` is the implementation: it decides
   * whether the room has an artifact, builds the journal entry, and opens the
   * journal when the collection landed. This module does not repeat any of that,
   * and does not add an `encounter/artifact-collect` sibling, because two
   * implementations of one action would drift.
   */
  collectArtifact(command: ArtifactCollectCommand): void | Promise<void>;
}

/** Everything {@link createEncounterController} needs. */
export interface EncounterCommandDeps {
  subject: EncounterSubjectStorePort;
  progression: EncounterProgressionPort;
  artifactCollection: EncounterArtifactCollectionPort;
  /** Wall clock, so the ledger's timestamp is injectable. */
  nowIso(): string;
}

// ── Results ─────────────────────────────────────────────────────────────────

/**
 * Refusal codes.
 *
 * `NO_ACTIVE_SUBJECT` and `ROOM_NOT_FOUND` name the two conditions the note
 * store throws for, restated as codes. `INVALID_OPERATION` is the one code that
 * is not a restatement: it reports this layer's own invariant - a clear that
 * produced no artifact - so a broken store surfaces as a refusal rather than as
 * a "cleared" outcome carrying no artifact.
 */
export type EncounterCommandErrorCode =
  | 'NO_ACTIVE_SUBJECT'
  | 'ROOM_NOT_FOUND'
  | 'INVALID_OPERATION';

export interface EncounterCommandError {
  code: EncounterCommandErrorCode;
  /**
   * The store's own message for the same condition.
   *
   * `submitNote` threw these strings before Phase 15; reusing them means a
   * surface that toasts `error.message` shows a learner the same words whether
   * the command or the store answered. They are condition messages, not learner
   * data.
   */
  message: string;
  /** The room the command was about, when there was one. */
  details?: Record<string, unknown>;
}

/** The result of one encounter command. */
export type EncounterCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EncounterCommandError };

// ── Outcomes ────────────────────────────────────────────────────────────────

/** What the reward transaction reported for a clear. */
export interface EncounterClearRewardOutcome {
  /** The room this reward was for. */
  roomId: string;
  /** The digest of the graph generation the clear was validated in. */
  clearIdentity: string;
  /** False when the ledger already held this exact (room, clear generation). */
  awarded: boolean;
  /** True when the award was suppressed as a repeat. */
  duplicate: boolean;
  xpGained: number;
  newRank: RankTier;
  rankChanged: boolean;
  unlockedBadges: string[];
  loot: CanonicalLootItem | null;
  unlockedAchievements: string[];
  /** Whether the 120-word Scribe badge was newly awarded by this submission. */
  badgeAwarded: boolean;
}

/** `encounter/note-submit` saved a draft. No progression, by construction. */
export interface EncounterNoteDraftOutcome {
  command: 'encounter/note-submit';
  roomId: string;
  kind: 'draft';
  /** The note validation, verbatim, so a surface needs no second evaluation. */
  validation: NoteValidationOutput;
  /** Always `null` on this branch; the store clears any previous artifact. */
  artifactMarkdown: null;
  /** Always `null` on this branch. Present so "no reward" is in the type. */
  progression: null;
}

/** `encounter/note-submit` cleared the encounter. */
export interface EncounterNoteClearOutcome {
  command: 'encounter/note-submit';
  roomId: string;
  kind: 'cleared';
  validation: NoteValidationOutput;
  /** The generated artifact markdown, verbatim from the store. */
  artifactMarkdown: string;
  progression: EncounterClearRewardOutcome;
}

/** Either branch of `encounter/note-submit`. */
export type EncounterNoteSubmitOutcome = EncounterNoteDraftOutcome | EncounterNoteClearOutcome;

/** What `encounter/attachment-add` and `...-add-external` produced. */
interface EncounterAttachmentAddBase {
  roomId: string;
  /**
   * The created attachment, or `null` when the store declined to create one.
   *
   * `null` is a real answer - the store returns it when it has no subject or the
   * room is gone between the pre-check and the call - so it is not collapsed into
   * a refusal.
   */
  attachment: RoomAttachment | null;
}

/** `encounter/attachment-add`. */
export interface EncounterAttachmentAddOutcome extends EncounterAttachmentAddBase {
  command: 'encounter/attachment-add';
}

/** `encounter/attachment-add-external`. */
export interface EncounterAttachmentAddExternalOutcome extends EncounterAttachmentAddBase {
  command: 'encounter/attachment-add-external';
}

/** What `encounter/attachment-remove` removed. */
export interface EncounterAttachmentRemoveOutcome {
  command: 'encounter/attachment-remove';
  roomId: string;
  attachmentId: string;
}

/**
 * What `EncounterController.artifactCollect` did.
 *
 * The `command` field is `artifact/collect`, not an `encounter/*` name: this is
 * the reuse, stated in the type. The outcome is whether the pickup was *handed
 * over*, because whether it landed is the world flow's answer - it opens the
 * journal itself, and a caller that needs "is it collected" reads the view model.
 */
export interface EncounterArtifactCollectOutcome {
  command: 'artifact/collect';
  roomId: string;
  handedToWorldFlow: true;
}

/** Every encounter outcome, discriminated by command. */
export type EncounterOutcome =
  | EncounterNoteSubmitOutcome
  | EncounterArtifactCollectOutcome
  | EncounterAttachmentAddOutcome
  | EncounterAttachmentAddExternalOutcome
  | EncounterAttachmentRemoveOutcome;

/** The result of one named encounter command. */
export type EncounterResult<C extends EncounterCommandName> = EncounterCommandResult<
  Extract<EncounterOutcome, { command: C }>
>;

/**
 * The result of the forwarded artifact pickup.
 *
 * Its own alias rather than an `EncounterResult<'artifact/collect'>`, because
 * `artifact/collect` is not an `encounter/*` command - that is the point of it.
 *
 * Phase 15. **This promise can reject**, and that is deliberate rather than an
 * oversight: the pickup is owned by whichever world flow is mounted, and a host that
 * never bound one has no correct answer to give. `src/store/encounterCommands.ts`
 * throws in that case with a message naming the missing wiring. Reporting
 * `{ ok: true }` for an action that never ran would be a typed lie in the same way a
 * swallowed persistence failure is, so the declared alias stays a *resolved* result
 * and the rejection is part of the contract. Callers must handle both - the Scribe
 * surface does, and reports it as a refusal rather than as a successful collection.
 */
export type EncounterArtifactCollectResult = EncounterCommandResult<EncounterArtifactCollectOutcome>;

// ── Shared answers ──────────────────────────────────────────────────────────

/**
 * The messages the note store throws for its two preconditions.
 *
 * Not invented: they are `submitNote`'s own strings. A condition message is not
 * learner data, and reusing them is what lets a surface show the same words
 * whichever lane answered.
 */
const NO_ACTIVE_SUBJECT_MESSAGE = 'No active subject';
const ROOM_NOT_FOUND_MESSAGE = 'Room not found';

/**
 * The clear-without-an-artifact message.
 *
 * A condition message about the application's own wiring, not a restatement of a
 * domain message: `submitNote` generates the artifact inside its own clear branch
 * and returns it, so this can only fire if that wiring is broken.
 */
const CLEAR_WITHOUT_ARTIFACT_MESSAGE = 'Submitted note cleared without an artifact.';

/**
 * The no-active-subject refusal.
 *
 * `reportFailure` is deliberately absent from this module's surface: `submitNote`
 * returned before touching `lastError` on this path, and preserving that is what
 * lets a rollback to the store lane show the same thing.
 */
function noActiveSubject(): EncounterCommandResult<never> {
  return { ok: false, error: { code: 'NO_ACTIVE_SUBJECT', message: NO_ACTIVE_SUBJECT_MESSAGE } };
}

/** The unknown-room refusal, carrying the room that was asked for. */
function roomNotFound(roomId: string): EncounterCommandResult<never> {
  return {
    ok: false,
    error: { code: 'ROOM_NOT_FOUND', message: ROOM_NOT_FOUND_MESSAGE, details: { roomId } },
  };
}

/** The room a command is about, or the typed refusal for why there is none. */
type RoomLookup =
  | { ok: true; snapshot: SubjectSnapshot; room: SubjectSnapshot['rooms'][string] }
  | { ok: false; result: EncounterCommandResult<never> };

function requireRoom(deps: EncounterCommandDeps, roomId: string): RoomLookup {
  const snapshot = deps.subject.readSnapshot();
  if (!snapshot) return { ok: false, result: noActiveSubject() };
  const room = snapshot.rooms[roomId];
  if (!room) return { ok: false, result: roomNotFound(roomId) };
  return { ok: true, snapshot, room };
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Whether a room sits on a boss floor, from the pre-submit snapshot. */
function isBossEncounterIn(snapshot: SubjectSnapshot, roomId: string): boolean {
  const hierarchy = deriveGraphHierarchy(snapshot.dungeon);
  const floorIds = hierarchy.floorIds;
  const roomFloorId = hierarchy.floorIdByRoomId[roomId] ?? floorIds[0];
  const floorNumber = floorIds.indexOf(roomFloorId) + 1;
  return isBossFloor(floorNumber);
}

/** `encounter/note-submit`. */
async function runNoteSubmit(
  deps: EncounterCommandDeps,
  payload: EncounterNoteSubmitPayload,
): Promise<EncounterCommandResult<EncounterNoteSubmitOutcome>> {
  const lookup = requireRoom(deps, payload.roomId);
  if (!lookup.ok) return lookup.result as EncounterCommandResult<EncounterNoteSubmitOutcome>;

  // Derived from the snapshot the note is about to be validated against, not from
  // the one that comes back. `submitNote` touches no edges, so the two agree in
  // the normal case; reading the pre-submit snapshot is the one that stays
  // truthful if a graph mutation lands while the write is in flight, because then
  // the reward is recorded against the generation it was actually validated in
  // and the learner's next clear is a *new* identity and is awarded again.
  const clearIdentity = deriveRoomClearIdentity({
    roomId: payload.roomId,
    dungeon: lookup.snapshot.dungeon,
  });

  // Not wrapped in a `try`: a failed write must reject here exactly as it did in
  // the modal, with the note already saved in memory.
  const result = await deps.subject.submitNote(
    payload.roomId,
    payload.noteText,
    payload.manualConfirmed,
  );

  if (!result.finalPass) {
    return {
      ok: true,
      value: {
        command: 'encounter/note-submit',
        roomId: payload.roomId,
        kind: 'draft',
        validation: result,
        artifactMarkdown: null,
        progression: null,
      },
    };
  }

  // `submitNote` generates the artifact inside its own clear branch and returns
  // it, so a `null` here means the store's wiring is broken. Reported as a
  // refusal rather than as a clear with no artifact, because "cleared" is the
  // one outcome a caller may not second-guess.
  if (result.artifactMarkdown === null) {
    return {
      ok: false,
      error: {
        code: 'INVALID_OPERATION',
        message: CLEAR_WITHOUT_ARTIFACT_MESSAGE,
        details: { roomId: payload.roomId },
      },
    };
  }

  // Badge progress, exactly as the modal computed it from its render-time
  // snapshot: the count of rooms that had already passed validation, plus this
  // one. See the module header on why this is not recomputed after the submit.
  const totalRooms = lookup.snapshot.dungeon.rooms.length;
  const clearedBefore = Object.values(lookup.snapshot.rooms).filter(
    (candidate) => candidate.validationState.finalPass,
  ).length;

  const reward = deps.progression.awardRoomClear({
    qualityBonus: result.qualityBonus,
    totalRooms,
    creatorMappedRooms: totalRooms,
    scribeClearedRooms: clearedBefore + 1,
    archaeologistFullReviewPasses: 0,
    isBossEncounter: isBossEncounterIn(lookup.snapshot, payload.roomId),
    clear: { roomId: payload.roomId, clearIdentity },
  });

  // After the reward, as in the modal. Idempotent in the store, so a suppressed
  // clear changes nothing here either.
  const badgeAwarded =
    result.wordCount >= NOTE_BADGE_WORD_COUNT
      ? deps.progression.awardBadge(SCRIBE_CENTURY_120_BADGE_ID)
      : false;

  return {
    ok: true,
    value: {
      command: 'encounter/note-submit',
      roomId: payload.roomId,
      kind: 'cleared',
      validation: result,
      artifactMarkdown: result.artifactMarkdown,
      progression: {
        roomId: payload.roomId,
        clearIdentity,
        awarded: reward.awarded,
        duplicate: reward.duplicate,
        xpGained: reward.xpGained,
        newRank: reward.newRank,
        rankChanged: reward.rankChanged,
        unlockedBadges: reward.unlockedBadges,
        loot: reward.loot,
        unlockedAchievements: reward.unlockedAchievements,
        badgeAwarded,
      },
    },
  };
}

/**
 * Artifact pickup, forwarded to the existing `artifact/collect` command.
 *
 * Not an `encounter/*` command, and not a second implementation. The pickup
 * already has a home - `studyFlowController.collectArtifact`, which builds the
 * journal entry and opens the journal - and plan exit criterion 5 is that
 * generation and pickup stay separate actions, which one command for each of them
 * guarantees. A sibling here would be a third thing to keep in step.
 */
async function runArtifactCollect(
  deps: EncounterCommandDeps,
  payload: ArtifactCollectCommand['payload'],
): Promise<EncounterCommandResult<EncounterArtifactCollectOutcome>> {
  await deps.artifactCollection.collectArtifact({ type: 'artifact/collect', payload });
  return {
    ok: true,
    value: { command: 'artifact/collect', roomId: payload.roomId, handedToWorldFlow: true },
  };
}

/** `encounter/attachment-add` and `encounter/attachment-add-external`. */
async function runAttachmentAdd<
  C extends 'encounter/attachment-add' | 'encounter/attachment-add-external',
>(
  command: C,
  deps: EncounterCommandDeps,
  roomId: string,
  attach: () => Promise<RoomAttachment | null>,
): Promise<EncounterResult<C>> {
  const lookup = requireRoom(deps, roomId);
  if (!lookup.ok) return lookup.result as EncounterResult<C>;

  const attachment = await attach();
  return { ok: true, value: { command, roomId, attachment } } as EncounterResult<C>;
}

/**
 * `encounter/attachment-remove`.
 *
 * The attachment is looked up *before* the port call, because the store's
 * `removeAttachment` resolves without doing anything when the room or the
 * attachment is absent. Pre-checking turns that silent no-op into a typed
 * refusal, which is what makes `EncounterAttachmentRemoveOutcome` honest: reaching
 * this outcome means something was removed.
 */
async function runAttachmentRemove(
  deps: EncounterCommandDeps,
  payload: EncounterAttachmentRemovePayload,
): Promise<EncounterCommandResult<EncounterAttachmentRemoveOutcome>> {
  const lookup = requireRoom(deps, payload.roomId);
  if (!lookup.ok) return lookup.result as EncounterCommandResult<EncounterAttachmentRemoveOutcome>;

  const known = lookup.room.attachments.some(
    (attachment) => attachment.attachmentId === payload.attachmentId,
  );
  if (!known) return roomNotFound(payload.attachmentId) as EncounterCommandResult<EncounterAttachmentRemoveOutcome>;

  await deps.subject.removeAttachment(payload.roomId, payload.attachmentId);
  return {
    ok: true,
    value: {
      command: 'encounter/attachment-remove',
      roomId: payload.roomId,
      attachmentId: payload.attachmentId,
    },
  };
}

// ── Controller ──────────────────────────────────────────────────────────────

/**
 * The Scribe encounter surface.
 *
 * Each method takes exactly the payload its command declares and returns exactly
 * that command's outcome - narrowed, with no cast at the call site.
 * {@link dispatch} accepts the tagged {@link EncounterCommand} union for callers
 * that hold a command as data.
 */
export interface EncounterController {
  /** `encounter/note-submit` - save a draft, or clear the encounter. */
  submitNote(payload: EncounterNoteSubmitPayload): Promise<EncounterResult<'encounter/note-submit'>>;
  /** Forward an artifact pickup to the world flow's `artifact/collect`. */
  artifactCollect(payload: ArtifactCollectCommand['payload']): Promise<EncounterArtifactCollectResult>;
  /** `encounter/attachment-add` - store picked bytes on this device. */
  addAttachment(
    payload: EncounterAttachmentAddPayload,
  ): Promise<EncounterResult<'encounter/attachment-add'>>;
  /** `encounter/attachment-add-external` - record an externally hosted image. */
  addExternalAttachment(
    payload: EncounterAttachmentAddExternalPayload,
  ): Promise<EncounterResult<'encounter/attachment-add-external'>>;
  /** `encounter/attachment-remove` - forget an attachment and its bytes. */
  removeAttachment(
    payload: EncounterAttachmentRemovePayload,
  ): Promise<EncounterResult<'encounter/attachment-remove'>>;
  /** Execute any Scribe encounter command held as a tagged value. */
  dispatch(command: EncounterCommand): Promise<EncounterCommandResult<EncounterOutcome>>;
}

/**
 * Build the Scribe encounter controller.
 *
 * @param deps Injected ports and clock. No defaults: the application layer must
 * not reach for a real store, a real `Date`, or a real `Math.random` on its own.
 */
export function createEncounterController(deps: EncounterCommandDeps): EncounterController {
  const submitNoteCommand = (payload: EncounterNoteSubmitPayload) => runNoteSubmit(deps, payload);
  const artifactCollectCommand = (payload: ArtifactCollectCommand['payload']) =>
    runArtifactCollect(deps, payload);
  const addAttachmentCommand = (payload: EncounterAttachmentAddPayload) =>
    runAttachmentAdd('encounter/attachment-add', deps, payload.roomId, () =>
      deps.subject.addDeviceLocalAttachment(payload.roomId, payload.file),
    );
  const addExternalAttachmentCommand = (payload: EncounterAttachmentAddExternalPayload) =>
    runAttachmentAdd('encounter/attachment-add-external', deps, payload.roomId, () =>
      deps.subject.addExternalAttachment(payload.roomId, payload.url),
    );
  const removeAttachmentCommand = (payload: EncounterAttachmentRemovePayload) =>
    runAttachmentRemove(deps, payload);

  return {
    submitNote: submitNoteCommand,
    artifactCollect: artifactCollectCommand,
    addAttachment: addAttachmentCommand,
    addExternalAttachment: addExternalAttachmentCommand,
    removeAttachment: removeAttachmentCommand,
    // Both entry points reach the same runner for each command, so `dispatch` and
    // the named methods cannot drift apart: one implementation per command, named
    // above the switch.
    dispatch: (command) => {
      switch (command.type) {
        case 'encounter/note-submit':
          return submitNoteCommand(command.payload);
        case 'encounter/attachment-add':
          return addAttachmentCommand(command.payload);
        case 'encounter/attachment-add-external':
          return addExternalAttachmentCommand(command.payload);
        case 'encounter/attachment-remove':
          return removeAttachmentCommand(command.payload);
        default: {
          // Structural exhaustiveness rather than an incidental one: adding an
          // `encounter/*` command to the payload map without a runner here fails
          // `npm run typecheck` at this line, instead of silently returning
          // `undefined` to a caller that awaited it.
          const unhandled: never = command;
          return unhandled;
        }
      }
    },
  };
}