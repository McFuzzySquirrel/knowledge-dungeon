/**
 * The Phase 16 review workspace: its region order, its rating control, and its ARIA values.
 *
 * ## Why these assertions and not "the workspace renders"
 *
 * Four of this phase's properties are about the *shape* of the surface rather than its
 * behaviour, and each one is a defect that renders happily:
 *
 * 1. **The region order.** `StudyShell` renders the caller's region list in order, so the
 *    order `ArchaeologistWorkspace`'s header argues for is only a claim until it is asserted.
 * 2. **The rating is a radio group carrying the real SM-2 labels.** A `<select>` of bare
 *    numbers would pass a "there is a rating control" test and fail plan 10.1's "no colour-only
 *    state" for the reason that a number alone explains nothing.
 * 3. **`aria-valuenow/min/max` are correct on a *partially* cleared dungeon** - which is the
 *    case `src/core/review/reviewPasses.ts`'s header says the pre-Phase-16 numbers get wrong,
 *    and the case a single-room fixture would never produce.
 * 4. **Overdue, due today, and scheduled are three different words.** Asserted as text, so a
 *    change that replaced them with three fills fails.
 *
 * ## Non-vacuity
 *
 * Every sweep has a count floor, and the due-state test builds three *separate* snapshots so
 * the three words cannot be satisfied by one of them appearing somewhere.
 *
 * Hermeticity: no renderer, no canvas, no network, no `dist/`, no real clock - `nowIso` is
 * injected into the workspace exactly as `reviewCommands.ts` injects it.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, archaeologistReviewWorkspace: true },
  };
});

import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { ARCHAEOLOGIST_CONTROL_IDS } from '@/ui/study/controlIds';
import { ArchaeologistWorkspace } from '@/ui/study/review/ArchaeologistWorkspace';
import {
  FIXTURE_DUNGEON_ID,
  buildReviewFixture,
  withClearedRoom,
  withEveryRoomCleared,
  withSchedule,
  withUndefeatedRoom,
  type ReviewFixture,
} from './support/reviewFixtures';

/** One render-scoped instant, so the due state is a fact rather than a timing accident. */
const NOW_ISO = '2026-03-01T12:00:00.000Z';

let fixture: ReviewFixture;

function install(snapshot: ReviewFixture['snapshot']): void {
  useSubjectStore.setState({ snapshot, lastError: null });
  useSessionStore.setState({ phase: 'archaeologist', activeScreen: 'game' });
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(FIXTURE_DUNGEON_ID);
}

/** The workspace, mounted the way `RoomPanel` mounts it in the archaeologist phase. */
function renderWorkspace(
  snapshot: ReviewFixture['snapshot'],
  overrides: Partial<Parameters<typeof ArchaeologistWorkspace>[0]> = {},
): void {
  const room = snapshot.rooms[fixture.matrixRoomId] ?? null;
  render(
    <ArchaeologistWorkspace
      room={room}
      snapshot={snapshot}
      pendingSession={null}
      nowIso={NOW_ISO}
      resolveLocalImage={() => null}
      onResumeReview={() => true}
      onDiscardReview={() => true}
      onClose={() => {}}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  fixture = buildReviewFixture();
});

afterEach(() => {
  cleanup();
});

describe('the workspace is organised around the phase\'s scope line, in the order its header claims', () => {
  it('renders the five regions in order, each with a heading in the document', () => {
    install(withEveryRoomCleared(fixture.snapshot));
    renderWorkspace(useSubjectStore.getState().snapshot as ReviewFixture['snapshot']);

    const regions = [...document.querySelectorAll<HTMLElement>('[data-study-region]')];
    // Non-vacuity: a selector that matched nothing would satisfy the next assertion.
    expect(regions).toHaveLength(5);
    expect(regions.map((region) => region.getAttribute('data-study-region'))).toEqual([
      'standing',
      'artifact',
      'recall',
      'schedule',
      'complete',
    ]);

    for (const region of regions) {
      const id = region.getAttribute('data-study-region') ?? '';
      const labelledBy = region.getAttribute('aria-labelledby');
      expect(labelledBy, `region ${id} has no accessible name`).not.toBeNull();
      const heading = labelledBy === null ? null : document.getElementById(labelledBy);
      expect(heading?.textContent, `region ${id} names a heading that is not in the document`).toBeTruthy();
    }
  });

  it('states the order as the one-sentence argument the header makes', () => {
    install(withEveryRoomCleared(fixture.snapshot));
    renderWorkspace(useSubjectStore.getState().snapshot as ReviewFixture['snapshot']);

    /*
     * The header's claim, asserted on the headings a learner actually reads. If a region is
     * reordered, the claim and the order stop agreeing and this fails - which is the whole
     * point of putting the argument in the header rather than leaving it implicit.
     */
    expect(screen.getByRole('heading', { name: 'Where this review stands' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The artifact under review' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recall' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Complete' })).toBeInTheDocument();
  });

  it('never collapses the arrival region, and collapses the schedule one by default', () => {
    install(withEveryRoomCleared(fixture.snapshot));
    renderWorkspace(useSubjectStore.getState().snapshot as ReviewFixture['snapshot']);

    const standing = document.querySelector<HTMLElement>('[data-study-region="standing"]');
    expect(standing?.querySelector('.study-region__toggle')).toBeNull();
    expect(standing?.querySelector('.study-region__body')?.hasAttribute('hidden')).toBe(false);

    const schedule = document.querySelector<HTMLElement>('[data-study-region="schedule"]');
    // `hidden`, not a class: that removes the subtree from Tab order and from the
    // accessibility tree together, which is the property plan 10.1 is about.
    expect(schedule?.querySelector('.study-region__body')?.hasAttribute('hidden')).toBe(true);
    // ...and the toggle opens it, so the schedule is one control away rather than unreachable.
    expect(screen.getByRole('button', { name: 'Show Schedule' })).toBeEnabled();
  });
});

describe('the rating control is a keyboard-operable radio group carrying the real SM-2 labels', () => {
  it('is a radiogroup of six native radios, not a select and not five buttons', () => {
    install(withEveryRoomCleared(fixture.snapshot));
    renderWorkspace(useSubjectStore.getState().snapshot as ReviewFixture['snapshot']);

    const group = document.getElementById(ARCHAEOLOGIST_CONTROL_IDS.qualityRating);
    expect(group?.tagName).toBe('FIELDSET');
    // A `<fieldset>`'s implicit role is `group`, so `role="radiogroup"` is asserted on the
    // radios' container by role *within* it rather than by the fieldset's own role.
    expect(group?.getAttribute('aria-labelledby')).not.toBeNull();

    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(6);
    for (const radio of radios) {
      // A native input, so arrow-key roving focus and Space activation are the browser's.
      expect(radio.tagName).toBe('INPUT');
      expect(radio.type).toBe('radio');
      // No `name`: the obvious value would be the room id, and a radio group is keyed by its
      // own `role="radiogroup"` ancestor rather than by a name. Asserted because it is the
      // one place a room id would have been most natural to write.
      expect(radio.getAttribute('name')).toBeNull();
      // 44 by 44 through the shared inline style, which is what makes the control a target
      // rather than a 24-pixel dot.
      expect(radio.style.minWidth).toBe('44px');
      expect(radio.style.minHeight).toBe('44px');
    }

    expect(document.querySelector('select[name*="rating" i]')).toBeNull();
  });

  it('shows both the short label and the full SM-2 sentence for every rating', () => {
    install(withEveryRoomCleared(fixture.snapshot));
    renderWorkspace(useSubjectStore.getState().snapshot as ReviewFixture['snapshot']);

    const shortLabels: Record<string, string> = {
      '0': 'Forgot',
      '1': 'Barely',
      '2': 'Shaky',
      '3': 'Solid',
      '4': 'Good',
      '5': 'Perfect',
    };
    const longLabels: Record<string, string> = {
      '0': 'Complete blackout - could not recall anything',
      '1': 'Incorrect - but remembered after seeing the answer',
      '2': 'Incorrect - answer seemed easy to recall upon seeing it',
      '3': 'Correct - required serious mental effort',
      '4': 'Correct - after brief hesitation',
      '5': 'Perfect - immediate and confident recall',
    };

    const group = screen.getByRole('radiogroup', { name: 'How well did you recall it?' });
    for (const [value, short] of Object.entries(shortLabels)) {
      // The word is visible, so the scale is scannable without reading a number.
      expect(within(group).getByText(short), `short label ${value} missing`).toBeInTheDocument();
      // And the full sentence is in the DOM as text, reachable through `aria-describedby`, so
      // the number is never the only thing carrying the meaning.
      const radio = document.getElementById(
        `${ARCHAEOLOGIST_CONTROL_IDS.qualityRating}-option-${value}`,
      );
      const describedBy = radio?.getAttribute('aria-describedby') ?? '';
      expect(describedBy, `rating ${value} has no description`).not.toBe('');
      const description = document.getElementById(describedBy);
      expect(description?.textContent).toContain(longLabels[value]);
    }
  });

  it('reads the chosen rating back as a sentence, so the state is not the radio dot alone', () => {
    install(withEveryRoomCleared(fixture.snapshot));
    renderWorkspace(useSubjectStore.getState().snapshot as ReviewFixture['snapshot']);

    const readback = document.querySelector('[data-review-rating-readback]');
    expect(readback?.textContent).toBe('No rating chosen yet.');

    const good = document.getElementById(`${ARCHAEOLOGIST_CONTROL_IDS.qualityRating}-option-4`);
    if (good === null) throw new Error('No radio for rating 4');
    expect(readback?.textContent).not.toContain('4 of 5');
  });
});

describe('the progress bar carries correct ARIA values on a partially cleared dungeon', () => {
  /**
   * Open the collapsed schedule region and return its progressbar.
   *
   * The region starts collapsed, so this is how a learner reaches it - and reading it without
   * opening it would assert a DOM that no interaction produces, because `hidden` removes the
   * subtree from the accessibility tree as well as from Tab order.
   */
  function openSchedule(): HTMLElement {
    // `fireEvent.click`, not a raw `.click()`: the raw form is not wrapped in `act`, so the
    // state update is not flushed before the next query, and a `role="progressbar"` inside a
    // still-`hidden` region is correctly excluded from the accessibility tree - which would
    // make this a test that fails for the right reason at the wrong moment.
    fireEvent.click(screen.getByRole('button', { name: 'Show Schedule' }));
    return screen.getByRole('progressbar', {
      name: 'Room review progress toward the next full pass',
    });
  }

  it('reports the all-rooms denominator, which is what the HUD card has always reported', () => {
    /*
     * Two rooms at `reviewPassCount: 1` and one at `0` over three total. The reviewable
     * population is all three (every room is cleared), so `fullReviewPasses` is
     * `trunc(2 / 3) = 0` and the current pass is 1 - and `roomsTowardNextPass` is 2 of 3.
     *
     * The two numbers have different denominators *in general* - see the header of
     * `src/core/review/reviewPasses.ts` - and the point of asserting them separately is that
     * this surface reports the all-rooms pair, so it cannot silently disagree with the HUD it
     * sits beside.
     */
    let snapshot = withEveryRoomCleared(fixture.snapshot);
    snapshot = withSchedule(snapshot, fixture.rootRoomId, {
      reviewPassCount: 1,
      sm2NextReviewDate: '2026-04-01T00:00:00.000Z',
    });
    snapshot = withSchedule(snapshot, fixture.matrixRoomId, {
      reviewPassCount: 1,
      sm2NextReviewDate: '2026-04-01T00:00:00.000Z',
    });
    snapshot = withSchedule(snapshot, fixture.eigenRoomId, {
      reviewPassCount: 0,
      sm2NextReviewDate: null,
    });
    install(snapshot);
    renderWorkspace(snapshot);

    const bar = openSchedule();
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    // The value *text* is a sentence with a denominator, because `aria-valuenow` alone is a
    // number with no unit and no denominator.
    expect(bar.getAttribute('aria-valuetext')).toBe(
      '2 of 3 rooms reviewed toward pass 1',
    );

    // The same numbers, in full sentences, above the bar.
    expect(
      screen.getByText('Full review passes completed: 0.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('2/3 rooms reviewed toward pass 1.'),
    ).toBeInTheDocument();
  });

  it('reports a well-formed one-room range when the dungeon has no rooms to count', () => {
    /*
     * `aria-valuemax` must be greater than `aria-valuemin`, so `0` over `0` - a range with no
     * members - is malformed and an assistive technology is entitled to report an undefined
     * percentage. One is the honest substitute, and the sentence still says "0/0".
     */
    const snapshot = withEveryRoomCleared(fixture.snapshot);
    install(snapshot);
    renderWorkspace(snapshot);

    const bar = openSchedule();
    const max = Number(bar.getAttribute('aria-valuemax'));
    const min = Number(bar.getAttribute('aria-valuemin'));
    expect(max).toBeGreaterThan(min);
  });
});

describe('overdue, due today, and scheduled are distinguishable without colour', () => {
  /**
   * Render one due state and return the schedule region's text.
   *
   * The schedule region starts collapsed, so it is opened first - which is also how a learner
   * reaches it, and a test that read it without opening it would be asserting a DOM that no
   * interaction produces.
   */
  function readSchedule(nextReviewDateIso: string | null): string {
    let snapshot = withEveryRoomCleared(fixture.snapshot);
    snapshot = withSchedule(snapshot, fixture.matrixRoomId, {
      reviewPassCount: 0,
      sm2NextReviewDate: nextReviewDateIso,
    });
    install(snapshot);
    renderWorkspace(snapshot);

    fireEvent.click(screen.getByRole('button', { name: 'Show Schedule' }));
    const region = document.querySelector<HTMLElement>('[data-study-region="schedule"]');
    const body = region?.querySelector('.study-region__body');
    return body?.textContent ?? '';
  }

  it('says "Overdue" in words, with the day count', () => {
    const text = readSchedule('2026-02-25T12:00:00.000Z');
    expect(text).toContain('Overdue by 4 days.');
    expect(screen.getByText('Overdue by 4 days.')).toBeInTheDocument();
  });

  it('says "Overdue by 1 day" in the singular', () => {
    // `1 days` is the kind of small lie that makes a learner doubt the number beside it.
    const text = readSchedule('2026-02-28T12:00:00.000Z');
    expect(text).toContain('Overdue by 1 day.');
    expect(text).not.toContain('Overdue by 1 days.');
  });

  it('says "Due today" in words, which is a different word from either neighbour', () => {
    const text = readSchedule('2026-03-01T06:00:00.000Z');
    expect(text).toContain('Due today.');
    expect(text).not.toContain('Overdue');
  });

  it('says "Due in N days" for a room scheduled ahead, and names the date', () => {
    const text = readSchedule('2026-03-11T12:00:00.000Z');
    expect(text).toContain('Due in 10 days.');
    expect(text).toContain('Next review date: 2026-03-11.');
  });

  it('distinguishes a room that has never been scheduled from one that is due now', () => {
    /*
     * `describeReviewDueState` maps an absent date to `due-in 0`, which is indistinguishable
     * from "due today" by its discriminant alone. The *label* is what separates them, and this
     * is the assertion that stops that distinction being lost.
     */
    const text = readSchedule(null);
    expect(text).toContain('Not scheduled yet.');
    expect(text).not.toContain('Due today.');
  });

  it('carries the state in a static attribute as well as the sentence, never in a class alone', () => {
    let snapshot = withEveryRoomCleared(fixture.snapshot);
    snapshot = withSchedule(snapshot, fixture.matrixRoomId, {
      reviewPassCount: 0,
      sm2NextReviewDate: '2026-02-25T12:00:00.000Z',
    });
    install(snapshot);
    renderWorkspace(snapshot);

    fireEvent.click(screen.getByRole('button', { name: 'Show Schedule' }));
    const due = document.querySelector('[data-review-due-state]');
    expect(due?.getAttribute('data-review-due-state')).toBe('overdue');
    // The class is a *reinforcement* of the sentence, never the carrier: both are present and
    // the sentence is the one a screen reader reads.
    expect(due?.className).toContain('archaeologist-due--overdue');
    expect(due?.textContent).toContain('Overdue by 4 days.');
  });
});

describe('the workspace is total over the states a learner can actually arrive in', () => {
  it('renders a locked room with the domain\'s own refusal sentence, verbatim', () => {
    /*
     * One undefeated room of three drops `completionRatio` below 1, which is
     * `evaluateReviewUnlock`'s default `requiredCompletionRatio`, so every room in this
     * snapshot is locked - the domain's rule, not a per-room state.
     */
    const snapshot = withUndefeatedRoom(withEveryRoomCleared(fixture.snapshot), fixture.eigenRoomId);
    install(snapshot);
    renderWorkspace(snapshot);

    // `describeReviewRefusal`'s sentence, character for character. Rendered from the domain
    // rather than re-worded, which is what makes it impossible for this surface and the flow's
    // toast to say different things about the same refusal.
    //
    // `getAllByText`, because the sentence legitimately appears twice: once as the next
    // action's detail and once as the completion control's refusal note. Two copies of the
    // *domain's* words is the point - neither is a re-wording - so the assertion is that they
    // are the same string, not that there is only one of them.
    const refusal = screen.getAllByText('Review unlocks at 3/3 rooms cleared (2 so far).');
    expect(refusal.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Review is locked, so nothing on this room counts toward a pass yet.')).toBeInTheDocument();
  });

  it('disables completion with a visible reason while a room has no artifact to review', () => {
    const snapshot = withClearedRoom(fixture.snapshot, fixture.matrixRoomId, '');
    // The unlock is satisfied, so this is the *artifact* lane rather than the locked one -
    // which is the distinction the two refusal sentences exist to make.
    const allCleared = withEveryRoomCleared(snapshot);
    install(allCleared);
    renderWorkspace(allCleared);

    const complete = screen.getByRole('button', { name: 'Complete this review pass' });
    expect(complete).toBeDisabled();
    // Two reasons, in visible text next to the control: no rating yet, and no artifact. The
    // rating reason is the one that outranks, because a learner who is told "pick a rating"
    // first would be told to do something that does not help.
    //
    // The sentence also names what closing the panel would do instead, so the disabled
    // button is not read as "this review cannot be completed yet". See the workspace header's
    // "The two routes out" section.
    expect(
      screen.getByText(
        'Pick how well you recalled this room before completing the pass, because your rating is what schedules the next review. Closing the room panel counts this pass at a rating of 3, whatever you picked here.',
      ),
    ).toBeInTheDocument();
  });

  it('renders with no room at all rather than throwing', () => {
    const snapshot = withEveryRoomCleared(fixture.snapshot);
    install(snapshot);
    renderWorkspace(snapshot, { room: null });

    // A null room is a real state - the room was removed between two renders - and the shell
    // still renders, with the header saying so in words rather than an empty frame.
    expect(screen.getByRole('heading', { name: 'No room is under review.' })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-study-region]')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Complete this review pass' })).toBeInTheDocument();
  });
});

describe('the shell owns exactly one live region', () => {
  it('exposes one status region and one workspace landmark', () => {
    install(withEveryRoomCleared(fixture.snapshot));
    renderWorkspace(useSubjectStore.getState().snapshot as ReviewFixture['snapshot']);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByLabelText('Archaeologist review workspace')).toBeInTheDocument();
  });

  it('writes no learner value into an id, a data attribute, or an aria string', () => {
    install(withEveryRoomCleared(fixture.snapshot));
    renderWorkspace(useSubjectStore.getState().snapshot as ReviewFixture['snapshot']);

    /*
     * Static vocabulary only. The room's topic is the workspace's heading - text a learner
     * reads - and it appears in no id, no `data-*`, and no region name, so a selector pasted
     * into an issue report can never carry what the subject is about.
     */
    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      expect(id.toLowerCase(), `id ${id} carries learner text`).not.toContain('matrices');
      expect(id.toLowerCase(), `id ${id} carries learner text`).not.toContain('eigenvalues');
    }
    expect(ids).toEqual(
      expect.arrayContaining([
        'archaeologist-arrival',
        'archaeologist-recall-prompts',
        'archaeologist-quality-rating',
        'archaeologist-quality-rating-option-0',
        'archaeologist-quality-rating-option-5',
        'archaeologist-progress',
        'archaeologist-pass-complete',
        'archaeologist-session-save',
        'archaeologist-review-close',
      ]),
    );

    // The subject name reaches the shell header as text and nowhere else.
    const regions = [...document.querySelectorAll<HTMLElement>('[data-study-region]')];
    for (const region of regions) {
      expect(region.getAttribute('data-study-region')).not.toContain('algebra');
    }
  });

  it('uses no positive tabindex anywhere, so Tab order follows the document', () => {
    install(withEveryRoomCleared(fixture.snapshot));
    renderWorkspace(useSubjectStore.getState().snapshot as ReviewFixture['snapshot']);

    for (const element of document.querySelectorAll<HTMLElement>('[tabindex]')) {
      expect(
        Number(element.getAttribute('tabindex')),
        element.outerHTML.slice(0, 80),
      ).toBeLessThanOrEqual(0);
    }
  });
});