import { useEffect, useState, type JSX } from 'react';
import { useSessionStore, type GamePhase } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { PLAYER_CLASSES, type PlayerClassId } from '@/game/systems/playerClasses';
import {
  exportSubjectFolder,
  exportSubjectsRoot,
  listSubjectIds,
  loadSubjectSnapshot,
  openSubjectsFolder,
} from '@/services/persistence/subjectPersistence';
import { getElectronEnvironmentLabel, isElectronAvailable } from '@/services/electronBridge';
import { GraphicsModeToggle } from '@/ui/components/GraphicsModeToggle';

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
    { id: string; subjectName: string; roomCount: number }[]
  >([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const env = getElectronEnvironmentLabel();
  const electronAvailable = isElectronAvailable();
  const selectedPhaseLabel = PHASES.find((phaseDef) => phaseDef.id === phase)?.title ?? phase;
  const selectedClassLabel =
    PLAYER_CLASSES.find((playerClass) => playerClass.id === selectedClass)?.name ?? 'Not selected yet';
  const isReadyToEnter = Boolean(selectedClass);

  async function fetchExistingSubjects() {
    try {
      const ids = await listSubjectIds();
      const snapshots = await Promise.all(ids.map((id) => loadSubjectSnapshot(id)));
      return ids.map((id, index) => {
        const snapshotAtIndex = snapshots[index];
        return {
          id,
          subjectName: snapshotAtIndex?.dungeon.subjectName ?? id,
          roomCount: snapshotAtIndex?.dungeon.rooms.length ?? 0,
        };
      });
    } catch {
      return [];
    }
  }

  async function refreshExistingSubjects() {
    setLoadingExisting(true);
    setExistingSubjects(await fetchExistingSubjects());
    setLoadingExisting(false);
  }

  useEffect(() => {
    let cancelled = false;
    async function loadExisting() {
      setLoadingExisting(true);
      const subjects = await fetchExistingSubjects();
      if (cancelled) return;
      setExistingSubjects(subjects);
      setLoadingExisting(false);
    }
    void loadExisting();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    if (!subjectName.trim() || !rootTopic.trim()) return;
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
    const loaded = await loadSubject(id);
    if (loaded) {
      setActiveSubjectId(loaded.dungeon.dungeonId);
    }
  }

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

  return (
    <div className="welcome-screen">
      <header style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <img
          src={`${import.meta.env.BASE_URL}assets/sprites/objects/readme-scroll.svg`}
          alt=""
          width={72}
          height={72}
          style={{ flex: '0 0 auto' }}
        />
        <div>
          <h1>Knowledge Dungeon</h1>
          <p>
            A local-first study dungeon-crawler. Build a subject as a mindmap of topic-rooms,
            then defeat each room&rsquo;s encounter by writing structured notes. Currently running
            in <strong>{env}</strong> mode.
          </p>
        </div>
        <div className="welcome-graphics-mode">
          <GraphicsModeToggle label="Graphics" compact />
        </div>
      </header>

      <section className="welcome-selection-summary" aria-label="Current selections">
        <h2>Current selections</h2>
        <p
          className={isReadyToEnter ? 'welcome-ready-indicator welcome-ready-indicator--ready' : 'welcome-ready-indicator'}
          role="status"
          aria-live="polite"
        >
          {isReadyToEnter ? 'Ready to enter dungeon' : 'Select an archetype to enter dungeon'}
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
              <h3>{phaseDef.title}</h3>
              <p>{phaseDef.description}</p>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>2. Pick a study archetype</h2>
        <div className="class-grid">
          {PLAYER_CLASSES.map((cls) => (
            <button
              key={cls.id}
              type="button"
              className="class-card"
              aria-pressed={selectedClass === cls.id}
              onClick={() => setSelectedClass(cls.id)}
            >
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
            rooms). Pick a phase above and an archetype to enter the dungeon.
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
              disabled={!subjectName.trim() || !rootTopic.trim() || submitting}
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
            <div className="welcome-actions">
              {existingSubjects.map((subject) => (
                <button key={subject.id} type="button" onClick={() => void handleLoad(subject.id)}>
                  {subject.subjectName}
                  <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                    ({subject.roomCount} rooms)
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <h2>Admin</h2>
        {electronAvailable ? (
          <>
            <p>Use these tools to export your local subject data between machines.</p>
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
