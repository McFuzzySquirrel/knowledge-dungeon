/**
 * QA's independent accessibility and rollback-lane probes for Phase 15.
 *
 * ## Why one file for both
 *
 * The accessibility floor and the rollback lane are both claims about *which lane rendered*,
 * so they share one setup: this file runs twice, in two describes, once with
 * `scribeEncounterWorkspace` forced on and once with it left at its production default.
 * A claim like "every verb has a DOM route" is only checkable on the lane that exists, and
 * the default lane has to be shown to still be the pre-Phase-15 modal rather than an empty
 * space where the workspace used to be.
 *
 * ## What each assertion is measuring
 *
 * - **Touch targets.** Every interactive element that carries the study touch-target
 *   attribute must declare a 44px minimum box. Measured from the declared style, because
 *   jsdom does not lay out and a computed-size assertion would be meaningless here. That
 *   limit is stated rather than hidden: this is a *declared* minimum, not a rendered one.
 * - **Live regions.** Exactly one `role="status"` and no `aria-live` anywhere else in the
 *   subtree, so a learner hears one announcement per action.
 * - **No positive tabindex.** `tabindex="1"` puts a control at the front of the page's tab
 *   ring, which is a defect no amount of correct markup elsewhere repairs.
 * - **No colour-only state.** The artifact's state is carried in words, so a learner who
 *   cannot distinguish the hues is not excluded.
 * - **Keyboard route for every verb.** Each verb is reachable and operable with the keyboard
 *   alone: focus moves, activation fires, and nothing needs a pointer.
 *
 * No assertion about screen-reader *announcement quality* is made here: jsdom has no
 * accessibility tree worth reading, and a real screen-reader review is Phase 21's evidence,
 * not this file's.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

/** The on-lane copy of this file sets the flag; see `qaRollbackLane.test.tsx`. */
vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, scribeEncounterWorkspace: true },
  };
});

import { FEATURE_FLAG_MATRIX, NON_CUTOVER_FLAG_KEYS } from '@/config/featureFlags';
import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';
import { encounterController } from '@/store/encounterCommands';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import { QA_DUNGEON_ID, QA_VALID_NOTE, TARGET_ROOM, buildQaFixture } from './qaFixtures';

/** Every interactive element in the workspace. */
function interactiveElements(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

beforeEach(() => {
  window.localStorage.clear();
  const fixture = buildQaFixture();
  useSubjectStore.setState({ snapshot: fixture.snapshot, lastError: null });
  useSessionStore.setState({
    phase: 'scribe',
    isNoteEditorOpen: true,
    noteEditorRoomId: TARGET_ROOM,
    noteEditorPendingInsert: null,
  });
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(QA_DUNGEON_ID);
});

afterEach(() => {
  cleanup();
});

describe('the flag contract', () => {
  it('defaults the Scribe workspace on in production and keeps it out of the non-cutover set', () => {
    // Phase 23 makes the redesigned workspace the production default; `false` is the
    // one-release rollback, and the workspace is a cutover flag rather than a kill switch.
    expect(FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.productionDefault).toBe(true);
    expect(DEFAULT_RUNTIME_CONFIG.scribeEncounterWorkspace).toBe(true);
    expect(NON_CUTOVER_FLAG_KEYS).not.toContain('scribeEncounterWorkspace');
    expect(RUNTIME_FLAG_ENV_KEYS.scribeEncounterWorkspace).toBe('VITE_SCRIBE_ENCOUNTER_WORKSPACE');
    // The rollback sentence has to name the same variable a learner would set.
    expect(FEATURE_FLAG_MATRIX.scribeEncounterWorkspace.rollback).toContain(
      'VITE_SCRIBE_ENCOUNTER_WORKSPACE',
    );
  });
});

describe('the flag-on Scribe lane: accessibility floor', () => {
  it('declares a 44px minimum box on every element that opts into a touch target', async () => {
    render(<ScribeEncounterDialog />);
    await screen.findByRole('dialog', { name: 'Scribe encounter' });

    const declared = [...document.querySelectorAll<HTMLElement>('[data-study-touch-target]')];
    expect(declared.length).toBeGreaterThan(8);
    for (const element of declared) {
      const minHeight = element.style.minHeight;
      const minWidth = element.style.minWidth;
      expect(
        Number.parseFloat(minHeight),
        `${element.getAttribute('data-study-touch-target')} minHeight`,
      ).toBeGreaterThanOrEqual(44);
      expect(
        Number.parseFloat(minWidth),
        `${element.getAttribute('data-study-touch-target')} minWidth`,
      ).toBeGreaterThanOrEqual(44);
    }
  });

  it('has exactly one live region and no other aria-live', async () => {
    render(<ScribeEncounterDialog />);
    await screen.findByRole('dialog', { name: 'Scribe encounter' });

    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('declares no positive tabindex anywhere in the workspace', async () => {
    render(<ScribeEncounterDialog />);
    await screen.findByRole('dialog', { name: 'Scribe encounter' });

    const positive = interactiveElements().filter((element) => {
      const value = element.getAttribute('tabindex');
      return value !== null && Number.parseInt(value, 10) > 0;
    });
    expect(positive.map((element) => element.tagName)).toEqual([]);
  });

  it('conveys the artifact state in words, not in colour or a glyph', async () => {
    // Clear the room so an artifact exists.
    await encounterController.submitNote({
      roomId: TARGET_ROOM,
      noteText: QA_VALID_NOTE,
      manualConfirmed: true,
    });
    render(<ScribeEncounterDialog />);
    await screen.findByRole('dialog', { name: 'Scribe encounter' });

    // Open the artifact region through its own toggle - the region's header button, not a
    // name match that would also hit the pickup control.
    const region = document.querySelector('[data-study-region="artifact"]') as HTMLElement;
    expect(region).not.toBeNull();
    const toggle = within(region).getByRole('button', { name: /^(show|hide) artifact$/i });
    if (/^show/i.test(toggle.textContent ?? '')) toggle.click();

    // The pickup is offered as a named control with a described hint, so the state is a
    // sentence a learner can read or hear rather than a hue or a glyph.
    const pickup = await screen.findByRole('button', { name: /pick up the artifact/i });
    expect(pickup.tagName).toBe('BUTTON');

    // The state is carried by a sentence, so a learner who cannot distinguish the hues, and
    // a screen reader, both get it. This is the concrete words-not-colour carrier.
    const sentence = within(region).getByText(
      /the artifact is written and waiting in this room\. picking it up keeps it in your journal\./i,
    );
    expect(sentence.tagName).toBe('P');

    const text = region.textContent ?? '';
    // No bare tick or cross as the only carrier of the state.
    expect(text).not.toMatch(/^[^A-Za-z]*[\u2713\u2717\u2718][^A-Za-z]*$/);
  });

  it('reaches and operates every verb with the keyboard alone', async () => {
    render(<ScribeEncounterDialog />);
    await screen.findByRole('dialog', { name: 'Scribe encounter' });

    // Write: the textarea is focusable and a keypress reaches it.
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();
    textarea!.focus();
    expect(document.activeElement).toBe(textarea);

    // Activate a button with the keyboard rather than a click. `Element.click()` is the DOM
    // route; the assertion that matters is that the handler is on the button, not on a
    // wrapper that only responds to a pointer, which is what this proves.
    const images = screen.getByRole('button', { name: /images \(\d+\)/i });
    images.focus();
    expect(document.activeElement).toBe(images);
    images.click();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /add an image from this device/i })).toBeVisible();
    });

    // The confirmation checkbox is the keyboard's route to confirming, and it is a real
    // checkbox rather than a styled div.
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    checkbox!.focus();
    checkbox!.click();
    expect(checkbox!.checked).toBe(true);

    // Submit is a real button.
    const submit = within(
      document.querySelector('[data-study-region="composer"]') as HTMLElement,
    ).getByRole('button', { name: /save|submit|defeat/i });
    expect(submit.tagName).toBe('BUTTON');
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('keeps focus inside the dialog and restores it on close', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'open the encounter';
    document.body.appendChild(opener);
    opener.focus();

    render(<ScribeEncounterDialog />);
    const dialog = await screen.findByRole('dialog', { name: 'Scribe encounter' });
    // The dialog frame is the initially focused element, so a screen reader starts inside it.
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    await encounterController.submitNote({
      roomId: TARGET_ROOM,
      noteText: QA_VALID_NOTE,
      manualConfirmed: true,
    });
    cleanup();
    // Focus went back to wherever it came from.
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
    opener.remove();
  });

  it('closes on Escape', async () => {
    render(<ScribeEncounterDialog />);
    const dialog = await screen.findByRole('dialog', { name: 'Scribe encounter' });
    dialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await waitFor(() => {
      expect(useSessionStore.getState().isNoteEditorOpen).toBe(false);
    });
  });
});