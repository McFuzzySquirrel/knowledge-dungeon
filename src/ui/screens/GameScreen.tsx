import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type Phaser from 'phaser';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph';
import { TELEPORT_COOLDOWN_MS, useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createGame } from '@/game/createGame';
import { generateDungeonMap } from '@/game/systems/dungeonGenerator';
import type { DungeonScene } from '@/game/scenes/DungeonScene';
import { Hud } from '@/ui/components/Hud';
import { RoomPanel } from '@/ui/components/RoomPanel';
import { NoteEditorModal } from '@/ui/components/NoteEditorModal';
import { TouchControls } from '@/ui/components/TouchControls';
import { Minimap } from '@/ui/components/Minimap';
import { HelpOverlay } from '@/ui/components/HelpOverlay';
import { FullMapView } from '@/ui/components/FullMapView';
import { isEditableElement } from '@/ui/utils/editableElement';
import { setActiveSubjectId as persistActiveSubjectId } from '@/services/persistence/subjectPersistence';

export function GameScreen(): JSX.Element {
  const snapshot = useSubjectStore((s) => s.snapshot);
  const setSnapshot = useSubjectStore((s) => s.setSnapshot);
  const setFocusedRoomId = useSessionStore((s) => s.setFocusedRoomId);
  const openNoteEditor = useSessionStore((s) => s.openNoteEditor);
  const focusedRoomId = useSessionStore((s) => s.focusedRoomId);
  const phase = useSessionStore((s) => s.phase);
  const setPhase = useSessionStore((s) => s.setPhase);
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
  const graphicsMode = usePreferencesStore((s) => s.graphicsMode);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<DungeonScene | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [sceneReady, setSceneReady] = useState(false);

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
      graphicsMode,
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
            void recordReviewPass(roomId);
            setFocusedRoomId(roomId);
          } else {
            openNoteEditor(roomId);
          }
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
  }, [dungeonMap, openNoteEditor, phase, recordReviewPass, selectedClass, setFocusedRoomId, graphicsMode]);

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
      />

      <TouchControls onInteract={() => sceneRef.current?.triggerInteract()} />

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
    </div>
  );
}
