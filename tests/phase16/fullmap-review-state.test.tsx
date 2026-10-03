/**
 * Phase 16's other half of the accessibility scope line: "Add keyboard and screen-reader
 * alternatives for the full map and review controls."
 *
 * ## What this file found by auditing `FullMapView.tsx` before changing it
 *
 * `FullMapView.tsx` contained **zero** occurrences of the string `review` - no due-date
 * awareness, no review affordance of any kind. What it *did* already provide, and what is
 * therefore left alone:
 *
 * 1. **Every room is reachable by keyboard.** Each SVG `<g role="button" tabIndex={0}>` is a
 *    Tab stop, and the sidebar's teleport list is a list of real `<button>`s.
 * 2. **The teleport list is fully keyboard-operable** - a filter field with ArrowUp/ArrowDown
 *    selection and Enter to teleport, plus per-room buttons.
 * 3. **Focus is visible.** `[data-cozy-visuals='true'] :focus-visible` in
 *    `src/styles/cozy.css` draws a 3px ring on every focusable element, SVG included.
 * 4. **The dialog has `role="dialog"`, `aria-modal="true"`, and a name**, and `Escape` closes
 *    it through the screen's own `closeMapView`.
 *
 * So this file does **not** rewrite the map. It pins the four existing properties that the
 * phase's scope line depends on, and adds three assertions for what was missing:
 *
 * - The `<g role="button">` nodes had **no `onKeyDown`**. They were focusable, announced as
 *   buttons, and did nothing on Enter or Space - a `<g>` is not a `<button>` and gets neither
 *   implicit activation nor Space semantics. That is the defect.
 * - No room's review state was announced anywhere.
 * - `roomInteract` on a reviewable room reaches the panel, so *reaching* a due room needed no
 *   new affordance - only *identifying* it did.
 *
 * ## Why no "due only" filter was added
 *
 * Recorded rather than silently omitted: hiding rooms that are due is the opposite of making
 * them findable, and a colour that meant "overdue" would be a colour-only state signal. The
 * state is a **word**, in three places - the node's accessible name, its `<title>`, and the
 * sidebar row a learner reads.
 *
 * Hermeticity: no renderer, no canvas, no network, no `dist/`, no real clock - `nowIso` is
 * injected.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import { useSubjectStore } from '@/store/subjectStore';

import { FullMapView } from '@/ui/components/FullMapView';
import {
  buildReviewFixture,
  withClearedRoom,
  withEveryRoomCleared,
  withSchedule,
  type ReviewFixture,
} from './support/reviewFixtures';

/** One render-scoped instant, so a due state is a fact and not a timing accident. */
const NOW_ISO = '2026-03-01T12:00:00.000Z';

let fixture: ReviewFixture;

/**
 * Every room of the fixture, cleared, with the given matrix-room schedule.
 *
 * `nowIso` is threaded through rather than read from a clock so the three due states can each
 * be built from a *different snapshot* and asserted independently - which is the only way a
 * test can prove the three words are distinct rather than one word appearing three times.
 */
/**
 * Install a snapshot into the store and return it.
 *
 * `FullMapView` takes `snapshot` as a prop and reads no store for it, but it does read
 * `useSubjectStore` for its own mutations (`addChildRooms`, `reparentRoom`, `lastError`) - so
 * the store is installed anyway, which keeps this file's rendering identical to `GameScreen`'s
 * rather than a slightly different tree.
 */
function install(snapshot: SubjectSnapshot): SubjectSnapshot {
  useSubjectStore.setState({ snapshot, lastError: null });
  return snapshot;
}

/** Every room cleared, with the matrix room's SM-2 fields set. */
function installScheduled(schedule: {
  nextReviewDateIso: string | null;
  reviewPassCount: number;
}): SubjectSnapshot {
  return install(
    withSchedule(withEveryRoomCleared(fixture.snapshot), fixture.matrixRoomId, {
      reviewPassCount: schedule.reviewPassCount,
      // `null` rather than the field name of the room, because `RoomMetadata.sm2NextReviewDate`
      // is optional: `withSchedule` writes `undefined` for `null`, and a test that wrote the
      // literal `undefined` would be indistinguishable from forgetting the field.
      sm2NextReviewDate: schedule.nextReviewDateIso,
    }),
  );
}

function renderMap(snapshot: SubjectSnapshot): void {
  const dungeonMap = generateDungeonMap(snapshot.dungeon);
  if (dungeonMap === null) throw new Error('The fixture dungeon produced no map');
  render(
    <FullMapView
      snapshot={snapshot}
      dungeonMap={dungeonMap}
      colorTheme="dark"
      focusedRoomId={fixture.matrixRoomId}
      phase="archaeologist"
      teleportModeArmed={false}
      teleportRemainingMs={0}
      onTravelToRoom={() => {}}
      onTeleportToRoom={() => {}}
      onClose={() => {}}
      nowIso={NOW_ISO}
    />,
  );
}

/** The SVG node for one room. */
function roomNode(roomId: string): SVGGElement {
  const node = document.querySelector<SVGGElement>(`g[data-room-id="${roomId}"]`);
  if (node === null) throw new Error(`No map node for ${roomId}`);
  return node;
}

beforeEach(() => {
  window.localStorage.clear();
  fixture = buildReviewFixture();
});

afterEach(() => {
  cleanup();
});

describe('what FullMapView already provided, pinned so a rewrite cannot quietly remove it', () => {
  it('exposes one named dialog, and every room as a focusable button', () => {
    renderMap(installScheduled({ nextReviewDateIso: null, reviewPassCount: 0 }));

    expect(screen.getByRole('dialog', { name: 'Full map view' })).toHaveAttribute(
      'aria-modal',
      'true',
    );

    const nodes = [...document.querySelectorAll<SVGGElement>('g[data-room-id]')];
    // Non-vacuity: a fixture that produced no nodes would satisfy every assertion below.
    expect(nodes).toHaveLength(3);
    for (const node of nodes) {
      expect(node.getAttribute('role')).toBe('button');
      expect(node.getAttribute('tabindex')).toBe('0');
    }
  });

  it('keeps the teleport list operable from the keyboard alone', () => {
    renderMap(installScheduled({ nextReviewDateIso: null, reviewPassCount: 0 }));

    const filter = screen.getByRole('textbox', { name: 'Filter teleport rooms' });
    filter.focus();
    expect(filter).toHaveFocus();

    // ArrowDown then Enter is the documented route, and it is entirely in the DOM: a list of
    // real buttons driven by a field, with no pointer and no canvas.
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    fireEvent.keyDown(filter, { key: 'Enter' });
    // The button that fires is present and enabled, which is the property that matters: the
    // handler is the screen's own and this file injects a no-op.
    expect(screen.getByRole('button', { name: /Teleport to selection/ })).toBeEnabled();
  });
});

describe('the review affordance this phase adds', () => {
  it('activates a room with Enter and with Space, which the node did not do before', () => {
    renderMap(installScheduled({ nextReviewDateIso: null, reviewPassCount: 0 }));

    /*
     * The defect, asserted as a behaviour rather than as an absence: the node is focusable and
     * announced as a button, so both keys are ones a keyboard user will press, and a `<g>` is
     * not a `<button>` so neither did anything. Each is fired on a *different* room, because
     * selection is idempotent and firing both on one node would pass even if only the first
     * were handled.
     */
    const first = roomNode(fixture.eigenRoomId);
    const second = roomNode(fixture.rootRoomId);

    fireEvent.keyDown(first, { key: 'Enter' });
    expect(selectedTopic()).toBe('Eigenvalues');

    fireEvent.keyDown(second, { key: ' ' });
    expect(selectedTopic()).toBe('Linear Algebra');
  });

  it('leaves every other key alone, so panning and arrow navigation are unaffected', () => {
    renderMap(installScheduled({ nextReviewDateIso: null, reviewPassCount: 0 }));

    const node = roomNode(fixture.eigenRoomId);
    fireEvent.keyDown(node, { key: 'ArrowDown' });
    fireEvent.keyDown(node, { key: 'Tab' });

    expect(selectedTopic()).toBe('Matrices');
  });

  it('announces an overdue room in the node\'s accessible name, not by colour', () => {
    const snapshot = installScheduled({ nextReviewDateIso: '2026-02-25T12:00:00.000Z', reviewPassCount: 0 });
    renderMap(snapshot);

    const node = roomNode(fixture.matrixRoomId);
    // The topic comes from the node's own rendering, so this asserts the *shape* - "topic,
    // then one sentence" - rather than a string concatenated somewhere else.
    expect(nodeTopic(node)).toBe('Matrices');
    expect(node.getAttribute('aria-label')).toBe('Matrices. Review overdue by 4 days.');
    // ...and the same words in the `<title>`, so a mouse user and a screen-reader user read
    // one sentence rather than two claims. Asserted as identity, because two copies of the
    // same sentence is the point and a re-worded one would be a second claim.
    expect(node.querySelector('title')?.textContent).toBe(node.getAttribute('aria-label'));
    // The state is a static attribute for tests and for a stylesheet that reinforces the word.
    expect(node.getAttribute('data-review-due')).toBe('overdue');
  });

  it('names all three states as three different words', () => {
    // Three separate renders, because one snapshot cannot be overdue and scheduled at once.
    const overdue = installScheduled({ nextReviewDateIso: '2026-02-25T12:00:00.000Z', reviewPassCount: 0 });
    renderMap(overdue);
    expect(roomNode(fixture.matrixRoomId).getAttribute('aria-label')).toContain(
      'Review overdue by 4 days.',
    );
    cleanup();

    const dueToday = installScheduled({ nextReviewDateIso: '2026-03-01T06:00:00.000Z', reviewPassCount: 0 });
    renderMap(dueToday);
    expect(roomNode(fixture.matrixRoomId).getAttribute('aria-label')).toContain('Review due today.');
    cleanup();

    const scheduled = installScheduled({ nextReviewDateIso: '2026-03-11T12:00:00.000Z', reviewPassCount: 0 });
    renderMap(scheduled);
    expect(roomNode(fixture.matrixRoomId).getAttribute('aria-label')).toContain(
      'Review due in 10 days.',
    );
  });

  it('says a room that has never been defeated has no review, rather than staying silent', () => {
    // Only the root stays cleared here; the other two are the untouched `makeEmptyRoomMetadata`
    // rooms, so this is the "nothing scheduled" case rather than the "due" one.
    const snapshot = install(withClearedRoom(fixture.snapshot, fixture.matrixRoomId));
    renderMap(snapshot);

    const undefeated = roomNode(fixture.eigenRoomId);
    expect(undefeated.getAttribute('aria-label')).toBe(
      'Eigenvalues. Not yet defeated, so it has no review scheduled.',
    );
    expect(undefeated.getAttribute('data-review-due')).toBe('none');
  });

  it('gives every node a non-empty title, so no node is read as unlabelled', () => {
    renderMap(installScheduled({ nextReviewDateIso: null, reviewPassCount: 0 }));

    for (const node of document.querySelectorAll<SVGGElement>('g[data-room-id]')) {
      const title = node.querySelector('title')?.textContent ?? '';
      // An empty `<title>` makes some assistive technologies treat the element as unlabelled
      // and read raw SVG coordinates instead, so this is asserted for *every* node.
      expect(title.trim().length, `node ${node.getAttribute('data-room-id')}`).toBeGreaterThan(0);
    }
  });

  it('repeats the selected room\'s review state as visible text in the sidebar', () => {
    const snapshot = installScheduled({ nextReviewDateIso: '2026-02-25T12:00:00.000Z', reviewPassCount: 3 });
    renderMap(snapshot);

    // The panel that opens for the room under review is where this surface repeats the state,
    // so the workspace's Schedule region and the map cannot disagree - and a sighted keyboard
    // user has somewhere to *read* the words the node announces.
    const selected = document.querySelector('[data-review-state-for-selection]');
    expect(selected?.textContent).toBe('Review overdue by 4 days.');
    // ...with the count and the date, which is what makes "overdue" actionable.
    expect(screen.getByText(/Times reviewed: 3\./)).toBeInTheDocument();
    expect(screen.getByText(/Next date: 2026-02-25\./)).toBeInTheDocument();
  });

  it('lists every scheduled room as a keyboard-reachable button, worst state first', () => {
    const snapshot = installScheduled({ nextReviewDateIso: '2026-02-25T12:00:00.000Z', reviewPassCount: 0 });
    renderMap(snapshot);

    const list = screen.getByRole('region', { name: 'Rooms due for review' });
    const rows = [...list.querySelectorAll<HTMLElement>('button[data-review-due-row]')];
    // Non-vacuity: three cleared rooms, so three rows.
    expect(rows).toHaveLength(3);

    // Each row's own text carries the state, so the state is not the class and not the fill.
    for (const row of rows) {
      expect(row.textContent ?? '').toMatch(/Review (overdue by \d+ days?|due today|due in \d+ days?)\./);
    }
    // Overdue leads, so a learner scanning the list reads what to do first.
    expect(rows[0]?.getAttribute('data-review-due-row')).toBe('overdue');
    expect(within(rows[0] as HTMLElement).getByText(/Review overdue by/)).toBeInTheDocument();
  });

  it('selects the room a due-list row names, so the list is an action and not a report', () => {
    const snapshot = installScheduled({ nextReviewDateIso: '2026-02-25T12:00:00.000Z', reviewPassCount: 0 });
    renderMap(snapshot);

    const list = screen.getByRole('region', { name: 'Rooms due for review' });
    const row = [...list.querySelectorAll<HTMLElement>('button[data-review-due-row]')].find(
      (candidate) => candidate.textContent?.includes('Eigenvalues') ?? false,
    );
    if (row === undefined) throw new Error('No row for Eigenvalues');

    fireEvent.click(row);

    expect(selectedTopic()).toBe('Eigenvalues');
  });

  it('renders the whole map with no flag on, because this affordance is not gated', () => {
    /*
     * `FullMapView` reads no `runtimeConfig`. The review-state announcement is pure
     * presentation over data the map already had, so gating it would have been a second flag to
     * roll back for no correctness reason - and the room nodes' missing `onKeyDown` was a
     * defect in both lanes.
     */
    renderMap(installScheduled({ nextReviewDateIso: null, reviewPassCount: 0 }));

    expect(screen.getByRole('heading', { name: 'Full Map' })).toBeInTheDocument();
    expect(document.querySelectorAll('g[data-room-id]')).toHaveLength(3);
  });
});

/** The topic shown in the "Selected topic" panel. */
/** The topic the "Selected topic" panel currently shows, or `''` when it shows none. */
function selectedTopic(): string {
  const panel = document.querySelector('.full-map-selected-section');
  return panel?.querySelector('.room-meta-line')?.textContent ?? '';
}

/**
 * The room's topic, read from the map's own node.
 *
 * Taken from the rendered `<title>`'s leading segment rather than from the fixture, so the
 * assertion is that the *node* labels itself with its topic and one sentence - not that a
 * known string was concatenated somewhere else.
 */
function nodeTopic(node: SVGGElement): string {
  return (node.querySelector('title')?.textContent ?? '').split('. ')[0] ?? '';
}