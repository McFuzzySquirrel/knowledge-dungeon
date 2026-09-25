/**
 * Phase 2 contract test: the shared renderer-neutral study-flow controller.
 *
 * `src/application/studyFlow.ts` is the single home of the learning loop that
 * used to be inlined in `GameScreen` and `VillageScreen`. It has no renderer,
 * React, DOM, or store import, so the whole surface is exercised here through
 * injected fake ports: every side effect is a `vi.fn()`, which makes the guard
 * conditions and call ordering the screen had before Phase 2 observable.
 *
 * Coverage, operation by operation:
 * - `roomInteract` dispatch per learning phase, and the deferred review it records
 * - `closeInfoPanel` / `toggleInfoPanel` finalizing a deferred review exactly
 *   once, and only in the archaeologist phase
 * - `collectArtifact`: floor-label fallback, markdown preview derivation, and
 *   the journal only opening when the collection actually succeeded
 * - `changeFloor` in both directions, `travelToRoom` including the
 *   already-on-this-floor early return, and the teleport cooldown gate
 * - `returnToVillage` ordering, including clearing the persisted active id
 * - `structureApproached` / `structureInteract` routing for every village
 *   structure type
 * - `enterFishing` / `exitFishing`, including the regression guard that the
 *   mount check runs *before* any village UI state is cleared
 *
 * Every fixture below is obviously synthetic: `synthetic-*` ids and
 * `Test Room *` topics invented for this file, no learner data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStudyFlowController,
  resolveSubjectFloorBiome,
  toFloorVisibilityModel,
  type StudyFlowController,
  type StudyFlowDeps,
  type StudyFlowFishCaught,
  type StudyFlowPhase,
  type StudyFlowVillageSubject,
} from '@/application/studyFlow';
import type { FloorVisibilityModel } from '@/application/contracts/world';
import { TUTORIAL_SUBJECT_ID } from '@/data/tutorialSubject';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';

// ── Synthetic fixtures ──────────────────────────────────────────────────────

const SYNTHETIC_SUBJECT_ID = 'synthetic-subject-1';
const SYNTHETIC_SUBJECT_NAME = 'Synthetic Test Subject';
const SYNTHETIC_ROOM_ROOT = 'synthetic-room-root';
const SYNTHETIC_ROOM_ALPHA = 'synthetic-room-alpha';
const SYNTHETIC_ROOM_ALPHA_CHILD = 'synthetic-room-alpha-child';
const SYNTHETIC_ROOM_BETA = 'synthetic-room-beta';
const SYNTHETIC_ROOM_ORPHAN = 'synthetic-room-orphan';
const SYNTHETIC_NOW = '2026-09-25T00:00:00.000Z';

const SYNTHETIC_NOTE_MARKDOWN = [
  '# Synthetic Heading',
  '',
  'A synthetic note body with an ![alt](image.png) reference and a [link](https://example.invalid).',
  'It continues here so the derived preview is not empty.',
].join('\n');

const SYNTHETIC_ARTIFACT_MARKDOWN = [
  '# Synthetic Artifact Heading',
  '',
  'Synthetic artifact body used when a room has no note text yet.',
].join('\n');

function room(
  roomId: string,
  topic: string,
  overrides: Partial<RoomMetadata> = {},
): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic, nowIso: SYNTHETIC_NOW }),
    ...overrides,
  };
}

function dungeonMetadata(overrides: Partial<DungeonMetadata> = {}): DungeonMetadata {
  return {
    schemaVersion: '1.1.0',
    dungeonId: SYNTHETIC_SUBJECT_ID,
    subjectName: SYNTHETIC_SUBJECT_NAME,
    createdAt: SYNTHETIC_NOW,
    updatedAt: SYNTHETIC_NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: SYNTHETIC_ROOM_ROOT,
    rooms: [
      { roomId: SYNTHETIC_ROOM_ROOT, topic: 'Synthetic Root Floor', status: 'Created' },
      { roomId: SYNTHETIC_ROOM_ALPHA, topic: 'Test Room Alpha', status: 'ArtifactCollected' },
      {
        roomId: SYNTHETIC_ROOM_ALPHA_CHILD,
        topic: 'Test Room Alpha Child',
        status: 'Created',
      },
      { roomId: SYNTHETIC_ROOM_BETA, topic: 'Test Room Beta', status: 'Created' },
    ],
    edges: [
      {
        fromRoomId: SYNTHETIC_ROOM_ROOT,
        toRoomId: SYNTHETIC_ROOM_ALPHA,
        relationType: 'subtopic',
        createdAt: SYNTHETIC_NOW,
        createdByPhase: 'Scribe',
      },
      {
        fromRoomId: SYNTHETIC_ROOM_ALPHA,
        toRoomId: SYNTHETIC_ROOM_ALPHA_CHILD,
        relationType: 'subtopic',
        createdAt: SYNTHETIC_NOW,
        createdByPhase: 'Scribe',
      },
      {
        fromRoomId: SYNTHETIC_ROOM_ROOT,
        toRoomId: SYNTHETIC_ROOM_BETA,
        relationType: 'subtopic',
        createdAt: SYNTHETIC_NOW,
        createdByPhase: 'Scribe',
      },
    ],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    biome: 'scienceLabs',
    ...overrides,
  };
}

/**
 * A two-floor synthetic subject:
 * - `synthetic-room-root` is the root floor with two down portals.
 * - `synthetic-room-alpha` is a lower floor holding `synthetic-room-alpha-child`,
 *   reachable from the root floor by walking up through the root room.
 */
function makeSnapshot(overrides: Partial<SubjectSnapshot> = {}): SubjectSnapshot {
  return {
    dungeon: dungeonMetadata(),
    rooms: {
      [SYNTHETIC_ROOM_ROOT]: room(SYNTHETIC_ROOM_ROOT, 'Synthetic Root Floor'),
      [SYNTHETIC_ROOM_ALPHA]: room(SYNTHETIC_ROOM_ALPHA, 'Test Room Alpha', {
        state: 'ArtifactCollected',
        validationState: { ...makeEmptyValidationState(), finalPass: true },
        artifactMarkdown: SYNTHETIC_ARTIFACT_MARKDOWN,
      }),
      [SYNTHETIC_ROOM_ALPHA_CHILD]: room(
        SYNTHETIC_ROOM_ALPHA_CHILD,
        'Test Room Alpha Child',
      ),
      [SYNTHETIC_ROOM_BETA]: room(SYNTHETIC_ROOM_BETA, 'Test Room Beta'),
    },
    ...overrides,
  };
}

/** A room present in `rooms` but absent from `dungeon.rooms` (orphan). */
function makeOrphanSnapshot(): SubjectSnapshot {
  return makeSnapshot({
    dungeon: dungeonMetadata({
      rooms: [{ roomId: SYNTHETIC_ROOM_ALPHA, topic: 'Test Room Alpha', status: 'Created' }],
      edges: [],
    }),
    rooms: {
      [SYNTHETIC_ROOM_ALPHA]: room(SYNTHETIC_ROOM_ALPHA, 'Test Room Alpha'),
      [SYNTHETIC_ROOM_ORPHAN]: room(SYNTHETIC_ROOM_ORPHAN, 'Test Room Orphan', {
        artifactMarkdown: SYNTHETIC_ARTIFACT_MARKDOWN,
      }),
    },
  });
}

// ── Fake ports ──────────────────────────────────────────────────────────────

interface FakeFlow {
  deps: StudyFlowDeps;
  flow: StudyFlowController;
  store: Record<string, ReturnType<typeof vi.fn>>;
  renderer: Record<string, ReturnType<typeof vi.fn>>;
  teleport: Record<string, ReturnType<typeof vi.fn>>;
  dungeonUi: Record<string, ReturnType<typeof vi.fn>>;
  villageUi: Record<string, ReturnType<typeof vi.fn>>;
  villageStore: Record<string, ReturnType<typeof vi.fn>>;
  fishing: Record<string, ReturnType<typeof vi.fn>>;
  /** Mutable stand-in for the live learning phase. */
  phase: { current: StudyFlowPhase };
  /** Mutable stand-in for the live subject snapshot. */
  snapshot: { current: SubjectSnapshot | null };
  /** Mutable stand-in for the floor the renderer is showing. */
  currentFloorId: { current: string | null };
}

function createFakeFlow(options: { withVillagePorts?: boolean } = {}): FakeFlow {
  const withVillagePorts = options.withVillagePorts ?? true;
  const phase = { current: 'archaeologist' as StudyFlowPhase };
  const snapshot = { current: null as SubjectSnapshot | null };
  const currentFloorId = { current: null as string | null };

  const store: Record<string, ReturnType<typeof vi.fn>> = {
    getSnapshot: vi.fn(() => snapshot.current),
    getPhase: vi.fn(() => phase.current),
    persistActiveSubjectId: vi.fn(),
    setFocusedRoomId: vi.fn(),
    setActiveSubjectId: vi.fn(),
    setActiveScreen: vi.fn(),
    openNoteEditor: vi.fn(),
    closeMapView: vi.fn(),
    cancelTeleportMode: vi.fn(),
    setMobileHudOpen: vi.fn(),
    setProgressionActiveSubject: vi.fn(),
    collectArtifactNote: vi.fn(() => true),
    awardReviewPass: vi.fn(() => ({ xpGained: 25 })),
    awardBadge: vi.fn(),
    readProgressionBadges: vi.fn((): readonly string[] => []),
    recordReviewPass: vi.fn(async () => undefined),
  };

  const renderer: Record<string, ReturnType<typeof vi.fn>> = {
    setFloorVisibility: vi.fn(),
    teleportToRoom: vi.fn(),
  };

  const teleport: Record<string, ReturnType<typeof vi.fn>> = {
    remainingMs: vi.fn(() => 0),
    markConsumed: vi.fn(),
  };

  const dungeonUi: Record<string, ReturnType<typeof vi.fn>> = {
    pushToast: vi.fn(),
    requestRoomPanelTab: vi.fn(),
    setInfoPanelOpen: vi.fn(),
    isInfoPanelOpen: vi.fn(() => false),
    clearNpcDialog: vi.fn(),
    openJournalForCollectedNote: vi.fn(),
    getCurrentFloorId: vi.fn(() => currentFloorId.current),
    setCurrentFloorId: vi.fn((floorId: string) => {
      currentFloorId.current = floorId;
    }),
  };

  const villageUi: Record<string, ReturnType<typeof vi.fn>> = {
    setInfoPanel: vi.fn(),
    setWelcomeMessage: vi.fn(),
    setCreateOpen: vi.fn(),
    setMakeItYoursOpen: vi.fn(),
    setShowStats: vi.fn(),
    setFishCaught: vi.fn(),
    prepareFishingSession: vi.fn(),
  };

  const villageSubjects: StudyFlowVillageSubject[] = [
    {
      id: SYNTHETIC_SUBJECT_ID,
      subjectName: SYNTHETIC_SUBJECT_NAME,
      roomCount: 4,
      clearedRoomCount: 3,
    },
    {
      id: 'synthetic-subject-2',
      subjectName: 'Synthetic Second Subject',
      roomCount: 2,
      clearedRoomCount: 0,
    },
  ];

  const villageStore: Record<string, ReturnType<typeof vi.fn>> = {
    getSelectedClass: vi.fn(() => 'cartographer' as const),
    getVillageSubjects: vi.fn(() => villageSubjects),
    loadSubject: vi.fn(async () => makeSnapshot()),
    importSubjectSnapshot: vi.fn(async () => undefined),
    setActiveSubjectId: vi.fn(),
    setProgressionActiveSubject: vi.fn(),
    setActiveScreen: vi.fn(),
    setPhase: vi.fn(),
    setSelectedClass: vi.fn(),
    setQuestStep: vi.fn(),
    advanceQuestStep: vi.fn(),
  };

  const fishing: Record<string, ReturnType<typeof vi.fn>> = {
    isMounted: vi.fn(() => true),
    enter: vi.fn(),
    exit: vi.fn(),
  };

  const deps: StudyFlowDeps = {
    store: store as unknown as StudyFlowDeps['store'],
    renderer: renderer as unknown as StudyFlowDeps['renderer'],
    teleport: teleport as unknown as StudyFlowDeps['teleport'],
    dungeonUi: dungeonUi as unknown as StudyFlowDeps['dungeonUi'],
    ...(withVillagePorts
      ? {
          village: {
            content: { getDynamicStructures: () => [] },
            store: villageStore as never,
            ui: villageUi as never,
            fishing: fishing as never,
          },
        }
      : {}),
  };

  return {
    deps,
    flow: createStudyFlowController(deps),
    store,
    renderer,
    teleport,
    dungeonUi,
    villageUi,
    villageStore,
    fishing,
    phase,
    snapshot,
    currentFloorId,
  };
}

const SYNTHETIC_POND = 'pond-fish-nw';

let harness: FakeFlow;

beforeEach(() => {
  harness = createFakeFlow();
});

// ── Room interaction dispatch ───────────────────────────────────────────────

describe('Phase 2 study flow: room interaction dispatch', () => {
  it('opens the topic tab and the panel in the creator phase', () => {
    harness.phase.current = 'creator';
    harness.snapshot.current = makeSnapshot();

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);

    expect(harness.store.setMobileHudOpen).toHaveBeenCalledWith(false);
    expect(harness.dungeonUi.clearNpcDialog).toHaveBeenCalledTimes(1);
    expect(harness.store.setFocusedRoomId).toHaveBeenCalledWith(SYNTHETIC_ROOM_ALPHA);
    expect(harness.dungeonUi.requestRoomPanelTab).toHaveBeenCalledWith('topic');
    expect(harness.dungeonUi.setInfoPanelOpen).toHaveBeenCalledWith(true);
    expect(harness.store.openNoteEditor).not.toHaveBeenCalled();
  });

  it('opens the note editor in the scribe phase, with no panel', () => {
    harness.phase.current = 'scribe';
    harness.snapshot.current = makeSnapshot();

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);

    expect(harness.store.openNoteEditor).toHaveBeenCalledWith(SYNTHETIC_ROOM_ALPHA);
    expect(harness.dungeonUi.requestRoomPanelTab).not.toHaveBeenCalled();
    expect(harness.dungeonUi.setInfoPanelOpen).not.toHaveBeenCalled();
  });

  it('opens the notes tab and the panel in the archaeologist phase', () => {
    harness.phase.current = 'archaeologist';
    harness.snapshot.current = makeSnapshot();

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);

    expect(harness.dungeonUi.requestRoomPanelTab).toHaveBeenCalledWith('notes');
    expect(harness.dungeonUi.setInfoPanelOpen).toHaveBeenCalledWith(true);
    expect(harness.store.openNoteEditor).not.toHaveBeenCalled();
  });

  it('records a deferred review only for a room that already passed validation', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);
    harness.flow.closeInfoPanel();
    expect(harness.store.recordReviewPass).toHaveBeenCalledWith(SYNTHETIC_ROOM_ALPHA);

    harness.store.recordReviewPass.mockClear();
    // `synthetic-room-beta` has no final pass, so closing the panel records nothing.
    harness.flow.roomInteract(SYNTHETIC_ROOM_BETA);
    harness.flow.closeInfoPanel();
    expect(harness.store.recordReviewPass).not.toHaveBeenCalled();
  });

  it('drops a pending review when another room is interacted with', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);
    harness.flow.roomInteract(SYNTHETIC_ROOM_BETA);
    harness.flow.closeInfoPanel();

    expect(harness.store.recordReviewPass).not.toHaveBeenCalled();
  });
});

// ── Deferred review finalization ────────────────────────────────────────────

describe('Phase 2 study flow: deferred review finalization', () => {
  it('finalizes the deferred review exactly once when the panel closes', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);
    harness.flow.closeInfoPanel();
    harness.flow.closeInfoPanel();

    expect(harness.store.recordReviewPass).toHaveBeenCalledTimes(1);
    expect(harness.store.awardReviewPass).toHaveBeenCalledTimes(1);
  });

  it('never finalizes outside the archaeologist phase', () => {
    harness.snapshot.current = makeSnapshot();
    harness.phase.current = 'scribe';

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);
    harness.flow.closeInfoPanel();

    expect(harness.store.recordReviewPass).not.toHaveBeenCalled();
    expect(harness.store.awardReviewPass).not.toHaveBeenCalled();
    expect(harness.dungeonUi.setInfoPanelOpen).toHaveBeenCalledWith(false);
  });

  it('closes the panel before it finalizes the review', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);
    harness.flow.closeInfoPanel();

    const closeOrder = harness.dungeonUi.setInfoPanelOpen.mock.invocationCallOrder[1];
    const recordOrder = harness.store.recordReviewPass.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(recordOrder);
  });

  it('reports the reviewed-toward-next-pass count in a toast', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);
    harness.flow.closeInfoPanel();

    // Copy and numbers are pinned verbatim: the flow kept the message the
    // dungeon screen produced before Phase 2.
    expect(harness.dungeonUi.pushToast).toHaveBeenCalledWith(
      'info',
      'Review recorded (+25 XP): 0/4 rooms toward pass 2. Completed full passes: 1.',
    );
  });

  it('says the pass was already counted when no review xp is awarded', () => {
    harness.snapshot.current = makeSnapshot();
    harness.store.awardReviewPass.mockReturnValue({ xpGained: 0 });

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);
    harness.flow.closeInfoPanel();

    expect(harness.dungeonUi.pushToast).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('(already counted for this pass)'),
    );
  });

  it('awards no badge when every phase badge is already owned', () => {
    harness.snapshot.current = makeSnapshot();
    harness.store.readProgressionBadges.mockReturnValue([
      'CreatorPhaseComplete',
      'ScribePhaseComplete',
      'ArchaeologistPhaseComplete',
      'ArchaeologistReviewPass3',
      'ArchaeologistReviewPass7',
      'ArchaeologistReviewPass15',
    ]);

    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);
    harness.flow.closeInfoPanel();

    expect(harness.store.awardBadge).not.toHaveBeenCalled();
    expect(harness.store.readProgressionBadges).toHaveBeenCalled();
  });

  it('finalizes nothing when the room is not reviewable or no snapshot is loaded', () => {
    harness.snapshot.current = null;
    harness.flow.finalizePendingReview(SYNTHETIC_ROOM_ALPHA);
    expect(harness.store.recordReviewPass).not.toHaveBeenCalled();

    harness.snapshot.current = makeSnapshot();
    harness.flow.finalizePendingReview(SYNTHETIC_ROOM_BETA);
    expect(harness.store.recordReviewPass).not.toHaveBeenCalled();

    harness.flow.finalizePendingReview('synthetic-room-does-not-exist');
    expect(harness.store.recordReviewPass).not.toHaveBeenCalled();
  });

  it('toggles the panel closed through the finalizing path, and open otherwise', () => {
    harness.snapshot.current = makeSnapshot();
    harness.dungeonUi.isInfoPanelOpen.mockReturnValue(false);

    harness.flow.toggleInfoPanel();
    expect(harness.dungeonUi.setInfoPanelOpen).toHaveBeenLastCalledWith(true);
    expect(harness.store.recordReviewPass).not.toHaveBeenCalled();

    harness.dungeonUi.isInfoPanelOpen.mockReturnValue(true);
    harness.flow.toggleInfoPanel();
    expect(harness.dungeonUi.setInfoPanelOpen).toHaveBeenLastCalledWith(false);
  });
});

// ── Artifact collection ──────────────────────────────────────────────────────

describe('Phase 2 study flow: artifact collection', () => {
  it('collects a cleared room, labels the floor, and opens the journal', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.collectArtifact(SYNTHETIC_ROOM_ALPHA);

    expect(harness.store.collectArtifactNote).toHaveBeenCalledWith(
      expect.objectContaining({
        dungeonId: SYNTHETIC_SUBJECT_ID,
        roomId: SYNTHETIC_ROOM_ALPHA,
        topic: 'Test Room Alpha',
        floorLabel: 'Test Room Alpha',
      }),
    );
    expect(harness.dungeonUi.openJournalForCollectedNote).toHaveBeenCalledWith(
      `${SYNTHETIC_SUBJECT_ID}:${SYNTHETIC_ROOM_ALPHA}`,
    );
  });

  it('leaves the journal closed when the collection did not succeed', () => {
    harness.snapshot.current = makeSnapshot();
    harness.store.collectArtifactNote.mockReturnValue(false);

    harness.flow.collectArtifact(SYNTHETIC_ROOM_ALPHA);

    expect(harness.store.collectArtifactNote).toHaveBeenCalledTimes(1);
    expect(harness.dungeonUi.openJournalForCollectedNote).not.toHaveBeenCalled();
  });

  it('collects nothing without a snapshot or without an artifact to record', () => {
    harness.snapshot.current = null;
    harness.flow.collectArtifact(SYNTHETIC_ROOM_ALPHA);
    expect(harness.store.collectArtifactNote).not.toHaveBeenCalled();

    harness.snapshot.current = makeSnapshot();
    harness.flow.collectArtifact(SYNTHETIC_ROOM_BETA);
    expect(harness.store.collectArtifactNote).not.toHaveBeenCalled();

    harness.store.collectArtifactNote.mockClear();
    harness.flow.collectArtifact('synthetic-room-does-not-exist');
    expect(harness.store.collectArtifactNote).not.toHaveBeenCalled();
  });

  it('prefers note text and flattens headings, images, links, and whitespace', () => {
    harness.snapshot.current = makeSnapshot();
    harness.snapshot.current.rooms[SYNTHETIC_ROOM_ALPHA].noteText = SYNTHETIC_NOTE_MARKDOWN;

    harness.flow.collectArtifact(SYNTHETIC_ROOM_ALPHA);

    const entry = harness.store.collectArtifactNote.mock.calls[0][0] as {
      artifactPreview: string;
      noteMarkdown: string;
      artifactMarkdown: string;
    };
    expect(entry.noteMarkdown).toBe(SYNTHETIC_NOTE_MARKDOWN);
    expect(entry.artifactPreview).not.toContain('#');
    expect(entry.artifactPreview).not.toContain('![');
    expect(entry.artifactPreview).toContain('link');
    expect(entry.artifactPreview).not.toContain('https://example.invalid');
    expect(entry.artifactPreview).not.toMatch(/\s\s/);
    expect(entry.artifactPreview.length).toBeLessThanOrEqual(180);
  });

  it('truncates the derived preview to 180 characters', () => {
    harness.snapshot.current = makeSnapshot();
    harness.snapshot.current.rooms[SYNTHETIC_ROOM_ALPHA].noteText = 'x'.repeat(400);

    harness.flow.collectArtifact(SYNTHETIC_ROOM_ALPHA);

    const entry = harness.store.collectArtifactNote.mock.calls[0][0] as {
      artifactPreview: string;
    };
    expect(entry.artifactPreview).toHaveLength(180);
  });

  it('falls back to the artifact markdown when the room has no note text yet', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.collectArtifact(SYNTHETIC_ROOM_ALPHA);

    const entry = harness.store.collectArtifactNote.mock.calls[0][0] as {
      artifactPreview: string;
      noteMarkdown: string;
      artifactMarkdown: string;
    };
    expect(entry.noteMarkdown).toBe(SYNTHETIC_ARTIFACT_MARKDOWN);
    expect(entry.artifactMarkdown).toBe(SYNTHETIC_ARTIFACT_MARKDOWN);
    expect(entry.artifactPreview).toBe(
      'Synthetic artifact body used when a room has no note text yet.',
    );
  });

  it('labels an orphan room with the subject name instead of a floor topic', () => {
    harness.snapshot.current = makeOrphanSnapshot();

    harness.flow.collectArtifact(SYNTHETIC_ROOM_ORPHAN);

    expect(harness.store.collectArtifactNote).toHaveBeenCalledWith(
      expect.objectContaining({ floorLabel: SYNTHETIC_SUBJECT_NAME }),
    );
  });
});

// ── Floors, travel, and teleport ────────────────────────────────────────────

describe('Phase 2 study flow: floors, travel, and teleport', () => {
  it('descends through a portal by activating the floor of the portal room', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.changeFloor(SYNTHETIC_ROOM_ROOT, 'down');

    expect(harness.dungeonUi.setCurrentFloorId).toHaveBeenCalledWith(SYNTHETIC_ROOM_ROOT);
    expect(harness.renderer.setFloorVisibility).toHaveBeenCalledWith({
      floorId: SYNTHETIC_ROOM_ROOT,
      visibleRoomIds: [SYNTHETIC_ROOM_ROOT, SYNTHETIC_ROOM_ALPHA, SYNTHETIC_ROOM_BETA],
      portalUpRoomId: null,
      portalDownRoomIds: [SYNTHETIC_ROOM_ALPHA, SYNTHETIC_ROOM_BETA],
      biomeId: 'scienceLabs',
    });
    expect(harness.renderer.teleportToRoom).toHaveBeenCalledWith(SYNTHETIC_ROOM_ROOT);
  });

  it('ascends through a portal on the lower floor, exposing the up portal room', () => {
    harness.snapshot.current = makeSnapshot();
    harness.currentFloorId.current = SYNTHETIC_ROOM_ROOT;

    harness.flow.changeFloor(SYNTHETIC_ROOM_ALPHA, 'up');

    expect(harness.dungeonUi.setCurrentFloorId).toHaveBeenCalledWith(SYNTHETIC_ROOM_ALPHA);
    expect(harness.renderer.setFloorVisibility).toHaveBeenCalledWith({
      floorId: SYNTHETIC_ROOM_ALPHA,
      visibleRoomIds: [SYNTHETIC_ROOM_ALPHA, SYNTHETIC_ROOM_ALPHA_CHILD, SYNTHETIC_ROOM_ROOT],
      portalUpRoomId: SYNTHETIC_ROOM_ROOT,
      portalDownRoomIds: [],
      biomeId: 'scienceLabs',
    });
    expect(harness.renderer.teleportToRoom).toHaveBeenCalledWith(SYNTHETIC_ROOM_ALPHA);
  });

  it('falls back to the room id when the portal room is not in the graph', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.changeFloor('synthetic-room-unmapped', 'down');

    expect(harness.dungeonUi.setCurrentFloorId).toHaveBeenCalledWith('synthetic-room-unmapped');
  });

  it('ignores a floor change with no loaded snapshot', () => {
    harness.snapshot.current = null;

    harness.flow.changeFloor(SYNTHETIC_ROOM_ROOT, 'down');

    expect(harness.dungeonUi.setCurrentFloorId).not.toHaveBeenCalled();
    expect(harness.renderer.setFloorVisibility).not.toHaveBeenCalled();
    expect(harness.renderer.teleportToRoom).not.toHaveBeenCalled();
  });

  it('drops an unresolvable subject biome instead of leaking a bad id', () => {
    harness.snapshot.current = makeSnapshot({
      dungeon: dungeonMetadata({ biome: 'not-a-real-biome' }),
    });

    harness.flow.changeFloor(SYNTHETIC_ROOM_ROOT, 'down');

    const visibility = harness.renderer.setFloorVisibility.mock.calls[0][0] as
      FloorVisibilityModel;
    expect(visibility.biomeId).toBeUndefined();
    expect(resolveSubjectFloorBiome('not-a-real-biome')).toBeUndefined();
    expect(resolveSubjectFloorBiome('sunkenSwamp')).toBe('sunkenSwamp');
    expect(resolveSubjectFloorBiome(null)).toBeUndefined();
  });

  it('switches floors when travelling to a room on another floor', () => {
    harness.snapshot.current = makeSnapshot();
    harness.currentFloorId.current = SYNTHETIC_ROOM_ROOT;

    harness.flow.travelToRoom(SYNTHETIC_ROOM_ALPHA_CHILD);

    expect(harness.dungeonUi.setCurrentFloorId).toHaveBeenCalledWith(SYNTHETIC_ROOM_ALPHA);
    expect(harness.renderer.setFloorVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ floorId: SYNTHETIC_ROOM_ALPHA }),
    );
    expect(harness.renderer.teleportToRoom).toHaveBeenCalledWith(SYNTHETIC_ROOM_ALPHA_CHILD);
  });

  it('returns early from the floor sync when already on that floor, but still teleports', () => {
    harness.snapshot.current = makeSnapshot();
    harness.currentFloorId.current = SYNTHETIC_ROOM_ALPHA;

    harness.flow.travelToRoom(SYNTHETIC_ROOM_BETA);

    // `synthetic-room-beta` is its own floor, so this is not a no-op; the
    // early return is what a second room on the *current* floor exercises.
    harness.renderer.setFloorVisibility.mockClear();
    harness.dungeonUi.setCurrentFloorId.mockClear();
    harness.currentFloorId.current = SYNTHETIC_ROOM_ALPHA;

    harness.flow.travelToRoom(SYNTHETIC_ROOM_ALPHA_CHILD);

    expect(harness.dungeonUi.setCurrentFloorId).not.toHaveBeenCalled();
    expect(harness.renderer.setFloorVisibility).not.toHaveBeenCalled();
    expect(harness.renderer.teleportToRoom).toHaveBeenCalledWith(SYNTHETIC_ROOM_ALPHA_CHILD);
  });

  it('consumes the teleport cooldown and closes the map when the gate is open', () => {
    harness.snapshot.current = makeSnapshot();
    harness.currentFloorId.current = SYNTHETIC_ROOM_ROOT;
    harness.teleport.remainingMs.mockReturnValue(0);

    harness.flow.teleportToRoom(SYNTHETIC_ROOM_ALPHA);

    expect(harness.renderer.teleportToRoom).toHaveBeenCalledWith(SYNTHETIC_ROOM_ALPHA);
    expect(harness.teleport.markConsumed).toHaveBeenCalledTimes(1);
    expect(harness.teleport.markConsumed.mock.calls[0][0]).toBeTypeOf('number');
    expect(harness.store.closeMapView).toHaveBeenCalledTimes(1);
  });

  it('refuses the teleport while the cooldown is still running', () => {
    harness.snapshot.current = makeSnapshot();
    harness.teleport.remainingMs.mockReturnValue(1200);

    harness.flow.teleportToRoom(SYNTHETIC_ROOM_ALPHA);

    expect(harness.teleport.remainingMs).toHaveBeenCalled();
    expect(harness.renderer.teleportToRoom).not.toHaveBeenCalled();
    expect(harness.teleport.markConsumed).not.toHaveBeenCalled();
    expect(harness.store.closeMapView).not.toHaveBeenCalled();
  });

  it('reads the floor the renderer is showing', () => {
    harness.currentFloorId.current = SYNTHETIC_ROOM_ALPHA;
    expect(harness.flow.getCurrentFloorId()).toBe(SYNTHETIC_ROOM_ALPHA);
  });

  it('builds a renderer-neutral floor visibility model for a snapshot floor', () => {
    const model = harness.flow.buildFloorVisibilityModel(makeSnapshot(), SYNTHETIC_ROOM_ALPHA);

    expect(model).toEqual({
      floorId: SYNTHETIC_ROOM_ALPHA,
      visibleRoomIds: [SYNTHETIC_ROOM_ALPHA, SYNTHETIC_ROOM_ALPHA_CHILD, SYNTHETIC_ROOM_ROOT],
      portalUpRoomId: SYNTHETIC_ROOM_ROOT,
      portalDownRoomIds: [],
      biomeId: 'scienceLabs',
    });
    expect(model.visibleRoomIds).not.toBe(model.portalDownRoomIds);
    expect(toFloorVisibilityModel(
      {
        floorId: SYNTHETIC_ROOM_ROOT,
        floorRoomIds: new Set([SYNTHETIC_ROOM_ROOT]),
        portalUpRoomId: null,
        portalDownRoomIds: new Set([SYNTHETIC_ROOM_BETA]),
        visibleRoomIds: new Set([SYNTHETIC_ROOM_ROOT, SYNTHETIC_ROOM_BETA]),
      },
      undefined,
    )).toEqual({
      floorId: SYNTHETIC_ROOM_ROOT,
      visibleRoomIds: [SYNTHETIC_ROOM_ROOT, SYNTHETIC_ROOM_BETA],
      portalUpRoomId: null,
      portalDownRoomIds: [SYNTHETIC_ROOM_BETA],
      biomeId: undefined,
    });
  });
});

// ── Returning to the village ────────────────────────────────────────────────

describe('Phase 2 study flow: returning to the village', () => {
  it('clears every dungeon-scoped id, including the persisted active subject', () => {
    harness.flow.returnToVillage();

    expect(harness.store.setActiveSubjectId).toHaveBeenCalledWith(null);
    expect(harness.store.persistActiveSubjectId).toHaveBeenCalledWith(null);
    expect(harness.store.setProgressionActiveSubject).toHaveBeenCalledWith(null);
    expect(harness.store.setFocusedRoomId).toHaveBeenCalledWith(null);
    expect(harness.store.cancelTeleportMode).toHaveBeenCalledTimes(1);
    expect(harness.store.closeMapView).toHaveBeenCalledTimes(1);
    expect(harness.store.setActiveScreen).toHaveBeenCalledWith('village');
  });

  it('clears the persisted active subject id in the same order as the session id', () => {
    harness.flow.returnToVillage();

    const sessionOrder = harness.store.setActiveSubjectId.mock.invocationCallOrder[0];
    const persistOrder = harness.store.persistActiveSubjectId.mock.invocationCallOrder[0];
    const screenOrder = harness.store.setActiveScreen.mock.invocationCallOrder[0];

    expect(sessionOrder).toBeLessThan(persistOrder);
    expect(persistOrder).toBeLessThan(screenOrder);
  });

  it('drops a deferred review so returning cannot record one later', () => {
    harness.snapshot.current = makeSnapshot();
    harness.flow.roomInteract(SYNTHETIC_ROOM_ALPHA);

    harness.flow.returnToVillage();
    harness.flow.closeInfoPanel();

    expect(harness.store.recordReviewPass).not.toHaveBeenCalled();
  });
});

// ── Village structure routing ───────────────────────────────────────────────

describe('Phase 2 study flow: village structure routing', () => {
  it('routes every static structure type to its approach panel', () => {
    harness.snapshot.current = makeSnapshot();
    const expected: Array<[string, string]> = [
      ['keeper-tower', 'quest-board'],
      ['guild-hall', 'guild'],
      ['training-gate', 'training'],
      ['trophy-hall', 'trophy'],
      ['library', 'library'],
      ['artisan-workshop', 'workshop'],
      ['central-fountain', 'fountain'],
      [SYNTHETIC_POND, 'fishing-pond'],
      ['fish-stand', 'fish-stand'],
    ];

    for (const [structureId, panelType] of expected) {
      harness.villageUi.setInfoPanel.mockClear();
      harness.flow.structureApproached(structureId);
      expect(harness.villageUi.setInfoPanel, structureId).toHaveBeenCalledWith(
        expect.objectContaining({ type: panelType, structureId }),
      );
    }
  });

  it('resolves a signpost or waysign to the signpost panel and the entrance welcome', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.structureApproached('sign-entrance');

    expect(harness.villageUi.setInfoPanel).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'signpost', structureId: 'sign-entrance' }),
    );
    expect(harness.villageUi.setWelcomeMessage).toHaveBeenCalledWith(
      expect.stringContaining('Welcome to the Dungeon Village!'),
    );

    harness.villageUi.setWelcomeMessage.mockClear();
    harness.flow.structureApproached('sign-center');
    expect(harness.villageUi.setWelcomeMessage).not.toHaveBeenCalled();
  });

  it('resolves a dynamic portal icon to the dungeon panel for the listed subject', () => {
    const dynamic = createFakeFlow();
    dynamic.deps.village!.content.getDynamicStructures = () => [
      {
        id: 'synthetic-portal-icon',
        type: 'portal-icon',
        label: 'Synthetic Portal',
        gridX: 3,
        gridY: 3,
        width: 1,
        height: 1,
        subjectId: SYNTHETIC_SUBJECT_ID,
        subjectName: SYNTHETIC_SUBJECT_NAME,
        roomCount: 4,
        clearedCount: 3,
      },
    ];

    dynamic.flow.structureApproached('synthetic-portal-icon');

    expect(dynamic.villageUi.setInfoPanel).toHaveBeenCalledWith({
      type: 'dungeon',
      structureId: 'synthetic-portal-icon',
      subject: {
        id: SYNTHETIC_SUBJECT_ID,
        subjectName: SYNTHETIC_SUBJECT_NAME,
        roomCount: 4,
        clearedRoomCount: 3,
      },
    });
  });

  it('opens the dungeon panel with no subject for an unmatched portal subject', () => {
    harness.flow.structureApproached('synthetic-portal-unknown');

    // No such structure exists at all, so nothing is routed.
    expect(harness.villageUi.setInfoPanel).not.toHaveBeenCalled();
  });

  it('clears the panel on approach-exit and clears only the entrance welcome', () => {
    harness.flow.structureLeft('keeper-tower');
    expect(harness.villageUi.setInfoPanel).toHaveBeenCalledWith(null);
    expect(harness.villageUi.setWelcomeMessage).not.toHaveBeenCalled();

    harness.flow.structureLeft('sign-entrance');
    expect(harness.villageUi.setInfoPanel).toHaveBeenCalledWith(null);
    expect(harness.villageUi.setWelcomeMessage).toHaveBeenCalledWith(null);
  });

  it('activates a subject and enters the dungeon through a portal interaction', async () => {
    const dynamic = createFakeFlow();
    dynamic.deps.village!.content.getDynamicStructures = () => [
      {
        id: 'synthetic-portal-icon',
        type: 'portal-icon',
        label: 'Synthetic Portal',
        gridX: 3,
        gridY: 3,
        width: 1,
        height: 1,
        subjectId: SYNTHETIC_SUBJECT_ID,
      },
    ];

    dynamic.flow.structureInteract('synthetic-portal-icon');
    await vi.waitFor(() => {
      expect(dynamic.villageStore.setActiveScreen).toHaveBeenCalledWith('game');
    });

    expect(dynamic.villageStore.setPhase).toHaveBeenCalledWith('scribe');
    expect(dynamic.villageStore.setSelectedClass).toHaveBeenCalledWith('cartographer');
    expect(dynamic.villageStore.loadSubject).toHaveBeenCalledWith(SYNTHETIC_SUBJECT_ID);
    expect(dynamic.villageStore.setActiveSubjectId).toHaveBeenCalledWith(SYNTHETIC_SUBJECT_ID);
    expect(dynamic.villageStore.setProgressionActiveSubject).toHaveBeenCalledWith(
      SYNTHETIC_SUBJECT_ID,
    );
  });

  it('falls back to the scholar archetype when none is selected', async () => {
    const dynamic = createFakeFlow();
    dynamic.villageStore.getSelectedClass.mockReturnValue(null);
    dynamic.deps.village!.content.getDynamicStructures = () => [
      {
        id: 'synthetic-portal-icon',
        type: 'portal-icon',
        label: 'Synthetic Portal',
        gridX: 3,
        gridY: 3,
        width: 1,
        height: 1,
        subjectId: SYNTHETIC_SUBJECT_ID,
      },
    ];

    dynamic.flow.structureInteract('synthetic-portal-icon');
    await vi.waitFor(() => {
      expect(dynamic.villageStore.setSelectedClass).toHaveBeenCalledWith('scholar');
    });
  });

  it('routes every interactable structure type to its own outcome', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.structureInteract('keeper-tower');
    expect(harness.villageUi.setInfoPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'quest-board' }),
    );

    harness.flow.structureInteract('guild-hall');
    expect(harness.villageUi.setCreateOpen).toHaveBeenCalledWith(true);
    expect(harness.villageStore.advanceQuestStep).toHaveBeenCalledTimes(1);

    harness.flow.structureInteract('trophy-hall');
    expect(harness.villageUi.setInfoPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'trophy' }),
    );

    harness.flow.structureInteract('sign-center');
    expect(harness.villageUi.setInfoPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'signpost' }),
    );

    harness.flow.structureInteract('library');
    expect(harness.villageUi.setInfoPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'library' }),
    );

    harness.flow.structureInteract('artisan-workshop');
    expect(harness.villageUi.setMakeItYoursOpen).toHaveBeenCalledWith(true);

    harness.flow.structureInteract('central-fountain');
    expect(harness.villageUi.setShowStats).toHaveBeenCalledWith(true);

    harness.flow.structureInteract('fish-stand');
    expect(harness.villageUi.setInfoPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'fish-stand' }),
    );

    harness.flow.structureInteract(SYNTHETIC_POND);
    expect(harness.fishing.enter).toHaveBeenCalledTimes(1);
  });

  it('ignores an interaction with a structure that does not exist', () => {
    harness.flow.structureInteract('synthetic-structure-does-not-exist');

    expect(harness.villageUi.setInfoPanel).not.toHaveBeenCalled();
    expect(harness.villageUi.setCreateOpen).not.toHaveBeenCalled();
    expect(harness.fishing.enter).not.toHaveBeenCalled();
  });

  it('routes the training gate through the tutorial subject import', async () => {
    harness.flow.structureInteract('training-gate');

    await vi.waitFor(() => {
      expect(harness.villageStore.setActiveScreen).toHaveBeenCalledWith('game');
    });
    expect(harness.villageStore.importSubjectSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.villageStore.setQuestStep).toHaveBeenCalledWith('enter-dungeon');
    expect(harness.villageStore.loadSubject).toHaveBeenCalledWith(TUTORIAL_SUBJECT_ID);
  });
});

// ── Fishing ─────────────────────────────────────────────────────────────────

describe('Phase 2 study flow: fishing', () => {
  it('starts fishing at the pond with the nearest portal subject cleared state', () => {
    harness.snapshot.current = makeSnapshot();

    harness.flow.enterFishing(SYNTHETIC_POND);

    expect(harness.villageUi.prepareFishingSession).toHaveBeenCalledTimes(1);
    expect(harness.fishing.enter).toHaveBeenCalledTimes(1);
    const input = harness.fishing.enter.mock.calls[0][0] as {
      pondId: string;
      playerClass: string;
      hasClearedRooms: boolean;
    };
    expect(input.pondId).toBe(SYNTHETIC_POND);
    expect(input.playerClass).toBe('cartographer');
    expect(input.hasClearedRooms).toBe(true);
  });

  it('derives hasClearedRooms from the subject occupying the nearest portal slot', () => {
    const dynamic = createFakeFlow();
    dynamic.villageStore.getVillageSubjects.mockReturnValue([
      {
        id: SYNTHETIC_SUBJECT_ID,
        subjectName: SYNTHETIC_SUBJECT_NAME,
        roomCount: 4,
        clearedRoomCount: 0,
      },
    ]);

    dynamic.flow.enterFishing(SYNTHETIC_POND);

    const input = dynamic.fishing.enter.mock.calls[0][0] as { hasClearedRooms: boolean };
    expect(input.hasClearedRooms).toBe(false);
  });

  it('defaults hasClearedRooms to true when the pond maps to no portal slot', () => {
    harness.fishing.enter.mockClear();

    harness.flow.enterFishing('synthetic-pond-not-in-the-map');

    const input = harness.fishing.enter.mock.calls[0][0] as { hasClearedRooms: boolean };
    expect(input.hasClearedRooms).toBe(true);
  });

  it('checks the mount guard before clearing any village UI state', () => {
    harness.snapshot.current = makeSnapshot();
    harness.fishing.isMounted.mockReturnValue(false);

    harness.flow.enterFishing(SYNTHETIC_POND);

    // The pre-Phase-2 village screen did `if (!gameRef.current) return;` above
    // its four `set…(null)` calls, so with no world host mounted the info
    // panel, catch dialog, and recall dialog all stayed open. Reordering the
    // guard would be a user-visible change.
    expect(harness.villageUi.prepareFishingSession).not.toHaveBeenCalled();
    expect(harness.fishing.enter).not.toHaveBeenCalled();
    expect(harness.villageUi.setInfoPanel).not.toHaveBeenCalled();
    expect(harness.villageUi.setFishCaught).not.toHaveBeenCalled();
  });

  it('routes a caught fish to the village catch dialog', () => {
    harness.flow.enterFishing(SYNTHETIC_POND);
    const input = harness.fishing.enter.mock.calls[0][0] as {
      onFishCaught: (data: StudyFlowFishCaught) => void;
    };
    const caught: StudyFlowFishCaught = {
      fishName: 'Synthetic Test Fish',
      rarity: 'common',
      catalogId: 'synthetic-fish-1',
      description: 'A synthetic fish invented for contract tests.',
    };

    input.onFishCaught(caught);

    expect(harness.villageUi.setFishCaught).toHaveBeenCalledWith(caught);
  });

  it('routes the scene return request back out through the fishing host', () => {
    harness.flow.enterFishing(SYNTHETIC_POND);
    const input = harness.fishing.enter.mock.calls[0][0] as {
      onReturnToVillage: () => void;
    };

    input.onReturnToVillage();

    expect(harness.fishing.exit).toHaveBeenCalledTimes(1);
  });

  it('exits fishing through the host', () => {
    harness.flow.exitFishing();
    expect(harness.fishing.exit).toHaveBeenCalledTimes(1);
  });

  it('is inert when the host presents the dungeon world only', () => {
    const dungeonOnly = createFakeFlow({ withVillagePorts: false });

    dungeonOnly.flow.structureApproached('keeper-tower');
    dungeonOnly.flow.structureInteract('guild-hall');
    dungeonOnly.flow.enterFishing(SYNTHETIC_POND);
    dungeonOnly.flow.exitFishing();

    expect(dungeonOnly.villageUi.setInfoPanel).not.toHaveBeenCalled();
    expect(dungeonOnly.villageUi.setCreateOpen).not.toHaveBeenCalled();
    expect(dungeonOnly.fishing.enter).not.toHaveBeenCalled();
    expect(dungeonOnly.fishing.exit).not.toHaveBeenCalled();
  });
});
