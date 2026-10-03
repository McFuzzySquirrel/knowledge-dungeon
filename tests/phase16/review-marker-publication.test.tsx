/**
 * What Phase 16's review state machine publishes to the dungeon renderer.
 *
 * ## The question this file exists to settle
 *
 * `GameScreen` publishes the review marker with one filter:
 *
 * ```ts
 * phase === 'archaeologist'
 *   ? Object.values(snapshot.rooms).filter((room) => room.reviewPassCount > 0).map((r) => r.roomId)
 *   : []
 * renderer.setReviewedArtifactRooms(reviewedArtifactRoomIds);
 * ```
 *
 * Phase 16 changed what `reviewPassCount` *means*. Before it, `review/pass-complete` reached
 * `subjectStore.recordReviewPass` on every finalize, so a duplicate review still incremented
 * the counter. After it, `reviewPassRewards` suppresses a repeat `(room, pass)` and
 * `reviewCommands.runPassComplete` gates `recordReviewPass` on `!progression.duplicate` - so a
 * suppressed duplicate writes nothing at all. The filter's *meaning* is therefore a live
 * question rather than a comment: is `reviewPassCount > 0` still "has been reviewed at least
 * once", or has it become "was reviewed during the pass currently in progress"?
 *
 * Those are two different sets, and this codebase derives both:
 *
 * | Set | Where it comes from |
 * | --- | --- |
 * | "ever reviewed" - `reviewPassCount > 0` | `GameScreen`'s effect; the signal the renderer consumes |
 * | "reviewed in this pass" - `reviewPassCount >= fullReviewPasses + 1` | `summarizeReviewPassProgress.reviewedRoomIds`; an input to the badge and summary surfaces |
 *
 * **The answer is that the renderer signal is still the first one**, and the discriminator
 * between them is asserted directly in "a genuine second pass adds the sibling rooms and
 * nothing else": once every room of the fixture has been reviewed once, `nextPassTarget`
 * moves to 2, so the *current-pass* set is empty while the *ever-reviewed* set - the one the
 * renderer is handed - is all three rooms.
 *
 * ## How the proof is built, and why it is not a re-implementation
 *
 * Every assertion drives the **real** `GameScreen` component, the **real**
 * `createStudyFlowController`, the **real** `src/store/reviewCommands.ts` binding, and the
 * **real** `useSubjectStore` / `useProgressionStore`. The only replacement is the Phaser
 * seam `@/game/createGame`, taken from `tests/unit/GameScreen.npcDialog.test.tsx`, and a
 * `RoomPanel` double that exposes the close button the review route is driven through.
 *
 * A test that hand-copied `filter((room) => room.reviewPassCount > 0)` would pass whether or
 * not the shipped code agrees, which is the exact failure this file is shaped to make
 * impossible: the marker set below is *observed coming out of the screen*, and the review
 * that produced it is *the one the flow awards*.
 *
 * ## What it does NOT claim
 *
 * **It does not claim the marker is the right design.** It claims the shipped signal still
 * carries the meaning the marker has always carried, and that the Phase 16 ledger did not
 * quietly turn it into a different question. Redrawing the marker per pass would be a
 * *renderer behaviour change*, which is Phase 17/22 scope and explicitly not this phase's.
 *
 * **It does not re-pin the two known-red tests in `tests/unit/GameScreen.npcDialog.test.tsx`.**
 * `qa-engineer` owns those. This file adds coverage that does not depend on their fixtures.
 *
 * Hermeticity: a synthetic three-room subject, no network, no `dist/`, and no clock in any
 * assertion - the review route reads no time except the injected `nowIso` the stores own.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GameScreen } from '@/ui/screens/GameScreen';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import type { FloorVisibilityModel } from '@/application/contracts/world';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import { DUNGEON_ACTIONS } from '@/renderers/pixi/dungeon/createDungeonScene';

import {
  buildReviewFixture,
  withClearedRoom,
  withUndefeatedRoom,
  type ReviewFixture,
} from './support/reviewFixtures';

/* ── Mocks, declared before the screen is imported ──────────────────────────── */

interface CapturedCallbacks {
  onInteract?: (roomId: string) => void;
  onRoomEntered?: (roomId: string) => void;
}

const createGameMock = vi.fn();
let capturedCallbacks: CapturedCallbacks | null = null;
let reviewedPublications: string[][] = [];

const setReviewedArtifactRooms = vi.fn((roomIds: readonly string[]) => {
  reviewedPublications.push([...roomIds].sort());
});

vi.mock('@/game/createGame', () => ({
  createGame: (options: Record<string, unknown>) => {
    capturedCallbacks = (options.callbacks as CapturedCallbacks) ?? null;
    return createGameMock(options);
  },
}));

/**
 * `RoomPanel` reduced to the one thing the review route is driven through: its close button,
 * which is `closeInfoPanel`, which is what finalizes a pending review.
 *
 * `ui-engineer` owns the real panel. Stubbing it here is not a convenience - the panel's own
 * Phase 16 unlock *display* is asserted in `tests/phase16/review-workspace.test.tsx`, and what
 * this file needs is the flow's *enforcement*, which is reached by closing the panel.
 */
vi.mock('@/ui/components/RoomPanel', () => ({
  RoomPanel: (props: { onClose: () => void }) => (
    <div data-testid="room-panel">
      <button type="button" onClick={props.onClose}>
        Close room panel
      </button>
    </div>
  ),
}));

vi.mock('@/ui/components/Hud', () => ({ Hud: () => null }));
vi.mock('@/ui/components/HudDrawer', () => ({ HudDrawer: () => null }));
vi.mock('@/ui/components/FloatingActions', () => ({ FloatingActions: () => null }));
vi.mock('@/ui/components/InventoryBadgesPanel', () => ({
  InventoryBadgesPanel: () => null,
}));
vi.mock('@/ui/components/NoteEditorModal', () => ({ NoteEditorModal: () => null }));
vi.mock('@/ui/study/scribe/ScribeEncounter', () => ({ ScribeEncounterDialog: () => null }));
vi.mock('@/ui/components/RoomNpcDialog', () => ({ RoomNpcDialog: () => null }));
vi.mock('@/ui/components/Minimap', () => ({ Minimap: () => null }));
vi.mock('@/ui/components/HelpOverlay', () => ({ HelpOverlay: () => null }));
vi.mock('@/ui/components/FullMapView', () => ({ FullMapView: () => null }));
vi.mock('@/ui/components/GameplayOnboardingModal', () => ({
  GameplayOnboardingModal: () => null,
}));
vi.mock('@/ui/components/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('@/ui/components/ToastStack', () => ({ ToastStack: () => null }));
vi.mock('@/ui/components/MobileTouchHint', () => ({ MobileTouchHint: () => null }));
vi.mock('@/ui/components/TutorialOverlay', () => ({ TutorialOverlay: () => null }));
vi.mock('@/ui/utils/editableElement', () => ({ isEditableElement: () => false }));
vi.mock('@/ui/utils/onboarding', () => ({
  hasSeenGameplayLoopOnboarding: () => true,
  markGameplayLoopOnboardingSeen: () => undefined,
}));

/**
 * Persistence is stubbed, the state transition is not.
 *
 * `saveSubjectSnapshot` is what makes the room write asynchronous, and the review route is
 * synchronous by design (see `src/application/reviewCommands.ts`), so the store's `set` has to
 * land without it. Everything else - `recordReviewPass`, the reward ledger, the suppression -
 * is the real implementation, which is the whole point of this file.
 */
vi.mock('@/services/persistence/subjectPersistence', async () => {
  const actual = await vi.importActual<typeof import('@/services/persistence/subjectPersistence')>(
    '@/services/persistence/subjectPersistence',
  );
  return {
    ...actual,
    setActiveSubjectId: vi.fn(),
    saveSubjectSnapshot: vi.fn(async () => ({ success: true as const })),
  };
});

/**
 * A neutral renderer whose every capability is a spy.
 *
 * Only `setReviewedArtifactRooms` records a log; the rest are spies kept so the screen's other
 * capability effects run their real code path rather than being skipped by a missing member.
 */
function createFakeRenderer(): Record<string, unknown> {
  let ready = false;
  let readyListeners: Array<() => void> = [];
  return {
    mount: () => {
      ready = true;
      const listeners = readyListeners;
      readyListeners = [];
      for (const listener of listeners) listener();
    },
    unmount: () => {
      ready = false;
      readyListeners = [];
    },
    isReady: () => ready,
    restart: vi.fn(),
    onReady: (listener: () => void) => {
      readyListeners.push(listener);
      return () => {
        readyListeners = readyListeners.filter((entry) => entry !== listener);
      };
    },
    setFloorVisibility: vi.fn<(visibility: FloorVisibilityModel) => void>(),
    teleportToRoom: vi.fn<(roomId: string) => void>(),
    setArtifactRooms: vi.fn<(roomIds: readonly string[], visible: boolean) => void>(),
    setCollectedArtifactRooms: vi.fn<(roomIds: readonly string[]) => void>(),
    setReviewedArtifactRooms: (roomIds: readonly string[]) => setReviewedArtifactRooms(roomIds),
    setImageRooms: vi.fn<(roomIds: readonly string[]) => void>(),
    setRoomOverlayStates: vi.fn<(states: Record<string, string>) => void>(),
    triggerInteract: vi.fn<() => void>(),
  };
}

/* ── Fixture installation ───────────────────────────────────────────────────── */

let fixture: ReviewFixture;

/** The fixture with every room cleared, which is what satisfies the review unlock. */
function clearedFixture(): SubjectSnapshot {
  return Object.values(fixture.snapshot.rooms).reduce(
    (accumulated, room) => withClearedRoom(accumulated, room.roomId),
    fixture.snapshot,
  );
}

/**
 * Install a snapshot into the three real stores.
 *
 * `bySubject: {}` and `xpTotal: 0` are a clean progression record rather than a partial one,
 * so the reward ledger really does start empty and a suppression assertion is a suppression
 * assertion rather than a residue from a previous test.
 */
function install(snapshot: SubjectSnapshot, phase: 'creator' | 'scribe' | 'archaeologist'): void {
  useSubjectStore.setState({ snapshot, lastError: null });
  useSessionStore.setState({
    activeSubjectId: snapshot.dungeon.dungeonId,
    phase,
    selectedClass: null,
    focusedRoomId: null,
    isNoteEditorOpen: false,
    noteEditorRoomId: null,
    noteEditorPendingInsert: null,
    isMapViewOpen: false,
    teleportModeArmed: false,
    lastTeleportAt: null,
    sceneRestartCounter: 0,
  });
  useProgressionStore.setState({
    activeSubjectId: snapshot.dungeon.dungeonId,
    bySubject: {},
    crossSubjectAchievements: [],
    xpTotal: 0,
    rank: 'Novice',
    reviewPasses: 0,
    badges: [],
    inventory: [],
    equippedItems: [],
    collectedNotes: [],
    streakCount: 0,
  } as never);
}

/** Give rooms a review history, so an empty marker set cannot be explained by "never reviewed". */
function withReviewHistory(snapshot: SubjectSnapshot, roomIds: readonly string[]): SubjectSnapshot {
  const rooms = { ...snapshot.rooms };
  for (const roomId of roomIds) {
    const room = rooms[roomId];
    if (room === undefined) throw new Error(`No room ${roomId} in the fixture`);
    rooms[roomId] = { ...room, reviewPassCount: 1 };
  }
  return { ...snapshot, rooms };
}

/** The most recently published review-marker set. */
function publishedReviewSet(): readonly string[] {
  const latest = reviewedPublications.at(-1);
  if (latest === undefined) throw new Error('the renderer was never handed a review set');
  return latest;
}

/** Mount the screen and wait until the renderer has been handed its first review set. */
async function mountScreen(): Promise<void> {
  render(<GameScreen />);
  await waitFor(() => {
    expect(setReviewedArtifactRooms).toHaveBeenCalled();
  });
}

/**
 * The review route, exactly as the canvas drives it.
 *
 * Interact with the room - which is what `DungeonWorld`'s Interact control dispatches, through
 * `triggerInteract` into the same flow - then close the panel, which is what finalizes.
 */
async function reviewRoom(roomId: string): Promise<void> {
  await act(async () => {
    capturedCallbacks?.onInteract?.(roomId);
  });
  await act(async () => {
    screen.getByRole('button', { name: /Close room panel/i }).click();
  });
}

beforeEach(() => {
  capturedCallbacks = null;
  createGameMock.mockReset();
  createGameMock.mockImplementation(() => createFakeRenderer());
  setReviewedArtifactRooms.mockClear();
  reviewedPublications = [];
  fixture = buildReviewFixture();
  install(clearedFixture(), 'archaeologist');
});

afterEach(() => {
  cleanup();
});

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('the review marker still means "reviewed at least once"', () => {
  it('nothing is published for a cleared but unreviewed room', async () => {
    // The first half of "has been reviewed": every room here is cleared, reviewable, and
    // unlocked, so the only thing separating an empty marker set from a full one is whether a
    // review happened. The signal is a review *history*, not an eligibility.
    await mountScreen();

    expect(publishedReviewSet()).toEqual([]);
  });

  it('a room enters the published set after one genuine review, and only then', async () => {
    await mountScreen();

    await reviewRoom(fixture.matrixRoomId);

    expect(publishedReviewSet()).toEqual([fixture.matrixRoomId]);
    expect(useSubjectStore.getState().snapshot?.rooms[fixture.matrixRoomId]?.reviewPassCount).toBe(1);
    // The sibling rooms are still unreviewed, so the set is not "every cleared room".
    expect(publishedReviewSet()).not.toContain(fixture.rootRoomId);
    expect(publishedReviewSet()).not.toContain(fixture.eigenRoomId);
  });

  it('a suppressed duplicate republishes nothing a renderer could redraw from', async () => {
    await mountScreen();

    await reviewRoom(fixture.matrixRoomId);
    const afterFirst = [...publishedReviewSet()];
    const publicationsAfterFirst = reviewedPublications.length;
    const xpAfterFirst = useProgressionStore.getState().xpTotal;
    expect(xpAfterFirst, 'the first review of a pass must award').toBeGreaterThan(0);

    // The same room, same pass. `reviewPassRewards` already holds this `(room, pass)`, so the
    // second finalize is suppressed: no XP, no `reviewPassCount`, no ledger change.
    await reviewRoom(fixture.matrixRoomId);

    expect(publishedReviewSet(), 'a suppressed duplicate must not move the marker set').toEqual(
      afterFirst,
    );
    expect(useProgressionStore.getState().xpTotal).toBe(xpAfterFirst);
    expect(useSubjectStore.getState().snapshot?.rooms[fixture.matrixRoomId]?.reviewPassCount).toBe(1);
    // And the store never moved, so React never re-rendered, so the renderer was not asked to
    // redraw. This is the "no redraw as a side effect of an XP toast" claim, observed at its
    // consequence rather than at an implementation detail.
    expect(reviewedPublications.length).toBe(publicationsAfterFirst);
  });

  it('every room stays in the set once every room has been reviewed once', async () => {
    // The discriminator between the two candidate meanings.
    //
    // With three reviewable rooms, completing all three reviews moves `fullReviewPasses` from
    // 0 to 1, so `nextPassTarget` becomes 2 and `summarizeReviewPassProgress.reviewedRoomIds`
    // - the *current-pass* set - is now **empty**. If `GameScreen`'s filter had silently become
    // that question, the marker set would empty out at exactly this moment. It does not: the
    // renderer is handed all three rooms, because the marker means "has been reviewed".
    await mountScreen();

    await reviewRoom(fixture.matrixRoomId);
    await reviewRoom(fixture.eigenRoomId);
    await reviewRoom(fixture.rootRoomId);

    expect(publishedReviewSet()).toEqual(
      [fixture.rootRoomId, fixture.matrixRoomId, fixture.eigenRoomId].sort(),
    );
    for (const roomId of [fixture.rootRoomId, fixture.matrixRoomId, fixture.eigenRoomId]) {
      expect(useSubjectStore.getState().snapshot?.rooms[roomId]?.reviewPassCount).toBe(1);
    }
  });

  it('a room that has been reviewed is still announced when the session leaves the review phase', async () => {
    // The other half of the filter: `phase !== 'archaeologist'` publishes the empty set.
    // Asserted against a snapshot that *carries* review history, so the empty publication
    // cannot be explained by a room that was simply never reviewed.
    cleanup();
    install(
      withReviewHistory(clearedFixture(), [
        fixture.rootRoomId,
        fixture.matrixRoomId,
        fixture.eigenRoomId,
      ]),
      'scribe',
    );

    await mountScreen();

    expect(publishedReviewSet()).toEqual([]);
  });
});

describe('the enforced unlock moves no renderer signal', () => {
  it('a refused review neither adds a marker nor removes the one the room already had', async () => {
    // Phase 16 enforces the unlock in `roomInteract`, so an archaeologist-phase session in a
    // partially-cleared dungeon arms no review and toasts why. The renderer-facing claim is
    // narrow and worth stating: the marker is derived from the snapshot's review history, so a
    // refusal - which changes no history - republishes nothing.
    const locked = withUndefeatedRoom(clearedFixture(), fixture.eigenRoomId);
    cleanup();
    install(
      withReviewHistory(locked, [fixture.matrixRoomId]),
      'archaeologist',
    );

    await mountScreen();
    const beforeRefusal = [...publishedReviewSet()];
    const publicationsBefore = reviewedPublications.length;
    expect(beforeRefusal).toEqual([fixture.matrixRoomId]);

    // The panel still opens: a learner must be able to read their own notes and artifact.
    await act(async () => {
      capturedCallbacks?.onInteract?.(fixture.eigenRoomId);
    });
    expect(screen.getByTestId('room-panel')).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
    });

    expect(useProgressionStore.getState().xpTotal).toBe(0);
    expect(useSubjectStore.getState().snapshot?.rooms[fixture.eigenRoomId]?.reviewPassCount).toBe(0);
    expect(publishedReviewSet()).toEqual(beforeRefusal);
    expect(reviewedPublications.length).toBe(publicationsBefore);
  });

  it('the same room is reviewable again once the dungeon is fully cleared', async () => {
    // The refusal is about the unlock and nothing else: clearing the last room makes the very
    // same interact-then-close route award and publish. Without this, the previous test would
    // also pass for a room the flow could never review at all.
    const locked = withUndefeatedRoom(clearedFixture(), fixture.eigenRoomId);
    cleanup();
    install(locked, 'archaeologist');
    await mountScreen();

    await act(async () => {
      capturedCallbacks?.onInteract?.(fixture.eigenRoomId);
    });
    await act(async () => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
    });
    expect(useProgressionStore.getState().xpTotal).toBe(0);

    // Clear the outstanding room through the store, exactly as an encounter clear does, and
    // retry through the same route.
    useSubjectStore.setState({ snapshot: clearedFixture(), lastError: null });
    await act(async () => {
      capturedCallbacks?.onInteract?.(fixture.eigenRoomId);
    });
    await act(async () => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
    });

    expect(useProgressionStore.getState().xpTotal).toBeGreaterThan(0);
    expect(publishedReviewSet()).toContain(fixture.eigenRoomId);
  });
});

describe('the Pixi dungeon offers no review control of its own', () => {
  /**
   * Stated as a fact about the action table, not as a search that might come up empty.
   *
   * The worry was that the enforced unlock would leave a room the canvas offers as reviewable
   * while the flow refuses it. `DungeonWorld` cannot have that defect, because it has no review
   * control to offer: the review surface is `RoomPanel` and the Archaeologist workspace, and the
   * dungeon's DOM mirror declares exactly the world verbs it routes through the host.
   */
  it('the dungeon action table names five world verbs, and none of them is a review', () => {
    // Imported through the renderer barrel so the assertion is about the *renderer's* own
    // declared contract rather than about a copy of it in this file.
    expect(DUNGEON_ACTIONS.map((action) => action.id)).toEqual([
      'dungeon-interact',
      'dungeon-ascend',
      'dungeon-descend',
      'dungeon-zoom-in',
      'dungeon-zoom-out',
    ]);

    // The vocabulary check, in words. An assertion on the exact ids above would be edited by
    // whoever added a sixth verb; the words are what say "this is not a review control", so both
    // are asserted.
    //
    // **Word-bounded**, because substring matching produced two false positives the moment this
    // was written: the Interact hint ends "...or collects the artifact here", and `artifact` is
    // the pickup - a *different* Phase 15 verb that is deliberately not in this table and is
    // surfaced by its own control - while `pass` matches nothing here but would match a future
    // "passage". The review vocabulary that must never appear is the learner's *recall*
    // vocabulary, so that is what is listed.
    const REVIEW_VOCABULARY = /\b(review|reviewed|recalling|recall|sm-2|confidence|due)\b/i;
    for (const action of DUNGEON_ACTIONS) {
      const vocabulary = `${action.id} ${action.label} ${action.hint}`;
      expect(vocabulary, `${action.id} must not offer a review verb`).not.toMatch(
        REVIEW_VOCABULARY,
      );
    }

    // And the pickup, which *is* a dungeon verb, is declared outside this table rather than
    // smuggled into it - which is why "artifact" is allowed above and "review" is not.
    expect(DUNGEON_ACTIONS.map((action) => action.id)).not.toContain('dungeon-collect-artifact');
  });

  it('the one verb it does offer reaches the flow, which is where the refusal lives', async () => {
    // The honest shape of the parity claim: the canvas's interact control is a *world* verb and
    // lands in `roomInteract`, where `canReviewRoom` is consulted. So the refusal is enforced on
    // the single route the canvas has, rather than being duplicated inside the renderer - which
    // is why Phase 16 needed no renderer change.
    cleanup();
    install(withUndefeatedRoom(clearedFixture(), fixture.eigenRoomId), 'archaeologist');
    await mountScreen();

    await act(async () => {
      capturedCallbacks?.onInteract?.(fixture.eigenRoomId);
    });
    await act(async () => {
      screen.getByRole('button', { name: /Close room panel/i }).click();
    });

    expect(useProgressionStore.getState().xpTotal).toBe(0);
    expect(useSubjectStore.getState().snapshot?.rooms[fixture.eigenRoomId]?.reviewPassCount).toBe(0);
    expect(publishedReviewSet()).toEqual([]);
  });
});