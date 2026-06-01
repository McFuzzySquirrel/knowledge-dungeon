import { useEffect, useState, type JSX } from 'react';
import { useSessionStore, type GamePhase } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { PLAYER_CLASSES, type PlayerClassId } from '@/game/systems/playerClasses';
import {
  exportSubjectFolder,
  exportSubjectsRoot,
  importSubjectFolder,
  listSubjectIds,
  loadSubjectSnapshot,
  openSubjectsFolder,
} from '@/services/persistence/subjectPersistence';
import { getElectronEnvironmentLabel, isElectronAvailable } from '@/services/electronBridge';

const PHASES: { id: GamePhase; title: string; description: string }[] = [
  {
    id: 'creator',
    title: 'Create',
    description: 'Author a new subject and link topic-rooms into a dungeon.',
  },
  {
    id: 'scribe',
    title: 'Scribe',
    description: 'Explore your dungeon and defeat encounters by writing structured notes.',
  },
  {
    id: 'archaeologist',
    title: 'Review',
    description: 'Once every room is cleared, revisit artifacts and self-check prompts.',
  },
];

const BASE = import.meta.env.BASE_URL;
const WELCOME_ICON = `${BASE}assets/welcome-icon.png`;
const CLASS_SPRITES: Record<PlayerClassId, string> = {
  scholar: `${BASE}assets/sprites/player-hero.svg`,
  cartographer: `${BASE}assets/sprites/player-explorer.svg`,
  archivist: `${BASE}assets/sprites/player-archivist.svg`,
};

export function WelcomeScreen(): JSX.Element {
  const phase = useSessionStore((s) => s.phase);
  const setPhase = useSessionStore((s) => s.setPhase);
  const selectedClass = useSessionStore((s) => s.selectedClass);
  const setSelectedClass = useSessionStore((s) => s.setSelectedClass);
  const setActiveSubjectId = useSessionStore((s) => s.setActiveSubjectId);

  const snapshot = useSubjectStore((s) => s.snapshot);
  const initSubject = useSubjectStore((s) => s.initSubject);
  const loadSubject = useSubjectStore((s) => s.loadSubject);

  const [subjectName, setSubjectName] = useState('');
  const [rootTopic, setRootTopic] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [existingSubjects, setExistingSubjects] = useState<
    {
      id: string;
      subjectName: string;
      roomCount: number;
      clearedRoomCount: number;
      suggestedPhase: 'Create' | 'Scribe' | 'Review';
    }[]
  >([]);
  const [selectedExistingSubjectId, setSelectedExistingSubjectId] = useState<string | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const env = getElectronEnvironmentLabel();
  const electronAvailable = isElectronAvailable();
  const selectedPhaseLabel = PHASES.find((phaseDef) => phaseDef.id === phase)?.title ?? phase;
  const selectedClassLabel =
    PLAYER_CLASSES.find((playerClass) => playerClass.id === selectedClass)?.name ?? 'Not selected yet';
  const isReadyToEnter = Boolean(selectedClass);
  const isFirstTimeUser = !snapshot && existingSubjects.length === 0;

  async function fetchExistingSubjects() {
    try {
      const ids = await listSubjectIds();
      const snapshots = await Promise.all(ids.map((id) => loadSubjectSnapshot(id)));
      return ids.map((id, index) => {
        const snapshotAtIndex = snapshots[index];
        const roomCount = snapshotAtIndex?.dungeon.rooms.length ?? 0;
        const clearedRoomCount = snapshotAtIndex
          ? Object.values(snapshotAtIndex.rooms).filter((room) => room.validationState.finalPass).length
          : 0;
        const suggestedPhase: 'Create' | 'Scribe' | 'Review' =
          roomCount > 0 && clearedRoomCount === roomCount
            ? 'Review'
            : roomCount > 1
              ? 'Scribe'
              : 'Create';
        return {
          id,
          subjectName: snapshotAtIndex?.dungeon.subjectName ?? id,
          roomCount,
          clearedRoomCount,
          suggestedPhase,
        };
      });
    } catch {
      return [];
    }
  }

  async function refreshExistingSubjects() {
    setLoadingExisting(true);
    const subjects = await fetchExistingSubjects();
    setExistingSubjects(subjects);
    if (selectedExistingSubjectId && !subjects.some((subject) => subject.id === selectedExistingSubjectId)) {
      setSelectedExistingSubjectId(null);
    }
    setLoadingExisting(false);
  }

  useEffect(() => {
    let cancelled = false;
    async function loadExisting() {
      setLoadingExisting(true);
      const subjects = await fetchExistingSubjects();
      if (cancelled) return;
      setExistingSubjects(subjects);
      setSelectedExistingSubjectId((current) =>
        current && subjects.some((subject) => subject.id === current) ? current : null,
      );
      setLoadingExisting(false);
    }
    void loadExisting();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    if (!subjectName.trim() || !rootTopic.trim() || !isReadyToEnter) return;
    setSubmitting(true);
    try {
      const created = await initSubject({
        subjectName: subjectName.trim(),
        rootTopic: rootTopic.trim(),
      });
      setActiveSubjectId(created.dungeon.dungeonId);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLoad(id: string) {
    if (!isReadyToEnter) return;
    const loaded = await loadSubject(id);
    if (loaded) {
      setActiveSubjectId(loaded.dungeon.dungeonId);
    }
  }

  async function handleEnterSelectedSubject() {
    if (!selectedExistingSubjectId) return;
    await handleLoad(selectedExistingSubjectId);
  }

  const selectedExistingSubject =
    selectedExistingSubjectId
      ? existingSubjects.find((subject) => subject.id === selectedExistingSubjectId) ?? null
      : null;

  async function handleOpenSubjectsFolder() {
    setAdminBusy(true);
    setAdminMessage(null);
    try {
      const opened = await openSubjectsFolder();
      setAdminMessage(opened ? 'Opened local subjects folder.' : 'Unable to open subjects folder.');
    } finally {
      setAdminBusy(false);
    }
  }

  async function handleExportSubjectsRoot() {
    setAdminBusy(true);
    setAdminMessage(null);
    try {
      const exportedTo = await exportSubjectsRoot();
      setAdminMessage(exportedTo ? `Exported subjects root to: ${exportedTo}` : 'Export cancelled.');
    } finally {
      setAdminBusy(false);
    }
  }

  async function handleExportSubject(subjectId: string) {
    setAdminBusy(true);
    setAdminMessage(null);
    try {
      const exportedTo = await exportSubjectFolder(subjectId);
      setAdminMessage(exportedTo ? `Exported ${subjectId} to: ${exportedTo}` : 'Export cancelled.');
    } finally {
      setAdminBusy(false);
    }
  }

  async function handleImportSubjectFolder() {
    setAdminBusy(true);
    setAdminMessage(null);
    try {
      const imported = await importSubjectFolder();
      if (!imported) {
        setAdminMessage('Import cancelled.');
        return;
      }
      await refreshExistingSubjects();
      await loadSubject(imported.dungeon.dungeonId);
      setActiveSubjectId(imported.dungeon.dungeonId);
      setAdminMessage(`Imported ${imported.dungeon.subjectName}.`);
    } finally {
      setAdminBusy(false);
    }
  }

  return (
    <div className="welcome-screen">
      <header style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <img
          src={WELCOME_ICON}
          alt="Knowledge Dungeon crystal icon"
          width={88}
          height={88}
          style={{
            flex: '0 0 auto',
            borderRadius: 18,
            padding: 6,
            background: 'linear-gradient(180deg, rgba(242, 200, 121, 0.14), rgba(15, 11, 6, 0.28))',
            border: '1px solid rgba(242, 200, 121, 0.28)',
            boxShadow: '0 10px 24px rgba(0, 0, 0, 0.35)',
          }}
        />
        <div>
          <h1>Knowledge Dungeon</h1>
          <p>
            A local-first study dungeon-crawler. Build a subject as a mindmap of topic-rooms,
            then defeat each room&rsquo;s encounter by writing structured notes. Currently running
            in <strong>{env}</strong> mode.
          </p>
        </div>
      </header>

      <section className="welcome-selection-summary" aria-label="Current selections">
        <h2>Current selections</h2>
        <p
          className={isReadyToEnter ? 'welcome-ready-indicator welcome-ready-indicator--ready' : 'welcome-ready-indicator'}
          role="status"
          aria-live="polite"
        >
          {isReadyToEnter ? 'Ready to Enter Dungeon' : 'Select an Archetype to Enter Dungeon'}
        </p>
        <div className="welcome-selection-grid">
          <div className="welcome-selection-card">
            <span className="welcome-selection-label">Phase</span>
            <strong>{selectedPhaseLabel}</strong>
          </div>
          <div className="welcome-selection-card">
            <span className="welcome-selection-label">Archetype</span>
            <strong>{selectedClassLabel}</strong>
          </div>
        </div>
      </section>

      <section className="room-section" aria-label="Gameplay loop overview">
        <h2>Gameplay loop</h2>
        <p className="room-help-text">
          Knowledge Dungeon works as a loop: map your ideas in Creator, clear encounters by writing
          notes in Scribe, then run review passes in Archaeologist once rooms are cleared.
        </p>
        <p className="room-help-text">
          For your first subject, start in Creator to build a few connected rooms, then switch to
          Scribe when you are ready to clear encounters.
        </p>
      </section>

      <section>
        <h2>1. Choose a phase</h2>
        <div className="phase-grid">
          {PHASES.map((phaseDef) => (
            <button
              key={phaseDef.id}
              type="button"
              className="phase-card"
              aria-pressed={phase === phaseDef.id}
              onClick={() => setPhase(phaseDef.id)}
            >
              {phase === phaseDef.id ? <span className="selection-chip">Selected</span> : null}
              <h3>{phaseDef.title}</h3>
              <p>{phaseDef.description}</p>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>2. Pick a Study Archetype</h2>
        <div className="class-grid">
          {PLAYER_CLASSES.map((cls) => (
            <button
              key={cls.id}
              type="button"
              className="class-card"
              aria-pressed={selectedClass === cls.id}
              onClick={() => setSelectedClass(cls.id)}
            >
              {selectedClass === cls.id ? <span className="selection-chip">Selected</span> : null}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <img
                  src={CLASS_SPRITES[cls.id]}
                  alt=""
                  width={48}
                  height={48}
                  style={{ flex: '0 0 auto' }}
                />
                <h4 style={{ margin: 0 }}>{cls.name}</h4>
              </div>
              <p>{cls.tagline}</p>
              <div className="perk">Perk: {cls.perk}</div>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>3. Start or load a subject</h2>
        {snapshot ? (
          <p>
            Active subject: <strong>{snapshot.dungeon.subjectName}</strong> ({snapshot.dungeon.rooms.length}{' '}
            rooms). Choose a phase and archetype, then Enter Dungeon.
          </p>
        ) : null}
        <div style={{ display: 'grid', gap: 8 }}>
          <input
            type="text"
            placeholder="Subject name (e.g. Linear Algebra)"
            value={subjectName}
            onChange={(e) => setSubjectName(e.target.value)}
          />
          <input
            type="text"
            placeholder="Root topic (e.g. Vector Spaces)"
            value={rootTopic}
            onChange={(e) => setRootTopic(e.target.value)}
          />
          <div className="welcome-actions">
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!subjectName.trim() || !rootTopic.trim() || submitting || !isReadyToEnter}
            >
              {submitting ? 'Creating…' : 'Create new subject'}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => void refreshExistingSubjects()}
            disabled={loadingExisting}
            aria-label="Refresh subject list"
          >
            Refresh subjects
          </button>
        </div>

        {loadingExisting ? <p>Loading subjects…</p> : null}
        {existingSubjects.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <h3>Previously created</h3>
            <p className="room-help-text">Select a subject, then confirm with Enter Dungeon.</p>
            <div className="welcome-actions">
              {existingSubjects.map((subject) => (
                <button
                  key={subject.id}
                  type="button"
                  className={selectedExistingSubjectId === subject.id ? 'ghost room-travel-item--selected' : 'ghost'}
                  aria-pressed={selectedExistingSubjectId === subject.id}
                  onClick={() => setSelectedExistingSubjectId(subject.id)}
                >
                  {subject.subjectName}
                  <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                    ({subject.clearedRoomCount}/{subject.roomCount} cleared · Suggested: {subject.suggestedPhase})
                  </span>
                </button>
              ))}
            </div>
            {selectedExistingSubject ? (
              <div style={{ marginTop: 12 }} className="room-section" aria-live="polite">
                <p>
                  Selected subject: <strong>{selectedExistingSubject.subjectName}</strong>
                </p>
                <p className="room-help-text">
                  Progress: {selectedExistingSubject.clearedRoomCount}/{selectedExistingSubject.roomCount} rooms
                  cleared. Suggested phase: {selectedExistingSubject.suggestedPhase}.
                </p>
                {!isReadyToEnter ? (
                  <p className="room-help-text">Pick an archetype above to enter this dungeon.</p>
                ) : null}
                <div className="welcome-actions">
                  <button
                    type="button"
                    onClick={() => void handleEnterSelectedSubject()}
                    disabled={!isReadyToEnter}
                  >
                    Enter Dungeon
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setSelectedExistingSubjectId(null)}
                  >
                    Choose different subject
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section>
        <h2>Admin</h2>
        {electronAvailable ? (
          <>
            <p>
              {isFirstTimeUser
                ? 'Import is available here. Advanced export tools are tucked away until you need them.'
                : 'Use these tools to export your local subject data between machines.'}
            </p>
            <div className="welcome-actions" aria-busy={adminBusy}>
              <button
                type="button"
                onClick={() => void handleImportSubjectFolder()}
                disabled={adminBusy}
                aria-disabled={adminBusy}
              >
                Import subject folder
              </button>
            </div>
            <details className="welcome-admin-advanced" open={!isFirstTimeUser}>
              <summary>Advanced admin tools</summary>
              <div className="welcome-actions" aria-busy={adminBusy}>
                <button
                  type="button"
                  onClick={() => void handleOpenSubjectsFolder()}
                  disabled={adminBusy}
                  aria-disabled={adminBusy}
                >
                  Open subjects folder
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportSubjectsRoot()}
                  disabled={adminBusy}
                  aria-disabled={adminBusy}
                >
                  Export subjects root
                </button>
                {existingSubjects.map((subject) => (
                  <button
                    key={`export-${subject.id}`}
                    type="button"
                    onClick={() => void handleExportSubject(subject.id)}
                    disabled={adminBusy}
                    aria-disabled={adminBusy}
                  >
                    Export {subject.subjectName}
                  </button>
                ))}
              </div>
            </details>
          </>
        ) : (
          <p>Admin export tools are available in desktop mode.</p>
        )}
        {adminMessage ? (
          <p style={{ marginTop: 8, color: 'var(--text-muted)', wordBreak: 'break-word' }}>
            {adminMessage}
          </p>
        ) : null}
      </section>
    </div>
  );
}
