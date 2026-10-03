/**
 * Phase 14 - revalidation parity (exit criterion 2: "Revalidation behavior
 * remains unchanged").
 *
 * The application layer deliberately re-implements the store's revalidation
 * step. Phase 14 preserves two facts about it that are easy to "tidy away" by
 * accident, so they are pinned here as observable outcomes rather than as
 * comments:
 *
 * 1. The four graph commands (`children-add`, `cross-link-add`,
 *    `room-reparent`, `room-remove`) run revalidation propagation.
 * 2. The three tag commands do **not**. The pre-Phase-14 store's tag actions
 *    ran none, and the asymmetry is deliberate, not an oversight.
 *
 * How "did propagation run?" is observed
 * --------------------------------------
 * `propagateRevalidationAfterGraphMutation` only does anything once
 * `phaseState` has reached a Scribe phase, and it only rewrites rooms whose
 * status is in `CLEARED_OR_NOTES_PROGRESS_STATES` (`NotesDrafted`,
 * `EncounterDefeated`, `ArtifactCollected`, `NeedsRevalidation`). The fixture
 * therefore puts the subject in `ScribeActive` and marks the two cleared rooms
 * `ArtifactCollected`, which makes propagation visible as a status change.
 *
 * Every expected status below is hand-computed from the fixture's edges rather
 * than obtained by calling the domain, because "run the domain and compare it
 * to what the domain produced" would pass even if propagation were removed
 * entirely - which is exactly the vacuity Phase 13 found three times.
 */
import { describe, expect, it } from 'vitest';
import { createCreatorGraphController } from '@/application/creatorGraphCommands';
import type { GraphDomainResult } from '@/core/graph';
import type { RoomState, SubjectSnapshot } from '@/core/validation/persistence';

import {
  cloneSnapshot,
  FIXED_NOW,
  makeSubjectSnapshot,
  statusesByRoomId,
} from './support/creatorGraphFixtures';
import {
  createRecordingStore,
  createSequentialRoomIds,
} from './support/creatorGraphRecordingPort';

/**
 * root(Created) ──▶ alpha(ArtifactCollected) ──▶ beta(ArtifactCollected)
 *      └──────────────────────▶ gamma(Visited, tags: ['seed-tag'])
 */
function scribeFixture(): SubjectSnapshot {
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

function harness(initial: SubjectSnapshot | null) {
  const store = createRecordingStore(initial);
  const controller = createCreatorGraphController({
    store: store.port,
    nowIso: () => FIXED_NOW,
    newRoomId: createSequentialRoomIds(),
  });
  return { store, controller };
}

function expectOk<T>(result: GraphDomainResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got refusal ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** Statuses of the one snapshot the command committed. */
function committedStatuses(store: ReturnType<typeof createRecordingStore>): Record<string, RoomState> {
  expect(store.commits).toHaveLength(1);
  return statusesByRoomId(store.commits[0].dungeon);
}

describe('graph commands run revalidation propagation', () => {
  it('graph/children-add revalidates the branch around the parent room', async () => {
    const { store, controller } = harness(cloneSnapshot(scribeFixture()));

    const outcome = expectOk(
      await controller.addChildTopics({ parentRoomId: 'room-alpha', topics: ['Delta'] }),
    );
    expect(outcome.touchedRoomIds).toEqual(['room-alpha', 'room-minted-1']);

    // touched = {alpha, Delta}; every edge touching the impacted set pulls in its
    // other endpoint, so root, beta and gamma join the set. Of those, alpha and
    // beta are in a cleared state; root (Created), gamma (Visited) and the new
    // Delta (Created) are not, so they keep their status.
    expect(committedStatuses(store)).toEqual({
      'room-root': 'Created',
      'room-alpha': 'NeedsRevalidation',
      'room-beta': 'NeedsRevalidation',
      'room-gamma': 'Visited',
      'room-minted-1': 'Created',
    });
  });

  it('graph/cross-link-add revalidates both connected branches', async () => {
    const { store, controller } = harness(cloneSnapshot(scribeFixture()));

    const outcome = expectOk(
      await controller.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-beta' }),
    );
    expect(outcome.touchedRoomIds).toEqual(['room-root', 'room-beta']);

    // touched = {root, beta}; root's other edges pull in alpha and gamma, and
    // alpha→beta is already spanned. alpha and beta are cleared; gamma is only
    // Visited.
    expect(committedStatuses(store)).toEqual({
      'room-root': 'Created',
      'room-alpha': 'NeedsRevalidation',
      'room-beta': 'NeedsRevalidation',
      'room-gamma': 'Visited',
    });
  });

  it('graph/room-reparent revalidates both the old and the new parent branch', async () => {
    const { store, controller } = harness(cloneSnapshot(scribeFixture()));

    const outcome = expectOk(
      await controller.reparentRoom({ roomId: 'room-gamma', newParentRoomId: 'room-alpha' }),
    );
    expect(outcome.previousParentRoomId).toBe('room-root');

    // touched = {gamma, alpha, root}; alpha→beta pulls in beta. alpha and beta
    // are cleared; gamma is only Visited even though it moved.
    expect(committedStatuses(store)).toEqual({
      'room-root': 'Created',
      'room-alpha': 'NeedsRevalidation',
      'room-beta': 'NeedsRevalidation',
      'room-gamma': 'Visited',
    });
  });

  it('graph/room-remove revalidates the surviving neighbour of the removed room', async () => {
    const { store, controller } = harness(cloneSnapshot(scribeFixture()));

    const outcome = expectOk(await controller.removeRoom({ roomId: 'room-beta' }));
    expect(outcome.removedRoomIds).toEqual(['room-beta']);

    // Only alpha survived as a neighbour of beta, so alpha is the only touched
    // room; root→alpha and root→gamma widen the impacted set, and only alpha is
    // cleared.
    expect(committedStatuses(store)).toEqual({
      'room-root': 'Created',
      'room-alpha': 'NeedsRevalidation',
      'room-gamma': 'Visited',
    });
  });
});

describe('tag commands do not run revalidation propagation', () => {
  const untouched = {
    'room-root': 'Created',
    'room-alpha': 'ArtifactCollected',
    'room-beta': 'ArtifactCollected',
    'room-gamma': 'Visited',
  } as const;

  it('graph/tags-set leaves every room status alone', async () => {
    const { store, controller } = harness(cloneSnapshot(scribeFixture()));

    const outcome = expectOk(
      await controller.setRoomTags({ roomId: 'room-gamma', tags: ['vectors', 'bases'] }),
    );
    expect(outcome).toEqual({ command: 'graph/tags-set', tags: ['vectors', 'bases'] });

    // Propagation would have revalidated the branch around room-gamma. The
    // pre-Phase-14 tag actions ran none, and neither does this one.
    expect(committedStatuses(store)).toEqual(untouched);
  });

  it('graph/tag-add leaves every room status alone', async () => {
    const { store, controller } = harness(cloneSnapshot(scribeFixture()));

    const outcome = expectOk(await controller.addRoomTag({ roomId: 'room-gamma', tag: 'matrices' }));
    expect(outcome).toEqual({ command: 'graph/tag-add', tags: ['seed-tag', 'matrices'] });

    expect(committedStatuses(store)).toEqual(untouched);
  });

  it('graph/tag-remove leaves every room status alone', async () => {
    const { store, controller } = harness(cloneSnapshot(scribeFixture()));

    const outcome = expectOk(await controller.removeRoomTag({ roomId: 'room-gamma', tag: 'seed-tag' }));
    expect(outcome).toEqual({ command: 'graph/tag-remove', tags: [] });

    expect(committedStatuses(store)).toEqual(untouched);
  });

  it('tagging a cleared room does not revalidate it, while a graph mutation on the same fixture does', async () => {
    // The asymmetry, stated as one comparison rather than three separate
    // assertions, because "these three happen to leave statuses alone" is only
    // meaningful next to "a graph mutation on the identical fixture does not".
    const tagged = harness(cloneSnapshot(scribeFixture()));
    await tagged.controller.addRoomTag({ roomId: 'room-gamma', tag: 'matrices' });

    const relinked = harness(cloneSnapshot(scribeFixture()));
    await relinked.controller.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-beta' });

    expect(committedStatuses(tagged.store)).not.toEqual(committedStatuses(relinked.store));
    expect(committedStatuses(tagged.store)).toEqual({
      'room-root': 'Created',
      'room-alpha': 'ArtifactCollected',
      'room-beta': 'ArtifactCollected',
      'room-gamma': 'Visited',
    });
    expect(committedStatuses(relinked.store)['room-beta']).toBe('NeedsRevalidation');
  });
});

describe('revalidation observations are phase-gated, not a constant', () => {
  it('the same cross-link mutation leaves statuses untouched before Scribe starts', async () => {
    // The control for everything above: identical command, identical edges,
    // only the phase differs. If any of the propagation assertions above were
    // passing for a reason other than propagation, this would not separate.
    const creator = makeSubjectSnapshot({
      phaseState: 'CreatorActive',
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
    const { store, controller } = harness(cloneSnapshot(creator));

    await controller.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-beta' });

    expect(committedStatuses(store)).toEqual({
      'room-root': 'Created',
      'room-alpha': 'ArtifactCollected',
      'room-beta': 'ArtifactCollected',
    });
  });
});