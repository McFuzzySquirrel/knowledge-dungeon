/**
 * Phase 14 contract: the two Creator graph-mutation lanes must agree.
 *
 * ## The duplication this test exists for
 *
 * `VITE_CREATOR_WORKSPACE` gates between two implementations of the same seven
 * Creator mutations:
 *
 * - **Lane A, the store lane.** `src/store/subjectStore.ts` has carried
 *   `addChildRooms`, `addCrossLinkBetween`, `reparentRoom`, `removeRoom`,
 *   `setRoomTags`, `addRoomTag` and `removeRoomTag` since Phase 4. Each one
 *   calls `src/core/graph` itself, merges the result with its own private
 *   `withRooms`, runs its own revalidation propagation, and persists.
 * - **Lane B, the application lane.** `src/application/creatorGraphCommands.ts`
 *   was added in Phase 14. It reaches the store through three injected ports and
 *   re-implements the merge and the propagation step.
 *
 * The source says so outright: *"The duplication is the point: while both lanes
 * exist, each has to be independently correct, and the parity test is what holds
 * them to each other."* The parity test did not exist. This is it.
 *
 * ## Why this is not a function compared to itself
 *
 * Each side below is driven through a different module, in a different order,
 * with different id and clock sources:
 *
 * - Lane A calls the Zustand store actions in `@/store/subjectStore`, which mints
 *   ids with its private `generateId` (`Math.random`) and stamps times with
 *   `new Date()`.
 * - Lane B calls `createCreatorGraphController` in
 *   `@/application/creatorGraphCommands`, bound to the *real* store port from
 *   `@/store/creatorGraphCommands`, with an injected clock and an injected
 *   sequential room-id mint.
 *
 * Only generated room ids and wall-clock timestamps are allowed to differ
 * (`normalizeSnapshotForParity`); anything else is a divergence. The last test
 * in this file additionally reads both sources and fails if either one starts
 * delegating to the other, so the two sides cannot silently collapse into one.
 *
 * Refusals are compared too: both lanes must leave the snapshot untouched and
 * leave the same text in the last-error slot.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCreatorGraphController } from '@/application/creatorGraphCommands';
import { creatorGraphStorePort } from '@/store/creatorGraphCommands';
import { useSubjectStore } from '@/store/subjectStore';
import type { SubjectSnapshot } from '@/core/validation/persistence';

import {
  cloneSnapshot,
  FIXED_NOW,
  makeSubjectSnapshot,
  normalizeSnapshotForParity,
} from '../unit/support/creatorGraphFixtures';
import { createSequentialRoomIds } from '../unit/support/creatorGraphRecordingPort';

const BASE_ROOM_IDS = ['room-root', 'room-alpha', 'room-beta', 'room-gamma'];

/**
 * root(Created) -▶ alpha(ArtifactCollected) -▶ beta(ArtifactCollected)
 *   └────────────────▶ gamma(Visited, tags: ['seed-tag'])
 */
function fixture() {
  return makeSubjectSnapshot({
    phaseState: 'ScribeActive',
    rooms: [
      { roomId: 'room-root', topic: 'Vector Spaces', status: 'Created' },
      { roomId: 'room-alpha', topic: 'Subspaces', status: 'ArtifactCollected' },
      { roomId: 'room-beta', topic: 'Bases', status: 'ArtifactCollected' },
      {
        roomId: 'room-gamma',
        topic: 'Linear Maps',
        status: 'Visited',
        metadata: { tags: ['seed-tag'] },
      },
    ],
    edges: [
      { fromRoomId: 'room-root', toRoomId: 'room-alpha' },
      { fromRoomId: 'room-alpha', toRoomId: 'room-beta' },
      { fromRoomId: 'room-root', toRoomId: 'room-gamma' },
    ],
  });
}

/** Lane B: the real controller, on the real store port, with deterministic deps. */
function applicationController() {
  return createCreatorGraphController({
    store: creatorGraphStorePort,
    nowIso: () => FIXED_NOW,
    newRoomId: createSequentialRoomIds('room-lane-b'),
  });
}

/** What one lane left behind: the snapshot it holds and its last-error text. */
interface LaneResult {
  readonly snapshot: SubjectSnapshot | null;
  readonly lastError: string | null;
}

interface Lanes {
  readonly storeLane: LaneResult;
  readonly applicationLane: LaneResult;
}

/**
 * Run one mutation down both lanes from the same input, and hand back what each
 * lane left behind.
 */
async function runBothLanes(
  label: string,
  storeLane: () => Promise<unknown>,
  applicationLane: (controller: ReturnType<typeof applicationController>) => Promise<unknown>,
): Promise<Lanes> {
  // Lane A.
  useSubjectStore.setState({ snapshot: cloneSnapshot(fixture()), lastError: null });
  await storeLane();
  const afterStore = useSubjectStore.getState();

  // Lane B, from a byte-identical starting point.
  useSubjectStore.setState({ snapshot: cloneSnapshot(fixture()), lastError: null });
  const applicationResult = await applicationLane(applicationController());
  const afterApplication = useSubjectStore.getState();

  // The store lane answers with `void` (its whole contract is the side effect),
  // so only the application lane has a value to hand back.
  expect(applicationResult, `${label}: the application lane must answer`).toBeDefined();

  return {
    storeLane: { snapshot: afterStore.snapshot, lastError: afterStore.lastError },
    applicationLane: { snapshot: afterApplication.snapshot, lastError: afterApplication.lastError },
  };
}

function assertParity(label: string, lanes: Lanes): void {
  expect(lanes.storeLane.snapshot, `${label}: lane A snapshot`).not.toBeNull();
  expect(lanes.applicationLane.snapshot, `${label}: lane B snapshot`).not.toBeNull();

  expect(
    normalizeSnapshotForParity(lanes.applicationLane.snapshot!, BASE_ROOM_IDS),
    `${label}: the application lane and the store lane produced different snapshots`,
  ).toEqual(normalizeSnapshotForParity(lanes.storeLane.snapshot!, BASE_ROOM_IDS));

  // The last-error slot is part of the contract: the Creator UI still reads it.
  expect(lanes.applicationLane.lastError, `${label}: lastError`).toBe(lanes.storeLane.lastError);
}

describe('Creator graph commands: store lane and application lane parity', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useSubjectStore.setState({ snapshot: null, lastError: null });
  });

  afterEach(() => {
    window.localStorage.clear();
    useSubjectStore.setState({ snapshot: null, lastError: null });
  });

  describe('mutations that should land', () => {
    const cases = [
      {
        label: 'graph/children-add',
        store: () => useSubjectStore.getState().addChildRooms('room-alpha', ['Delta', 'Epsilon']),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addChildTopics({ parentRoomId: 'room-alpha', topics: ['Delta', 'Epsilon'] }),
        // The shape the mutation must actually have produced, so a pair of
        // implementations that agree on doing *nothing* cannot pass.
        expectedRoomIds: [
          'room-root',
          'room-alpha',
          'room-beta',
          'room-gamma',
          '__new-room-0__',
          '__new-room-1__',
        ],
      },
      {
        label: 'graph/cross-link-add',
        store: () => useSubjectStore.getState().addCrossLinkBetween('room-root', 'room-beta'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-beta' }),
        expectedRoomIds: BASE_ROOM_IDS,
      },
      {
        label: 'graph/room-reparent',
        store: () => useSubjectStore.getState().reparentRoom('room-gamma', 'room-alpha'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.reparentRoom({ roomId: 'room-gamma', newParentRoomId: 'room-alpha' }),
        expectedRoomIds: BASE_ROOM_IDS,
      },
      {
        label: 'graph/room-remove',
        store: () => useSubjectStore.getState().removeRoom('room-alpha'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.removeRoom({ roomId: 'room-alpha' }),
        // room-beta hangs off room-alpha in this fixture, so it cascades.
        expectedRoomIds: ['room-root', 'room-gamma'],
      },
      {
        label: 'graph/tags-set',
        store: () =>
          useSubjectStore.getState().setRoomTags('room-gamma', [' Vectors ', 'vectors', 'Bases!']),
        application: (c: ReturnType<typeof applicationController>) =>
          c.setRoomTags({ roomId: 'room-gamma', tags: [' Vectors ', 'vectors', 'Bases!'] }),
        expectedRoomIds: BASE_ROOM_IDS,
      },
      {
        label: 'graph/tag-add',
        store: () => useSubjectStore.getState().addRoomTag('room-gamma', '  Linear Algebra!  '),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addRoomTag({ roomId: 'room-gamma', tag: '  Linear Algebra!  ' }),
        expectedRoomIds: BASE_ROOM_IDS,
      },
      {
        label: 'graph/tag-remove',
        store: () => useSubjectStore.getState().removeRoomTag('room-gamma', 'seed-tag'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.removeRoomTag({ roomId: 'room-gamma', tag: 'seed-tag' }),
        expectedRoomIds: BASE_ROOM_IDS,
      },
    ] as const;

    for (const testCase of cases) {
      it(`${testCase.label} lands the same snapshot on both lanes`, async () => {
        const lanes = await runBothLanes(testCase.label, testCase.store, testCase.application);
        assertParity(testCase.label, lanes);

        // Both lanes really did the work, not just the same nothing.
        expect(
          normalizeSnapshotForParity(lanes.applicationLane.snapshot!, BASE_ROOM_IDS).dungeon.rooms.map(
            (room) => room.roomId,
          ),
        ).toEqual(testCase.expectedRoomIds);
        expect(
          normalizeSnapshotForParity(lanes.storeLane.snapshot!, BASE_ROOM_IDS).dungeon.rooms.map(
            (room) => room.roomId,
          ),
        ).toEqual(testCase.expectedRoomIds);
      });
    }

    it('graph/children-add creates rooms whose metadata both lanes agree on', async () => {
      const lanes = await runBothLanes(
        'graph/children-add metadata',
        () => useSubjectStore.getState().addChildRooms('room-alpha', ['Delta', 'Epsilon']),
        (c) => c.addChildTopics({ parentRoomId: 'room-alpha', topics: ['Delta', 'Epsilon'] }),
      );

      const created = (lanes.applicationLane.snapshot!.dungeon.rooms ?? [])
        .map((room) => room.topic)
        .filter((topic) => topic === 'Delta' || topic === 'Epsilon');
      expect(created).toEqual(['Delta', 'Epsilon']);
      // `notePath` embeds the minted id, so it is only comparable once ids are
      // aliased - which is precisely why the normalizer substitutes inside
      // strings rather than only whole values.
      for (const snapshot of [lanes.storeLane.snapshot!, lanes.applicationLane.snapshot!]) {
        for (const roomId of Object.keys(snapshot.rooms)) {
          if (roomId === 'room-root' || roomId === 'room-gamma') continue;
          expect(snapshot.rooms[roomId].notePath).toContain(roomId);
        }
      }
    });

    it('graph/room-remove drops the cascaded descendants room metadata on both lanes', async () => {
      const lanes = await runBothLanes(
        'graph/room-remove cascade',
        () => useSubjectStore.getState().removeRoom('room-alpha'),
        (c) => c.removeRoom({ roomId: 'room-alpha' }),
      );

      // room-alpha and its only child room-beta both go, notes and all.
      for (const snapshot of [lanes.storeLane.snapshot!, lanes.applicationLane.snapshot!]) {
        expect(Object.keys(snapshot.rooms)).toEqual(['room-root', 'room-gamma']);
        expect(snapshot.rooms['room-alpha']).toBeUndefined();
        expect(snapshot.rooms['room-beta']).toBeUndefined();
      }
    });
  });

  describe('refusals and no-ops', () => {
    const cases = [
      {
        label: 'children-add from an unknown parent',
        store: () => useSubjectStore.getState().addChildRooms('room-missing', ['Delta']),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addChildTopics({ parentRoomId: 'room-missing', topics: ['Delta'] }),
        expectedLastError: 'Source room does not exist.',
      },
      {
        label: 'children-add with a duplicate topic',
        store: () => useSubjectStore.getState().addChildRooms('room-root', ['  sUbSpAcEs  ']),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addChildTopics({ parentRoomId: 'room-root', topics: ['  sUbSpAcEs  '] }),
        expectedLastError: 'Topic already exists in subject graph (case-insensitive, trimmed).',
      },
      {
        label: 'children-add with only blank topics',
        store: () => useSubjectStore.getState().addChildRooms('room-root', ['', '  ']),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addChildTopics({ parentRoomId: 'room-root', topics: ['', '  '] }),
        expectedLastError: null,
      },
      {
        label: 'cross-link-add for an edge that already exists',
        store: () => useSubjectStore.getState().addCrossLinkBetween('room-root', 'room-alpha'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-alpha' }),
        expectedLastError: 'Cross-link already exists.',
      },
      {
        label: 'cross-link-add that self-loops',
        store: () => useSubjectStore.getState().addCrossLinkBetween('room-root', 'room-root'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-root' }),
        expectedLastError: 'Cross-link cannot self-loop.',
      },
      {
        label: 'cross-link-add with an unknown endpoint',
        store: () => useSubjectStore.getState().addCrossLinkBetween('room-root', 'room-missing'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-missing' }),
        expectedLastError: 'Cross-link endpoints must exist.',
      },
      {
        label: 'room-reparent under a descendant',
        store: () => useSubjectStore.getState().reparentRoom('room-alpha', 'room-beta'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.reparentRoom({ roomId: 'room-alpha', newParentRoomId: 'room-beta' }),
        expectedLastError: 'Cannot move a room under one of its descendants.',
      },
      {
        label: 'room-reparent of the root',
        store: () => useSubjectStore.getState().reparentRoom('room-root', 'room-alpha'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.reparentRoom({ roomId: 'room-root', newParentRoomId: 'room-alpha' }),
        expectedLastError: 'Cannot change the parent of the root room.',
      },
      {
        label: 'room-reparent of an unknown room',
        store: () => useSubjectStore.getState().reparentRoom('room-missing', 'room-alpha'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.reparentRoom({ roomId: 'room-missing', newParentRoomId: 'room-alpha' }),
        expectedLastError: 'Reparent endpoints must exist.',
      },
      {
        label: 'room-reparent that self-parents',
        store: () => useSubjectStore.getState().reparentRoom('room-alpha', 'room-alpha'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.reparentRoom({ roomId: 'room-alpha', newParentRoomId: 'room-alpha' }),
        expectedLastError: 'A room cannot become its own parent.',
      },
      {
        label: 'room-remove of the root',
        store: () => useSubjectStore.getState().removeRoom('room-root'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.removeRoom({ roomId: 'room-root' }),
        expectedLastError: 'Cannot remove the root room.',
      },
      {
        label: 'room-remove of an unknown room',
        store: () => useSubjectStore.getState().removeRoom('room-missing'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.removeRoom({ roomId: 'room-missing' }),
        expectedLastError: 'Room not found for removal.',
      },
      {
        label: 'tags-set on an unknown room',
        store: () => useSubjectStore.getState().setRoomTags('room-missing', ['a']),
        application: (c: ReturnType<typeof applicationController>) =>
          c.setRoomTags({ roomId: 'room-missing', tags: ['a'] }),
        expectedLastError: 'Room not found: room-missing',
      },
      {
        label: 'tag-add on an unknown room',
        store: () => useSubjectStore.getState().addRoomTag('room-missing', 'a'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addRoomTag({ roomId: 'room-missing', tag: 'a' }),
        expectedLastError: 'Room not found: room-missing',
      },
      {
        label: 'tag-remove on an unknown room',
        store: () => useSubjectStore.getState().removeRoomTag('room-missing', 'seed-tag'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.removeRoomTag({ roomId: 'room-missing', tag: 'seed-tag' }),
        expectedLastError: 'Room not found: room-missing',
      },
      {
        label: 'tag-add for a tag that is already there',
        store: () => useSubjectStore.getState().addRoomTag('room-gamma', 'seed-tag'),
        application: (c: ReturnType<typeof applicationController>) =>
          c.addRoomTag({ roomId: 'room-gamma', tag: 'seed-tag' }),
        expectedLastError: null,
      },
    ] as const;

    for (const testCase of cases) {
      it(`${testCase.label} behaves the same on both lanes`, async () => {
        const lanes = await runBothLanes(testCase.label, testCase.store, testCase.application);
        assertParity(testCase.label, lanes);

        // A refusal or a no-op must not have moved either snapshot.
        expect(lanes.applicationLane.snapshot).toEqual(fixture());
        expect(lanes.storeLane.snapshot).toEqual(fixture());
        expect(lanes.applicationLane.lastError).toBe(testCase.expectedLastError);
        expect(lanes.storeLane.lastError).toBe(testCase.expectedLastError);
      });
    }
  });

  describe('no active subject', () => {
    it('the store lane returns silently and the application lane refuses without writing lastError', async () => {
      // A sentinel in the error slot: neither lane may overwrite it.
      useSubjectStore.setState({ snapshot: null, lastError: 'untouched-sentinel' });
      await useSubjectStore.getState().addChildRooms('room-root', ['Delta']);
      await useSubjectStore.getState().setRoomTags('room-gamma', ['a']);

      expect(useSubjectStore.getState().snapshot).toBeNull();
      expect(useSubjectStore.getState().lastError).toBe('untouched-sentinel');

      useSubjectStore.setState({ snapshot: null, lastError: 'untouched-sentinel' });
      const controller = applicationController();
      const outcomes = [
        await controller.addChildTopics({ parentRoomId: 'room-root', topics: ['Delta'] }),
        await controller.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-beta' }),
        await controller.reparentRoom({ roomId: 'room-beta', newParentRoomId: 'room-gamma' }),
        await controller.removeRoom({ roomId: 'room-gamma' }),
        await controller.setRoomTags({ roomId: 'room-gamma', tags: ['a'] }),
        await controller.addRoomTag({ roomId: 'room-gamma', tag: 'a' }),
        await controller.removeRoomTag({ roomId: 'room-gamma', tag: 'seed-tag' }),
      ];

      // The application lane has to answer, and answers the same way for all
      // seven commands - but it must not invent an error the store never wrote.
      for (const outcome of outcomes) {
        expect(outcome).toEqual({
          ok: false,
          error: { code: 'INVALID_OPERATION', message: 'No active subject' },
        });
      }
      expect(useSubjectStore.getState().snapshot).toBeNull();
      expect(useSubjectStore.getState().lastError).toBe('untouched-sentinel');
    });
  });

  describe('known divergences', () => {
    // ── Recorded, not endorsed. ────────────────────────────────────────────
    // Each test in this block pins a place where the two lanes do NOT behave
    // identically. They are characterization tests: they exist so the
    // divergence is visible in CI rather than discovered during a rollback.
    // Whichever way the phase resolves them, these will go red - and that is the
    // intent. A silent fix here would mean the divergence was never real.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a failed write rejects from the application lane but is swallowed by the store lane on tag commands', async () => {
      // `src/store/subjectStore.ts` wraps each tag action's
      // `await persist(next)` in the same try/catch as the domain call, so a
      // write failure becomes `lastError` and the action resolves.
      // `applyTag` awaits `deps.store.commit(...)` *outside* its try, so the
      // rejection escapes the command and `lastError` is never written.
      //
      // Phase 14's stated contract is "semantics are the pre-Phase-14 store's,
      // deliberately", so this is a break of that contract on the three tag
      // commands. The four graph commands are unaffected: their `persist` calls
      // are not inside a try/catch, and both lanes reject.
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });

      const storeResult = await (async () => {
        useSubjectStore.setState({ snapshot: cloneSnapshot(fixture()), lastError: null });
        await useSubjectStore.getState().addRoomTag('room-gamma', 'matrices');
        return useSubjectStore.getState();
      })();

      const applicationOutcome = await (async () => {
        useSubjectStore.setState({ snapshot: cloneSnapshot(fixture()), lastError: null });
        try {
          await applicationController().addRoomTag({ roomId: 'room-gamma', tag: 'matrices' });
          return 'resolved';
        } catch (error) {
          return error instanceof Error ? error.message : 'non-Error thrown';
        }
      })();

      const QUOTA_MESSAGE =
        'Storage quota exceeded. Please export your data and free up space by removing unused subjects.';

      // Store lane: swallowed, and the message reached lastError.
      expect(storeResult.lastError).toBe(QUOTA_MESSAGE);
      // Application lane: rejected, and lastError was left null by
      // `commitSubjectSnapshot`'s `set({ snapshot, lastError: null })`.
      expect(applicationOutcome).toBe(QUOTA_MESSAGE);
      expect(useSubjectStore.getState().lastError).toBeNull();
    });

    it('a failed write rejects from both lanes on graph commands, so the tag commands are the only divergence', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });

      const storeOutcome = await (async () => {
        useSubjectStore.setState({ snapshot: cloneSnapshot(fixture()), lastError: null });
        try {
          await useSubjectStore.getState().addCrossLinkBetween('room-root', 'room-beta');
          return 'resolved';
        } catch (error) {
          return error instanceof Error ? error.message : 'non-Error thrown';
        }
      })();

      useSubjectStore.setState({ snapshot: cloneSnapshot(fixture()), lastError: null });
      const applicationOutcome = await (async () => {
        try {
          await applicationController().addCrossLink({
            fromRoomId: 'room-root',
            toRoomId: 'room-beta',
          });
          return 'resolved';
        } catch (error) {
          return error instanceof Error ? error.message : 'non-Error thrown';
        }
      })();

      expect(storeOutcome).toBe(applicationOutcome);
      expect(applicationOutcome).not.toBe('resolved');
    });
  });

  describe('the two lanes have not collapsed into one', () => {
    const storeSource = readFileSync(
      join(process.cwd(), 'src/store/subjectStore.ts'),
      'utf8',
    );
    const applicationSource = readFileSync(
      join(process.cwd(), 'src/application/creatorGraphCommands.ts'),
      'utf8',
    );

    function occurrences(haystack: string, needle: string): number {
      return haystack.split(needle).length - 1;
    }

    it('each lane still owns its own snapshot merge', () => {
      // If either file stopped defining its own `withRooms` and started
      // importing the other's, the comparisons above would be a module against
      // itself - the exact vacuity this contract exists to prevent.
      expect(occurrences(storeSource, 'function withRooms(')).toBe(1);
      expect(occurrences(applicationSource, 'function withRooms(')).toBe(1);
      expect(storeSource).not.toContain('@/application/creatorGraphCommands');
      expect(applicationSource).not.toContain('@/store');
    });

    it('each lane still owns its own revalidation fallback', () => {
      // Four graph actions in the store, one shared helper in the application
      // layer - each written where it is used.
      expect(occurrences(storeSource, 'propagated.ok ? propagated.value.dungeon')).toBe(4);
      expect(occurrences(applicationSource, 'propagated.ok ? propagated.value.dungeon')).toBe(1);
    });

    it('the store lane still runs no propagation on its tag actions', () => {
      // Four propagation call sites for seven graph-and-tag actions: the three
      // tag actions must not have grown one. This is the asymmetry the parity
      // contract is preserving.
      expect(occurrences(storeSource, 'propagateRevalidationAfterGraphMutation(')).toBe(4);
    });
  });
});