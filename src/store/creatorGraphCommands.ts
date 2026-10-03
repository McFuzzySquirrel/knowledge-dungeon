/**
 * Store binding for the Creator graph-mutation commands.
 *
 * The controller itself is renderer-neutral and store-free
 * (`src/application/creatorGraphCommands.ts`). This module is the only place the
 * two meet: it binds the controller's three store ports to `useSubjectStore` and
 * exposes one ready-made controller, so a DOM control can dispatch a `graph/*`
 * command without knowing that a Zustand store exists.
 *
 * Deliberately *not* a rewrite of the store's own graph actions. Those stay
 * exactly as they were, because Phase 14 keeps the existing Creator lane behind
 * `VITE_CREATOR_WORKSPACE` and the flag's rollback is "the old path still
 * works". Collapsing the two copies is the cutover step, not the build step.
 */
import {
  createCreatorGraphController,
  type CreatorGraphController,
  type CreatorGraphStorePort,
} from '@/application/creatorGraphCommands';
import { commitSubjectSnapshot, useSubjectStore } from './subjectStore';

/**
 * Mint a room id.
 *
 * The same shape the store's private `generateId` produces, deliberately: a new
 * lane minting ids the old lane would not produce would make a rollback produce
 * two different graphs from the same click. Uniqueness across two calls in the
 * same millisecond comes from `Math.random`, and nothing downstream depends on
 * an id's shape.
 */
export function createRoomId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `room-${time}-${random}`;
}

/** The controller bound to the real subject store. */
export const creatorGraphStorePort: CreatorGraphStorePort = {
  readSnapshot: () => useSubjectStore.getState().snapshot,
  commit: (snapshot) => commitSubjectSnapshot(snapshot),
  // A refusal writes the domain's own message, exactly as the store's graph
  // actions did, so a surface still reading `lastError` is unaffected by which
  // lane performed the mutation.
  reportFailure: (message) => useSubjectStore.setState({ lastError: message }),
};

/**
 * The Creator graph-mutation controller, wired to the subject store.
 *
 * @example
 * ```ts
 * const result = await creatorGraphController.dispatch({
 *   type: 'graph/children-add',
 *   payload: { parentRoomId, topics: ['Bases', 'Metrics'] },
 * });
 * if (!result.ok) setError(result.error.message);
 * ```
 */
export const creatorGraphController: CreatorGraphController = createCreatorGraphController({
  store: creatorGraphStorePort,
  nowIso: () => new Date().toISOString(),
  newRoomId: createRoomId,
});
