import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type Phaser from 'phaser';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph';
import { evaluatePhaseBadgeUnlocks } from '@/core/progression';
import { isReviewableRoom, summarizeReviewAnalytics } from '@/core/review';
import { TELEPORT_COOLDOWN_MS, useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import { createGame } from '@/game/createGame';
import { generateDungeonMap } from '@/game/systems/dungeonGenerator';
import type { DungeonScene } from '@/game/scenes/DungeonScene';
import { Hud } from '@/ui/components/Hud';
import { InventoryBadgesPanel } from '@/ui/components/InventoryBadgesPanel';
import { RoomPanel } from '@/ui/components/RoomPanel';
import { NoteEditorModal } from '@/ui/components/NoteEditorModal';
import { TouchControls } from '@/ui/components/TouchControls';
import { Minimap } from '@/ui/components/Minimap';
import { HelpOverlay } from '@/ui/components/HelpOverlay';
import { FullMapView } from '@/ui/components/FullMapView';
import { GameplayOnboardingModal } from '@/ui/components/GameplayOnboardingModal';
import { ToastStack } from '@/ui/components/ToastStack';
import { isEditableElement } from '@/ui/utils/editableElement';
import { useToasts } from '@/ui/utils/useToasts';
import {
  hasSeenGameplayLoopOnboarding,
  markGameplayLoopOnboardingSeen,
} from '@/ui/utils/onboarding';
import { setActiveSubjectId as persistActiveSubjectId } from '@/services/persistence/subjectPersistence';

export function GameScreen(): JSX.Element {
  const snapshot = useSubjectStore((s) => s.snapshot);
  const setSnapshot = useSubjectStore((s) => s.setSnapshot);
  const setFocusedRoomId = useSessionStore((s) => s.setFocusedRoomId);
  const openNoteEditor = useSessionStore((s) => s.openNoteEditor);
  const focusedRoomId = useSessionStore((s) => s.focusedRoomId);
  const phase = useSessionStore((s) => s.phase);
  const setPhase = useSessionStore((s) => s.setPhase);
  const isNoteEditorOpen = useSessionStore((s) => s.isNoteEditorOpen);
  const selectedClass = useSessionStore((s) => s.selectedClass);
  const setActiveSubjectId = useSessionStore((s) => s.setActiveSubjectId);
  const isMapViewOpen = useSessionStore((s) => s.isMapViewOpen);
  const openMapView = useSessionStore((s) => s.openMapView);
  const closeMapView = useSessionStore((s) => s.closeMapView);
  const teleportModeArmed = useSessionStore((s) => s.teleportModeArmed);
  const lastTeleportAt = useSessionStore((s) => s.lastTeleportAt);
  const armTeleportMode = useSessionStore((s) => s.armTeleportMode);
  const cancelTeleportMode = useSessionStore((s) => s.cancelTeleportMode);
  const markTeleported = useSessionStore((s) => s.markTeleported);
  const recordReviewPass = useSubjectStore((s) => s.recordReviewPass);
  const xpTotal = useProgressionStore((s) => s.xpTotal);
  const rank = useProgressionStore((s) => s.rank);
  const inventory = useProgressionStore((s) => s.inventory);
  const badges = useProgressionStore((s) => s.badges);
  const collectedNotes = useProgressionStore((s) => s.collectedNotes);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<DungeonScene | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [inventoryView, setInventoryView] = useState<null | 'inventory' | 'badges' | 'journal'>(
    null,
  );
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [sceneReady, setSceneReady] = useState(false);
  const [lastWelcomedSubjectId, setLastWelcomedSubjectId] = useState<string | null>(null);
  const { toasts, pushToast } = useToasts();

  const dungeonMap = useMemo(() => {
    if (!snapshot) return null;
    return generateDungeonMap(snapshot.dungeon);
  }, [snapshot]);
  const hierarchy = useMemo(
    () => (snapshot ? deriveGraphHierarchy(snapshot.dungeon) : null),
    [snapshot],
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

  useEffect(() => {
    if (teleportRemainingMs <= 0) return;
    const interval = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [teleportRemainingMs]);

  useEffect(() => {
    if (!dungeonMap || !containerRef.current) return;
    const initialFloor =
      hierarchy && snapshot
        ? computeFloorVisibility(
            hierarchy,
            snapshot.dungeon,
            currentFloorId ?? snapshot.dungeon.rootRoomId,
          )
        : null;
    const game = createGame({
      parent: containerRef.current,
      dungeonMap,
      playerClass: selectedClass,
      initialFloor: initialFloor
        ? {
            floorId: initialFloor.floorId,
            visibleRoomIds: initialFloor.visibleRoomIds,
            portalUpRoomId: initialFloor.portalUpRoomId,
            portalDownRoomIds: initialFloor.portalDownRoomIds,
          }
        : undefined,
      callbacks: {
        onRoomEntered: (roomId) => setFocusedRoomId(roomId),
        onInteract: (roomId) => {
          if (phase === 'archaeologist') {
            const liveSnapshot = useSubjectStore.getState().snapshot;
            void recordReviewPass(roomId);

            if (liveSnapshot) {
              const room = liveSnapshot.rooms[roomId];
              if (room && room.validationState.finalPass) {
                const roomsWithIncrement = {
                  ...liveSnapshot.rooms,
                  [roomId]: {
                    ...room,
                    reviewPassCount: room.reviewPassCount + 1,
                  },
                };
                const reviewableRoomIds = liveSnapshot.dungeon.rooms
                  .map((summary) => summary.roomId)
                  .filter((candidateRoomId) => {
                    const candidate = roomsWithIncrement[candidateRoomId];
                    return candidate ? isReviewableRoom(candidate) : false;
                  });
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
                  useProgressionStore.getState().badges,
                );
                if (unlockedBadges.length > 0) {
                  const progression = useProgressionStore.getState();
                  unlockedBadges.forEach((badgeId) => {
                    progression.awardBadge(badgeId);
                  });
                }
              }
            }

            setFocusedRoomId(roomId);
          } else {
            openNoteEditor(roomId);
          }
        },
        onArtifactCollected: (roomId) => {
          const liveSnapshot = useSubjectStore.getState().snapshot;
          if (!liveSnapshot) return;
          const room = liveSnapshot.rooms[roomId];
          if (!room?.artifactMarkdown) return;

          const liveHierarchy = deriveGraphHierarchy(liveSnapshot.dungeon);
          const floorId = liveHierarchy.floorIdByRoomId[roomId] ?? liveSnapshot.dungeon.rootRoomId;
          const floorLabel = liveHierarchy.floorLabelByFloorId[floorId] ?? liveSnapshot.dungeon.subjectName;
          const previewSource = room.noteText.trim().length > 0 ? room.noteText : room.artifactMarkdown;
          const preview = previewSource
            .replace(/^#\s+.*$/gm, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);

          useProgressionStore.getState().collectArtifactNote({
            dungeonId: liveSnapshot.dungeon.dungeonId,
            roomId,
            topic: room.topic,
            floorLabel,
            artifactPreview: preview,
            noteMarkdown: room.noteText.trim().length > 0 ? room.noteText : room.artifactMarkdown,
            artifactMarkdown: room.artifactMarkdown,
          });
        },
        onFloorTransition: ({ fromRoomId, direction }) => {
          const liveSnapshot = useSubjectStore.getState().snapshot;
          if (!liveSnapshot) return;
          const liveHierarchy = deriveGraphHierarchy(liveSnapshot.dungeon);
          // For both directions the destination room is the very portal the
          // player is standing on — we just swap which floor is "active" so
          // that room's neighbors become visible.
          const destinationFloorId =
            direction === 'up'
              ? liveHierarchy.floorIdByRoomId[fromRoomId] ?? liveSnapshot.dungeon.rootRoomId
              : liveHierarchy.floorIdByRoomId[fromRoomId] ?? fromRoomId;
          const nextVisibility = computeFloorVisibility(
            liveHierarchy,
            liveSnapshot.dungeon,
            destinationFloorId,
          );
          setCurrentFloorId(destinationFloorId);
          sceneRef.current?.setFloorVisibility({
            floorId: nextVisibility.floorId,
            visibleRoomIds: nextVisibility.visibleRoomIds,
            portalUpRoomId: nextVisibility.portalUpRoomId,
            portalDownRoomIds: nextVisibility.portalDownRoomIds,
          });
          sceneRef.current?.teleportToRoom(fromRoomId);
        },
      },
    });
    gameRef.current = game;
    game.events.once('ready', () => {
      sceneRef.current = game.scene.getScene('DungeonScene') as DungeonScene;
      setSceneReady(true);
    });
    return () => {
      game.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
      setSceneReady(false);
    };
    // We intentionally do NOT depend on `phase` or `currentFloorId` here —
    // phase reads happen at interact-time via the closure update below, and
    // floor changes are pushed via `scene.setFloorVisibility` to avoid
    // tearing down the Phaser game on every transition.
  }, [dungeonMap, openNoteEditor, phase, recordReviewPass, selectedClass, setFocusedRoomId]);

  useEffect(() => {
    if (!sceneReady || !snapshot) return;
    const scene = sceneRef.current;
    if (!scene) return;
    const artifactRoomIds = Object.values(snapshot.rooms)
      .filter((room) => room.validationState.finalPass)
      .map((room) => room.roomId);
    scene.setArtifactRooms(artifactRoomIds, phase === 'archaeologist');
  }, [sceneReady, snapshot, phase]);

  useEffect(() => {
    if (!snapshot) return;
    if (hasSeenGameplayLoopOnboarding()) return;
    setShowOnboarding(true);
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    if (lastWelcomedSubjectId === snapshot.dungeon.dungeonId) return;
    const totalRooms = snapshot.dungeon.rooms.length;
    const suggestedNextAction =
      clearedRoomsCount >= totalRooms && totalRooms > 0
        ? 'Review artifacts in Archaeologist phase.'
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
      // Ignore the help shortcut while typing in any text-input/textarea/
      // contenteditable so users can actually type a `?` character.
      if (isEditableElement(e.target)) return;
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
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeMapView, openMapView]);

  function handleHome() {
    // Clear the active subject so <App> falls back to <WelcomeScreen>, where
    // the user can pick an existing subject or create a new one.
    closeMapView();
    setFocusedRoomId(null);
    setActiveSubjectId(null);
    persistActiveSubjectId(null);
    cancelTeleportMode();
    setSnapshot(null);
  }

  const noteMarkdownByRoomId = useMemo(() => {
    if (!snapshot) return {};
    return Object.fromEntries(
      Object.values(snapshot.rooms).map((room) => [room.roomId, room.noteText] as const),
    );
  }, [snapshot]);

  if (!snapshot || !dungeonMap) {
    return <div>Loading dungeon…</div>;
  }

  const focusedRoom = focusedRoomId ? snapshot.rooms[focusedRoomId] ?? null : null;
  const currentFloorLabel =
    focusedRoom && hierarchy
      ? hierarchy.floorLabelByFloorId[hierarchy.floorIdByRoomId[focusedRoom.roomId]]
      : snapshot.dungeon.subjectName;

  function handleTravelToRoom(roomId: string) {
    syncFloorForRoom(roomId);
    sceneRef.current?.teleportToRoom(roomId);
  }

  function syncFloorForRoom(roomId: string) {
    if (!hierarchy || !snapshot) return;
    const targetFloorId =
      hierarchy.floorIdByRoomId[roomId] ?? snapshot.dungeon.rootRoomId;
    if (targetFloorId === currentFloorId) return;
    const nextVisibility = computeFloorVisibility(
      hierarchy,
      snapshot.dungeon,
      targetFloorId,
    );
    setCurrentFloorId(targetFloorId);
    sceneRef.current?.setFloorVisibility({
      floorId: nextVisibility.floorId,
      visibleRoomIds: nextVisibility.visibleRoomIds,
      portalUpRoomId: nextVisibility.portalUpRoomId,
      portalDownRoomIds: nextVisibility.portalDownRoomIds,
    });
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
    if (teleportRemainingMs > 0) return;
    syncFloorForRoom(roomId);
    sceneRef.current?.teleportToRoom(roomId);
    const now = Date.now();
    setClockMs(now);
    markTeleported(now);
    closeMapView();
  }

  function handleCloseOnboarding() {
    markGameplayLoopOnboardingSeen();
    setShowOnboarding(false);
  }

  return (
    <div className="game-shell">
      <Hud
        subjectName={snapshot.dungeon.subjectName}
        roomCount={snapshot.dungeon.rooms.length}
        xpTotal={xpTotal}
        rank={rank}
        phase={phase}
        currentFloorLabel={currentFloorLabel}
        teleportRemainingMs={teleportRemainingMs}
        teleportModeArmed={teleportModeArmed}
        phaseChangeNeedsConfirmation={phaseChangeNeedsConfirmation}
        showScribeNudge={showScribeNudge}
        onPhaseChange={setPhase}
        onHelp={() => setHelpOpen(true)}
        onOpenMap={openMapView}
        onTeleport={handleTeleport}
        onHome={handleHome}
      />

      <div className="game-canvas">
        <div className="game-canvas-host" ref={containerRef} />
        <Minimap
          dungeonMap={dungeonMap}
          focusedRoomId={focusedRoomId}
          visibleRoomIds={floorVisibility?.visibleRoomIds}
          portalUpRoomId={floorVisibility?.portalUpRoomId ?? null}
          portalDownRoomIds={floorVisibility?.portalDownRoomIds}
        />
      </div>

      <RoomPanel
        snapshot={snapshot}
        focusedRoom={focusedRoom}
        onInteract={() => focusedRoom && openNoteEditor(focusedRoom.roomId)}
        onTravelToRoom={handleTravelToRoom}
        inventoryCount={inventory.length}
        badgeCount={badges.length}
        journalCount={collectedNotes.length}
        onOpenInventory={() => setInventoryView('inventory')}
        onOpenBadges={() => setInventoryView('badges')}
        onOpenJournal={() => setInventoryView('journal')}
      />

      <TouchControls onInteract={() => sceneRef.current?.triggerInteract()} />
      <ToastStack toasts={toasts} />

      <NoteEditorModal />
      {isMapViewOpen ? (
        <FullMapView
          snapshot={snapshot}
          dungeonMap={dungeonMap}
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
          collectedNotes={collectedNotes}
          noteMarkdownByRoomId={noteMarkdownByRoomId}
          xpTotal={xpTotal}
          rank={rank}
          onSwitchView={(v) => setInventoryView(v)}
          onClose={() => setInventoryView(null)}
        />
      ) : null}
    </div>
  );
}
