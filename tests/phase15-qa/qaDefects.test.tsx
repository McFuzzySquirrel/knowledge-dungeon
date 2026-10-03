/**
 * QA's independent probes for the two *reporting* defects the phase-15 lane introduces.
 *
 * ## These are expected to FAIL
 *
 * Each test below asserts the behaviour the product should have and does not have. They are
 * left red deliberately: a green suite with a caveat is worth less than a red test with a
 * diagnosis, and the orchestrator asked for exactly that. Nothing here is fixed in
 * `src/`, because both items need a scope ruling first.
 *
 * ## D1 - `awarded: false` is overloaded across three causes, and the learner is told the wrong one
 *
 * `progressionStore.awardRoomClear` returns `awarded: false` for three distinct situations:
 *
 * 1. the ledger already held this (room, clear generation) - a genuine repeat;
 * 2. there is **no active progression subject**, so nothing could be awarded at all;
 * 3. `awardRoomClearProgression` **refused** the award (an unsatisfiable badge-progress input).
 *
 * `EncounterClearRewardOutcome` names only (1): its `awarded` field is documented as "False when
 * the ledger already held this exact (room, clear generation)". Cases (2) and (3) report
 * `awarded: false, duplicate: false`, a combination the type does not describe.
 *
 * `useScribeEncounterActions.describeClear` branches on `!reward.awarded` alone, so cases (2)
 * and (3) are announced to the learner as **"This clear was already rewarded, so nothing was
 * added this time."** That sentence is false: nothing was ever awarded. This is the one part
 * of Phase 15 that *talks about* suppression, and it is the part that can lie about it.
 *
 * Severity: **minor, learner-facing**. Nothing is lost and nothing is double-awarded; the
 * defect is a sentence that misdescribes the outcome. Reachability is low but real:
 * `setActiveSubject` is called from bootstrap and subject activation, so a failed or skipped
 * activation leaves `activeSubjectId === null` while a subject snapshot is loaded.
 *
 * ## D2 - `EncounterArtifactCollectResult` is declared as a result and behaves as a throw
 *
 * `EncounterArtifactCollectResult` is `EncounterCommandResult<EncounterArtifactCollectOutcome>`,
 * so its declared failure mode is `{ ok: false, error }`. In fact the store's port throws
 * (`src/store/encounterCommands.ts`), and `runArtifactCollect` does not catch, so the promise
 * rejects. The UI catches it, so the learner is safe; the *type* and the store module's own
 * header ("until then a pickup is refused rather than silently ignored") are what disagree.
 *
 * Severity: **minor, contract/documentation**. There is no `EncounterCommandErrorCode` for it,
 * so a caller written against the declared type would find the rejection outside its contract.
 *
 * ## D3 - `EncounterNoteDraftOutcome.validation` carries a field its type does not declare
 *
 * `runNoteSubmit` assigns the whole `submitNote` result - which includes `artifactMarkdown` -
 * to `validation: NoteValidationOutput`. Structural typing permits it, so the object a surface
 * receives has one more key than its declared type says. Harmless for named-field consumers,
 * and a trap for `Object.keys` or exact comparison.
 *
 * Severity: **informational**. Reported, not asserted below, because it is a type-honesty
 * nit rather than a behaviour; `qaExitCriteria.test.ts` records the observed shape.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

import { bindArtifactCollection, encounterController } from '@/store/encounterCommands';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import { QA_DUNGEON_ID, QA_VALID_NOTE, TARGET_ROOM, buildQaFixture } from './qaFixtures';

beforeEach(() => {
  window.localStorage.clear();
  useSubjectStore.setState({ snapshot: buildQaFixture().snapshot, lastError: null });
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(QA_DUNGEON_ID);
});

describe('D1: the Scribe feedback sentence for a clear that was never awarded', () => {
  it('does not tell a learner a never-awarded clear was "already rewarded"', async () => {
    /*
     * Drives the real workspace, not a reproduction of its logic.
     *
     * The first version of this test copied `describeClear`'s branch into the test body and
     * asserted on the copy, which meant it could never go green from a product fix - it was
     * a transcript of the bug, not a check on it. This renders `ScribeEncounterDialog`, clears
     * the active progression subject so no reward can be awarded, and asserts on the sentence
     * the learner actually reads in the live region.
     */
    useProgressionStore.getState().setActiveSubject(null);
    useSessionStore.setState({ isNoteEditorOpen: true, noteEditorRoomId: TARGET_ROOM });

    render(<ScribeEncounterDialog />);

    // Write a complete, confirmed note so the submit is a *clear*, not a draft.
    const textarea = await screen.findByRole('textbox', { name: /Summary/ });
    fireEvent.change(textarea, { target: { value: QA_VALID_NOTE } });
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm/i }));
    fireEvent.click(screen.getByRole('button', { name: /Defeat encounter/i }));

    const status = await screen.findByRole('status');
    // Wait on the store, not on a sentence: the sentence is the thing under test, so
    // waiting for it would let the assertion confirm whatever text it happens to produce.
    await waitFor(() => {
      const live = useSubjectStore.getState().snapshot;
      expect(live?.rooms[TARGET_ROOM]?.state).toBe('ArtifactCollected');
    });

    // The precondition this test exists for: a clear whose reward did not happen and was not
    // a repeat. If the fixture stops producing it, the test is no longer testing D1.
    expect(useProgressionStore.getState().activeSubjectId).toBeNull();

    // The defect: this sentence is false when nothing was ever rewarded.
    expect(status).not.toHaveTextContent(/already rewarded/i);
    // What it must say instead.
    expect(status).toHaveTextContent(/no reward was added/i);
  });

  it('still says "already rewarded" for a genuine repeat clear', async () => {
    /*
     * The control for the test above. Fixing D1 must not turn a real duplicate into silence,
     * and the awarded-once property is only visible to a learner if this sentence survives.
     */
    useProgressionStore.getState().setActiveSubject(QA_DUNGEON_ID);
    useSessionStore.setState({ isNoteEditorOpen: true, noteEditorRoomId: TARGET_ROOM });

    render(<ScribeEncounterDialog />);

    const textarea = await screen.findByRole('textbox', { name: /Summary/ });
    fireEvent.change(textarea, { target: { value: QA_VALID_NOTE } });
    fireEvent.click(screen.getByRole('checkbox', { name: /confirm/i }));
    fireEvent.click(screen.getByRole('button', { name: /Defeat encounter/i }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/room cleared/i));

    // Second submit of the same still-valid note: a real repeat.
    fireEvent.click(screen.getByRole('button', { name: /Defeat encounter/i }));
    await waitFor(() => expect(status).toHaveTextContent(/already rewarded/i));
    expect(status).not.toHaveTextContent(/no reward was added/i);
  });
});

describe('D2: an unbound artifact pickup rejects, and the contract now says so', () => {
  it('rejects with a message naming the missing wiring, rather than reporting success', async () => {
    /*
     * The orchestrator's ruling on D2: the *throw* is correct and stays. An unbound pickup
     * means a host forgot a wiring step, and resolving `{ ok: true }` for an action that never
     * ran would be a typed lie. The defect QA found was that the declared alias promised a
     * resolved refusal, so `EncounterArtifactCollectResult` now documents the rejection as part
     * of its contract. This test pins the runtime behaviour that document describes.
     */
    const settled = await encounterController
      .artifactCollect({ roomId: TARGET_ROOM })
      .then(
        (value) => ({ state: 'resolved' as const, value }),
        (error: unknown) => ({ state: 'rejected' as const, error }),
      );

    expect(settled.state).toBe('rejected');
    if (settled.state !== 'rejected') throw new Error('unreachable');
    // The message names the wiring, and carries no learner content.
    expect(settled.error).toBeInstanceOf(Error);
    expect((settled.error as Error).message).toBe('No world flow is bound to collect artifacts.');

    // Nothing was collected: a rejected pickup must leave the journal untouched.
    expect(useProgressionStore.getState().collectedNotes).toHaveLength(0);
  });

  it('resolves normally once a collector is bound', async () => {
    bindArtifactCollection(() => {
      /* a bound collector that reports the pickup as taken */
    });
    const result = await encounterController.artifactCollect({ roomId: TARGET_ROOM });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.command).toBe('artifact/collect');
    bindArtifactCollection(null);
  });
});

afterEach(() => {
  cleanup();
  bindArtifactCollection(null);
});
