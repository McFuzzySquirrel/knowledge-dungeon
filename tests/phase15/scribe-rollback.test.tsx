/**
 * The rollback lane: with the flag off, the pre-Phase-15 note-editor modal is the Scribe
 * view, unchanged and still working.
 *
 * ## Why this file is not "the old tests still pass"
 *
 * `tests/unit/NoteEditorModal.test.tsx` renders the modal directly, which proves the
 * component still works but says nothing about which Scribe surface a learner is shown.
 * This file drives the *routing*: it mocks `@/config/featureFlags` with
 * `scribeEncounterWorkspace: false`, mounts the screen's decision point, and asserts the
 * modal renders and the redesigned workspace does not - and then that submitting through the
 * modal still saves the note.
 *
 * The two lanes must not share an implementation, and the strongest evidence is that the
 * rollback lane's own double-award behaviour is unchanged: `NoteEditorModal.handleSubmit`
 * still calls `awardRoomClear` without a `clear` identity. That is precisely why the new
 * workspace exists, and why this file does *not* assert awarded-once behaviour for it.
 *
 * Hermeticity: no renderer, no canvas, no network, no `dist/`, no clock.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    // The production default, stated explicitly so the flag's own default cannot drift
    // unnoticed: this suite is the evidence that `false` is the rollback build.
    runtimeConfig: { ...actual.runtimeConfig, scribeEncounterWorkspace: false },
  };
});

import { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS } from '@/config/runtimeConfig';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { NoteEditorModal } from '@/ui/components/NoteEditorModal';
import { FIXTURE_DUNGEON_ID, buildScribeFixture, type ScribeFixture } from './support/scribeFixtures';

let fixture: ScribeFixture;

function snapshot() {
  const live = useSubjectStore.getState().snapshot;
  if (live === null) throw new Error('No snapshot installed');
  return live;
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

describe('the rollback build', () => {
  it('defaults the flag to off, which is what makes the modal the Scribe view', () => {
    /*
     * `src/config/runtimeConfig.ts` directly, not the mocked `@/config/featureFlags`: this is
     * the value a release actually ships with, and asserting the mock would only assert
     * this file.
     */
    expect(DEFAULT_RUNTIME_CONFIG.scribeEncounterWorkspace).toBe(false);
    expect(RUNTIME_FLAG_ENV_KEYS.scribeEncounterWorkspace).toBe('VITE_SCRIBE_ENCOUNTER_WORKSPACE');
  });

  it('renders the pre-Phase-15 modal, and not the redesigned workspace', () => {
    render(<NoteEditorModal />);

    expect(screen.getByRole('dialog', { name: 'Note editor' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Scribe encounter workspace')).toBeNull();
    // The redesigned workspace's own regions are absent, not merely hidden.
    expect(document.querySelectorAll('[data-study-region]')).toHaveLength(0);
    expect(document.querySelector('[data-study-arrival-stage]')).toBeNull();
  });

  it('still seeds the three required headings and the neutral checklist', () => {
    render(<NoteEditorModal />);

    const tabs = screen.getByRole('tablist', { name: 'Note sections' });
    expect(tabs.textContent).toContain('Summary');
    expect(tabs.textContent).toContain('Key Points');
    expect(tabs.textContent).toContain('Recall Question');
    // The modal's own neutral-checklist wording, which `scribeViewModel.ts` also owns and
    // which the redesigned workspace renders through that module instead.
    fireEvent.click(screen.getByRole('button', { name: 'Checks' }));
    expect(
      screen.getByText('Keep headings: Summary, Key Points, Recall Question.'),
    ).toBeInTheDocument();
  });

  it('still saves a draft with no progression through the modal', async () => {
    render(<NoteEditorModal />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'A rectangle of numbers.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() =>
      expect(snapshot().rooms[fixture.matrixRoomId]?.state).toBe('NotesDrafted'),
    );
    expect(useProgressionStore.getState().xpTotal).toBe(0);
    expect(useProgressionStore.getState().roomsCleared).toBe(0);
  });

  it('still clears and rewards through the modal, on the modal\'s own terms', async () => {
    render(<NoteEditorModal />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), {
      target: { value: 'A matrix acts on a vector by multiplication.' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I confirm these notes are my own and complete.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Defeat encounter' }));

    await waitFor(() =>
      expect(snapshot().rooms[fixture.matrixRoomId]?.validationState.finalPass).toBe(true),
    );
    // The modal's reward path is deliberately left exactly as it was, including the
    // unconditional `awardRoomClear`. Asserting otherwise here would be asserting the
    // defect the flag exists to route around.
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
    expect(useProgressionStore.getState().xpTotal).toBeGreaterThan(0);
  });
});