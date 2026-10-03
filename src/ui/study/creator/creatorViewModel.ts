/**
 * Everything the Creator workspace shows, derived from a subject snapshot.
 *
 * ## Read-only on purpose
 *
 * This module is the workspace's whole read surface: snapshot in, view model out. It
 * calls `deriveGraphHierarchy`, `getConnectedRoomIds`, and `isReachableViaSubtopics`
 * from `@/core/graph` and nothing else - it never calls a mutation, never touches the
 * application layer, and never imports a store or a renderer. That is what makes
 * "every graph verb needs a DOM route" a structural claim rather than a reviewer's
 * opinion: the DOM can render every fact here and still have no way to change one.
 *
 * ## The refusals are computed here, not guessed in the component
 *
 * Each candidate carries the reason it is unavailable, in the same terms the graph
 * domain refuses in ("Cannot move a room under one of its descendants."), so a control
 * that is disabled can say why *before* anything is attempted. The domain still owns
 * the refusal: a stale candidate list can produce a refusal at dispatch time, and that
 * refusal is what the workspace shows then.
 */
import {
  deriveGraphHierarchy,
  getConnectedRoomIds,
  isReachableViaSubtopics,
  type GraphHierarchy,
} from '@/core/graph';
import type { RoomState, RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';

import type { CreatorNextActionKey } from './creatorTools';

/** The state that means "this topic changed, so its note has to be checked again". */
const NEEDS_REVALIDATION: RoomState = 'NeedsRevalidation';

/**
 * The room count the Scribe transition has always required.
 *
 * Preserved from the pre-Phase-14 Creator view, which offered "Switch to Scribe" once
 * the map had this many rooms. It is a constant rather than a re-derivation so the rule
 * has one place it can be changed from and one place a test can read it.
 */
export const SCRIBE_TRANSITION_ROOM_COUNT = 3;

export interface CreatorRoomSummary {
  readonly roomId: string;
  readonly topic: string;
  readonly state: RoomState;
  /** True when the room is the subject's root, which cannot be reparented or deleted. */
  readonly isRoot: boolean;
  /** True when a graph mutation has marked this room's note for revalidation. */
  readonly needsRevalidation: boolean;
  readonly tagCount: number;
}

export type CreatorRelationKind = 'parent' | 'child' | 'cross-link';

export interface CreatorRelatedTopic extends CreatorRoomSummary {
  readonly relation: CreatorRelationKind;
  /**
   * Why a cross-link to this room is refused, or `null` when it is allowed.
   *
   * Null for the parent and for children: those pairs already carry a `subtopic` edge,
   * so a cross-link between them would duplicate an edge the domain refuses.
   */
  readonly linkRefusal: string | null;
  /** Why this room cannot become the current room's parent, or `null`. */
  readonly reparentRefusal: string | null;
}

export interface CreatorFloorSummary {
  readonly floorId: string;
  readonly label: string;
  readonly roomCount: number;
}

export interface CreatorGraphSummary {
  readonly roomCount: number;
  readonly edgeCount: number;
  readonly crossLinkCount: number;
  readonly childEdgeCount: number;
  readonly floorCount: number;
  readonly floors: readonly CreatorFloorSummary[];
}

export interface CreatorNextActionSuggestion {
  readonly key: CreatorNextActionKey;
  readonly label: string;
  readonly detail: string;
  /**
   * Whether this step can do anything right now.
   *
   * A step that cannot is still rendered - a learner looking for a way to add a topic
   * should learn that the map already has everything this step needs - but the control
   * that performs it is disabled and says so.
   */
  readonly available: boolean;
  /** Why an unavailable step is unavailable, in one sentence. */
  readonly refusal: string | null;
}

export interface CreatorWorkspaceModel {
  /** The subject's root room, so a caller can fall back somewhere valid after a delete. */
  readonly rootRoomId: string;
  readonly current: CreatorRoomSummary & {
    readonly floorLabel: string;
    readonly breadcrumb: readonly string[];
    readonly parentRoomId: string | null;
    readonly parentTopic: string | null;
    readonly childCount: number;
    /** Child topics, deepest structure first for the "structure at a glance" line. */
    readonly descendantCount: number;
    readonly tags: readonly string[];
  };
  readonly related: readonly CreatorRelatedTopic[];
  /** Every room in the subject, for the topic picker. */
  readonly rooms: readonly CreatorRoomSummary[];
  /** Rooms a cross-link to the current topic is legal with, in topic order. */
  readonly linkCandidates: readonly CreatorRoomSummary[];
  /** Rooms the current topic can legally be moved under, in topic order. */
  readonly reparentCandidates: readonly CreatorRoomSummary[];
  readonly structure: CreatorGraphSummary;
  /** `null` when the room may be deleted, or the sentence saying why it may not. */
  readonly deleteRefusal: string | null;
  /** How many rooms a delete would take with it, for the confirmation sentence. */
  readonly deleteCascadeCount: number;
  /** Ranked most-useful first; the workspace promotes the archetype's step to the top. */
  readonly nextActions: readonly CreatorNextActionSuggestion[];
}

function summarizeRoom(
  snapshot: SubjectSnapshot,
  roomId: string,
  room: RoomMetadata | undefined,
): CreatorRoomSummary {
  return {
    roomId,
    topic: room?.topic ?? roomId,
    state: room?.state ?? 'Uncreated',
    isRoot: roomId === snapshot.dungeon.rootRoomId,
    needsRevalidation: room?.state === NEEDS_REVALIDATION,
    tagCount: room?.tags?.length ?? 0,
  };
}

/**
 * Every room below `roomId` through `subtopic` edges, in breadth-first order.
 *
 * The hierarchy already carries the children map, so this is a traversal and not a
 * second derivation - which is what keeps the cascade count in the delete confirmation
 * and the domain's own cascade in `removeRoom` describing the same subtree.
 */
export function descendantRoomIds(
  hierarchy: GraphHierarchy,
  roomId: string,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>([roomId]);
  const queue = [...(hierarchy.childRoomIdsByParentId[roomId] ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    found.push(current);
    queue.push(...(hierarchy.childRoomIdsByParentId[current] ?? []));
  }
  return found;
}

/**
 * Rank the steps a learner could take, most useful first.
 *
 * Deterministic and total: every key in {@link CREATOR_NEXT_ACTION_KEYS} gets an entry
 * whether or not it applies, so the workspace never has to invent one and the order is
 * a property of the graph rather than of the render.
 */
function rankNextActions(input: {
  roomCount: number;
  childCount: number;
  crossLinkCount: number;
  needsRevalidation: boolean;
}): CreatorNextActionSuggestion[] {
  const addable = input.roomCount >= 1;
  const linkable = input.roomCount >= 2;

  const suggestions: CreatorNextActionSuggestion[] = [
    {
      key: 'handle-revalidation',
      label: 'Revalidate this topic in Scribe',
      detail: input.needsRevalidation
        ? 'A graph change marked this topic for revalidation, so its note needs checking again.'
        : 'Nothing about this topic is waiting on a revalidation.',
      available: input.needsRevalidation,
      refusal: input.needsRevalidation
        ? null
        : 'This topic has not been marked for revalidation, so there is nothing to revalidate yet.',
    },
    {
      key: 'add-child-topics',
      label: 'Add child topics',
      detail:
        input.childCount === 0
          ? 'This topic has no subtopics yet, so it is a leaf in the map.'
          : `This topic already has ${input.childCount} subtopic${input.childCount === 1 ? '' : 's'}.`,
      available: addable,
      refusal: addable ? null : 'There is no topic to add subtopics to.',
    },
    {
      key: 'cross-link',
      label: 'Link a related topic',
      detail:
        input.crossLinkCount === 0
          ? 'This topic is only connected through its parent, so it has no cross-links yet.'
          : `This topic already has ${input.crossLinkCount} cross-link${input.crossLinkCount === 1 ? '' : 's'}.`,
      available: linkable,
      refusal: linkable
        ? null
        : 'A cross-link needs two topics. Add a subtopic first, then link them.',
    },
    {
      key: 'start-scribe',
      label: 'Switch to Scribe',
      detail:
        input.roomCount >= SCRIBE_TRANSITION_ROOM_COUNT
          ? `The map has ${input.roomCount} topics, which is enough to start Scribe encounters.`
          : `The map has ${input.roomCount} topic${input.roomCount === 1 ? '' : 's'}. Scribe opens at ${SCRIBE_TRANSITION_ROOM_COUNT}.`,
      available: input.roomCount >= SCRIBE_TRANSITION_ROOM_COUNT,
      refusal:
        input.roomCount >= SCRIBE_TRANSITION_ROOM_COUNT
          ? null
          : `Add ${SCRIBE_TRANSITION_ROOM_COUNT - input.roomCount} more topic${SCRIBE_TRANSITION_ROOM_COUNT - input.roomCount === 1 ? '' : 's'} and the Scribe phase opens.`,
    },
    {
      key: 'review-structure',
      label: 'Look at the graph structure',
      detail: 'Every topic in the subject, with the topics that branch off it.',
      available: true,
      refusal: null,
    },
  ];

  // `handle-revalidation` sorts first when it applies and last when it does not, so a
  // room with nothing pending does not open on a step that says "nothing to do".
  return [
    ...suggestions.filter((entry) => entry.key !== 'handle-revalidation'),
    ...suggestions.filter((entry) => entry.key === 'handle-revalidation' && entry.available),
    ...suggestions.filter((entry) => entry.key === 'handle-revalidation' && !entry.available),
  ];
}

/**
 * Build the workspace model for one room.
 *
 * @param snapshot The live subject snapshot. Read-only.
 * @param selectedRoomId The room the learner is working on, which is not necessarily the
 *   room they are standing in: the workspace is a map editor, and editing a topic does
 *   not move the character.
 */
export function buildCreatorWorkspaceModel(
  snapshot: SubjectSnapshot,
  selectedRoomId: string,
): CreatorWorkspaceModel {
  const { dungeon } = snapshot;
  const hierarchy = deriveGraphHierarchy(dungeon);
  const room = snapshot.rooms[selectedRoomId];
  const current = summarizeRoom(snapshot, selectedRoomId, room);

  const floorId = hierarchy.floorIdByRoomId[selectedRoomId] ?? dungeon.rootRoomId;
  /*
   * The path includes the topic itself, root first. It is the walk a learner would say
   * out loud - "Linear Algebra, then Matrices" - and the shell header names the topic on
   * the line above, so repeating it at the end is the path rather than a duplicate.
   */
  const breadcrumb = hierarchy.breadcrumbRoomIdsByRoomId[selectedRoomId].map(
    (roomId) => snapshot.rooms[roomId]?.topic ?? roomId,
  );
  const parentRoomId = hierarchy.parentByRoomId[selectedRoomId] ?? null;
  const childRoomIds = hierarchy.childRoomIdsByParentId[selectedRoomId] ?? [];
  const crossLinkRoomIds = getConnectedRoomIds(dungeon, selectedRoomId).filter(
    (roomId) => roomId !== parentRoomId && !childRoomIds.includes(roomId),
  );

  const relationOf = (roomId: string): CreatorRelationKind => {
    if (roomId === parentRoomId) return 'parent';
    if (childRoomIds.includes(roomId)) return 'child';
    return 'cross-link';
  };

  const relatedIds = [...new Set([...(parentRoomId === null ? [] : [parentRoomId]), ...childRoomIds, ...crossLinkRoomIds])];

  const related: CreatorRelatedTopic[] = relatedIds
    .map((roomId): CreatorRelatedTopic => {
      const relation = relationOf(roomId);
      const isSubtopicPair = relation === 'parent' || relation === 'child';
      const canReparent =
        !current.isRoot &&
        roomId !== parentRoomId &&
        !isReachableViaSubtopics(dungeon, selectedRoomId, roomId);
      return {
        ...summarizeRoom(snapshot, roomId, snapshot.rooms[roomId]),
        relation,
        /*
         * Every room in `related` is already connected to the current one - that is what
         * `related` is built from (parent, children, cross-link neighbours). So there is no
         * row here a cross-link could legally be added to: a subtopic pair already has the
         * edge, and a cross-link neighbour already has the edge too. Leaving this `null`
         * for the cross-link case rendered a "Cross-link to X" button that could only ever
         * fail with `EDGE_ALREADY_EXISTS`, so the refusal is stated for both.
         *
         * The legal cross-link targets are `linkCandidates`, which excludes everything
         * already connected; the `topic-tools` select is built from those.
         */
        linkRefusal: isSubtopicPair
          ? 'Already connected as a subtopic. Remove the subtopic before linking it again.'
          : 'Already cross-linked. Remove the cross-link before adding it again.',
        reparentRefusal: canReparent
          ? null
          : current.isRoot
            ? 'The root topic cannot be moved under another topic.'
            : roomId === parentRoomId
              ? 'This is already the parent topic.'
              : 'A topic cannot be moved under one of its own subtopics.',
      };
    })
    .sort((left, right) => {
      const order: Record<CreatorRelationKind, number> = { parent: 0, child: 1, 'cross-link': 2 };
      const relationCompare = order[left.relation] - order[right.relation];
      if (relationCompare !== 0) return relationCompare;
      return left.topic.localeCompare(right.topic);
    });

  const crossLinkCount = crossLinkRoomIds.length;
  const nextActions = rankNextActions({
    roomCount: dungeon.rooms.length,
    childCount: childRoomIds.length,
    crossLinkCount,
    needsRevalidation: current.needsRevalidation,
  });

  const rooms: CreatorRoomSummary[] = [...dungeon.rooms]
    .sort((left, right) => left.topic.localeCompare(right.topic))
    .map((entry) => summarizeRoom(snapshot, entry.roomId, snapshot.rooms[entry.roomId]));

  const linkCandidates = rooms.filter(
    (candidate) =>
      candidate.roomId !== selectedRoomId &&
      candidate.roomId !== parentRoomId &&
      !childRoomIds.includes(candidate.roomId),
  );

  const reparentCandidates = current.isRoot
    ? []
    : rooms.filter(
        (candidate) =>
          candidate.roomId !== selectedRoomId &&
          candidate.roomId !== parentRoomId &&
          !isReachableViaSubtopics(dungeon, selectedRoomId, candidate.roomId),
      );

  return {
    rootRoomId: dungeon.rootRoomId,
    current: {
      ...current,
      floorLabel: hierarchy.floorLabelByFloorId[floorId] ?? floorId,
      breadcrumb,
      parentRoomId,
      parentTopic: parentRoomId === null ? null : snapshot.rooms[parentRoomId]?.topic ?? null,
      childCount: childRoomIds.length,
      descendantCount: descendantRoomIds(hierarchy, selectedRoomId).length,
      tags: [...(room?.tags ?? [])],
    },
    related,
    rooms,
    linkCandidates,
    reparentCandidates,
    structure: {
      roomCount: dungeon.rooms.length,
      edgeCount: dungeon.edges.length,
      crossLinkCount: dungeon.edges.filter((edge) => edge.relationType !== 'subtopic').length,
      childEdgeCount: dungeon.edges.filter((edge) => edge.relationType === 'subtopic').length,
      floorCount: hierarchy.floorIds.length,
      floors: hierarchy.floorIds.map((entryFloorId) => ({
        floorId: entryFloorId,
        label: hierarchy.floorLabelByFloorId[entryFloorId] ?? entryFloorId,
        roomCount: (hierarchy.roomIdsByFloorId[entryFloorId] ?? []).length,
      })),
    },
    deleteRefusal: current.isRoot
      ? 'The root topic cannot be deleted.'
      : room === undefined
        ? 'This topic is not in the current subject.'
        : null,
    deleteCascadeCount: descendantRoomIds(hierarchy, selectedRoomId).length,
    nextActions,
  };
}
