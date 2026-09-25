import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GameScreen } from '@/ui/screens/GameScreen';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import type { FloorVisibilityModel } from '@/application/contracts/world';

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

/**
 * Stand-in for the Phaser scene handle the adapter drives. The adapter is
 * mocked out, so these spies record exactly what the screen asked the world
 * to do.
 */
interface MockScene {
  setArtifactRooms: Mock<(roomIds: readonly string[], visible: boolean) => void>;
  setCollectedArtifactRooms: Mock<(roomIds: readonly string[]) => void>;
  setReviewedArtifactRooms: Mock<(roomIds: readonly string[]) => void>;
  setImageRooms: Mock<(roomIds: readonly string[]) => void>;
  setFloorVisibility: Mock<(visibility: FloorVisibilityModel) => void>;
  teleportToRoom: Mock<(roomId: string) => void>;
  triggerInteract: Mock<() => void>;
  setRoomOverlayStates: Mock<(states: Record<string, string>) => void>;
}

/**
 * The renderer seam `@/game/createGame` now hands back: the neutral
 * `WorldRenderer` lifecycle, the neutral dungeon capabilities, and one
 * readiness subscription. The capabilities delegate to `fakeScene` so the
 * assertions below still observe what the screen asked the world to do.
 */
interface MockRenderer {
  mount: () => void;
  unmount: () => void;
  isReady: () => boolean;
  restart: () => void;
  onReady: (listener: () => void) => () => void;
  setArtifactRooms: (roomIds: readonly string[], visible: boolean) => void;
  setCollectedArtifactRooms: (roomIds: readonly string[]) => void;
  setReviewedArtifactRooms: (roomIds: readonly string[]) => void;
  setImageRooms: (roomIds: readonly string[]) => void;
  setFloorVisibility: (visibility: FloorVisibilityModel) => void;
  teleportToRoom: (roomId: string) => void;
  triggerInteract: () => void;
  setRoomOverlayStates: (states: Record<string, string>) => void;
}

const createGameMock = vi.fn<(options: Record<string, unknown>) => MockRenderer>();
let capturedCallbacks: CapturedCallbacks | null = null;
let fakeScene: MockScene;
const roomPanelProps = vi.fn<
  (props: { onClose: () => void; requestedTab?: { tab: string; sequence: number } | null }) => void
>();

vi.mock('@/game/createGame', () => ({
  createGame: (options: Record<string, unknown>) => {
    capturedCallbacks = (options.callbacks as CapturedCallbacks) ?? null;
    return createGameMock(options);
  },
}));

vi.mock('@/core/layout/dungeonGenerator', () => ({
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

vi.mock('@/core/review', async () => {
  const actual = await vi.importActual<typeof import('@/core/review')>('@/core/review');
  return {
    ...actual,
    isReviewableRoom: () => true,
    summarizeReviewAnalytics: () => ({ fullReviewPasses: 0 }),
  };
});

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
  RoomPanel: (props: {
    onClose: () => void;
    requestedTab?: { tab: string; sequence: number } | null;
  }) => {
    roomPanelProps(props);
    return (
      <div data-testid="room-panel">
        <button type="button" onClick={props.onClose}>
          Close room panel
        </button>
        <span>{props.requestedTab?.tab ?? 'no-tab'}</span>
      </div>
    );
  },
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

/**
 * Build a mock for the renderer seam. `mount()` flushes the readiness
 * listeners the way the real adapter does when the engine's ready event
 * lands, so the screen takes exactly the same code path it takes live.
 */
function createMockRenderer(): MockRenderer {
  let mounted = false;
  let readyListeners: (() => void)[] = [];
  return {
    mount: () => {
      mounted = true;
      const listeners = readyListeners;
      readyListeners = [];
      for (const listener of listeners) listener();
    },
    unmount: () => {
      mounted = false;
      readyListeners = [];
    },
    isReady: () => mounted,
    restart: vi.fn(),
    onReady: (listener: () => void) => {
      readyListeners.push(listener);
      return () => {
        readyListeners = readyListeners.filter((entry) => entry !== listener);
      };
    },
    setArtifactRooms: (roomIds, visible) => fakeScene.setArtifactRooms(roomIds, visible),
    setCollectedArtifactRooms: (roomIds) => fakeScene.setCollectedArtifactRooms(roomIds),
    setReviewedArtifactRooms: (roomIds) => fakeScene.setReviewedArtifactRooms(roomIds),
    setImageRooms: (roomIds) => fakeScene.setImageRooms(roomIds),
    setFloorVisibility: (visibility) => fakeScene.setFloorVisibility(visibility),
    teleportToRoom: (roomId) => fakeScene.teleportToRoom(roomId),
    triggerInteract: () => fakeScene.triggerInteract(),
    setRoomOverlayStates: (states) => fakeScene.setRoomOverlayStates(states),
  };
}

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
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
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
    roomPanelProps.mockReset();

    fakeScene = {
      setArtifactRooms: vi.fn<(roomIds: readonly string[], visible: boolean) => void>(),
      setCollectedArtifactRooms: vi.fn<(roomIds: readonly string[]) => void>(),
      setReviewedArtifactRooms: vi.fn<(roomIds: readonly string[]) => void>(),
      setImageRooms: vi.fn<(roomIds: readonly string[]) => void>(),
      setRoomOverlayStates: vi.fn<(states: Record<string, string>) => void>(),
      setFloorVisibility: vi.fn<(visibility: FloorVisibilityModel) => void>(),
      teleportToRoom: vi.fn<(roomId: string) => void>(),
      triggerInteract: vi.fn<() => void>(),
    };

    createGameMock.mockReturnValue(createMockRenderer());

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
    act(() => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
    });
    expect(useProgressionStore.getState().xpTotal).toBe(6);

    act(() => {
      capturedCallbacks?.onInteract?.('room-1');
    });
    act(() => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
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

    const { unmount } = render(<GameScreen />);

    await waitFor(() => {
      expect(fakeScene?.setReviewedArtifactRooms).toHaveBeenCalledWith([]);
    });

    unmount();
    createGameMock.mockClear();
    useSessionStore.setState({ phase: 'archaeologist' });

    render(<GameScreen />);

    await waitFor(() => {
      expect(fakeScene?.setReviewedArtifactRooms).toHaveBeenLastCalledWith(['room-1']);
    });
  });

  it('defers archaeologist review until the note panel is closed', async () => {
    const baseSnapshot = makeSnapshot();
    useSessionStore.setState({ phase: 'archaeologist' });
    useSubjectStore.setState({
      snapshot: {
        ...baseSnapshot,
        rooms: {
          'room-1': {
            ...baseSnapshot.rooms['room-1'],
            noteText: 'Review these notes.',
            validationState: {
              ...baseSnapshot.rooms['room-1'].validationState,
              finalPass: true,
            },
          },
        },
      },
      recordReviewPass: vi.fn(),
    });

    render(<GameScreen />);

    await waitFor(() => {
      expect(capturedCallbacks).not.toBeNull();
    });

    act(() => {
      capturedCallbacks?.onInteract?.('room-1');
    });

    const lastRoomPanelProps = roomPanelProps.mock.lastCall?.[0];
    expect(useSessionStore.getState().isNoteEditorOpen).toBe(false);
    expect(screen.getByTestId('room-panel')).toBeInTheDocument();
    expect(lastRoomPanelProps?.requestedTab?.tab).toBe('notes');
    expect(useSubjectStore.getState().recordReviewPass).not.toHaveBeenCalled();

    act(() => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
    });

    expect(useSubjectStore.getState().recordReviewPass).toHaveBeenCalledWith('room-1');
  });
});
