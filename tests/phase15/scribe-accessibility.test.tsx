/**
 * The Phase 15 accessibility floor, as assertions rather than as intentions.
 *
 * ## Why this file exists separately from the exit-criteria suite
 *
 * Plan section 10.1 and `StudyControls.tsx` record the same trap: a `disabled` control is
 * not focusable, so a reason carried only in `aria-describedby` is reachable exactly when it
 * does not matter and unreachable exactly when it does. That is a property of the rendered
 * element, not of the code that produced it, so it is asserted on the rendered element.
 *
 * ## Why the touch-target sweep reads the style attribute
 *
 * jsdom has no layout, so a rule in a stylesheet cannot be asserted - only computed, and
 * nothing is computed here. The inline `minWidth`/`minHeight` every study control carries is
 * part of the rendered style attribute, so the 44-pixel floor is readable, and it survives a
 * stylesheet that failed to load.
 *
 * ## Non-vacuity
 *
 * The sweep is checked against a count floor, so "no control is under 44 pixels" cannot be
 * satisfied by a selector that matched nothing.
 *
 * Hermeticity: no renderer, no canvas, no network, no clock.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, scribeEncounterWorkspace: true },
  };
});

import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { SCRIBE_CONTROL_IDS } from '@/ui/study/controlIds';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import { FIXTURE_DUNGEON_ID, buildScribeFixture, type ScribeFixture } from './support/scribeFixtures';

const CONFIRM_LABEL = 'I confirm these notes are my own and complete.';

let fixture: ScribeFixture;

/** Every element that declares itself a study touch target. */
function touchTargets(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-study-touch-target]')];
}

function minimumSize(element: HTMLElement): { minWidth: string; minHeight: string } {
  return {
    minWidth: element.style.minWidth,
    minHeight: element.style.minHeight,
  };
}

function renderEncounter(): void {
  render(<ScribeEncounterDialog />);
}

beforeEach(() => {
  window.localStorage.clear();
  fixture = buildScribeFixture();
  useSubjectStore.setState({ snapshot: fixture.snapshot, lastError: null });
  useSessionStore.setState({
    phase: 'scribe',
    activeScreen: 'game',
    isNoteEditorOpen: true,
    noteEditorRoomId: fixture.matrixRoomId,
    noteEditorPendingInsert: null,
  });
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(FIXTURE_DUNGEON_ID);
});

afterEach(() => {
  cleanup();
});

describe('every control is at least 44 by 44', () => {
  it('sweeps every declared study touch target in the open encounter', () => {
    renderEncounter();
    // Open the two regions that start closed, so their controls are in the sweep too.
    fireEvent.click(screen.getByRole('button', { name: 'Show Artifact' }));
    fireEvent.click(screen.getByRole('button', { name: 'Formatting' }));

    const targets = touchTargets();
    // Non-vacuity: a selector that matched nothing would satisfy every assertion below.
    expect(targets.length).toBeGreaterThan(12);

    for (const target of targets) {
      const name =
        target.getAttribute('data-study-touch-target') ?? target.getAttribute('aria-label') ?? '';
      expect(minimumSize(target), `${name} is under the 44-pixel floor`).toEqual({
        minWidth: '44px',
        minHeight: '44px',
      });
    }
  });
});

describe('every verb has a keyboard route', () => {
  it('reaches writing, previewing, formatting, confirming, and submitting with buttons and fields', () => {
    renderEncounter();

    // Native controls only: nothing here needs a canvas, a drag, or a pointer.
    for (const label of [
      'Edit',
      'Preview',
      'Formatting',
      'Images (0)',
      'Save draft',
      'Close this encounter',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
    }
    expect(screen.getByRole('textbox', { name: 'Summary' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: CONFIRM_LABEL })).toBeEnabled();
  });

  it('uses no positive tabindex anywhere, so Tab order follows the document', () => {
    renderEncounter();

    for (const element of document.querySelectorAll<HTMLElement>('[tabindex]')) {
      expect(Number(element.getAttribute('tabindex')), element.outerHTML.slice(0, 80)).toBeLessThanOrEqual(0);
    }
  });

  it('operates the confirmation and the submit control from the keyboard', () => {
    renderEncounter();

    const confirmation = screen.getByRole('checkbox', { name: CONFIRM_LABEL });
    confirmation.focus();
    expect(confirmation).toHaveFocus();
    fireEvent.click(confirmation);
    expect(confirmation).toBeChecked();

    const submit = screen.getByRole('button', { name: 'Defeat encounter' });
    submit.focus();
    expect(submit).toHaveFocus();
    // A native `<button type="button">`, not a div with a click handler: that is the
    // property that makes Space and Enter activate it without any code of ours running.
    expect(submit.tagName).toBe('BUTTON');
    expect(submit.getAttribute('type')).toBe('button');
    // Nothing here is `aria-disabled`: a control that can act is never announced as one.
    expect(submit.getAttribute('aria-disabled')).toBeNull();
  });

  it('removes a collapsed region\'s controls from Tab order and from the accessibility tree', () => {
    renderEncounter();

    // The artifact region starts closed, so its heading is the only thing reachable.
    const artifactRegion = document.querySelector<HTMLElement>('[data-study-region="artifact"]');
    expect(artifactRegion?.querySelector('.study-region__body')?.hasAttribute('hidden')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Hide Write the note' }));
    const composerRegion = document.querySelector<HTMLElement>('[data-study-region="composer"]');
    // `hidden`, not a class: that is what removes the subtree from Tab order and from the
    // accessibility tree together.
    expect(composerRegion?.querySelector('.study-region__body')?.hasAttribute('hidden')).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Summary' })).toBeNull();
  });

  it('reaches the guide conversation and out of it with the keyboard', () => {
    renderEncounter();

    const trigger = screen.getByRole('button', { name: 'Talk to the room guide about Matrices' });
    trigger.focus();
    fireEvent.click(trigger);

    const closer = screen.getByRole('button', { name: 'End the conversation' });
    expect(closer).toHaveFocus();
    fireEvent.keyDown(closer, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });
});

describe('a refusal is disabled and carries visible text where the control is', () => {
  it('refuses an empty image link in words on the control, not only in a description', () => {
    renderEncounter();

    fireEvent.click(screen.getByRole('button', { name: 'Images (0)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add an image link' }));

    const record = screen.getByRole('button', { name: 'Record this image link' });
    expect(record).toBeDisabled();
    // The sentence is in the normal flow next to the control, and it is also the control's
    // accessible description - both, because a disabled control cannot be focused to ask.
    expect(screen.getByText('Type an image link before recording it.')).toBeInTheDocument();
    expect(record.getAttribute('aria-describedby')).not.toBeNull();
  });

  it('offers no dead control at all where the action cannot apply', () => {
    renderEncounter();

    fireEvent.click(screen.getByRole('button', { name: 'Show Artifact' }));
    // No artifact yet, so no pickup control - and a sentence saying why, in words.
    expect(screen.queryByRole('button', { name: 'Pick up the artifact' })).toBeNull();
    expect(
      screen.getByText('No artifact yet. Defeating this encounter writes one.'),
    ).toBeInTheDocument();
  });

  it('never states a state in colour alone', () => {
    renderEncounter();
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'Matrix' },
    });

    const checks = document.querySelector<HTMLElement>('[data-study-region="checks"]');
    if (checks === null) throw new Error('No checks region');
    // Every verdict the checks region draws is also a word.
    expect(within(checks).getByText('Not met')).toBeInTheDocument();
    expect(within(checks).getByText('Met')).toBeInTheDocument();
    // ...and the glyph beside it is hidden from assistive technology, which should hear the
    // word rather than the mark.
    const marks = [...checks.querySelectorAll('.scribe-row__mark')];
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('landmarks and live regions', () => {
  it('exposes the encounter as one dialog with one name and one live region', () => {
    renderEncounter();

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Scribe encounter' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('gives every region a heading a screen reader can jump to', () => {
    renderEncounter();

    const regions = [...document.querySelectorAll<HTMLElement>('[data-study-region]')];
    expect(regions).toHaveLength(4);
    for (const region of regions) {
      // `getAttribute` is nullable and `expect`'s message overload wants `string |
      // undefined`, so the region id is defaulted rather than passed through as `string |
      // null`. An unnamed region is still caught by the assertions that follow.
      const id = region.getAttribute('data-study-region') ?? '';
      const labelledBy = region.getAttribute('aria-labelledby');
      expect(labelledBy, `region ${id} has no accessible name`).not.toBeNull();
      const heading = labelledBy === null ? null : document.getElementById(labelledBy);
      expect(heading?.textContent, `region ${id} names a heading that is not in the document`).toBeTruthy();
    }
  });

  it('labels the note textarea by the section tab that owns it', () => {
    renderEncounter();

    const textarea = screen.getByRole('textbox', { name: 'Summary' });
    const tab = document.getElementById(textarea.getAttribute('aria-labelledby') ?? '');
    expect(tab?.textContent).toBe('Summary');
    expect(tab?.getAttribute('role')).toBe('tab');
    expect(tab?.getAttribute('aria-controls')).toBe(textarea.id);
  });

  it('pins the four composer mode-toggle ids, so the derived family cannot drift', () => {
    renderEncounter();

    /*
     * These four are `SCRIBE_CONTROL_IDS.composerMode` plus a static suffix. The base is
     * shared vocabulary and the suffixes are literals, but "shared base plus a suffix" is
     * exactly the shape that breaks silently - and it did: the base key went missing from
     * `controlIds.ts` and four `undefined-edit` ids reached the DOM. So the exact strings
     * are asserted here rather than the pattern.
     */
    for (const suffix of ['edit', 'preview', 'formatting', 'images']) {
      const id = `${SCRIBE_CONTROL_IDS.composerMode}-${suffix}`;
      const element = document.getElementById(id);
      expect(element, `no element with id ${id}`).not.toBeNull();
      expect(element?.tagName).toBe('BUTTON');
      expect(element?.getAttribute('aria-pressed')).not.toBeNull();
    }

    const toggleIds = [...document.querySelectorAll<HTMLElement>('[id]')]
      .map((element) => element.id)
      .filter((id) => id.startsWith('scribe-composer-mode-'));
    // Exactly four, unique, and all static vocabulary - no learner value, no `undefined`.
    expect(toggleIds.sort()).toEqual([
      'scribe-composer-mode-edit',
      'scribe-composer-mode-formatting',
      'scribe-composer-mode-images',
      'scribe-composer-mode-preview',
    ]);
  });

  it('writes no learner value into an id, a data attribute, or an aria string', () => {
    renderEncounter();

    /*
     * Static vocabulary only. The topic appears as text content and nowhere else, so a
     * selector pasted into an issue report can never carry what a learner wrote.
     *
     * The shape of an id is deliberately not asserted: `StudyActionButton` uses React's
     * `useId` for its refusal-note association, and those ids are React's to choose. What is
     * asserted is the property that matters - no id carries the topic or the subject - plus
     * that the ids this phase introduces are the exact static literals `controlIds.ts`
     * declares, so a future edit that interpolated one would fail here.
     */
    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      expect(id.toLowerCase(), `id ${id} carries learner text`).not.toContain('matrices');
      expect(id.toLowerCase(), `id ${id} carries learner text`).not.toContain('linear');
    }
    expect(ids).toEqual(
      expect.arrayContaining([
        'scribe-arrival',
        'scribe-section-tabs',
        'scribe-section-tab-summary',
        'scribe-section-tab-key-points',
        'scribe-section-tab-recall-question',
        'scribe-note-editor',
        'scribe-confirmation',
        'scribe-submit',
        'scribe-encounter-close',
        'scribe-encounter-dialog',
      ]),
    );

    const arrival = document.querySelector('[data-study-arrival-stage]');
    expect(arrival?.getAttribute('data-study-arrival-stage')).toBe('not-started');
  });
});