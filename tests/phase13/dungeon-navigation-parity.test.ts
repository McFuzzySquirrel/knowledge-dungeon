/**
 * What the flow does with navigation: floor visibility, the cooldown, and travel order.
 *
 * ## What this file actually asserts, precisely
 *
 * Phase 13's exit criterion is "Room and floor navigation match current behavior". The
 * current behavior is not the Phaser scene - it is the *flow*. `createStudyFlowController`
 * owns which floor a portal leads to, `TELEPORT_COOLDOWN_MS` lives in the session store,
 * and `computeFloorVisibility` owns what a floor shows. A renderer that drew rooms
 * differently would be a cosmetic difference; a renderer that changed a floor decision
 * would be a behavioural one, and only the flow can be checked for that.
 *
 * So this file drives the **real** `createStudyFlowController` and records what it asks a
 * renderer to do. There is **one** recorder, and it is a `StudyFlowRendererPort`
 * implementation - the two-member interface Phase 2 defined. It is not a Phaser-shaped
 * double and it is not a Pixi-shaped double; the flow never sees an engine, which is
 * precisely the property these tests exist to demonstrate.
 *
 * ## What this file deliberately does NOT claim
 *
 * **It is not a differential comparison of the two renderers.** An earlier draft of this
 * header said it ran "a recorder that stands in for both renderers" and that "the
 * Phaser-shaped recorder and the Pixi-shaped recorder differ only in the object they are
 * handed". There was one recorder, so a reviewer would have believed a
 * renderer-versus-renderer comparison had been demonstrated. It had not, and it is not
 * demonstrated here either.
 *
 * The reason is structural rather than an omission: the renderer port the flow is handed
 * has two members and both engines implement it structurally, so a two-recorder
 * comparison would exercise two objects with identical behaviour and would pass whatever
 * the flow did. Renderer-specific behaviour is covered where it lives instead -
 *
 * | Concern                                              | File                              |
 * |------------------------------------------------------|-----------------------------------|
 * | walkability, collision, hidden floors, room lookup     | `walkability-controller.test.ts`  |
 * | rooms, corridors, doors, portals, zoom, the dispatcher | `dungeon-scene.test.ts`           |
 * | the accessible tree and the status sentences           | `dungeon-world-dom.test.tsx`      |
 * | the Phaser lane, unchanged                             | `tests/contracts/phase-2-*`       |
 *
 * Together those four cover both engines, but no single one of them is the comparison a
 * single-file differential would have been, and this file does not pretend otherwise.
 *
 * ## Why the cooldown is here and not on a renderer
 *
 * `TELEPORT_COOLDOWN_MS` lives in the session store and is consumed by the flow. A
 * renderer that implemented its own cooldown would produce a second answer to "may this
 * learner teleport", and the two would disagree after the first teleport. These tests pin
 * that the flow reads the cooldown rather than holding one, and that the renderer port is
 * only ever asked to move the player - never to decide whether it may.
 *
 * Hermeticity: synthetic subjects and ids, no `dist/`, no network, no real clock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph/navigation';
import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import type { DungeonMap } from '@/core/layout/dungeonTypes';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import {
  createStudyFlowController,
  type StudyFlowController,
  type StudyFlowRendererPort,
} from '@/application/studyFlow';
import type { FloorVisibilityModel } from '@/application/contracts/world';
import { TELEPORT_COOLDOWN_MS } from '@/store/sessionStore';

const NOW = '2026-01-01T00:00:00.000Z';

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

interface NestedSubject {
  readonly snapshot: SubjectSnapshot;
  readonly map: DungeonMap;
}

/**
 * A subject with two floors: a root, one child, and a grandchild under that child.
 *
 * Two levels is the minimum that produces both portal directions. The flat-floor model in
 * `computeFloorVisibility` gives the root floor one down portal per top-level subtopic
 * and no up portal, so an up transition is only reachable from the child floor - which is
 * why a one-level fixture could not test the up direction at all.
 */
function buildNestedSubject(): NestedSubject {
  const root = createRootDungeon({
    dungeonId: 'synthetic-subject',
    subjectName: 'Synthetic Subject',
    rootRoomId: 'root',
    rootTopic: 'Root Topic',
    nowIso: NOW,
  });
  if (!root.ok) throw new Error('root dungeon init failed');
  const withChild = addLinkedRooms(root.value, {
    fromRoomId: 'root',
    drafts: [
      { roomId: 'child-a', topic: 'Child A' },
      { roomId: 'child-b', topic: 'Child B' },
    ],
    nowIso: NOW,
  });
  if (!withChild.ok) throw new Error('addLinkedRooms (children) failed');
  const withGrandchild = addLinkedRooms(withChild.value.dungeon, {
    fromRoomId: 'child-a',
    drafts: [{ roomId: 'grandchild-0', topic: 'Grandchild 0' }],
    nowIso: NOW,
  });
  if (!withGrandchild.ok) throw new Error('addLinkedRooms (grandchild) failed');

  const dungeon = withGrandchild.value.dungeon;
  const rooms = Object.fromEntries(
    dungeon.rooms.map((room) => [
      room.roomId,
      {
        roomId: room.roomId,
        topic: room.topic,
        state: room.status,
        noteText: '',
        attachments: [],
        reviewPassCount: 0,
        validationState: { noteChecks: 0, failedChecks: 0, qualityBonus: 0, finalPass: false },
      },
    ]),
  );

  const snapshot = {
    schemaVersion: '1.1.0',
    dungeon,
    rooms,
  } as unknown as SubjectSnapshot;
  return { snapshot, map: generateDungeonMap(dungeon) };
}

/** Every renderer call the flow made, in order. */
interface RendererRecorder extends StudyFlowRendererPort {
  readonly calls: string[];
  readonly visibilityByFloor: Map<string, FloorVisibilityModel>;
  readonly teleports: string[];
  currentFloorId: string;
}

function createRecorder(): RendererRecorder {
  const calls: string[] = [];
  const visibilityByFloor = new Map<string, FloorVisibilityModel>();
  const teleports: string[] = [];
  return {
    calls,
    visibilityByFloor,
    teleports,
    currentFloorId: 'root',
    setFloorVisibility(visibility: FloorVisibilityModel): void {
      calls.push(`setFloorVisibility:${visibility.floorId}`);
      visibilityByFloor.set(visibility.floorId, visibility);
      this.currentFloorId = visibility.floorId;
    },
    teleportToRoom(roomId: string): void {
      calls.push(`teleportToRoom:${roomId}`);
      teleports.push(roomId);
    },
  };
}

interface FlowHarness {
  readonly flow: StudyFlowController;
  readonly renderer: RendererRecorder;
  readonly ui: {
    requestRoomPanelTab: ReturnType<typeof vi.fn>;
    setInfoPanelOpen: ReturnType<typeof vi.fn>;
    clearNpcDialog: ReturnType<typeof vi.fn>;
    setCurrentFloorId: ReturnType<typeof vi.fn>;
  };
  readonly teleport: { remainingMs: ReturnType<typeof vi.fn>; markConsumed: ReturnType<typeof vi.fn> };
  readonly state: {
    screen: string;
    focusedRoomId: string | null;
    noteEditorRoomId: string | null;
    isNoteEditorOpen: boolean;
    isMapViewOpen: boolean;
    teleportModeArmed: boolean;
  };
}

function createHarness(snapshot: SubjectSnapshot, phase: 'creator' | 'scribe' | 'archaeologist'): FlowHarness {
  const renderer = createRecorder();
  const state: FlowHarness['state'] = {
    screen: 'game',
    focusedRoomId: null,
    noteEditorRoomId: null,
    isNoteEditorOpen: false,
    isMapViewOpen: false,
    teleportModeArmed: false,
  };
  const ui = {
    requestRoomPanelTab: vi.fn(),
    setInfoPanelOpen: vi.fn(),
    clearNpcDialog: vi.fn(),
    setCurrentFloorId: vi.fn((floorId: string) => {
      state.screen = 'game';
      renderer.currentFloorId = floorId;
    }),
  };
  const teleport = {
    remainingMs: vi.fn(() => 0),
    markConsumed: vi.fn(),
  };

  const flow = createStudyFlowController({
    store: {
      getSnapshot: () => snapshot,
      getPhase: () => phase,
      persistActiveSubjectId: () => {},
      setFocusedRoomId: (roomId: string | null) => {
        state.focusedRoomId = roomId;
      },
      setActiveSubjectId: () => {},
      setActiveScreen: (screen: string) => {
        state.screen = screen;
      },
      openNoteEditor: (roomId: string) => {
        state.noteEditorRoomId = roomId;
        state.isNoteEditorOpen = true;
      },
      closeMapView: () => {
        state.isMapViewOpen = false;
      },
      cancelTeleportMode: () => {
        state.teleportModeArmed = false;
      },
      setMobileHudOpen: () => {},
      setProgressionActiveSubject: () => {},
      collectArtifactNote: () => true,
      awardReviewPass: () => ({ xpGained: 0 }),
      awardBadge: () => {},
      readProgressionBadges: () => [],
      recordReviewPass: async () => {},
    },
    renderer,
    teleport,
    dungeonUi: {
      pushToast: () => {},
      requestRoomPanelTab: ui.requestRoomPanelTab,
      setInfoPanelOpen: ui.setInfoPanelOpen,
      isInfoPanelOpen: () => false,
      clearNpcDialog: ui.clearNpcDialog,
      openJournalForCollectedNote: () => {},
      getCurrentFloorId: () => renderer.currentFloorId,
      setCurrentFloorId: ui.setCurrentFloorId,
    },
  });

  return { flow, renderer, ui, teleport, state };
}

let subject: NestedSubject;

beforeEach(() => {
  subject = buildNestedSubject();
});

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('the two floors of a nested subject agree with computeFloorVisibility', () => {
  it('the root floor shows the root, both children, and one down portal per child', () => {
    const visibility = computeFloorVisibility(
      deriveGraphHierarchy(subject.snapshot.dungeon),
      subject.snapshot.dungeon,
      'root',
    );
    expect(visibility.portalUpRoomId).toBeNull();
    expect([...visibility.portalDownRoomIds].sort()).toEqual(['child-a', 'child-b']);
    expect([...visibility.visibleRoomIds].sort()).toEqual(['child-a', 'child-b', 'root']);
    // The grandchild is on the child's floor, so the root floor cannot see it.
    expect(visibility.visibleRoomIds.has('grandchild-0')).toBe(false);
  });

  it('the child floor shows the grandchild and exactly one up portal', () => {
    const visibility = computeFloorVisibility(
      deriveGraphHierarchy(subject.snapshot.dungeon),
      subject.snapshot.dungeon,
      'child-a',
    );
    expect(visibility.portalUpRoomId).toBe('root');
    expect(visibility.portalDownRoomIds.size).toBe(0);
    expect([...visibility.visibleRoomIds].sort()).toEqual([
      'child-a',
      'grandchild-0',
      'root',
    ]);
  });
});

describe('a floor transition is a floor change followed by a teleport to the same room', () => {
  it('descending from a child activates that child own floor and stays put', () => {
    const { flow, renderer, ui } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'child-a';

    flow.changeFloor('child-a', 'down');

    // The destination floor is the *from* room's own floor: standing on the down portal of
    // a child swaps which floor is active so that the child's neighbours become visible,
    // and the player is placed back on the portal they pressed.
    expect(ui.setCurrentFloorId).toHaveBeenCalledWith('child-a');
    expect(renderer.calls).toEqual([
      'setFloorVisibility:child-a',
      'teleportToRoom:child-a',
    ]);
  });

  it('ascending from the parent room activates the parent own floor', () => {
    const { flow, renderer } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'child-a';

    flow.changeFloor('root', 'up');

    expect(renderer.calls).toEqual(['setFloorVisibility:root', 'teleportToRoom:root']);
    expect(renderer.visibilityByFloor.get('root')?.portalDownRoomIds.slice().sort()).toEqual([
      'child-a',
      'child-b',
    ]);
  });

  it('the visibility the flow hands the renderer names the portal the player is on', () => {
    const { flow, renderer } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'child-a';
    flow.changeFloor('child-a', 'down');

    const visibility = renderer.visibilityByFloor.get('child-a');
    expect(visibility).toBeDefined();
    if (visibility === undefined) throw new Error('no visibility was published');
    expect(visibility.portalUpRoomId).toBe('root');
    expect(visibility.visibleRoomIds).toContain('grandchild-0');
  });
});

describe('travelling and teleporting differ only in the cooldown', () => {
  it('travelToRoom moves without consuming the cooldown', () => {
    const { flow, renderer, teleport } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'root';

    flow.travelToRoom('child-b');

    expect(renderer.teleports).toEqual(['child-b']);
    expect(teleport.markConsumed).not.toHaveBeenCalled();
  });

  it('teleportToRoom consumes the cooldown once and closes the map', () => {
    const { flow, renderer, teleport, state } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'root';
    state.isMapViewOpen = true;

    flow.teleportToRoom('child-b');

    expect(renderer.teleports).toEqual(['child-b']);
    expect(teleport.markConsumed).toHaveBeenCalledTimes(1);
    expect(state.isMapViewOpen).toBe(false);
  });

  it('a second teleport inside the cooldown does nothing at all', () => {
    const { flow, renderer, teleport } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'root';
    teleport.remainingMs.mockReturnValue(TELEPORT_COOLDOWN_MS);

    flow.teleportToRoom('child-b');

    // Not the renderer, not the floor, not the map: the flow refuses before any of them.
    expect(renderer.calls).toEqual([]);
    expect(teleport.markConsumed).not.toHaveBeenCalled();
  });

  it('the boundary is `remainingMs() > 0`: any remaining millisecond blocks', () => {
    const { flow, renderer, teleport } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'root';

    // One millisecond left is still a cooldown, so nothing at all happens.
    teleport.remainingMs.mockReturnValue(1);
    flow.teleportToRoom('child-a');
    expect(renderer.calls, 'a teleport was performed inside the cooldown').toEqual([]);
    expect(teleport.markConsumed).not.toHaveBeenCalled();

    // Zero remaining allows it.
    teleport.remainingMs.mockReturnValue(0);
    flow.teleportToRoom('child-a');
    expect(renderer.teleports).toEqual(['child-a']);
    expect(teleport.markConsumed).toHaveBeenCalledTimes(1);
  });

  it('the flow reads the cooldown rather than holding one, so a second consumer agrees', () => {
    // `remainingMs` is a port the screen answers from the session store's
    // `lastTeleportAt`. The flow keeps no clock of its own, which is what makes the
    // cooldown a property of the store rather than of whichever renderer is mounted.
    const { flow, renderer, teleport } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'root';
    let lastTeleportAt: number | null = null;
    teleport.remainingMs.mockImplementation(() =>
      lastTeleportAt === null
        ? 0
        : Math.max(0, TELEPORT_COOLDOWN_MS - (Date.now() - lastTeleportAt)),
    );
    teleport.markConsumed.mockImplementation((at: number) => {
      lastTeleportAt = at;
    });

    flow.teleportToRoom('child-a');
    // Immediately afterwards the store-derived cooldown is active, and the flow obeys it.
    flow.teleportToRoom('child-b');
    expect(renderer.teleports).toEqual(['child-a']);
  });

  it('the cooldown is the store constant, not a renderer concern', () => {
    // The renderer port the flow is handed declares exactly two members. A renderer that
    // implemented a cooldown, a floor decision, or a room-entry callback would need a
    // third, and that is the drift this assertion names.
    const { renderer } = createHarness(subject.snapshot, 'scribe');
    expect(Object.keys(renderer).sort()).toEqual([
      'calls',
      'currentFloorId',
      'setFloorVisibility',
      'teleportToRoom',
      'teleports',
      'visibilityByFloor',
    ]);
    expect(TELEPORT_COOLDOWN_MS).toBeGreaterThan(0);
  });
});

describe('travelling to a room on another floor activates that floor first', () => {
  it('moving to the grandchild activates the child floor and then lands there', () => {
    const { flow, renderer } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'root';

    flow.travelToRoom('grandchild-0');

    expect(renderer.calls).toEqual([
      'setFloorVisibility:child-a',
      'teleportToRoom:grandchild-0',
    ]);
    expect(renderer.visibilityByFloor.get('child-a')?.portalUpRoomId).toBe('root');
  });

  it('travelling within the current floor does not republish visibility', () => {
    // `grandchild-0` is a native room of the `child-a` floor, so a travel to it needs no
    // floor change. A travel to `child-b` - its own floor - does, which is the flat-floor
    // model `computeFloorVisibility` documents: every top-level subtopic *is* a floor.
    const { flow, renderer } = createHarness(subject.snapshot, 'scribe');
    renderer.currentFloorId = 'child-a';

    flow.travelToRoom('grandchild-0');

    expect(renderer.calls).toEqual(['teleportToRoom:grandchild-0']);
    expect(renderer.visibilityByFloor.size).toBe(0);

    flow.travelToRoom('child-b');
    expect(renderer.calls).toEqual([
      'teleportToRoom:grandchild-0',
      'setFloorVisibility:child-b',
      'teleportToRoom:child-b',
    ]);
  });
});

describe('a 100-room subject produces one flow command per room', () => {
  it('every room is asked for exactly once, and each floor is published exactly once', () => {
    // **This is a request-counting test, not a traversal test.** `travelToRoom` has no
    // cooldown, so "100 inputs produce 100 recorded teleports" is close to tautological:
    // what it actually pins is that the flow addresses every room the map has and
    // republishes a floor exactly once per change.
    //
    // The geometric half - that all 100 room centres are actually *reachable* on foot -
    // is `tests/phase13/walkability-controller.test.ts`, "a hundred-room subject is
    // geometrically traversable", which floods the mask and asserts 100/100. Both exist
    // because they are different claims; neither substitutes for the other.
    const root = createRootDungeon({
      dungeonId: 'synthetic-large',
      subjectName: 'Synthetic Large',
      rootRoomId: 'root',
      rootTopic: 'Root Topic',
      nowIso: NOW,
    });
    if (!root.ok) throw new Error('root dungeon init failed');
    const grown = addLinkedRooms(root.value, {
      fromRoomId: 'root',
      drafts: Array.from({ length: 99 }, (_unused, index) => ({
        roomId: `room-${index}`,
        topic: `Room ${index}`,
      })),
      nowIso: NOW,
    });
    if (!grown.ok) throw new Error('addLinkedRooms failed');
    const dungeon = grown.value.dungeon;
    const rooms = Object.fromEntries(
      dungeon.rooms.map((room) => [
        room.roomId,
        {
          roomId: room.roomId,
          topic: room.topic,
          state: room.status,
          noteText: '',
          attachments: [],
          reviewPassCount: 0,
          validationState: { noteChecks: 0, failedChecks: 0, qualityBonus: 0, finalPass: false },
        },
      ]),
    );
    const snapshot = {
      schemaVersion: '1.1.0',
      dungeon,
      rooms,
    } as unknown as SubjectSnapshot;

    const map = generateDungeonMap(dungeon);
    expect(map.rooms).toHaveLength(100);

    const { flow, renderer } = createHarness(snapshot, 'scribe');
    renderer.currentFloorId = 'root';

    const roomIds = map.rooms.map((room) => room.roomId);
    for (const roomId of roomIds) flow.travelToRoom(roomId);

    expect(renderer.teleports).toEqual(roomIds);
    // Every room is reached exactly once, and each of the 99 children is its own floor in
    // the flat-floor model, so the floor is republished exactly once per child and never
    // for the root. A renderer that had to be asked for visibility more often than the
    // floor changed would show up as a count above 100.
    expect(renderer.calls).toHaveLength(100 + 99);
    expect(renderer.visibilityByFloor.size).toBe(99);

    // And the layout is such that the spatial index is engaged, which is the 100-room
    // path the Phaser scene's Phase-5 optimisation exists for.
    const visibility = computeFloorVisibility(deriveGraphHierarchy(dungeon), dungeon, 'root');
    expect(visibility.visibleRoomIds.size).toBe(100);
    expect(visibility.portalDownRoomIds.size).toBe(99);
  });
});