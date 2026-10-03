/**
 * Phase 16: the study flow's review routes.
 *
 * `tests/contracts/phase-2-study-flow.test.ts` pins the flow's shape and its toast
 * copy. This file pins the four behaviours Phase 16 changed:
 *
 * - the unlock is **enforced** where the review is armed, using the one shared
 *   evaluation, and a locked room gets a refusal sentence rather than a silent
 *   no-op;
 * - the durable (room, pass) ledger is what stops a second finalize paying;
 * - leaving with a review open **saves** it instead of dropping it, and the
 *   marker outlives the controller;
 * - resume and discard reach the same command layer the workspace uses.
 *
 * ## What these fakes can and cannot prove
 *
 * The store port here is a hand-written fake, so this file can only ever prove what the
 * **flow** decides: which route ran, in what order, with which rating, and what it told the
 * learner. Everything inside the store's award transaction - the marker clear, the
 * awarded-once decision against a real ledger - is proved against the real stores in
 * `tests/phase16/reviewCommandStoreBinding.test.ts`,
 * `tests/phase16/review-rollback-award.test.tsx`, and
 * `tests/phase16/panelCloseAfterExplicitReview.test.ts`. A test here that appears to assert
 * one of those is asserting the fake, so those assertions do not live here.
 *
 * Fixtures are obviously synthetic throughout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStudyFlowController,
  type StudyFlowController,
  type StudyFlowDeps,
  type StudyFlowPhase,
} from '@/application/studyFlow';
import {
  readInterruptedReviewSessionFromFields,
  type InterruptedReviewSessionWrite,
} from '@/core/review/interruptedReviewSession';
import { deriveReviewPassIdentity } from '@/core/review/reviewPassRewards';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';

const SUBJECT_ID = 'synthetic-flow-subject';
const ROOM_A = 'synthetic-flow-room-a';
const ROOM_B = 'synthetic-flow-room-b';
const ROOM_C = 'synthetic-flow-room-c';
const NOW = '2026-06-06T06:06:06.000Z';

function room(
  roomId: string,
  overrides: {
    finalPass?: boolean;
    state?: string;
    reviewPassCount?: number;
    artifactMarkdown?: string | null;
  } = {},
): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: (overrides.state ?? 'ArtifactCollected') as RoomMetadata['state'],
    validationState: { ...makeEmptyValidationState(), finalPass: overrides.finalPass ?? true },
    reviewPassCount: overrides.reviewPassCount ?? 0,
    artifactMarkdown:
      overrides.artifactMarkdown === undefined
        ? `# Synthetic Artifact ${roomId}`
        : overrides.artifactMarkdown,
  };
}

function dungeon(roomIds: readonly string[]): DungeonMetadata {
  return {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT_ID,
    subjectName: 'Synthetic Flow Subject',
    createdAt: NOW,
    updatedAt: NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: roomIds[0] ?? 'synthetic-root',
    rooms: roomIds.map((roomId) => ({
      roomId,
      topic: `synthetic-topic-${roomId}`,
      status: 'ArtifactCollected' as const,
    })),
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice' as const, badges: [], fishCollection: [] },
  };
}

interface Fake {
  deps: StudyFlowDeps;
  flow: StudyFlowController;
  store: Record<string, ReturnType<typeof vi.fn>>;
  dungeonUi: Record<string, ReturnType<typeof vi.fn>>;
  state: {
    phase: StudyFlowPhase;
    snapshot: SubjectSnapshot | null;
    /** The one progression record, mutated in place like a real store record. */
    record: { xpTotal: number; extraFields: Record<string, unknown> | undefined };
    sm2Calls: Array<{ roomId: string; qualityRating: number | undefined }>;
    /** Set to false to simulate a host that did not bind the marker port. */
    markerPortBound: boolean;
  };
}

function ledgerEntries(
  record: Fake['state']['record'],
): Array<{ roomId: string; passNumber: number }> {
  const raw = record.extraFields?.reviewPassRewardLedger as
    | { entries?: Array<{ roomId: string; passNumber: number }> }
    | undefined;
  return raw?.entries ?? [];
}

function createFake(snapshot: SubjectSnapshot | null): Fake {
  const state: Fake['state'] = {
    phase: 'archaeologist',
    snapshot,
    record: { xpTotal: 0, extraFields: undefined },
    sm2Calls: [],
    markerPortBound: true,
  };

  const store: Record<string, ReturnType<typeof vi.fn>> = {
    getSnapshot: vi.fn(() => state.snapshot),
    getPhase: vi.fn(() => state.phase),
    persistActiveSubjectId: vi.fn(),
    setFocusedRoomId: vi.fn(),
    setActiveSubjectId: vi.fn(),
    setActiveScreen: vi.fn(),
    openNoteEditor: vi.fn(),
    closeMapView: vi.fn(),
    cancelTeleportMode: vi.fn(),
    setMobileHudOpen: vi.fn(),
    setProgressionActiveSubject: vi.fn(),
    collectArtifactNote: vi.fn(() => true),
    awardReviewPass: vi.fn((review?: { roomId: string; passNumber: number }) => {
      if (review === undefined) {
        // The documented pre-Phase-16 lane.
        state.record.xpTotal += 6;
        return { xpGained: 6 };
      }
      if (ledgerEntries(state.record).some((e) => e.roomId === review.roomId && e.passNumber === review.passNumber)) {
        return { xpGained: 0, awarded: false, duplicate: true };
      }
      state.record.extraFields = {
        ...(state.record.extraFields ?? {}),
        reviewPassRewardLedger: {
          version: 1,
          entries: [
            { ...review, reviewIdentity: deriveReviewPassIdentity(review), awardedAt: NOW },
            ...ledgerEntries(state.record),
          ],
        },
      };
      /*
       * The store clears this room's marker in the same record write as the award, and this
       * fake has to as well - the flow does not clear the marker itself, so a fake that left
       * it behind would report a completed review as still resumable and every downstream
       * assertion about the marker would be about the fake.
       *
       * **No test in this file asserts that clear.** It is fidelity, not coverage: the
       * behaviour is a property of `progressionStore.awardReviewPass`, and it is pinned
       * against the real store by `tests/phase16/reviewCommandStoreBinding.test.ts`
       * ("a saved marker is removed when the same review is completed") and by
       * `tests/phase16/panelCloseAfterExplicitReview.test.ts`. An earlier version of this file
       * asserted it here, which looked like coverage of the store and was coverage of the four
       * lines below.
       */
      const fields: Record<string, unknown> = { ...state.record.extraFields };
      delete fields.interruptedReviewSession;
      state.record.extraFields = fields;
      state.record.xpTotal += 6;
      return { xpGained: 6, awarded: true, duplicate: false };
    }),
    awardBadge: vi.fn(),
    readProgressionBadges: vi.fn((): readonly string[] => []),
    recordReviewPass: vi.fn((roomId: string, qualityRating?: number) => {
      state.sm2Calls.push({ roomId, qualityRating });
      return Promise.resolve();
    }),
    readProgressionPreservedFields: vi.fn(() => state.record.extraFields),
    writeReviewSession: vi.fn((write: InterruptedReviewSessionWrite) => {
      if (!state.markerPortBound) return;
      const before = readInterruptedReviewSessionFromFields(state.record.extraFields);
      if (write.kind === 'save') {
        state.record.extraFields = {
          ...(state.record.extraFields ?? {}),
          interruptedReviewSession: write.session,
        };
        return;
      }
      if (before !== null && before.roomId === write.roomId) {
        const fields: Record<string, unknown> = { ...state.record.extraFields };
        delete fields.interruptedReviewSession;
        state.record.extraFields = fields;
      }
    }),
  };

  const dungeonUi: Record<string, ReturnType<typeof vi.fn>> = {
    pushToast: vi.fn(),
    requestRoomPanelTab: vi.fn(),
    setInfoPanelOpen: vi.fn(),
    isInfoPanelOpen: vi.fn(() => false),
    clearNpcDialog: vi.fn(),
    openJournalForCollectedNote: vi.fn(),
    getCurrentFloorId: vi.fn(() => null),
    setCurrentFloorId: vi.fn(),
  };

  return {
    deps: {
      store: store as unknown as StudyFlowDeps['store'],
      renderer: { setFloorVisibility: vi.fn(), teleportToRoom: vi.fn() },
      teleport: { remainingMs: vi.fn(() => 0), markConsumed: vi.fn() },
      dungeonUi: dungeonUi as unknown as StudyFlowDeps['dungeonUi'],
    } as StudyFlowDeps,
    flow: createStudyFlowController({
      store: store as unknown as StudyFlowDeps['store'],
      renderer: { setFloorVisibility: vi.fn(), teleportToRoom: vi.fn() },
      teleport: { remainingMs: vi.fn(() => 0), markConsumed: vi.fn() },
      dungeonUi: dungeonUi as unknown as StudyFlowDeps['dungeonUi'],
    }),
    store,
    dungeonUi,
    state,
  };
}

/** Every room cleared, so the unlock ratio of 1 is satisfied. */
function fullyCleared(): SubjectSnapshot {
  return {
    dungeon: dungeon([ROOM_A, ROOM_B, ROOM_C]),
    rooms: { [ROOM_A]: room(ROOM_A), [ROOM_B]: room(ROOM_B), [ROOM_C]: room(ROOM_C) },
  };
}

/** One room cleared out of three: review is displayed as locked. */
function partiallyCleared(): SubjectSnapshot {
  return {
    dungeon: dungeon([ROOM_A, ROOM_B, ROOM_C]),
    rooms: {
      [ROOM_A]: room(ROOM_A),
      [ROOM_B]: room(ROOM_B, { finalPass: false, state: 'Created' }),
      [ROOM_C]: room(ROOM_C, { finalPass: false, state: 'Created' }),
    },
  };
}

let fake: Fake;

beforeEach(() => {
  fake = createFake(fullyCleared());
});

// ── Enforcement ─────────────────────────────────────────────────────────────

describe('study flow - review unlock enforcement', () => {
  it('arms and finalizes a review in a dungeon the unlock has reached', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();

    expect(fake.store.recordReviewPass).toHaveBeenCalledTimes(1);
    expect(fake.store.awardReviewPass).toHaveBeenCalledTimes(1);
    // The identity is what makes the award durable.
    expect(fake.store.awardReviewPass).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM_A, passNumber: 1 }),
    );
  });

  it('does not arm a review while the unlock is locked, and says why', () => {
    fake = createFake(partiallyCleared());

    fake.flow.roomInteract(ROOM_A);

    // The panel still opens - a learner must be able to read their own notes.
    expect(fake.dungeonUi.setInfoPanelOpen).toHaveBeenCalledWith(true);
    // And the refusal is a sentence, not a silent no-op.
    expect(fake.dungeonUi.pushToast).toHaveBeenCalledWith(
      'warn',
      'Review unlocks at 3/3 rooms cleared (1 so far).',
    );
  });

  it('records nothing on close for a locked dungeon', () => {
    fake = createFake(partiallyCleared());

    fake.flow.roomInteract(ROOM_A);
    fake.store.recordReviewPass.mockClear();
    fake.flow.closeInfoPanel();

    expect(fake.store.recordReviewPass).not.toHaveBeenCalled();
    expect(fake.store.awardReviewPass).not.toHaveBeenCalled();
  });

  it('the refusal is enforced on finalize too, not only on arm', () => {
    // Arm while the dungeon is unlocked, so the flow holds a review worth finalizing.
    fake.flow.roomInteract(ROOM_A);
    fake.store.recordReviewPass.mockClear();
    fake.store.awardReviewPass.mockClear();
    fake.dungeonUi.pushToast.mockClear();

    // The dungeon's ratio drops between arming and finalizing. `ROOM_A` has never been
    // completed, so there is no (room, pass) ledger entry and no duplicate for the ledger to
    // suppress - the only thing that can stop this award is the unlock.
    fake.state.snapshot = partiallyCleared();
    fake.flow.closeInfoPanel();

    expect(fake.store.recordReviewPass).not.toHaveBeenCalled();
    expect(fake.store.awardReviewPass).not.toHaveBeenCalled();
    expect(fake.state.record.xpTotal).toBe(0);
    expect(ledgerEntries(fake.state.record)).toHaveLength(0);

    /*
     * The sentence is the load-bearing assertion, and it is what this test is actually
     * about. `finalizePendingReview` asks `canReviewRoom` itself and reports
     * `describeReviewRefusal`; the command layer's own refusal reports the typed
     * `REVIEW_LOCKED` condition instead, which is a *different* sentence. So this pins the
     * flow's copy of the check: delete the `canReviewRoom` call from `finalizePendingReview`
     * and the command layer still refuses and still records nothing, but the learner is told
     * a different thing and this assertion fails. Asserting only "nothing was recorded"
     * would pass either way, which is why the earlier version of this test did.
     */
    expect(fake.dungeonUi.pushToast).toHaveBeenCalledWith(
      'warn',
      'Review unlocks at 3/3 rooms cleared (1 so far).',
    );
    expect(fake.dungeonUi.pushToast).not.toHaveBeenCalledWith(
      'warn',
      'Clear every room encounter to unlock full review mode.',
    );
  });

  it('says the encounter sentence when a passed room is not in a reviewable state', () => {
    // `finalPass` is true, so the flow consults the shared evaluation, and
    // `canReviewRoom` answers `room-not-cleared` before it reaches the ratio.
    fake.state.snapshot = {
      dungeon: dungeon([ROOM_A, ROOM_B]),
      rooms: { [ROOM_A]: room(ROOM_A), [ROOM_B]: room(ROOM_B, { state: 'NotesDrafted' }) },
    };

    fake.flow.roomInteract(ROOM_B);

    expect(fake.dungeonUi.pushToast).toHaveBeenLastCalledWith(
      'warn',
      'Defeat this room encounter before reviewing it.',
    );
  });
});

// ── Durability ──────────────────────────────────────────────────────────────

describe('study flow - the award is once per (room, pass)', () => {
  it('a retried close pays once', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();
    fake.flow.closeInfoPanel();

    expect(fake.state.record.xpTotal).toBe(6);
    expect(ledgerEntries(fake.state.record)).toHaveLength(1);
  });

  it('a reopened panel in the same pass pays once', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();
    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();

    expect(fake.state.record.xpTotal).toBe(6);
    expect(ledgerEntries(fake.state.record)).toHaveLength(1);
  });

  /*
   * What this block deliberately does **not** assert: that the marker is gone after a
   * completion. That is `progressionStore.awardReviewPass`'s own write, it can only be proved
   * against the real store, and it is proved there - in
   * `tests/phase16/reviewCommandStoreBinding.test.ts` and, for the route that motivated it,
   * in `tests/phase16/panelCloseAfterExplicitReview.test.ts`. Asserting it against the fake
   * here would have kept passing with the store's clear deleted.
   */
});

// ── Exit decision ───────────────────────────────────────────────────────────

describe('study flow - exiting during a review', () => {
  it('saves the session instead of dropping it, and says so', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.flow.returnToVillage();

    const marker = readInterruptedReviewSessionFromFields(fake.state.record.extraFields);
    expect(marker?.roomId).toBe(ROOM_A);
    expect(fake.dungeonUi.pushToast).toHaveBeenCalledWith(
      'info',
      'Review saved. Return to this room to finish it, or discard it from the room panel.',
    );
  });

  it('the saved session outlives the controller, so a reload can resume it', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.flow.returnToVillage();

    // A reload: a brand-new controller over the same persisted record.
    const reloaded = createFake(fullyCleared());
    reloaded.state.record = { ...fake.state.record };

    expect(reloaded.flow.readPendingReviewSession()?.roomId).toBe(ROOM_A);
    expect(reloaded.flow.resumePendingReview(ROOM_A)).toBe(true);
  });

  it('records nothing when the learner exits mid-review, so no award is minted', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.store.recordReviewPass.mockClear();
    fake.flow.returnToVillage();

    expect(fake.store.recordReviewPass).not.toHaveBeenCalled();
    expect(fake.store.awardReviewPass).not.toHaveBeenCalled();
    expect(fake.state.record.xpTotal).toBe(0);
  });

  it('a discarded session leaves nothing resumable and awards nothing', () => {
    fake.flow.roomInteract(ROOM_A);

    expect(fake.flow.discardPendingReview(ROOM_A)).toBe(true);

    expect(readInterruptedReviewSessionFromFields(fake.state.record.extraFields)).toBeNull();
    expect(fake.flow.readPendingReviewSession()).toBeNull();
    expect(fake.state.record.xpTotal).toBe(0);
  });

  it('reports false when there was nothing to resume', () => {
    expect(fake.flow.resumePendingReview(ROOM_A)).toBe(false);
    expect(fake.flow.discardPendingReview(ROOM_A)).toBe(false);
  });

  it('keeps the pre-Phase-16 in-memory behaviour on a host with no marker port', () => {
    // The port members are *optional*, so a host that does not bind them still
    // compiles and still reviews - it just loses the interrupted session exactly
    // as it did before Phase 16. `villageStudyFlow.ts` is the one host still in
    // that state.
    const unbound = createFake(fullyCleared());
    delete unbound.store.readProgressionPreservedFields;
    delete unbound.store.writeReviewSession;
    unbound.flow = createStudyFlowController({
      ...unbound.deps,
      store: unbound.store as unknown as StudyFlowDeps['store'],
    });

    unbound.flow.roomInteract(ROOM_A);
    unbound.flow.returnToVillage();

    // Documented limitation: durability needs the marker port, and this lane has
    // none, so the session is lost exactly as it was before Phase 16.
    expect(readInterruptedReviewSessionFromFields(unbound.state.record.extraFields)).toBeNull();
    expect(unbound.dungeonUi.pushToast).not.toHaveBeenCalledWith(
      'info',
      expect.stringContaining('Review saved'),
    );
  });
});

// ── Preserved behaviour ─────────────────────────────────────────────────────

describe('study flow - preserved behaviour', () => {
  it('still records a deferred review only for a room that passed validation', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();
    expect(fake.store.recordReviewPass).toHaveBeenCalledWith(ROOM_A);

    fake.store.recordReviewPass.mockClear();
    fake.state.snapshot = {
      dungeon: dungeon([ROOM_A]),
      rooms: { [ROOM_A]: room(ROOM_A, { finalPass: false, state: 'Created' }) },
    };
    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();
    expect(fake.store.recordReviewPass).not.toHaveBeenCalled();
  });

  it('still drops a pending review when another room is interacted with', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.flow.roomInteract(ROOM_B);
    fake.flow.closeInfoPanel();

    // The marker is the durable form of "which room's panel was open", so the
    // second interaction replaced it and the close finalized B, not A.
    expect(fake.store.recordReviewPass).toHaveBeenCalledWith(ROOM_B);
    expect(fake.store.recordReviewPass).toHaveBeenCalledTimes(1);
  });

  it('still closes the panel before it finalizes the review', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();

    const closeOrder = fake.dungeonUi.setInfoPanelOpen.mock.invocationCallOrder[1];
    const recordOrder = fake.store.recordReviewPass.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(recordOrder);
  });

  it('still keeps the pre-Phase-16 toast copy verbatim', () => {
    fake.state.snapshot = {
      dungeon: dungeon([ROOM_A, ROOM_B, ROOM_C]),
      rooms: { [ROOM_A]: room(ROOM_A), [ROOM_B]: room(ROOM_B), [ROOM_C]: room(ROOM_C) },
    };
    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();

    expect(fake.dungeonUi.pushToast).toHaveBeenCalledWith(
      'info',
      'Review recorded (+6 XP): 1/3 rooms toward pass 1. Completed full passes: 0.',
    );
  });

  it('still evaluates phase badges with the real post-review pass count', () => {
    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();

    expect(fake.store.readProgressionBadges).toHaveBeenCalled();
  });

  it('still never finalizes outside the archaeologist phase', () => {
    fake.state.phase = 'scribe';

    fake.flow.roomInteract(ROOM_A);
    fake.flow.closeInfoPanel();

    expect(fake.store.recordReviewPass).not.toHaveBeenCalled();
    expect(fake.dungeonUi.setInfoPanelOpen).toHaveBeenCalledWith(false);
  });

  it('still collects an artifact and opens the journal', () => {
    fake.flow.collectArtifact(ROOM_A);

    expect(fake.store.collectArtifactNote).toHaveBeenCalledWith(
      expect.objectContaining({ dungeonId: SUBJECT_ID, roomId: ROOM_A }),
    );
    expect(fake.dungeonUi.openJournalForCollectedNote).toHaveBeenCalledWith(`${SUBJECT_ID}:${ROOM_A}`);
  });
});
