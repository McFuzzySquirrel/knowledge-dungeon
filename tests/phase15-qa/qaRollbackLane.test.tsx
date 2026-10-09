/**
 * QA's rollback-lane probe: with the flag off, is the pre-Phase-15 experience intact?
 *
 * ## The claim
 *
 * `GameScreen` renders `ScribeEncounterDialog` when `runtimeConfig.scribeEncounterWorkspace`
 * is `true` and `NoteEditorModal` otherwise. With the flag at its production default, the
 * pre-Phase-15 modal must still work **end to end**: open a room, write a note, save a draft,
 * clear the encounter, get a reward, and see the artifact. Phase 15's rollback is "Restore the
 * existing modal as the Scribe view while retaining shared commands", so nothing about the
 * rollback lane may have been broken by the new lane's arrival.
 *
 * ## The flag contract after the cutover
 *
 * After the Phase 23 cutover the production default is on, so `qaAccessibility.test.tsx`
 * measures the shipped default and this file drives the rollback build: it renders
 * `NoteEditorModal` directly and asserts the `VITE_SCRIBE_ENCOUNTER_WORKSPACE=false` value
 * still selects the pre-Phase-15 lane. The flag contract is asserted from the real
 * `runtimeConfig`/`parseRuntimeConfig`, not from an assumption that the default is off.
 *
 * No renderer, no canvas, no network, no clock, no `dist/`. The subject store's own write is
 * stubbed, as everywhere else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

import { runtimeConfig } from '@/config/featureFlags';
import { parseRuntimeConfig } from '@/config/runtimeConfig';
import {
  eventsOfKind,
  readStatisticsEventLedgerFromFields,
  totalXpAwarded,
} from '@/core/statistics/statisticsEvents';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { NoteEditorModal } from '@/ui/components/NoteEditorModal';
import { QA_DUNGEON_ID, QA_VALID_NOTE, TARGET_ROOM, buildQaFixture } from './qaFixtures';

function room() {
  const found = useSubjectStore.getState().snapshot?.rooms[TARGET_ROOM];
  if (found === undefined) throw new Error('no target room');
  return found;
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

describe('the flag contract: on by default, off is the rollback', () => {
  it('ships the flag on after the cutover, and the false rollback still selects the pre-Phase-15 modal', () => {
    expect(runtimeConfig.scribeEncounterWorkspace).toBe(true);
    expect(
      parseRuntimeConfig({ VITE_SCRIBE_ENCOUNTER_WORKSPACE: 'false' }).scribeEncounterWorkspace,
    ).toBe(false);
  });
});

describe('the rollback lane: the pre-Phase-15 modal still works end to end', () => {
  it('saves a draft for an invalid note, with no progression', async () => {
    render(<NoteEditorModal />);

    const editor = (await screen.findByLabelText('Summary')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'a partial thought with no headings' } });
    fireEvent.click(screen.getByRole('button', { name: /save draft/i }));

    // The modal composes the note with the three required headings and writes the learner's
    // text under the active one, so the saved note is the composition rather than the raw
    // keystrokes. That is the pre-Phase-15 behaviour and it is what must not change.
    await waitFor(() => {
      expect(room().noteText).toContain('a partial thought with no headings');
    });
    expect(room().noteText).toContain('Summary');
    expect(room().noteText).toContain('Key Points');
    expect(room().noteText).toContain('Recall Question');
    expect(room().state).toBe('NotesDrafted');
    expect(room().artifactMarkdown).toBeNull();
    expect(useProgressionStore.getState().roomsCleared).toBe(0);
    expect(useProgressionStore.getState().xpTotal).toBe(0);
  });

  it('clears the encounter, awards once, and shows the generated artifact', async () => {
    render(<NoteEditorModal />);

    const editor = (await screen.findByLabelText('Summary')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: QA_VALID_NOTE } });

    // The modal asks for the learner's own confirmation. It is never ticked for them.
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);
    fireEvent.click(checkbox!);
    await waitFor(() => {
      expect(checkbox!.checked).toBe(true);
    });

    // The modal's own label is derived from the live validation, so a note that can now
    // clear says "Defeat encounter". That is the learner's cue and the button's only name.
    const submit = await screen.findByRole('button', { name: /defeat encounter|save draft/i });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(room().validationState.finalPass).toBe(true);
    });
    expect(room().artifactMarkdown).not.toBeNull();
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
    expect(useProgressionStore.getState().xpTotal).toBeGreaterThan(0);

    // The artifact is written on the room and *not* in the journal: generation and pickup are
    // still separate actions in the rollback lane too.
    expect(useProgressionStore.getState().collectedNotes).toEqual([]);
  });

  it('records the note and its XP as statistics, which the default build did not before Phase 18', async () => {
    // The Phase 18 blocker, driven through the **real modal** rather than through a store call.
    // `qa-engineer` reproduced it in Chromium against the default `dist`: the toast said
    // "Room cleared! +26 XP" and every statistic was zero, because this lane supplied no room to
    // `awardRoomClear` and the store wrote statistics only for a call that named one.
    //
    // Nothing here can be satisfied by the store behaving correctly on its own: if the modal
    // stopped passing `roomId`, this case fails while every store-level test still passes.
    render(<NoteEditorModal />);

    const editor = (await screen.findByLabelText('Summary')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: QA_VALID_NOTE } });
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    fireEvent.click(checkbox);
    const submit = await screen.findByRole('button', { name: /defeat encounter|save draft/i });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(useProgressionStore.getState().roomsCleared).toBe(1);
    });
    const xpTotal = useProgressionStore.getState().xpTotal;
    expect(xpTotal).toBeGreaterThan(0);

    // The progression record now carries the ledger, in the record that paid for it.
    const preserved = useProgressionStore.getState().readProgressionPreservedFields() ?? {};
    const ledger = readStatisticsEventLedgerFromFields(preserved);
    const notes = eventsOfKind(ledger, 'note-submission');
    expect(notes).toHaveLength(1);
    expect(notes[0].roomId).toBe(TARGET_ROOM);
    expect(totalXpAwarded(ledger)).toBeGreaterThan(0);
    // And it reaches the shipping repository's key, so it survives a reload on the default build.
    const persisted = window.localStorage.getItem('knowledge-dungeon:v1:progression');
    expect(persisted).not.toBeNull();
    expect(persisted).toContain('statisticsEventLedger');
  });

  it('releases a resubmitted valid note instead of paying and counting it again', async () => {
    // The trap. Phase 15 closed the double count with the clear identity, which this lane does not
    // have - so recording statistics here without an equivalent guard would have made the default
    // build pay every time the learner resubmits a note they already passed. Driven through the
    // real modal, so the assertion is about the shipped path rather than about a store call shape.
    render(<NoteEditorModal />);

    /** Fill the modal in and press its own button, exactly as the learner would. */
    const submitValidNote = async (): Promise<void> => {
      const editor = (await screen.findByLabelText('Summary')) as HTMLTextAreaElement;
      fireEvent.change(editor, { target: { value: QA_VALID_NOTE } });
      const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      if (!checkbox.checked) fireEvent.click(checkbox);
      const submit = await screen.findByRole('button', { name: /defeat encounter|save draft/i });
      await waitFor(() => {
        expect(submit.hasAttribute('disabled')).toBe(false);
      });
      fireEvent.click(submit);
    };

    // ── First submission: pays, counts, clears.
    await submitValidNote();
    await waitFor(() => {
      expect(useProgressionStore.getState().roomsCleared).toBe(1);
    });
    const xpAfterFirst = useProgressionStore.getState().xpTotal;
    expect(xpAfterFirst).toBeGreaterThan(0);
    const countedOnce = () => eventsOfKind(
      readStatisticsEventLedgerFromFields(
        useProgressionStore.getState().readProgressionPreservedFields() ?? {},
      ),
      'note-submission',
    );
    expect(countedOnce()).toHaveLength(1);
    expect(countedOnce()[0].roomId).toBe(TARGET_ROOM);

    // ── The same still-valid note, submitted again. The modal closed itself after the clear, so
    // re-open it the way the room panel does.
    useSessionStore.setState({ isNoteEditorOpen: true, noteEditorRoomId: TARGET_ROOM });
    await submitValidNote();
    await waitFor(() => {
      // The save itself ran: the room is still a final pass.
      expect(room().validationState.finalPass).toBe(true);
    });

    // ── Released, not paid and not counted a second time.
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
    expect(useProgressionStore.getState().xpTotal).toBe(xpAfterFirst);
    expect(useProgressionStore.getState().streakCount).toBe(1);
    expect(countedOnce()).toHaveLength(1);
  });

  it('renders, and the rollback modal owns the one dialog in the tree', async () => {
    // The lane's own landmark, so "the modal rendered" is not the same claim as "some dialog
    // rendered".
    render(<NoteEditorModal />);
    const dialog = await screen.findByRole('dialog', { name: /note editor/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Scribe encounter' })).toBeNull();
  });

  it('GameScreen picks the modal, not the workspace, on a VITE_SCRIBE_ENCOUNTER_WORKSPACE=false build', () => {
    // The choice is asserted at the screen, not at a helper: `GameScreen` reads the flag once
    // at module scope, so this is the only place the decision is observable.
    // Read the *rendered source* rather than the transpiled function body: the flag-gated
    // choice is a module-scope constant, so the decision exists in the source text and not
    // inside `GameScreen`'s own body.
    const source = readFileSync(
      join(process.cwd(), 'src/ui/screens/GameScreen.tsx'),
      'utf8',
    );
    expect(source).toContain(
      'const SCRIBE_ENCOUNTER_WORKSPACE_ENABLED = runtimeConfig.scribeEncounterWorkspace;',
    );
    expect(source).toMatch(
      /SCRIBE_ENCOUNTER_WORKSPACE_ENABLED \? <ScribeEncounterDialog \/> : <NoteEditorModal \/>/,
    );
    // The host's pickup permission is a named constant, not a phase comparison, so the
    // Phase 15 deliverable is reachable in every phase including Scribe.
    expect(source).toContain('const HOST_PERMITS_ARTIFACT_PICKUP = true;');
    expect(source).not.toMatch(/setArtifactRooms\(artifactRoomIds, phase ===/);
    void within;
  });
});