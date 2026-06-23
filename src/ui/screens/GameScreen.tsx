import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type Phaser from 'phaser';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph';
import { evaluatePhaseBadgeUnlocks } from '@/core/progression';
import { isReviewableRoom, summarizeReviewAnalytics } from '@/core/review';
import { TELEPORT_COOLDOWN_MS, useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useShortcutStore } from '@/store/shortcutStore';
import { createGame } from '@/game/createGame';
import { generateDungeonMap } from '@/game/systems/dungeonGenerator';
import type { DungeonScene, NpcDialogAnchor } from '@/game/scenes/DungeonScene';
import { FLOOR_BIOME_IDS, type FloorBiomeId } from '@/game/systems/proceduralTextures';
import { Hud } from '@/ui/components/Hud';
import { HudDrawer } from '@/ui/components/HudDrawer';
import { FloatingActions } from '@/ui/components/FloatingActions';
import { InventoryBadgesPanel } from '@/ui/components/InventoryBadgesPanel';
import { RoomPanel } from '@/ui/components/RoomPanel';
import { TutorialOverlay } from '@/ui/components/TutorialOverlay';
import { MobileTouchHint } from '@/ui/components/MobileTouchHint';
import type { RoomTab } from '@/ui/components/RoomPanel';
import { NoteEditorModal } from '@/ui/components/NoteEditorModal';
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
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<DungeonScene | null>(null);
  const npcDialogRoomIdRef = useRef<string | null>(null);
  const roomPanelTabRequestSequenceRef = useRef(0);
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
  const [pendingReviewRoomId, setPendingReviewRoomId] = useState<string | null>(null);
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

  const handleRoomInteract = useCallback(
    (roomId: string) => {
      setMobileHudOpen(false);
      setNpcDialogRoomId(null);
      setNpcDialogAnchor(null);
      setFocusedRoomId(roomId);
      setPendingReviewRoomId(null);

      if (phase === 'creator') {
        requestRoomPanelTab('topic');
        setIsInfoPanelOpen(true);
        return;
      }

      if (phase === 'scribe') {
        openNoteEditor(roomId);
        return;
      }

      const liveSnapshot = useSubjectStore.getState().snapshot;

      if (liveSnapshot) {
        const room = liveSnapshot.rooms[roomId];
        if (room && room.validationState.finalPass) {
          setPendingReviewRoomId(roomId);
        }
      }

      requestRoomPanelTab('notes');
      setIsInfoPanelOpen(true);
    },
    [openNoteEditor, phase, requestRoomPanelTab, setFocusedRoomId, setMobileHudOpen],
  );

  const finalizePendingReview = useCallback(
    (roomId: string) => {
      const liveSnapshot = useSubjectStore.getState().snapshot;
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

      void recordReviewPass(roomId);
      const reviewProgression = shouldAwardReviewXp
        ? useProgressionStore.getState().awardReviewPass()
        : { xpGained: 0, newRank: useProgressionStore.getState().rank, rankChanged: false };

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
        useProgressionStore.getState().badges,
      );
      if (unlockedBadges.length > 0) {
        const progression = useProgressionStore.getState();
        unlockedBadges.forEach((badgeId) => {
          progression.awardBadge(badgeId);
        });
        pushToast(
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
      pushToast(
        'info',
        `Review recorded${xpMessage}: ${reviewedTowardNextPass}/${liveSnapshot.dungeon.rooms.length} rooms toward pass ${nextPassProgressTarget}. Completed full passes: ${analytics.fullReviewPasses}.`,
      );
    },
    [pushToast, recordReviewPass],
  );

  const closeInfoPanel = useCallback(() => {
    setIsInfoPanelOpen(false);
    if (phase === 'archaeologist' && pendingReviewRoomId) {
      finalizePendingReview(pendingReviewRoomId);
    }
    setPendingReviewRoomId(null);
  }, [finalizePendingReview, pendingReviewRoomId, phase]);

  const toggleInfoPanel = useCallback(() => {
    if (isInfoPanelOpen) {
      closeInfoPanel();
      return;
    }
    setIsInfoPanelOpen(true);
  }, [closeInfoPanel, isInfoPanelOpen]);

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
      colorTheme,
      playerClass: selectedClass,
      initialFloor: initialFloor
        ? {
            floorId: initialFloor.floorId,
            visibleRoomIds: initialFloor.visibleRoomIds,
            portalUpRoomId: initialFloor.portalUpRoomId,
            portalDownRoomIds: initialFloor.portalDownRoomIds,
            biomeId: (snapshot?.dungeon.biome && FLOOR_BIOME_IDS.includes(snapshot.dungeon.biome as FloorBiomeId)
              ? (snapshot.dungeon.biome as FloorBiomeId)
              : undefined),
          }
        : undefined,
      callbacks: {
        onRoomEntered: (roomId) => setFocusedRoomId(roomId),
        onNpcInteract: ({ roomId, clientX, clientY }: NpcDialogAnchor) => {
          setNpcDialogRoomId(roomId);
          setNpcDialogAnchor({ x: clientX, y: clientY });
          setFocusedRoomId(roomId);
        },
        onNpcDialogPosition: ({ roomId, clientX, clientY }: NpcDialogAnchor) => {
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
        onInteract: (roomId) => handleRoomInteract(roomId),
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
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);

          const collected = useProgressionStore.getState().collectArtifactNote({
            dungeonId: liveSnapshot.dungeon.dungeonId,
            roomId,
            topic: room.topic,
            floorLabel,
            artifactPreview: preview,
            noteMarkdown: room.noteText.trim().length > 0 ? room.noteText : room.artifactMarkdown,
            artifactMarkdown: room.artifactMarkdown,
          });

          if (collected) {
            setInventoryView('journal');
            setAutoOpenCollectedNoteId(`${liveSnapshot.dungeon.dungeonId}:${roomId}`);
          }
        },
        onFloorTransition: ({ fromRoomId, direction }) => {
          const liveSnapshot = useSubjectStore.getState().snapshot;
          if (!liveSnapshot) return;
          const liveHierarchy = deriveGraphHierarchy(liveSnapshot.dungeon);
          // For both directions the destination room is the very portal the
          // player is standing on - we just swap which floor is "active" so
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
            biomeId: (liveSnapshot.dungeon.biome && FLOOR_BIOME_IDS.includes(liveSnapshot.dungeon.biome as FloorBiomeId)
              ? (liveSnapshot.dungeon.biome as FloorBiomeId)
              : undefined),
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
  }, [
    colorTheme,
    dungeonMap,
    handleRoomInteract,
    hierarchy,
    selectedClass,
    setFocusedRoomId,
  ]);

  // Restart the dungeon scene when the user saves custom sprites and clicks "Apply Changes"
  useEffect(() => {
    if (sceneRestartCounter === 0) return;
    if (!gameRef.current) return;
    // Revoke old blob URLs before restarting so Phaser reloads fresh SVGs
    import('@/services/customSprites').then(({ revokeAllBlobUrls }) => revokeAllBlobUrls());
    const scene = gameRef.current.scene.getScene('DungeonScene');
    if (scene) scene.scene.restart();
    // Re-acquire scene reference on next ready
    gameRef.current.events.once('ready', () => {
      sceneRef.current = gameRef.current!.scene.getScene('DungeonScene') as DungeonScene;
    });
  }, [sceneRestartCounter]);

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
    if (!sceneReady || !snapshot) return;
    const scene = sceneRef.current;
    if (!scene) return;
    const subjectCollectedArtifactRoomIds = collectedNotes
      .filter((entry) => entry.dungeonId === snapshot.dungeon.dungeonId)
      .map((entry) => entry.roomId);
    scene.setCollectedArtifactRooms(subjectCollectedArtifactRoomIds);
  }, [sceneReady, snapshot, collectedNotes]);

  useEffect(() => {
    if (!sceneReady || !snapshot) return;
    const scene = sceneRef.current;
    if (!scene) return;
    const reviewedArtifactRoomIds =
      phase === 'archaeologist'
        ? Object.values(snapshot.rooms)
            .filter((room) => room.reviewPassCount > 0)
            .map((room) => room.roomId)
        : [];
    scene.setReviewedArtifactRooms(reviewedArtifactRoomIds);
  }, [phase, sceneReady, snapshot]);

  useEffect(() => {
    if (!sceneReady || !snapshot) return;
    const scene = sceneRef.current;
    if (!scene) return;
    const imageRoomIds = Object.values(snapshot.rooms)
      .filter((room) => room.attachments.length > 0)
      .map((room) => room.roomId);
    scene.setImageRooms(imageRoomIds);
  }, [sceneReady, snapshot]);

  useEffect(() => {
    if (!sceneReady || !snapshot) return;
    const scene = sceneRef.current;
    if (!scene) return;
    const roomStates: Record<string, string> = {};
    for (const room of snapshot.dungeon.rooms) {
      const meta = snapshot.rooms[room.roomId];
      roomStates[room.roomId] = meta?.state ?? room.status;
    }
    scene.setRoomOverlayStates(roomStates);
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
    closeMapView();
    setPendingReviewRoomId(null);
    setFocusedRoomId(null);
    setActiveSubjectId(null);
    persistActiveSubjectId(null);
    cancelTeleportMode();
    setProgressionActiveSubject(null);
    setActiveScreen('village');
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
      biomeId: (snapshot.dungeon.biome && FLOOR_BIOME_IDS.includes(snapshot.dungeon.biome as FloorBiomeId)
        ? (snapshot.dungeon.biome as FloorBiomeId)
        : undefined),
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
          <div className="game-canvas-host" ref={containerRef} />
          <Minimap
            dungeonMap={dungeonMap}
            colorTheme={colorTheme}
            focusedRoomId={focusedRoomId}
            visibleRoomIds={floorVisibility?.visibleRoomIds}
            portalUpRoomId={floorVisibility?.portalUpRoomId ?? null}
            portalDownRoomIds={floorVisibility?.portalDownRoomIds}
          />
          {sceneReady ? (
            <button
              type="button"
              className="touch-interact-btn"
              aria-label="Interact with current room"
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
              onClick={() => sceneRef.current?.triggerInteract()}
            >
              ⚔
            </button>
          ) : null}
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
                handleRoomInteract(focusedRoom.roomId);
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

          <NoteEditorModal />
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
