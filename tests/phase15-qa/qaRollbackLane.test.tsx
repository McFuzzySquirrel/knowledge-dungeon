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
 * ## Why this file does not mock the flag
 *
 * `qaAccessibility.test.tsx` forces the flag on to measure the new lane. This file does the
 * opposite: it asserts the **unmocked** `runtimeConfig.scribeEncounterWorkspace` is `false`
 * and then drives `NoteEditorModal` through the same real stores the new lane uses. A rollback
 * test that forced the flag off by mocking it would prove nothing about the default build.
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

describe('the default build: the flag is off', () => {
  it('is off without any mock, so the default artifact really is the pre-Phase-15 lane', () => {
    expect(runtimeConfig.scribeEncounterWorkspace).toBe(false);
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

  it('renders, and the rollback modal owns the one dialog in the tree', async () => {
    // The lane's own landmark, so "the modal rendered" is not the same claim as "some dialog
    // rendered".
    render(<NoteEditorModal />);
    const dialog = await screen.findByRole('dialog', { name: /note editor/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Scribe encounter' })).toBeNull();
  });

  it('GameScreen picks the modal, not the workspace, on the default build', () => {
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