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
import { isReviewableRoom, summarizeReviewAnalytics } from '@/core/review';
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
  awardReviewPass(): { xpGained: number };
  awardBadge(badgeId: string): void;
  readProgressionBadges(): readonly string[];

  // ── Subject store ──
  recordReviewPass(roomId: string): Promise<void>;
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
  let pendingReviewRoomId: string | null = null;

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

  function finalizePendingReview(roomId: string): void {
    const liveSnapshot = store.getSnapshot();
    if (!liveSnapshot) return;

    const room = liveSnapshot.rooms[roomId];
    if (!room || !room.validationState.finalPass) return;

    const reviewableRoomIds = liveSnapshot.dungeon.rooms
      .map((summary) => summary.roomId)
      .filter((candidateRoomId) => {
        const candidate = liveSnapshot.rooms[candidateRoomId];
        return candidate ? isReviewableRoom(candidate) : false;
      });
    const analyticsBefore = summarizeReviewAnalytics({
      rooms: liveSnapshot.rooms,
      reviewableRoomIds,
      currentReviewStreak: 0,
      longestReviewStreak: 0,
    });
    const nextPassTarget = analyticsBefore.fullReviewPasses + 1;
    const shouldAwardReviewXp = room.reviewPassCount < nextPassTarget;

    void store.recordReviewPass(roomId);
    const reviewProgression = shouldAwardReviewXp ? store.awardReviewPass() : { xpGained: 0 };

    const roomsWithIncrement = {
      ...liveSnapshot.rooms,
      [roomId]: {
        ...room,
        reviewPassCount: room.reviewPassCount + 1,
      },
    };
    const analytics = summarizeReviewAnalytics({
      rooms: roomsWithIncrement,
      reviewableRoomIds,
      currentReviewStreak: 0,
      longestReviewStreak: 0,
    });

    const unlockedBadges = evaluatePhaseBadgeUnlocks(
      {
        totalRooms: liveSnapshot.dungeon.rooms.length,
        creatorMappedRooms: liveSnapshot.dungeon.rooms.length,
        scribeClearedRooms: reviewableRoomIds.length,
        archaeologistFullReviewPasses: analytics.fullReviewPasses,
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

    const nextPassProgressTarget = analytics.fullReviewPasses + 1;
    const reviewedTowardNextPass = liveSnapshot.dungeon.rooms.filter((summary) => {
      const count = roomsWithIncrement[summary.roomId]?.reviewPassCount ?? 0;
      return count >= nextPassProgressTarget;
    }).length;
    const xpMessage =
      reviewProgression.xpGained > 0
        ? ` (+${reviewProgression.xpGained} XP)`
        : ' (already counted for this pass)';
    dungeonUi.pushToast(
      'info',
      `Review recorded${xpMessage}: ${reviewedTowardNextPass}/${liveSnapshot.dungeon.rooms.length} rooms toward pass ${nextPassProgressTarget}. Completed full passes: ${analytics.fullReviewPasses}.`,
    );
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

    if (liveSnapshot) {
      const room = liveSnapshot.rooms[roomId];
      if (room && room.validationState.finalPass) {
        pendingReviewRoomId = roomId;
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
