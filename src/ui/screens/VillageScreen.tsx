import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useSessionStore, QUEST_LABELS, QUEST_ORDER } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useProgressionStore } from '@/store/progressionStore';
import { useLoadSubjectFlow } from '@/ui/hooks/useLoadSubjectFlow';
import { createVillageGame } from '@/game/createVillageGame';
import type { VillageSceneEvents } from '@/game/scenes/VillageScene';
import { VILLAGE_MAP, type VillageStructure, getDungeonPortalSlots } from '@/data/villageLayout';
import { PLAYER_CLASSES } from '@/game/systems/playerClasses';
import { listSubjectIds, loadSubjectSnapshot } from '@/services/persistence/subjectPersistence';
import { createTutorialSubject, TUTORIAL_SUBJECT_ID } from '@/data/tutorialSubject';

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
  const initSubject = useSubjectStore((s) => s.initSubject);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [infoPanel, setInfoPanel] = useState<{
    type: 'dungeon' | 'keeper' | 'guild' | 'training';
    structureId: string;
    subject?: SubjectSummary;
  } | null>(null);
  const [keeperDialogue, setKeeperDialogue] = useState<string | null>(null);
  const [, setKeeperDialogueIndex] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createTopic, setCreateTopic] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
      type: 'dungeon-portal' as const,
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
        if (struct.type === 'dungeon-portal') {
          const subj = subjectsRef.current.find((s) => s.id === struct.subjectId);
          setInfoPanel({ type: 'dungeon', structureId, subject: subj });
        } else if (struct.type === 'keeper-tower') {
          setInfoPanel({ type: 'keeper', structureId });
        } else if (struct.type === 'guild-hall') {
          setInfoPanel({ type: 'guild', structureId });
        } else if (struct.type === 'training-gate') {
          setInfoPanel({ type: 'training', structureId });
        }
      },
      onStructureLeft: () => setInfoPanel(null),
      onStructureInteract: (structureId) => {
        const struct = [...VILLAGE_MAP.structures, ...dynamicStructuresRef.current]
          .find((s) => s.id === structureId);
        if (!struct) return;
        if (struct.type === 'dungeon-portal' && struct.subjectId) {
          const session = useSessionStore.getState();
          session.setPhase('scribe');
          session.setSelectedClass(selectedClassRef.current || 'scholar');
          const subjStore = useSubjectStore.getState();
          subjStore.loadSubject(struct.subjectId).then((loaded) => {
            if (loaded) {
              session.setActiveSubjectId(loaded.dungeon.dungeonId);
              useProgressionStore.getState().setActiveSubject(loaded.dungeon.dungeonId);
              session.setActiveScreen('game');
            }
          });
        } else if (struct.type === 'keeper-tower') {
          const keeper = VILLAGE_MAP.npcs.find((n) => n.id === 'keeper');
          if (keeper) {
            const session = useSessionStore.getState();
            const questLines = keeper.questDialogue?.[session.questStep];
            if (questLines && questLines.length > 0) {
              setKeeperDialogue(questLines[0]);
            } else {
              setKeeperDialogue(keeper.greeting);
            }
            setKeeperDialogueIndex(0);
          }
        } else if (struct.type === 'guild-hall') {
          setCreateOpen(true);
          useSessionStore.getState().advanceQuestStep();
        } else if (struct.type === 'training-gate') {
          const tutorial = createTutorialSubject();
          const session = useSessionStore.getState();
          const subjStore = useSubjectStore.getState();
          subjStore.importSnapshot(tutorial).then(() => {
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
        }
      },
      onNpcApproached: () => {
        const keeper = VILLAGE_MAP.npcs.find((n) => n.id === 'keeper');
        if (!keeper) return;
        const session = useSessionStore.getState();
        if (session.questStep === 'intro' || session.questStep === 'meet-keeper') {
          session.setQuestStep('meet-keeper');
        }
        const questLines = keeper.questDialogue?.[session.questStep];
        if (questLines && questLines.length > 0) {
          setKeeperDialogue(questLines[0]);
          setKeeperDialogueIndex(0);
        } else {
          setKeeperDialogue(keeper.greeting);
          setKeeperDialogueIndex(0);
        }
      },
      onNpcLeft: () => { setKeeperDialogue(null); setKeeperDialogueIndex(0); },
      onNpcInteract: () => {
        const keeper = VILLAGE_MAP.npcs.find((n) => n.id === 'keeper');
        if (!keeper) return;
        const session = useSessionStore.getState();
        const questLines = keeper.questDialogue?.[session.questStep];
        if (questLines && questLines.length > 0) {
          setKeeperDialogueIndex((prev) => {
            const next = (prev + 1) % questLines.length;
            setKeeperDialogue(questLines[next]);
            return next;
          });
        } else {
          setKeeperDialogueIndex((prev) => {
            const next = (prev + 1) % keeper.dialogue.length;
            setKeeperDialogue(keeper.dialogue[next]);
            return next;
          });
        }
      },
      onNpcDialogPosition: () => {},
      onReady: () => {},
    };
    Object.assign(callbacksRef.current, cb);
  }, [subjects, dynamicStructures, selectedClass]);

  // Mount Phaser game once — it reads from callbacksRef
  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;
    const ref = callbacksRef;
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
    });
    gameRef.current = game;
    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  // Sync dynamic structures when subjects change
  useEffect(() => {
    const scene = gameRef.current?.scene.getScene('VillageScene') as any;
    if (scene?.setDynamicStructures) {
      scene.setDynamicStructures(dynamicStructures);
    }
  }, [dynamicStructures]);

  // Sync player class to village sprite
  useEffect(() => {
    const scene = gameRef.current?.scene.getScene('VillageScene') as any;
    if (scene?.setPlayerClass) {
      scene.setPlayerClass(selectedClass ?? 'scholar');
    }
  }, [selectedClass]);

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
      });
      await refreshSubjects();
      advanceQuestStep();
      setCreateName('');
      setCreateTopic('');
      setCreateOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="village-screen ui-skin screen-fade-in" data-theme={colorTheme}>
      <div className="village-canvas" ref={containerRef} />

      <div className="village-hud ui-skin" data-theme={colorTheme}>
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
              <button
                key={cls.id}
                type="button"
                className={`village-class-btn${selectedClass === cls.id ? ' village-class-btn--selected' : ''}`}
                aria-pressed={selectedClass === cls.id}
                onClick={() => setSelectedClass(cls.id)}
              >
                <strong>{cls.name}</strong>
                <span className="village-class-tagline">{cls.tagline}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="village-quest-log">
          <span className="village-hud-section-label">Current Quest</span>
          <div className="village-quest-step">
            <span className="village-quest-icon">{questStep === 'complete' ? '✅' : '▶'}</span>
            <div>
              <strong>{QUEST_LABELS[questStep].label}</strong>
              <p className="village-quest-hint">{QUEST_LABELS[questStep].hint}</p>
            </div>
          </div>
          <div className="village-quest-progress">
            {QUEST_ORDER.filter((s) => s !== 'intro').map((step) => {
              const idx = QUEST_ORDER.indexOf(step);
              const currentIdx = QUEST_ORDER.indexOf(questStep);
              const done = idx <= currentIdx;
              return (
                <span
                  key={step}
                  className={`village-quest-dot${done ? ' village-quest-dot--done' : ''}${step === questStep ? ' village-quest-dot--current' : ''}`}
                  title={QUEST_LABELS[step].label}
                />
              );
            })}
          </div>
        </div>

        <div className="village-hud-info">
          <p className="village-hint">
            Walk around the village with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrow keys.
            Press <kbd>E</kbd> to interact with buildings and NPCs.
          </p>
        </div>

        <div className="village-hud-actions">
          <button type="button" className="village-action-btn" onClick={() => setCreateOpen(true)}>
            + Create New
          </button>
          <button type="button" className="village-action-btn village-action-btn--tutorial" onClick={handleStartTutorial}>
            Tutorial
          </button>
        </div>
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
              onClick={handleStartTutorial}
            >
              Start Tutorial
            </button>
          </div>
        </div>
      ) : null}

      {keeperDialogue ? (
        <div className="village-npc-dialog ui-skin" data-theme={colorTheme}>
          <div className="village-npc-dialog-header">
            <span className="village-npc-dialog-icon">🧙</span>
            <strong>Keeper of Knowledge</strong>
          </div>
          <p className="village-npc-dialog-text village-npc-dialog-text--typing" key={keeperDialogue}>{keeperDialogue}</p>
          <p className="village-npc-dialog-hint">Press E to continue</p>
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
              <div className="modal-actions">
                <button type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
                <button
                  type="button"
                  onClick={handleCreateSubject}
                  disabled={!createName.trim() || !createTopic.trim() || submitting}
                >
                  {submitting ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ThemePicker({ current, onChange }: { current: string; onChange: (t: any) => void }): JSX.Element {
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
