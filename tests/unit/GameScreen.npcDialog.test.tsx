import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameScreen } from '@/ui/screens/GameScreen';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import type { SubjectSnapshot } from '@/core/validation/persistence';

interface NpcDialogPayload {
  roomId: string;
  clientX: number;
  clientY: number;
}

interface CapturedCallbacks {
  onNpcInteract?: (payload: NpcDialogPayload) => void;
  onNpcOutOfRange?: (roomId: string) => void;
  onInteract?: (roomId: string) => void;
}

interface MockScene {
  setArtifactRooms: ReturnType<typeof vi.fn>;
  setCollectedArtifactRooms: ReturnType<typeof vi.fn>;
  setReviewedArtifactRooms: ReturnType<typeof vi.fn>;
  setFloorVisibility: ReturnType<typeof vi.fn>;
  teleportToRoom: ReturnType<typeof vi.fn>;
  triggerInteract: ReturnType<typeof vi.fn>;
}

interface MockGame {
  events: {
    once: (_event: string, cb: () => void) => void;
  };
  scene: {
    getScene: () => MockScene;
  };
  destroy: ReturnType<typeof vi.fn>;
}

const createGameMock = vi.fn<(options: Record<string, unknown>) => MockGame>();
let capturedCallbacks: CapturedCallbacks | null = null;
let fakeScene: MockScene;

vi.mock('@/game/createGame', () => ({
  createGame: (options: Record<string, unknown>) => {
    capturedCallbacks = (options.callbacks as CapturedCallbacks) ?? null;
    return createGameMock(options);
  },
}));

vi.mock('@/game/systems/dungeonGenerator', () => ({
  generateDungeonMap: () => ({
    tileSize: 32,
    bounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
    rooms: [],
    corridors: [],
    doors: [],
    walkable: { width: 20, height: 20, offsetX: 0, offsetY: 0, data: new Uint8Array(400) },
  }),
}));

vi.mock('@/core/graph', () => ({
  deriveGraphHierarchy: () => ({
    floorIdByRoomId: { 'room-1': 'room-1' },
    floorLabelByFloorId: { 'room-1': 'Floor 1' },
  }),
  computeFloorVisibility: () => ({
    floorId: 'room-1',
    visibleRoomIds: new Set(['room-1']),
    portalUpRoomId: null,
    portalDownRoomIds: new Set<string>(),
  }),
}));

vi.mock('@/core/review', () => ({
  isReviewableRoom: () => true,
  summarizeReviewAnalytics: () => ({ fullReviewPasses: 0 }),
}));

vi.mock('@/core/progression', async () => {
  const actual = await vi.importActual('@/core/progression');
  return {
    ...actual,
    evaluatePhaseBadgeUnlocks: () => [],
  };
});

vi.mock('@/ui/components/Hud', () => ({ Hud: () => <div data-testid="hud" /> }));
vi.mock('@/ui/components/InventoryBadgesPanel', () => ({
  InventoryBadgesPanel: () => null,
}));
vi.mock('@/ui/components/RoomPanel', () => ({
  RoomPanel: () => <div data-testid="room-panel" />,
}));
vi.mock('@/ui/components/NoteEditorModal', () => ({ NoteEditorModal: () => null }));
vi.mock('@/ui/components/Minimap', () => ({ Minimap: () => null }));
vi.mock('@/ui/components/HelpOverlay', () => ({ HelpOverlay: () => null }));
vi.mock('@/ui/components/FullMapView', () => ({ FullMapView: () => null }));
vi.mock('@/ui/components/GameplayOnboardingModal', () => ({
  GameplayOnboardingModal: () => null,
}));
vi.mock('@/ui/components/ToastStack', () => ({ ToastStack: () => null }));

vi.mock('@/ui/utils/editableElement', () => ({ isEditableElement: () => false }));
vi.mock('@/ui/utils/onboarding', () => ({
  hasSeenGameplayLoopOnboarding: () => true,
  markGameplayLoopOnboardingSeen: () => undefined,
}));
vi.mock('@/services/persistence/subjectPersistence', async () => {
  const actual = await vi.importActual('@/services/persistence/subjectPersistence');
  return {
    ...actual,
    setActiveSubjectId: vi.fn(),
  };
});

function makeSnapshot(): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: '1.0.0',
      dungeonId: 'subject-1',
      subjectName: 'Linear Algebra',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      phaseState: 'ScribeActive',
      rootRoomId: 'room-1',
      rooms: [{ roomId: 'room-1', topic: 'Vector Spaces', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      'room-1': {
        roomId: 'room-1',
        topic: 'Vector Spaces',
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

describe('GameScreen NPC dialog callbacks', () => {
  beforeEach(() => {
    capturedCallbacks = null;
    createGameMock.mockReset();

    fakeScene = {
      setArtifactRooms: vi.fn(),
      setCollectedArtifactRooms: vi.fn(),
      setReviewedArtifactRooms: vi.fn(),
      setFloorVisibility: vi.fn(),
      teleportToRoom: vi.fn(),
      triggerInteract: vi.fn(),
    };

    createGameMock.mockReturnValue({
      events: {
        once: (_event: string, cb: () => void) => cb(),
      },
      scene: {
        getScene: () => fakeScene,
      },
      destroy: vi.fn(),
    });

    useSubjectStore.setState({ snapshot: makeSnapshot(), lastError: null });
    useSessionStore.setState({
      activeSubjectId: 'subject-1',
      phase: 'scribe',
      selectedClass: null,
      focusedRoomId: null,
      isNoteEditorOpen: false,
      noteEditorRoomId: null,
      noteEditorPendingInsert: null,
      isMapViewOpen: false,
      teleportModeArmed: false,
      lastTeleportAt: null,
    });
    useProgressionStore.setState({
      xpTotal: 0,
      rank: 'Novice',
      badges: [],
      inventory: [],
      collectedNotes: [],
      streakCount: 0,
    });
  });

  it('opens on NPC interaction and closes on out-of-range callback', async () => {
    render(<GameScreen />);

    await waitFor(() => {
      expect(capturedCallbacks).not.toBeNull();
    });

    act(() => {
      capturedCallbacks?.onNpcInteract?.({ roomId: 'room-1', clientX: 420, clientY: 260 });
    });

    expect(screen.getByText(/Room Guide/i)).toBeInTheDocument();
    expect(screen.getByText(/Scribe Brief: Vector Spaces/i)).toBeInTheDocument();

    act(() => {
      capturedCallbacks?.onNpcOutOfRange?.('room-1');
    });

    expect(screen.queryByText(/Room Guide/i)).toBeNull();
  });

  it('clears NPC dialog when normal room interaction starts', async () => {
    render(<GameScreen />);

    await waitFor(() => {
      expect(capturedCallbacks).not.toBeNull();
    });

    act(() => {
      capturedCallbacks?.onNpcInteract?.({ roomId: 'room-1', clientX: 420, clientY: 260 });
    });
    expect(screen.getByText(/Room Guide/i)).toBeInTheDocument();

    act(() => {
      capturedCallbacks?.onInteract?.('room-1');
    });

    expect(screen.queryByText(/Room Guide/i)).toBeNull();
    expect(useSessionStore.getState().isNoteEditorOpen).toBe(true);
  });

  it('opens room topic activities instead of the note editor in creator phase', async () => {
    useSessionStore.setState({ phase: 'creator' });

    render(<GameScreen />);

    await waitFor(() => {
      expect(capturedCallbacks).not.toBeNull();
    });

    act(() => {
      capturedCallbacks?.onInteract?.('room-1');
    });

    expect(screen.getByTestId('room-panel')).toBeInTheDocument();
    expect(useSessionStore.getState().isNoteEditorOpen).toBe(false);
  });

  it('awards archaeologist XP only on first review per room per pass', async () => {
    const snapshot = makeSnapshot();
    snapshot.rooms['room-1'] = {
      ...snapshot.rooms['room-1'],
      state: 'ArtifactCollected',
      validationState: {
        ...snapshot.rooms['room-1'].validationState,
        finalPass: true,
      },
    };
    useSubjectStore.setState({ snapshot, lastError: null });
    act(() => {
      useSessionStore.setState({ phase: 'archaeologist' });
    });

    render(<GameScreen />);

    await waitFor(() => {
      expect(capturedCallbacks).not.toBeNull();
    });

    act(() => {
      capturedCallbacks?.onInteract?.('room-1');
    });
    expect(useProgressionStore.getState().xpTotal).toBe(6);

    act(() => {
      capturedCallbacks?.onInteract?.('room-1');
    });
    expect(useProgressionStore.getState().xpTotal).toBe(6);
  });

  it('only shows reviewed markers in archaeologist phase', async () => {
    const snapshot = makeSnapshot();
    snapshot.rooms['room-1'] = {
      ...snapshot.rooms['room-1'],
      state: 'ArtifactCollected',
      reviewPassCount: 1,
      validationState: {
        ...snapshot.rooms['room-1'].validationState,
        finalPass: true,
      },
    };
    useSubjectStore.setState({ snapshot, lastError: null });

    render(<GameScreen />);

    await waitFor(() => {
      expect(fakeScene.setReviewedArtifactRooms).toHaveBeenCalledWith([]);
    });

    useSessionStore.setState({ phase: 'archaeologist' });

    await waitFor(() => {
      expect(fakeScene.setReviewedArtifactRooms).toHaveBeenLastCalledWith(['room-1']);
    });
  });
});
