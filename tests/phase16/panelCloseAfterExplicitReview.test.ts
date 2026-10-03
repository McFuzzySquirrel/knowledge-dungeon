/**
 * Phase 16: the panel-close route, after an explicit completion.
 *
 * ## The defect this file exists for
 *
 * `ArchaeologistWorkspace` offers two ways to finish a review of the same room, and the
 * workspace's own copy says so: **"Complete this review pass"** dispatches
 * `review/pass-complete` through the command layer, and **"Done reviewing"** closes the panel,
 * which is `flow.closeInfoPanel` -> `finalizePendingReview` -> `review/pass-complete` at
 * `CLOSED_WITHOUT_RATING_QUALITY`.
 *
 * Both reach the *same* command layer, so a surface can mix them, and the order a learner
 * naturally uses - complete, then close - was reachable and paid twice:
 *
 * 1. `roomInteract(roomId)` arms the review: it sets the flow's in-memory
 *    `pendingReviewRoomId` **and** writes the durable interrupted-review marker.
 * 2. The learner rates 5 and presses "Complete this review pass". That goes straight to
 *    `reviewController.passComplete`, so the flow's `finalizePendingReview` is never told.
 *    `pendingReviewRoomId` is still set, and the marker is gone.
 * 3. The learner closes the panel. `finalizePendingReview` re-derives the pass number from
 *    the *advanced* `reviewPassCount`s. Normally that is the same pass and the
 *    (room, pass) ledger suppresses it - but when step 2 was the room that **completed** the
 *    pass, `fullReviewPasses` has moved, so the close derives pass N+1. The ledger has never
 *    seen N+1, so from its side it is a genuinely new pass and it awards.
 *
 * ## The arithmetic, because the obvious reproduction does *not* fail
 *
 * `fullReviewPasses` is `trunc(sum of reviewPassCount / reviewable rooms)`, and one award adds
 * exactly one to that sum. So the derived pass number moves only when the sum crosses a
 * multiple of the room count. With three rooms, reviewing the *same* room twice cannot move
 * it: the second review re-derives the same pass and the ledger suppresses the close, which
 * is why a same-room repeat is not the defect. The double award needs the explicit completion
 * to be a room that had **not** been reviewed in this pass, with the other rooms already
 * ahead of it, so that the explicit review is the one that crosses the multiple.
 *
 * Confirmed over the real stores with three reviewable rooms - review two rooms (2 awards, 12
 * XP), open the third room's panel, complete it explicitly at 5 (3 awards, 18 XP, pass 1
 * complete), then close the panel:
 *
 * - before the fix: 4 awards, 24 XP, `reviewPassCount` 2 on the third room, ledger carrying
 *   `(roomC, 2)`, and a toast saying so - for a room the learner reviewed once.
 * - after the fix: 3 awards, 18 XP, `reviewPassCount` 1, ledger carrying only pass 1, and no
 *   toast, because the close route has nothing to finalize.
 *
 * That is plan exit criterion 2 for this phase, "Review pass and XP cannot be
 * double-counted", so it is fixed here rather than documented as an option.
 *
 * ## The fix under test
 *
 * `progressionStore.awardReviewPass` already clears the interrupted-review marker **for the
 * room it pays**, in the same record write as the award. So after a genuine completion - or an
 * explicit discard - there is no marker for that room, and `finalizePendingReview` returns
 * early on a durable host. The marker is written by the same call that arms the in-memory
 * arm, which is what makes it the right thing to guard on.
 *
 * ## Why these tests drive the real stores
 *
 * The defect is a disagreement between three things: the flow's in-memory arm, the durable
 * marker, and the store's award transaction. A fake port can be written to agree with
 * whatever the flow does, which is exactly how `tests/phase16/studyFlowReview.test.ts` ended up
 * with a fake that re-implemented the store's marker clear. So this file binds
 * `useSubjectStore`, `useProgressionStore`, and the ready-made `reviewController` to each
 * other, and runs the two routes in the order the UI runs them.
 *
 * The store port is `GameScreen.tsx`'s binding verbatim - the one host that can arm a review -
 * so a green run here is a statement about the shipping host and not about a test-only
 * arrangement. `tests/phase16/review-rollback-award.test.tsx` established that harness.
 *
 * Hermeticity: no renderer, no network, no `dist/`, no clock assertions.
 * `saveSubjectSnapshot` is mocked, so a completed review is an in-memory store update plus the
 * reward transaction and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

import { createStudyFlowController, type StudyFlowController } from '@/application/studyFlow';
import {
  readInterruptedReviewSessionFromFields,
  readReviewPassRewardLedgerFromFields,
} from '@/core/review';
import { useProgressionStore } from '@/store/progressionStore';
import { reviewController } from '@/store/reviewCommands';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import {
  FIXTURE_DUNGEON_ID,
  buildReviewFixture,
  withEveryRoomCleared,
  type ReviewFixture,
} from './support/reviewFixtures';

let fixture: ReviewFixture;
let flow: StudyFlowController;
/** Every `pushToast` the flow made, as `kind: message`. */
let toasts: string[];
/**
 * The fixture's three reviewable rooms, in a fixed order, so "the first room" is a real id.
 *
 * Rebuilt per test rather than appended to a module-level array, so one test's rooms cannot
 * leak into the next one's assertions.
 */
let roomIds: readonly string[];

function progression() {
  return useProgressionStore.getState();
}

function ledgerRoomPasses(): Array<{ roomId: string; passNumber: number }> {
  return readReviewPassRewardLedgerFromFields(
    useProgressionStore.getState().readProgressionPreservedFields(),
  ).entries.map((entry) => ({ roomId: entry.roomId, passNumber: entry.passNumber }));
}

function room(roomId: string) {
  const found = useSubjectStore.getState().snapshot?.rooms[roomId];
  if (found === undefined) throw new Error(`No room ${roomId} in the live snapshot`);
  return found;
}

/** The marker, read the way `flow.readPendingReviewSession()` reads it. */
function marker() {
  return readInterruptedReviewSessionFromFields(
    useProgressionStore.getState().readProgressionPreservedFields(),
  );
}

/**
 * `GameScreen.tsx`'s store binding, verbatim.
 *
 * Every member the review routes touch is the real store action, including the two marker
 * ports - so this controller is a **durable** host, the only kind on which the guard under
 * test exists at all.
 */
function createFlowOverRealStores(): StudyFlowController {
  return createStudyFlowController({
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
}

beforeEach(() => {
  window.localStorage.clear();
  toasts = [];
  fixture = buildReviewFixture();
  roomIds = [fixture.rootRoomId, fixture.matrixRoomId, fixture.eigenRoomId];
  useSubjectStore.setState({ snapshot: withEveryRoomCleared(fixture.snapshot), lastError: null });
  useSessionStore.setState({
    phase: 'archaeologist',
    activeScreen: 'game',
    focusedRoomId: fixture.matrixRoomId,
  });
  // `activeSubjectId: null` first, so `setActiveSubject` seeds a *fresh* progression record and
  // the review ledger starts empty. `setActiveSubject` deliberately keeps an existing one.
  useProgressionStore.setState({
    activeSubjectId: null,
    bySubject: {},
    crossSubjectAchievements: [],
    collectedNotes: [],
  });
  useProgressionStore.getState().setActiveSubject(FIXTURE_DUNGEON_ID);
  flow = createFlowOverRealStores();
});

/**
 * Review every room but the last, so one room is left unreviewed in this pass.
 *
 * This is the state the defect needs, and getting it wrong is what makes the regression test
 * pass for the wrong reason. `fullReviewPasses` is `trunc(sum / totalReviewable)`, and a
 * review adds exactly one to `sum`, so the derived pass number only ever moves when the sum
 * crosses a multiple of the room count. Reviewing the *same* room twice in a row therefore
 * never re-derives a pass, and the close route lands on the same `(room, pass)` the explicit
 * call already paid - which the ledger suppresses. The double award needs the explicit call to
 * be the one that **completed** the pass: the reviewed room has to be one that had not been
 * reviewed in this pass yet, and the other rooms have to be ahead of it.
 */
function completeEveryOtherRoomExplicitly(): void {
  for (const roomId of roomIds.slice(0, -1)) {
    const result = reviewController.passComplete({ roomId, qualityRating: 5 });
    expect(result.ok).toBe(true);
  }
  // Two of three rooms: the pass is not complete, and the derived pass is still 1.
  expect(progression().reviewPasses).toBe(2);
  expect(progression().xpTotal).toBe(12);
}

// ── The regression: explicit completion, then the panel close ────────────────

describe('panel close after an explicit completion', () => {
  it('does not pay a second full pass for a room the learner reviewed once', () => {
    const [roomA, roomB, roomC] = roomIds;
    // `roomC` is the one left unreviewed, so it is the one that completes the pass.
    completeEveryOtherRoomExplicitly();

    // 1. The panel opens. `roomInteract` arms the review: the in-memory arm and the marker.
    flow.roomInteract(roomC);
    expect(flow.readPendingReviewSession()?.roomId).toBe(roomC);

    // 2. "Complete this review pass": the command layer directly, at the learner's rating.
    const explicit = reviewController.passComplete({ roomId: roomC, qualityRating: 5 });
    if (!explicit.ok) throw new Error(`Expected the explicit completion to be accepted`);
    expect(explicit.value.reviewIdentity).toMatchObject({ roomId: roomC, passNumber: 1 });
    expect(explicit.value.progression.awarded).toBe(true);
    // Three awards, 18 XP, and the pass is complete.
    expect(progression().reviewPasses).toBe(3);
    expect(progression().xpTotal).toBe(18);

    // The store cleared this room's marker in the same record write as the award, so the fact
    // the close route needed - "this review is still unfinished" - is gone. The in-memory arm
    // is not, because the command layer never touched it.
    expect(marker()).toBeNull();

    // 3. "Done reviewing". `fullReviewPasses` has moved to 1, so this re-derives pass **2**,
    // which the ledger has never seen and therefore cannot suppress.
    flow.closeInfoPanel();

    expect(progression().reviewPasses).toBe(3);
    expect(progression().xpTotal).toBe(18);
    // Newest first, as the ledger stores it.
    expect(ledgerRoomPasses()).toEqual([
      { roomId: roomC, passNumber: 1 },
      { roomId: roomB, passNumber: 1 },
      { roomId: roomA, passNumber: 1 },
    ]);
    expect(ledgerRoomPasses()).not.toContainEqual({ roomId: roomC, passNumber: 2 });
    // The SM-2 half was not stepped a second time either, and the rating that survived is the
    // learner's `5` rather than the panel-close `3`.
    expect(room(roomC).reviewPassCount).toBe(1);
    expect(room(roomC).sm2QualityResponse).toBe(5);
    // And the close route reported nothing, because it had nothing to finalize.
    expect(toasts.filter((entry) => entry.startsWith('info: Review recorded'))).toEqual([]);
  });
});

// ── The guard is a backstop, not the only guard ──────────────────────────────

describe('the same-pass case, which the ledger already suppressed', () => {
  it('leaves the close inert after an explicit completion that did not complete the pass', () => {
    // One room reviewed out of three, so `fullReviewPasses` is still 0 and both routes would
    // derive pass 1.
    flow.roomInteract(roomIds[0]);
    const explicit = reviewController.passComplete({ roomId: roomIds[0], qualityRating: 5 });
    if (!explicit.ok) throw new Error(`Expected the explicit completion to be accepted`);
    expect(explicit.value.reviewIdentity.passNumber).toBe(1);
    expect(marker()).toBeNull();

    flow.closeInfoPanel();

    expect(progression().reviewPasses).toBe(1);
    expect(progression().xpTotal).toBe(6);
    expect(ledgerRoomPasses()).toEqual([{ roomId: roomIds[0], passNumber: 1 }]);
    expect(room(roomIds[0]).reviewPassCount).toBe(1);
    expect(toasts.filter((entry) => entry.startsWith('info: Review recorded'))).toEqual([]);
  });

  it('is suppressed by the durable (room, pass) ledger even with no marker involved', () => {
    // The second call above never reached the command layer, so this pins the layer beneath
    // it: the same repeat, dispatched directly, with the marker guard nowhere in the call.
    flow.roomInteract(roomIds[0]);
    const first = reviewController.passComplete({ roomId: roomIds[0], qualityRating: 5 });
    if (!first.ok) throw new Error('Expected the first completion to be accepted');

    // Re-arm, so the only thing standing between the repeat and a second award is the ledger.
    flow.roomInteract(roomIds[0]);
    expect(marker()?.roomId).toBe(roomIds[0]);

    const repeat = reviewController.passComplete({ roomId: roomIds[0], qualityRating: 3 });
    if (!repeat.ok) throw new Error('Expected the repeat to be accepted as a command');

    expect(repeat.value.reviewIdentity.passNumber).toBe(first.value.reviewIdentity.passNumber);
    expect(repeat.value.progression.awarded).toBe(false);
    expect(repeat.value.progression.duplicate).toBe(true);
    expect(progression().reviewPasses).toBe(1);
    expect(progression().xpTotal).toBe(6);
    expect(ledgerRoomPasses()).toHaveLength(1);
    // A suppressed repeat writes no schedule either, so the rating `3` never reached SM-2.
    expect(room(roomIds[0]).reviewPassCount).toBe(1);
    expect(room(roomIds[0]).sm2QualityResponse).toBe(5);
  });
});

// ── The guard must not suppress a real finalize ─────────────────────────────

describe('the panel-close route still works', () => {
  it('counts the pass when nothing else finished it', () => {
    // The rollback lane's route: open the panel, rate nothing, close.
    flow.roomInteract(roomIds[0]);
    expect(flow.readPendingReviewSession()?.roomId).toBe(roomIds[0]);

    flow.closeInfoPanel();

    expect(progression().reviewPasses).toBe(1);
    expect(progression().xpTotal).toBe(6);
    expect(ledgerRoomPasses()).toEqual([{ roomId: roomIds[0], passNumber: 1 }]);
    expect(room(roomIds[0]).reviewPassCount).toBe(1);
    // The panel-close rating, verbatim, which is the whole documented cost of this route.
    expect(room(roomIds[0]).sm2QualityResponse).toBe(3);
    // And the award cleared the marker, so nothing is left resumable.
    expect(marker()).toBeNull();
    expect(toasts).toContain(
      'info: Review recorded (+6 XP): 1/3 rooms toward pass 1. Completed full passes: 0.',
    );
  });

  it('a marker for another room does not pass this room', () => {
    // The guard is room-scoped. A naive "is there any marker?" check would let the second
    // room's close through on the strength of the first room's open review, so this pins
    // that the marker has to name the room being finalized.
    flow.roomInteract(roomIds[0]);
    expect(marker()?.roomId).toBe(roomIds[0]);

    flow.finalizePendingReview(roomIds[1]);

    expect(progression().reviewPasses).toBe(0);
    expect(ledgerRoomPasses()).toEqual([]);
    // And the other room's marker is left alone, so its review is still resumable.
    expect(marker()?.roomId).toBe(roomIds[0]);
  });

  it('suppresses the close after an explicit discard, which clears the same marker', () => {
    flow.roomInteract(roomIds[0]);
    expect(flow.readPendingReviewSession()?.roomId).toBe(roomIds[0]);

    // "Discard this review" in the workspace.
    expect(flow.discardPendingReview(roomIds[0])).toBe(true);
    expect(marker()).toBeNull();

    // Called directly, so this pins the *guard* rather than the in-memory arm that
    // `discardPendingReview` also clears - otherwise the test would pass for the wrong reason,
    // exactly as the suite it replaces did.
    flow.finalizePendingReview(roomIds[0]);
    flow.closeInfoPanel();

    expect(progression().reviewPasses).toBe(0);
    expect(progression().xpTotal).toBe(0);
    expect(ledgerRoomPasses()).toEqual([]);
    expect(room(roomIds[0]).reviewPassCount).toBe(0);
    expect(room(roomIds[0]).sm2QualityResponse).toBeUndefined();
    expect(toasts.filter((entry) => entry.startsWith('info: Review recorded'))).toEqual([]);
  });
});