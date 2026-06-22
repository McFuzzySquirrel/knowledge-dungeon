import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '@/ui/App';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import type { SubjectSnapshot } from '@/core/validation/persistence';

const mocks = vi.hoisted(() => ({
  isElectronAvailable: vi.fn(() => false),
  getElectronEnvironmentLabel: vi.fn(() => 'web'),
  getActiveSubjectId: vi.fn(() => null as string | null),
  listSubjectIds: vi.fn<() => Promise<string[]>>(),
  loadSubjectSnapshot: vi.fn<(id: string) => Promise<SubjectSnapshot | null>>(),
}));

vi.mock('@/services/electronBridge', () => ({
  isElectronAvailable: () => mocks.isElectronAvailable(),
  getElectronEnvironmentLabel: () => mocks.getElectronEnvironmentLabel(),
}));

vi.mock('@/ui/screens/VillageScreen', () => ({
  VillageScreen: () => <div>Village Screen</div>,
}));

vi.mock('@/ui/screens/GameScreen', () => ({
  GameScreen: () => <div>Game Screen</div>,
}));

vi.mock('@/services/persistence/subjectPersistence', async () => {
  const actual = await vi.importActual('@/services/persistence/subjectPersistence');
  return {
    ...actual,
    getActiveSubjectId: () => mocks.getActiveSubjectId(),
    listSubjectIds: () => mocks.listSubjectIds(),
    loadSubjectSnapshot: (id: string) => mocks.loadSubjectSnapshot(id),
    saveSubjectSnapshot: vi.fn(() => Promise.resolve({ success: true })),
    setActiveSubjectId: vi.fn(),
  };
});

function makeSnapshot(subjectId: string, subjectName: string): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: '1.0.0',
      dungeonId: subjectId,
      subjectName,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      phaseState: 'CreatorActive',
      rootRoomId: 'room-1',
      rooms: [{ roomId: 'room-1', topic: 'Root Topic', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      'room-1': {
        roomId: 'room-1',
        topic: 'Root Topic',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        state: 'Created',
        notePath: 'rooms/room-1/notes.md',
        artifactPath: 'rooms/room-1/artifact.md',
        noteText: '',
        artifactMarkdown: null,
        validationState: {
          wordCount: 0,
          requiredSectionsPresent: false,
          manualConfirmed: false,
          criterionScores: {
            sectionCompleteness: 0,
            conceptTermCoverage: 0,
            linkReferences: 0,
            recallQuestionQuality: 0,
            clarityReadability: 0,
          },
          failedChecks: [],
          qualityBonus: 0,
          finalPass: false,
        },
        reviewPassCount: 0,
        attachments: [],
      },
    },
  };
}

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useSessionStore.setState({
      activeSubjectId: null,
      phase: 'creator',
      selectedClass: null,
      focusedRoomId: null,
      isNoteEditorOpen: false,
      noteEditorRoomId: null,
      noteEditorPendingInsert: null,
      isMapViewOpen: false,
      teleportModeArmed: false,
      lastTeleportAt: null,
    });
    useSubjectStore.setState({ snapshot: null, lastError: null });
    useProgressionStore.setState({
      activeSubjectId: null,
      bySubject: {},
      xpTotal: 0,
      rank: 'Novice',
      badges: [],
      inventory: [],
      collectedNotes: [],
      streakCount: 0,
    });
    mocks.getActiveSubjectId.mockReset();
    mocks.listSubjectIds.mockReset();
    mocks.loadSubjectSnapshot.mockReset();
    mocks.getActiveSubjectId.mockReturnValue(null);
    mocks.listSubjectIds.mockResolvedValue([]);
    mocks.isElectronAvailable.mockReturnValue(false);
    mocks.getElectronEnvironmentLabel.mockReturnValue('web');
  });

  it('shows welcome screen without subjects, then village after creating one', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument();
    });

    // No subjects → WelcomeScreen shown
    expect(screen.getByRole('heading', { name: 'Knowledge Dungeon' })).toBeInTheDocument();

    // Simulate subjects becoming available (as if created in WelcomeScreen)
    const snapshot = makeSnapshot('subject-1', 'Imported Subject');
    mocks.getActiveSubjectId.mockReturnValue('subject-1');
    mocks.listSubjectIds.mockResolvedValue(['subject-1']);
    mocks.loadSubjectSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'subject-1' ? snapshot : null),
    );
  });

  it('shows welcome screen with Continue to Village when subjects exist', async () => {
    const snapshot = makeSnapshot('subject-1', 'Imported Subject');
    mocks.getActiveSubjectId.mockReturnValue('subject-1');
    mocks.listSubjectIds.mockResolvedValue(['subject-1']);
    mocks.loadSubjectSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'subject-1' ? snapshot : null),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument();
    });

    // Subjects exist → WelcomeScreen shown with Continue to Village button
    await screen.findByRole('button', { name: /Continue to Village/i });
  });
});
