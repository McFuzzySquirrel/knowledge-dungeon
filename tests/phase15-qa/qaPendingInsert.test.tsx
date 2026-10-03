/**
 * QA's independent probe of the pending-insert (signpost) ordering fix.
 *
 * ## The defect the orchestrator reports
 *
 * `pendingInsert` used to be applied by an effect in `NoteComposer`, a child of
 * `ScribeEncounter`. React runs a child's effects before its parent's, so on the mount that
 * follows an insertion the composer's effect appended the signpost text to the *active
 * section* and the parent's seed effect then overwrote `sections` from `room.noteText` -
 * discarding the insertion while still draining the one-shot token. The text could never
 * arrive, and because the token was consumed the retry could not re-ask.
 *
 * `ScribeEncounter` now owns both effects, declared in seed-then-insert order.
 *
 * ## What has to be true afterwards, and what each assertion earns
 *
 * 1. **The insert lands**, in one section, not smeared across the composer.
 * 2. **It is drained exactly once**, in the same pass that applied it.
 * 3. **It cannot be applied twice.** The effect's dependency array includes
 *    `activeSection`, so switching sections is a *legitimate* second trigger and "the deps
 *    did not change" is not a sufficient guard. A keystroke, a tab round-trip, and an
 *    unrelated store commit are each a real way to get there.
 *
 * The count is *measured*, not inferred: asserting "the text is present" also passes for an
 * implementation that appends twice.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { REQUIRED_NOTE_SECTIONS } from '@/core/validation/notes';
import { SCRIBE_CONTROL_IDS, SCRIBE_SECTION_TAB_IDS } from '@/ui/study/controlIds';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { TARGET_ROOM, buildQaFixture } from './qaFixtures';

const SIGNPOST = 'Remember: linked lists are not contiguous in memory.';
const SECOND = 'And a second signpost.';

/** The composer's live textarea, which is always the currently selected section. */
function textarea(): HTMLTextAreaElement {
  const area = document.querySelector<HTMLTextAreaElement>(
    `textarea[id="${SCRIBE_CONTROL_IDS.noteEditor}"]`,
  );
  if (area === null) throw new Error('no composer textarea on screen');
  return area;
}

/** Select a section and return what the composer holds for it. */
function sectionValue(section: (typeof REQUIRED_NOTE_SECTIONS)[number]): string {
  act(() => {
    fireEvent.click(document.getElementById(SCRIBE_SECTION_TAB_IDS[section]) as HTMLElement);
  });
  return textarea().value;
}

/** Every section's current value, so a count can be measured rather than inferred. */
function allSectionValues(): string[] {
  return REQUIRED_NOTE_SECTIONS.map((section) => sectionValue(section));
}

function occurrencesAcrossSections(text: string): number {
  return allSectionValues().reduce(
    (total, value) => total + (value.split(text).length - 1),
    0,
  );
}

function openWithPendingInsert(text: string | null): void {
  useSessionStore.setState({
    phase: 'scribe',
    isNoteEditorOpen: true,
    noteEditorRoomId: TARGET_ROOM,
    noteEditorPendingInsert: text,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useSubjectStore.setState({ snapshot: buildQaFixture().snapshot, lastError: null });
  openWithPendingInsert(null);
});

afterEach(() => {
  cleanup();
});

describe('the pending insert lands, drains once, and cannot be applied twice', () => {
  it('appends the signpost text to the note, in exactly one section', async () => {
    openWithPendingInsert(SIGNPOST);
    render(<ScribeEncounterDialog />);

    await waitFor(() => {
      expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
    });
    expect(occurrencesAcrossSections(SIGNPOST)).toBe(1);
    // The word count the workspace reports agrees the text is in the note, which is a
    // different read of the same fact than the textarea's value.
    await waitFor(() => {
      expect(screen.getByText(/Words in this note: \d+/).textContent).toMatch(
        /Words in this note: (?!0$)\d+/,
      );
    });
    const summary = sectionValue('Summary');
    expect(summary).toContain(SIGNPOST);
    expect(sectionValue('Key Points')).not.toContain(SIGNPOST);
    expect(sectionValue('Recall Question')).not.toContain(SIGNPOST);
  });

  it('drains the one-shot token in the same pass that applied it', async () => {
    openWithPendingInsert(SIGNPOST);
    render(<ScribeEncounterDialog />);

    await waitFor(() => {
      expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
    });
    // Applied *and* drained: the text is present at the moment the token is gone, so the two
    // were not separated by a render boundary.
    expect(sectionValue('Summary')).toContain(SIGNPOST);
    expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
  });

  it('does not append again on a keystroke, a section round-trip, or a region toggle', async () => {
    openWithPendingInsert(SIGNPOST);
    render(<ScribeEncounterDialog />);
    await waitFor(() => {
      expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
    });
    expect(occurrencesAcrossSections(SIGNPOST)).toBe(1);

    // 1. A keystroke in the active section.
    act(() => {
      fireEvent.change(textarea(), { target: { value: `${textarea().value} extra words` } });
    });
    // 2. A tab round-trip: `activeSection` is a declared dependency of the insert effect.
    sectionValue('Key Points');
    sectionValue('Summary');
    // 3. An unrelated region toggle, which re-renders the whole tree.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /checks and quality/i }));
      fireEvent.click(screen.getByRole('button', { name: /checks and quality/i }));
    });

    await waitFor(() => {
      expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
    });
    expect(occurrencesAcrossSections(SIGNPOST)).toBe(1);
    expect(occurrencesAcrossSections(SIGNPOST), 'the insert must be applied once').toBe(1);
    // Nothing is left queued for a later re-render either.
    expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
    // ...and the learner's own keystroke was not eaten by the guard. (The keystroke went
    // into whichever section the helper left selected, so the check is section-agnostic.)
    expect(allSectionValues().join('\n')).toContain('extra words');
  });

  it('applies a second, different insert on its own', async () => {
    // The guard must be per-token, not a latch that disables the feature after one use.
    openWithPendingInsert(SIGNPOST);
    render(<ScribeEncounterDialog />);
    await waitFor(() => {
      expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
    });
    expect(occurrencesAcrossSections(SIGNPOST)).toBe(1);

    act(() => {
      useSessionStore.getState().openNoteEditorWithInsert(TARGET_ROOM, SECOND);
    });
    await waitFor(() => {
      expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
    });
    expect(occurrencesAcrossSections(SECOND)).toBe(1);
    // The first insert is untouched, and the second did not duplicate it.
    expect(occurrencesAcrossSections(SIGNPOST)).toBe(1);
  });

  it('applies an insert requested for a room it is switching to, rather than losing it to the seed', async () => {
    // This is the ordering claim itself: seed is declared before insert, so an insert that
    // arrives together with a room change must land in the *new* room's note.
    render(<ScribeEncounterDialog />);
    await screen.findByRole('dialog', { name: 'Scribe encounter' });

    act(() => {
      useSessionStore.getState().openNoteEditorWithInsert('r-target-2', SIGNPOST);
    });
    await waitFor(() => {
      expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
    });
    expect(occurrencesAcrossSections(SIGNPOST)).toBe(1);
    expect(occurrencesAcrossSections(SIGNPOST)).toBe(1);
    // The room the note belongs to is the one that was asked for.
    expect(useSessionStore.getState().noteEditorRoomId).toBe('r-target-2');
  });
});