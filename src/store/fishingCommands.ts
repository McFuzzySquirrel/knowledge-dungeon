/**
 * Store binding for the Fisher's Rest fishing commands.
 *
 * The controller itself is renderer-neutral and store-free
 * (`src/application/fishingCommands.ts`). This module is the only place the two meet:
 * it binds the subject store and the progression store to the ports
 * `createFishingController` needs, and exposes one ready-made controller, so a DOM
 * surface or a Pixi world can dispatch a `fishing/*` command without knowing that a
 * Zustand store exists.
 *
 * ## The session lives with the caller, deliberately
 *
 * `FishingSessionPort.readSession` reads a `FishingContext` the **caller** holds, not
 * one this module keeps in a closure. Three reasons, and the third is the one that
 * matters most:
 *
 * 1. The controller is then a pure function of its ports, so a test can drive a
 *    mismatch case that no real UI would produce.
 * 2. A renderer and a DOM surface at the same time - which is exactly the rollback
 *    window, `VITE_PIXI_FISHING` flipping while a pond is open - cannot disagree about
 *    which session they are in, because there is only one place that holds it.
 * 3. **A closure-held session would make the subject-context enforcement untestable.**
 *    `isSameFishingSubject` exists to catch a step that re-derived a different subject,
 *    and the only way a test can produce that is to hand the command a context that
 *    disagrees with the one it is committed against.
 *
 * So `fishingSessionPortFrom` is the exported seam: a caller builds its own port from
 * whatever holds its session, and `openFishingSession` is the convenience for the
 * common case of a single mutable slot.
 *
 * ## The subject snapshot is the caller's to load
 *
 * `FishingSubjectPort.readSnapshot` returns a snapshot the caller has already loaded,
 * for the subject the **session** names. This binding passes the subject store's
 * loaded snapshot and returns `null` when the subject is not the loaded one, rather
 * than loading anything: the application layer must not reach for a subject other than
 * the session's, and a load is async where the command layer is synchronous.
 *
 * A caller that has a snapshot in hand for the session's subject should build its own
 * port instead of using this one, which is why `FishingCommandDeps` is exported.
 *
 * ## Deliberately not here
 *
 * - **Nothing for the Phaser `FishingScene`.** It keeps calling `addFish`,
 *   `awardFishingXp`, and `checkFishingBadges` through `VillageScreen`, unchanged.
 *   That is the Phase 17 rollback lane, and rewiring it would make the rollback a
 *   behaviour change.
 * - **Nothing that mints ids.** `mintSessionId` defaults to `crypto.randomUUID()`,
 *   which is opaque and app-minted. A test injects a constant instead.
 *
 * No renderer imports.
 */
import {
  createFishingController,
  type CatchCommitOutcome,
  type FishingCommandDeps,
  type FishingProgressionPort,
  type FishingSessionPort,
  type FishingSubjectPort,
} from '@/application/fishingCommands';
import type { FishingContext } from '@/core/fishing/fishingContext';
import type { CatchDeclinedOutcome, CatchOutcome } from '@/core/fishing/catchRewards';
import type { FishCatalogEntry } from '@/core/fishing/fishingTypes';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import { useProgressionStore } from './progressionStore';
import { useSubjectStore } from './subjectStore';

// ── Session ──────────────────────────────────────────────────────────────────

/**
 * A session port over a mutable holder.
 *
 * The holder is the caller's: a `useRef` in a React surface, a field on a Pixi
 * controller, or a plain variable in a test.
 */
export function fishingSessionPortFrom(
  holder: { current: FishingContext | null },
): FishingSessionPort {
  return { readSession: () => holder.current };
}

/** A single-slot session holder, for the common one-pond-at-a-time case. */
const openSession: { current: FishingContext | null } = { current: null };

/**
 * The session port, over a module-level single slot.
 *
 * Correct as long as one pond is open at a time, which is what the application allows
 * - `fishing/enter` swaps the world and `fishing/exit` tears it down. A host that can
 * hold two ponds at once should use {@link fishingSessionPortFrom}.
 */
export const fishingSessionPort: FishingSessionPort = {
  readSession: () => openSession.current,
};

/**
 * The open session's context, and the setter for it.
 *
 * Exported so a surface can clear the slot when its pond unmounts: leaving a stale
 * context behind would let a command after the pond closed commit against a subject
 * the learner is no longer in, and the mismatch refusal would not fire because there
 * would be nothing to disagree with it.
 */
export const fishingSessionSlot = openSession;

// ── Subject ──────────────────────────────────────────────────────────────────

/**
 * The subject store, as the controller is allowed to see it.
 *
 * Returns the loaded snapshot **only when it belongs to `subjectId`**. A snapshot of a
 * different subject is reported as absent rather than returned, because the controller
 * would otherwise draw eligibility and recall material from a subject the session did
 * not name - the defect, one layer down, rather than the one this module removes.
 *
 * `null` for an unloaded subject means `clearedRoomCount: 0`, which
 * `isFishingEligible` reports as ineligible: a subject whose snapshot has not loaded
 * cannot fish. That is the safe direction, and it is what the rollback lane's
 * "Defeat encounters in the nearby dungeon to unlock fish here" already says.
 */
export const fishingSubjectPort: FishingSubjectPort = {
  readSnapshot: (subjectId) => {
    const snapshot = useSubjectStore.getState().snapshot;
    if (!snapshot || snapshot.dungeon.dungeonId !== subjectId) return null;
    return snapshot as SubjectSnapshot;
  },
};

// ── Progression ──────────────────────────────────────────────────────────────

/**
 * The reward transaction and the durable ledger, as the controller sees them.
 *
 * `readPreservedFields` takes the **session's** subject id and passes it through, so
 * the ledger the command layer reads is the ledger of the subject the catch will be
 * written to. `readProgressionPreservedFields` on the store takes no argument and
 * reads the *active* subject; using it here would reintroduce the mismatch the
 * controller just refused to allow.
 */
export const fishingProgressionPort: FishingProgressionPort = {
  readPreservedFields: (subjectId) => {
    const state = useProgressionStore.getState();
    return state.bySubject[subjectId]?.extraFields;
  },
  commitCatch: (input): CatchCommitOutcome => {
    const outcome = useProgressionStore.getState().recordCatch({
      subjectId: input.subjectId,
      identity: input.identity,
      outcome: input.outcome as CatchOutcome | CatchDeclinedOutcome,
      catalogEntry: input.catalogEntry as FishCatalogEntry,
      subjectName: input.subjectName,
      recallRoomId: input.recallRoomId,
    });
    return {
      awarded: outcome.awarded,
      duplicate: outcome.duplicate,
      xpGained: outcome.xpGained,
      newRank: outcome.newRank,
      rankChanged: outcome.rankChanged,
      unlockedBadges: outcome.unlockedBadges,
      fishEntryId: outcome.fishEntryId,
    };
  },
};

// ── Controller ───────────────────────────────────────────────────────────────

/** The controller's dependencies, assembled from the three ports. */
export const fishingCommandDeps: FishingCommandDeps = {
  session: fishingSessionPort,
  subject: fishingSubjectPort,
  progression: fishingProgressionPort,
  nowIso: () => new Date().toISOString(),
  mintSessionId: () => crypto.randomUUID(),
};

/**
 * The fishing controller, wired to the real stores.
 *
 * @example
 * ```ts
 * const begun = fishingController.sessionBegin({ pondId, subjectId, subjectName });
 * if (!begun.ok) return setError(begun.error.message);
 * fishingSessionSlot.current = begun.value.context;
 *
 * const kept = fishingController.catchKeep({
 *   subject: toFishingSubjectContext(begun.value.context),
 *   castNumber,
 *   catalogId,
 *   recall: { kind: 'answered-correct', roomId },
 * });
 * if (kept.ok && kept.value.progression?.awarded) announce(kept.value.progression.xpGained);
 * ```
 */
export const fishingController = createFishingController(fishingCommandDeps);