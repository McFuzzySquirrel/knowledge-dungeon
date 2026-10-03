/**
 * Creator graph-mutation application layer.
 *
 * The Creator workspace used to reach past the application layer into
 * `useSubjectStore` and let each store action call `src/core/graph` and then do
 * its own revalidation propagation. This module is the one implementation of
 * those mutations: a DOM control dispatches a `graph/*` command from
 * `src/application/contracts/commands.ts` and receives the graph domain's own
 * `GraphDomainResult`, so a refusal is a typed, discriminated answer rather than
 * a `lastError` string discovered afterwards.
 *
 * Plain TypeScript, like `studyFlow.ts`: no React, no renderer, no DOM, no
 * store import. Every side effect - read the snapshot, commit a new one, record
 * a message, read the clock, mint a room id - is an injected port, so the whole
 * surface is testable without a browser and without a store.
 *
 * ## Semantics are the pre-Phase-14 store's, deliberately
 *
 * Phase 14's exit criterion 2 is "Revalidation behavior remains unchanged", so
 * this module is a *move*, not a redesign. In particular:
 *
 * - {@link propagateAfterGraphMutation} is the revalidation step, byte for byte
 *   the one the store actions performed: a propagation refusal falls back to the
 *   unpropagated dungeon instead of aborting the mutation.
 * - The tag commands run **no** revalidation propagation, because the store's
 *   tag actions ran none. That asymmetry is preserved, not fixed.
 * - Tag commands commit even when they changed nothing (an empty or duplicate
 *   tag), because the store's tag actions persisted unconditionally too.
 * - Domain refusals are returned as results *and* mirrored to `reportFailure`,
 *   because the store wrote `lastError` on refusal and the existing UI reads it.
 * - A persistence failure rejects for the four graph commands, because their
 *   `persist` call was never inside the store actions' `try`.
 * - It does **not** uniformly reject for the three tag commands, and the two
 *   lanes genuinely differ here. The store's tag actions wrap `await persist` in
 *   the same `try` as the domain call, so a write failure is swallowed into
 *   `lastError` and the action resolves; `applyTag` awaits `commit` outside its
 *   `try`, so the command rejects and `lastError` stays `null`. The command form
 *   is kept as-is on purpose: `ok: true` next to a failed write would be a typed
 *   lie, which is worse than the store's untyped silence. `applyTag` also rejects
 *   for an unknown room, so a caller that awaited without a `catch` would see a
 *   refusal and an I/O failure in the same place.
 *   Known divergence, pinned by `tests/contracts/creator-graph-store-parity.test.ts`
 *   and recorded as a Phase 14 limitation. Making the store reject too would make
 *   the rollback lane's `void addRoomTag(...)` calls unhandled rejections, so it
 *   is not this phase's change to make.
 *
 * Domain error codes and messages are never restated here; they come from the
 * domain, and the tag domain's thrown message is passed through rather than
 * retyped, so the two cannot drift.
 */
import {
  addCrossLink,
  addLinkedRooms,
  addRoomTag,
  propagateRevalidationAfterGraphMutation,
  reparentRoom,
  removeRoom,
  removeRoomTag,
  setRoomTags,
  type GraphDomainError,
  type GraphDomainResult,
} from '@/core/graph';
import {
  makeEmptyRoomMetadata,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import type {
  GraphAddChildTopicsPayload,
  GraphAddCrossLinkPayload,
  GraphAddRoomTagPayload,
  GraphCommand,
  GraphCommandName,
  GraphRemoveRoomTagPayload,
  GraphRemoveRoomPayload,
  GraphReparentRoomPayload,
  GraphSetRoomTagsPayload,
} from './contracts/commands';

// ── Ports ───────────────────────────────────────────────────────────────────

/**
 * The subject store, as this module is allowed to see it.
 *
 * Three operations only. Anything richer - a write that touches more than the
 * snapshot, a renderer, a React ref - would be a port this layer should not have.
 */
export interface CreatorGraphStorePort {
  /** Live subject snapshot, or `null` when no subject is loaded. */
  readSnapshot(): SubjectSnapshot | null;
  /**
   * Apply the new snapshot, clear the last-error slot, and persist.
   *
   * Resolves once the write has completed. A rejected promise means the write
   * failed, exactly as `persist` failing did before Phase 14.
   */
  commit(snapshot: SubjectSnapshot): Promise<void>;
  /**
   * Record a message in the last-error slot without mutating the snapshot.
   *
   * Called once per *domain* refusal. Not called when no subject is loaded:
   * the store returned before touching `lastError` in that case, and preserving
   * that is what lets a rollback to the store lane show the same thing.
   */
  reportFailure(message: string): void;
}

/** Everything {@link createCreatorGraphController} needs. */
export interface CreatorGraphMutationDeps {
  store: CreatorGraphStorePort;
  /** Wall clock, so every timestamp a command stamps is injectable. */
  nowIso(): string;
  /** Mint a fresh room id for a created child topic. */
  newRoomId(): string;
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/** What `graph/children-add` created. */
export interface GraphChildrenAddOutcome {
  command: 'graph/children-add';
  /** Rooms this command created, in the order the topics were given. */
  createdRoomIds: string[];
  /** Rooms the domain reported as touched, for revalidation. */
  touchedRoomIds: string[];
}

/** What `graph/cross-link-add` linked. */
export interface GraphCrossLinkAddOutcome {
  command: 'graph/cross-link-add';
  touchedRoomIds: string[];
}

/** What `graph/room-reparent` moved. */
export interface GraphReparentRoomOutcome {
  command: 'graph/room-reparent';
  /** The subtopic parent before the move, or `null` when there was none. */
  previousParentRoomId: string | null;
  touchedRoomIds: string[];
}

/** What `graph/room-remove` removed, cascade included. */
export interface GraphRemoveRoomOutcome {
  command: 'graph/room-remove';
  /** The room and every descendant it took with it. */
  removedRoomIds: string[];
  touchedRoomIds: string[];
}

/** What a tag command left on the room. */
export interface GraphSetRoomTagsOutcome {
  command: 'graph/tags-set';
  tags: string[];
}
/** What `graph/tag-add` left on the room. */
export interface GraphAddRoomTagOutcome {
  command: 'graph/tag-add';
  tags: string[];
}
/** What `graph/tag-remove` left on the room. */
export interface GraphRemoveRoomTagOutcome {
  command: 'graph/tag-remove';
  tags: string[];
}

/** The outcome of every Creator graph mutation, discriminated by command. */
export type CreatorGraphOutcome =
  | GraphChildrenAddOutcome
  | GraphCrossLinkAddOutcome
  | GraphReparentRoomOutcome
  | GraphRemoveRoomOutcome
  | GraphSetRoomTagsOutcome
  | GraphAddRoomTagOutcome
  | GraphRemoveRoomTagOutcome;

/** The result of one named command. */
export type CreatorGraphResult<C extends GraphCommandName> = GraphDomainResult<
  Extract<CreatorGraphOutcome, { command: C }>
>;

/** The three tag command names, which share one execution shape. */
export type TagCommandName = 'graph/tags-set' | 'graph/tag-add' | 'graph/tag-remove';

/** What any of the tag commands left on the room, before it is tagged by name. */
interface TagMutation {
  command: TagCommandName;
  tags: string[];
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * The Creator graph-mutation surface.
 *
 * Each method takes exactly the payload its command declares and returns
 * exactly that command's outcome - narrowed, with no cast at the call site.
 * {@link dispatch} accepts the tagged {@link GraphCommand} union for callers
 * that hold a command as data.
 */
export interface CreatorGraphController {
  /** `graph/children-add` - create child topics in bulk under one room. */
  addChildTopics(payload: GraphAddChildTopicsPayload): Promise<CreatorGraphResult<'graph/children-add'>>;
  /** `graph/cross-link-add` - link two rooms without re-parenting either. */
  addCrossLink(payload: GraphAddCrossLinkPayload): Promise<CreatorGraphResult<'graph/cross-link-add'>>;
  /** `graph/room-reparent` - move a room under a different parent. */
  reparentRoom(payload: GraphReparentRoomPayload): Promise<CreatorGraphResult<'graph/room-reparent'>>;
  /** `graph/room-remove` - remove a room and its orphaned descendants. */
  removeRoom(payload: GraphRemoveRoomPayload): Promise<CreatorGraphResult<'graph/room-remove'>>;
  /** `graph/tags-set` - replace a room's tags. */
  setRoomTags(payload: GraphSetRoomTagsPayload): Promise<CreatorGraphResult<'graph/tags-set'>>;
  /** `graph/tag-add` - add one tag to a room. */
  addRoomTag(payload: GraphAddRoomTagPayload): Promise<CreatorGraphResult<'graph/tag-add'>>;
  /** `graph/tag-remove` - remove one tag from a room. */
  removeRoomTag(payload: GraphRemoveRoomTagPayload): Promise<CreatorGraphResult<'graph/tag-remove'>>;
  /** Execute any Creator graph command held as a tagged value. */
  dispatch(command: GraphCommand): Promise<GraphDomainResult<CreatorGraphOutcome>>;
}

// ── Shared refusal and no-subject answers ────────────────────────────────────

/**
 * The no-active-subject message.
 *
 * Not invented: it is the string `submitNote` already throws for the same
 * condition, and it is a condition message rather than learner data.
 */
const NO_ACTIVE_SUBJECT_MESSAGE = 'No active subject';

/**
 * The last-error fallbacks the store's tag actions used when a thrown value was
 * not an `Error`, reused verbatim so a rollback shows the same text.
 */
const TAG_FAILURE_FALLBACKS: Readonly<Record<TagCommandName, string>> = {
  'graph/tags-set': 'Failed to set tags.',
  'graph/tag-add': 'Failed to add tag.',
  'graph/tag-remove': 'Failed to remove tag.',
};

/** A refusal in the graph domain's own shape, so no code is ever invented. */
function refusal(
  code: GraphDomainError['code'],
  message: string,
  details?: Record<string, unknown>,
): GraphDomainResult<never> {
  const error: GraphDomainError = { code, message };
  if (details) {
    error.details = details;
  }
  return { ok: false, error };
}

/**
 * The no-active-subject refusal.
 *
 * The store's graph actions returned silently here. A command has to answer, so
 * it answers with `INVALID_OPERATION` (an existing code) and the existing
 * `No active subject` wording - and, deliberately, *without* calling
 * `reportFailure`, because the store never wrote `lastError` on this path.
 */
function noActiveSubject(): GraphDomainResult<never> {
  return refusal('INVALID_OPERATION', NO_ACTIVE_SUBJECT_MESSAGE);
}

// ── Snapshot merge ───────────────────────────────────────────────────────────

/**
 * Merge a new dungeon into a snapshot: add or replace room metadata, then drop
 * metadata for rooms the dungeon no longer lists.
 *
 * The drop is what makes a cascade delete free - `graph/room-remove` only has
 * to hand over the new dungeon and every descendant's notes, artifacts, and
 * attachments go with it.
 *
 * Kept identical to the pre-Phase-14 store helper. The duplication is the point:
 * while both lanes exist, each has to be independently correct, and the parity
 * test is what holds them to each other. Deleting one copy is the cutover step.
 */
function withRooms(
  snapshot: SubjectSnapshot,
  dungeon: DungeonMetadata,
  newRooms: readonly RoomMetadata[] = [],
): SubjectSnapshot {
  const rooms = { ...snapshot.rooms };
  for (const room of newRooms) {
    rooms[room.roomId] = room;
  }
  for (const id of Object.keys(rooms)) {
    if (!dungeon.rooms.some((r) => r.roomId === id)) {
      delete rooms[id];
    }
  }
  return { dungeon, rooms };
}

// ── Revalidation ─────────────────────────────────────────────────────────────

/**
 * Revalidation propagation after a graph mutation, byte for byte the step the
 * store performed on every graph mutation.
 *
 * Note the fallback: when `propagateRevalidationAfterGraphMutation` refuses,
 * the *unpropagated* dungeon is used and the mutation still lands. That is the
 * existing behavior and Phase 14 requires it to be unchanged, so it is written
 * here as it was rather than tidied into an early return.
 */
function propagateAfterGraphMutation(
  dungeon: DungeonMetadata,
  touchedRoomIds: readonly string[],
  nowIso: string,
): DungeonMetadata {
  const propagated = propagateRevalidationAfterGraphMutation({
    dungeon,
    touchedRoomIds,
    nowIso,
  });
  return propagated.ok ? propagated.value.dungeon : dungeon;
}

// ── Commands ─────────────────────────────────────────────────────────────────

/** `graph/children-add`. */
async function runChildrenAdd(
  deps: CreatorGraphMutationDeps,
  payload: GraphAddChildTopicsPayload,
): Promise<GraphDomainResult<GraphChildrenAddOutcome>> {
  const snapshot = deps.store.readSnapshot();
  if (!snapshot) return noActiveSubject();

  // Blank topics are dropped *before* ids are minted, so a list of blanks costs
  // no ids and creates nothing.
  const normalizedTopics = payload.topics.map((topic) => topic.trim()).filter(Boolean);
  if (normalizedTopics.length === 0) {
    // The store returned here too - no mutation, no write, no error. A command
    // still has to answer, and "nothing was created" is the truthful answer.
    return {
      ok: true,
      value: { command: 'graph/children-add', createdRoomIds: [], touchedRoomIds: [] },
    };
  }

  const result = addLinkedRooms(snapshot.dungeon, {
    fromRoomId: payload.parentRoomId,
    drafts: normalizedTopics.map((topic) => ({ roomId: deps.newRoomId(), topic })),
    nowIso: deps.nowIso(),
  });
  if (!result.ok) {
    deps.store.reportFailure(result.error.message);
    return result;
  }

  const createdTopicByRoomId = new Map(
    result.value.dungeon.rooms.map((room) => [room.roomId, room.topic] as const),
  );
  const newRooms = result.value.createdRoomIds.map((roomId) =>
    makeEmptyRoomMetadata({
      roomId,
      topic: createdTopicByRoomId.get(roomId) ?? roomId,
      nowIso: deps.nowIso(),
    }),
  );
  await deps.store.commit(
    withRooms(
      snapshot,
      propagateAfterGraphMutation(result.value.dungeon, result.value.touchedRoomIds, deps.nowIso()),
      newRooms,
    ),
  );

  return {
    ok: true,
    value: {
      command: 'graph/children-add',
      createdRoomIds: result.value.createdRoomIds,
      touchedRoomIds: result.value.touchedRoomIds,
    },
  };
}

/** `graph/cross-link-add`. */
async function runCrossLinkAdd(
  deps: CreatorGraphMutationDeps,
  payload: GraphAddCrossLinkPayload,
): Promise<GraphDomainResult<GraphCrossLinkAddOutcome>> {
  const snapshot = deps.store.readSnapshot();
  if (!snapshot) return noActiveSubject();

  const result = addCrossLink(snapshot.dungeon, {
    fromRoomId: payload.fromRoomId,
    toRoomId: payload.toRoomId,
    relationType: payload.relationType,
    nowIso: deps.nowIso(),
  });
  if (!result.ok) {
    deps.store.reportFailure(result.error.message);
    return result;
  }

  await deps.store.commit(
    withRooms(
      snapshot,
      propagateAfterGraphMutation(result.value.dungeon, result.value.touchedRoomIds, deps.nowIso()),
    ),
  );

  return {
    ok: true,
    value: { command: 'graph/cross-link-add', touchedRoomIds: result.value.touchedRoomIds },
  };
}

/** `graph/room-reparent`. */
async function runReparentRoom(
  deps: CreatorGraphMutationDeps,
  payload: GraphReparentRoomPayload,
): Promise<GraphDomainResult<GraphReparentRoomOutcome>> {
  const snapshot = deps.store.readSnapshot();
  if (!snapshot) return noActiveSubject();

  const result = reparentRoom(snapshot.dungeon, {
    roomId: payload.roomId,
    newParentRoomId: payload.newParentRoomId,
    nowIso: deps.nowIso(),
  });
  if (!result.ok) {
    deps.store.reportFailure(result.error.message);
    return result;
  }

  await deps.store.commit(
    withRooms(
      snapshot,
      propagateAfterGraphMutation(result.value.dungeon, result.value.touchedRoomIds, deps.nowIso()),
    ),
  );

  return {
    ok: true,
    value: {
      command: 'graph/room-reparent',
      previousParentRoomId: result.value.previousParentRoomId,
      touchedRoomIds: result.value.touchedRoomIds,
    },
  };
}

/** `graph/room-remove`. */
async function runRemoveRoom(
  deps: CreatorGraphMutationDeps,
  payload: GraphRemoveRoomPayload,
): Promise<GraphDomainResult<GraphRemoveRoomOutcome>> {
  const snapshot = deps.store.readSnapshot();
  if (!snapshot) return noActiveSubject();

  const result = removeRoom(snapshot.dungeon, { roomId: payload.roomId, nowIso: deps.nowIso() });
  if (!result.ok) {
    deps.store.reportFailure(result.error.message);
    return result;
  }

  // No new room metadata: `withRooms` drops the removed rooms' entries because
  // they are no longer in the dungeon, which is how cascade delete takes their
  // notes, artifacts, and attachments with them.
  await deps.store.commit(
    withRooms(
      snapshot,
      propagateAfterGraphMutation(result.value.dungeon, result.value.touchedRoomIds, deps.nowIso()),
    ),
  );

  return {
    ok: true,
    value: {
      command: 'graph/room-remove',
      removedRoomIds: result.value.removedRoomIds,
      touchedRoomIds: result.value.touchedRoomIds,
    },
  };
}

/**
 * The three tag commands, which share a shape.
 *
 * They run the tag domain directly and, unlike the graph commands, run **no**
 * revalidation propagation - the store's tag actions did not, and changing that
 * would change revalidation behavior. They commit unconditionally: the tag
 * domain reports "nothing changed" by returning the input room and dungeon, and
 * the store persisted that no-op anyway.
 */
async function applyTag(
  command: TagCommandName,
  deps: CreatorGraphMutationDeps,
  roomId: string,
  mutate: (snapshot: SubjectSnapshot) => { room: RoomMetadata; dungeon: DungeonMetadata },
): Promise<GraphDomainResult<TagMutation>> {
  const snapshot = deps.store.readSnapshot();
  if (!snapshot) return noActiveSubject();

  let mutated: { room: RoomMetadata; dungeon: DungeonMetadata };
  try {
    mutated = mutate(snapshot);
  } catch (error) {
    // The tag domain signals a missing room by throwing. Its message is passed
    // through verbatim rather than retyped here, so it cannot drift from the
    // domain's own wording; the code is chosen from the snapshot, not from the
    // message, so it is not a guess about an English string.
    const message = error instanceof Error ? error.message : TAG_FAILURE_FALLBACKS[command];
    deps.store.reportFailure(message);
    return refusal(snapshot.rooms[roomId] ? 'INVALID_OPERATION' : 'ROOM_NOT_FOUND', message, {
      roomId,
    });
  }

  await deps.store.commit(withRooms(snapshot, mutated.dungeon, [mutated.room]));

  return { ok: true, value: { command, tags: [...(mutated.room.tags ?? [])] } };
}

// ── Controller ───────────────────────────────────────────────────────────────

/**
 * Build the Creator graph-mutation controller.
 *
 * @param deps Injected store port, clock, and room-id mint. No defaults: the
 * application layer must not reach for a real store, a real `Date`, or a real
 * `Math.random` on its own.
 */
export function createCreatorGraphController(
  deps: CreatorGraphMutationDeps,
): CreatorGraphController {
  const setTags = async (payload: GraphSetRoomTagsPayload) => {
    const result = await applyTag('graph/tags-set', deps, payload.roomId, (snapshot) =>
      setRoomTags(snapshot, payload.roomId, [...payload.tags]),
    );
    if (!result.ok) return result;
    return { ok: true as const, value: { command: 'graph/tags-set' as const, tags: result.value.tags } };
  };

  const addTag = async (payload: GraphAddRoomTagPayload) => {
    const result = await applyTag('graph/tag-add', deps, payload.roomId, (snapshot) =>
      addRoomTag(snapshot, payload.roomId, payload.tag),
    );
    if (!result.ok) return result;
    return { ok: true as const, value: { command: 'graph/tag-add' as const, tags: result.value.tags } };
  };

  const removeTag = async (payload: GraphRemoveRoomTagPayload) => {
    const result = await applyTag('graph/tag-remove', deps, payload.roomId, (snapshot) =>
      removeRoomTag(snapshot, payload.roomId, payload.tag),
    );
    if (!result.ok) return result;
    return {
      ok: true as const,
      value: { command: 'graph/tag-remove' as const, tags: result.value.tags },
    };
  };

  return {
    addChildTopics: (payload) => runChildrenAdd(deps, payload),
    addCrossLink: (payload) => runCrossLinkAdd(deps, payload),
    reparentRoom: (payload) => runReparentRoom(deps, payload),
    removeRoom: (payload) => runRemoveRoom(deps, payload),
    setRoomTags: setTags,
    addRoomTag: addTag,
    removeRoomTag: removeTag,
    // Both entry points reach the same runner for each command, so `dispatch` and
    // the named methods cannot drift apart: one implementation per command, named
    // above the switch.
    dispatch: (command) => {
      switch (command.type) {
        case 'graph/children-add':
          return runChildrenAdd(deps, command.payload);
        case 'graph/cross-link-add':
          return runCrossLinkAdd(deps, command.payload);
        case 'graph/room-reparent':
          return runReparentRoom(deps, command.payload);
        case 'graph/room-remove':
          return runRemoveRoom(deps, command.payload);
        case 'graph/tags-set':
          return setTags(command.payload);
        case 'graph/tag-add':
          return addTag(command.payload);
        case 'graph/tag-remove':
          return removeTag(command.payload);
        default: {
          // Structural exhaustiveness rather than an incidental one: adding a
          // `graph/*` command to the payload map without a runner here fails
          // `npm run typecheck` at this line, instead of silently returning
          // `undefined` to a caller that awaited it.
          const unhandled: never = command;
          return unhandled;
        }
      }
    },
  };
}
