import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '@/ui/App';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import type { SubjectSnapshot } from '@/core/validation/persistence';

const mockIsElectronAvailable = vi.fn(() => false);
const mockGetElectronEnvironmentLabel = vi.fn(() => 'web');
const mockGetActiveSubjectId = vi.fn(() => null as string | null);
const mockListSubjectIds = vi.fn<() => Promise<string[]>>();
const mockLoadSubjectSnapshot = vi.fn<(id: string) => Promise<SubjectSnapshot | null>>();

vi.mock('@/services/electronBridge', () => ({
  isElectronAvailable: () => mockIsElectronAvailable(),
  getElectronEnvironmentLabel: () => mockGetElectronEnvironmentLabel(),
}));

vi.mock('@/ui/screens/GameScreen', () => ({
  GameScreen: () => <div>Game Screen</div>,
}));

vi.mock('@/services/persistence/subjectPersistence', async () => {
  const actual = await vi.importActual('@/services/persistence/subjectPersistence');
  return {
    ...actual,
    getActiveSubjectId: () => mockGetActiveSubjectId(),
    listSubjectIds: () => mockListSubjectIds(),
    loadSubjectSnapshot: (id: string) => mockLoadSubjectSnapshot(id),
    saveSubjectSnapshot: vi.fn(() => Promise.resolve(undefined)),
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
    mockGetActiveSubjectId.mockReset();
    mockListSubjectIds.mockReset();
    mockLoadSubjectSnapshot.mockReset();
    mockGetActiveSubjectId.mockReturnValue(null);
    mockListSubjectIds.mockResolvedValue([]);
    mockIsElectronAvailable.mockReturnValue(false);
    mockGetElectronEnvironmentLabel.mockReturnValue('web');
  });

  it('keeps the welcome flow active until Enter Dungeon is confirmed', async () => {
    const snapshot = makeSnapshot('subject-1', 'Imported Subject');
    mockGetActiveSubjectId.mockReturnValue('subject-1');
    mockListSubjectIds.mockResolvedValue(['subject-1']);
    mockLoadSubjectSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'subject-1' ? snapshot : null),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText(/^Loading…$/i)).not.toBeInTheDocument();
    });
    await screen.findByText(/Selected subject: \s*Imported Subject/i);

    fireEvent.click(screen.getByRole('button', { name: /Scholar/i }));

    expect(screen.queryByText('Game Screen')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Enter Dungeon/i }));

    await waitFor(() => {
      expect(screen.getByText('Game Screen')).toBeInTheDocument();
    });
  });
});
