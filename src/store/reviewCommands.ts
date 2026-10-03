/**
 * Store binding for the Archaeologist review commands.
 *
 * The controller itself is renderer-neutral and store-free
 * (`src/application/reviewCommands.ts`). This module is the only place the two
 * meet: it binds the subject-store and progression ports to `useSubjectStore` and
 * `useProgressionStore`, and exposes one ready-made controller, so a DOM surface
 * can dispatch a `review/*` command without knowing that a Zustand store exists.
 *
 * Deliberately *not* a rewrite of the store's own actions. `recordReviewPass` and
 * `awardReviewPass` are called exactly as the Phase 14 rollback lane and the
 * existing tests call them. The only new behaviour is the `ReviewPassRewardIdentity`
 * the command supplies to `awardReviewPass`, which is additive and ignored by
 * callers that do not supply it.
 *
 * **Artifact pickup is not here**, for the same reason it is absent from
 * `src/application/encounterCommands.ts`'s command block: `studyFlowController.collectArtifact`
 * owns it, it is already idempotent per `${dungeonId}:${roomId}`, and a second
 * implementation is the drift this layer exists to remove.
 *
 * No renderer imports.
 */
import {
  createReviewController,
  type ReviewCommandDeps,
  type ReviewProgressionPort,
  type ReviewSubjectStorePort,
} from '@/application/reviewCommands';
import type { InterruptedReviewSessionWrite } from '@/core/review/interruptedReviewSession';
import { useProgressionStore } from './progressionStore';
import { useSubjectStore } from './subjectStore';

/** The subject store, as the review controller is allowed to see it. */
export const reviewSubjectStorePort: ReviewSubjectStorePort = {
  readSnapshot: () => useSubjectStore.getState().snapshot,
  recordReviewPass: (roomId, qualityRating) =>
    useSubjectStore
      .getState()
      .recordReviewPass(roomId, qualityRating),
};

/** The reward transaction and the durable marker store, as the controller sees them. */
export const reviewProgressionPort: ReviewProgressionPort = {
  awardReviewPass: (review) => useProgressionStore.getState().awardReviewPass(review),
  readPreservedFields: () => useProgressionStore.getState().readProgressionPreservedFields(),
  writeReviewSession: (write: InterruptedReviewSessionWrite) =>
    useProgressionStore.getState().writeReviewSession(write),
};

/** The controller's dependencies, assembled from the two ports. */
const reviewDeps: ReviewCommandDeps = {
  subject: reviewSubjectStorePort,
  progression: reviewProgressionPort,
  nowIso: () => new Date().toISOString(),
};

/**
 * The review controller, wired to the real stores.
 *
 * @example
 * ```ts
 * const result = reviewController.passComplete({ roomId, qualityRating: 4 });
 * if (!result.ok) setError(result.error.message);
 * else if (result.value.progression.awarded) showReward(result.value.progression.xpGained);
 * ```
 */
export const reviewController = createReviewController(reviewDeps);
