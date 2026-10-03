/**
 * Store binding for the Scribe encounter commands.
 *
 * The controller itself is renderer-neutral and store-free
 * (`src/application/encounterCommands.ts`). This module is the only place the two
 * meet: it binds the subject-store and progression ports to `useSubjectStore` and
 * `useProgressionStore`, and exposes one ready-made controller, so a DOM surface
 * can dispatch an `encounter/*` command without knowing that a Zustand store
 * exists.
 *
 * Deliberately *not* a rewrite of the store's own actions. `submitNote`,
 * `addDeviceLocalAttachment`, `addExternalAttachment`, `removeAttachment`,
 * `awardRoomClear`, and `awardBadge` are called exactly as the Phase 14 rollback
 * lane and the existing tests call them, because those paths are the contract
 * this phase must not change. The only new behaviour is the `clear` identity the
 * command supplies to `awardRoomClear`, which is additive and ignored by callers
 * that do not supply it.
 *
 * The artifact-pickup port is a *binding seam* rather than a direct call, because
 * the pickup is owned by whichever world controller is mounted:
 * `studyFlowController.collectArtifact` is per-screen, built inside `GameScreen`
 * from that screen's ports, and it is the implementation that builds the journal
 * entry and opens the journal. A host registers it with
 * {@link bindArtifactCollection}; until then a pickup **rejects** rather than
 * silently resolving, so a Scribe surface can never report "collected" for an
 * action that did not run. A rejection is the honest answer here rather than a typed
 * refusal: the condition is a host that forgot a wiring step, not a condition a
 * learner can be told about, and `EncounterArtifactCollectResult` documents the
 * rejection as part of its contract.
 */
import {
  createEncounterController,
  type EncounterArtifactCollectionPort,
  type EncounterCommandDeps,
  type EncounterProgressionPort,
  type EncounterSubjectStorePort,
} from '@/application/encounterCommands';
import type { ArtifactCollectCommand } from '@/application/contracts/commands';
import { useProgressionStore } from './progressionStore';
import { useSubjectStore } from './subjectStore';

/**
 * The mounted world flow's artifact pickup.
 *
 * `null` until a host binds one. A command that reaches the pickup unbound is
 * refused with a message naming the missing binding, which is a wiring mistake
 * and not a learner-facing condition.
 */
let artifactCollector: ((command: ArtifactCollectCommand) => void | Promise<void>) | null = null;

/**
 * Register (or unregister, with `null`) the mounted world flow's pickup.
 *
 * Called by a host that owns a `studyFlowController`; on unmount it must pass
 * `null` so a later encounter does not dispatch into an unmounted flow.
 */
export function bindArtifactCollection(
  collect: ((command: ArtifactCollectCommand) => void | Promise<void>) | null,
): void {
  artifactCollector = collect;
}

/** The refusal an unbound pickup produces. */
const NO_ARTIFACT_FLOW_MESSAGE = 'No world flow is bound to collect artifacts.';

/** The subject store, as the encounter controller is allowed to see it. */
export const encounterSubjectStorePort: EncounterSubjectStorePort = {
  readSnapshot: () => useSubjectStore.getState().snapshot,
  submitNote: (roomId, noteText, manualConfirmed) =>
    useSubjectStore.getState().submitNote(roomId, noteText, manualConfirmed),
  addDeviceLocalAttachment: (roomId, file) =>
    useSubjectStore.getState().addDeviceLocalAttachment(roomId, file),
  addExternalAttachment: (roomId, url) =>
    useSubjectStore.getState().addExternalAttachment(roomId, url),
  removeAttachment: (roomId, attachmentId) =>
    useSubjectStore.getState().removeAttachment(roomId, attachmentId),
};

/** The reward transaction, as the encounter controller is allowed to see it. */
export const encounterProgressionPort: EncounterProgressionPort = {
  awardRoomClear: (input) => useProgressionStore.getState().awardRoomClear(input),
  awardBadge: (badgeId) => useProgressionStore.getState().awardBadge(badgeId),
};

/**
 * The artifact-pickup port.
 *
 * The controller's port returns void, so an unbound collector is surfaced by
 * throwing rather than being swallowed. The message names the wiring, not the
 * learner: this can only be reached by a host that never bound its world flow.
 */
export const encounterArtifactCollectionPort: EncounterArtifactCollectionPort = {
  collectArtifact(command) {
    if (artifactCollector === null) {
      throw new Error(NO_ARTIFACT_FLOW_MESSAGE);
    }
    return artifactCollector(command);
  },
};

/** The controller's dependencies, assembled from the three ports. */
const encounterDeps: EncounterCommandDeps = {
  subject: encounterSubjectStorePort,
  progression: encounterProgressionPort,
  artifactCollection: encounterArtifactCollectionPort,
  nowIso: () => new Date().toISOString(),
};

/**
 * The Scribe encounter controller, wired to the real stores.
 *
 * @example
 * ```ts
 * const result = await encounterController.dispatch({
 *   type: 'encounter/note-submit',
 *   payload: { roomId, noteText, manualConfirmed: true },
 * });
 * if (!result.ok) setError(result.error.message);
 * else if (result.value.kind === 'draft') showDraftSaved();
 * else if (result.value.progression.awarded) showReward(result.value.progression.xpGained);
 * ```
 */
export const encounterController = createEncounterController(encounterDeps);