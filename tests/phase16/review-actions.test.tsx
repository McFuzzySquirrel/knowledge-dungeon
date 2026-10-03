/**
 * Exit criteria 2 and 5 under React StrictMode: a review pass cannot be double-counted, and
 * every dispatch comes from an event handler.
 *
 * ## Why counting renders is not evidence
 *
 * StrictMode double-*invokes* effects in development. `review/pass-complete` is
 * **synchronous** - `runPassComplete` reads a snapshot, writes the ledger, and calls
 * `recordReviewPass` all in one call - so a mutation fired from an effect applies twice with
 * nothing thrown and no warning. A test that rendered in StrictMode and asserted "the panel
 * shows one pass" would pass on exactly that defect; a test that counts renders would not
 * notice it at all, because renders are not the thing at risk.
 *
 * So this file measures the mutation, with counters at three independent layers:
 *
 * 1. **Commands.** Every method on `reviewController` is wrapped in a spy that forwards to the
 *    real controller. One user action must produce exactly one command, so a second invocation
 *    anywhere - an effect, a double-fired event, a re-entrant handler - is red.
 * 2. **The durable store.** `reviewPasses` and `xpTotal` are read from the real progression
 *    store. This is the counter that cannot be fooled: whatever the components do, one pass is
 *    one increment.
 * 3. **The subject store.** `reviewPassCount` is read back, because a review that awarded once
 *    but scheduled twice would inflate the pass number - which is a *badge* input, and
 *    `src/core/review/reviewPasses.ts` is explicit that the pass number must not drift.
 *
 * ## The two layers, tested separately
 *
 * The ref guard in `useReviewActions` answers "was this asked twice?". The durable (room, pass)
 * ledger answers "has this pass been awarded before?". The second is what makes the first
 * unnecessary rather than load-bearing, so the resubmission case below bypasses the UI
 * entirely and calls the command twice: if the guard were the only defence, that call would
 * double the reward.
 *
 * ## `duplicate` is the discriminator, not `awarded`
 *
 * Three assertions below exist only to pin that: a suppressed duplicate, an unlocked room, and
 * a no-active-subject store all produce `awarded: false`, and the sentences must not collapse
 * into one another.
 *
 * Hermeticity: no renderer, no canvas, no network, no `dist/`, no clock - `nowIso` is injected
 * into the workspace.
 */
import { StrictMode, type ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store's write, counted. Everything else in the persistence module is the real thing.
vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

// The command boundary, counted and forwarded. The wrapper changes no behaviour: it records
// the call and hands the identical payload to the identical controller.
vi.mock('@/store/reviewCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/reviewCommands')>();
  return {
    ...actual,
    reviewController: {
      ...actual.reviewController,
      passComplete: vi.fn(actual.reviewController.passComplete),
      sessionSave: vi.fn(actual.reviewController.sessionSave),
      sessionDiscard: vi.fn(actual.reviewController.sessionDiscard),
      sessionResume: vi.fn(actual.reviewController.sessionResume),
      dispatch: vi.fn(actual.reviewController.dispatch),
    },
  };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, archaeologistReviewWorkspace: true },
  };
});

import type { ReviewPassCompleteOutcome } from '@/application/reviewCommands';
import { toReviewPassRewardIdentity } from '@/core/review/reviewPassRewards';
import { saveSubjectSnapshot } from '@/services/persistence/subjectPersistence';
import { reviewController } from '@/store/reviewCommands';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { ArchaeologistWorkspace } from '@/ui/study/review/ArchaeologistWorkspace';
import { describePassComplete } from '@/ui/study/review/useReviewActions';
import {
  FIXTURE_DUNGEON_ID,
  buildReviewFixture,
  withEveryRoomCleared,
  type ReviewFixture,
} from './support/reviewFixtures';

const passCompleteMock = vi.mocked(reviewController.passComplete);
const sessionSaveMock = vi.mocked(reviewController.sessionSave);
const sessionDiscardMock = vi.mocked(reviewController.sessionDiscard);
const saveMock = vi.mocked(saveSubjectSnapshot);

const NOW_ISO = '2026-03-01T12:00:00.000Z';

let fixture: ReviewFixture;

function progression() {
  return useProgressionStore.getState();
}

function snapshot() {
  const live = useSubjectStore.getState().snapshot;
  if (live === null) throw new Error('No snapshot installed');
  return live;
}

/** Rate the recall, which is the only thing that can set the rating. */
function chooseRating(value: number): void {
  const radio = document.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${value}"]`,
  );
  if (radio === null) throw new Error(`No rating radio for ${value}`);
  fireEvent.click(radio);
}

/** The workspace, mounted the way `RoomPanel` mounts it, inside StrictMode. */
function renderStrict(
  overrides: Partial<Parameters<typeof ArchaeologistWorkspace>[0]> = {},
): { rerender: (node: ReactElement) => void } {
  const live = snapshot();
  return render(
    <StrictMode>
      <ArchaeologistWorkspace
        room={live.rooms[fixture.matrixRoomId] ?? null}
        snapshot={live}
        pendingSession={null}
        nowIso={NOW_ISO}
        resolveLocalImage={() => null}
        onResumeReview={() => true}
        onDiscardReview={() => true}
        onClose={() => {}}
        {...overrides}
      />
    </StrictMode>,
  );
}

/** The completion control, whatever its pending label says. */
function completeButton(): HTMLElement {
  return screen.getByRole('button', { name: /^(Recording…|Complete this review pass)$/ });
}

beforeEach(() => {
  window.localStorage.clear();
  fixture = buildReviewFixture();
  useSubjectStore.setState({
    snapshot: withEveryRoomCleared(fixture.snapshot),
    lastError: null,
  });
  useSessionStore.setState({ phase: 'archaeologist', activeScreen: 'game' });
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(FIXTURE_DUNGEON_ID);
  for (const mock of [passCompleteMock, sessionSaveMock, sessionDiscardMock, saveMock]) {
    mock.mockClear();
  }
});

afterEach(() => {
  cleanup();
});

describe('mounting and re-rendering never mutates', () => {
  it('dispatches nothing and commits nothing on mount, under StrictMode', () => {
    renderStrict();

    expect(passCompleteMock).not.toHaveBeenCalled();
    expect(sessionSaveMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(progression().reviewPasses).toBe(0);
    expect(progression().xpTotal).toBe(0);
  });

  it('dispatches nothing when regions are opened, collapsed, and re-opened', () => {
    renderStrict();

    for (const id of ['schedule', 'artifact', 'recall', 'complete']) {
      const toggle = document
        .querySelector<HTMLElement>(`[data-study-region="${id}"]`)
        ?.querySelector<HTMLButtonElement>('.study-region__toggle');
      if (toggle === null || toggle === undefined) throw new Error(`No toggle for ${id}`);
      fireEvent.click(toggle);
      fireEvent.click(toggle);
    }

    expect(passCompleteMock).not.toHaveBeenCalled();
    expect(sessionSaveMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('dispatches nothing when the learner rates their recall', () => {
    renderStrict();

    // The rating is local state. Choosing it must not reach the command layer, because a
    // rating the learner has not submitted has not been recalled and must not schedule
    // anything.
    chooseRating(4);

    expect(passCompleteMock).not.toHaveBeenCalled();
    expect(sessionSaveMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(snapshot().rooms[fixture.matrixRoomId]?.reviewPassCount).toBe(0);
  });

  it('dispatches nothing when the next action moves focus into a collapsed region', () => {
    renderStrict();

    // "Rate how well you recalled it" targets the recall region, which starts open; the
    // schedule toggle is the closed one. Either way, focus movement is presentation.
    fireEvent.click(screen.getByRole('button', { name: /Go to: / }));
    fireEvent.click(screen.getByRole('button', { name: 'Show Schedule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide Schedule' }));

    expect(passCompleteMock).not.toHaveBeenCalled();
    expect(sessionSaveMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('dispatches nothing when a re-render is forced from outside the workspace', () => {
    const { rerender } = renderStrict();
    rerender(
      <StrictMode>
        <ArchaeologistWorkspace
          room={snapshot().rooms[fixture.matrixRoomId] ?? null}
          snapshot={snapshot()}
          pendingSession={null}
          nowIso={NOW_ISO}
          resolveLocalImage={() => null}
          onResumeReview={() => true}
          onDiscardReview={() => true}
          onClose={() => {}}
        />
      </StrictMode>,
    );

    expect(passCompleteMock).not.toHaveBeenCalled();
    expect(sessionSaveMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe('review/pass-complete fires exactly once and awards exactly once', () => {
  it('rewards once for one activation, under StrictMode', async () => {
    renderStrict();
    chooseRating(4);
    expect(completeButton()).toHaveTextContent('Complete this review pass');

    fireEvent.click(completeButton());

    await waitFor(() => expect(progression().reviewPasses).toBe(1));
    expect(passCompleteMock).toHaveBeenCalledTimes(1);
    // The rating reached the command layer as a number, not as the standing default: this is
    // the assertion that `CLOSED_WITHOUT_RATING_QUALITY` no longer stands in for a choice.
    expect(passCompleteMock.mock.calls[0]?.[0]).toEqual({
      roomId: fixture.matrixRoomId,
      qualityRating: 4,
    });
    expect(progression().xpTotal).toBeGreaterThan(0);
  });

  it('refuses a second dispatch of the same scope inside one tick, which is what a double tap is', () => {
    renderStrict();
    chooseRating(4);
    const complete = completeButton();

    fireEvent.click(complete);
    fireEvent.click(complete);

    // The ref guard: the second click is refused *before* the controller is called.
    expect(passCompleteMock).toHaveBeenCalledTimes(1);
  });

  it('rewards once across a resubmission, with the ref guard nowhere near it', () => {
    // Straight at the command layer, twice, with no UI and no guard. This is the assertion
    // that the *durable* ledger is what makes the award idempotent rather than the button.
    const payload = { roomId: fixture.matrixRoomId, qualityRating: 4 as const };

    const first = reviewController.passComplete(payload);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.progression.awarded).toBe(true);
      expect(first.value.progression.duplicate).toBe(false);
    }
    const xpAfterFirst = progression().xpTotal;
    const passCountAfterFirst = snapshot().rooms[fixture.matrixRoomId]?.reviewPassCount;

    const second = reviewController.passComplete(payload);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.progression.awarded).toBe(false);
      // The discriminator. Without it, "nothing was awarded" and "this was already awarded"
      // are the same event and the surface would tell a learner a sentence that may be false.
      expect(second.value.progression.duplicate).toBe(true);
    }

    expect(progression().xpTotal).toBe(xpAfterFirst);
    expect(progression().reviewPasses).toBe(1);
    // The scheduling half is gated on the award too, so a duplicate does not walk the pass
    // number forward - which is a badge threshold input.
    expect(snapshot().rooms[fixture.matrixRoomId]?.reviewPassCount).toBe(passCountAfterFirst);
  });

  it('reports a duplicate in words, distinctly from a reward', async () => {
    /*
     * Award the pass at the command layer first, then mount and complete through the UI.
     *
     * Doing it this way round rather than clicking twice is deliberate. The ref guard holds a
     * scope closed for one macrotask after a dispatch, which is exactly what makes a double
     * tap safe - and it means a second click *in the same task* is correctly refused with no
     * message. So a test that wanted the duplicate *sentence* by clicking twice would be
     * testing the guard, not the sentence. Here the workspace mounts on a snapshot whose ledger
     * already holds this (room, pass), so the one click is a genuine duplicate and the message
     * is the one a learner would read after a reload, a retry, or a panel close that landed
     * twice.
     */
    const first = reviewController.passComplete({ roomId: fixture.matrixRoomId, qualityRating: 4 });
    expect(first.ok && first.value.progression.awarded).toBe(true);
    await waitFor(() => expect(progression().reviewPasses).toBe(1));

    renderStrict();
    chooseRating(4);
    fireEvent.click(completeButton());

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('already counted'),
    );
    // ...and the passing sentence is the one that says what happened, not what did not.
    expect(screen.getByRole('status').textContent).not.toContain('Review pass recorded.');
    expect(progression().reviewPasses).toBe(1);
  });

  it('distinguishes a duplicate from "nothing was awarded" in the message, not in the type', () => {
    /*
     * `awarded: false` covers three causes and only one is "already awarded". The three
     * sentences are asserted directly on `describePassComplete`, because that is where the
     * discrimination happens and it is the property that makes the other two safe.
     */
    const base: Omit<ReviewPassCompleteOutcome, 'progression'> = {
      command: 'review/pass-complete',
      roomId: fixture.matrixRoomId,
      qualityRating: 4,
      // Built through the domain's own factory rather than as a literal, because
      // `ReviewPassRewardIdentity`'s ledger key is derived from its parts - a hand-written
      // `{ roomId, passNumber, awardedAt }` is the shape a reader expects and not the shape the
      // type accepts, and the difference is exactly what this phase made durable.
      reviewIdentity: toReviewPassRewardIdentity({
        roomId: fixture.matrixRoomId,
        passNumber: 1,
      }),
      passProgress: {
        fullReviewPasses: 0,
        nextPassTarget: 1,
        roomsTowardNextPass: 1,
        totalRooms: 3,
        reviewedRoomIds: [],
      },
      resumedSessionDiscarded: false,
    };
    const reward = (awarded: boolean, duplicate: boolean, xpGained: number) => ({
      awarded,
      duplicate,
      xpGained,
      newRank: 'Novice' as const,
      rankChanged: false,
      unlockedAchievements: [],
    });

    expect(
      describePassComplete({ ...base, progression: reward(false, true, 0) }),
    ).toBe('This pass for this room was already counted, so nothing was added this time.');
    expect(
      describePassComplete({ ...base, progression: reward(false, false, 0) }),
    ).toBe('The review was recorded, but no reward was added because no subject is open.');
    expect(describePassComplete({ ...base, progression: reward(true, false, 6) })).toContain(
      '+6 XP',
    );
  });

  it('records nothing when the learner has not rated, and says why in visible text', () => {
    renderStrict();

    const complete = screen.getByRole('button', { name: 'Complete this review pass' });
    expect(complete).toBeDisabled();
    /*
     * The refusal names the *other* route and the rating it will use, because "disabled
     * until you answer" is a claim about this button and a learner who reads only it would
     * conclude the review cannot be completed at all. See Defect 2 in the workspace header.
     */
    expect(
      screen.getByText(
        'Pick how well you recalled this room before completing the pass, because your rating is what schedules the next review. Closing the room panel counts this pass at a rating of 3, whatever you picked here.',
      ),
    ).toBeInTheDocument();
    expect(passCompleteMock).not.toHaveBeenCalled();
  });
});

describe('the interrupted-session routes are two distinct decisions', () => {
  it('saves without awarding and without writing SM-2 state', () => {
    renderStrict();
    chooseRating(3);

    fireEvent.click(screen.getByRole('button', { name: 'Save and finish later' }));

    expect(sessionSaveMock).toHaveBeenCalledTimes(1);
    // "Nothing was awarded" is in the type as `progression: null`, and the message says it in
    // words: a review the learner did not finish has not been recalled.
    expect(screen.getByRole('status').textContent).toContain('Nothing was awarded yet');
    expect(progression().reviewPasses).toBe(0);
    expect(progression().xpTotal).toBe(0);
    expect(snapshot().rooms[fixture.matrixRoomId]?.reviewPassCount).toBe(0);
  });

  it('offers resume and discard only when the marker names this room, and each reaches its own verb', () => {
    // A marker for a different room: the headline says so, and neither control is offered,
    // because a control whose only possible outcome is "nothing changed" is worse than none.
    const otherSession = {
      version: 1 as const,
      roomId: fixture.eigenRoomId,
      passNumber: 1,
      startedAt: '2026-02-28T00:00:00.000Z',
      savedAt: '2026-02-28T00:00:00.000Z',
      // `null` is typed by the interface's own field, not by a `as const` on a bare literal -
      // `as const` only applies to literals, and `null` here is an *absence*, which is exactly
      // the distinction the marker draws between "no rating yet" and a rating.
      qualityRating: null,
    };
    renderStrict({ pendingSession: otherSession });

    expect(screen.queryByRole('button', { name: 'Pick this review back up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard the saved review' })).toBeNull();
    expect(
      screen.getByText(/An unfinished review is saved for a different room/),
    ).toBeInTheDocument();
  });

  it('resume reaches the flow - which re-arms the panel-close route - and the command layer', () => {
    const onResumeReview = vi.fn(() => true);
    const thisSession = {
      version: 1 as const,
      roomId: fixture.matrixRoomId,
      passNumber: 1,
      startedAt: '2026-02-28T00:00:00.000Z',
      savedAt: '2026-02-28T00:00:00.000Z',
      qualityRating: 2 as const,
    };
    renderStrict({ pendingSession: thisSession, onResumeReview });

    fireEvent.click(screen.getByRole('button', { name: 'Pick this review back up' }));

    // The flow's own method, because it re-arms `pendingReviewRoomId` and that is what lets
    // `closeInfoPanel` finalize this review later. Without it, resuming would restore the
    // marker and never be counted.
    expect(onResumeReview).toHaveBeenCalledWith(fixture.matrixRoomId);
    expect(reviewController.sessionResume).toHaveBeenCalledWith({ roomId: fixture.matrixRoomId });
  });

  it('discard reaches the flow - without which the next close would finalize an abandoned review', () => {
    const onDiscardReview = vi.fn(() => true);
    const thisSession = {
      version: 1 as const,
      roomId: fixture.matrixRoomId,
      passNumber: 1,
      startedAt: '2026-02-28T00:00:00.000Z',
      savedAt: '2026-02-28T00:00:00.000Z',
      qualityRating: null,
    };
    renderStrict({ pendingSession: thisSession, onDiscardReview });

    fireEvent.click(screen.getByRole('button', { name: 'Discard the saved review' }));

    expect(onDiscardReview).toHaveBeenCalledWith(fixture.matrixRoomId);
    expect(sessionDiscardMock).toHaveBeenCalledWith({ roomId: fixture.matrixRoomId });
    expect(progression().reviewPasses).toBe(0);
    expect(progression().xpTotal).toBe(0);
  });

  it('restores the remembered rating from the marker, and never invents one', () => {
    const remembered = {
      version: 1 as const,
      roomId: fixture.matrixRoomId,
      passNumber: 1,
      startedAt: '2026-02-28T00:00:00.000Z',
      savedAt: '2026-02-28T00:00:00.000Z',
      qualityRating: 1 as const,
    };
    renderStrict({ pendingSession: remembered });

    // Named in the arrival headline, in words, from `QUALITY_SHORT_LABELS` - so a learner
    // returning sees what they last said rather than an empty control.
    expect(screen.getByText(/rated barely/i)).toBeInTheDocument();
    // The rating control is still unset, because the marker records the choice and this
    // surface must not write it into the *submission* path without the learner confirming.
    expect(screen.getByText('No rating chosen yet.')).toBeInTheDocument();
    expect(passCompleteMock).not.toHaveBeenCalled();
  });
});