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
 * ## The fishing port is honest about which renderer owns it
 *
 * `isMounted` reports the **Phaser** handle, and `enter` returns early when that
 * handle has no fishing world. The Phase 11 Pixi village has no fishing world yet
 * (Phase 17 does), so on the Pixi path `isMounted` is `false` and `enterFishing`
 * no-ops *before* the flow clears any village UI state. That ordering is a
 * documented behaviour - the original village screen returned before touching
 * state when no host was mounted - and this module preserves it by construction
 * rather than by comment.
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
import type { PlayerClassId } from '@/game/systems/playerClasses';
import type { VillageStructure } from '@/data/villageLayout';

/**
 * The fishing host a Phaser village renderer owns.
 *
 * Structural, so this module names no engine - the same reasoning the screen's
 * handle type uses.
 */
export interface VillageFishingHost {
  enter(
    model: FishingWorldModel,
    handlers: {
      onFishCaught: (data: StudyFlowFishCaught) => void;
      onReturnToVillage: () => void;
      onReady: () => void;
    },
  ): void;
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
      awardReviewPass: () => useProgressionStore.getState().awardReviewPass(),
      awardBadge: (badgeId) => {
        useProgressionStore.getState().awardBadge(badgeId);
      },
      readProgressionBadges: () => useProgressionStore.getState().badges,
      recordReviewPass: (roomId) => useSubjectStore.getState().recordReviewPass(roomId),
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
        isMounted: () => options.readPhaserHandle() !== null,
        enter: ({ playerClass, hasClearedRooms, onFishCaught, onReturnToVillage, onReady }) => {
          // Fishing is a Phaser-host capability in Phase 11; the Pixi path has no
          // fishing world yet, and `isMounted` above reports false there. The
          // original village screen also cleared its panels *after* this guard, so
          // a learner with nowhere to fish sees the pond, not an empty screen.
          const fishing = options.readPhaserHandle()?.fishing?.();
          if (fishing === undefined) return;
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
          fishing.enter(world, { onFishCaught, onReturnToVillage, onReady });
        },
        exit: () => {
          options.readPhaserHandle()?.fishing?.().returnToVillage();
        },
      },
    },
  });
}
