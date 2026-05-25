import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type Phaser from 'phaser';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
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
  const recordReviewPass = useSubjectStore((s) => s.recordReviewPass);
  const xpTotal = useProgressionStore((s) => s.xpTotal);
  const rank = useProgressionStore((s) => s.rank);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<DungeonScene | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const dungeonMap = useMemo(() => {
    if (!snapshot) return null;
    return generateDungeonMap(snapshot.dungeon);
  }, [snapshot]);

  useEffect(() => {
    if (!dungeonMap || !containerRef.current) return;
    const game = createGame({
      parent: containerRef.current,
      dungeonMap,
      playerClass: selectedClass,
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
      },
    });
    gameRef.current = game;
    game.events.once('ready', () => {
      sceneRef.current = game.scene.getScene('DungeonScene') as DungeonScene;
    });
    return () => {
      game.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
    };
    // We intentionally do NOT depend on `phase` here — phase reads happen at
    // interact-time via the closure update below; rebuilding Phaser on phase
    // changes would tear down the game state unnecessarily.
  }, [dungeonMap, openNoteEditor, phase, recordReviewPass, selectedClass, setFocusedRoomId]);

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
    setSnapshot(null);
  }

  if (!snapshot || !dungeonMap) {
    return <div>Loading dungeon…</div>;
  }

  const focusedRoom = focusedRoomId ? snapshot.rooms[focusedRoomId] ?? null : null;

  return (
    <div className="game-shell">
      <Hud
        subjectName={snapshot.dungeon.subjectName}
        roomCount={snapshot.dungeon.rooms.length}
        xpTotal={xpTotal}
        rank={rank}
        phase={phase}
        onPhaseChange={setPhase}
        onHelp={() => setHelpOpen(true)}
        onOpenMap={openMapView}
        onHome={handleHome}
      />

      <div className="game-canvas">
        <div className="game-canvas-host" ref={containerRef} />
        <Minimap dungeonMap={dungeonMap} focusedRoomId={focusedRoomId} />
      </div>

      <RoomPanel
        snapshot={snapshot}
        focusedRoom={focusedRoom}
        onInteract={() => focusedRoom && openNoteEditor(focusedRoom.roomId)}
      />

      <TouchControls onInteract={() => sceneRef.current?.triggerInteract()} />

      <NoteEditorModal />
      {isMapViewOpen ? (
        <FullMapView
          dungeonMap={dungeonMap}
          focusedRoomId={focusedRoomId}
          onClose={closeMapView}
        />
      ) : null}
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}
