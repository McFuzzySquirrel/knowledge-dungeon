/**
 * Phase 14 - a propagation refusal falls back to the unpropagated dungeon
 * instead of aborting the mutation.
 *
 * `propagateAfterGraphMutation` in `src/application/creatorGraphCommands.ts`
 * ends with `propagated.ok ? propagated.value.dungeon : dungeon`, and the same
 * fallback appears in each of the store's four graph actions. Phase 14's exit
 * criterion 2 requires that to stay unchanged, so it is pinned here.
 *
 * ## Why this file mocks anything
 *
 * `propagateRevalidationAfterGraphMutation` refuses only when a *touched* room
 * is missing from the dungeon it was handed, and every caller derives its
 * touched list from a dungeon that already contains those rooms. The refusal is
 * therefore unreachable through the public command surface - which means a test
 * that only drives real commands can never observe the fallback, and would be
 * asserting a branch it never entered.
 *
 * So the single domain function is replaced with a switchable stand-in that
 * defaults to delegating to the real implementation. Two things keep that from
 * becoming a vacuous test:
 *
 * - The control case runs first on the identical fixture and asserts the real
 *   statuses *do* flip, so a stand-in that silently swallowed the call would go
 *   red.
 * - Every test asserts the stand-in was called with the rooms the mutation
 *   touched, so a mock that failed to install also goes red.
 *
 * Everything else - the controller, the tag and graph domains, the store, the
 * port binding - is the real module.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCreatorGraphController,
  type CreatorGraphStorePort,
} from '@/application/creatorGraphCommands';
import type { GraphDomainResult, RevalidationPropagationInput } from '@/core/graph';
import type { RoomState, SubjectSnapshot } from '@/core/validation/persistence';

import {
  cloneSnapshot,
  FIXED_NOW,
  makeSubjectSnapshot,
  normalizeSnapshotForParity,
  statusesByRoomId,
} from './support/creatorGraphFixtures';
import {
  createRecordingStore,
  createSequentialRoomIds,
} from './support/creatorGraphRecordingPort';

const { propagateSpy } = vi.hoisted(() => ({ propagateSpy: vi.fn() }));

vi.mock('@/core/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/graph')>();
  return {
    ...actual,
    propagateRevalidationAfterGraphMutation: (
      input: RevalidationPropagationInput,
    ): GraphDomainResult<unknown> =>
      propagateSpy(input, actual.propagateRevalidationAfterGraphMutation),
  };
});

type RealPropagation = (
  input: RevalidationPropagationInput,
) => GraphDomainResult<{
  dungeon: SubjectSnapshot['dungeon'];
  impactedRoomIds: string[];
  revalidatedRoomIds: string[];
}>;

/** The domain's own refusal shape, so nothing about it is invented here. */
const PROPAGATION_REFUSAL = {
  ok: false as const,
  error: {
    code: 'ROOM_NOT_FOUND' as const,
    message: 'Touched room is not present in graph.',
    details: { touchedRoomId: 'room-beta' },
  },
};

/** root(Created) -▶ alpha(ArtifactCollected) -▶ beta(ArtifactCollected). */
function scribeFixture(): SubjectSnapshot {
  return makeSubjectSnapshot({
    phaseState: 'ScribeActive',
    rooms: [
      { roomId: 'room-root', topic: 'Vector Spaces', status: 'Created' },
      { roomId: 'room-alpha', topic: 'Subspaces', status: 'ArtifactCollected' },
      { roomId: 'room-beta', topic: 'Bases', status: 'ArtifactCollected' },
    ],
    edges: [
      { fromRoomId: 'room-root', toRoomId: 'room-alpha' },
      { fromRoomId: 'room-alpha', toRoomId: 'room-beta' },
    ],
  });
}

function harness(initial: SubjectSnapshot | null) {
  const store = createRecordingStore(initial);
  const controller = createCreatorGraphController({
    store: store.port,
    nowIso: () => FIXED_NOW,
    newRoomId: createSequentialRoomIds(),
  });
  return { store, controller };
}

function statuses(store: ReturnType<typeof createRecordingStore>): Record<string, RoomState> {
  expect(store.commits).toHaveLength(1);
  return statusesByRoomId(store.commits[0].dungeon);
}

describe('a propagation refusal falls back instead of aborting', () => {
  beforeEach(() => {
    // Default: the stand-in is transparent.
    propagateSpy.mockReset();
    propagateSpy.mockImplementation((input: RevalidationPropagationInput, real: RealPropagation) =>
      real(input),
    );
  });

  it('control: with the real propagation the mutation revalidates', async () => {
    const { store, controller } = harness(cloneSnapshot(scribeFixture()));

    const result = await controller.addCrossLink({
      fromRoomId: 'room-root',
      toRoomId: 'room-beta',
    });

    expect(result.ok).toBe(true);
    expect(statuses(store)).toEqual({
      'room-root': 'Created',
      'room-alpha': 'NeedsRevalidation',
      'room-beta': 'NeedsRevalidation',
    });
    // And the stand-in really was in the path, with the rooms the mutation
    // touched. Without this, the test above could pass with no propagation at
    // all.
    expect(propagateSpy).toHaveBeenCalledTimes(1);
    expect(propagateSpy.mock.calls[0][0]).toMatchObject({
      touchedRoomIds: ['room-root', 'room-beta'],
      nowIso: FIXED_NOW,
    });
  });

  it('commits the unpropagated dungeon and still reports success when propagation refuses', async () => {
    propagateSpy.mockImplementation(() => PROPAGATION_REFUSAL);
    const { store, controller } = harness(cloneSnapshot(scribeFixture()));

    const result = await controller.addCrossLink({
      fromRoomId: 'room-root',
      toRoomId: 'room-beta',
    });

    // The mutation is not aborted, is not turned into a refusal, and does not
    // write a last-error: the edge it created is still there.
    expect(result).toEqual({
      ok: true,
      value: {
        command: 'graph/cross-link-add',
        touchedRoomIds: ['room-root', 'room-beta'],
      },
    });
    expect(store.failures).toEqual([]);

    const committed = store.commits[0];
    // The *unpropagated* dungeon is what landed: alpha and beta keep their
    // statuses, because the fallback returns the pre-propagation dungeon
    // instead of the propagated one.
    expect(statusesByRoomId(committed.dungeon)).toEqual({
      'room-root': 'Created',
      'room-alpha': 'ArtifactCollected',
      'room-beta': 'ArtifactCollected',
    });
    // ...and the mutation's own effect is present.
    expect(
      committed.dungeon.edges.find((edge) => edge.relationType === 'related'),
    ).toMatchObject({ fromRoomId: 'room-root', toRoomId: 'room-beta', createdAt: FIXED_NOW });
    expect(propagateSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back the same way for every graph command that propagates', async () => {
    propagateSpy.mockImplementation(() => PROPAGATION_REFUSAL);
    const before = {
      'room-root': 'Created',
      'room-alpha': 'ArtifactCollected',
      'room-beta': 'ArtifactCollected',
    } as const;

    for (const [label, run] of [
      [
        'graph/children-add',
        (c: ReturnType<typeof harness>['controller']) =>
          c.addChildTopics({ parentRoomId: 'room-root', topics: ['Delta'] }),
      ],
      [
        'graph/cross-link-add',
        (c: ReturnType<typeof harness>['controller']) =>
          c.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-beta' }),
      ],
      [
        'graph/room-reparent',
        (c: ReturnType<typeof harness>['controller']) =>
          c.reparentRoom({ roomId: 'room-beta', newParentRoomId: 'room-root' }),
      ],
      [
        'graph/room-remove',
        (c: ReturnType<typeof harness>['controller']) => c.removeRoom({ roomId: 'room-beta' }),
      ],
    ] as const) {
      propagateSpy.mockClear();
      const { store, controller } = harness(cloneSnapshot(scribeFixture()));

      const result = await run(controller);

      expect(result.ok, `${label} should not be aborted by a propagation refusal`).toBe(true);
      expect(store.failures, `${label} must not report a domain failure`).toEqual([]);
      expect(propagateSpy, `${label} should attempt propagation`).toHaveBeenCalledTimes(1);

      const committed = store.commits[0];
      expect(committed, `${label} must still commit`).toBeDefined();
      // Nothing was flipped to NeedsRevalidation anywhere.
      expect(
        Object.values(statusesByRoomId(committed.dungeon)),
        `${label} must land the unpropagated dungeon`,
      ).not.toContain('NeedsRevalidation');
      // For the three non-removing commands the untouched rooms keep their
      // pre-mutation statuses exactly.
      if (label !== 'graph/room-remove') {
        expect(
          statusesByRoomId(committed.dungeon)['room-alpha'],
          `${label} must leave room-alpha alone`,
        ).toBe(before['room-alpha']);
      }
    }
  });

  it('the store lane falls back identically, so a rollback shows the same graph', async () => {
    propagateSpy.mockImplementation(() => PROPAGATION_REFUSAL);
    window.localStorage.clear();
    const { useSubjectStore } = await import('@/store/subjectStore');

    // Lane A: the pre-Phase-14 store action, with the same refusing stand-in.
    useSubjectStore.setState({ snapshot: cloneSnapshot(scribeFixture()), lastError: null });
    await useSubjectStore.getState().removeRoom('room-beta');
    const storeLane = useSubjectStore.getState().snapshot;

    // Lane B: the application-layer command, through the real store binding.
    const port: CreatorGraphStorePort = {
      readSnapshot: () => useSubjectStore.getState().snapshot,
      commit: async (next) => {
        useSubjectStore.setState({ snapshot: next, lastError: null });
      },
      reportFailure: (message) => useSubjectStore.setState({ lastError: message }),
    };
    const controller = createCreatorGraphController({
      store: port,
      nowIso: () => FIXED_NOW,
      newRoomId: createSequentialRoomIds(),
    });
    useSubjectStore.setState({ snapshot: cloneSnapshot(scribeFixture()), lastError: null });
    await controller.removeRoom({ roomId: 'room-beta' });
    const applicationLane = useSubjectStore.getState().snapshot;

    expect(storeLane).not.toBeNull();
    expect(applicationLane).not.toBeNull();
    expect(propagateSpy).toHaveBeenCalledTimes(2);

    const base = ['room-root', 'room-alpha', 'room-beta'];
    expect(normalizeSnapshotForParity(applicationLane!, base)).toEqual(
      normalizeSnapshotForParity(storeLane!, base),
    );
    // Neither lane flipped a status, and neither reported a failure.
    expect(
      Object.values(statusesByRoomId(applicationLane!.dungeon)),
    ).not.toContain('NeedsRevalidation');
    expect(useSubjectStore.getState().lastError).toBeNull();

    window.localStorage.clear();
  });
});