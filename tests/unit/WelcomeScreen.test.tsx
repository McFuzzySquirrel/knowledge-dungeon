import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomeScreen } from '@/ui/screens/WelcomeScreen';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import type { SubjectSnapshot } from '@/core/validation/persistence';

vi.mock('@/services/electronBridge', () => ({
  isElectronAvailable: () => false,
  getElectronEnvironmentLabel: () => 'web',
}));

const mockListSubjectIds = vi.fn<() => Promise<string[]>>();
const mockLoadSubjectSnapshot = vi.fn<(id: string) => Promise<SubjectSnapshot | null>>();

vi.mock('@/services/persistence/subjectPersistence', () => ({
  listSubjectIds: () => mockListSubjectIds(),
  loadSubjectSnapshot: (id: string) => mockLoadSubjectSnapshot(id),
  saveSubjectSnapshot: vi.fn(() => Promise.resolve(undefined)),
  setActiveSubjectId: vi.fn(),
  exportSubjectFolder: vi.fn(() => Promise.resolve(null)),
  exportSubjectsRoot: vi.fn(() => Promise.resolve(null)),
  importSubjectFolder: vi.fn(() => Promise.resolve(null)),
  openSubjectsFolder: vi.fn(() => Promise.resolve(false)),
  addRoomLocalAttachment: vi.fn(() => Promise.resolve(null)),
  addRoomExternalAttachment: vi.fn(() => Promise.resolve(null)),
  deleteRoomAttachment: vi.fn(() => Promise.resolve(false)),
  resolveRoomAttachmentUrl: vi.fn(() => Promise.resolve(null)),
}));

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

describe('WelcomeScreen', () => {
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
    mockListSubjectIds.mockReset();
    mockLoadSubjectSnapshot.mockReset();
  });

  it('keeps create disabled until an archetype is selected', async () => {
    mockListSubjectIds.mockResolvedValue([]);

    render(<WelcomeScreen />);
    await waitFor(() => {
      expect(screen.queryByText(/Loading subjects/i)).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/Subject name/i), {
      target: { value: 'Linear Algebra' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Root topic/i), {
      target: { value: 'Vector Spaces' },
    });

    const createButton = screen.getByRole('button', { name: /Create new subject/i });
    expect(createButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Scholar/i }));

    expect(createButton).not.toBeDisabled();
  });

  it('requires explicit enter confirmation after selecting an existing subject', async () => {
    const snapshot = makeSnapshot('subject-1', 'Imported Subject');
    mockListSubjectIds.mockResolvedValue(['subject-1']);
    mockLoadSubjectSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'subject-1' ? snapshot : null),
    );

    useSessionStore.setState({ selectedClass: 'scholar' });

    render(<WelcomeScreen />);

    await screen.findByRole('button', { name: /Imported Subject/i });
    expect(screen.getByText(/0\/1 cleared · Suggested: Create/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Imported Subject/i }));

    expect(useSessionStore.getState().activeSubjectId).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Enter dungeon/i }));

    await waitFor(() => {
      expect(useSessionStore.getState().activeSubjectId).toBe('subject-1');
    });
  });
});
