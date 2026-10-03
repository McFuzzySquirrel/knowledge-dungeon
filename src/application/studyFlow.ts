/**
 * Shared renderer-neutral learning-flow controller.
 *
 * The learning loop that used to be inlined in `GameScreen` and `VillageScreen`
 * lives here: room-interaction dispatch, pending-review finalization, artifact
 * collection, portal floor changes, travel/teleport, returning to the village,
 * village structure routing, and entering/leaving fishing.
 *
 * This module is plain TypeScript. It imports no renderer, no React, no DOM
 * global, no store, and no UI component - every side effect is an injected
 * port. That keeps the flow deterministic and unit-testable, and it lets a
 * PixiJS host reuse exactly the same operations as the Phaser host.
 *
 * Guard conditions, call ordering, and message copy are preserved verbatim from
 * the screens this controller replaced.
 */
import { FLOOR_BIOME_IDS, type FloorBiomeId } from '@/core/biomes';
import {
  computeFloorVisibility,
  deriveGraphHierarchy,
  type FloorVisibility,
} from '@/core/graph';
import type { FishRarity } from '@/core/fishing/fishingTypes';
import { evaluatePhaseBadgeUnlocks } from '@/core/progression';
import {
  canReviewRoom,
  describeReviewRefusal,
  isReviewableRoom,
  type ReviewRoomRefusal,
} from '@/core/review';
import type { ReviewPassRewardIdentity } from '@/core/review/reviewPassRewards';
import {
  isInterruptedReviewSessionForRoom,
  readInterruptedReviewSessionFromFields,
  type InterruptedReviewSession,
  type InterruptedReviewSessionWrite,
} from '@/core/review/interruptedReviewSession';
import type { RankTier } from '@/core/progression/types';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import { createTutorialSubject, TUTORIAL_SUBJECT_ID } from '@/data/tutorialSubject';
import {
  VILLAGE_MAP,
  getDungeonPortalSlots,
  getFishingPondPortalMap,
  type VillageStructure,
} from '@/data/villageLayout';
import type { FloorTransitionDirection } from './contracts/events';
import type { FloorVisibilityModel, PlayerClassId } from './contracts/world';
import {
  createReviewController,
  CLOSED_WITHOUT_RATING_QUALITY,
  type ReviewCommandResult,
  type ReviewController,
  type ReviewOutcome,
} from './reviewCommands';
import { activateSubject } from './subjectActivation';

// ── Port value types ───────────────────────────────────────────────────────

/**
 * Learning phase, mirrored from the session store so the application layer
 * never imports it. `src/store/sessionStore.ts` asserts union parity at
 * compile time.
 */
export type StudyFlowPhase = 'creator' | 'scribe' | 'archaeologist';

/** Top-level screen, mirrored from the session store (parity asserted there). */
export type StudyFlowScreen = 'welcome' | 'village' | 'game';

/** Quest step, mirrored from the session store (parity asserted there). */
export type StudyFlowQuestStep =
  | 'intro'
  | 'meet-keeper'
  | 'create-subject'
  | 'visit-training'
  | 'pick-archetype'
  | 'enter-dungeon'
  | 'clear-room'
  | 'write-note'
  | 'review-artifact'
  | 'complete';

/** Room-panel tab names the flow can request. */
export type StudyFlowRoomTab = 'topic' | 'notes' | 'images' | 'artifact' | 'selfcheck';
/** Toast severity levels the flow can raise. */
export type StudyFlowToastLevel = 'info' | 'warn' | 'error';

/** A village subject summary, used for portal slots and the fishing gate. */
export interface StudyFlowVillageSubject {
  id: string;
  subjectName: string;
  roomCount: number;
  clearedRoomCount: number;
}

/** A fish the fishing world just caught. */
export interface StudyFlowFishCaught {
  fishName: string;
  rarity: FishRarity;
  catalogId: string;
  description: string;
}

/** Village info panel kinds, mirrored from the village screen. */
export type StudyFlowVillagePanelType =
  | 'dungeon'
  | 'keeper'
  | 'guild'
  | 'training'
  | 'trophy'
  | 'signpost'
  | 'waysign'
  | 'quest-board'
  | 'library'
  | 'workshop'
  | 'fountain'
  | 'fishing-pond'
  | 'fish-stand';

/** Request to show a village info panel. */
export interface StudyFlowVillageInfoPanel {
  type: StudyFlowVillagePanelType;
  structureId: string;
  subject?: StudyFlowVillageSubject;
}

/** Renderer capability port used by the dungeon world. */
export interface StudyFlowRendererPort {
  setFloorVisibility(visibility: FloorVisibilityModel): void;
  teleportToRoom(roomId: string): void;
}

/** Cooldown bookkeeping for the map-view teleport action. */
export interface StudyFlowTeleportPort {
  /** Milliseconds still blocked; `0` when the teleport is available. */
  remainingMs(): number;
  /** Record that a teleport was consumed at `at` (epoch ms). */
  markConsumed(at: number): void;
}

/** Village/fishing world switching. */
export interface StudyFlowFishingHost {
  /**
   * Whether a world host is mounted and able to start the fishing world.
   *
   * `enterFishing` checks this *before* clearing any village UI state, because
   * the original village screen returned before touching state when no host was
   * mounted. Clearing the panels when there is nowhere to enter fishing is a
   * user-visible change, so the application layer must not reorder it.
   */
  isMounted(): boolean;
  /**
   * Start the fishing world. Implementations must also no-op while no world
   * host is mounted, so the application layer and the renderer agree on the
   * guard independently.
   */
  enter(input: {
    pondId: string;
    playerClass: string;
    hasClearedRooms: boolean;
    onFishCaught: (data: StudyFlowFishCaught) => void;
    onReturnToVillage: () => void;
    onReady: () => void;
  }): void;
  /** Stop the fishing world and wake the village again. */
  exit(): void;
}

/** App-owned state and store writers the dungeon flow needs. */
export interface StudyFlowStorePort {
  /** Live subject snapshot, or null when nothing is loaded. */
  getSnapshot(): SubjectSnapshot | null;
  /** Live learning phase. */
  getPhase(): StudyFlowPhase;
  /** Persist (or clear) the active subject id in app-owned storage. */
  persistActiveSubjectId(subjectId: string | null): void;

  // ── Session store ──
  setFocusedRoomId(roomId: string | null): void;
  setActiveSubjectId(subjectId: string | null): void;
  setActiveScreen(screen: StudyFlowScreen): void;
  openNoteEditor(roomId: string): void;
  closeMapView(): void;
  cancelTeleportMode(): void;
  setMobileHudOpen(open: boolean): void;

  // ── Progression store ──
  setProgressionActiveSubject(subjectId: string | null): void;
  collectArtifactNote(entry: {
    dungeonId: string;
    roomId: string;
    topic: string;
    floorLabel: string;
    artifactPreview: string;
    noteMarkdown: string;
    artifactMarkdown: string;
  }): boolean;
  /**
   * Award a review pass.
   *
   * Phase 16: `review` is what makes the award durable, and it is supplied by the
   * review command layer. It is **optional** so the pre-Phase-16 lane - the
   * Phase 15 rollback, and `villageStudyFlow`'s binding - keeps working unchanged.
   * `awarded` and `duplicate` are optional for the same reason: a host that binds
   * the old lane does not report them, and the flow derives the answer from the one
   * number that lane does report.
   */
  awardReviewPass(review?: ReviewPassRewardIdentity): {
    xpGained: number;
    awarded?: boolean;
    duplicate?: boolean;
  };
  awardBadge(badgeId: string): void;
  readProgressionBadges(): readonly string[];

  // ── Subject store ──
  /**
   * Record a review pass and advance SM-2.
   *
   * Phase 16: `qualityRating` is now reachable. It was declared one-argument here,
   * which is why `subjectStore.recordReviewPass`'s `qualityRating ?? 3` default was
   * the only rating the application ever supplied.
   */
  recordReviewPass(roomId: string, qualityRating?: number): Promise<void>;

  // ── Progression store, Phase 16 marker ──
  //
  // Optional, and optional *because* the marker is optional infrastructure: a host
  // that does not bind them keeps the pre-Phase-16 in-memory review behaviour and
  // loses the interrupted session on exit, exactly as it did before. Both real
  // hosts are expected to bind them; `GameScreen` does, and `villageStudyFlow` is
  // recorded as the follow-up because it binds a dungeon UI that never dispatches
  // review finalization.
  readProgressionPreservedFields?(): Record<string, unknown> | undefined;
  writeReviewSession?(write: InterruptedReviewSessionWrite): void;
}

/** Dungeon-world UI sinks. */
export interface StudyFlowDungeonUiPort {
  /** Push a toast. */
  pushToast(level: StudyFlowToastLevel, message: string): void;
  /** Ask the room panel to show a specific tab. */
  requestRoomPanelTab(tab: StudyFlowRoomTab): void;
  /** Open or close the room info panel. */
  setInfoPanelOpen(open: boolean): void;
  /** Whether the room info panel is currently open. */
  isInfoPanelOpen(): boolean;
  /** Dismiss the in-world NPC dialog when a room interaction starts. */
  clearNpcDialog(): void;
  /** Show a freshly collected artifact in the journal. */
  openJournalForCollectedNote(noteId: string): void;
  /** Floor the scene is rendering; `null` until the first floor is known. */
  getCurrentFloorId(): string | null;
  /** Record the floor the scene should now render. */
  setCurrentFloorId(floorId: string): void;
}

/** Village-world UI sinks. */
export interface StudyFlowVillageUiPort {
  setInfoPanel(panel: StudyFlowVillageInfoPanel | null): void;
  setWelcomeMessage(message: string | null): void;
  setCreateOpen(open: boolean): void;
  setMakeItYoursOpen(open: boolean): void;
  setShowStats(open: boolean): void;
  setFishCaught(data: StudyFlowFishCaught | null): void;
  /**
   * Close the info panel and the catch/recall dialogs before a new fishing
   * session starts.
   */
  prepareFishingSession(): void;
}

/** Village content the flow needs in order to resolve a structure id. */
export interface StudyFlowVillageContentPort {
  /** Portal structures derived from the current subject list. */
  getDynamicStructures(): readonly VillageStructure[];
}

/** Store writers the village flow needs to activate a subject or open a panel. */
export interface StudyFlowVillageStorePort {
  /** Live study archetype, or null when none is selected. */
  getSelectedClass(): PlayerClassId | null;
  /** Subjects currently listed in the village, in portal-slot order. */
  getVillageSubjects(): readonly StudyFlowVillageSubject[];

  loadSubject(subjectId: string): Promise<SubjectSnapshot | null>;
  importSubjectSnapshot(snapshot: SubjectSnapshot): Promise<void>;
  setActiveSubjectId(subjectId: string | null): void;
  setProgressionActiveSubject(subjectId: string | null): void;
  setActiveScreen(screen: StudyFlowScreen): void;
  setPhase(phase: StudyFlowPhase): void;
  setSelectedClass(playerClass: PlayerClassId | null): void;
  setQuestStep(step: StudyFlowQuestStep): void;
  advanceQuestStep(): void;
}

/** Every village-world port, required only by hosts that present the village. */
export interface StudyFlowVillagePorts {
  content: StudyFlowVillageContentPort;
  store: StudyFlowVillageStorePort;
  ui: StudyFlowVillageUiPort;
  fishing: StudyFlowFishingHost;
}

/** Every dependency of {@link createStudyFlowController}. */
export interface StudyFlowDeps {
  store: StudyFlowStorePort;
  renderer: StudyFlowRendererPort;
  teleport: StudyFlowTeleportPort;
  dungeonUi: StudyFlowDungeonUiPort;
  /** Omitted by hosts that only present the dungeon world. */
  village?: StudyFlowVillagePorts;
}

// ── Operations ─────────────────────────────────────────────────────────────

/** Operations the shared flow exposes to a host. */
export interface StudyFlowController {
  /** `dungeon:interact` / `room/interact` dispatch. */
  roomInteract(roomId: string): void;
  /** Close the room info panel, finalizing a deferred review first. */
  closeInfoPanel(): void;
  /** Toggle the room info panel, closing it through `closeInfoPanel`. */
  toggleInfoPanel(): void;
  /** Finalize the deferred archaeologist review for a room. */
  finalizePendingReview(roomId: string): void;
  /**
   * Phase 16: the durable interrupted-review session, or `null` when there is
   * none.
   *
   * A surface calls this to offer "resume" before it offers anything else, and it
   * is what makes the marker observable: the marker is durable, but a durable fact
   * nobody can read is not a feature.
   */
  readPendingReviewSession(): InterruptedReviewSession | null;
  /**
   * Phase 16: re-enter an interrupted review, reporting whether one existed.
   *
   * Read-only. Re-arming is idempotent for the same room, so a resume that the
   * learner then abandons leaves the marker it found rather than losing it.
   */
  resumePendingReview(roomId: string): boolean;
  /**
   * Phase 16: abandon an interrupted review. Awards nothing and writes no SM-2
   * state; returns whether there was anything to discard.
   */
  discardPendingReview(roomId: string): boolean;
  /** `dungeon:artifact-collected` / `artifact/collect`. */
  collectArtifact(roomId: string): void;
  /** `dungeon:floor-transition` / `floor/change`. */
  changeFloor(fromRoomId: string, direction: FloorTransitionDirection): void;
  /** `floor/travel` - travel to a room, switching floors when required. */
  travelToRoom(roomId: string): void;
  /** Cooldown-gated teleport used by the map view. */
  teleportToRoom(roomId: string): void;
  /** `village/return` - leave the dungeon. */
  returnToVillage(): void;
  /** `village:structure-approached` dispatch. */
  structureApproached(structureId: string): void;
  /** `village:structure-left` dispatch. */
  structureLeft(structureId: string): void;
  /** `village:structure-interact` / `structure/interact` dispatch. */
  structureInteract(structureId: string): void;
  /** `fishing/enter` - start fishing at a pond. */
  enterFishing(pondId: string): void;
  /** `fishing/exit` - return from the fishing world to the village. */
  exitFishing(): void;
  /** Read the floor the dungeon renderer is currently showing. */
  getCurrentFloorId(): string | null;
  /**
   * Renderer-neutral floor-visibility model for a snapshot floor, used when a
   * dungeon world is first mounted.
   */
  buildFloorVisibilityModel(snapshot: SubjectSnapshot, floorId: string): FloorVisibilityModel;
}

/** Resolve the biome a floor renders with, or undefined for the default. */
export function resolveSubjectFloorBiome(
  biome: string | null | undefined,
): FloorBiomeId | undefined {
  return biome && FLOOR_BIOME_IDS.includes(biome as FloorBiomeId)
    ? (biome as FloorBiomeId)
    : undefined;
}

/** Convert the navigation `FloorVisibility` sets into the neutral model. */
export function toFloorVisibilityModel(
  visibility: FloorVisibility,
  biomeId: FloorBiomeId | undefined,
): FloorVisibilityModel {
  return {
    floorId: visibility.floorId,
    visibleRoomIds: [...visibility.visibleRoomIds],
    portalUpRoomId: visibility.portalUpRoomId,
    portalDownRoomIds: [...visibility.portalDownRoomIds],
    biomeId,
  };
}

const WELCOME_MESSAGE_SIGN_ENTRANCE =
  'Welcome to the Dungeon Village! Explore the buildings, meet the Keeper, and step through a portal to begin your studies.';

/**
 * Build the shared learning-flow controller.
 *
 * @param deps Injected store, renderer, and UI ports.
 */
export function createStudyFlowController(deps: StudyFlowDeps): StudyFlowController {
  const { store, renderer, teleport, dungeonUi, village } = deps;
  const villageStore = village?.store ?? null;
  const villageUi = village?.ui ?? null;
  const fishing = village?.fishing ?? null;

  // Deferred archaeologist review: a cleared room remembers that its panel was
  // opened so closing the panel records the review pass exactly once.
  //
  // Phase 16: this is now the *in-memory* arm only. The durable copy of the same
  // fact is the interrupted-review marker in the progression record, so a review
  // survives a reload and a walk out of the dungeon - see
  // `src/core/review/interruptedReviewSession.ts` for where it lives and why.
  //
  // It is deliberately **not** what `finalizePendingReview` decides on: a learner who
  // completes the pass from the workspace finishes the review without this ever being
  // cleared, so on its own it cannot answer "is there still a review here". The marker
  // can, and does - see that function's doc comment.
  let pendingReviewRoomId: string | null = null;

  /**
   * The review command layer, bound to this flow's store port.
   *
   * Built here rather than injected so `finalizePendingReview` and
   * `roomInteract` go through exactly the same implementation the Phase 16
   * workspace reaches through `src/store/reviewCommands.ts`, and so the flow has no
   * second path to the reward.
   *
   * The subject port's split is the documented backwards-compatibility carve-out:
   * the panel-close route is the *implicit* finalization, the learner never
   * answered a rating question, so it stands in
   * `CLOSED_WITHOUT_RATING_QUALITY` and takes the one-argument store call that
   * `tests/contracts/phase-2-study-flow.test.ts` and
   * `tests/unit/GameScreen.npcDialog.test.tsx` pin. Both branches reach the same
   * `subjectStore.recordReviewPass`, and for the same rating number they compute
   * the identical SM-2 update.
   *
   * `awarded` / `duplicate` are derived when the bound action does not report them,
   * because a host on the pre-Phase-16 lane reports only `xpGained` - and
   * `xpGained > 0` is that lane's own definition of "awarded".
   */
  const review: ReviewController = createReviewController({
    subject: {
      readSnapshot: () => store.getSnapshot(),
      recordReviewPass: (reviewRoomId, qualityRating) =>
        qualityRating === CLOSED_WITHOUT_RATING_QUALITY
          ? store.recordReviewPass(reviewRoomId)
          : store.recordReviewPass(reviewRoomId, qualityRating),
    },
    progression: {
      awardReviewPass: (reviewIdentity) => {
        const reward = store.awardReviewPass(reviewIdentity);
        return {
          xpGained: reward.xpGained,
          newRank: 'Novice' as RankTier,
          rankChanged: false,
          unlockedAchievements: [],
          awarded: reward.awarded ?? reward.xpGained > 0,
          duplicate: reward.duplicate ?? false,
        };
      },
      readPreservedFields: () => store.readProgressionPreservedFields?.(),
      writeReviewSession: (write) => store.writeReviewSession?.(write),
    },
    nowIso: () => new Date().toISOString(),
  });

  /** Whether this flow's host bound the durable marker store. */
  const reviewSessionDurable = (): boolean => typeof store.writeReviewSession === 'function';

  function findVillageStructure(structureId: string): VillageStructure | undefined {
    return [...VILLAGE_MAP.structures, ...(village?.content.getDynamicStructures() ?? [])].find(
      (structure) => structure.id === structureId,
    );
  }

  function activationDeps() {
    return {
      loadSubject: (subjectId: string) => villageStore?.loadSubject(subjectId) ?? Promise.resolve(null),
      setSessionActiveSubjectId: (subjectId: string | null) =>
        villageStore?.setActiveSubjectId(subjectId),
      setProgressionActiveSubject: (subjectId: string | null) =>
        villageStore?.setProgressionActiveSubject(subjectId),
    };
  }

  /**
   * The pass toast, after a completed review.
   *
   * The message is the pre-Phase-16 string, character for character:
   * `tests/contracts/phase-2-study-flow.test.ts` pins it verbatim and it is what a
   * learner has always read. The numbers come from the command's *post*-increment
   * pass progress rather than from a re-read, because the SM-2 write is
   * asynchronous and a re-read would be one review stale - which is exactly the
   * drift `archaeologistFullReviewPasses` must not have, since it is a badge
   * input.
   */
  function pushReviewRecordedToast(outcome: Extract<ReviewOutcome, { command: 'review/pass-complete' }>): void {
    const xpMessage =
      outcome.progression.xpGained > 0
        ? ` (+${outcome.progression.xpGained} XP)`
        : ' (already counted for this pass)';
    dungeonUi.pushToast(
      'info',
      `Review recorded${xpMessage}: ${outcome.passProgress.roomsTowardNextPass}/${outcome.passProgress.totalRooms} rooms toward pass ${outcome.passProgress.nextPassTarget}. Completed full passes: ${outcome.passProgress.fullReviewPasses}.`,
    );
  }

  /** The refusal sentence for a room that cannot be reviewed. */
  function pushReviewRefusedToast(reason: ReviewRoomRefusal, unlock: ReturnType<typeof canReviewRoom>['unlock']): void {
    dungeonUi.pushToast('warn', describeReviewRefusal({ reason, unlock }));
  }

  /**
   * Report a typed review refusal as a learner-facing sentence.
   *
   * `NO_ACTIVE_SUBJECT` and `ROOM_NOT_FOUND` are silent, exactly as
   * `finalizePendingReview` has always been: a caller can ask about a room that was
   * removed between two renders, and toasting about it would be noise. The two
   * Phase 16 conditions are learner-facing, because they are the ones a learner
   * caused by walking into a cleared room while the phase was still locked.
   */
  function reportReviewRefusal(
    result: ReviewCommandResult<ReviewOutcome>,
    fallback: { reason: ReviewRoomRefusal; unlock: ReturnType<typeof canReviewRoom>['unlock'] } | null,
  ): void {
    if (result.ok) return;
    if (result.error.code === 'ROOM_NOT_REVIEWABLE' || result.error.code === 'REVIEW_LOCKED') {
      dungeonUi.pushToast('warn', result.error.message);
      return;
    }
    if (fallback !== null) {
      pushReviewRefusedToast(fallback.reason, fallback.unlock);
    }
  }

  /**
   * Finalize the review the panel-close route armed, for one room.
   *
   * ## The rating passed here is **not** the learner's, and this is deliberate
   *
   * Read this before assuming the workspace's rating reaches SM-2 through this
   * route. It does not. This function passes
   * {@link CLOSED_WITHOUT_RATING_QUALITY} - a real `3` - **unconditionally**, so a
   * learner who rated a room `5` in the workspace and then closed the panel is
   * recorded as a `3`. The full argument for keeping it that way, and its cost, is
   * on the constant in `reviewCommands.ts`; the short version is that this route
   * has to work with no rating control on screen at all (the rollback lane renders
   * the pre-Phase-16 notes tab, which has none) and the drift is toward *more*
   * review rather than less.
   *
   * ## The durable marker is what says this review is still pending
   *
   * The workspace gives a learner two ways to finish the same review: "Complete
   * this review pass" (the command layer, at their rating) and "Done reviewing"
   * (this route, at {@link CLOSED_WITHOUT_RATING_QUALITY}). Both can be pressed, in
   * that order, on the same panel. So the in-memory `pendingReviewRoomId` arm is
   * **not** sufficient evidence that there is anything to finalize - the explicit
   * completion never touches it, because the workspace dispatches a command and
   * does not know a flow exists.
   *
   * The marker is. `armPendingReview` writes it in the same call that sets the arm,
   * and both `progressionStore.awardReviewPass` and `review/session-discard` clear it
   * for the room they finish, in the same record write as their own decision. So on
   * a durable host, **no marker for this room is the fact that the review is
   * already finished or explicitly abandoned**, and this function returns.
   *
   * Without that guard the flow pays twice for one room. `currentReviewPassNumber`
   * is `fullReviewPasses + 1`, and `fullReviewPasses` is
   * `trunc(sum of reviewPassCount / reviewable rooms)`, so the pass number moves only
   * when a review crosses a multiple of the room count. Reviewing the same room
   * twice re-derives the *same* pass, the (room, pass) ledger reports
   * `duplicate: true`, and nothing is paid. But when the explicit completion was the
   * room that **completed** the pass, the sum crossed the multiple, this function
   * re-derives pass N+1, and the ledger has never seen N+1 - from its side that is a
   * genuinely new pass, so it awards. The marker guard is what covers the case the
   * ledger structurally cannot see; the ledger remains what covers the rest.
   *
   * ## Why the guard is on the marker and not on the arm
   *
   * The marker is durable and the arm is a closure variable, so they do not have the
   * same reach:
   *
   * - The arm exists only inside one controller instance and only until one of its
   *   own routes clears it. The marker survives a reload, so guarding on it holds
   *   across every way a review can be finished - including from a surface that has
   *   no way to reach the flow at all.
   * - Every route that finishes a review already invalidates the marker as a side
   *   effect of its own correct write. Invalidating the *arm* instead would mean
   *   adding a callback the workspace must make before it can complete a review -
   *   new public API on the controller, and a UI -> flow coupling that reintroduces
   *   exactly the knowledge of flow internals the command layer exists to remove.
   * - The arm is a cache of the marker, written in the same call. On a durable host
   *   an arm implies a marker; a marker does not imply an arm. So guarding on the
   *   marker is never the weaker of the two.
   *
   * A host that did not bind the marker ports has no marker to consult, so
   * `reviewSessionDurable()` gates the guard and that lane keeps its pre-Phase-16
   * in-memory behaviour exactly.
   */
  function finalizePendingReview(roomId: string): void {
    const liveSnapshot = store.getSnapshot();
    if (!liveSnapshot) return;

    const room = liveSnapshot.rooms[roomId];
    if (!room || !room.validationState.finalPass) return;

    // Nothing to finalize. Read *before* the unlock check, because a review that is
    // already finished is not a refusal and must not be reported as one.
    if (
      reviewSessionDurable() &&
      !isInterruptedReviewSessionForRoom(readPendingReviewSession(), roomId)
    ) {
      return;
    }

    // The shared unlock evaluation, asked the same way `RoomPanel` asks it. A
    // review is not finalized for a room the panel is simultaneously saying is
    // locked, so the displayed unlock and the enforced unlock cannot diverge.
    const permission = canReviewRoom({
      dungeon: liveSnapshot.dungeon,
      rooms: liveSnapshot.rooms,
      roomId,
    });
    if (!permission.allowed) {
      pushReviewRefusedToast(permission.reason, permission.unlock);
      return;
    }

    // `review/pass-complete`, not a hand-rolled pair of store calls. The identity
    // is derived inside the command layer from the same pre-increment pass number
    // the badge thresholds read, and it is what makes this award durable.
    //
    // Unconditional, and it overrides any rating chosen in the workspace - see this
    // function's doc comment above before changing it.
    const result = review.passComplete({ roomId, qualityRating: CLOSED_WITHOUT_RATING_QUALITY });
    if (!result.ok) {
      reportReviewRefusal(result, null);
      return;
    }
    const outcome = result.value;

    // The number `evaluatePhaseBadgeUnlocks` has always been given here: the count
    // of currently reviewable rooms for `scribeClearedRooms`, and the *real*
    // post-review `fullReviewPasses` for `archaeologistFullReviewPasses`. Both are
    // unchanged; the second now comes from the one pass-progress derivation rather
    // than from a local copy of the analytics the command layer already ran.
    const reviewableRoomIds = liveSnapshot.dungeon.rooms
      .map((summary) => summary.roomId)
      .filter((candidateRoomId) => {
        const candidate = liveSnapshot.rooms[candidateRoomId];
        return candidate ? isReviewableRoom(candidate) : false;
      });
    const unlockedBadges = evaluatePhaseBadgeUnlocks(
      {
        totalRooms: liveSnapshot.dungeon.rooms.length,
        creatorMappedRooms: liveSnapshot.dungeon.rooms.length,
        scribeClearedRooms: reviewableRoomIds.length,
        archaeologistFullReviewPasses: outcome.passProgress.fullReviewPasses,
      },
      store.readProgressionBadges(),
    );
    if (unlockedBadges.length > 0) {
      unlockedBadges.forEach((badgeId) => {
        store.awardBadge(badgeId);
      });
      dungeonUi.pushToast(
        'info',
        `Archaeologist badge unlocked: ${unlockedBadges.join(', ')}`,
      );
    }

    pushReviewRecordedToast(outcome);
  }

  function readPendingReviewSession(): InterruptedReviewSession | null {
    return readInterruptedReviewSessionFromFields(store.readProgressionPreservedFields?.());
  }

  function resumePendingReview(roomId: string): boolean {
    const resumed = review.sessionResume({ roomId });
    if (!resumed.ok) {
      reportReviewRefusal(resumed, null);
      return false;
    }
    if (resumed.value.resumed) armPendingReview(roomId);
    return resumed.value.resumed;
  }

  function discardPendingReview(roomId: string): boolean {
    const discarded = review.sessionDiscard({ roomId });
    if (!discarded.ok) {
      reportReviewRefusal(discarded, null);
      return false;
    }
    if (discarded.value.discarded && pendingReviewRoomId === roomId) {
      pendingReviewRoomId = null;
    }
    return discarded.value.discarded;
  }

  /**
   * Arm a review for a room whose panel is opening, and make it resumable.
   *
   * `review/session-save` with no rating is the arming write: it records a marker
   * and nothing else, so opening a cleared room's panel is what makes the session
   * survive a reload, and closing the panel clears the marker in the same record
   * write as the award. Saving the same room twice keeps the original
   * `startedAt`, so this is idempotent rather than a new session each time.
   */
  function armPendingReview(roomId: string): void {
    pendingReviewRoomId = roomId;
    if (!reviewSessionDurable()) return;
    const saved = review.sessionSave({ roomId, qualityRating: null });
    if (!saved.ok) reportReviewRefusal(saved, null);
  }

  function roomInteract(roomId: string): void {
    store.setMobileHudOpen(false);
    dungeonUi.clearNpcDialog();
    store.setFocusedRoomId(roomId);
    pendingReviewRoomId = null;

    const phase = store.getPhase();
    if (phase === 'creator') {
      dungeonUi.requestRoomPanelTab('topic');
      dungeonUi.setInfoPanelOpen(true);
      return;
    }

    if (phase === 'scribe') {
      store.openNoteEditor(roomId);
      return;
    }

    const liveSnapshot = store.getSnapshot();

    // Phase 16: the unlock is enforced here, where the review is armed, using the
    // one shared evaluation `RoomPanel` renders. The panel still opens - a learner
    // must be able to read their own notes and artifact - but a locked room does
    // not arm a review, and the learner is told why in a sentence rather than
    // getting a silent no-op when they close the panel.
    if (liveSnapshot) {
      const room = liveSnapshot.rooms[roomId];
      if (room && room.validationState.finalPass) {
        const permission = canReviewRoom({
          dungeon: liveSnapshot.dungeon,
          rooms: liveSnapshot.rooms,
          roomId,
        });
        if (permission.allowed) {
          armPendingReview(roomId);
        } else {
          pushReviewRefusedToast(permission.reason, permission.unlock);
        }
      }
    }

    dungeonUi.requestRoomPanelTab('notes');
    dungeonUi.setInfoPanelOpen(true);
  }

  function closeInfoPanel(): void {
    dungeonUi.setInfoPanelOpen(false);
    if (store.getPhase() === 'archaeologist' && pendingReviewRoomId) {
      finalizePendingReview(pendingReviewRoomId);
    }
    pendingReviewRoomId = null;
  }

  function toggleInfoPanel(): void {
    if (dungeonUi.isInfoPanelOpen()) {
      closeInfoPanel();
      return;
    }
    dungeonUi.setInfoPanelOpen(true);
  }

  function collectArtifact(roomId: string): void {
    const liveSnapshot = store.getSnapshot();
    if (!liveSnapshot) return;
    const room = liveSnapshot.rooms[roomId];
    if (!room?.artifactMarkdown) return;

    const liveHierarchy = deriveGraphHierarchy(liveSnapshot.dungeon);
    const floorId = liveHierarchy.floorIdByRoomId[roomId] ?? liveSnapshot.dungeon.rootRoomId;
    const floorLabel = liveHierarchy.floorLabelByFloorId[floorId] ?? liveSnapshot.dungeon.subjectName;
    const previewSource = room.noteText.trim().length > 0 ? room.noteText : room.artifactMarkdown;
    const preview = previewSource
      .replace(/^#\s+.*$/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

    const collected = store.collectArtifactNote({
      dungeonId: liveSnapshot.dungeon.dungeonId,
      roomId,
      topic: room.topic,
      floorLabel,
      artifactPreview: preview,
      noteMarkdown: room.noteText.trim().length > 0 ? room.noteText : room.artifactMarkdown,
      artifactMarkdown: room.artifactMarkdown,
    });

    if (collected) {
      dungeonUi.openJournalForCollectedNote(`${liveSnapshot.dungeon.dungeonId}:${roomId}`);
    }
  }

  function applyFloorVisibility(snapshot: SubjectSnapshot, floorId: string): void {
    const hierarchy = deriveGraphHierarchy(snapshot.dungeon);
    const nextVisibility = computeFloorVisibility(hierarchy, snapshot.dungeon, floorId);
    renderer.setFloorVisibility(
      toFloorVisibilityModel(nextVisibility, resolveSubjectFloorBiome(snapshot.dungeon.biome)),
    );
  }

  function syncFloorForRoom(roomId: string): void {
    const liveSnapshot = store.getSnapshot();
    if (!liveSnapshot) return;
    const hierarchy = deriveGraphHierarchy(liveSnapshot.dungeon);
    const targetFloorId =
      hierarchy.floorIdByRoomId[roomId] ?? liveSnapshot.dungeon.rootRoomId;
    if (targetFloorId === dungeonUi.getCurrentFloorId()) return;
    dungeonUi.setCurrentFloorId(targetFloorId);
    applyFloorVisibility(liveSnapshot, targetFloorId);
  }

  function changeFloor(fromRoomId: string, direction: FloorTransitionDirection): void {
    const liveSnapshot = store.getSnapshot();
    if (!liveSnapshot) return;
    const liveHierarchy = deriveGraphHierarchy(liveSnapshot.dungeon);
    // For both directions the destination room is the very portal the
    // player is standing on - we just swap which floor is "active" so
    // that room's neighbors become visible.
    const destinationFloorId =
      direction === 'up'
        ? liveHierarchy.floorIdByRoomId[fromRoomId] ?? liveSnapshot.dungeon.rootRoomId
        : liveHierarchy.floorIdByRoomId[fromRoomId] ?? fromRoomId;
    dungeonUi.setCurrentFloorId(destinationFloorId);
    applyFloorVisibility(liveSnapshot, destinationFloorId);
    renderer.teleportToRoom(fromRoomId);
  }

  function travelToRoom(roomId: string): void {
    syncFloorForRoom(roomId);
    renderer.teleportToRoom(roomId);
  }

  function teleportToRoom(roomId: string): void {
    if (teleport.remainingMs() > 0) return;
    travelToRoom(roomId);
    const now = Date.now();
    teleport.markConsumed(now);
    store.closeMapView();
  }

  function returnToVillage(): void {
    store.closeMapView();
    // Phase 16: leaving with a review open is a **decision**, not a silent drop.
    // The default is to SAVE - keep the marker so the review is resumable - because
    // save is the only branch that cannot lose committed work, and
    // `review/session-discard` is available to the surface that wants to offer the
    // other two choices. The marker was already written when the review was armed,
    // so this is a re-save: it refreshes `savedAt` and makes the choice durable
    // even if arming happened on a host without the marker port.
    if (pendingReviewRoomId !== null) {
      const openRoomId = pendingReviewRoomId;
      if (reviewSessionDurable()) {
        const saved = review.sessionSave({ roomId: openRoomId, qualityRating: null });
        if (saved.ok) {
          dungeonUi.pushToast(
            'info',
            'Review saved. Return to this room to finish it, or discard it from the room panel.',
          );
        }
      }
    }
    pendingReviewRoomId = null;
    store.setFocusedRoomId(null);
    store.setActiveSubjectId(null);
    store.persistActiveSubjectId(null);
    store.cancelTeleportMode();
    store.setProgressionActiveSubject(null);
    store.setActiveScreen('village');
  }

  function structureApproached(structureId: string): void {
    if (!villageStore || !villageUi) return;
    const struct = findVillageStructure(structureId);
    if (!struct) return;
    const sType = struct.type;
    if (sType === 'portal-icon') {
      const subj = villageStore
        .getVillageSubjects()
        .find((subject) => subject.id === struct.subjectId);
      villageUi.setInfoPanel({ type: 'dungeon', structureId, subject: subj });
    } else if (sType === 'keeper-tower') {
      villageUi.setInfoPanel({ type: 'quest-board', structureId });
    } else if (sType === 'guild-hall') {
      villageUi.setInfoPanel({ type: 'guild', structureId });
    } else if (sType === 'training-gate') {
      villageUi.setInfoPanel({ type: 'training', structureId });
    } else if (sType === 'trophy-hall') {
      villageUi.setInfoPanel({ type: 'trophy', structureId });
    } else if (sType === 'signpost' || sType === 'waysign') {
      villageUi.setInfoPanel({ type: 'signpost', structureId });
      if (structureId === 'sign-entrance') {
        villageUi.setWelcomeMessage(WELCOME_MESSAGE_SIGN_ENTRANCE);
      }
    } else if (sType === 'library') {
      villageUi.setInfoPanel({ type: 'library', structureId });
    } else if (sType === 'workshop') {
      villageUi.setInfoPanel({ type: 'workshop', structureId });
    } else if (sType === 'fountain') {
      villageUi.setInfoPanel({ type: 'fountain', structureId });
    } else if (sType === 'fishing-pond') {
      villageUi.setInfoPanel({ type: 'fishing-pond', structureId });
    } else if (sType === 'fish-stand') {
      villageUi.setInfoPanel({ type: 'fish-stand', structureId });
    }
  }

  function structureLeft(structureId: string): void {
    if (!villageUi) return;
    villageUi.setInfoPanel(null);
    if (structureId === 'sign-entrance') {
      villageUi.setWelcomeMessage(null);
    }
  }

  function structureInteract(structureId: string): void {
    if (!villageStore || !villageUi) return;
    const struct = findVillageStructure(structureId);
    if (!struct) return;
    const sType = struct.type;
    if (sType === 'portal-icon' && struct.subjectId) {
      const subjectId = struct.subjectId;
      villageStore.setPhase('scribe');
      villageStore.setSelectedClass(villageStore.getSelectedClass() || 'scholar');
      void activateSubject(subjectId, activationDeps()).then((result) => {
        if (result.activated) {
          villageStore.setActiveScreen('game');
        }
      });
    } else if (sType === 'keeper-tower') {
      villageUi.setInfoPanel({ type: 'quest-board', structureId });
    } else if (sType === 'guild-hall') {
      villageUi.setCreateOpen(true);
      villageStore.advanceQuestStep();
    } else if (sType === 'training-gate') {
      const tutorial = createTutorialSubject();
      void villageStore.importSubjectSnapshot(tutorial).then(() => {
        villageStore.setPhase('scribe');
        villageStore.setSelectedClass('scholar');
        villageStore.setQuestStep('enter-dungeon');
        return activateSubject(TUTORIAL_SUBJECT_ID, activationDeps()).then((result) => {
          if (result.activated) {
            villageStore.setActiveScreen('game');
          }
        });
      });
    } else if (sType === 'trophy-hall') {
      villageUi.setInfoPanel({ type: 'trophy', structureId });
    } else if (sType === 'signpost' || sType === 'waysign') {
      villageUi.setInfoPanel({ type: 'signpost', structureId });
    } else if (sType === 'library') {
      villageUi.setInfoPanel({ type: 'library', structureId });
    } else if (sType === 'workshop') {
      villageUi.setMakeItYoursOpen(true);
    } else if (sType === 'fountain') {
      villageUi.setShowStats(true);
    } else if (sType === 'fishing-pond') {
      enterFishing(structureId);
    } else if (sType === 'fish-stand') {
      villageUi.setInfoPanel({ type: 'fish-stand', structureId });
    }
  }

  function enterFishing(pondId: string): void {
    if (!villageStore || !villageUi || !fishing) return;
    // Mount guard first, before any state is cleared. The village screen this
    // replaced did `if (!gameRef.current) return;` above its four `set…(null)`
    // calls, so with no world host mounted the info panel, catch dialog, and
    // recall dialog all stayed open. `enter` keeps its own guard so both layers
    // enforce the same rule.
    if (!fishing.isMounted()) return;
    villageUi.prepareFishingSession();

    // Compute hasClearedRooms for the nearest dungeon portal
    const pondPortalMap = getFishingPondPortalMap();
    const nearestPortal = pondPortalMap[pondId];
    let hasClearedRooms = true; // default: allow fishing

    if (nearestPortal) {
      const slots = getDungeonPortalSlots();
      const slotIndex = slots.findIndex(
        (s) => s.gridX === nearestPortal.gridX && s.gridY === nearestPortal.gridY,
      );
      if (slotIndex >= 0) {
        const currentSubjects = villageStore.getVillageSubjects();
        if (slotIndex < currentSubjects.length) {
          hasClearedRooms = currentSubjects[slotIndex].clearedRoomCount > 0;
        }
      }
    }

    fishing.enter({
      pondId,
      playerClass: villageStore.getSelectedClass() ?? 'scholar',
      hasClearedRooms,
      onFishCaught: (data) => {
        villageUi.setFishCaught(data);
      },
      onReturnToVillage: () => {
        exitFishing();
      },
      onReady: () => {},
    });
  }

  function exitFishing(): void {
    fishing?.exit();
  }

  function buildFloorVisibilityModel(
    snapshot: SubjectSnapshot,
    floorId: string,
  ): FloorVisibilityModel {
    const hierarchy = deriveGraphHierarchy(snapshot.dungeon);
    return toFloorVisibilityModel(
      computeFloorVisibility(hierarchy, snapshot.dungeon, floorId),
      resolveSubjectFloorBiome(snapshot.dungeon.biome),
    );
  }

  return {
    roomInteract,
    closeInfoPanel,
    toggleInfoPanel,
    finalizePendingReview,
    readPendingReviewSession,
    resumePendingReview,
    discardPendingReview,
    collectArtifact,
    changeFloor,
    travelToRoom,
    teleportToRoom,
    returnToVillage,
    structureApproached,
    structureLeft,
    structureInteract,
    enterFishing,
    exitFishing,
    getCurrentFloorId: () => dungeonUi.getCurrentFloorId(),
    buildFloorVisibilityModel,
  };
}
