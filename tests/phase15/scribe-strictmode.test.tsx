/**
 * Exit criterion 2 under React StrictMode: a valid note clears and rewards a room exactly
 * once, including when the component is mounted twice.
 *
 * ## Why counting renders is not evidence
 *
 * StrictMode double-*invokes* effects in development, and every encounter command in this
 * application is asynchronous: the controller reads a snapshot, calls `submitNote`, and then
 * writes the reward. A mutation fired from an effect therefore applies twice, and - because
 * `submitNote` writes the note and the reward transaction writes the ledger - both
 * applications can be individually valid while the learner is credited twice. Nothing
 * throws, nothing warns. A test that renders in StrictMode and asserts the DOM shows one
 * cleared room would pass on exactly that defect; a test that counts renders would not
 * notice it at all, because renders are not the thing at risk.
 *
 * So this file measures the mutation itself, with three independent counters:
 *
 * 1. **Commands.** Every method on `encounterController` is wrapped in a spy that forwards
 *    to the real controller. One user action must produce exactly one command, so a second
 *    invocation anywhere - an effect, a double-fired event, a re-entrant handler - is red.
 * 2. **Store writes.** `saveSubjectSnapshot` is mocked, so the note commit is counted. A
 *    command that ran once but committed twice (or the reverse) is also red.
 * 3. **Progression.** `roomsCleared` and `xpTotal` are read from the real store. This is the
 *    counter that cannot be fooled: whatever the components do, one clear is one increment.
 *
 * ## The two layers, tested separately
 *
 * The ref guard in `useScribeEncounterActions` answers "was this asked twice?"; the durable
 * (room, valid-clear identity) ledger in `progressionStore.awardRoomClear` answers "has this
 * clear been rewarded before?". The second is what makes the first unnecessary rather than
 * load-bearing, so the resubmission case below bypasses the UI entirely and calls the command
 * twice: if the guard were the only defence, that call would double the reward.
 *
 * Hermeticity: no renderer, no canvas, no network, no `dist/`, no clock.
 */
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store's write, counted. Everything else in the persistence module is the real thing.
vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

// The command boundary, counted and forwarded. The wrapper changes no behaviour: it records
// the call and hands the identical payload to the identical controller.
vi.mock('@/store/encounterCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/encounterCommands')>();
  return {
    ...actual,
    encounterController: {
      ...actual.encounterController,
      submitNote: vi.fn(actual.encounterController.submitNote),
      artifactCollect: vi.fn(actual.encounterController.artifactCollect),
      addAttachment: vi.fn(actual.encounterController.addAttachment),
      addExternalAttachment: vi.fn(actual.encounterController.addExternalAttachment),
      removeAttachment: vi.fn(actual.encounterController.removeAttachment),
      dispatch: vi.fn(actual.encounterController.dispatch),
    },
  };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, scribeEncounterWorkspace: true },
  };
});

import { saveSubjectSnapshot } from '@/services/persistence/subjectPersistence';
import { encounterController } from '@/store/encounterCommands';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { ScribeEncounterDialog } from '@/ui/study/scribe/ScribeEncounter';
import { FIXTURE_DUNGEON_ID, buildScribeFixture, type ScribeFixture } from './support/scribeFixtures';

const submitMock = vi.mocked(encounterController.submitNote);
const saveMock = vi.mocked(saveSubjectSnapshot);

let fixture: ScribeFixture;

function progression() {
  return useProgressionStore.getState();
}

function snapshot() {
  const live = useSubjectStore.getState().snapshot;
  if (live === null) throw new Error('No snapshot installed');
  return live;
}

function writeAndConfirm(): void {
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Summary' }),
    { target: { value: 'A matrix acts on a vector by multiplication, and composition is product.' } },
  );
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'I confirm these notes are my own and complete.' }),
  );
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: /^(Save draft|Defeat encounter)$/ });
}

/** The encounter, mounted the way `GameScreen` mounts it, inside StrictMode. */
function renderStrict(): void {
  render(
    <StrictMode>
      <ScribeEncounterDialog />
    </StrictMode>,
  );
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
  submitMock.mockClear();
  saveMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('mounting and re-rendering never mutates', () => {
  it('dispatches nothing and commits nothing on mount, under StrictMode', () => {
    renderStrict();

    expect(submitMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(progression().xpTotal).toBe(0);
  });

  it('dispatches nothing when regions are opened, collapsed, and re-opened', () => {
    renderStrict();

    for (const id of ['checks', 'artifact', 'composer']) {
      const toggle = document
        .querySelector<HTMLElement>(`[data-study-region="${id}"]`)
        ?.querySelector<HTMLButtonElement>('.study-region__toggle');
      if (toggle === null || toggle === undefined) throw new Error(`No toggle for ${id}`);
      fireEvent.click(toggle);
      fireEvent.click(toggle);
    }

    expect(submitMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('dispatches nothing when the learner switches the section being written', () => {
    renderStrict();

    fireEvent.click(screen.getByRole('tab', { name: 'Key Points' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Recall Question' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Summary' }));

    expect(submitMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('dispatches nothing when the composer is asked to preview and to format', () => {
    renderStrict();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Formatting' }));

    expect(submitMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('dispatches nothing when the room guide conversation is opened and closed', () => {
    renderStrict();

    const trigger = screen.getByRole('button', { name: 'Talk to the room guide about Matrices' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'End the conversation' }));

    expect(submitMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('dispatches nothing when a re-render is forced from outside the workspace', () => {
    const { rerender } = render(
      <StrictMode>
        <ScribeEncounterDialog />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <ScribeEncounterDialog />
      </StrictMode>,
    );

    expect(submitMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });
});

describe('encounter/note-submit fires exactly once and rewards exactly once', () => {
  it('rewards once for one activation, under StrictMode', async () => {
    renderStrict();
    writeAndConfirm();
    expect(submitButton()).toHaveTextContent('Defeat encounter');

    fireEvent.click(submitButton());

    await waitFor(() => expect(progression().roomsCleared).toBe(1));
    // The counters that say "one click, one command, one commit"...
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
    // ...and the one that says "one clear, one increment", which no counter can argue with.
    expect(progression().roomsCleared).toBe(1);
    expect(snapshot().rooms[fixture.matrixRoomId]?.validationState.finalPass).toBe(true);
  });

  it('refuses a second dispatch of the same scope inside one tick, which is what a double tap is', async () => {
    renderStrict();
    writeAndConfirm();
    const submit = submitButton();

    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(progression().roomsCleared).toBe(1));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(progression().xpTotal).toBeGreaterThan(0);
  });

  it('rewards once across a resubmission, without the ref guard anywhere near it', async () => {
    // Straight at the command layer, twice, with no UI and no guard. This is the assertion
    // that the *durable* ledger is what makes the award idempotent rather than the button.
    const payload = {
      roomId: fixture.matrixRoomId,
      noteText: [
        'Summary',
        'A matrix acts on a vector by multiplication, and composition is product.',
        '',
        'Key Points',
        '- Composition is multiplication.',
        '',
        'Recall Question',
        'What does a matrix do to a vector?',
      ].join('\n'),
      manualConfirmed: true,
    };

    const first = await encounterController.submitNote(payload);
    expect(first.ok).toBe(true);
    if (first.ok && first.value.kind === 'cleared') {
      expect(first.value.progression.awarded).toBe(true);
    }
    const xpAfterFirst = progression().xpTotal;

    const second = await encounterController.submitNote(payload);
    expect(second.ok).toBe(true);
    if (second.ok && second.value.kind === 'cleared') {
      expect(second.value.progression.awarded).toBe(false);
      expect(second.value.progression.duplicate).toBe(true);
    }

    expect(progression().xpTotal).toBe(xpAfterFirst);
    expect(progression().roomsCleared).toBe(1);
  });

  it('saves a draft with no progression when the note is not confirmed', async () => {
    renderStrict();
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Summary' }),
      { target: { value: 'An unfinished thought.' } },
    );
    expect(submitButton()).toHaveTextContent('Save draft');

    fireEvent.click(submitButton());

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(progression().xpTotal).toBe(0);
    expect(progression().roomsCleared).toBe(0);
    expect(snapshot().rooms[fixture.matrixRoomId]?.state).toBe('NotesDrafted');
    expect(snapshot().rooms[fixture.matrixRoomId]?.artifactMarkdown).toBeNull();
  });

  it('does not re-dispatch when the store notifies after the submit landed', async () => {
    renderStrict();
    writeAndConfirm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));

    // The commit landed, the stores notified, the workspace re-rendered with a new model.
    fireEvent.click(screen.getByRole('tab', { name: 'Key Points' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Summary' }));
    await Promise.resolve();

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });
});