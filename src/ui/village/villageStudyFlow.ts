/**
 * The village screen's study-flow wiring: one controller, one set of ports.
 *
 * ## Why this is its own module
 *
 * `createStudyFlowController` takes roughly thirty ports. Writing them inline in
 * the screen made it a hundred and thirty lines of `() => {}` and store
 * plumbing, which is the largest single block in the file and the least
 * interesting to a reader - the screen's job is *composition*, and a wall of
 * getters is the opposite of that. Splitting it out is what lets the screen be
 * read as: switch, handles, flow, panels.
 *
 * It is a **factory, not a hook**, and that distinction is load-bearing. The
 * controller must be created **once** for the life of the screen: creating a second
 * one would reset its bookkeeping (the quest cursor, the tutorial-progress flags,
 * the pending-interaction state) the first one accumulated, and the pre-Phase-12
 * screen created it once precisely because of that. So this module exports a
 * `createVillageStudyFlow` that the screen calls inside a ref guard - the same
 * idiom, and the same reason.
 *
 * ## Every port reads live state
 *
 * Each port below is a getter, never a captured value, so a scene callback fired
 * from the renderer's animation loop always sees the *current* subject list and
 * portal-slot projection even though the controller was created at mount. The two
 * that would otherwise close over a stale array take them through refs, which the
 * screen keeps up to date on every render - the same trick the pre-Phase-12
 * screen used, preserved rather than reinvented.
 *
 * ## The fishing port, and which renderer owns it
 *
 * `isMounted` reports **whether a fishing world can be entered at all**, and `enter` returns
 * early when there is none. Both resolve through one function, {@link resolveFishingHost},
 * which asks the Pixi lane first and the Phaser lane second.
 *
 * That indirection exists because Phase 17 gave the Pixi lane a fishing world. Until it did,
 * this module read `options.readPhaserHandle()?.fishing?.()` directly and documented the Pixi
 * path as having nowhere to fish. That is no longer true, and this is the change that makes
 * it so: a Pixi host is a peer of the Phaser one, not a second concept. The Phaser lane's
 * behaviour is unchanged, because a non-null Phaser handle always reports a `fishing()`
 * member and so always resolves to a host.
 *
 * The ordering is a deliberate build-time one: the Pixi host is preferred so a build with
 * `VITE_PIXI_FISHING=true` never reaches for a Phaser scene, and the default build - where
 * `readPixiFishingHost` returns `null` because the Pixi fishing chunk is deleted from the
 * artifact - behaves exactly as it did before.
 *
 * The ordering also preserves the documented early return: a learner with nowhere to fish sees
 * the pond, not an empty screen, because `enterFishing` returns before `prepareFishingSession`
 * clears any village UI state.
 *
 * ## Why the Pixi host arrives through a port rather than being reached from here
 *
 * This module names no engine and no renderer tree. Phase 12's exit criterion - "no Pixi object
 * is required to understand or invoke a village action" - is enforced as a graph property by
 * `tests/phase12/village-shell-split.test.ts`, which refuses *any* `@/renderers` reach from
 * `src/ui/village/**`, dynamic import included. A `VITE_PIXI_FISHING` switch here would have
 * been a second, differently-located copy of a rule the screen already owns twice over: this
 * file's own header puts "the build-time Phaser/Pixi switch" in the screen, "deliberately".
 * So the switch lives in `VillageScreen.tsx` beside the village and dungeon switches, and all
 * this module needs from it is a getter that returns the host or `null`.
 */
import { useSubjectStore } from '@/store/subjectStore';
import { useSessionStore } from '@/store/sessionStore';
import { useProgressionStore } from '@/store/progressionStore';

import {
  createStudyFlowController,
  type StudyFlowController,
  type StudyFlowFishCaught,
  type StudyFlowVillageInfoPanel,
  type StudyFlowVillageSubject,
} from '@/application/studyFlow';
import type { FishingWorldModel } from '@/application/contracts/world';
/*
 * Phase 17. This used to be `@/game/systems/playerClasses`, which put a Phaser-tree module in
 * the import closure of the fishing lane's own host contract - and the lane's DOM half, which
 * legitimately holds that contract, is held renderer-free by
 * `tests/phase17/fishing-control-ids.test.ts`. `PlayerClassId` is declared in
 * `@/application/contracts/world`, and `playerClasses.ts` asserts its own duplicate is identical
 * to that one at compile time, so reading the neutral declaration loses nothing and keeps the
 * two from drifting - the same move `src/store/sessionStore.ts` records making for `GamePhase`.
 */
import type { PlayerClassId } from '@/application/contracts/world';
import type { VillageStructure } from '@/data/villageLayout';

/**
 * The fishing host a renderer owns, in renderer-neutral terms.
 *
 * The same shape for both lanes, so this module names no engine and holds no engine type.
 * The Phaser adapter supplies a facade over a scene swap inside the village's own game; a
 * Pixi host supplies a mount of `FishingWorld` and the controller its handle exposes.
 */
export interface VillageFishingHostHandlers {
  onFishCaught: (data: StudyFlowFishCaught) => void;
  onReturnToVillage: () => void;
  onReady: () => void;
  /**
   * The pond this session is for.
   *
   * Carried on the handlers rather than added to `FishingWorldModel` because plan 6.1 keeps
   * world models renderer-neutral and `src/application/contracts/**` is not this phase's to
   * edit - and because a pond id is session *identity*, which is exactly what a handler bag
   * is for. Phase 17 needs it to mint the fishing session context with the same pond
   * identifier the eligibility lookup used, which is plan 5.3's "one subject context carried
   * unchanged" in the one place it was previously dropped.
   *
   * The **Phaser** adapter does not supply it: it is a facade over a scene swap and its
   * `enter` ignores the field. A Pixi-lane session therefore carries a pond id and a
   * Phaser-lane session does not, so the screen falls back to the structure id it cast from.
   */
  readonly pondId?: string;
}

export interface VillageFishingHost {
  enter(model: FishingWorldModel, handlers: VillageFishingHostHandlers): void;
  returnToVillage(): void;
}

export interface VillageStudyFlowOptions {
  /**
   * The live Phaser-path renderer handle, read at call time.
   *
   * `null` on the Pixi path, and `null` before the dynamic import resolves, which
   * is what makes `fishing.isMounted` false in both cases.
   */
  readonly readPhaserHandle: () => { fishing?: () => VillageFishingHost } | null;
  /**
   * The live Pixi-lane fishing host, read at call time.
   *
   * `null` on the Phaser lane, and `null` on a build whose artifact contains no Pixi fishing
   * chunk at all.
   *
   * **Non-null means "this screen has a Pixi fishing world host", not "a pond is running."** The
   * two are different questions with different answers, and the Pixi lane's host is published
   * from the moment the screen mounts - because `studyFlow.enterFishing` asks `isMounted()`
   * *before* it calls `enter`, so a host published by `enter` could never be reached by the only
   * code that calls `enter`. This is the same shape as `readPhaserHandle`, which is likewise
   * non-null whenever the village game has mounted and not while `FishingScene` is the active
   * scene; see `PixiFishingLane`'s header for the two questions and the two answers.
   *
   * Nothing in this module may read the non-null case as "a pond exists". The only thing that
   * answers *that* is the host's own `enter` having been called.
   */
  readonly readPixiFishingHost: () => VillageFishingHost | null;
  /** The current portal-slot projection. Read through a ref by the screen. */
  readonly readDynamicStructures: () => readonly VillageStructure[];
  /** The current subject summaries. Read through a ref by the screen. */
  readonly readSubjects: () => readonly StudyFlowVillageSubject[];
  /** Sets the open structure panel, or clears it. */
  readonly setInfoPanel: (panel: StudyFlowVillageInfoPanel | null) => void;
  /** Sets or clears the one-shot welcome sentence. */
  readonly setWelcomeMessage: (message: string | null) => void;
  /** Opens or closes the create-subject dialog. */
  readonly setCreateOpen: (open: boolean) => void;
  /** Opens or closes the sprite editor. */
  readonly setMakeItYoursOpen: (open: boolean) => void;
  /** Opens or closes the statistics dashboard. */
  readonly setShowStats: (open: boolean) => void;
  /** Reports a caught fish, or clears the offer. */
  readonly setFishCaught: (data: StudyFlowFishCaught | null) => void;
  /**
   * Clears every village surface a fishing session owns, before it starts.
   *
   * Supplied whole rather than composed here, because "which surfaces a fishing
   * session owns" is a screen decision: it includes the recall dialog, which is
   * screen state and not a port.
   */
  readonly prepareFishingSession: () => void;
  /**
   * A fishing session ended, on a lane that cannot report it to the DOM itself.
   *
   * Called from the one place every exit route funnels through: this module's `fishing.exit`,
   * which is what `studyFlow.exitFishing` dispatches and what the `onReturnToVillage` handler
   * `enterFishing` built into the world's own handlers.
   *
   * ## Why the option and not something already in the port
   *
   * The Pixi lane's host *can* say so itself - its `returnToVillage` clears its session and
   * reports it - and the screen's flag is cleared from that report. The **Phaser** lane cannot:
   * `createPhaserFishingRenderer`'s `returnToVillage` stops the fishing scene and wakes the
   * village, both inside a `Phaser.Game` the DOM cannot see, and reports nothing. So on the
   * rollback lane the screen's `data-world` stayed `fishing` and its live region kept announcing
   * "You have started fishing" after the learner had walked back - a learner-visible false
   * sentence, on the artifact that ships by default.
   *
   * This is the symmetric counterpart to {@link prepareFishingSession}, and it is supplied whole
   * for the same reason that one is: which surfaces a fishing session owns is a screen decision.
   */
  readonly finishFishingSession: () => void;
}

/**
 * Build the village's one learning-flow controller.
 *
 * Call this **once**, inside a ref guard. Calling it again is not idempotent: the
 * controller owns the interaction bookkeeping that the tutorial depends on.
 */
export function createVillageStudyFlow(options: VillageStudyFlowOptions): StudyFlowController {
  return createStudyFlowController({
    store: {
      getSnapshot: () => useSubjectStore.getState().snapshot,
      getPhase: () => useSessionStore.getState().phase,
      persistActiveSubjectId: () => {},
      setFocusedRoomId: (roomId) => {
        useSessionStore.getState().setFocusedRoomId(roomId);
      },
      setActiveSubjectId: (subjectId) => {
        useSessionStore.getState().setActiveSubjectId(subjectId);
      },
      setActiveScreen: (screen) => {
        useSessionStore.getState().setActiveScreen(screen);
      },
      openNoteEditor: (roomId) => {
        useSessionStore.getState().openNoteEditor(roomId);
      },
      closeMapView: () => {
        useSessionStore.getState().closeMapView();
      },
      cancelTeleportMode: () => {
        useSessionStore.getState().cancelTeleportMode();
      },
      setMobileHudOpen: (open) => {
        useSessionStore.getState().setMobileHudOpen(open);
      },
      setProgressionActiveSubject: (subjectId) => {
        useProgressionStore.getState().setActiveSubject(subjectId);
      },
      collectArtifactNote: (entry) => useProgressionStore.getState().collectArtifactNote(entry),
      /*
       * Phase 16: the review identity is forwarded, and the two marker ports are bound.
       *
       * Both were recorded as follow-ups by `core-logic-engineer` in `studyFlow.ts`'s
       * `StudyFlowStorePort` header, which states them as deliberate backwards-compatibility
       * carve-outs: `review` and `awarded`/`duplicate` are optional so a pre-Phase-16 host
       * keeps working, and `writeReviewSession`/`readProgressionPreservedFields` are optional
       * *because* the marker is optional infrastructure. This binding was the last host on the
       * unconditional lane, and it was reachable - see the inertness note below.
       *
       * Forwarding the identity is what makes an award on this host **durable**: without it
       * `progressionStore.awardReviewPass` is called with no identity, takes the
       * `decision === null` branch, skips `decideReviewPassReward` entirely, and therefore
       * writes no (room, pass) ledger entry - so the awarded-once property this phase exists
       * to establish does not exist on this host at all. `GameScreen` has forwarded it since
       * Phase 16 landed there; this is the village half of the same fix.
       *
       * **What binding the marker ports does and does not change here.** This host's dungeon
       * UI port is all no-ops - `pushToast`, `requestRoomPanelTab`, `setInfoPanelOpen`,
       * `clearNpcDialog`, `openJournalForCollectedNote`, `getCurrentFloorId`,
       * `setCurrentFloorId` all do nothing - and its renderer port is `setFloorVisibility` and
       * `teleportToRoom` doing nothing. So `roomInteract` cannot open a room panel, and
       * `closeInfoPanel` cannot be reached from here, which means **no review is ever armed
       * and `finalizePendingReview` is never dispatched on this host**: `armPendingReview`
       * needs `dungeonUi.requestRoomPanelTab` to have opened a panel, and nothing here can.
       *
       * That is stated rather than assumed, because it is the honest reason this is a
       * correctness fix rather than a behaviour change. `roomInteract` *is* reachable on this
       * host (the Phaser village's world callbacks and the Pixi village's approach handlers
       * both route to it), and it *does* evaluate `canReviewRoom` and can push a refusal - so
       * before this change a learner on this host could be told "review locked" and then have
       * nothing enforced or recorded either way. What the binding fixes is that from now on
       * the durable ledger and the marker are the *same* facts on this host as on
       * `GameScreen`'s, so the moment any host here does arm a review, it is awarded once and
       * resumable, with no second edit to this file.
       */
      awardReviewPass: (review) => useProgressionStore.getState().awardReviewPass(review),
      awardBadge: (badgeId) => {
        useProgressionStore.getState().awardBadge(badgeId);
      },
      readProgressionBadges: () => useProgressionStore.getState().badges,
      recordReviewPass: (roomId) => useSubjectStore.getState().recordReviewPass(roomId),
      readProgressionPreservedFields: () =>
        useProgressionStore.getState().readProgressionPreservedFields(),
      writeReviewSession: (write) => useProgressionStore.getState().writeReviewSession(write),
    },
    renderer: {
      setFloorVisibility: () => {},
      teleportToRoom: () => {},
    },
    teleport: {
      remainingMs: () => 0,
      markConsumed: () => {},
    },
    dungeonUi: {
      pushToast: () => {},
      requestRoomPanelTab: () => {},
      setInfoPanelOpen: () => {},
      isInfoPanelOpen: () => false,
      clearNpcDialog: () => {},
      openJournalForCollectedNote: () => {},
      getCurrentFloorId: () => null,
      setCurrentFloorId: () => {},
    },
    village: {
      content: {
        getDynamicStructures: () => options.readDynamicStructures(),
      },
      store: {
        getSelectedClass: () => useSessionStore.getState().selectedClass,
        getVillageSubjects: () => options.readSubjects(),
        loadSubject: (subjectId) => useSubjectStore.getState().loadSubject(subjectId),
        importSubjectSnapshot: (snapshot) => useSubjectStore.getState().importSnapshot(snapshot),
        setActiveSubjectId: (subjectId) => {
          useSessionStore.getState().setActiveSubjectId(subjectId);
        },
        setProgressionActiveSubject: (subjectId) => {
          useProgressionStore.getState().setActiveSubject(subjectId);
        },
        setActiveScreen: (screen) => {
          useSessionStore.getState().setActiveScreen(screen);
        },
        setPhase: (phase) => {
          useSessionStore.getState().setPhase(phase);
        },
        setSelectedClass: (playerClass) => {
          useSessionStore.getState().setSelectedClass(playerClass);
        },
        setQuestStep: (step) => {
          useSessionStore.getState().setQuestStep(step);
        },
        advanceQuestStep: () => {
          useSessionStore.getState().advanceQuestStep();
        },
      },
      ui: {
        setInfoPanel: options.setInfoPanel,
        setWelcomeMessage: options.setWelcomeMessage,
        setCreateOpen: options.setCreateOpen,
        setMakeItYoursOpen: options.setMakeItYoursOpen,
        setShowStats: options.setShowStats,
        setFishCaught: options.setFishCaught,
        prepareFishingSession: options.prepareFishingSession,
      },
      fishing: {
        /*
         * "A world host is mounted and able to start the fishing world" - which is the
         * question `enterFishing` asks before it clears any village UI state, and *not*
         * "a fishing world is running". The Pixi host answers it from the moment the screen
         * mounts and the Phaser one from the moment the village game has, so the two lanes
         * mean the same thing here.
         */
        isMounted: () => resolveFishingHost() !== null,
        enter: ({ pondId, playerClass, hasClearedRooms, onFishCaught, onReturnToVillage, onReady }) => {
          // A host that resolves to nothing means there is nowhere to fish, and this
          // returns before `prepareFishingSession` clears any village UI state - so a
          // learner with no world sees the pond, not an empty screen. That ordering is
          // the original village screen's behaviour, preserved by construction rather than
          // by comment.
          const fishing = resolveFishingHost();
          if (fishing === null) return;
          // One explicit subject context for the whole session, so catch resolution
          // and persistence cannot disagree about the subject.
          const world: FishingWorldModel = {
            kind: 'fishing',
            // The flow resolves this from the session store, so it is one of the
            // three archetypes; the port types it loosely as a string.
            playerClass: playerClass as PlayerClassId,
            hasClearedRooms,
            subjectId: useProgressionStore.getState().activeSubjectId,
          };
          // `pondId` forwarded, and that one word is the whole of Phase 17's session-identity
          // fix on this side: `studyFlow.enterFishing` already resolved it from the structure
          // the learner cast from, so the pond's identity is now the *same* value the
          // eligibility lookup above used instead of being re-derived - or, as before Phase 17,
          // thrown away.
          fishing.enter(world, { onFishCaught, onReturnToVillage, onReady, pondId });
        },
        exit: () => {
          /*
           * Stop the world first, then say so - and say so on **both** lanes.
           *
           * `studyFlow.exitFishing` is the only dispatch every route out of a fishing session
           * reaches: `FishingScene`'s `ESC` binding and its in-scene return button both fire the
           * `onReturnToVillage` handler this module's `enterFishing` built, and the Pixi lane's
           * own return control routes through the same host. The host handles the lane that can
           * report itself; `finishFishingSession` covers the one that cannot, which is the Phaser
           * rollback lane. Without it that lane left `data-world="fishing"` and the live region
           * still saying "You have started fishing" while the learner stood in the village.
           */
          resolveFishingHost()?.returnToVillage();
          options.finishFishingSession();
        },
      },
    },
  });

  /**
   * The fishing host this build can enter, Pixi first and Phaser second.
   *
   * One resolution for all three port members, which is the point: `isMounted`, `enter`, and
   * `exit` cannot disagree about which world they are talking about. That is the Phase 9
   * "one dispatch path" rule restated for the fishing port.
   */
  function resolveFishingHost(): VillageFishingHost | null {
    return options.readPixiFishingHost() ?? options.readPhaserHandle()?.fishing?.() ?? null;
  }
}
