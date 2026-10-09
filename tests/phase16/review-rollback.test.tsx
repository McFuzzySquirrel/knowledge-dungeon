/**
 * The rollback lane: with the flag off, `RoomPanel`'s `notes` tab renders the pre-Phase-16
 * review view, unchanged and still working.
 *
 * ## Why this drives `RoomPanel` rather than the workspace
 *
 * `tests/phase16/review-workspace.test.tsx` renders `ArchaeologistWorkspace` directly, which
 * proves the component works and says nothing about *which* view a learner is shown. The
 * swap lives in `RoomPanel`, one `phase === 'archaeologist' && FLAG` comparison in the `notes`
 * tab body, exactly as the Creator lane's swap lives in the `topic` tab - so the decision point
 * to test is `RoomPanel`, and testing anything else would leave the actual branch untested.
 *
 * ## What "unchanged" is asserted as
 *
 * Four of the pre-Phase-16 `notes` tab's landmarks, by their text: the two progress cards'
 * sentences, the note body, and the "Done reviewing" button. Each is a string the tab has
 * always rendered, so a rewrite of the lane - not a rewrite of the new workspace - is what
 * fails here. The redesigned workspace's own markers are asserted absent rather than hidden:
 * `data-study-region` and the workspace's accessible name, because a region that is present
 * but `hidden` would still be a second review surface in the accessibility tree.
 *
 * ## The flag's own default is asserted against the real module
 *
 * `DEFAULT_RUNTIME_CONFIG` from `src/config/runtimeConfig.ts` rather than the mock, for the
 * reason `tests/phase15/scribe-rollback.test.tsx` gives: the mock can only assert this file,
 * and the value a release actually ships with is the one that makes this the production build.
 *
 * Hermeticity: no renderer, no canvas, no network, no `dist/`, no clock.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    // The reviewed rollback value, stated explicitly so the flag's own cutover default cannot
    // drift unnoticed: this suite is the evidence that a
    // `VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=false` build still renders the old notes tab.
    runtimeConfig: { ...actual.runtimeConfig, archaeologistReviewWorkspace: false },
  };
});

import {
  DEFAULT_RUNTIME_CONFIG,
  parseRuntimeConfig,
  RUNTIME_FLAG_ENV_KEYS,
} from '@/config/runtimeConfig';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { RoomPanel } from '@/ui/components/RoomPanel';
import {
  FIXTURE_DUNGEON_ID,
  buildReviewFixture,
  withClearedRoom,
  withEveryRoomCleared,
  type ReviewFixture,
} from './support/reviewFixtures';

let fixture: ReviewFixture;

function snapshot() {
  const live = useSubjectStore.getState().snapshot;
  if (live === null) throw new Error('No snapshot installed');
  return live;
}

/** The room panel with the archaeologist phase's default tab already selected. */
function renderPanel(): void {
  render(
    <RoomPanel
      snapshot={snapshot()}
      focusedRoom={snapshot().rooms[fixture.matrixRoomId] ?? null}
      onInteract={() => {}}
      onClose={() => {}}
      onTravelToRoom={() => {}}
      reviewPassesCompleted={0}
      reviewRoomsTowardNextPass={0}
      reviewNextPassTarget={1}
      reviewTotalRooms={3}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  fixture = buildReviewFixture();
  useSubjectStore.setState({
    snapshot: withEveryRoomCleared(fixture.snapshot),
    lastError: null,
  });
  // `archaeologist` is the phase whose `getDefaultTabForPhase` selects `notes`, which is the
  // tab this phase's swap replaces.
  useSessionStore.setState({
    phase: 'archaeologist',
    activeScreen: 'game',
    focusedRoomId: fixture.matrixRoomId,
  });
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(FIXTURE_DUNGEON_ID);
});

afterEach(() => {
  cleanup();
});

describe('the rollback build', () => {
  it('ships the flag on after the cutover, so this rollback build must set it false explicitly', () => {
    // After the Phase 23 cutover the production default is `true`; a rollback build sets
    // `VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE=false`, which is the value this suite mocks above.
    expect(DEFAULT_RUNTIME_CONFIG.archaeologistReviewWorkspace).toBe(true);
    expect(
      parseRuntimeConfig({ VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE: 'false' })
        .archaeologistReviewWorkspace,
    ).toBe(false);
    expect(RUNTIME_FLAG_ENV_KEYS.archaeologistReviewWorkspace).toBe(
      'VITE_ARCHAEOLOGIST_REVIEW_WORKSPACE',
    );
  });

  it('renders the pre-Phase-16 notes tab, with its own three landmarks', () => {
    renderPanel();

    /*
     * Exactly the three things the old `notes` tab rendered for a cleared room with a drafted
     * note, and nothing else.
     *
     * Worth being precise about what the old tab did *not* contain, because it is the finding
     * this phase started from: the two progress cards and their progressbar live in the
     * `topic` tab, not here. So the pre-Phase-16 review view a learner saw on arrival was the
     * `notes` tab - "Done reviewing", a helper sentence, and the note body - with the pass
     * counters one tab away behind a `⋯` menu. Asserted below as their *absence* from this tab,
     * which is what makes the new region's first position a real change rather than a
     * rearrangement.
     */
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
    // The note body, rendered from the room's own `noteText`.
    expect(screen.getByText(/A matrix acts on a vector by multiplication/)).toBeInTheDocument();
    // ...and the "Done reviewing" button, whose label and explanation are both unchanged.
    expect(screen.getByRole('button', { name: 'Done reviewing' })).toBeInTheDocument();
    expect(
      screen.getByText('Close this panel when you are done reviewing to count the pass.'),
    ).toBeInTheDocument();

    // The pass counters were never in this tab, and adding them here is the phase's substance.
    expect(screen.queryByText(/Archaeologist unlock:/)).toBeNull();
    expect(screen.queryByText(/Review passes:/)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // Nor was the artifact, nor any recall prompt, nor any rating control.
    expect(screen.queryByLabelText('Room artifact under review')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('still renders the old pass counters in the topic tab, where they have always lived', () => {
    /*
     * The rollback lane is not "the panel without its counters" - it is the panel as it was.
     * They live in the `topic` tab, which this phase did not touch, and asserting them here
     * proves the swap was scoped to one tab body rather than reaching the whole component.
     */
    renderPanel();
    /*
     * The archaeologist phase uses the compact layout, so the secondary tabs are behind the
     * room-tools disclosure. Opening it is the route a learner takes to reach the counters,
     * and `tests/unit/RoomPanel.*` already pins that behaviour - it is asserted here only so
     * the navigation to this tab is a real interaction rather than a `setTab` call.
     */
    fireEvent.click(screen.getByRole('button', { name: /room tools/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Topic' }));

    expect(screen.getByText('Archaeologist unlock: 3/3 rooms cleared')).toBeInTheDocument();
    expect(screen.getByText('Review passes: 0 complete')).toBeInTheDocument();
    expect(screen.getByText('0/3 rooms toward pass 1.')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Room review progress toward next pass' }),
    ).toBeInTheDocument();
    // Still no part of the redesigned workspace, on this tab either.
    expect(document.querySelectorAll('[data-study-region]')).toHaveLength(0);
  });

  it('renders no part of the redesigned workspace, not even hidden', () => {
    renderPanel();

    // Absent, not merely collapsed. A `hidden` region would still be a second review surface
    // in the accessibility tree, which is the double-answering the flag exists to prevent.
    expect(document.querySelectorAll('[data-study-region]')).toHaveLength(0);
    expect(screen.queryByLabelText('Archaeologist review workspace')).toBeNull();
    // The rating control is the phase's headline addition, so its absence is the sharpest
    // single assertion that the old lane is what renders.
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(document.getElementById('archaeologist-arrival')).toBeNull();
    expect(document.getElementById('archaeologist-progress')).toBeNull();
  });

  it('still finalizes the review through the panel-close route', () => {
    /*
     * The old lane's one route, exercised through the old lane's own control. `onClose` is
     * `flow.closeInfoPanel` in `GameScreen`, which is what calls `finalizePendingReview`; this
     * asserts that the control still *is* that route, which is the part of the pre-Phase-16
     * behaviour the phase's scope line says to preserve ("Preserve review finalization on
     * panel close").
     */
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

    fireEvent.click(screen.getByRole('button', { name: 'Done reviewing' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel\'s own header controls, which no phase of this work replaced', () => {
    renderPanel();

    // The panel close, the expand toggle, and the phase-menu disclosure are all still
    // `RoomPanel`'s. The swap replaced one tab body and nothing else, which is what makes the
    // rollback a single branch rather than a second rendering path.
    expect(screen.getByRole('button', { name: 'Close review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Expand/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /room tools/i })).toBeInTheDocument();
    // The tab strip is intact and still navigable.
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('still shows the empty-notes copy for a room with nothing drafted', () => {
    // The other branch of the old tab's first ternary, so "unchanged" covers both arms.
    useSubjectStore.setState({
      snapshot: withClearedRoom(fixture.snapshot, fixture.matrixRoomId),
      lastError: null,
    });
    useSessionStore.setState({
      phase: 'archaeologist',
      activeScreen: 'game',
      focusedRoomId: fixture.matrixRoomId,
    });
    // A room with no note text and no word count takes the `No notes drafted yet` branch.
    useSubjectStore.setState((state) => ({
      ...state,
      snapshot: state.snapshot === null ? null : withNoNote(state.snapshot, fixture.matrixRoomId),
    }));

    renderPanel();

    expect(
      screen.getByText(/No notes drafted yet/),
    ).toBeInTheDocument();
    // The "Done reviewing" control lives *inside* the drafted branch, so its absence here is
    // the old behaviour rather than a regression: an undrafted room never counted a pass.
    expect(screen.queryByRole('button', { name: 'Done reviewing' })).toBeNull();
  });
});

/** A room with an empty note and a zero word count. */
function withNoNote(
  live: NonNullable<ReturnType<typeof useSubjectStore.getState>['snapshot']>,
  roomId: string,
): NonNullable<ReturnType<typeof useSubjectStore.getState>['snapshot']> {
  const room = live.rooms[roomId];
  if (room === undefined) throw new Error(`No room ${roomId}`);
  return {
    ...live,
    rooms: {
      ...live.rooms,
      [roomId]: {
        ...room,
        noteText: '',
        validationState: { ...room.validationState, wordCount: 0 },
      },
    },
  };
}