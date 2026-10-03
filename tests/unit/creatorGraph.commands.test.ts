/**
 * Phase 14 - Creator graph-mutation application layer: command behaviour.
 *
 * `src/application/creatorGraphCommands.ts` shipped with no tests. This file
 * covers the parts of it that are observable from outside the module: every
 * refusal path with its real domain code, the cascade delete, the
 * no-active-subject answer, what the three tag commands return, and the claim
 * that `dispatch` and the named methods are the same implementation.
 *
 * What this file deliberately does *not* claim:
 *
 * - Revalidation parity (which commands propagate) lives in
 *   `creatorGraph.revalidationParity.test.ts`, because it needs a
 *   `ScribeActive` fixture and hand-computed expected statuses.
 * - The propagation-refusal fallback lives in
 *   `creatorGraph.propagationFallback.test.ts`, because it has to make the
 *   domain refuse.
 * - Store/application parity lives in
 *   `tests/contracts/creator-graph-store-parity.test.ts`, because it has to
 *   drive the real store.
 */
import { describe, expect, it } from 'vitest';
import { createCreatorGraphController } from '@/application/creatorGraphCommands';
import type { GraphCommand, GraphCommandName } from '@/application/contracts/commands';
import type { GraphDomainError, GraphDomainResult } from '@/core/graph';
import type { SubjectSnapshot } from '@/core/validation/persistence';

import {
  cloneSnapshot,
  FIXED_NOW,
  makeRevalidationFixture,
  makeSubjectSnapshot,
  normalizeSnapshotForParity,
} from './support/creatorGraphFixtures';
import {
  createRecordingStore,
  createSequentialRoomIds,
} from './support/creatorGraphRecordingPort';

const BASE_ROOM_IDS = ['room-root', 'room-alpha', 'room-beta', 'room-gamma'];

function harness(initial: SubjectSnapshot | null) {
  const store = createRecordingStore(initial);
  const controller = createCreatorGraphController({
    store: store.port,
    nowIso: () => FIXED_NOW,
    newRoomId: createSequentialRoomIds(),
  });
  return { store, controller };
}

function fixture(): SubjectSnapshot {
  return makeRevalidationFixture();
}

function expectOk<T>(result: GraphDomainResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got refusal ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function expectRefusal<T>(result: GraphDomainResult<T>): GraphDomainError {
  if (result.ok) {
    throw new Error(`expected a refusal, got success`);
  }
  return result.error;
}

/** Every graph command, as a `dispatch` value, for the dispatch/named-method pin. */
describe('creatorGraphCommands - refusals', () => {
  it('graph/children-add refuses an unknown parent room with ROOM_NOT_FOUND', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    const error = expectRefusal(
      await controller.addChildTopics({ parentRoomId: 'room-missing', topics: ['Delta'] }),
    );

    expect(error.code).toBe('ROOM_NOT_FOUND');
    expect(error.message).toBe('Source room does not exist.');
    expect(error.details).toEqual({ fromRoomId: 'room-missing' });
    // The store lane wrote `lastError` on a domain refusal, so the command does
    // too - once, with the domain's own message.
    expect(store.failures).toEqual(['Source room does not exist.']);
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });

  it('graph/children-add refuses a duplicate topic with TOPIC_ALREADY_EXISTS, case-insensitively', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    const error = expectRefusal(
      await controller.addChildTopics({ parentRoomId: 'room-root', topics: ['  sUbSpAcEs  '] }),
    );

    expect(error.code).toBe('TOPIC_ALREADY_EXISTS');
    expect(error.message).toBe('Topic already exists in subject graph (case-insensitive, trimmed).');
    // The topic reaches the domain already trimmed, which is where the identity
    // comparison happens.
    expect(error.details).toEqual({ topic: 'sUbSpAcEs' });
    expect(store.failures).toEqual([
      'Topic already exists in subject graph (case-insensitive, trimmed).',
    ]);
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });

  it('graph/children-add refuses a draft whose minted id collides with an existing room', async () => {
    const input = fixture();
    const store = createRecordingStore(cloneSnapshot(input));
    const controller = createCreatorGraphController({
      store: store.port,
      nowIso: () => FIXED_NOW,
      // The mint is the only seam that can produce this: a real collision needs
      // the generator to hand back an id the subject already has.
      newRoomId: () => 'room-beta',
    });

    const error = expectRefusal(
      await controller.addChildTopics({ parentRoomId: 'room-root', topics: ['Delta'] }),
    );

    expect(error.code).toBe('ROOM_ALREADY_EXISTS');
    expect(error.message).toBe('Room id already exists in subject graph.');
    expect(error.details).toEqual({ roomId: 'room-beta' });
    expect(store.failures).toEqual(['Room id already exists in subject graph.']);
    // The domain rejects the whole batch, so neither draft landed.
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });

  it('graph/children-add refuses a draft whose id equals the parent room with SELF_LOOP_EDGE', async () => {
    const input = fixture();
    const store = createRecordingStore(cloneSnapshot(input));
    const controller = createCreatorGraphController({
      store: store.port,
      nowIso: () => FIXED_NOW,
      newRoomId: () => 'room-root',
    });

    const error = expectRefusal(
      await controller.addChildTopics({ parentRoomId: 'room-root', topics: ['Delta'] }),
    );

    expect(error.code).toBe('SELF_LOOP_EDGE');
    expect(error.message).toBe('Linked rooms cannot self-loop to source room.');
    expect(error.details).toEqual({ roomId: 'room-root' });
    expect(store.failures).toEqual(['Linked rooms cannot self-loop to source room.']);
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });

  it('graph/cross-link-add refuses an edge that already exists with EDGE_ALREADY_EXISTS', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    const error = expectRefusal(
      await controller.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-alpha' }),
    );

    expect(error.code).toBe('EDGE_ALREADY_EXISTS');
    expect(error.message).toBe('Cross-link already exists.');
    expect(error.details).toEqual({ fromRoomId: 'room-root', toRoomId: 'room-alpha' });
    expect(store.failures).toEqual(['Cross-link already exists.']);
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });

  it('graph/cross-link-add refuses a self-loop with SELF_LOOP_EDGE', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    const error = expectRefusal(
      await controller.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-root' }),
    );

    expect(error.code).toBe('SELF_LOOP_EDGE');
    expect(error.message).toBe('Cross-link cannot self-loop.');
    expect(error.details).toEqual({ roomId: 'room-root' });
    expect(store.failures).toEqual(['Cross-link cannot self-loop.']);
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });

  it('graph/cross-link-add refuses an unknown endpoint with ROOM_NOT_FOUND', async () => {
    const { store, controller } = harness(cloneSnapshot(fixture()));

    const error = expectRefusal(
      await controller.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-missing' }),
    );

    expect(error.code).toBe('ROOM_NOT_FOUND');
    expect(error.message).toBe('Cross-link endpoints must exist.');
    expect(error.details).toEqual({ fromRoomId: 'room-root', toRoomId: 'room-missing' });
    expect(store.failures).toEqual(['Cross-link endpoints must exist.']);
    expect(store.commits).toHaveLength(0);
  });

  it('graph/room-reparent refuses a move under the room own descendant with INVALID_OPERATION', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    // room-beta hangs off room-alpha, so moving alpha under beta is a cycle.
    const error = expectRefusal(
      await controller.reparentRoom({ roomId: 'room-alpha', newParentRoomId: 'room-beta' }),
    );

    expect(error.code).toBe('INVALID_OPERATION');
    expect(error.message).toBe('Cannot move a room under one of its descendants.');
    expect(error.details).toEqual({ roomId: 'room-alpha', newParentRoomId: 'room-beta' });
    expect(store.failures).toEqual(['Cannot move a room under one of its descendants.']);
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });

  it('graph/room-reparent refuses to reparent the root with INVALID_OPERATION', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    const error = expectRefusal(
      await controller.reparentRoom({ roomId: 'room-root', newParentRoomId: 'room-alpha' }),
    );

    expect(error.code).toBe('INVALID_OPERATION');
    expect(error.message).toBe('Cannot change the parent of the root room.');
    expect(error.details).toEqual({ roomId: 'room-root' });
    expect(store.failures).toEqual(['Cannot change the parent of the root room.']);
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });

  it('graph/room-reparent refuses an unknown room with ROOM_NOT_FOUND', async () => {
    const { store, controller } = harness(cloneSnapshot(fixture()));

    const error = expectRefusal(
      await controller.reparentRoom({ roomId: 'room-missing', newParentRoomId: 'room-alpha' }),
    );

    expect(error.code).toBe('ROOM_NOT_FOUND');
    expect(error.message).toBe('Reparent endpoints must exist.');
    expect(error.details).toEqual({ roomId: 'room-missing', newParentRoomId: 'room-alpha' });
    expect(store.commits).toHaveLength(0);
  });

  it('graph/room-reparent refuses self-parenting with SELF_LOOP_EDGE', async () => {
    const { store, controller } = harness(cloneSnapshot(fixture()));

    const error = expectRefusal(
      await controller.reparentRoom({ roomId: 'room-alpha', newParentRoomId: 'room-alpha' }),
    );

    expect(error.code).toBe('SELF_LOOP_EDGE');
    expect(error.message).toBe('A room cannot become its own parent.');
    expect(error.details).toEqual({ roomId: 'room-alpha' });
    expect(store.commits).toHaveLength(0);
  });

  it('graph/room-remove refuses the root room with INVALID_OPERATION', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    const error = expectRefusal(await controller.removeRoom({ roomId: 'room-root' }));

    expect(error.code).toBe('INVALID_OPERATION');
    expect(error.message).toBe('Cannot remove the root room.');
    expect(error.details).toEqual({ roomId: 'room-root' });
    expect(store.failures).toEqual(['Cannot remove the root room.']);
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });

  it('graph/room-remove refuses an unknown room with ROOM_NOT_FOUND', async () => {
    const { store, controller } = harness(cloneSnapshot(fixture()));

    const error = expectRefusal(await controller.removeRoom({ roomId: 'room-missing' }));

    expect(error.code).toBe('ROOM_NOT_FOUND');
    expect(error.message).toBe('Room not found for removal.');
    expect(error.details).toEqual({ roomId: 'room-missing' });
    expect(store.failures).toEqual(['Room not found for removal.']);
    expect(store.commits).toHaveLength(0);
  });

  it('graph/children-add treats a blank-only topic list as a no-op with no write and no error', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    const outcome = expectOk(
      await controller.addChildTopics({ parentRoomId: 'room-root', topics: ['', '   ', '\t'] }),
    );

    expect(outcome).toEqual({
      command: 'graph/children-add',
      createdRoomIds: [],
      touchedRoomIds: [],
    });
    // Blanks are dropped before ids are minted, so nothing was even created to
    // write, and the old store action did not write an error either.
    expect(store.commits).toHaveLength(0);
    expect(store.failures).toEqual([]);
    expect(store.current()).toEqual(input);
  });
});

describe('creatorGraphCommands - cascade delete', () => {
  it('graph/room-remove removes unreachable descendants and their room metadata', async () => {
    const input = makeSubjectSnapshot({
      phaseState: 'ScribeActive',
      rooms: [
        { roomId: 'room-root', topic: 'Vector Spaces', status: 'Created' },
        { roomId: 'room-alpha', topic: 'Subspaces', status: 'ArtifactCollected' },
        {
          roomId: 'room-beta',
          topic: 'Bases',
          status: 'ArtifactCollected',
          metadata: {
            noteText: 'A basis is a spanning, linearly independent set.',
            artifactMarkdown: '# Bases',
            attachments: [
              {
                attachmentId: 'att-beta-1',
                sourceType: 'local',
                fileName: 'basis.png',
                mimeType: 'image/png',
                addedAt: FIXED_NOW,
              },
            ],
            reviewPassCount: 3,
            tags: ['kept-only-on-beta'],
          },
        },
      ],
      edges: [
        { fromRoomId: 'room-root', toRoomId: 'room-alpha' },
        { fromRoomId: 'room-alpha', toRoomId: 'room-beta' },
      ],
    });
    const { store, controller } = harness(cloneSnapshot(input));

    const outcome = expectOk(await controller.removeRoom({ roomId: 'room-alpha' }));

    expect(outcome.command).toBe('graph/room-remove');
    expect(outcome.removedRoomIds).toEqual(['room-alpha', 'room-beta']);

    const committed = store.commits[0];
    expect(committed.dungeon.rooms.map((room) => room.roomId)).toEqual(['room-root']);
    expect(committed.dungeon.edges).toEqual([]);
    // The metadata goes with the rooms: no orphaned notes, artifacts, or
    // attachments survive in the snapshot.
    expect(Object.keys(committed.rooms)).toEqual(['room-root']);
    expect(committed.rooms['room-alpha']).toBeUndefined();
    expect(committed.rooms['room-beta']).toBeUndefined();
  });

  it('graph/room-remove keeps a descendant that is still reachable by another edge', async () => {
    const input = makeSubjectSnapshot({
      phaseState: 'ScribeActive',
      rooms: [
        { roomId: 'room-root', topic: 'Vector Spaces', status: 'Created' },
        { roomId: 'room-alpha', topic: 'Subspaces', status: 'ArtifactCollected' },
        { roomId: 'room-beta', topic: 'Bases', status: 'ArtifactCollected' },
      ],
      edges: [
        { fromRoomId: 'room-root', toRoomId: 'room-alpha' },
        { fromRoomId: 'room-alpha', toRoomId: 'room-beta' },
        { fromRoomId: 'room-root', toRoomId: 'room-beta', relationType: 'related' },
      ],
    });
    const { store, controller } = harness(cloneSnapshot(input));

    const outcome = expectOk(await controller.removeRoom({ roomId: 'room-alpha' }));

    expect(outcome.removedRoomIds).toEqual(['room-alpha']);
    const committed = store.commits[0];
    expect(committed.dungeon.rooms.map((room) => room.roomId).sort()).toEqual([
      'room-beta',
      'room-root',
    ]);
    expect(Object.keys(committed.rooms).sort()).toEqual(['room-beta', 'room-root']);
    expect(committed.rooms['room-beta']?.reviewPassCount).toBe(0);
  });
});

describe('creatorGraphCommands - no active subject', () => {
  const cases: ReadonlyArray<{
    label: string;
    command: GraphCommand;
    invoke: (controller: ReturnType<typeof harness>['controller']) => Promise<
      GraphDomainResult<unknown>
    >;
  }> = [
    {
      label: 'graph/children-add',
      command: { type: 'graph/children-add', payload: { parentRoomId: 'room-root', topics: ['X'] } },
      invoke: (c) => c.addChildTopics({ parentRoomId: 'room-root', topics: ['X'] }),
    },
    {
      label: 'graph/cross-link-add',
      command: {
        type: 'graph/cross-link-add',
        payload: { fromRoomId: 'room-root', toRoomId: 'room-alpha' },
      },
      invoke: (c) => c.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-alpha' }),
    },
    {
      label: 'graph/room-reparent',
      command: {
        type: 'graph/room-reparent',
        payload: { roomId: 'room-beta', newParentRoomId: 'room-gamma' },
      },
      invoke: (c) => c.reparentRoom({ roomId: 'room-beta', newParentRoomId: 'room-gamma' }),
    },
    {
      label: 'graph/room-remove',
      command: { type: 'graph/room-remove', payload: { roomId: 'room-gamma' } },
      invoke: (c) => c.removeRoom({ roomId: 'room-gamma' }),
    },
    {
      label: 'graph/tags-set',
      command: { type: 'graph/tags-set', payload: { roomId: 'room-gamma', tags: ['a'] } },
      invoke: (c) => c.setRoomTags({ roomId: 'room-gamma', tags: ['a'] }),
    },
    {
      label: 'graph/tag-add',
      command: { type: 'graph/tag-add', payload: { roomId: 'room-gamma', tag: 'a' } },
      invoke: (c) => c.addRoomTag({ roomId: 'room-gamma', tag: 'a' }),
    },
    {
      label: 'graph/tag-remove',
      command: { type: 'graph/tag-remove', payload: { roomId: 'room-gamma', tag: 'seed-tag' } },
      invoke: (c) => c.removeRoomTag({ roomId: 'room-gamma', tag: 'seed-tag' }),
    },
  ];

  for (const { label, command, invoke } of cases) {
    it(`${label} refuses with INVALID_OPERATION and does not report a failure`, async () => {
      const { store, controller } = harness(null);

      const viaNamedMethod = expectRefusal(await invoke(controller));
      expect(viaNamedMethod).toEqual({ code: 'INVALID_OPERATION', message: 'No active subject' });

      // The pre-Phase-14 store returned before touching `lastError` on this
      // path, so reporting a failure here would be a visible behavior change.
      expect(store.failures).toEqual([]);
      expect(store.commits).toHaveLength(0);

      const viaDispatch = expectRefusal(await controller.dispatch(command));
      expect(viaDispatch).toEqual({ code: 'INVALID_OPERATION', message: 'No active subject' });
      expect(store.failures).toEqual([]);
      expect(store.commits).toHaveLength(0);
    });
  }
});

describe('creatorGraphCommands - tag commands', () => {
  it('graph/tag-add normalizes the tag and returns the resulting tags', async () => {
    const { store, controller } = harness(cloneSnapshot(fixture()));

    const outcome = expectOk(await controller.addRoomTag({ roomId: 'room-gamma', tag: '  Linear Algebra!  ' }));

    expect(outcome).toEqual({ command: 'graph/tag-add', tags: ['seed-tag', 'linear-algebra'] });
    expect(store.commits).toHaveLength(1);
    expect(store.commits[0].rooms['room-gamma']?.tags).toEqual(['seed-tag', 'linear-algebra']);
    expect(store.commits[0].dungeon.tagIndex).toEqual({
      'seed-tag': ['room-gamma'],
      'linear-algebra': ['room-gamma'],
    });
  });

  it('graph/tags-set replaces, normalizes, and de-duplicates the tag list', async () => {
    const { store, controller } = harness(cloneSnapshot(fixture()));

    const outcome = expectOk(
      await controller.setRoomTags({ roomId: 'room-gamma', tags: [' Vectors ', 'vectors', 'Bases!'] }),
    );

    expect(outcome).toEqual({ command: 'graph/tags-set', tags: ['vectors', 'bases'] });
    expect(store.commits[0].rooms['room-gamma']?.tags).toEqual(['vectors', 'bases']);
    expect(store.commits[0].dungeon.tagIndex).toEqual({
      vectors: ['room-gamma'],
      bases: ['room-gamma'],
    });
  });

  it('graph/tag-remove removes only the named tag', async () => {
    const input = makeSubjectSnapshot({
      phaseState: 'ScribeActive',
      rooms: [
        { roomId: 'room-root', topic: 'Vector Spaces', status: 'Created' },
        {
          roomId: 'room-gamma',
          topic: 'Linear Maps',
          status: 'Visited',
          metadata: { tags: ['seed-tag', 'other-tag'] },
        },
      ],
      edges: [{ fromRoomId: 'room-root', toRoomId: 'room-gamma' }],
    });
    const { store, controller } = harness(cloneSnapshot(input));

    const outcome = expectOk(await controller.removeRoomTag({ roomId: 'room-gamma', tag: 'seed-tag' }));

    expect(outcome).toEqual({ command: 'graph/tag-remove', tags: ['other-tag'] });
    expect(store.commits[0].rooms['room-gamma']?.tags).toEqual(['other-tag']);
    expect(store.commits[0].dungeon.tagIndex).toEqual({ 'other-tag': ['room-gamma'] });
  });

  it('commits a tag no-op anyway, because the pre-Phase-14 store persisted unconditionally', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    // 'seed-tag' is already on room-gamma, so the domain returns the room and
    // the dungeon untouched.
    const outcome = expectOk(await controller.addRoomTag({ roomId: 'room-gamma', tag: 'seed-tag' }));

    expect(outcome).toEqual({ command: 'graph/tag-add', tags: ['seed-tag'] });
    // A write happened...
    expect(store.commits).toHaveLength(1);
    // ...and it wrote exactly the snapshot that was already there.
    expect(store.commits[0]).toEqual(input);
  });

  it('reports ROOM_NOT_FOUND for a tag command on a room that is not in the snapshot', async () => {
    const input = fixture();
    const { store, controller } = harness(cloneSnapshot(input));

    for (const invoke of [
      () => controller.setRoomTags({ roomId: 'room-missing', tags: ['a'] }),
      () => controller.addRoomTag({ roomId: 'room-missing', tag: 'a' }),
      () => controller.removeRoomTag({ roomId: 'room-missing', tag: 'seed-tag' }),
    ] as ReadonlyArray<() => Promise<GraphDomainResult<unknown>>>) {
      const error = expectRefusal(await invoke());
      // The message is the tag domain's own thrown text, passed through.
      expect(error.code).toBe('ROOM_NOT_FOUND');
      expect(error.message).toBe('Room not found: room-missing');
      expect(error.details).toEqual({ roomId: 'room-missing' });
    }

    expect(store.failures).toEqual([
      'Room not found: room-missing',
      'Room not found: room-missing',
      'Room not found: room-missing',
    ]);
    expect(store.commits).toHaveLength(0);
    expect(store.current()).toEqual(input);
  });
});

describe('creatorGraphCommands - dispatch is the named method', () => {
  interface Case {
    command: GraphCommand;
    invoke: (controller: ReturnType<typeof harness>['controller']) => Promise<
      GraphDomainResult<unknown>
    >;
    expectedOutcome: { command: GraphCommandName; [key: string]: unknown };
  }

  const cases: readonly Case[] = [
    {
      command: {
        type: 'graph/children-add',
        payload: { parentRoomId: 'room-root', topics: ['Delta', 'Epsilon'] },
      },
      invoke: (c) => c.addChildTopics({ parentRoomId: 'room-root', topics: ['Delta', 'Epsilon'] }),
      expectedOutcome: {
        command: 'graph/children-add',
        createdRoomIds: ['room-minted-1', 'room-minted-2'],
        touchedRoomIds: ['room-root', 'room-minted-1', 'room-minted-2'],
      },
    },
    {
      command: {
        type: 'graph/cross-link-add',
        payload: { fromRoomId: 'room-root', toRoomId: 'room-beta' },
      },
      invoke: (c) => c.addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-beta' }),
      expectedOutcome: {
        command: 'graph/cross-link-add',
        touchedRoomIds: ['room-root', 'room-beta'],
      },
    },
    {
      command: {
        type: 'graph/room-reparent',
        payload: { roomId: 'room-gamma', newParentRoomId: 'room-alpha' },
      },
      invoke: (c) => c.reparentRoom({ roomId: 'room-gamma', newParentRoomId: 'room-alpha' }),
      expectedOutcome: {
        command: 'graph/room-reparent',
        previousParentRoomId: 'room-root',
        touchedRoomIds: ['room-alpha', 'room-gamma', 'room-root'],
      },
    },
    {
      command: { type: 'graph/room-remove', payload: { roomId: 'room-gamma' } },
      invoke: (c) => c.removeRoom({ roomId: 'room-gamma' }),
      expectedOutcome: {
        command: 'graph/room-remove',
        removedRoomIds: ['room-gamma'],
        touchedRoomIds: ['room-root'],
      },
    },
    {
      command: { type: 'graph/tags-set', payload: { roomId: 'room-gamma', tags: ['vectors'] } },
      invoke: (c) => c.setRoomTags({ roomId: 'room-gamma', tags: ['vectors'] }),
      expectedOutcome: { command: 'graph/tags-set', tags: ['vectors'] },
    },
    {
      command: { type: 'graph/tag-add', payload: { roomId: 'room-gamma', tag: 'matrices' } },
      invoke: (c) => c.addRoomTag({ roomId: 'room-gamma', tag: 'matrices' }),
      expectedOutcome: { command: 'graph/tag-add', tags: ['seed-tag', 'matrices'] },
    },
    {
      command: { type: 'graph/tag-remove', payload: { roomId: 'room-gamma', tag: 'seed-tag' } },
      invoke: (c) => c.removeRoomTag({ roomId: 'room-gamma', tag: 'seed-tag' }),
      expectedOutcome: { command: 'graph/tag-remove', tags: [] },
    },
  ];

  for (const { command, invoke, expectedOutcome } of cases) {
    it(`${command.type} returns the same outcome through dispatch and through the named method`, async () => {
      const input = fixture();

      const named = harness(cloneSnapshot(input));
      const viaNamed = await invoke(named.controller);

      const dispatched = harness(cloneSnapshot(input));
      const viaDispatch = await dispatched.controller.dispatch(command);

      // The documented outcome, not just "the two calls matched": if both sides
      // were wrong in the same way this would still fail.
      expect(viaNamed).toEqual({ ok: true, value: expectedOutcome });
      expect(viaDispatch).toEqual(viaNamed);
      expect(dispatched.store.commits).toHaveLength(1);
      // The tag domain stamps its own `new Date()`, so the two lanes differ by
      // a millisecond; erasing timestamps is the whole of the allowance.
      expect(normalizeSnapshotForParity(dispatched.store.commits[0], BASE_ROOM_IDS)).toEqual(
        normalizeSnapshotForParity(named.store.commits[0], BASE_ROOM_IDS),
      );
      expect(named.store.failures).toEqual(dispatched.store.failures);
    });
  }
});

describe('creatorGraphCommands - persistence failures escape', () => {
  function failingCommitController() {
    return createCreatorGraphController({
      store: {
        readSnapshot: () => cloneSnapshot(fixture()),
        commit: async () => {
          throw new Error('device storage is full');
        },
        // A write failure must never be reported as a domain refusal; if it is,
        // the tests below fail loudly instead of passing quietly.
        reportFailure: () => {
          throw new Error('reportFailure must not run for a write failure');
        },
      },
      nowIso: () => FIXED_NOW,
      newRoomId: createSequentialRoomIds(),
    });
  }

  it('a graph command rejects when commit rejects, like the store lane does', async () => {
    await expect(
      failingCommitController().addCrossLink({ fromRoomId: 'room-root', toRoomId: 'room-beta' }),
    ).rejects.toThrow('device storage is full');
  });

  it('a tag command also rejects when commit rejects', async () => {
    // NOTE: this is a *divergence* from the store lane, not parity. The store's
    // three tag actions put `await persist(next)` inside their try/catch, so a
    // write failure there is swallowed into `lastError` and the action resolves;
    // `applyTag` awaits `commit` outside its try, so it rejects. The two lanes
    // are put side by side in
    // `tests/contracts/creator-graph-store-parity.test.ts` -> "known divergences".
    // Pinned here so the application lane's own behavior is pinned too.
    await expect(
      failingCommitController().addRoomTag({ roomId: 'room-gamma', tag: 'matrices' }),
    ).rejects.toThrow('device storage is full');
  });
});