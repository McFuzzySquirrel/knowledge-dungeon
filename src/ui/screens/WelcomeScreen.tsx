import { useState, type JSX } from 'react';
import { useSessionStore, type GamePhase } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { PLAYER_CLASSES } from '@/game/systems/playerClasses';
import { listSubjectIds } from '@/services/persistence/subjectPersistence';
import { getElectronEnvironmentLabel } from '@/services/electronBridge';

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
  const [existingIds, setExistingIds] = useState<string[]>([]);
  const env = getElectronEnvironmentLabel();

  void useState(() => {
    void listSubjectIds().then(setExistingIds);
    return 0;
  });

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

  return (
    <div className="welcome-screen">
      <header>
        <h1>Knowledge Dungeon</h1>
        <p>
          A local-first study dungeon-crawler. Build a subject as a mindmap of topic-rooms,
          then defeat each room&rsquo;s encounter by writing structured notes. Currently running
          in <strong>{env}</strong> mode.
        </p>
      </header>

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
              <h4>{cls.name}</h4>
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

        {existingIds.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <h3>Previously created</h3>
            <div className="welcome-actions">
              {existingIds.map((id) => (
                <button key={id} type="button" onClick={() => void handleLoad(id)}>
                  {id}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
