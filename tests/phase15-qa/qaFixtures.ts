/**
 * Independent QA fixture for the Phase 15 exit-criteria probes.
 *
 * ## Why this exists rather than reusing `tests/phase15/support/scribeFixtures.ts`
 *
 * A verifier that probes with the implementers' own fixture can only ever confirm that
 * their fixture and their code agree. This fixture is built with a different shape on
 * purpose: a **branching** graph, not a chain, because the clear identity digests a room's
 * edge *window*, and a chain has no edge that is provably outside it. The branching shape
 * gives this suite three addressable positions:
 *
 * ```
 * Algorithms (root, r-root)
 * |              \
 * v               v
 * r-leaf       r-target          <- the room under test
 * |              \
 * v                v
 * r-leaf-2      r-target-2
 *
 * plus r-far, linked to r-leaf-2 only.
 * ```
 *
 * For `r-target`, an edge touching `r-leaf-2` or `r-far` is *outside* the window that
 * `propagateRevalidationAfterGraphMutation` can reach, and an edge touching `r-target-2`
 * is *inside* it. That distinction is what makes "the identity is graph-sensitive, and
 * sensitive to exactly the right edges" an assertion rather than a hope.
 *
 * No renderer, no network, no `dist/`, no clock, no persistence stubbing here. The tests
 * stub the subject store's own write, as every test in this repository does.
 */
import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { makeEmptyRoomMetadata } from '@/core/validation/persistence';
import type { SubjectSnapshot } from '@/core/validation/persistence';

export const QA_NOW = '2026-03-04T05:06:07.000Z';
export const QA_DUNGEON_ID = 'subject-qa-branch';

export const ROOT_ROOM = 'r-root';
export const TARGET_ROOM = 'r-target';
export const NEIGHBOUR_ROOM = 'r-target-2';
export const OUT_OF_WINDOW_ROOM = 'r-leaf-2';
export const FAR_ROOM = 'r-far';

/** The journal note id `collectArtifactNote` builds for the target room. */
export const TARGET_NOTE_ID = `${QA_DUNGEON_ID}:${TARGET_ROOM}`;

export interface QaFixture {
  readonly snapshot: SubjectSnapshot;
}

/**
 * A note that passes `evaluateNoteValidation`: all three headings, several body lines,
 * the topic's own term, a link, and two recall questions.
 */
export const QA_VALID_NOTE = [
  '## Summary',
  '',
  'A linked list is a sequence of nodes, each holding a value and a pointer.',
  '',
  '## Key Points',
  '',
  '- Each node stores data and a link.',
  '- Insertion at the head is constant time.',
  '- See https://en.wikipedia.org/wiki/Linked_list for the history.',
  '',
  '## Recall Question',
  '',
  'What does each node in a linked list store?',
  'Why is head insertion constant time?',
].join('\n');

/**
 * A note that cannot pass: no required headings at all, and no confirmation.
 *
 * Deliberately *not* an almost-valid note, so the draft branch cannot be reached by an
 * accidental `finalPass`.
 */
export const QA_INVALID_NOTE = 'i had a thought about lists';

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(`graph refused: ${result.error.message}`);
  return result.value;
}

/** Build the branching fixture described in this module's header. */
export function buildQaFixture(): QaFixture {
  let dungeon = must(
    createRootDungeon({
      dungeonId: QA_DUNGEON_ID,
      subjectName: 'Data Structures',
      rootRoomId: ROOT_ROOM,
      rootTopic: 'Algorithms',
      nowIso: QA_NOW,
    }),
  );

  dungeon = must(
    addLinkedRooms(dungeon, {
      fromRoomId: ROOT_ROOM,
      drafts: [
        { roomId: OUT_OF_WINDOW_ROOM, topic: 'Leaves' },
        { roomId: TARGET_ROOM, topic: 'Linked Lists' },
      ],
      nowIso: QA_NOW,
    }),
  ).dungeon;

  dungeon = must(
    addLinkedRooms(dungeon, {
      fromRoomId: OUT_OF_WINDOW_ROOM,
      drafts: [{ roomId: FAR_ROOM, topic: 'Far Away' }],
      nowIso: QA_NOW,
    }),
  ).dungeon;

  dungeon = must(
    addLinkedRooms(dungeon, {
      fromRoomId: TARGET_ROOM,
      drafts: [{ roomId: NEIGHBOUR_ROOM, topic: 'Linked List Variants' }],
      nowIso: QA_NOW,
    }),
  ).dungeon;

  const rooms = Object.fromEntries(
    dungeon.rooms.map((summary) => [
      summary.roomId,
      makeEmptyRoomMetadata({
        roomId: summary.roomId,
        topic: summary.topic,
        nowIso: QA_NOW,
      }),
    ]),
  );

  return { snapshot: { dungeon, rooms } };
}