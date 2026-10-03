/**
 * QA's ruling probe for the orchestrator's narrowed assertion in
 * `tests/phase15/scribe-encounter.test.tsx`.
 *
 * ## The question
 *
 * That test used to assert `room.artifactMarkdown` is byte-identical across a resubmission of
 * the same valid note. It is not. The orchestrator ruled the rewrite is **pre-existing
 * behaviour that Phase 15's "Preserve ... artifact generation" scope line forbids changing**,
 * narrowed the test to the plan's actual criterion, and recorded the rewrite as a known
 * limitation. The verifier's job is to say whether that ruling is defensible or whether it
 * weakened a test to make it pass.
 *
 * ## What settles it
 *
 * The ruling is a claim about the **pre-Phase-15 lane**. If the artifact diverges on the *old*
 * `NoteEditorModal` too, the behaviour is not Phase 15's and Phase 15 cannot have caused it.
 * If it diverges only on the *new* lane, the narrowing concealed a Phase 15 defect.
 *
 * So the rollback lane is driven through two identical valid submissions here, unmocked, and
 * the artifact is read both times.
 *
 * ## The finding, which is larger than the ruling records
 *
 * The ruling describes the divergence as "`submitNote`'s clear branch regenerates the artifact
 * with a fresh `generatedAtIso` on every valid submit". That is **true but incomplete**. The
 * two artifacts differ in more than the timestamp, and the cause is not the generator:
 *
 * - the composer seeds its three sections from `room.noteText` on arrival, and
 *   `composeNoteSections` writes the outer `Summary` / `Key Points` / `Recall Question`
 *   headings itself;
 * - so a note the learner wrote *with its own* `## Summary` / `## Key Points` /
 *   `## Recall Question` headings is stored as those headings **nested inside** the outer ones;
 * - on the second arrival `extractNoteSections` reads the outer headings and treats the inner
 *   ones as body text, so the next composition has the inner headings absorbed and the stored
 *   note is **structurally different**.
 *
 * Measured here, so the record states the size of the known limitation rather than a fraction
 * of it. It is still pre-existing - the rollback lane does exactly the same - so the
 * orchestrator's ruling stands. But a learner who resubmits loses markdown structure from
 * their saved note, which is a larger loss than a refreshed timestamp and belongs in the
 * follow-up.
 *
 * `src/store/subjectStore.ts` is untouched by this phase, which is a second and independent
 * reason the behaviour is pre-existing. It is noted rather than asserted, because a test cannot
 * see git.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { NoteEditorModal } from '@/ui/components/NoteEditorModal';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import { QA_DUNGEON_ID, QA_VALID_NOTE, TARGET_ROOM, buildQaFixture } from './qaFixtures';

/** A note whose headings are the learner's own, as a learner would actually write one. */
const LEARNER_NOTE = QA_VALID_NOTE;

function artifactNow(): string | null {
  return useSubjectStore.getState().snapshot?.rooms[TARGET_ROOM].artifactMarkdown ?? null;
}

function noteNow(): string {
  return useSubjectStore.getState().snapshot?.rooms[TARGET_ROOM].noteText ?? '';
}

function generatedLineOf(artifact: string | null): string {
  return (artifact ?? '')
    .split('\n')
    .filter((line) => line.startsWith('- Generated At:'))
    .join('');
}

function withoutGeneratedLine(value: string): string[] {
  return value.split('\n').filter((line) => !line.startsWith('- Generated At:'));
}

function install(): void {
  useSubjectStore.setState({ snapshot: buildQaFixture().snapshot, lastError: null });
  useSessionStore.setState({
    phase: 'scribe',
    isNoteEditorOpen: true,
    noteEditorRoomId: TARGET_ROOM,
    noteEditorPendingInsert: null,
  });
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(QA_DUNGEON_ID);
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: /defeat encounter|save draft/i });
}

async function writeValidNoteAndConfirm(): Promise<HTMLTextAreaElement> {
  const label = document.querySelector<HTMLLabelElement>('.note-section-label, .scribe-composer__label');
  const editor = (await screen.findByLabelText(label?.textContent ?? 'Summary')) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: LEARNER_NOTE } });
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  fireEvent.click(checkbox as HTMLInputElement);
  await waitFor(() => {
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });
  return editor;
}

/** Submit twice and hand back the two stored artifacts and the two stored notes. */
async function submitTwice(): Promise<{
  firstArtifact: string;
  secondArtifact: string;
  firstNote: string;
  secondNote: string;
}> {
  fireEvent.click(submitButton());
  await waitFor(() => {
    expect(artifactNow()).not.toBeNull();
  });
  const firstArtifact = artifactNow() as string;
  const firstNote = noteNow();

  fireEvent.click(submitButton());
  await waitFor(() => {
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
  });
  return {
    firstArtifact,
    secondArtifact: artifactNow() as string,
    firstNote,
    secondNote: noteNow(),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  install();
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ isNoteEditorOpen: false });
});

describe('the orchestrator ruling, measured on the rollback lane', () => {
  it('the PRE-Phase-15 modal also rewrites the artifact and the stored note', async () => {
    render(<NoteEditorModal />);
    await writeValidNoteAndConfirm();

    const result = await submitTwice();

    // (a) The orchestrator's stated reason, confirmed: the generated-at line moves.
    expect(generatedLineOf(result.firstArtifact)).not.toBe('');
    expect(generatedLineOf(result.secondArtifact)).not.toBe(generatedLineOf(result.firstArtifact));
    // So the artifact is not byte-identical - the original assertion could not have held.
    expect(result.secondArtifact).not.toBe(result.firstArtifact);

    // (b) The finding the ruling does not record: the *stored note* is restructured too, and
    // that is the larger part of the divergence. The learner's own `##` headings are absorbed
    // into the composer's outer headings and are gone from the note on disk.
    expect(result.firstNote).toContain('## Summary');
    expect(result.secondNote).not.toBe(result.firstNote);
    expect(result.secondNote).not.toContain('## Summary');
    expect(result.secondNote).not.toContain('## Key Points');
    expect(result.secondNote).not.toContain('## Recall Question');
    // The learner's prose survives; only the markdown structure is lost.
    expect(result.secondNote).toContain('A linked list is a sequence of nodes');
    expect(result.secondNote).toContain('What does each node in a linked list store?');

    // So the artifacts differ in more than their timestamp, for a reason upstream of the
    // generator. Both facts are pre-existing; the second is the one worth a follow-up.
    expect(withoutGeneratedLine(result.secondArtifact)).not.toEqual(
      withoutGeneratedLine(result.firstArtifact),
    );

    // (c) The rollback lane still double-awards, because it calls `awardRoomClear` with no
    // clear identity. Documented, expected, and the reason the ledger exists - recorded here so
    // the two lanes' divergence is measured rather than assumed.
    expect(useProgressionStore.getState().roomsCleared).toBe(2);
  });

  it('the new workspace does NOT reproduce either defect: stable note, single award', async () => {
    render(<ScribeEncounterDialog />);
    await screen.findByRole('dialog', { name: 'Scribe encounter' });
    await writeValidNoteAndConfirm();

    const result = await submitTwice();

    // The timestamp still moves - the artifact is regenerated - so the orchestrator's reason
    // for the narrowing is correct as far as it goes.
    expect(generatedLineOf(result.secondArtifact)).not.toBe(generatedLineOf(result.firstArtifact));
    // But the *note* is stable here, because the workspace does not re-seed after its own
    // submit. The learner's markdown structure survives.
    expect(result.secondNote).toBe(result.firstNote);
    expect(result.secondNote).toContain('## Summary');
    // ...and the reward is awarded once, which is the criterion the phase is judged on.
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
  });
});