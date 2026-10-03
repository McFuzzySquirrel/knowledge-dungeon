/**
 * The rollback lane **awards**, and is still deduplicated.
 *
 * ## Why this file exists
 *
 * `tests/phase16/review-rollback.test.tsx` proves the rollback build *renders* the pre-Phase-16
 * `notes` tab and that its one control is wired to `onClose`. It stops there, which leaves the
 * question a rollback actually has to answer unanswered: **if a learner on the flag-off build
 * presses "Done reviewing", does the review still finalize, does XP still arrive, and is the
 * award still once-per-(room, pass)?**
 *
 * That is the claim Phase 16's own Rollback line rests on - "Use the previous Archaeologist panel
 * and Phaser scene while retaining the command layer" - and it is a claim about *behaviour*, not
 * about markup.
 *
 * ## The lane, stated precisely, because "the rollback lane" names two different things
 *
 * 1. **`VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=false`** - the build-time cutover gate. This is what
 *    "the rollback" means for this phase. On it, `RoomPanel`'s `notes` tab renders the
 *    pre-Phase-16 view. **This lane still supplies a review identity and is still deduplicated**,
 *    because "Done reviewing" calls nothing but `onClose`, which is
 *    `flow.closeInfoPanel` -> `finalizePendingReview` -> `review.passComplete`, and
 *    `review/pass-complete` derives the identity itself before it reaches the store. The two
 *    lanes differ in which *view* is rendered, not in whether an award is keyed.
 *
 * 2. **A caller that invokes `progressionStore.awardReviewPass()` with no argument.** That path
 *    *is* unconditional - `awardReviewPass` treats a missing identity as "award it" - and it is
 *    the deliberate backwards-compatibility carve-out the store documents. No `src/` call site
 *    takes it any more: all four forward the identity
 *    (`GameScreen.tsx`, `village/villageStudyFlow.ts`, `store/reviewCommands.ts`, and
 *    `application/studyFlow.ts`). This file pins (1) and asserts (2)'s existence separately, so
 *    the two facts cannot be reported as one.
 *
 * Hermeticity: no renderer, no canvas, no network, no `dist/`, no clock. Synthetic ids only.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    // The production default, stated explicitly: this suite is the evidence that the shipping
    // build is the rollback build.
    runtimeConfig: { ...actual.runtimeConfig, archaeologistReviewWorkspace: false },
  };
});

import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { createStudyFlowController } from '@/application/studyFlow';
import { readReviewPassRewardLedgerFromFields } from '@/core/review';
import { RoomPanel } from '@/ui/components/RoomPanel';
import {
  FIXTURE_DUNGEON_ID,
  buildReviewFixture,
  withEveryRoomCleared,
  type ReviewFixture,
} from './support/reviewFixtures';

let fixture: ReviewFixture;

function snapshot() {
  const live = useSubjectStore.getState().snapshot;
  if (live === null) throw new Error('No snapshot installed');
  return live;
}

beforeEach(() => {
  window.localStorage.clear();
  fixture = buildReviewFixture();
  useSubjectStore.setState({
    snapshot: withEveryRoomCleared(fixture.snapshot),
    lastError: null,
  });
  useSessionStore.setState({
    phase: 'archaeologist',
    activeScreen: 'game',
    focusedRoomId: fixture.matrixRoomId,
  });
  // `activeSubjectId: null` so `setActiveSubject` seeds a *fresh* progression record and the
  // review ledger starts empty; `setActiveSubject` deliberately keeps an existing record.
  useProgressionStore.setState({
    activeSubjectId: null,
    bySubject: {},
    crossSubjectAchievements: [],
    collectedNotes: [],
  });
  useProgressionStore.getState().setActiveSubject(FIXTURE_DUNGEON_ID);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The ledger as the store holds it right now. */
function ledgerEntryCount(): number {
  return readReviewPassRewardLedgerFromFields(
    useProgressionStore.getState().readProgressionPreservedFields(),
  ).entries.length;
}

describe('the rollback lane still finalizes and still awards', () => {
  it('closes the panel through the flow, which finalizes and awards exactly once', async () => {
    const toasts: string[] = [];
    const flow = createStudyFlowController({
      store: {
        getSnapshot: () => useSubjectStore.getState().snapshot,
        getPhase: () => useSessionStore.getState().phase,
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
        // The identity-carrying binding, verbatim from `GameScreen.tsx`. The rollback lane's
        // reward travels through this and nothing else.
        awardReviewPass: (review) => useProgressionStore.getState().awardReviewPass(review),
        awardBadge: vi.fn(),
        readProgressionBadges: () => useProgressionStore.getState().badges,
        recordReviewPass: (roomId, qualityRating) =>
          useSubjectStore.getState().recordReviewPass(roomId, qualityRating),
        readProgressionPreservedFields: () =>
          useProgressionStore.getState().readProgressionPreservedFields(),
        writeReviewSession: (write) => useProgressionStore.getState().writeReviewSession(write),
      },
      renderer: { setFloorVisibility: vi.fn(), teleportToRoom: vi.fn() },
      teleport: { remainingMs: () => 0, markConsumed: vi.fn() },
      dungeonUi: {
        pushToast: (kind: string, message: string) => {
          toasts.push(`${kind}: ${message}`);
        },
        requestRoomPanelTab: vi.fn(),
        setInfoPanelOpen: vi.fn(),
        isInfoPanelOpen: () => false,
        clearNpcDialog: vi.fn(),
        openJournalForCollectedNote: vi.fn(),
        getCurrentFloorId: () => null,
        setCurrentFloorId: vi.fn(),
      },
    });

    expect(useProgressionStore.getState().xpTotal).toBe(0);
    expect(ledgerEntryCount()).toBe(0);

    // The two steps the rollback lane's own control performs: open the panel for the room,
    // then close it. `roomInteract` is what arms the review; `closeInfoPanel` finalizes it.
    flow.roomInteract(fixture.matrixRoomId);
    flow.closeInfoPanel();

    await vi.waitFor(() => {
      expect(useProgressionStore.getState().xpTotal).toBeGreaterThan(0);
    });
    // `REVIEW_PASS_XP` in `src/store/progressionStore.ts`, with no equip bonus.
    expect(useProgressionStore.getState().xpTotal).toBe(6);
    expect(useProgressionStore.getState().reviewPasses).toBe(1);
    // The award is durable, not just an in-memory increment: the ledger carries it.
    expect(ledgerEntryCount()).toBe(1);
    expect(toasts.some((entry) => entry.startsWith('info: Review recorded (+6 XP)'))).toBe(true);
    // And the SM-2 half ran at the documented panel-close rating.
    await vi.waitFor(() => {
      const room = useSubjectStore.getState().snapshot?.rooms[fixture.matrixRoomId];
      expect(room?.reviewPassCount).toBe(1);
    });
    expect(useSubjectStore.getState().snapshot?.rooms[fixture.matrixRoomId]?.sm2QualityResponse).toBe(
      3,
    );
  });

  it('is still once-per-(room, pass) on a second close in the same pass', async () => {
    const flow = createStudyFlowController({
      store: {
        getSnapshot: () => useSubjectStore.getState().snapshot,
        getPhase: () => useSessionStore.getState().phase,
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
        awardReviewPass: (review) => useProgressionStore.getState().awardReviewPass(review),
        awardBadge: vi.fn(),
        readProgressionBadges: () => useProgressionStore.getState().badges,
        recordReviewPass: (roomId, qualityRating) =>
          useSubjectStore.getState().recordReviewPass(roomId, qualityRating),
        readProgressionPreservedFields: () =>
          useProgressionStore.getState().readProgressionPreservedFields(),
        writeReviewSession: (write) => useProgressionStore.getState().writeReviewSession(write),
      },
      renderer: { setFloorVisibility: vi.fn(), teleportToRoom: vi.fn() },
      teleport: { remainingMs: () => 0, markConsumed: vi.fn() },
      dungeonUi: {
        pushToast: vi.fn(),
        requestRoomPanelTab: vi.fn(),
        setInfoPanelOpen: vi.fn(),
        isInfoPanelOpen: () => false,
        clearNpcDialog: vi.fn(),
        openJournalForCollectedNote: vi.fn(),
        getCurrentFloorId: () => null,
        setCurrentFloorId: vi.fn(),
      },
    });

    flow.roomInteract(fixture.matrixRoomId);
    flow.closeInfoPanel();
    flow.roomInteract(fixture.matrixRoomId);
    flow.closeInfoPanel();
    await vi.waitFor(() => {
      expect(useProgressionStore.getState().xpTotal).toBeGreaterThan(0);
    });

    /*
     * The reviewable-room count is 3 and one of them has one review, so
     * `trunc(1/3) = 0` full passes and `nextPassTarget` is still 1. The second close
     * therefore derives the *same* `(room, 1)` pair, and the ledger suppresses it.
     *
     * This is the assertion the plan's Rollback line needs and that no existing Phase 16
     * test makes: the rollback lane is not merely "still rendering", it is "still
     * awarded once", which is only true because it goes through `review/pass-complete`.
     */
    expect(useProgressionStore.getState().xpTotal).toBe(6);
    expect(useProgressionStore.getState().reviewPasses).toBe(1);
    expect(ledgerEntryCount()).toBe(1);
  });

  it('the identity-less store call is unconditional, and no src call site takes it', async () => {
    /*
     * The carve-out, stated as a fact about the store rather than as an assumption.
     *
     * `progressionStore.awardReviewPass(undefined)` awards unconditionally: no identity means
     * no `(room, pass)` to key on, so `decideReviewPassReward` is never consulted. This is the
     * deliberate backwards-compatibility path the store's own header documents.
     *
     * It is pinned here for one reason: so that "the rollback lane cannot be awarded twice"
     * is a claim about a *lane* (which goes through `review/pass-complete` and is keyed) and
     * not a claim about the *store* (which is not keyed on this path). Conflating them is how a
     * later phase would come to believe its own rollback was double-paying.
     */
    useProgressionStore.getState().awardReviewPass();
    useProgressionStore.getState().awardReviewPass();

    expect(useProgressionStore.getState().xpTotal).toBe(12);
    expect(ledgerEntryCount()).toBe(0);
  });

  it('the pre-Phase-16 Done reviewing button is the close route and nothing else', () => {
    const onClose = vi.fn();
    render(
      <RoomPanel
        snapshot={snapshot()}
        focusedRoom={snapshot().rooms[fixture.matrixRoomId] ?? null}
        onInteract={() => {}}
        onClose={onClose}
        onTravelToRoom={() => {}}
        reviewPassesCompleted={0}
        reviewRoomsTowardNextPass={0}
        reviewNextPassTarget={1}
        reviewTotalRooms={3}
      />,
    );

    // Proves the branch: the redesigned workspace is not in the tree at all, so the button
    // found here can only be the pre-Phase-16 one.
    expect(document.getElementById('archaeologist-pass-complete')).toBeNull();
    expect(screen.getByRole('button', { name: 'Done reviewing' })).toBeInTheDocument();

    screen.getByRole('button', { name: 'Done reviewing' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});