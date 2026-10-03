/**
 * Phase 15 exit criteria, as executable assertions, on the flag-on Scribe lane.
 *
 * ## What this file holds
 *
 * `GameScreen` chooses between the pre-Phase-15 note-editor modal and the redesigned Scribe
 * encounter workspace on one build-time flag, so this file mocks
 * `@/config/featureFlags` with `scribeEncounterWorkspace: true` and exercises the new lane.
 * Its siblings cover the rollback, the StrictMode double dispatch, the accessibility floor,
 * and the local-attachment round trip. No test changes a component to make its case, so
 * "the flag decides" is itself under test.
 *
 * ## Why every criterion is measured against the store, not against the DOM
 *
 * The five Phase 15 exit criteria are about state transitions: a clear that awards once, a
 * draft that awards nothing, an artifact that exists before a pickup is offered. A DOM
 * assertion can be satisfied by a component that *says* the right thing while the store did
 * something else, so each one here is asserted on `useProgressionStore` and
 * `useSubjectStore` state, with the DOM assertion as the second half of the pair rather than
 * the only half.
 *
 * ## Hermeticity
 *
 * No renderer, no canvas, no network, no `dist/`, no clock. `saveSubjectSnapshot` is
 * stubbed, so a note submission is an in-memory commit plus the reward transaction.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store's write, stubbed. Everything else in the persistence module is the real thing.
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

import { evaluateNoteValidation, REQUIRED_NOTE_SECTIONS } from '@/core/validation/notes';
import { deriveRoomClearIdentity } from '@/core/progression/roomClearRewards';
import { bindArtifactCollection } from '@/store/encounterCommands';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import {
  COMPLETE_NOTE_TEXT,
  FIXTURE_DUNGEON_ID,
  buildScribeFixture,
  withClearedRoom,
  withDraftNote,
  withNeedsRevalidation,
  type ScribeFixture,
} from './support/scribeFixtures';

const ARTIFACT_MARKDOWN = '# Matrices\n\nAn artifact written by clearing the room.';
const CONFIRM_LABEL = 'I confirm these notes are my own and complete.';

let fixture: ScribeFixture;

function progression() {
  return useProgressionStore.getState();
}

function snapshot() {
  const live = useSubjectStore.getState().snapshot;
  if (live === null) throw new Error('No snapshot installed');
  return live;
}

/**
 * A stand-in for the world flow's pickup, wired the way `GameScreen` wires the real one.
 *
 * It forwards to `collectArtifactNote` exactly as `studyFlowController.collectArtifact`
 * does, so the test exercises the handover *and* the journal entry it produces rather than
 * a stub that stops at the command boundary. The handover itself is recorded separately.
 */
function bindFakePickup(): { roomIds: string[] } {
  const roomIds: string[] = [];
  bindArtifactCollection((command) => {
    roomIds.push(command.payload.roomId);
    const live = useSubjectStore.getState().snapshot;
    if (live === null) return;
    const room = live.rooms[command.payload.roomId];
    if (room === undefined || room.artifactMarkdown === null) return;
    useProgressionStore.getState().collectArtifactNote({
      dungeonId: live.dungeon.dungeonId,
      roomId: room.roomId,
      topic: room.topic,
      floorLabel: live.dungeon.subjectName,
      artifactPreview: 'artifact preview',
      noteMarkdown: room.noteText,
      artifactMarkdown: room.artifactMarkdown,
    });
  });
  return { roomIds };
}

function renderEncounter(): void {
  render(<ScribeEncounterDialog />);
}

function regionOrder(): string[] {
  return [...document.querySelectorAll('[data-study-region]')].map(
    (element) => element.getAttribute('data-study-region') ?? '',
  );
}

function regionById(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-study-region="${id}"]`);
  if (element === null) throw new Error(`No region ${id}`);
  return element;
}

/** Open a region the way a learner does - through its own toggle. */
function openRegion(id: string): void {
  const toggle = regionById(id).querySelector<HTMLButtonElement>('.study-region__toggle');
  if (toggle === null) throw new Error(`Region ${id} has no toggle`);
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
}

function workspace(): HTMLElement {
  return screen.getByLabelText('Scribe encounter workspace');
}

function arrivalStage(): string | null {
  return document.querySelector('[data-study-arrival-stage]')?.getAttribute('data-study-arrival-stage') ?? null;
}

/** Write into the Summary section, which is what the composer opens on. */
function writeSummary(text: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Summary' }), { target: { value: text } });
}

function confirmNote(): void {
  fireEvent.click(screen.getByRole('checkbox', { name: CONFIRM_LABEL }));
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: /^(Save draft|Defeat encounter)$/ });
}

/** Write a real sentence and confirm the note, which is what defeats an encounter. */
function writeAndConfirm(): void {
  writeSummary(
    'A matrix is a rectangular array of numbers that acts on a vector by multiplication.',
  );
  confirmNote();
}

beforeEach(() => {
  window.localStorage.clear();
  // No world flow is bound unless a test binds one, so the pickup's refusal is a state a
  // test can rely on rather than an accident of file order.
  bindArtifactCollection(null);
  fixture = buildScribeFixture();
  useSubjectStore.setState({ snapshot: fixture.snapshot, lastError: null });
  useSessionStore.setState({
    phase: 'scribe',
    activeScreen: 'game',
    isNoteEditorOpen: true,
    noteEditorRoomId: fixture.matrixRoomId,
    noteEditorPendingInsert: null,
    focusedRoomId: fixture.matrixRoomId,
  });
  // A fresh progression record for the fixture subject, so an awarded clear is measurable.
  useProgressionStore.setState({ bySubject: {}, crossSubjectAchievements: [], collectedNotes: [] });
  useProgressionStore.getState().setActiveSubject(FIXTURE_DUNGEON_ID);
});

afterEach(() => {
  bindArtifactCollection(null);
  cleanup();
});

describe('the flag-on Scribe lane', () => {
  it('renders the encounter workspace in the slot the pre-Phase-15 modal used to fill', () => {
    renderEncounter();

    expect(screen.getByRole('dialog', { name: 'Scribe encounter' })).toBeInTheDocument();
    expect(workspace()).toBeInTheDocument();
    // The rollback lane's own landmark is the evidence that only one Scribe surface renders.
    expect(screen.queryByLabelText('Note editor')).toBeNull();
  });

  it('orders the regions arrival, composer, checks, artifact', () => {
    renderEncounter();

    expect(regionOrder()).toEqual(['arrival', 'composer', 'checks', 'artifact']);
  });

  it('carries the topic, status, floor, and path in the shell header', () => {
    renderEncounter();

    const shell = workspace();
    expect(within(shell).getByRole('heading', { name: 'Matrices' })).toBeInTheDocument();
    expect(within(shell).getByText('Status').nextElementSibling?.textContent).toBe('Created');
    expect(within(shell).getByText('Floor').nextElementSibling?.textContent).toBe('Matrices');
    expect(within(shell).getByText('Path').nextElementSibling?.textContent).toBe(
      'Linear Algebra → Matrices',
    );
  });

  it('reaches the room guide copy the room panel used to reach, unchanged', () => {
    renderEncounter();

    fireEvent.click(screen.getByRole('button', { name: 'Talk to the room guide about Matrices' }));

    // The words are `RoomNpcDialog`'s own. The workspace renders the component and never
    // restates them, so this assertion is on reachability rather than on a copy.
    expect(
      screen.getByText(
        'Capture this topic in your own words. Keep Summary, Key Points, and Recall Question so the validator can pass it.',
      ),
    ).toBeInTheDocument();
  });

  it('never ticks the confirmation for the learner and never generates note text', () => {
    renderEncounter();

    expect(screen.getByRole('checkbox', { name: CONFIRM_LABEL })).not.toBeChecked();
    // The three headings are seeded and every section body is empty: nothing was written.
    expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveValue('');
  });

  it('renders nothing at all when no room is open', () => {
    useSessionStore.setState({ isNoteEditorOpen: true, noteEditorRoomId: null });
    renderEncounter();

    expect(screen.queryByLabelText('Scribe encounter workspace')).toBeNull();
  });
});

describe('exit criterion 1: existing validation output is unchanged', () => {
  it('shows the validator\'s own messages, rationales, and scores, verbatim', () => {
    useSubjectStore.setState({ snapshot: withDraftNote(fixture.snapshot, fixture.matrixRoomId) });
    renderEncounter();

    // The same inputs the composer holds, evaluated by the same domain function. The rows
    // must be these values and no others.
    const expected = evaluateNoteValidation({
      noteText: COMPLETE_NOTE_TEXT,
      manualConfirmed: false,
      roomTopic: 'Matrices',
    });

    const checks = regionById('checks');
    for (const criterion of expected.criteria) {
      expect(within(checks).getByText(criterion.message)).toBeInTheDocument();
    }
    for (const entry of expected.rubric) {
      expect(within(checks).getAllByText(entry.rationale).length).toBeGreaterThan(0);
      // The rubric renders the score as `2/2 · <band>`, so the score is matched at the start
      // of the row rather than as a whole string.
      expect(within(checks).getAllByText(new RegExp(`^${entry.score}/2`)).length).toBeGreaterThan(0);
    }
    expect(
      within(checks).getByText('Words in this note').nextElementSibling?.textContent,
    ).toBe(String(expected.wordCount));
  });

  it('shows the pristine checklist for an untouched draft, as requirements not failures', () => {
    renderEncounter();

    const checks = regionById('checks');
    // The neutral wording lives in the view model, and the workspace must not reword it.
    expect(
      within(checks).getByText('Keep headings: Summary, Key Points, Recall Question.'),
    ).toBeInTheDocument();
    expect(within(checks).getByText('Tick confirmation when your draft is ready to submit.')).toBeInTheDocument();
    // ...and nothing claims a failure, because nothing has been tried.
    expect(within(checks).queryByText('Not met')).toBeNull();
  });

  it('turns the same checklist into failures once the learner has edited', () => {
    renderEncounter();

    expect(within(regionById('checks')).queryByText('Not met')).toBeNull();

    writeSummary('Matrix');

    const checks = regionById('checks');
    // The confirmation is the one blocking check still unmet, and it is a word not a colour.
    expect(within(checks).getByText('Not met')).toBeInTheDocument();
    expect(within(checks).getByText('Manual confirmation is required before completion.')).toBeInTheDocument();
  });

  it('names all three required sections and where each one stands', () => {
    renderEncounter();

    const checks = regionById('checks');
    for (const section of REQUIRED_NOTE_SECTIONS) {
      expect(within(checks).getByText(section)).toBeInTheDocument();
    }
    expect(within(checks).getAllByText('Present')).toHaveLength(REQUIRED_NOTE_SECTIONS.length);
  });
});

describe('exit criterion 2: a valid note clears and rewards a room exactly once', () => {
  it('clears the room and awards once for one submission', async () => {
    renderEncounter();
    const identity = deriveRoomClearIdentity({
      roomId: fixture.matrixRoomId,
      dungeon: fixture.snapshot.dungeon,
    });
    expect(identity).toMatch(/^clear-[0-9a-f]{8}$/);

    writeAndConfirm();
    expect(submitButton()).toHaveTextContent('Defeat encounter');
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(snapshot().rooms[fixture.matrixRoomId]?.validationState.finalPass).toBe(true);
    });
    expect(progression().roomsCleared).toBe(1);
    expect(progression().xpTotal).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent('Room cleared.');
  });

  it('awards nothing more on a resubmission of the same valid note', async () => {
    renderEncounter();
    writeAndConfirm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(progression().roomsCleared).toBe(1));

    const xpAfterFirst = progression().xpTotal;
    const lootAfterFirst = progression().inventory.length;

    // A second submission of a still-valid note. The learner's text is unchanged, so the
    // command reaches the same (room, valid-clear identity) pair and the ledger suppresses it.
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('already rewarded');
    });
    expect(progression().xpTotal).toBe(xpAfterFirst);
    expect(progression().roomsCleared).toBe(1);
    expect(progression().inventory).toHaveLength(lootAfterFirst);
  });

  it('still saves the note on that resubmission, because the note is still valid', async () => {
    renderEncounter();
    writeAndConfirm();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(snapshot().rooms[fixture.matrixRoomId]?.validationState.finalPass).toBe(true),
    );
    const artifact = snapshot().rooms[fixture.matrixRoomId]?.artifactMarkdown;

    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('already rewarded');
    });

    // Suppressing the *reward* is not suppressing the save: the note and its artifact stay.
    expect(snapshot().rooms[fixture.matrixRoomId]?.noteText).toContain('Summary');
    expect(snapshot().rooms[fixture.matrixRoomId]?.artifactMarkdown).not.toBeNull();
    expect(snapshot().rooms[fixture.matrixRoomId]?.artifactMarkdown).toContain(
      '## Submitted Notes',
    );
    // Still exactly one clear, still `ArtifactCollected`: the second submit did not
    // roll the room back to a draft and did not advance it to a second state.
    expect(snapshot().rooms[fixture.matrixRoomId]?.state).toBe('ArtifactCollected');
    expect(progression().roomsCleared).toBe(1);

    /*
     * Known limitation, deliberately NOT asserted as stable. Measured, not guessed -
     * see `tests/phase15-qa/qaArtifactRewriteRuling.test.tsx`, which drives the real
     * rollback lane:
     *
     * 1. `room.artifactMarkdown` can never be byte-stable across a resubmission on
     *    either lane: the clear branch of `submitNote` regenerates the artifact with
     *    a fresh `generatedAtIso` on every valid submit. Pre-Phase-15 behaviour, and
     *    Phase 15's scope line is "Preserve ... artifact generation", so it is
     *    recorded rather than silently changed.
     * 2. On the *rollback* lane the stored note is also restructured, which is worse
     *    than the timestamp: the learner's own `## Summary` / `## Key Points` /
     *    `## Recall Question` headings get nested inside the composer's outer
     *    headings, and the second arrival's `extractNoteSections` reads them as body
     *    text. The prose survives; the markdown structure does not.
     * 3. The rollback lane also double-awards (`roomsCleared === 2` on two valid
     *    submits), because the pre-Phase-15 modal calls `awardRoomClear` with no
     *    clear identity. That is the documented rollback, not a defect in this lane.
     *
     * This lane does none of the three: `ScribeEncounter`'s seed effect is guarded by
     * a `roomId` ref, so its composer keeps its own sections and a resubmit is
     * byte-stable with the reward awarded once.
     *
     * The *reward* is what the exit criterion makes idempotent, and it is asserted
     * above. Follow-up owner: core-logic-engineer, post-cutover.
     */
    expect(artifact).toContain('## Rubric Breakdown');
  });
});

describe('exit criterion 3: an invalid note saves a draft without progression', () => {
  it('saves the draft, changes no progression, and says so', async () => {
    renderEncounter();
    writeSummary('Matrix multiplication composes linear maps.');

    expect(submitButton()).toHaveTextContent('Save draft');
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Nothing was awarded');
    });
    const room = snapshot().rooms[fixture.matrixRoomId];
    expect(room?.state).toBe('NotesDrafted');
    expect(room?.validationState.finalPass).toBe(false);
    expect(room?.noteText).toContain('Matrix multiplication composes linear maps.');
    expect(room?.artifactMarkdown).toBeNull();

    expect(progression().xpTotal).toBe(0);
    expect(progression().roomsCleared).toBe(0);
    expect(progression().artifacts).toBe(0);
    expect(progression().collectedNotes).toHaveLength(0);
  });

  it('leaves the learner a draft it can pick back up', async () => {
    renderEncounter();
    writeSummary('Matrix multiplication composes linear maps.');
    fireEvent.click(submitButton());
    await waitFor(() => expect(snapshot().rooms[fixture.matrixRoomId]?.state).toBe('NotesDrafted'));

    // Close and reopen the encounter, which is what arriving again looks like.
    cleanup();
    renderEncounter();

    expect(arrivalStage()).toBe('draft');
    expect(screen.getByText('You have a draft here. Pick up where you left off.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveValue(
      'Matrix multiplication composes linear maps.',
    );
  });
});

describe('incomplete encounters are visibly resumable', () => {
  it('says nothing is written for a room nobody has started', () => {
    renderEncounter();

    expect(arrivalStage()).toBe('not-started');
    expect(screen.getByText('Nothing written here yet.')).toBeInTheDocument();
    expect(screen.getByText('Required sections still missing: 0')).toBeInTheDocument();
  });

  it('seeds the composer from the room a learner already drafted', () => {
    useSubjectStore.setState({ snapshot: withDraftNote(fixture.snapshot, fixture.matrixRoomId) });
    renderEncounter();

    expect(screen.getByText('You have a draft here. Pick up where you left off.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveValue(
      'A matrix is a rectangular array of numbers that acts on a vector.',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Recall Question' }));
    expect(screen.getByRole('textbox', { name: 'Recall Question' })).toHaveValue(
      'What does multiplying a matrix by a vector produce?\nHow does a determinant relate to area?',
    );
  });

  it('leads with the graph change when a room needs revalidation', () => {
    useSubjectStore.setState({
      snapshot: withNeedsRevalidation(
        withDraftNote(fixture.snapshot, fixture.matrixRoomId),
        fixture.matrixRoomId,
      ),
    });
    renderEncounter();

    expect(arrivalStage()).toBe('needs-revalidation');
    expect(screen.getByText(/needs to be rewritten before it clears again/)).toBeInTheDocument();
    expect(screen.getByText('Status').nextElementSibling?.textContent).toBe('NeedsRevalidation');
  });

  it('names the next step in words and moves focus to the control that performs it', () => {
    renderEncounter();

    // Nothing typed and nothing confirmed: the confirmation box is the blocker.
    expect(screen.getByText(/Next: Confirm these notes are your own/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to: Confirm these notes are your own' }));

    expect(screen.getByRole('checkbox', { name: CONFIRM_LABEL })).toHaveFocus();
  });

  it('opens a region that starts closed before moving focus into it', async () => {
    renderEncounter();
    writeAndConfirm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(snapshot().rooms[fixture.matrixRoomId]?.validationState.finalPass).toBe(true));

    // The artifact is written and uncollected, so the lead step is the pickup.
    expect(screen.getByText(/Next: Pick up the artifact/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to: Pick up the artifact' }));
    // The pickup lives in a region that starts closed, so the region opened first and the
    // focus landed rather than being dropped by the browser.
    expect(screen.getByRole('button', { name: 'Pick up the artifact' })).toHaveFocus();
  });
});

describe('exit criterion 5: artifact generation and pickup remain separate actions', () => {
  it('offers no pickup before an artifact exists', () => {
    const pickup = bindFakePickup();
    renderEncounter();
    openRegion('artifact');

    expect(screen.queryByRole('button', { name: 'Pick up the artifact' })).toBeNull();
    expect(
      screen.getByText('No artifact yet. Defeating this encounter writes one.'),
    ).toBeInTheDocument();
    expect(pickup.roomIds).toEqual([]);
  });

  it('writes the artifact on the clear and only then offers the pickup', async () => {
    const pickup = bindFakePickup();
    renderEncounter();

    writeAndConfirm();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(snapshot().rooms[fixture.matrixRoomId]?.artifactMarkdown).toEqual(expect.any(String)),
    );

    openRegion('artifact');
    expect(screen.getByRole('button', { name: 'Pick up the artifact' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'The artifact is written and waiting in this room. Picking it up keeps it in your journal.',
      ),
    ).toBeInTheDocument();
    // Generated, not collected: the journal does not have it yet.
    expect(pickup.roomIds).toEqual([]);
    expect(progression().collectedNotes).toHaveLength(0);
  });

  it('hands the pickup to the world flow exactly once and then withdraws the control', async () => {
    const pickup = bindFakePickup();
    renderEncounter();

    writeAndConfirm();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(snapshot().rooms[fixture.matrixRoomId]?.artifactMarkdown).toEqual(expect.any(String)),
    );
    openRegion('artifact');

    fireEvent.click(screen.getByRole('button', { name: 'Pick up the artifact' }));

    await waitFor(() => expect(pickup.roomIds).toEqual([fixture.matrixRoomId]));
    await waitFor(() =>
      expect(
        screen.getByText(
          'This artifact is already in your journal, so there is nothing left to pick up here.',
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Pick up the artifact' })).toBeNull();
    expect(progression().collectedNotes.map((entry) => entry.noteId)).toEqual([
      fixture.matrixNoteId,
    ]);
  });

  it('reports a collected artifact as collected on arrival, and offers no second pickup', () => {
    const live = withClearedRoom(fixture.snapshot, fixture.matrixRoomId, ARTIFACT_MARKDOWN);
    useSubjectStore.setState({ snapshot: live });
    useProgressionStore.getState().collectArtifactNote({
      dungeonId: FIXTURE_DUNGEON_ID,
      roomId: fixture.matrixRoomId,
      topic: 'Matrices',
      floorLabel: 'Matrices',
      artifactPreview: 'artifact preview',
      noteMarkdown: COMPLETE_NOTE_TEXT,
      artifactMarkdown: ARTIFACT_MARKDOWN,
    });
    renderEncounter();
    openRegion('artifact');

    expect(
      screen.getByText(
        'This artifact is already in your journal, so there is nothing left to pick up here.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick up the artifact' })).toBeNull();
    // The artifact body is still readable; collection does not hide it.
    expect(screen.getByText('An artifact written by clearing the room.')).toBeInTheDocument();
  });

  it('reports a refusal rather than pretending, when no world flow is bound', async () => {
    renderEncounter();

    writeAndConfirm();
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(snapshot().rooms[fixture.matrixRoomId]?.artifactMarkdown).toEqual(expect.any(String)),
    );
    openRegion('artifact');

    // Nothing is bound in this test, which is the state a host that forgot to wire
    // `bindArtifactCollection` is in. The pickup must be refused, not silently dropped.
    fireEvent.click(screen.getByRole('button', { name: 'Pick up the artifact' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('No world flow is bound'),
    );
    // And the journal still has nothing, so the control stays offered rather than vanishing.
    expect(progression().collectedNotes).toHaveLength(0);
  });
});

describe('the composer keeps the capabilities the modal had', () => {
  it('exposes the three required sections as a tablist', () => {
    renderEncounter();

    const tablist = screen.getByRole('tablist', { name: 'Note sections' });
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      ...REQUIRED_NOTE_SECTIONS,
    ]);
    expect(within(tablist).getByRole('tab', { name: 'Summary' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(within(tablist).getByRole('tab', { name: 'Key Points' }));
    expect(within(tablist).getByRole('tab', { name: 'Key Points' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('textbox', { name: 'Key Points' })).toBeInTheDocument();
  });

  it('renders the markdown highlight overlay beside the textarea', () => {
    renderEncounter();
    writeSummary('**bold** and *italic* and `code`');

    const overlay = document.querySelector('.md-highlight-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay?.innerHTML).toContain('md-hl-bold');
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies the formatting toolbar around the selection', () => {
    renderEncounter();
    const textarea = screen.getByRole('textbox', { name: 'Summary' }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    textarea.setSelectionRange(0, 5);

    fireEvent.click(screen.getByRole('button', { name: 'Formatting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));

    expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveValue('**hello**');
  });

  it('previews the composed note as rendered markdown', () => {
    renderEncounter();
    writeSummary('A **bold** claim about matrices.');

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByLabelText('Note preview')).toBeInTheDocument();
    expect(screen.getByText('bold')).toBeInTheDocument();
    // The composer's textarea is gone while previewing.
    expect(screen.queryByRole('textbox', { name: 'Summary' })).toBeNull();
  });

  it('states that a draft may always be saved and only a confirmation defeats an encounter', () => {
    renderEncounter();

    expect(submitButton()).toHaveTextContent('Save draft');
    expect(
      screen.getByText('This saves a draft. Nothing is awarded until you confirm the note yourself.'),
    ).toBeInTheDocument();

    confirmNote();
    expect(submitButton()).toHaveTextContent('Defeat encounter');
    expect(screen.getByText('Confirmed. Submitting now defeats the encounter.')).toBeInTheDocument();
  });

  it('appends a pending insert another surface asked for, and drains it once', async () => {
    useSessionStore.setState({ noteEditorPendingInsert: 'from the signpost' });
    renderEncounter();

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveValue('from the signpost');
    });
    // Drained: the one-shot token cannot append the same text twice.
    await waitFor(() => {
      expect(useSessionStore.getState().noteEditorPendingInsert).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Summary' })).toHaveValue('from the signpost');
    });
  });

  it('closes on its own control and on Escape', () => {
    renderEncounter();

    fireEvent.click(screen.getByRole('button', { name: 'Close this encounter' }));
    expect(useSessionStore.getState().isNoteEditorOpen).toBe(false);
    // `closeNoteEditor` also clears the room id, so reopening means opening the room again.
    expect(useSessionStore.getState().noteEditorRoomId).toBeNull();
    expect(screen.queryByLabelText('Scribe encounter workspace')).toBeNull();

    cleanup();
    useSessionStore.setState({
      isNoteEditorOpen: true,
      noteEditorRoomId: fixture.matrixRoomId,
    });
    renderEncounter();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Scribe encounter' }), { key: 'Escape' });
    expect(useSessionStore.getState().isNoteEditorOpen).toBe(false);
  });
});

describe('one live region carries every command outcome', () => {
  it('has exactly one role=status in the workspace, before and after a command', async () => {
    renderEncounter();
    expect(screen.getAllByRole('status')).toHaveLength(1);

    writeSummary('A draft.');
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Draft saved'));
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});