import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph';
import { isReviewableRoom, summarizeReviewAnalytics } from '@/core/review';
import {
  createStudyFlowController,
  type StudyFlowController,
} from '@/application/studyFlow';
import { TELEPORT_COOLDOWN_MS, useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useShortcutStore } from '@/store/shortcutStore';
import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import { runtimeConfig } from '@/config/featureFlags';
import type {
  DungeonRendererCapabilities,
  WorldRenderer,
} from '@/application/contracts/renderer';
import type { DungeonWorldModel } from '@/application/contracts/world';
import type { DungeonSceneCallbacks } from '@/renderers/pixi/dungeon/DungeonRenderer';
import type { DungeonWorldHandle } from '@/renderers/pixi/dungeon/DungeonWorld';
import { Hud } from '@/ui/components/Hud';
import { HudDrawer } from '@/ui/components/HudDrawer';
import { FloatingActions } from '@/ui/components/FloatingActions';
import { InventoryBadgesPanel } from '@/ui/components/InventoryBadgesPanel';
import { RoomPanel } from '@/ui/components/RoomPanel';
import { TutorialOverlay } from '@/ui/components/TutorialOverlay';
import { MobileTouchHint } from '@/ui/components/MobileTouchHint';
import type { RoomTab } from '@/ui/components/RoomPanel';
import { NoteEditorModal } from '@/ui/components/NoteEditorModal';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import { bindArtifactCollection } from '@/store/encounterCommands';
import { RoomNpcDialog } from '@/ui/components/RoomNpcDialog';
import { Minimap } from '@/ui/components/Minimap';
import { HelpOverlay } from '@/ui/components/HelpOverlay';
import { FullMapView } from '@/ui/components/FullMapView';
import { GameplayOnboardingModal } from '@/ui/components/GameplayOnboardingModal';
import { SettingsModal } from '@/ui/components/SettingsModal';
import { ToastStack } from '@/ui/components/ToastStack';
import { isEditableElement } from '@/ui/utils/editableElement';
import { useToasts } from '@/ui/utils/useToasts';
import { useExportReminder } from '@/ui/hooks/useExportReminder';
import {
  hasSeenGameplayLoopOnboarding,
  markGameplayLoopOnboardingSeen,
} from '@/ui/utils/onboarding';
import { setActiveSubjectId as persistActiveSubjectId } from '@/services/persistence/subjectPersistence';
import { getStorageThreshold } from '@/services/errorRecovery';

/**
 * The build-time dungeon renderer switch (Phase 13).
 *
 * ## Why the comparison is against a literal
 *
 * `import.meta.env.VITE_PIXI_DUNGEON` is substituted as a string literal at build time,
 * so a *literal* `=== 'true'` lets the bundler fold the branch and delete the other arm -
 * along with the dynamic `import()` inside it, and therefore with the whole PixiJS chunk
 * that import pulls in. A normalising call first (`String(raw).trim().toLowerCase()`)
 * reads the same at run time and defeats the folding, so the default build keeps a Pixi
 * dungeon chunk it would never fetch. This mirrors `src/ui/App.tsx`'s renderer switch and
 * `src/ui/screens/VillageScreen.tsx`'s village switch exactly.
 *
 * The parsed run-time value is `runtimeConfig.pixiDungeon`. The two are used for two
 * jobs, as in those files: this literal decides what the bundler may delete, and the
 * parsed flag produces a defined mismatch message below instead of a silent fallback when
 * the environment value was not literally `true`.
 */
const pixiDungeonFactory =
  import.meta.env.VITE_PIXI_DUNGEON === 'true'
    ? () => import('@/renderers/pixi/dungeon/DungeonWorld')
    : null;

const phaserDungeonFactory =
  import.meta.env.VITE_PIXI_DUNGEON === 'true'
    ? null
    : () => import('@/game/createGame');

/**
 * The lazy Pixi dungeon chunk, or `null` on a build that did not request it.
 *
 * Computed once at module scope: a `lazy()` call inside the component would mint a new
 * component type on every render and remount the world - which for a PixiJS world means
 * tearing down and rebuilding the `Application`.
 */
const LazyPixiDungeonWorld = pixiDungeonFactory !== null ? lazy(pixiDungeonFactory) : null;

/**
 * Whether this build renders the redesigned Scribe encounter workspace (Phase 15).
 *
 * Read from the build-time flag once, at module scope, exactly as `RoomPanel` reads
 * `runtimeConfig.creatorWorkspace` for the Creator workspace. `false` is the production
 * default, and with it this screen renders the pre-Phase-15 `NoteEditorModal` unchanged
 * and untouched - that modal is the rollback lane, and the phase's rollback line is to
 * restore it as the Scribe view while retaining the shared commands.
 *
 * The two are switched here rather than in two places because they occupy the *same slot*:
 * `studyFlowController.roomInteract` opens exactly one Scribe surface per room, so
 * rendering both would put two composers over one encounter.
 */
const SCRIBE_ENCOUNTER_WORKSPACE_ENABLED = runtimeConfig.scribeEncounterWorkspace;

/**
 * Whether this host permits an artifact pickup, in every phase.
 *
 * ## Why the second argument to `setArtifactRooms` is no longer a phase test
 *
 * That argument used to be `phase === 'archaeologist'`, which read as "are we reviewing"
 * while the renderer asked "may this be picked up". Those are different questions, and the
 * second is the one the renderer actually asks: `dungeonArtifact.ts` documents that input as
 * "pickup is a live action in whatever phase the session is in" and forbids the renderer
 * from importing the session store to answer it. So the host is the only place the answer can
 * live, and the honest answer is yes.
 *
 * It was also a delivery blocker, not a nicety. The Scribe phase is where an artifact is
 * generated, so a gate that opened only in Archaeologist left a learner holding a thing they
 * had just earned with no way to take it. That is Phase 15's "Artifact collection event for
 * Pixi Dungeon", and it could not land while the host said no.
 *
 * ## Why `true`, rather than something cleverer
 *
 * The domain rule is per-room, and the other two inputs already carry it in full:
 * `StudyFlowController.collectArtifact` returns early on anything but a truthy
 * `room.artifactMarkdown`; `artifactRoomIds` lists only cleared rooms; and
 * `setCollectedArtifactRooms` makes an already-collected room report `collected`, which
 * `resolveDungeonArtifactMarker` answers before it ever looks at permission. A phase term
 * here would not add a condition, it would add a rule the domain does not have - which is
 * exactly how the Scribe pickup got stranded. One fewer input, one fewer way to disagree.
 *
 * The surface that owns the action in Scribe is the encounter workspace's artifact region; the
 * canvas marker is the gesture route to the same `artifact/collect`. Both reach
 * `flow.collectArtifact`, so both are gated by the same domain check.
 */
const HOST_PERMITS_ARTIFACT_PICKUP = true;

/**
 * The renderer surface this screen drives, in renderer-neutral terms.
 *
 * Structural rather than a named adapter type, because naming either adapter would mean
 * statically importing an engine from a UI module - which is precisely what Phase 11's
 * boundary gate tolerated in this one file and what Phase 13 closes. `DungeonWorld`'s
 * handle satisfies it because it declares the whole `DungeonRendererCapabilities` port;
 * the Phaser adapter satisfies it because it has declared that port since Phase 2.
 *
 * `onReady` and `activateFromDom` are optional because they are additive conveniences:
 * the Phaser adapter has `onReady` but no action dispatcher, and a capability object has
 * neither.
 */
type DungeonRendererPort = DungeonRendererCapabilities & {
  isReady(): boolean;
  restart(): void;
  onReady?: (listener: () => void) => () => void;
  activateFromDom?: (actionId: string) => void;
};

/**
 * The Phaser adapter's full lifecycle, which the mount effect drives.
 *
 * Narrower than `WorldRenderer & DungeonRendererPort` on purpose: `DungeonWorld` mounts and
 * unmounts itself through a React effect, so it exposes no `mount`/`unmount`, and a port
 * that required them would exclude the very handle the Pixi lane hands back. Only the
 * Phaser branch below ever calls these two, and it only exists on a build whose flag asks
 * for Phaser.
 */
type MountableDungeonRenderer = DungeonRendererPort &
  Pick<WorldRenderer, 'mount' | 'unmount'>;

/** The Phaser factory, or `null` on a build that asked for the Pixi dungeon. */
const phaserDungeonModule =
  phaserDungeonFactory === null ? null : phaserDungeonFactory;

export function GameScreen(): JSX.Element {
  const snapshot = useSubjectStore((s) => s.snapshot);
  const setFocusedRoomId = useSessionStore((s) => s.setFocusedRoomId);
  const openNoteEditor = useSessionStore((s) => s.openNoteEditor);
  const focusedRoomId = useSessionStore((s) => s.focusedRoomId);
  const phase = useSessionStore((s) => s.phase);
  const setPhase = useSessionStore((s) => s.setPhase);
  const isNoteEditorOpen = useSessionStore((s) => s.isNoteEditorOpen);
  const selectedClass = useSessionStore((s) => s.selectedClass);
  const setActiveSubjectId = useSessionStore((s) => s.setActiveSubjectId);
  const setActiveScreen = useSessionStore((s) => s.setActiveScreen);
  const isMapViewOpen = useSessionStore((s) => s.isMapViewOpen);
  const openMapView = useSessionStore((s) => s.openMapView);
  const closeMapView = useSessionStore((s) => s.closeMapView);
  const teleportModeArmed = useSessionStore((s) => s.teleportModeArmed);
  const lastTeleportAt = useSessionStore((s) => s.lastTeleportAt);
  const armTeleportMode = useSessionStore((s) => s.armTeleportMode);
  const cancelTeleportMode = useSessionStore((s) => s.cancelTeleportMode);
  const markTeleported = useSessionStore((s) => s.markTeleported);
  const recordReviewPass = useSubjectStore((s) => s.recordReviewPass);
  const resolveAttachmentUrl = useSubjectStore((s) => s.resolveAttachmentUrl);
  const xpTotal = useProgressionStore((s) => s.xpTotal);
  const rank = useProgressionStore((s) => s.rank);
  const inventory = useProgressionStore((s) => s.inventory);
  const badges = useProgressionStore((s) => s.badges);
  const collectedNotes = useProgressionStore((s) => s.collectedNotes);
  const equippedItems = useProgressionStore((s) => s.equippedItems);
  const equipItem = useProgressionStore((s) => s.equipItem);
  const unequipItem = useProgressionStore((s) => s.unequipItem);
  const getEquipBonuses = useProgressionStore((s) => s.getEquipBonuses);
  const setProgressionActiveSubject = useProgressionStore((s) => s.setActiveSubject);
  const colorTheme = usePreferencesStore((s) => s.colorTheme);
  const setColorTheme = usePreferencesStore((s) => s.setColorTheme);
  const sceneRestartCounter = useSessionStore((s) => s.sceneRestartCounter);

  const containerRef = useRef<HTMLDivElement | null>(null);
  /**
   * Whichever renderer is mounted, through the neutral port.
   *
   * One ref for both lanes on purpose: the capability effects below run against whatever
   * is live, so a renderer swap cannot leave one of them writing to an object no screen
   * reads.
   */
  const rendererRef = useRef<DungeonRendererPort | null>(null);
  const pixiDungeonRef = useRef<DungeonWorldHandle | null>(null);
  const npcDialogRoomIdRef = useRef<string | null>(null);
  const roomPanelTabRequestSequenceRef = useRef(0);
  const isInfoPanelOpenRef = useRef(false);
  const currentFloorIdRef = useRef<string | null>(null);
  const teleportRemainingMsRef = useRef(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isInfoPanelOpen, setIsInfoPanelOpen] = useState(false);
  const [roomPanelTabRequest, setRoomPanelTabRequest] = useState<{
    tab: RoomTab;
    sequence: number;
  } | null>(null);
  const [inventoryView, setInventoryView] = useState<null | 'inventory' | 'badges' | 'journal'>(
    null,
  );
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [sceneReady, setSceneReady] = useState(false);
  const [lastWelcomedSubjectId, setLastWelcomedSubjectId] = useState<string | null>(null);
  const [npcDialogRoomId, setNpcDialogRoomId] = useState<string | null>(null);
  const [npcDialogAnchor, setNpcDialogAnchor] = useState<{ x: number; y: number } | null>(null);
  const [autoOpenCollectedNoteId, setAutoOpenCollectedNoteId] = useState<string | null>(null);
  const [attachmentUrlsByRoomId, setAttachmentUrlsByRoomId] = useState<
    Record<string, Record<string, string>>
  >({});
  const [isMobile] = useState(() => {
    try { return window.matchMedia('(max-width: 768px)').matches; }
    catch { return false; }
  });
  const setMobileHudOpen = useSessionStore((s) => s.setMobileHudOpen);
  const { toasts, pushToast, dismissToast } = useToasts();
  useExportReminder(pushToast);

  const requestRoomPanelTab = useCallback((tab: RoomTab) => {
    roomPanelTabRequestSequenceRef.current += 1;
    setRoomPanelTabRequest({ tab, sequence: roomPanelTabRequestSequenceRef.current });
  }, []);

  useEffect(() => {
    npcDialogRoomIdRef.current = npcDialogRoomId;
  }, [npcDialogRoomId]);

  const dungeonMap = useMemo(() => {
    if (!snapshot) return null;
    return generateDungeonMap(snapshot.dungeon);
  }, [snapshot?.dungeon]);
  const hierarchy = useMemo(
    () => (snapshot ? deriveGraphHierarchy(snapshot.dungeon) : null),
    [snapshot?.dungeon],
  );

  // The floor the in-game scene is currently rendering. Defaults to the
  // root floor and changes when the player triggers a portal (E on a stairs
  // room) or teleports via the map.
  const [currentFloorId, setCurrentFloorId] = useState<string | null>(null);
  useEffect(() => {
    if (snapshot && currentFloorId === null) {
      setCurrentFloorId(snapshot.dungeon.rootRoomId);
    }
  }, [snapshot, currentFloorId]);

  const floorVisibility = useMemo(() => {
    if (!snapshot || !hierarchy || !currentFloorId) return null;
    return computeFloorVisibility(hierarchy, snapshot.dungeon, currentFloorId);
  }, [snapshot, hierarchy, currentFloorId]);

  const teleportRemainingMs =
    lastTeleportAt === null ? 0 : Math.max(0, TELEPORT_COOLDOWN_MS - (clockMs - lastTeleportAt));
  const phaseChangeNeedsConfirmation = isNoteEditorOpen || isMapViewOpen || teleportModeArmed;
  const clearedRoomsCount = snapshot
    ? Object.values(snapshot.rooms).filter((room) => room.validationState.finalPass).length
    : 0;
  const showScribeNudge = phase === 'creator' && snapshot ? snapshot.dungeon.rooms.length >= 3 : false;

  // Refs mirroring render state the flow controller needs to read without
  // capturing a stale value (the controller itself stays identity-stable).
  isInfoPanelOpenRef.current = isInfoPanelOpen;
  currentFloorIdRef.current = currentFloorId;
  teleportRemainingMsRef.current = teleportRemainingMs;

  // The shared renderer-neutral learning flow. Every dependency below is a
  // stable store action, ref, or setter, so the controller is created once and
  // keeps its deferred-review state for the lifetime of the screen.
  const flowRef = useRef<StudyFlowController | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createStudyFlowController({
      store: {
        getSnapshot: () => useSubjectStore.getState().snapshot,
        getPhase: () => useSessionStore.getState().phase,
        persistActiveSubjectId,
        setFocusedRoomId,
        setActiveSubjectId,
        setActiveScreen,
        openNoteEditor,
        closeMapView,
        cancelTeleportMode,
        setMobileHudOpen,
        setProgressionActiveSubject,
        collectArtifactNote: (entry) =>
          useProgressionStore.getState().collectArtifactNote(entry),
        awardReviewPass: () => useProgressionStore.getState().awardReviewPass(),
        awardBadge: (badgeId) => {
          useProgressionStore.getState().awardBadge(badgeId);
        },
        readProgressionBadges: () => useProgressionStore.getState().badges,
        recordReviewPass,
      },
      renderer: {
        setFloorVisibility: (visibility) => {
          rendererRef.current?.setFloorVisibility(visibility);
        },
        teleportToRoom: (roomId) => {
          rendererRef.current?.teleportToRoom(roomId);
        },
      },
      teleport: {
        remainingMs: () => teleportRemainingMsRef.current,
        markConsumed: (at) => {
          setClockMs(at);
          markTeleported(at);
        },
      },
      dungeonUi: {
        pushToast,
        requestRoomPanelTab,
        setInfoPanelOpen: setIsInfoPanelOpen,
        isInfoPanelOpen: () => isInfoPanelOpenRef.current,
        clearNpcDialog: () => {
          setNpcDialogRoomId(null);
          setNpcDialogAnchor(null);
        },
        openJournalForCollectedNote: (noteId) => {
          setInventoryView('journal');
          setAutoOpenCollectedNoteId(noteId);
        },
        getCurrentFloorId: () => currentFloorIdRef.current,
        setCurrentFloorId,
      },
    });
  }
  const flow = flowRef.current;

  /**
   * Bind this screen's artifact pickup to the encounter command layer (Phase 15).
   *
   * `encounterController.artifactCollect` reaches the pickup through
   * `bindArtifactCollection`, because the pickup is owned by whichever world controller is
   * mounted and `studyFlowController` is per-screen: it is built here, from this screen's
   * ports, and it is what builds the journal entry and opens the journal. Without this
   * binding the redesigned Scribe workspace's pickup throws instead of silently doing
   * nothing, which is the right default and not a usable lane.
   *
   * Cleared on unmount, so a later encounter can never dispatch into a flow that is gone.
   * This is a wiring effect, not a mutation: it registers a handler and removes it, and
   * it never runs a command itself.
   */
  useEffect(() => {
    bindArtifactCollection((command) => {
      flow.collectArtifact(command.payload.roomId);
    });
    return () => {
      bindArtifactCollection(null);
    };
  }, [flow]);

  const closeInfoPanel = useCallback(() => {
    flow.closeInfoPanel();
  }, [flow]);

  const toggleInfoPanel = useCallback(() => {
    flow.toggleInfoPanel();
  }, [flow]);

  useEffect(() => {
    if (teleportRemainingMs <= 0) return;
    const interval = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [teleportRemainingMs]);

  /**
   * One stable callback bag for the lifetime of the mount.
   *
   * Both renderers report through these functions, so a bag that changed identity on
   * every render would tear the world down and rebuild it on every HUD update. Forwarding
   * into refs is what makes the bag stable *and* current.
   *
   * This is also why `phase` is no longer in the effect's dependency list below: the old
   * inline `handleRoomInteract` closure captured `phase`, which forced a remount on every
   * phase change. `flow.roomInteract` reads the live phase from the store, so the closure
   * no longer needs it - and for the Pixi lane a remount means destroying and rebuilding a
   * PixiJS `Application`, which is exactly the cost the ref removes.
   */
  const stableCallbacks = useMemo<DungeonSceneCallbacks>(
    () => ({
      onRoomEntered: (roomId) => setFocusedRoomId(roomId),
      onNpcInteract: ({ roomId, clientX, clientY }) => {
        setNpcDialogRoomId(roomId);
        setNpcDialogAnchor({ x: clientX, y: clientY });
        setFocusedRoomId(roomId);
      },
      onNpcDialogPosition: ({ roomId, clientX, clientY }) => {
        setNpcDialogAnchor((current) => {
          if (!current || npcDialogRoomIdRef.current !== roomId) {
            return { x: clientX, y: clientY };
          }
          if (Math.abs(current.x - clientX) < 0.75 && Math.abs(current.y - clientY) < 0.75) {
            return current;
          }
          return { x: clientX, y: clientY };
        });
      },
      onNpcOutOfRange: (roomId) => {
        setNpcDialogRoomId((current) => (current === roomId ? null : current));
        setNpcDialogAnchor((current) =>
          npcDialogRoomIdRef.current === roomId ? null : current,
        );
      },
      onInteract: (roomId) => flow.roomInteract(roomId),
      onArtifactCollected: (roomId) => flow.collectArtifact(roomId),
      onFloorTransition: ({ fromRoomId, direction }) => flow.changeFloor(fromRoomId, direction),
    }),
    [flow, setFocusedRoomId],
  );
  /**
   * The renderer-neutral world this screen presents.
   *
   * Memoised, not rebuilt per render, so a HUD update is not a new world. Floor *changes*
   * do not come through here: they are pushed through the renderer's `setFloorVisibility`
   * by the flow, exactly as the pre-Phase-2 screen did, because remounting the world on a
   * floor change would discard the player's position and the camera.
   */
  const worldModel = useMemo<DungeonWorldModel | null>(() => {
    if (!snapshot || !dungeonMap) return null;
    return {
      kind: 'dungeon',
      map: dungeonMap,
      floor: flow.buildFloorVisibilityModel(snapshot, currentFloorId ?? snapshot.dungeon.rootRoomId),
      playerClass: selectedClass,
    };
  }, [dungeonMap, flow, selectedClass, snapshot]);
  // Which renderer this build was asked for, and whether the artifact agrees.
  const pixiDungeon = LazyPixiDungeonWorld !== null;
  const pixiDungeonMismatch = runtimeConfig.pixiDungeon && pixiDungeonFactory === null;

  /**
   * Mount the Phaser dungeon, on the lane that asks for it.
   *
   * A no-op on the Pixi lane, where the world mounts as a React component instead. The
   * import is dynamic and guarded by the build-time literal, so this whole effect and the
   * Phaser chunk behind it are deleted from a Pixi-dungeon artifact - and deleted from the
   * default artifact too, by the same fold the flag comment describes.
   */
  useEffect(() => {
    if (pixiDungeon || phaserDungeonModule === null) return;
    if (!snapshot || !dungeonMap || !hierarchy || !containerRef.current || !worldModel) return;

    let cancelled = false;
    let stopWaitingForReady: (() => void) | null = null;
    // Held locally rather than read back off `rendererRef`, because on this lane the
    // ref holds *this* renderer - and a cleanup that read the ref could unmount a
    // successor mounted by a newer run of the effect.
    let mounted: MountableDungeonRenderer | null = null;

    void (async () => {
      const { createGame } = await phaserDungeonModule();
      const host = containerRef.current;
      if (cancelled || host === null) return;
      const renderer: MountableDungeonRenderer = createGame({
        parent: host,
        world: worldModel,
        colorTheme,
        callbacks: stableCallbacks,
      });
      mounted = renderer;
      rendererRef.current = renderer;
      stopWaitingForReady = renderer.onReady?.(() => setSceneReady(true)) ?? null;
      renderer.mount();
    })();

    return () => {
      cancelled = true;
      stopWaitingForReady?.();
      mounted?.unmount();
      mounted = null;
      rendererRef.current = null;
      pixiDungeonRef.current = null;
      setSceneReady(false);
    };
  }, [colorTheme, dungeonMap, hierarchy, pixiDungeon, snapshot, stableCallbacks, worldModel]);

  // Restart the dungeon world when the user saves custom sprites and clicks "Apply Changes"
  useEffect(() => {
    if (sceneRestartCounter === 0) return;
    if (!rendererRef.current) return;
    // The adapter revokes the old blob URLs and restarts the scene in place.
    rendererRef.current.restart();
  }, [sceneRestartCounter]);

  useEffect(() => {
    if (!sceneReady || !snapshot) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const artifactRoomIds = Object.values(snapshot.rooms)
      .filter((room) => room.validationState.finalPass)
      .map((room) => room.roomId);
    renderer.setArtifactRooms(artifactRoomIds, HOST_PERMITS_ARTIFACT_PICKUP);
    // `phase` stays in this dependency list on purpose. It is unused by the body today, and
    // removing it would mean the next person who reintroduces a phase term changes the
    // gate without also re-wiring the effect that publishes it.
  }, [sceneReady, snapshot, phase]);

  useEffect(() => {
    if (!sceneReady || !snapshot) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const subjectCollectedArtifactRoomIds = collectedNotes
      .filter((entry) => entry.dungeonId === snapshot.dungeon.dungeonId)
      .map((entry) => entry.roomId);
    renderer.setCollectedArtifactRooms(subjectCollectedArtifactRoomIds);
  }, [sceneReady, snapshot, collectedNotes]);

  useEffect(() => {
    if (!sceneReady || !snapshot) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const reviewedArtifactRoomIds =
      phase === 'archaeologist'
        ? Object.values(snapshot.rooms)
            .filter((room) => room.reviewPassCount > 0)
            .map((room) => room.roomId)
        : [];
    renderer.setReviewedArtifactRooms(reviewedArtifactRoomIds);
  }, [phase, sceneReady, snapshot]);

  useEffect(() => {
    if (!sceneReady || !snapshot) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const imageRoomIds = Object.values(snapshot.rooms)
      .filter((room) => room.attachments.length > 0)
      .map((room) => room.roomId);
    renderer.setImageRooms(imageRoomIds);
  }, [sceneReady, snapshot]);

  useEffect(() => {
    if (!sceneReady || !snapshot) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const roomStates: Record<string, string> = {};
    for (const room of snapshot.dungeon.rooms) {
      const meta = snapshot.rooms[room.roomId];
      roomStates[room.roomId] = meta?.state ?? room.status;
    }
    renderer.setRoomOverlayStates(roomStates);
  }, [sceneReady, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    if (hasSeenGameplayLoopOnboarding()) return;
    setShowOnboarding(true);
  }, [snapshot]);

  useEffect(() => {
    setProgressionActiveSubject(snapshot?.dungeon.dungeonId ?? null);
  }, [setProgressionActiveSubject, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    if (lastWelcomedSubjectId === snapshot.dungeon.dungeonId) return;
    const totalRooms = snapshot.dungeon.rooms.length;
    /*
     * Phase 15 changed this sentence's honesty, so it changed the sentence.
     *
     * It used to answer every phase with "Review artifacts in Archaeologist phase", which
     * is only good advice in the Archaeologist phase: it points a learner out of the phase
     * they are in, and after the pickup gate opened in every phase it also hid the fact
     * that the artifact they may still be owed is collectable *here and now*. So the branch
     * that fires once every room is cleared is now phase-aware: in the review phase it says
     * what to do, and in every other phase it names the pickup that is available before it
     * points at review.
     */
    const suggestedNextAction =
      clearedRoomsCount >= totalRooms && totalRooms > 0
        ? phase === 'archaeologist'
          ? 'Review the artifacts in your journal.'
          : 'Collect any artifact still waiting in a room, then move to Archaeologist to review.'
        : phase === 'creator'
          ? 'Add a few rooms, then switch to Scribe to clear encounters.'
          : 'Open a room encounter to continue progress.';
    pushToast(
      'info',
      `Welcome back: ${clearedRoomsCount}/${totalRooms} rooms cleared. Current phase: ${phase[0].toUpperCase()}${phase.slice(1)}. Suggested next: ${suggestedNextAction}`,
    );
    setLastWelcomedSubjectId(snapshot.dungeon.dungeonId);
  }, [clearedRoomsCount, lastWelcomedSubjectId, phase, pushToast, snapshot]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore shortcuts while typing in any text-input/textarea/
      // contenteditable so users can still type normally.
      if (isEditableElement(e.target)) return;

      // Phase 5: Use configurable shortcuts from the shortcut store
      const shortcutState = useShortcutStore.getState().shortcuts;

      // Help shortcut (index 0)
      const helpShortcut = shortcutState[0];
      if (helpShortcut) {
        const helpKey = helpShortcut.key.toLowerCase();
        const eKey = e.key.toLowerCase();
        const ctrlOk = helpShortcut.ctrlKey ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
        const shiftOk = helpShortcut.shiftKey ? e.shiftKey : !e.shiftKey;
        if (eKey === helpKey && ctrlOk && shiftOk) {
          e.preventDefault();
          setHelpOpen((open) => !open);
          return;
        }
      }

      // Map shortcut (index 1)
      const mapShortcut = shortcutState[1];
      if (mapShortcut) {
        const mapKey = mapShortcut.key.toLowerCase();
        const eKey = e.key.toLowerCase();
        const ctrlOk = mapShortcut.ctrlKey ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
        const shiftOk = mapShortcut.shiftKey ? e.shiftKey : !e.shiftKey;
        if (eKey === mapKey && ctrlOk && shiftOk) {
          e.preventDefault();
          if (useSessionStore.getState().isMapViewOpen) {
            closeMapView();
          } else {
            openMapView();
          }
          return;
        }
      }

      // Info panel shortcut (index 2)
      const infoShortcut = shortcutState[2];
      if (infoShortcut) {
        const infoKey = infoShortcut.key.toLowerCase();
        const eKey = e.key.toLowerCase();
        const ctrlOk = infoShortcut.ctrlKey ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
        const shiftOk = infoShortcut.shiftKey ? e.shiftKey : !e.shiftKey;
        if (eKey === infoKey && ctrlOk && shiftOk) {
          e.preventDefault();
          toggleInfoPanel();
          return;
        }
      }

      // Legacy fallback: keep old shortcuts working for backward compat
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setHelpOpen((open) => !open);
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        if (useSessionStore.getState().isMapViewOpen) {
          closeMapView();
        } else {
          openMapView();
        }
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        toggleInfoPanel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeMapView, openMapView, toggleInfoPanel]);

  // Phase 5: Storage quota warning
  useEffect(() => {
    const threshold = getStorageThreshold();
    if (threshold === 'critical') {
      pushToast('error', 'Storage quota critically low. Please export your data and free up space.');
    } else if (threshold === 'warn') {
      pushToast('info', 'Storage space is running low. Consider exporting your data for backup.');
    }
  }, [pushToast, snapshot]);

  function handleHome() {
    flow.returnToVillage();
  }

  const noteMarkdownByRoomId = useMemo(() => {
    if (!snapshot) return {};
    return Object.fromEntries(
      Object.values(snapshot.rooms).map((room) => [room.roomId, room.noteText] as const),
    );
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) {
      setAttachmentUrlsByRoomId({});
      return;
    }

    let cancelled = false;
    const roomsWithLocalAttachments = Object.values(snapshot.rooms).filter((room) =>
      room.attachments.some((attachment) => attachment.sourceType === 'local'),
    );

    if (roomsWithLocalAttachments.length === 0) {
      setAttachmentUrlsByRoomId({});
      return;
    }

    void Promise.all(
      roomsWithLocalAttachments.map(async (room) => {
        const localAttachments = room.attachments.filter((attachment) => attachment.sourceType === 'local');
        const resolvedEntries = await Promise.all(
          localAttachments.map(async (attachment) => {
            const resolved = await resolveAttachmentUrl(room.roomId, attachment.attachmentId);
            return [attachment.attachmentId, resolved] as const;
          }),
        );
        const resolvedMap = Object.fromEntries(
          resolvedEntries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
        );
        return [room.roomId, resolvedMap] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setAttachmentUrlsByRoomId(Object.fromEntries(results));
    });

    return () => {
      cancelled = true;
    };
  }, [resolveAttachmentUrl, snapshot]);

  const reviewProgress = useMemo(() => {
    if (!snapshot) {
      return {
        fullReviewPasses: 0,
        nextPassTarget: 1,
        reviewedTowardNextPass: 0,
        totalRooms: 0,
      };
    }

    const reviewableRoomIds = snapshot.dungeon.rooms
      .map((summary) => summary.roomId)
      .filter((roomId) => {
        const room = snapshot.rooms[roomId];
        return room ? isReviewableRoom(room) : false;
      });
    const analytics = summarizeReviewAnalytics({
      rooms: snapshot.rooms,
      reviewableRoomIds,
      currentReviewStreak: 0,
      longestReviewStreak: 0,
    });
    const nextPassTarget = analytics.fullReviewPasses + 1;
    const reviewedTowardNextPass = snapshot.dungeon.rooms.filter((summary) => {
      const count = snapshot.rooms[summary.roomId]?.reviewPassCount ?? 0;
      return count >= nextPassTarget;
    }).length;

    return {
      fullReviewPasses: analytics.fullReviewPasses,
      nextPassTarget,
      reviewedTowardNextPass,
      totalRooms: snapshot.dungeon.rooms.length,
    };
  }, [snapshot]);

  if (!snapshot || !dungeonMap) {
    return <div>Loading dungeon…</div>;
  }

  const focusedRoom = focusedRoomId ? snapshot.rooms[focusedRoomId] ?? null : null;
  const subjectCollectedNotes = collectedNotes.filter(
    (entry) => entry.dungeonId === snapshot.dungeon.dungeonId,
  );
  const currentFloorLabel =
    focusedRoom && hierarchy
      ? hierarchy.floorLabelByFloorId[hierarchy.floorIdByRoomId[focusedRoom.roomId]]
      : snapshot.dungeon.subjectName;

  function handleTravelToRoom(roomId: string) {
    flow.travelToRoom(roomId);
  }

  function handleTeleport() {
    setClockMs(Date.now());
    if (teleportModeArmed) {
      cancelTeleportMode();
      return;
    }
    if (teleportRemainingMs > 0) return;
    armTeleportMode();
  }

  function handleTeleportToRoom(roomId: string) {
    flow.teleportToRoom(roomId);
  }

  function handleCloseOnboarding() {
    markGameplayLoopOnboardingSeen();
    setShowOnboarding(false);
  }

  const hudContent = (
    <Hud
      subjectName={snapshot.dungeon.subjectName}
      roomCount={snapshot.dungeon.rooms.length}
      xpTotal={xpTotal}
      rank={rank}
      reviewPassesCompleted={reviewProgress.fullReviewPasses}
      reviewRoomsTowardNextPass={reviewProgress.reviewedTowardNextPass}
      reviewNextPassTarget={reviewProgress.nextPassTarget}
      reviewTotalRooms={reviewProgress.totalRooms}
      phase={phase}
      currentFloorLabel={currentFloorLabel}
      teleportRemainingMs={teleportRemainingMs}
      teleportModeArmed={teleportModeArmed}
      phaseChangeNeedsConfirmation={phaseChangeNeedsConfirmation}
      showScribeNudge={showScribeNudge}
      infoOpen={isInfoPanelOpen}
      focusedRoomTopic={focusedRoom?.topic ?? null}
      inventoryCount={inventory.length}
      badgeCount={badges.length}
      journalCount={subjectCollectedNotes.length}
      onPhaseChange={setPhase}
      onHelp={() => { setMobileHudOpen(false); setHelpOpen(true); }}
      onOpenSettings={() => { setMobileHudOpen(false); setSettingsOpen(true); }}
      onOpenMap={() => { setMobileHudOpen(false); openMapView(); }}
      onTeleport={() => { setMobileHudOpen(false); handleTeleport(); }}
      onHome={() => { setMobileHudOpen(false); handleHome(); }}
      onToggleInfo={() => { setMobileHudOpen(false); toggleInfoPanel(); }}
      onOpenInventory={() => setInventoryView('inventory')}
      onOpenBadges={() => setInventoryView('badges')}
      onOpenJournal={() => setInventoryView('journal')}
    />
  );

  return (
    <div className="game-shell screen-fade-in">
      {isMobile ? (
        <HudDrawer>{hudContent}</HudDrawer>
      ) : (
        <div className="ui-skin hud-sidebar-wrapper" data-theme={colorTheme}>
          {hudContent}
        </div>
      )}

      <div className="game-area">
        <div className="game-canvas">
          {pixiDungeon && LazyPixiDungeonWorld !== null && worldModel !== null ? (
            // The Pixi chunk is lazy, so a build that requested it shows this status
            // sentence for the frames before it evaluates. `DungeonWorld` supplies its
            // own labelled interact, ascend, descend, and zoom controls plus the room
            // list, so the Phaser touch button below is deliberately not rendered here.
            <Suspense
              fallback={
                <p role="status" className="dungeon-renderer-status">
                  Loading the dungeon…
                </p>
              }
            >
              <LazyPixiDungeonWorld
                /*
                 * A callback ref, and it writes both refs on purpose.
                 *
                 * `rendererRef` is what every capability effect above reads, so a Pixi
                 * world whose handle lived only in `pixiDungeonRef` would leave
                 * `setFloorVisibility`, `teleportToRoom`, `setArtifactRooms`, and the
                 * rest silently inert - a floor change that changes nothing, with nothing
                 * in the build to say so. That is the Phase 12 defect class exactly, and
                 * the room-list/drawn-room disagreement the browser lane reports is how it
                 * surfaced.
                 *
                 * A callback ref rather than an effect because it runs before the
                 * capability effects, so a push that happens on the same commit cannot
                 * land before the handle exists.
                 */
                ref={(handle) => {
                  pixiDungeonRef.current = handle;
                  rendererRef.current = handle;
                }}
                world={worldModel}
                callbacks={stableCallbacks}
                colorTheme={colorTheme}
                onReady={() => setSceneReady(true)}
                // Room navigation goes through the flow, not straight to the renderer, so
                // the shared teleport cooldown applies to it exactly as it applies to the
                // full map.
                onNavigateToRoom={(roomId) => flow.teleportToRoom(roomId)}
              />
            </Suspense>
          ) : (
            <>
              <div className="game-canvas-host" ref={containerRef} />
              {sceneReady ? (
                <button
                  type="button"
                  className="touch-interact-btn"
                  aria-label="Interact with current room"
                  onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                  onClick={() => rendererRef.current?.triggerInteract()}
                >
                  ⚔
                </button>
              ) : null}
            </>
          )}
          {pixiDungeonMismatch ? (
            <p role="alert" className="dungeon-renderer-status">
              This build was asked for the PixiJS dungeon renderer but contains no PixiJS
              dungeon chunk. Build it with VITE_PIXI_DUNGEON=true.
            </p>
          ) : null}
          <Minimap
            dungeonMap={dungeonMap}
            colorTheme={colorTheme}
            focusedRoomId={focusedRoomId}
            visibleRoomIds={floorVisibility?.visibleRoomIds}
            portalUpRoomId={floorVisibility?.portalUpRoomId ?? null}
            portalDownRoomIds={floorVisibility?.portalDownRoomIds}
          />
          {isMobile ? (
            <FloatingActions
              onOpenMap={() => { setMobileHudOpen(false); openMapView(); }}
              onTeleport={() => { setMobileHudOpen(false); handleTeleport(); }}
              onOpenInventory={() => setInventoryView('inventory')}
            />
          ) : null}
          <MobileTouchHint />
        </div>
        <div className="game-ui ui-skin" data-theme={colorTheme}>
          {isInfoPanelOpen ? (
            <RoomPanel
              snapshot={snapshot}
              focusedRoom={focusedRoom}
              onInteract={() => {
                if (!focusedRoom) return;
                flow.roomInteract(focusedRoom.roomId);
              }}
              onClose={closeInfoPanel}
              onTravelToRoom={handleTravelToRoom}
              requestedTab={roomPanelTabRequest}
              reviewPassesCompleted={reviewProgress.fullReviewPasses}
              reviewRoomsTowardNextPass={reviewProgress.reviewedTowardNextPass}
              reviewNextPassTarget={reviewProgress.nextPassTarget}
              reviewTotalRooms={reviewProgress.totalRooms}
            />
          ) : null}

          <ToastStack toasts={toasts} onDismiss={dismissToast} />

          <TutorialOverlay
            subjectId={snapshot.dungeon.dungeonId}
            focusedRoomId={focusedRoomId}
            rooms={snapshot.rooms}
            isPanelOpen={isInfoPanelOpen}
          />

          {npcDialogRoomId && snapshot.rooms[npcDialogRoomId] ? (
            <RoomNpcDialog
              topic={snapshot.rooms[npcDialogRoomId].topic}
              phase={phase}
              roomState={snapshot.rooms[npcDialogRoomId].state}
              isCleared={snapshot.rooms[npcDialogRoomId].validationState.finalPass}
              anchorPosition={npcDialogAnchor}
            />
          ) : null}

          {/*
            One Scribe surface per room, chosen by the build-time flag. With the flag off
            - the production default - this is the pre-Phase-15 modal, rendered unchanged;
            its own unit test is the rollback lane's evidence that it still works.
          */}
          {SCRIBE_ENCOUNTER_WORKSPACE_ENABLED ? <ScribeEncounterDialog /> : <NoteEditorModal />}
          {isMapViewOpen ? (
            <FullMapView
              snapshot={snapshot}
              dungeonMap={dungeonMap}
              colorTheme={colorTheme}
              focusedRoomId={focusedRoomId}
              phase={phase}
              teleportModeArmed={teleportModeArmed}
              teleportRemainingMs={teleportRemainingMs}
              onTravelToRoom={handleTravelToRoom}
              onTeleportToRoom={handleTeleportToRoom}
              onClose={closeMapView}
            />
          ) : null}
          {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
          {showOnboarding ? (
            <GameplayOnboardingModal
              subjectName={snapshot.dungeon.subjectName}
              onClose={handleCloseOnboarding}
            />
          ) : null}
          {inventoryView ? (
            <InventoryBadgesPanel
              view={inventoryView}
              inventory={inventory}
              badges={badges}
              collectedNotes={subjectCollectedNotes}
              equippedItems={equippedItems}
              equipBonuses={getEquipBonuses()}
              onEquip={(id) => { equipItem(id); }}
              onUnequip={(id) => { unequipItem(id); }}
              noteMarkdownByRoomId={noteMarkdownByRoomId}
              subjectName={snapshot.dungeon.subjectName}
              clearedRoomCount={clearedRoomsCount}
              totalRoomCount={snapshot.dungeon.rooms.length}
              xpTotal={xpTotal}
              rank={rank}
              autoOpenNoteId={inventoryView === 'journal' ? autoOpenCollectedNoteId : null}
              resolveCollectedNoteImage={(roomId, attachmentId) =>
                attachmentUrlsByRoomId[roomId]?.[attachmentId] ?? null
              }
              onSwitchView={(v) => {
                setInventoryView(v);
                if (v !== 'journal') {
                  setAutoOpenCollectedNoteId(null);
                }
              }}
              onClose={() => {
                setInventoryView(null);
                setAutoOpenCollectedNoteId(null);
              }}
            />
          ) : null}

          {settingsOpen ? (
            <SettingsModal
              currentTheme={colorTheme}
              onThemeChange={setColorTheme}
              onClose={() => setSettingsOpen(false)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
