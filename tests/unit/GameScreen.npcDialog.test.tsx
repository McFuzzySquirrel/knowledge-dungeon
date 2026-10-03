import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GameScreen } from '@/ui/screens/GameScreen';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import type { FloorVisibilityModel } from '@/application/contracts/world';
import {
  buildReviewFixture,
  withEveryRoomCleared,
} from '../phase16/support/reviewFixtures';

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

vi.mock('@/core/graph', async () => {
  const actual = await vi.importActual<typeof import('@/core/graph')>('@/core/graph');
  return {
    ...actual,
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
  };
});

/*
 * Phase 16 re-pin: the pre-Phase-16 version of this file stubbed
 * `summarizeReviewAnalytics` to `{ fullReviewPasses: 0 }` and `isReviewableRoom`
 * to `true` over a one-room dungeon.
 *
 * Both stubs are gone, and the one-room dungeon with them. On a single reviewable
 * room `fullReviewPasses = trunc(reviewSessionCount / 1)`, so the very first
 * review advanced the pass number to 2 and the second close of the same room was
 * a *genuine* pass-2 review that the domain correctly paid again. The stub hid
 * the arithmetic; the fixture was the defect, and the test's premise ("XP only on
 * the first review per room per pass") was an artifact of the stub rather than a
 * statement about the domain.
 *
 * `makeReviewableSnapshot()` below is the three-room fixture from
 * `tests/phase16/support/reviewFixtures.ts` with every room cleared. Reviewing
 * one room twice stays inside pass 1 because two of the three rooms are still
 * outstanding, so the ledger - not a frozen counter - is what suppresses the
 * second award.
 *
 * `deriveGraphHierarchy` and `computeFloorVisibility` stay stubbed because they
 * only drive floor *visuals*; the real `createRootDungeon` / `addLinkedRooms`
 * the fixture builds with are spread through from `actual` above.
 */

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

/**
 * The three-room review fixture from `tests/phase16/support/reviewFixtures.ts`,
 * with every room cleared.
 *
 * Three rooms is the point. `deriveReviewPassProgress` computes
 * `fullReviewPasses = trunc(reviewSessionCount / reviewableRoomCount)`, so on one
 * room the first review completes a whole pass and the pass number advances;
 * on three rooms a single review leaves `reviewSessionCount = 1` against
 * `reviewableRoomCount = 3`, `fullReviewPasses = 0`, and `nextPassTarget = 1`.
 * Reviewing the same room a second time is then the same `(room, pass)` pair, and
 * the durable ledger suppresses it - which is the property this file claims to
 * test.
 *
 * Reused rather than rebuilt because `tests/phase16/reviewPasses.test.ts` and the
 * Phase 16 workspace tests already pin that module's behaviour on this fixture;
 * a second hand-written copy would be a second thing to keep in step.
 */
function makeReviewableSnapshot(): SubjectSnapshot {
  return withEveryRoomCleared(buildReviewFixture().snapshot);
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
    /*
     * `bySubject` is reset as well as the flattened view fields, and `activeSubjectId`
     * is cleared so `GameScreen`'s `setActiveSubject('subject-1')` seeds a *fresh*
     * record.
     *
     * Phase 16 makes this necessary: `extraFields[reviewPassRewardLedger]` rides on the
     * per-subject progression record, and `setActiveSubject` deliberately keeps an
     * existing record. Without the reset, a ledger entry written by an earlier test in
     * this file would suppress the first award of a later one and the file would
     * pass or fail on test order.
     */
    useProgressionStore.setState({
      activeSubjectId: null,
      bySubject: {},
      crossSubjectAchievements: [],
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
    const fixture = buildReviewFixture();
    const snapshot = makeReviewableSnapshot();
    useSubjectStore.setState({ snapshot, lastError: null });
    act(() => {
      useSessionStore.setState({ phase: 'archaeologist' });
    });

    render(<GameScreen />);

    await waitFor(() => {
      expect(capturedCallbacks).not.toBeNull();
    });

    act(() => {
      capturedCallbacks?.onInteract?.(fixture.matrixRoomId);
    });
    act(() => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
    });
    // `REVIEW_PASS_XP` in `src/store/progressionStore.ts`, with no equip bonus.
    expect(useProgressionStore.getState().xpTotal).toBe(6);

    /*
     * Still pass 1: one of three reviewable rooms reviewed is
     * `trunc(1/3) = 0` full passes, so the identity is the same
     * `(room, 1)` pair and the ledger suppresses it. The XP total therefore does
     * not move, and the SM-2 half of the write does not run either - see
     * `runPassComplete`'s gate on `progression.duplicate`.
     */
    act(() => {
      capturedCallbacks?.onInteract?.(fixture.matrixRoomId);
    });
    act(() => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
    });
    expect(useProgressionStore.getState().xpTotal).toBe(6);
    expect(useProgressionStore.getState().reviewPasses).toBe(1);

    /*
     * The positive control the old one-room fixture could not express: a
     * *different* room in the same pass is a different identity, so it still
     * awards. Without this, "the total did not move" would be satisfied by a
     * broken flow that simply never awards.
     */
    act(() => {
      capturedCallbacks?.onInteract?.(fixture.eigenRoomId);
    });
    act(() => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
    });
    expect(useProgressionStore.getState().xpTotal).toBe(12);
    expect(useProgressionStore.getState().reviewPasses).toBe(2);
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
            /*
             * Phase 16 re-pin: this room was left at `state: 'Created'`.
             *
             * `'Created'` is not in `REVIEWABLE_ROOM_STATES`, so
             * `canReviewRoom` refused the room with `room-not-cleared` *before*
             * anything was armed, and `closeInfoPanel` had nothing to finalize.
             * That is the newly enforced unlock behaving correctly; the assertion
             * below is about *deferral*, so the fixture now says what a deferred
             * review needs: the room's encounter is defeated
             * (`ArtifactCollected`) and its validation passed.
             */
            state: 'ArtifactCollected',
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
