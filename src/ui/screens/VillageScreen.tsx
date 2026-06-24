import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useSessionStore, QUEST_LABELS, QUEST_ORDER, MANUAL_QUESTS, type QuestStep } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { usePreferencesStore, type ColorTheme } from '@/store/preferencesStore';
import { useProgressionStore } from '@/store/progressionStore';
import { useLoadSubjectFlow } from '@/ui/hooks/useLoadSubjectFlow';
import { createVillageGame } from '@/game/createVillageGame';
import type { VillageSceneEvents } from '@/game/scenes/VillageScene';
import { VILLAGE_MAP, type VillageStructure, getDungeonPortalSlots, getFishingPondPortalMap } from '@/data/villageLayout';
import { PLAYER_CLASSES, type PlayerClassId } from '@/game/systems/playerClasses';
import { FLOOR_BIOME_IDS, type FloorBiomeId } from '@/game/systems/proceduralTextures';
import { listSubjectIds, loadSubjectSnapshot, exportSubjectToJson, importSubjectFromJson, saveSubjectSnapshot } from '@/services/persistence/subjectPersistence';
import { createTutorialSubject, TUTORIAL_SUBJECT_ID } from '@/data/tutorialSubject';
import { GAME_GUIDE_MARKDOWN } from '@/data/gameGuide';
import { Markdown } from '@/ui/utils/markdown';
import { StudyStatsPanel } from '@/ui/components/StudyStatsPanel';
import { computeSessionStats } from '@/services/sessionTracker';
import { MakeItYoursModal } from '@/ui/components/MakeItYoursModal';
import { SettingsModal } from '@/ui/components/SettingsModal';
import { FishingRecallModal } from '@/ui/components/FishingRecallModal';
import { pullRecallQuestion, getClearedRooms } from '@/game/systems/fishingMechanics';
import type { SelfCheckPrompt } from '@/core/review/types';
import type { FishRarity } from '@/game/systems/fishingTypes';
import { FishStandPanel } from '@/ui/components/FishStandPanel';

interface SubjectSummary {
  id: string;
  subjectName: string;
  roomCount: number;
  clearedRoomCount: number;
}

export function VillageScreen(): JSX.Element {
  const setPhase = useSessionStore((s) => s.setPhase);
  const setSelectedClass = useSessionStore((s) => s.setSelectedClass);
  const selectedClass = useSessionStore((s) => s.selectedClass);
  const setActiveScreen = useSessionStore((s) => s.setActiveScreen);
  const questStep = useSessionStore((s) => s.questStep);
  const setQuestStep = useSessionStore((s) => s.setQuestStep);
  const advanceQuestStep = useSessionStore((s) => s.advanceQuestStep);
  const importSnapshot = useSubjectStore((s) => s.importSnapshot);
  const loadSubjectFlow = useLoadSubjectFlow();
  const colorTheme = usePreferencesStore((s) => s.colorTheme);
  const setColorTheme = usePreferencesStore((s) => s.setColorTheme);
  const sceneRestartCounter = useSessionStore((s) => s.sceneRestartCounter);
  const initSubject = useSubjectStore((s) => s.initSubject);
  const bySubject = useProgressionStore((s) => s.bySubject);
  const xpTotal = useProgressionStore((s) => s.xpTotal);
  const rank = useProgressionStore((s) => s.rank);
  const totalBadges = Object.values(bySubject).reduce((sum, s) => sum + s.badges.length, 0);
  const totalInventory = Object.values(bySubject).reduce((sum, s) => sum + s.inventory.length, 0);
  const totalNotes = Object.values(bySubject).reduce((sum, s) => sum + s.collectedNotes.length, 0);
  const sessionStats = useMemo(() => computeSessionStats(), []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<VillageSceneHandle | null>(null);

  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [infoPanel, setInfoPanel] = useState<{
    type: 'dungeon' | 'keeper' | 'guild' | 'training' | 'trophy' | 'signpost' | 'waysign' | 'quest-board' | 'library' | 'workshop' | 'fountain' | 'fishing-pond' | 'fish-stand';
    structureId: string;
    subject?: SubjectSummary;
  } | null>(null);
  const [keeperDialogue, setKeeperDialogue] = useState<string | null>(null);
  const [, setKeeperDialogueIndex] = useState(0);
  const [activeNpcId, setActiveNpcId] = useState<string | null>(null);
  const [activeNpcLabel, setActiveNpcLabel] = useState<string | null>(null);
  const [npcDialogPos, setNpcDialogPos] = useState<{ x: number; y: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [anchoredStyle, setAnchoredStyle] = useState<React.CSSProperties | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [hudOpen, setHudOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(() => {
    try { return window.matchMedia('(max-width: 768px)').matches; }
    catch { return false; }
  });

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const [createTopic, setCreateTopic] = useState('');
  const [createBiome, setCreateBiome] = useState<FloorBiomeId>(FLOOR_BIOME_IDS[0]);
  const [submitting, setSubmitting] = useState(false);
  const NPC_ICONS: Record<string, string> = {
    keeper: '🧙',
    'villager-1': '📚',
    'villager-2': '🧭',
    'villager-3': '❓',
    'villager-4': '🦉',
    'villager-5': '📜',
  };

  const [welcomeMessage, setWelcomeMessage] = useState<string | null>(null);
  const [villageReady, setVillageReady] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [dungeonBiome, setDungeonBiome] = useState<string | null>(null);
  const [showFullGuide, setShowFullGuide] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [makeItYoursOpen, setMakeItYoursOpen] = useState(false);
  const [showFishStand, setShowFishStand] = useState(false);
  const [fishCaughtData, setFishCaughtData] = useState<{
    fishName: string; rarity: string; catalogId: string; description: string;
  } | null>(null);
  const [showRecallModal, setShowRecallModal] = useState(false);
  const [recallQuestionData, setRecallQuestionData] = useState<{
    prompt: SelfCheckPrompt; roomId: string;
  } | null>(null);

  const FISHING_HINT_KEY = 'knowledge-dungeon:ui:fishing-hint:v1';
  const [fishingHintVisible, setFishingHintVisible] = useState(() => {
    try { return window.localStorage.getItem(FISHING_HINT_KEY) !== '1'; }
    catch { return false; }
  });

  // Track previous info panel type to detect when the fishing pond panel closes
  const prevInfoPanelTypeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!infoPanel && prevInfoPanelTypeRef.current === 'fishing-pond' && fishingHintVisible) {
      try { window.localStorage.setItem(FISHING_HINT_KEY, '1'); } catch { /* ignore */ }
      setFishingHintVisible(false);
    }
    prevInfoPanelTypeRef.current = infoPanel?.type ?? null;
  }, [infoPanel, fishingHintVisible]);

  const handleStartFishing = useCallback((pondId: string) => {
    const game = gameRef.current;
    if (!game) return;
    setInfoPanel(null);
    setFishCaughtData(null);
    setShowRecallModal(false);
    setRecallQuestionData(null);

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
        const currentSubjects = subjectsRef.current;
        if (slotIndex < currentSubjects.length) {
          hasClearedRooms = currentSubjects[slotIndex].clearedRoomCount > 0;
        }
      }
    }

    game.scene.getScene('VillageScene')?.scene.sleep();
    game.scene.start('FishingScene', {
      callbacks: {
        onFishCaught: (data: { fishName: string; rarity: string; catalogId: string; description: string }) => {
          setFishCaughtData(data);
        },
        onReturnToVillage: () => {
          setTimeout(() => {
            const g = gameRef.current;
            if (g) {
              g.scene.stop('FishingScene');
              g.scene.getScene('VillageScene')?.scene.wake();
            }
          }, 0);
        },
        onReady: () => {},
      },
      playerClass: selectedClass ?? 'scholar',
      hasClearedRooms,
    });
  }, [selectedClass]);

  const addFishToCollection = useProgressionStore((s) => s.addFish);

  const handleKeepFish = useCallback((data: typeof fishCaughtData) => {
    if (!data) return;
    // Find a subject to associate the fish with - prefer the most recently active one
    const subjectIds = Object.keys(useProgressionStore.getState().bySubject);
    const subjectId = subjectIds.length > 0 ? subjectIds[subjectIds.length - 1] : 'village';
    const subjectName = useSubjectStore.getState().snapshot?.dungeon.subjectName || subjectId;
    const rarity = data.rarity as FishRarity;
    addFishToCollection({
      name: data.fishName,
      rarity,
      subjectId,
      subjectName,
    });
    // Award XP for correctly answering the recall question
    const progression = useProgressionStore.getState();
    const xpResult = progression.awardFishingXp(rarity);
    console.log(`[Fishing] XP gained: ${xpResult.xpGained} (${rarity}), rank: ${xpResult.newRank}${xpResult.rankChanged ? ' ⬆' : ''}`);
    // Check for newly earned fishing badges
    const newBadges = progression.checkFishingBadges();
    if (newBadges.length > 0) {
      console.log(`[Fishing] New badges earned: ${newBadges.join(', ')}`);
    }
    setFishCaughtData(null);
    setShowRecallModal(false);
    setRecallQuestionData(null);
  }, [addFishToCollection]);

  const handleKeepFishClicked = useCallback(async (_data: NonNullable<typeof fishCaughtData>) => {
    // Compute the recall question from the active subject's dungeon data
    const activeSubjectId = useProgressionStore.getState().activeSubjectId;
    if (activeSubjectId) {
      try {
        const snapshot = await loadSubjectSnapshot(activeSubjectId);
        if (snapshot) {
          const clearedRooms = getClearedRooms(snapshot.rooms);
          const question = pullRecallQuestion({
            clearedRooms,
            dungeonRooms: snapshot.dungeon.rooms,
            subjectName: snapshot.dungeon.subjectName,
          });
          setRecallQuestionData(question);
        } else {
          setRecallQuestionData(null);
        }
      } catch {
        setRecallQuestionData(null);
      }
    } else {
      setRecallQuestionData(null);
    }
    setShowRecallModal(true);
  }, []);

  const refreshSubjects = useCallback(async () => {
    try {
      const ids = await listSubjectIds();
      const snapshots = await Promise.all(ids.map((id) => loadSubjectSnapshot(id)));
      const summaries: SubjectSummary[] = ids.map((id, i) => {
        const s = snapshots[i];
        return {
          id,
          subjectName: s?.dungeon.subjectName ?? id,
          roomCount: s?.dungeon.rooms.length ?? 0,
          clearedRoomCount: s
            ? Object.values(s.rooms).filter((r) => r.validationState.finalPass).length
            : 0,
        };
      });
      setSubjects(summaries);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshSubjects();
  }, [refreshSubjects]);

  // Reset biome when create modal opens
  useEffect(() => {
    if (createOpen) setCreateBiome(FLOOR_BIOME_IDS[0]);
  }, [createOpen]);

  // Load biome when inspecting a dungeon
  useEffect(() => {
    if (infoPanel?.type === 'dungeon' && infoPanel.subject) {
      void loadSubjectSnapshot(infoPanel.subject.id).then((snap) => {
        if (snap) setDungeonBiome(snap.dungeon.biome ?? FLOOR_BIOME_IDS[0]);
      });
    }
  }, [infoPanel]);

  // Advance quest when archetype selected
  useEffect(() => {
    if (selectedClass && questStep === 'pick-archetype') {
      advanceQuestStep();
    }
  }, [selectedClass, questStep, advanceQuestStep]);

  const dynamicStructures = useMemo((): VillageStructure[] => {
    const slots = getDungeonPortalSlots();
    return subjects.slice(0, slots.length).map((subj, i) => ({
      id: `portal-${subj.id}`,
      type: 'portal-icon' as const,
      label: subj.subjectName,
      gridX: slots[i].gridX,
      gridY: slots[i].gridY,
      width: 2,
      height: 3,
      subjectId: subj.id,
      subjectName: subj.subjectName,
      roomCount: subj.roomCount,
      clearedCount: subj.clearedRoomCount,
    }));
  }, [subjects]);

  // Ref-based callbacks: Phaser captures the ref, always reads fresh values
  const subjectsRef = useRef(subjects);
  subjectsRef.current = subjects;
  const selectedClassRef = useRef(selectedClass);
  selectedClassRef.current = selectedClass;
  const dynamicStructuresRef = useRef(dynamicStructures);
  dynamicStructuresRef.current = dynamicStructures;

  const callbacksRef = useRef<VillageSceneEvents>({
    onStructureApproached: () => {},
    onStructureLeft: () => {},
    onStructureInteract: () => {},
    onNpcApproached: () => {},
    onNpcLeft: () => {},
    onNpcInteract: () => {},
    onNpcDialogPosition: () => {},
    onReady: () => {},
  });

  // Keep callbacks ref in sync with latest React state
  useEffect(() => {
    const cb: VillageSceneEvents = {
      onStructureApproached: (structureId) => {
        const struct = [...VILLAGE_MAP.structures, ...dynamicStructuresRef.current]
          .find((s) => s.id === structureId);
        if (!struct) return;
        const sType = struct.type;
        if (sType === 'portal-icon') {
          const subj = subjectsRef.current.find((s) => s.id === struct.subjectId);
          setInfoPanel({ type: 'dungeon', structureId, subject: subj });
        } else if (sType === 'keeper-tower') {
          setInfoPanel({ type: 'quest-board', structureId });
        } else if (sType === 'guild-hall') {
          setInfoPanel({ type: 'guild', structureId });
        } else if (sType === 'training-gate') {
          setInfoPanel({ type: 'training', structureId });
        } else if (sType === 'trophy-hall') {
          setInfoPanel({ type: 'trophy', structureId });
        } else if (sType === 'signpost' || sType === 'waysign') {
          setInfoPanel({ type: 'signpost', structureId });
          if (structureId === 'sign-entrance') {
            setWelcomeMessage('Welcome to the Dungeon Village! Explore the buildings, meet the Keeper, and step through a portal to begin your studies.');
          }
        } else if (sType === 'library') {
          setInfoPanel({ type: 'library', structureId });
        } else if (sType === 'workshop') {
          setInfoPanel({ type: 'workshop', structureId });
        } else if (sType === 'fountain') {
          setInfoPanel({ type: 'fountain', structureId });
        } else if (sType === 'fishing-pond') {
          setInfoPanel({ type: 'fishing-pond', structureId });
        } else if (sType === 'fish-stand') {
          setInfoPanel({ type: 'fish-stand', structureId });
        }
      },
      onStructureLeft: (structureId) => {
        setInfoPanel(null);
        if (structureId === 'sign-entrance') {
          setWelcomeMessage(null);
        }
      },
      onStructureInteract: (structureId) => {
        const struct = [...VILLAGE_MAP.structures, ...dynamicStructuresRef.current]
          .find((s) => s.id === structureId);
        if (!struct) return;
        const sType = struct.type;
        if (sType === 'portal-icon' && struct.subjectId) {
          const session = useSessionStore.getState();
          session.setPhase('scribe');
          session.setSelectedClass(selectedClassRef.current || 'scholar');
          const subjStore = useSubjectStore.getState();
          void subjStore.loadSubject(struct.subjectId).then((loaded) => {
            if (loaded) {
              session.setActiveSubjectId(loaded.dungeon.dungeonId);
              useProgressionStore.getState().setActiveSubject(loaded.dungeon.dungeonId);
              session.setActiveScreen('game');
            }
          });
        } else if (sType === 'keeper-tower') {
          setInfoPanel({ type: 'quest-board', structureId });
        } else if (sType === 'guild-hall') {
          setCreateOpen(true);
          useSessionStore.getState().advanceQuestStep();
        } else if (sType === 'training-gate') {
          const tutorial = createTutorialSubject();
          const session = useSessionStore.getState();
          const subjStore = useSubjectStore.getState();
          void subjStore.importSnapshot(tutorial).then(() => {
            session.setPhase('scribe');
            session.setSelectedClass('scholar');
            session.setQuestStep('enter-dungeon');
            return subjStore.loadSubject(TUTORIAL_SUBJECT_ID).then((loaded) => {
              if (loaded) {
                session.setActiveSubjectId(loaded.dungeon.dungeonId);
                session.setActiveScreen('game');
              }
            });
          });
        } else if (sType === 'trophy-hall') {
          setInfoPanel({ type: 'trophy', structureId });
        } else if (sType === 'signpost' || sType === 'waysign') {
          setInfoPanel({ type: 'signpost', structureId });
        } else if (sType === 'library') {
          setInfoPanel({ type: 'library', structureId });
        } else if (sType === 'workshop') {
          setMakeItYoursOpen(true);
        } else if (sType === 'fountain') {
          setShowStats(true);
        } else if (sType === 'fishing-pond') {
          handleStartFishing(structureId);
        } else if (sType === 'fish-stand') {
          setInfoPanel({ type: 'fish-stand', structureId });
        }
      },
      onNpcApproached: (npcId) => {
        const npc = VILLAGE_MAP.npcs.find((n) => n.id === npcId);
        if (!npc) return;
        setActiveNpcId(npcId);
        setActiveNpcLabel(npc.label);
        if (npcId === 'keeper') {
          const session = useSessionStore.getState();
          if (session.questStep === 'intro' || session.questStep === 'meet-keeper') {
            session.setQuestStep('meet-keeper');
          }
          const questLines = npc.questDialogue?.[session.questStep];
          if (questLines && questLines.length > 0) {
            setKeeperDialogue(questLines[0]);
          } else {
            setKeeperDialogue(npc.greeting);
          }
        } else {
          // Wandering NPC - show random quote
          const quotes = npc.quotes ?? [];
          const quote = quotes.length > 0 ? quotes[Math.floor(Math.random() * quotes.length)] : npc.greeting;
          setKeeperDialogue(quote);
        }
        setKeeperDialogueIndex(0);
      },
      onNpcLeft: () => { setKeeperDialogue(null); setKeeperDialogueIndex(0); setActiveNpcId(null); setActiveNpcLabel(null); },
      onNpcInteract: (npcId) => {
        const npc = VILLAGE_MAP.npcs.find((n) => n.id === npcId);
        if (!npc) return;
        if (npcId === 'keeper') {
          const session = useSessionStore.getState();
          const questLines = npc.questDialogue?.[session.questStep];
          if (questLines && questLines.length > 0) {
            setKeeperDialogueIndex((prev) => {
              const next = (prev + 1) % questLines.length;
              setKeeperDialogue(questLines[next]);
              return next;
            });
          } else {
            setKeeperDialogueIndex((prev) => {
              const next = (prev + 1) % npc.dialogue.length;
              setKeeperDialogue(npc.dialogue[next]);
              return next;
            });
          }
        } else {
          const quotes = npc.quotes ?? npc.dialogue;
          setKeeperDialogueIndex((prev) => {
            const next = (prev + 1) % quotes.length;
            setKeeperDialogue(quotes[next]);
            return next;
          });
        }
      },
      onNpcDialogPosition: (pos) => {
        setNpcDialogPos({ x: pos.clientX, y: pos.clientY });
      },
      onReady: () => {
        if (gameRef.current) {
          sceneRef.current = gameRef.current.scene.getScene('VillageScene') as unknown as VillageSceneHandle;
          setVillageReady(true);
        }
      },
    };
    Object.assign(callbacksRef.current, cb);
  }, [subjects, dynamicStructures, selectedClass]);

  // Mount Phaser game once - it reads from callbacksRef
  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;
    const ref = callbacksRef;
    let spawnGridX: number | null = null;
    let spawnGridY: number | null = null;
    try {
      const raw = localStorage.getItem('kd-village-spawn');
      if (raw) {
        const parsed = JSON.parse(raw);
        spawnGridX = parsed.gridX;
        spawnGridY = parsed.gridY;
        localStorage.removeItem('kd-village-spawn');
      }
    } catch { /* ignore */ }
    const game = createVillageGame({
      parent: containerRef.current,
      callbacks: {
        onStructureApproached: (id) => ref.current.onStructureApproached(id),
        onStructureLeft: (id) => ref.current.onStructureLeft(id),
        onStructureInteract: (id) => ref.current.onStructureInteract(id),
        onNpcApproached: (id) => ref.current.onNpcApproached(id),
        onNpcLeft: (id) => ref.current.onNpcLeft(id),
        onNpcInteract: (id) => ref.current.onNpcInteract(id),
        onNpcDialogPosition: (p) => ref.current.onNpcDialogPosition?.(p),
        onReady: () => ref.current.onReady(),
      },
      dynamicStructures: dynamicStructures.length > 0 ? dynamicStructures : undefined,
      playerClass: selectedClass ?? 'scholar',
      spawnGridX,
      spawnGridY,
    });
    gameRef.current = game;
    game.events.once('ready', () => {
      sceneRef.current = game.scene.getScene('VillageScene') as unknown as VillageSceneHandle;
      setVillageReady(true);
    });
    return () => {
      game.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  // Restart the village scene when the user saves custom sprites and clicks "Apply Changes"
  useEffect(() => {
    if (sceneRestartCounter === 0) return;
    if (!gameRef.current) return;
    setVillageReady(false);
    import('@/services/customSprites').then(({ revokeAllBlobUrls }) => revokeAllBlobUrls());
    const scene = gameRef.current.scene.getScene('VillageScene');
    if (scene) scene.scene.restart();
  }, [sceneRestartCounter]);

  // Sync scene state whenever the scene is ready OR the data changes
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setDynamicStructures(dynamicStructures);
    scene.setPlayerClass(selectedClass ?? 'scholar');
  }, [villageReady, dynamicStructures, selectedClass]);

  // Show welcome message on village entry
  const handleStartTutorial = async () => {
    const tutorial = createTutorialSubject();
    await importSnapshot(tutorial);
    setPhase('scribe');
    setSelectedClass('scholar');
    setQuestStep('enter-dungeon');
    await loadSubjectFlow(TUTORIAL_SUBJECT_ID);
    setActiveScreen('game');
  };

  const handleCreateSubject = async () => {
    if (!createName.trim() || !createTopic.trim()) return;
    setSubmitting(true);
    try {
      await initSubject({
        subjectName: createName.trim(),
        rootTopic: createTopic.trim(),
        biome: createBiome,
      });
      await refreshSubjects();
      advanceQuestStep();
      setCreateName('');
      setCreateTopic('');
      setCreateBiome(FLOOR_BIOME_IDS[0]);
      setCreateOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  useLayoutEffect(() => {
    if (!npcDialogPos) {
      setAnchoredStyle(null);
      return;
    }

    const margin = 12;
    const updatePosition = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      const dialogWidth = dialog.offsetWidth || 360;
      const dialogHeight = dialog.offsetHeight || 140;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const preferRight = npcDialogPos.x + dialogWidth + 24 <= vw - margin;
      const preferredLeft = preferRight
        ? npcDialogPos.x + 24
        : npcDialogPos.x - dialogWidth - 24;

      const preferredTopAbove = npcDialogPos.y - dialogHeight - 8;
      const preferredTop =
        preferredTopAbove >= margin ? preferredTopAbove : npcDialogPos.y + 8;

      const maxLeft = Math.max(margin, vw - dialogWidth - margin);
      const maxTop = Math.max(margin, vh - dialogHeight - margin);

      const left = Math.min(Math.max(preferredLeft, margin), maxLeft);
      const top = Math.min(Math.max(preferredTop, margin), maxTop);

      setAnchoredStyle({ left: `${left}px`, top: `${top}px` });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [npcDialogPos]);

  useLayoutEffect(() => {
    if (!keeperDialogue) {
      setNpcDialogPos(null);
    }
  }, [keeperDialogue]);

  return (
    <>
    <div className="village-screen ui-skin screen-fade-in" data-theme={colorTheme}>
      {isMobile ? (
        <>
          <button type="button" className="village-hud-toggle" onClick={() => setHudOpen(!hudOpen)}
            aria-label={hudOpen ? 'Close HUD' : 'Open HUD'}>
            {hudOpen ? '✕' : '☰'}
          </button>
          <div className={`village-hud ui-skin village-hud--mobile${hudOpen ? ' village-hud--open' : ' village-hud--hidden'}`}
            data-theme={colorTheme}>
            <VillageHudContent questStep={questStep} subjects={subjects}
              selectedClass={selectedClass}               setSelectedClass={(c) => setSelectedClass(c as PlayerClassId ?? null)}
              setCreateOpen={setCreateOpen} setDataOpen={setDataOpen}
              colorTheme={colorTheme} setColorTheme={(t) => setColorTheme(t as ColorTheme)}
              onQuestClick={(step: string) => {
                setQuestStep(step as QuestStep);
                const keeper = VILLAGE_MAP.npcs.find((n) => n.id === 'keeper');
                if (keeper) {
                  const lines = keeper.questDialogue?.[step];
                  if (lines?.length) { setKeeperDialogue(lines[0]); setKeeperDialogueIndex(0); }
                }
              }}
              onStatsClick={() => setShowStats(true)}
              onSettingsClick={() => setSettingsOpen(true)} />
          </div>
        </>
      ) : (
        <div className="village-hud-wrapper">
          <div className="village-hud ui-skin" data-theme={colorTheme}>
            <VillageHudContent questStep={questStep} subjects={subjects}
              selectedClass={selectedClass} setSelectedClass={(c) => setSelectedClass(c as PlayerClassId ?? null)}
              setCreateOpen={setCreateOpen} setDataOpen={setDataOpen}
              colorTheme={colorTheme} setColorTheme={(t) => setColorTheme(t as ColorTheme)}
              onQuestClick={(step: string) => {
                setQuestStep(step as QuestStep);
                const keeper = VILLAGE_MAP.npcs.find((n) => n.id === 'keeper');
                if (keeper) {
                  const lines = keeper.questDialogue?.[step];
                  if (lines?.length) { setKeeperDialogue(lines[0]); setKeeperDialogueIndex(0); }
                }
              }}
              onStatsClick={() => setShowStats(true)}
              onSettingsClick={() => setSettingsOpen(true)} />
          </div>
        </div>
      )}

      <div className="village-game-area">
        <div className="village-canvas" ref={containerRef} />
        <CompassOverlay sceneRef={sceneRef} />
        <button type="button" className="touch-interact-btn"
          aria-label="Interact" style={{ zIndex: 150 }}
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onClick={() => {
            const s = sceneRef.current;
            if (s?.triggerInteract) s.triggerInteract();
          }}>
          ⚔
        </button>
      </div>

      {infoPanel?.type === 'dungeon' && infoPanel.subject ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">🌀</span>
            <div>
              <h3>{infoPanel.subject.subjectName}</h3>
              <p className="village-info-meta">
                {infoPanel.subject.clearedRoomCount}/{infoPanel.subject.roomCount} rooms cleared
              </p>
            </div>
          </div>
          {dungeonBiome !== null ? (
            <div style={{ padding: '0 4px' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Biome</label>
              <select
                value={dungeonBiome}
                onChange={(e) => {
                  const newBiome = e.target.value;
                  setDungeonBiome(newBiome);
                  void loadSubjectSnapshot(infoPanel.subject!.id).then((snap) => {
                    if (snap) {
                      snap.dungeon.biome = newBiome;
                      return saveSubjectSnapshot(snap.dungeon.dungeonId, snap);
                    }
                  });
                }}
                style={{ width: '100%', padding: '6px 10px', borderRadius: 6, fontSize: 12 }}
              >
                {FLOOR_BIOME_IDS.map((biome) => (
                  <option key={biome} value={biome}>
                    {biome.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="village-info-actions">
            <button
              type="button"
              className="village-enter-btn"
              disabled={!selectedClass}
              onClick={() => {
                if (infoPanel.subject) {
                  setPhase('scribe');
                  setSelectedClass(selectedClass ?? 'scholar');
                  void loadSubjectFlow(infoPanel.subject.id).then(() => {
                    setActiveScreen('game');
                  });
                }
              }}
            >
              Enter Dungeon
            </button>
            {!selectedClass ? (
              <p className="village-info-hint">Select an archetype above first</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {infoPanel?.type === 'keeper' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">🏛</span>
            <div>
              <h3>Keeper's Tower</h3>
              <p className="village-info-meta">Home of the guide NPC</p>
            </div>
          </div>
          <p className="village-info-desc">
            The Keeper of Knowledge resides here. Approach them to receive guidance
            on creating and clearing your first dungeon.
          </p>
          <div className="village-info-actions">
            <button type="button" className="village-action-btn" onClick={() => setCreateOpen(true)}>
              Create New Subject
            </button>
          </div>
        </div>
      ) : null}

      {infoPanel?.type === 'guild' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">⚒</span>
            <div>
              <h3>Guild Hall</h3>
              <p className="village-info-meta">Create and manage subjects</p>
            </div>
          </div>
          <p className="village-info-desc">
            Here you can create new subjects to study. Each subject becomes a new
            dungeon to explore and conquer.
          </p>
          <div className="village-info-actions" style={{ flexDirection: 'column', gap: 8 }}>
            {subjects.length > 0 ? (
              <div className="village-subject-list">
                <strong>Your dungeons:</strong>
                {subjects.map((subj) => (
                  <div key={subj.id} className="village-subject-item">
                    <span>{subj.subjectName}</span>
                    <span className="village-info-meta">
                      {subj.clearedRoomCount}/{subj.roomCount} cleared
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="village-info-meta">No dungeons yet. Create your first!</p>
            )}
            <button type="button" className="village-action-btn" onClick={() => setCreateOpen(true)}>
              + Create New Subject
            </button>
          </div>
        </div>
      ) : null}

      {infoPanel?.type === 'training' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">🎓</span>
            <div>
              <h3>Training Grounds</h3>
              <p className="village-info-meta">Learn the basics</p>
            </div>
          </div>
          <p className="village-info-desc">
            New to Knowledge Dungeon? The training grounds offer a guided 3-room
            tutorial covering notes, attachments, navigation, and more.
          </p>
          <div className="village-info-actions">
            <button
              type="button"
              className="village-action-btn village-action-btn--tutorial"
              onClick={() => { void handleStartTutorial(); }}
            >
              Start Tutorial
            </button>
          </div>
        </div>
      ) : null}

      {infoPanel?.type === 'trophy' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">🏆</span>
            <div>
              <h3>Trophy Hall</h3>
              <p className="village-info-meta">Your collection across all dungeons</p>
            </div>
          </div>
          <div className="village-subject-list" style={{ gap: 6 }}>
            <div className="village-subject-item">
              <span>🏅 Badges</span>
              <strong>{totalBadges}</strong>
            </div>
            <div className="village-subject-item">
              <span>🎒 Artifacts</span>
              <strong>{totalInventory}</strong>
            </div>
            <div className="village-subject-item">
              <span>📚 Journal entries</span>
              <strong>{totalNotes}</strong>
            </div>
            <div className="village-subject-item">
              <span>🌀 Dungeons</span>
              <strong>{subjects.length}</strong>
            </div>
          </div>
        </div>
      ) : null}

      {infoPanel?.type === 'library' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">📖</span>
            <div>
              <h3>Library of Knowledge</h3>
              <p className="village-info-meta">Game guide & help</p>
            </div>
          </div>
          <div className="village-info-actions" style={{ marginBottom: 8 }}>
            <button
              type="button"
              className="village-action-btn"
              onClick={() => setShowFullGuide((v) => !v)}
            >
              {showFullGuide ? 'Quick Reference' : 'Full Guide'}
            </button>
          </div>
          {showFullGuide ? (
            <div className="markdown-body" style={{ maxHeight: '60vh', overflowY: 'auto', padding: '0 4px', fontSize: 13 }}>
              <Markdown source={GAME_GUIDE_MARKDOWN} />
            </div>
          ) : (
            <div className="village-subject-list" style={{ gap: 6 }}>
            <div className="village-subject-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <strong>🎮 Controls</strong>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / Arrow keys - Move<br/>
                <kbd>E</kbd> - Interact with buildings & NPCs<br/>
                <kbd>M</kbd> - Open dungeon map<br/>
                <kbd>I</kbd> - Toggle room info panel<br/>
                <kbd>H</kbd> - Return to village<br/>
                <kbd>?</kbd> - Help overlay
              </span>
            </div>
            <div className="village-subject-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <strong>📋 Gameplay Loop</strong>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                <strong>Creator</strong> - Build your topic map by adding rooms<br/>
                <strong>Scribe</strong> - Clear rooms by writing structured notes<br/>
                <strong>Archaeologist</strong> - Review cleared rooms for badges & XP
              </span>
            </div>
            <div className="village-subject-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <strong>🏅 Archetypes</strong>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Each class has a unique perk. Scholar gets quality bonus, Cartographer gets cross-link suggestions, Archivist gets higher self-check cap.
              </span>
            </div>
          </div>
          )}
        </div>
      ) : null}

      {infoPanel?.type === 'workshop' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">🎨</span>
            <div>
              <h3>Artisan Workshop</h3>
              <p className="village-info-meta">Customize game sprites</p>
            </div>
          </div>
          <p className="village-info-desc">
            Personalize the look and feel of your dungeon adventure. Edit character
            sprites, icons, decorations, and more.
          </p>
          <div className="village-info-actions">
            <button type="button" className="village-enter-btn" onClick={() => setMakeItYoursOpen(true)}>
              Open Editor
            </button>
          </div>
        </div>
      ) : null}

      {infoPanel?.type === 'fountain' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">⛲</span>
            <div>
              <h3>Central Fountain</h3>
              <p className="village-info-meta">Your study statistics</p>
            </div>
          </div>
          <div className="village-subject-list" style={{ gap: 6 }}>
            <div className="village-subject-item">
              <span>📊 Total sessions</span>
              <strong>{sessionStats.totalSessions}</strong>
            </div>
            <div className="village-subject-item">
              <span>⏱ Study time</span>
              <strong>{sessionStats.totalMinutesStudied < 60
                ? `${sessionStats.totalMinutesStudied}m`
                : `${Math.floor(sessionStats.totalMinutesStudied / 60)}h ${sessionStats.totalMinutesStudied % 60}m`}</strong>
            </div>
            <div className="village-subject-item">
              <span>📝 Notes submitted</span>
              <strong>{sessionStats.totalNotesSubmitted}</strong>
            </div>
            <div className="village-subject-item">
              <span>🔄 Reviews completed</span>
              <strong>{sessionStats.totalReviewsCompleted}</strong>
            </div>
            <div className="village-subject-item">
              <span>⭐ Rank</span>
              <strong>{rank}</strong>
            </div>
            <div className="village-subject-item">
              <span>✨ Total XP</span>
              <strong>{xpTotal}</strong>
            </div>
            {sessionStats.recentStreak > 1 && (
              <div className="village-subject-item">
                <span>🔥 Daily streak</span>
                <strong>{sessionStats.recentStreak} days</strong>
              </div>
            )}
          </div>
          <p className="village-info-desc">
            Press <kbd>E</kbd> to view detailed statistics.
          </p>
        </div>
      ) : null}

      {infoPanel?.type === 'quest-board' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">📜</span>
            <div>
              <h3>Keeper's Quest Board</h3>
              <p className="village-info-meta">{'Click a quest to hear guidance. ✓ marks it done.'}</p>
            </div>
          </div>
          <div className="village-subject-list" style={{ gap: 6 }}>
            {QUEST_ORDER.filter((s) => s !== 'intro').map((step) => {
              const idx = QUEST_ORDER.indexOf(step);
              const currentIdx = QUEST_ORDER.indexOf(questStep);
              const done = idx < currentIdx;
              const active = step === questStep;
              const isManual = MANUAL_QUESTS.has(step);
              return (
                <div key={step} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div
                    className="village-subject-item"
                    style={{
                      borderColor: active ? 'var(--accent)' : done ? 'var(--good)' : 'var(--border-soft)',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setQuestStep(step);
                      const keeper = VILLAGE_MAP.npcs.find((n) => n.id === 'keeper');
                      if (keeper) {
                        const lines = keeper.questDialogue?.[step];
                        if (lines && lines.length > 0) {
                          setKeeperDialogue(lines[0]);
                          setKeeperDialogueIndex(0);
                        }
                      }
                    }}
                  >
                    <span>{done ? '✅' : active ? '▶' : '⬜'}</span>
                    <span style={{ fontWeight: active ? 700 : done ? 400 : 300, fontSize: 13 }}>
                      {QUEST_LABELS[step].label}
                    </span>
                    <span className="village-info-meta" style={{ fontSize: 10 }}>
                      {done ? 'Done' : active && isManual ? 'Needs confirm' : active ? 'Active' : 'Locked'}
                    </span>
                  </div>
                  {active && isManual ? (
                    <button
                      type="button"
                      className="village-action-btn"
                      style={{ fontSize: 11, padding: '4px 8px', alignSelf: 'flex-end' }}
                      onClick={() => { advanceQuestStep(); }}
                    >
                      ✓ Mark Complete
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {infoPanel?.type === 'fishing-pond' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">🎣</span>
            <div>
              <h3>Fishing Pond</h3>
              <p className="village-info-meta">Cast a line and reel in some knowledge</p>
            </div>
          </div>
          <p className="village-info-desc">
            Take a break from studying and try your luck at the fishing pond.
            Catch fish, test your recall, and build your collection.
          </p>
          {fishingHintVisible ? (
            <div className="fishing-tutorial-hint">
              💡 Cast a line, catch fish, and test your recall! Press E to start fishing.
            </div>
          ) : null}
          <div className="village-info-actions">
            <button
              type="button"
              className="village-enter-btn"
              onClick={() => handleStartFishing(infoPanel.structureId)}
            >
              Cast Line
            </button>
          </div>
        </div>
      ) : null}

      {infoPanel?.type === 'fish-stand' ? (
        <div className="village-info-panel ui-skin" data-theme={colorTheme}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">🐟</span>
            <div>
              <h3>Fish Stand</h3>
              <p className="village-info-meta">View your fish collection</p>
            </div>
          </div>
          <p className="village-info-desc">
            All the fish you have caught across every subject are displayed here.
            Visit a fishing pond to start your collection!
          </p>
          <div className="village-info-actions">
            <button
              type="button"
              className="village-enter-btn"
              onClick={() => { setInfoPanel(null); setShowFishStand(true); }}
            >
              View Collection
            </button>
          </div>
        </div>
      ) : null}

      {infoPanel?.type === 'signpost' ? (
        <SignpostPanel structureId={infoPanel.structureId} colorTheme={colorTheme} />
      ) : null}

      {keeperDialogue ? (
        <div className={`village-npc-dialog ui-skin${npcDialogPos ? ' village-npc-dialog--anchored' : ''}`} data-theme={colorTheme} ref={dialogRef} style={npcDialogPos ? anchoredStyle ?? undefined : undefined}>
          <div className="village-npc-dialog-header">
            <span className="village-npc-dialog-icon">{activeNpcId ? (NPC_ICONS[activeNpcId] ?? '🧙') : '🧙'}</span>
            <strong>{activeNpcLabel ?? 'Villager'}</strong>
          </div>
          <p className="village-npc-dialog-text village-npc-dialog-text--typing" key={keeperDialogue}>{keeperDialogue}</p>
          <p className="village-npc-dialog-hint">Press E to continue</p>
        </div>
      ) : null}

      {dataOpen ? (
        <div className="modal-backdrop" onClick={() => setDataOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(480px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2>Data Management</h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Your data is stored locally on this device. Use the tools below to back up
              your subjects or transfer them between devices.
            </p>
            <div className="village-subject-list" style={{ gap: 6 }}>
              {subjects.map((subj) => (
                <div key={subj.id} className="village-subject-item">
                  <span>{subj.subjectName}</span>
                   <button type="button" className="village-action-btn" style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={() => {
                      void (async () => {
                        const snapshot = await loadSubjectSnapshot(subj.id);
                        if (!snapshot) return;
                        const json = exportSubjectToJson(snapshot);
                        const blob = new Blob([json], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${subj.subjectName.replace(/[^a-z0-9]+/gi, '-')}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      })();
                    }}>
                    Export
                  </button>
                </div>
              ))}
            </div>
            <input type="file" accept=".json" style={{ fontSize: 12 }}
              onChange={(e) => {
                void (async () => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    const snapshot = importSubjectFromJson(text);
                    await saveSubjectSnapshot(snapshot.dungeon.dungeonId, snapshot);
                    window.location.reload();
                  } catch (err) {
                    alert('Import failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
                  }
                })();
              }} />
            <div className="modal-actions">
              <button type="button" onClick={() => setDataOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

      {createOpen ? (
        <div className="modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="modal village-create-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>Create New Subject</h2>
            <div className="village-create-form">
              <label>
                Subject name
                <input
                  type="text"
                  placeholder="e.g. Linear Algebra"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                />
              </label>
              <label>
                Root topic
                <input
                  type="text"
                  placeholder="e.g. Vector Spaces"
                  value={createTopic}
                  onChange={(e) => setCreateTopic(e.target.value)}
                />
              </label>
              <label>
                Dungeon theme
                <select
                  value={createBiome}
                  onChange={(e) => setCreateBiome(e.target.value as FloorBiomeId)}
                >
                  {FLOOR_BIOME_IDS.map((biome) => (
                    <option key={biome} value={biome}>
                      {biome.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
                    </option>
                  ))}
                </select>
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
                <button
                  type="button"
                  onClick={() => { void handleCreateSubject(); }}
                  disabled={!createName.trim() || !createTopic.trim() || submitting}
                >
                  {submitting ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showStats ? <StudyStatsPanel onClose={() => setShowStats(false)} /> : null}

      {settingsOpen ? (
        <SettingsModal
          currentTheme={colorTheme}
          onThemeChange={(t) => setColorTheme(t as ColorTheme)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {makeItYoursOpen ? (
        <MakeItYoursModal onClose={() => setMakeItYoursOpen(false)} />
      ) : null}

      {showFishStand ? (
        <FishStandPanel onClose={() => setShowFishStand(false)} />
      ) : null}

      {fishCaughtData ? (
        <div className="modal-backdrop" style={{ zIndex: 350, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="village-info-panel ui-skin screen-slide-up" data-theme={colorTheme}
            style={{ maxWidth: 420, width: '90%' }}>
            <div className="village-info-panel-header">
              <span className="village-info-portal-icon">🎣</span>
              <div>
                <h3>{fishCaughtData.fishName}</h3>
                <p className="village-info-meta">{fishCaughtData.rarity.charAt(0).toUpperCase() + fishCaughtData.rarity.slice(1)} Fish</p>
              </div>
              <span className="fish-rarity-badge" data-rarity={fishCaughtData.rarity}>
                {fishCaughtData.rarity.toUpperCase()}
              </span>
            </div>
            <p className="village-info-desc">{fishCaughtData.description}</p>
            <div className="village-info-actions">
              <button type="button" className="village-enter-btn"
                onClick={() => { void handleKeepFishClicked(fishCaughtData); }}
              >
                Keep Fish
              </button>
              <button type="button" className="village-action-btn"
                onClick={() => setFishCaughtData(null)}
              >
                Release
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showRecallModal && fishCaughtData ? (
        <FishingRecallModal
          fishName={fishCaughtData.fishName}
          rarity={fishCaughtData.rarity as 'common' | 'rare' | 'epic'}
          catalogId={fishCaughtData.catalogId}
          description={fishCaughtData.description}
          recallQuestion={recallQuestionData}
          onSelfEvaluate={(result) => {
            if (result === 'correct') {
              handleKeepFish(fishCaughtData);
            } else {
              setFishCaughtData(null);
              setShowRecallModal(false);
              setRecallQuestionData(null);
            }
          }}
          onCancel={() => {
            setFishCaughtData(null);
            setShowRecallModal(false);
            setRecallQuestionData(null);
          }}
        />
      ) : null}
    </div>

    {welcomeMessage ? (
      <div className="modal-backdrop" onClick={() => setWelcomeMessage(null)}
        style={{ zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="village-info-panel ui-skin screen-fade-in" data-theme={colorTheme}
          style={{ maxWidth: 420, position: 'relative', zIndex: 301, left: 'auto', transform: 'none' }}>
          <div className="village-info-panel-header">
            <span className="village-info-portal-icon">🏘</span>
            <div>
              <h3>Welcome to the Dungeon Village</h3>
              <p className="village-info-meta">Your knowledge adventure begins here</p>
            </div>
          </div>
          <p className="village-info-desc">{welcomeMessage}</p>
          <div className="village-info-actions" style={{ marginTop: 8 }}>
            <button type="button" className="village-action-btn" onClick={() => setWelcomeMessage(null)}>
              Begin your journey
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

/* VillageScene methods that the React layer calls */
interface VillageSceneHandle {
  lastPoi: { name: string; angle: number; distance: number };
  setDynamicStructures: (structures: VillageStructure[]) => void;
  setPlayerClass: (cls: string) => void;
  triggerInteract: () => void;
}

/* ── React compass overlay reads lastPoi from the Phaser scene ─────────── */
function CompassOverlay({ sceneRef }: { sceneRef: React.MutableRefObject<VillageSceneHandle | null> }): JSX.Element {
  const [poi, setPoi] = useState<{ name: string; angle: number; distance: number } | null>(null);

  useEffect(() => {
    let frame: number;
    const poll = () => {
      const scene = sceneRef.current;
      if (scene?.lastPoi && scene.lastPoi.distance < 1e9) {
        setPoi({ name: scene.lastPoi.name, angle: scene.lastPoi.angle, distance: scene.lastPoi.distance });
      } else {
        setPoi(null);
      }
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frame);
  }, [sceneRef]);

  if (!poi || poi.distance < 96) return <></>;

  const angleDeg = (poi.angle * 180) / Math.PI + 90; // 0=up in CSS

  return (
    <div className="village-compass" title={poi.name}>
      <div className="village-compass-ring">
        <div className="village-compass-needle" style={{ transform: `rotate(${angleDeg}deg)` }} />
      </div>
      <span className="village-compass-label">{poi.name.slice(0, 10)}</span>
    </div>
  );
}

/* ── Reusable HUD content (used in both desktop sidebar & mobile drawer) ── */
function VillageHudContent({
  questStep, subjects, selectedClass, setSelectedClass, setCreateOpen, setDataOpen,
  colorTheme, setColorTheme, onQuestClick, onStatsClick, onSettingsClick,
}: {
  questStep: QuestStep; subjects: Array<{ id: string; subjectName: string; roomCount: number; clearedRoomCount: number }>;
  selectedClass: string | null; setSelectedClass: (cls: string | null) => void;
  setCreateOpen: React.Dispatch<React.SetStateAction<boolean>>; setDataOpen: React.Dispatch<React.SetStateAction<boolean>>;
  colorTheme: string; setColorTheme: (t: string) => void;
  onQuestClick: (step: string) => void;
  onStatsClick: () => void;
  onSettingsClick: () => void;
}): JSX.Element {
  const QL = QUEST_LABELS as Record<string, { label: string; hint: string }>;
  const QO = QUEST_ORDER;

  return (
    <>
      <div className="village-hud-header">
        <div className="village-hud-title">
          <span className="village-hud-icon">🏘</span>
          <span>Dungeon Village</span>
        </div>
        <div className="village-hud-subtitle">
          <ThemePicker current={colorTheme} onChange={setColorTheme} />
        </div>
      </div>

      <div className="village-hud-stats">
        <div className="village-stat">
          <span className="village-stat-label">Dungeons</span>
          <strong className="village-stat-value">{subjects.length}</strong>
        </div>
        <div className="village-stat">
          <span className="village-stat-label">Archetype</span>
          <strong className="village-stat-value">
            {selectedClass ? PLAYER_CLASSES.find((c) => c.id === selectedClass)?.name ?? 'None' : 'Not set'}
          </strong>
        </div>
      </div>

      <div className="village-hud-classes">
        <span className="village-hud-section-label">Study Archetype</span>
        <div className="village-class-grid">
          {PLAYER_CLASSES.map((cls) => (
            <button key={cls.id} type="button"
              className={`village-class-btn${selectedClass === cls.id ? ' village-class-btn--selected' : ''}`}
              aria-pressed={selectedClass === cls.id}
              onClick={() => setSelectedClass(cls.id)}>
              <strong>{cls.name}</strong>
              <span className="village-class-tagline">{cls.tagline}</span>
            </button>
          ))}
        </div>
        {(() => {
          const activeClass = PLAYER_CLASSES.find((c) => c.id === selectedClass);
          if (!activeClass) return null;
          return (
            <div className="village-class-detail">
              <p className="village-class-desc">{activeClass.description}</p>
              <div className="village-class-perk">✨ <strong>Perk:</strong> {activeClass.perk}</div>
            </div>
          );
        })()}
      </div>

      {/* Clickable quest log */}
      <div className="village-quest-log">
        <span className="village-hud-section-label">Quest (click to select)</span>
        <div className="village-quest-step" style={{ cursor: 'pointer' }} onClick={() => onQuestClick(questStep)}>
          <span className="village-quest-icon">{questStep === 'complete' ? '✅' : '▶'}</span>
          <div>
            <strong>{QL[questStep]?.label ?? questStep}</strong>
            <p className="village-quest-hint">{QL[questStep]?.hint ?? ''}</p>
          </div>
        </div>
        <div className="village-quest-progress">
          {QO.filter((s) => s !== 'intro').map((step) => {
            const idx = QO.indexOf(step);
            const currentIdx = QO.indexOf(questStep);
            const done = idx <= currentIdx;
            return (
              <span key={step} onClick={() => onQuestClick(step)}
                className={`village-quest-dot${done ? ' village-quest-dot--done' : ''}${step === questStep ? ' village-quest-dot--current' : ''}`}
                title={QL[step]?.label ?? step} style={{ cursor: 'pointer' }} />
            );
          })}
        </div>
      </div>

      <div className="village-hud-info">
        <p className="village-hint">
          Walk with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows.
          Press <kbd>E</kbd> to interact.
        </p>
      </div>

      <div className="village-hud-actions">
        <button type="button" className="village-action-btn" onClick={() => setCreateOpen(true)}>
          + Create New
        </button>
        <button type="button" className="village-action-btn" onClick={onStatsClick}>
          📊 Stats
        </button>
        <button type="button" className="village-action-btn" onClick={() => setDataOpen(true)}
          style={{ fontSize: 11, opacity: 0.7 }}>
          🛡 Data
        </button>
        <button type="button" className="village-action-btn" onClick={onSettingsClick}
          style={{ fontSize: 11, opacity: 0.7 }}>
          ⚙ Settings
        </button>
      </div>
    </>
  );
}

/* ── Signpost panel shows directional info when player approaches ───── */
const SIGNPOST_INFO: Record<string, { icon: string; title: string; lines: string[] }> = {
  'sign-entrance': {
    icon: '🚪',
    title: 'Village Entrance',
    lines: [
      '↑ Straight ahead - Fountain & Market Square',
      '→ East - Guild Hall & Portals',
      '↖ Northwest - Training Grounds',
    ],
  },
  'sign-center': {
    icon: '📍',
    title: 'Central Crossroads',
    lines: [
      '↑ North - Keeper\'s Tower & Library',
      '→ East - Guild Hall & East Portals',
      '↓ South - Fountain, Trophy Hall & South Portals',
      '← West - Training Grounds & West Portals',
    ],
  },
  'sign-library': {
    icon: '📍',
    title: 'North Path Split',
    lines: [
      '↑ North - Library of Knowledge',
      '→ East - Keeper\'s Tower',
    ],
  },
  'sign-south': {
    icon: '📍',
    title: 'South Path Split',
    lines: [
      '← West - South Portals',
      '→ East - Trophy Hall',
      '↓ South - Village Gate (Exit)',
    ],
  },
  'sign-east': {
    icon: '📍',
    title: 'East Path Split',
    lines: [
      '→ East - Guild Hall',
      '← West - Central Square & North Portals',
    ],
  },
};

function SignpostPanel({ structureId, colorTheme }: { structureId: string; colorTheme: string }): JSX.Element {
  const info = SIGNPOST_INFO[structureId];

  if (!info || structureId === 'signpost-welcome') {
    return (
      <div className="village-info-panel ui-skin" data-theme={colorTheme}>
        <div className="village-info-panel-header">
          <span className="village-info-portal-icon">📋</span>
          <div>
            <h3>Welcome to Dungeon Village</h3>
            <p className="village-info-meta">Your knowledge adventure begins here</p>
          </div>
        </div>
        <p className="village-info-desc">
          This village is your home base. Explore the buildings to create subjects,
          enter dungeons, and track your progress.
        </p>
        <div className="village-info-actions" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          <span>🏛 Keeper's Tower - Meet your guide</span>
          <span>⚒ Guild Hall - Create new subjects</span>
          <span>🌀 Portals - Enter your dungeons</span>
          <span>🎓 Training Grounds - Learn the basics</span>
          <span>🏆 Trophy Hall - View collections</span>
        </div>
      </div>
    );
  }

  return (
    <div className="village-info-panel ui-skin" data-theme={colorTheme}>
      <div className="village-info-panel-header">
        <span className="village-info-portal-icon">{info.icon}</span>
        <div>
          <h3>{info.title}</h3>
          <p className="village-info-meta">Approach to read directions</p>
        </div>
      </div>
      <div className="village-subject-list" style={{ gap: 4 }}>
        {info.lines.map((line, i) => (
          <div key={i} className="village-subject-item" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function ThemePicker({ current, onChange }: { current: string; onChange: (t: string) => void }): JSX.Element {
  const themes = [
    { id: 'dark', label: 'Night' },
    { id: 'colorful', label: 'Arcade' },
    { id: 'aurora', label: 'Aurora' },
  ];
  return (
    <div className="village-theme-picker">
      {themes.map((t) => (
        <button
          key={t.id}
          type="button"
          className={current === t.id ? 'active' : ''}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
