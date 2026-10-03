/**
 * The review workspace's two claims about *where the learner is* and *how the review ends*.
 *
 * ## Why these need their own file
 *
 * Both defects this file pins are sentences that render happily and answer nothing. Neither
 * shows up as a crash, a store disagreement, or a missing control - a learner reviewing a
 * room three floors down is told, in the workspace's own context block, that they are at the
 * top of their subject, and a learner who reads the completion refusal is told a review
 * cannot be finished until they rate it, which the panel's own close button contradicts. The
 * rest of `review-workspace.test.tsx` is about shape and ARIA; this is about the workspace
 * not making claims, and it needs the two claims side by side to be checkable at all.
 *
 * ## The fixture's graph, which every expectation below is read off
 *
 * ```
 * Linear Algebra            (root)      floor: Linear Algebra   path: Linear Algebra
 * └── Matrices              (own floor) floor: Matrices         path: Linear Algebra → Matrices
 *     └── Eigenvalues                    floor: Matrices         path: Linear Algebra → Matrices → Eigenvalues
 * ```
 *
 * `Eigenvalues` is the room that makes the difference between a right answer and a wrong one:
 * it is **not** the root, it is **not** the floor it sits under (`Matrices` owns that floor),
 * and its subject is `Linear Algebra`. The pre-fix workspace rendered `Floor: Linear Algebra`
 * and `Path: This is the root topic.` for it, so every one of its three answers was false.
 *
 * ## Why the root's honest answer is a one-entry path and not a sentence
 *
 * `GraphHierarchy.breadcrumbRoomIdsByRoomId` is built root-first and **inclusive** - it ends
 * with the room itself - so the root room's real path is `['Linear Algebra']`, not `[]`. Every
 * caller of this shell field (`CreatorWorkspace`, `ScribeEncounter`, and now this workspace)
 * passes that inclusive chain, which is what makes one `<dt>Path</dt>` row mean one thing in
 * all three surfaces. An empty list therefore cannot mean "root"; it can only mean "there is
 * no room to trace a path from", and that is what the shell now says it means. The root case
 * is asserted below to *resolve to its own real answer* rather than to fall through to the
 * no-room wording, which is the property that would break if the case were simply deleted.
 *
 * Hermeticity: no renderer, no canvas, no network, no `dist/`, no real clock. `nowIso` is
 * injected into the workspace exactly as `reviewCommands.ts` injects it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { ArchaeologistWorkspace } from '@/ui/study/review/ArchaeologistWorkspace';
import {
  FIXTURE_DUNGEON_ID,
  buildReviewFixture,
  withEveryRoomCleared,
  type ReviewFixture,
} from './support/reviewFixtures';

/** One render-scoped instant, so nothing here depends on a clock. */
const NOW_ISO = '2026-03-01T12:00:00.000Z';

/**
 * The sentence the shell used to print for *every* review, whatever room was under review.
 *
 * Named rather than inlined at each assertion so that deleting the claim is one edit here and
 * the tests below cannot each be "fixed" by loosening their own copy.
 */
const FALSE_ROOT_CLAIM = 'This is the root topic.';

/** What the no-room case says instead, once for the floor row and once for the path row. */
const NO_ROOM_FLOOR = 'No room is under review here, so there is no floor.';
const NO_ROOM_PATH = 'No room is under review here, so there is no path to it.';

/** The rating the panel-close route records, which the copy below has to name. */
const PANEL_CLOSE_RATING = 3;

let fixture: ReviewFixture;

function install(snapshot: ReviewFixture['snapshot']): void {
  useSubjectStore.setState({ snapshot, lastError: null });
  useSessionStore.setState({ phase: 'archaeologist', activeScreen: 'game' });
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(FIXTURE_DUNGEON_ID);
}

/**
 * The text of one `<dd>` in the shell's context block, found by its `<dt>` label.
 *
 * By label rather than by position or by a class, so a row added to the block cannot make
 * every assertion below silently read a different row. Returns `null` for a missing row,
 * which no assertion here accepts as a substitute for a value.
 */
function contextRow(label: string): string | null {
  const term = [...document.querySelectorAll<HTMLElement>('.study-shell__context dt')].find(
    (element) => element.textContent === label,
  );
  return term?.nextElementSibling?.textContent ?? null;
}

/** Render the workspace on one room of the installed snapshot. */
function renderWorkspace(roomId: string | null): void {
  const snapshot = useSubjectStore.getState().snapshot;
  if (snapshot === null) throw new Error('No snapshot installed');
  render(
    <ArchaeologistWorkspace
      room={roomId === null ? null : (snapshot.rooms[roomId] ?? null)}
      snapshot={snapshot}
      pendingSession={null}
      nowIso={NOW_ISO}
      resolveLocalImage={() => null}
      onResumeReview={() => true}
      onDiscardReview={() => true}
      onClose={() => {}}
    />,
  );
}

/** Choose a recall rating, which is the only thing that can set it. */
function chooseRating(value: number): void {
  const radio = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
  if (radio === null) throw new Error(`No rating radio for ${value}`);
  fireEvent.click(radio);
}

beforeEach(() => {
  window.localStorage.clear();
  fixture = buildReviewFixture();
  install(withEveryRoomCleared(fixture.snapshot));
});

afterEach(() => {
  cleanup();
});

describe('a non-root room reports where it actually is', () => {
  it('gives a room two floors down its own floor label and its real path, not "the root topic"', () => {
    renderWorkspace(fixture.eigenRoomId);

    /*
     * The floor is `Matrices`, because a room's floor is the direct child of the subject root
     * above it - and specifically *not* `Eigenvalues` (its own topic) and *not* `Linear
     * Algebra` (the subject name, which is what the pre-fix workspace printed under `<dt>Floor`).
     */
    expect(contextRow('Floor')).toBe('Matrices');
    expect(contextRow('Floor')).not.toBe('Eigenvalues');
    expect(contextRow('Floor')).not.toBe('Linear Algebra');

    // The path is the walk from the root down to this room, inclusive of the room itself.
    expect(contextRow('Path')).toBe('Linear Algebra → Matrices → Eigenvalues');

    /*
     * The defect, stated as an absence so it cannot be satisfied by the correct rows above.
     * Scanned over the whole rendered text rather than through `queryByText`, because the
     * claim would reach a learner anywhere in the block - in a row, in a tooltip, in an aria
     * string - and a single-element query only rules out one of those.
     */
    expect(document.body.textContent).not.toContain(FALSE_ROOT_CLAIM);
    expect(screen.queryByText(FALSE_ROOT_CLAIM)).toBeNull();
  });

  it('gives a room that owns its own floor that floor, and a path of two entries', () => {
    renderWorkspace(fixture.matrixRoomId);

    // `Matrices` is a direct child of the root, so it *is* a floor rather than being on one.
    expect(contextRow('Floor')).toBe('Matrices');
    expect(contextRow('Path')).toBe('Linear Algebra → Matrices');
    expect(document.body.textContent).not.toContain(FALSE_ROOT_CLAIM);
  });

  it('never prints the subject name as a floor for any room, and never leaves a row unanswered', () => {
    /*
     * A sweep rather than one case: the subject name and a floor label coincide for the root
     * room in this fixture, so a single root-room assertion could pass while the non-root
     * substitution came back. Three rooms, one loop, `cleanup` between them so each render
     * starts from an empty document.
     */
    for (const roomId of [fixture.rootRoomId, fixture.matrixRoomId, fixture.eigenRoomId]) {
      renderWorkspace(roomId);

      // `Subject` is the row the subject name belongs in, and it is the only row that holds it.
      expect(contextRow('Subject'), `room ${roomId}`).toBe('Linear Algebra');
      expect(contextRow('Floor'), `room ${roomId}`).not.toBe(NO_ROOM_FLOOR);
      expect(contextRow('Path'), `room ${roomId}`).not.toBe(NO_ROOM_PATH);
      // Non-vacuity on the whole block: both rows resolved to something for all three rooms.
      expect(contextRow('Floor'), `room ${roomId}`).not.toBeNull();
      expect(contextRow('Path'), `room ${roomId}`).not.toBeNull();
      expect(document.body.textContent ?? '', `room ${roomId}`).not.toContain(FALSE_ROOT_CLAIM);

      cleanup();
    }
  });
});

describe('the root room still gets an answer of its own', () => {
  it('renders the root\'s real floor and its real one-entry path, not the no-room wording', () => {
    renderWorkspace(fixture.rootRoomId);

    /*
     * The root case is handled rather than dropped. Under the inclusive-path convention the
     * root's path is itself, so the honest answers are `Matrices`-free-by-nature: the floor is
     * the root's own topic and the path is that same single entry.
     *
     * The property worth pinning is that both rows *resolve to a room's real answer* instead
     * of falling through to the no-room sentences - which is exactly what would happen if the
     * fix had deleted the root case rather than answering it. For the root room the floor and
     * the subject happen to share a string, so the assertion that carries the weight is the
     * path: it must be the root's topic and not the no-room sentence.
     */
    expect(contextRow('Floor')).toBe('Linear Algebra');
    expect(contextRow('Path')).toBe('Linear Algebra');
    expect(contextRow('Path')).not.toBe(NO_ROOM_PATH);
    expect(contextRow('Floor')).not.toBe(NO_ROOM_FLOOR);

    // And the heading still names the room, so the root is visibly the root.
    expect(screen.getByRole('heading', { name: 'Linear Algebra' })).toBeInTheDocument();
    expect(screen.queryByText('No room is under review.')).toBeNull();
  });

  it('does not claim the root is above nothing when there is a room under review', () => {
    /*
     * The pre-fix shell rendered `This is the root topic.` for an empty breadcrumb and every
     * workspace passed an empty one, so the claim was both always-false (see the header) and
     * load-bearing: deleting it without answering the root would have left that row blank.
     * Both facts are pinned here - the claim is gone, and the row is not blank.
     */
    renderWorkspace(fixture.rootRoomId);
    expect(contextRow('Path')).not.toBe(FALSE_ROOT_CLAIM);
    expect(contextRow('Path')).not.toBe('');
    expect(contextRow('Path')).not.toBeNull();
  });
});

describe('the no-room case says so in both rows rather than borrowing a plausible value', () => {
  it('names no floor and no path, and keeps the heading fallback', () => {
    renderWorkspace(null);

    expect(screen.getByRole('heading', { name: 'No room is under review.' })).toBeInTheDocument();
    expect(contextRow('Floor')).toBe(NO_ROOM_FLOOR);
    expect(contextRow('Path')).toBe(NO_ROOM_PATH);
    // The subject name is a fine `Subject` and a false `Floor`; this is what stops the swap.
    expect(contextRow('Floor')).not.toBe('Linear Algebra');
    expect(document.body.textContent).not.toContain(FALSE_ROOT_CLAIM);
  });
});

describe('the two routes out of the workspace say the same thing about the same pass', () => {
  it('names the panel-close route and its rating in the unrated refusal', () => {
    renderWorkspace(fixture.matrixRoomId);

    /*
     * The pinned resolution of "a passing grade is not required to complete". `Complete this
     * review pass` is disabled until a rating exists - true, and true only about this button -
     * while closing the panel completes the same pass through `finalizePendingReview`. So the
     * refusal a learner reads beside the disabled control has to name the other route, or it
     * reads as "this review cannot be finished yet".
     */
    const refusal = screen.getByText(/^Pick how well you recalled this room before completing the pass/);
    expect(refusal.textContent).toContain(`Closing the room panel counts this pass at a rating of ${PANEL_CLOSE_RATING}`);
  });

  it('keeps the same number in every sentence that is on screen at once', () => {
    renderWorkspace(fixture.matrixRoomId);

    /*
     * Two places a learner can read the decision without moving: the `Complete` region's own
     * description, and the refusal standing under the disabled primary control. If either kept
     * the old wording - "Closing the room panel does the same thing", "counts this pass if you
     * rated it" - this fails.
     */
    expect(
      screen.getByText(
        `Count this pass at the rating you pick, park it for later, or close the panel, which counts it at a rating of ${PANEL_CLOSE_RATING}.`,
      ),
    ).toBeInTheDocument();

    /*
     * The refusal, checked as a whole sentence rather than as the substring the other test
     * matches, because `StudyActionButton` renders `refusal ?? description` - while a refusal
     * is showing, this control's own description is *not* on screen at all. That precedence is
     * the reason the refusal had to carry the number too: the description a learner would
     * otherwise read about the panel-close route is exactly the text the refusal replaces.
     */
    expect(
      screen.getByText(
        `Pick how well you recalled this room before completing the pass, because your rating is what schedules the next review. Closing the room panel counts this pass at a rating of ${PANEL_CLOSE_RATING}, whatever you picked here.`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        /Counts this room toward the current pass and schedules its next review from your rating\./,
      ),
      'the refusal replaces the description, so the description is not on screen yet',
    ).toBeNull();

    // ...and the panel-close control, which is never blocked and so always shows its own.
    expect(
      screen.getByText(
        `Closes the room panel, which counts this pass at a rating of ${PANEL_CLOSE_RATING}.`,
      ),
    ).toBeInTheDocument();
  });

  it('states the number unconditionally, because the flow applies it either way', () => {
    renderWorkspace(fixture.matrixRoomId);

    /*
     * The conditional wording the copy replaced - "counts this pass if you rated it" - was
     * false in both directions. `finalizePendingReview` passes
     * `CLOSED_WITHOUT_RATING_QUALITY` on every close, and the rating chosen in this workspace is
     * local state that never reaches the flow, so the panel-close route does not award *and*
     * does not use the chosen rating. No sentence here may be conditioned on having rated.
     */
    for (const text of [document.querySelector('.archaeologist-close')?.textContent ?? '']) {
      expect(text).not.toMatch(/if you rated/i);
    }
    expect(document.body.textContent ?? '').not.toMatch(/if you rated/i);
    expect(document.body.textContent ?? '').not.toMatch(/Closing the room panel does the same thing/i);
  });

  it('still says the panel-close number after a rating has been chosen, because the button is not that route', () => {
    renderWorkspace(fixture.matrixRoomId);

    chooseRating(5);
    expect(screen.getByRole('button', { name: 'Complete this review pass' })).toBeEnabled();
    // No refusal remains on this control - the learner answered - so this control's own
    // description takes its place, and that description must not have quietly adopted the
    // panel's number as if the two routes agreed.
    expect(
      screen.queryByText(/^Pick how well you recalled this room before completing the pass/),
    ).toBeNull();
    expect(
      screen.getByText(
        `Counts this room toward the current pass and schedules its next review from your rating. Closing the room panel counts this pass at a rating of ${PANEL_CLOSE_RATING}, whatever you picked here.`,
      ),
    ).toBeInTheDocument();
  });
});