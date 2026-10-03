/**
 * QA's independent probes for the five Phase 15 exit criteria.
 *
 * ```
 * Existing validation output is unchanged.
 * A valid note clears and rewards a room exactly once.
 * An invalid note saves a draft without progression.
 * Image attachment and preview work locally.
 * Artifact generation and pickup remain separate actions.
 * ```
 *
 * ## What makes these independent of `tests/phase15/**`
 *
 * - A **different fixture shape**: `qaFixtures.ts` builds a *branching* graph, so the clear
 *   identity's edge window has a provable outside. A chain, which the implementers' fixture
 *   uses, cannot distinguish "sensitive to its neighbourhood" from "sensitive to every edge".
 * - **No component.** Criteria 2, 3, and 5 are state transitions, so every assertion here is
 *   made against `useSubjectStore` / `useProgressionStore` after driving the *real*
 *   `encounterController` from `src/store/encounterCommands.ts`. A component that renders the
 *   right sentence while the store does the wrong thing cannot pass any of these.
 * - **The whole progression record is diffed**, not one field. `roomsCleared === 1` alone
 *   would pass a store that double-counted XP, rolled loot twice, or bumped the streak.
 * - **No `it.fails`, no `skip`, no mock of the code under test.** The only mock is the
 *   subject store's own write, which every test in this repository stubs.
 *
 * ## Non-vacuity of this file
 *
 * The final test in each describe is deliberately the weakest shape the criterion allows: it
 * asserts the *smallest* consequence and would still pass if the implementation were
 * needlessly cautious. A suite whose every assertion is maximal can be green for the wrong
 * reason; these are the floor assertions that make the maximal ones above them meaningful.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The subject store's own write. Nothing else in the persistence module is mocked, so the
// progression side is genuinely persisted to the legacy mirror the shipping build uses.
vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

import { evaluateNoteValidation } from '@/core/validation/notes';
import { deriveRoomClearIdentity } from '@/core/progression/roomClearRewards';
import { addLinkedRooms } from '@/core/graph';
import { bindArtifactCollection, encounterController } from '@/store/encounterCommands';
import { useProgressionStore } from '@/store/progressionStore';
import { useSubjectStore } from '@/store/subjectStore';
import {
  NEIGHBOUR_ROOM,
  OUT_OF_WINDOW_ROOM,
  QA_DUNGEON_ID,
  QA_INVALID_NOTE,
  QA_NOW,
  QA_VALID_NOTE,
  TARGET_NOTE_ID,
  TARGET_ROOM,
  buildQaFixture,
} from './qaFixtures';

/* ── Reading the real stores ──────────────────────────────────────────────── */

function subject(): ReturnType<typeof useSubjectStore.getState> {
  return useSubjectStore.getState();
}

function room(roomId: string) {
  const found = subject().snapshot?.rooms[roomId];
  if (found === undefined) throw new Error(`no room ${roomId}`);
  return found;
}

/** Everything a reward could touch, as one comparable value. */
function progressionSnapshot(): {
  xpTotal: number;
  roomsCleared: number;
  streakCount: number;
  bossesDefeated: number;
  badges: readonly string[];
  inventory: readonly unknown[];
  artifactCount: number;
  collectedNoteIds: readonly string[];
} {
  const state = useProgressionStore.getState();
  return {
    xpTotal: state.xpTotal,
    roomsCleared: state.roomsCleared,
    streakCount: state.streakCount,
    bossesDefeated: state.bossesDefeated,
    badges: [...state.badges],
    inventory: [...state.inventory],
    artifactCount: Number(state.artifacts),
    collectedNoteIds: state.collectedNotes.map((entry) => entry.noteId),
  };
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(`refused: ${result.error.message}`);
  return result.value;
}

function expectRefusal<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): unknown {
  if (result.ok) throw new Error('expected a refusal, got a value');
  return result.error;
}

beforeEach(() => {
  window.localStorage.clear();
  bindArtifactCollection(null);
  const fixture = buildQaFixture();
  useSubjectStore.setState({ snapshot: fixture.snapshot, lastError: null });
  useProgressionStore.setState({
    bySubject: {},
    crossSubjectAchievements: [],
    collectedNotes: [],
  });
  useProgressionStore.getState().setActiveSubject(QA_DUNGEON_ID);
});

/* ── Criterion 1: existing validation output is unchanged ──────────────────── */

describe('criterion 1: the validation output the encounter acts on is the domain output', () => {
  it('passes the validation object through verbatim, field for field', async () => {
    // The workspace evaluates live for its checklist and then the store evaluates again on
    // submit. If the command reported a *different* object - re-derived, re-scored, or
    // re-worded - the checklist and the verdict could disagree, and that is exactly what
    // "existing validation output is unchanged" forbids.
    const outcome = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_INVALID_NOTE,
        manualConfirmed: false,
      }),
    );
    const expected = evaluateNoteValidation({
      noteText: QA_INVALID_NOTE,
      manualConfirmed: false,
      roomTopic: room(TARGET_ROOM).topic,
    });

    // Field-for-field on the declared shape. `outcome.validation` additionally carries the
    // store result's own `artifactMarkdown`, which `NoteValidationOutput` does not declare -
    // recorded in qaDefects.test.ts, asserted here only as "every declared field matches".
    const declared = Object.fromEntries(
      Object.keys(expected).map((key) => [key, (outcome.validation as unknown as Record<string, unknown>)[key]]),
    );
    expect(declared).toEqual({ ...expected });
    // And the room's committed validation state is the same evaluation, not a re-scoring.
    expect(room(TARGET_ROOM).validationState).toMatchObject({
      wordCount: expected.wordCount,
      requiredSectionsPresent: expected.requiredSectionsPresent,
      manualConfirmed: expected.manualConfirmed,
      qualityBonus: expected.qualityBonus,
      finalPass: false,
      failedChecks: [...expected.failedChecks],
    });
  });

  it('produces byte-identical validation for the same note on both branches', async () => {
    const first = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_INVALID_NOTE,
        manualConfirmed: false,
      }),
    ).validation;
    const second = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_INVALID_NOTE,
        manualConfirmed: false,
      }),
    ).validation;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not change the domain validator itself (criterion floor)', () => {
    // The phase's own verification lane. If this moved, criterion 1 would be satisfied
    // vacuously by a reworded validator.
    const output = evaluateNoteValidation({
      noteText: QA_VALID_NOTE,
      manualConfirmed: true,
      roomTopic: 'Linked Lists',
    });
    expect(output.finalPass).toBe(true);
    expect(output.requiredSectionsPresent).toBe(true);
    expect(output.wordCount).toBeGreaterThan(20);
    expect(Object.keys(output.criterionScores).sort()).toEqual([
      'clarityReadability',
      'conceptTermCoverage',
      'linkReferences',
      'recallQuestionQuality',
      'sectionCompleteness',
    ]);
  });
});

/* ── Criterion 2: a valid note clears and rewards a room exactly once ──────── */

describe('criterion 2: a valid note clears and rewards the room exactly once', () => {
  it('changes the whole progression record exactly once across three submissions', async () => {
    const before = progressionSnapshot();

    const first = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    expect(first.kind).toBe('cleared');
    expect(first.kind === 'cleared' && first.progression.awarded).toBe(true);

    const afterFirst = progressionSnapshot();
    // Exactly one room cleared. Every other progression counter moved too, and each moved
    // by exactly the amount the first award produced - so a second award would show up here.
    expect(afterFirst.roomsCleared).toBe(before.roomsCleared + 1);
    expect(afterFirst.xpTotal).toBeGreaterThan(before.xpTotal);
    expect(afterFirst.streakCount).toBe(before.streakCount + 1);
    // The journal was NOT touched: generation and pickup are separate (criterion 5).
    expect(afterFirst.collectedNoteIds).toEqual(before.collectedNoteIds);

    const second = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    const third = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );

    expect(progressionSnapshot()).toEqual(afterFirst);
    for (const outcome of [second, third]) {
      expect(outcome.kind).toBe('cleared');
      if (outcome.kind !== 'cleared') throw new Error('unreachable');
      // The learner is told the truth about the suppression rather than being shown a reward
      // that did not happen.
      expect(outcome.progression.awarded).toBe(false);
      expect(outcome.progression.duplicate).toBe(true);
      expect(outcome.progression.xpGained).toBe(0);
    }
  });

  it('still saves the note on a suppressed submission', async () => {
    // "Exactly once" must not be reached by refusing the write. The learner's text is theirs.
    const edited = `${QA_VALID_NOTE}\n\nA closing line added after the first clear.`;
    await encounterController.submitNote({
      roomId: TARGET_ROOM,
      noteText: QA_VALID_NOTE,
      manualConfirmed: true,
    });
    expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: edited,
        manualConfirmed: true,
      }),
    );
    expect(room(TARGET_ROOM).noteText).toBe(edited);
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
  });

  it('awards exactly once for two dispatches in the same tick', async () => {
    // The StrictMode / double-tap shape: two identical commands before either has settled.
    const [a, b] = await Promise.all([
      encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
      encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    ]);

    expect(useProgressionStore.getState().roomsCleared).toBe(1);
    const awardedCount = [a, b].filter(
      (result) => result.ok && result.value.kind === 'cleared' && result.value.progression.awarded,
    ).length;
    expect(awardedCount).toBe(1);
  });

  it('suppression survives a reload of the store from its own legacy mirror', async () => {
    await encounterController.submitNote({
      roomId: TARGET_ROOM,
      noteText: QA_VALID_NOTE,
      manualConfirmed: true,
    });
    const afterFirst = progressionSnapshot();

    // A page load: fresh module registry, the subject reinstalled from its own persisted
    // copy, and the progression store hydrated from the mirror the shipping build uses.
    const persistedSubject = subject().snapshot!;
    vi.resetModules();
    const mod = await import('@/store/progressionStore');
    mod.useProgressionStore
      .getState()
      .hydrateProgression(mod.readPersistedProgressionPayload());
    const subjectModule = await import('@/store/subjectStore');
    subjectModule.useSubjectStore.setState({ snapshot: persistedSubject });

    // Re-submitting through the freshly hydrated store must still suppress.
    const module2 = await import('@/store/encounterCommands');
    expect(mod.useProgressionStore.getState().roomsCleared).toBe(afterFirst.roomsCleared);
    const outcome = expectOk(
      await module2.encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    expect(outcome.kind).toBe('cleared');
    if (outcome.kind !== 'cleared') throw new Error('unreachable');
    expect(outcome.progression.awarded).toBe(false);
    expect(outcome.progression.duplicate).toBe(true);
    expect(mod.useProgressionStore.getState().roomsCleared).toBe(afterFirst.roomsCleared);
    expect(mod.useProgressionStore.getState().xpTotal).toBe(afterFirst.xpTotal);
  });

  it('awards again after a real graph mutation invalidates the room (QA: the missing end-to-end case)', async () => {
    // This is the case the unit tests reach by *hand-supplying* a second identity. Here the
    // second identity is minted by the real command from a real graph mutation, and the real
    // store has to agree that it is a new clear.
    const identityBefore = deriveRoomClearIdentity({
      roomId: TARGET_ROOM,
      dungeon: room(TARGET_ROOM) && useSubjectStore.getState().snapshot!.dungeon,
    });
    expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    expect(useProgressionStore.getState().roomsCleared).toBe(1);

    // A mutation that *can* reach the room: a new child under its direct neighbour, which is
    // inside the propagation window and therefore inside the identity window.
    const snapshot = useSubjectStore.getState().snapshot!;
    const mutated = addLinkedRooms(snapshot.dungeon, {
      fromRoomId: NEIGHBOUR_ROOM,
      drafts: [{ roomId: 'r-target-2-new', topic: 'Newly Linked' }],
      nowIso: QA_NOW,
    });
    expect(mutated.ok).toBe(true);
    if (!mutated.ok) throw new Error('unreachable');
    useSubjectStore.setState({
      snapshot: {
        ...snapshot,
        dungeon: mutated.value.dungeon,
        rooms: {
          ...snapshot.rooms,
          'r-target-2-new': {
            ...snapshot.rooms[TARGET_ROOM],
            roomId: 'r-target-2-new',
            topic: 'Newly Linked',
            noteText: '',
            artifactMarkdown: null,
          },
        },
      },
    });

    const identityAfter = deriveRoomClearIdentity({
      roomId: TARGET_ROOM,
      dungeon: useSubjectStore.getState().snapshot!.dungeon,
    });
    expect(identityAfter, 'the mutation must mint a new clear generation').not.toBe(identityBefore);

    const again = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    expect(again.kind === 'cleared' && again.progression.awarded).toBe(true);
    expect(again.kind === 'cleared' && again.progression.duplicate).toBe(false);
    expect(useProgressionStore.getState().roomsCleared).toBe(2);
  });

  it('does not re-award for a mutation outside the room propagation window (QA)', async () => {
    // The other half of graph sensitivity, and the one a room-id hash would *also* pass.
    // Without it, an implementation that simply ignored the graph would look correct.
    await encounterController.submitNote({
      roomId: TARGET_ROOM,
      noteText: QA_VALID_NOTE,
      manualConfirmed: true,
    });
    const afterFirst = progressionSnapshot();

    const snapshot = useSubjectStore.getState().snapshot!;
    const mutated = addLinkedRooms(snapshot.dungeon, {
      fromRoomId: OUT_OF_WINDOW_ROOM,
      drafts: [{ roomId: 'r-far-2', topic: 'Farther Away' }],
      nowIso: QA_NOW,
    });
    expect(mutated.ok).toBe(true);
    if (!mutated.ok) throw new Error('unreachable');
    useSubjectStore.setState({ snapshot: { ...snapshot, dungeon: mutated.value.dungeon } });

    const again = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    expect(again.kind === 'cleared' && again.progression.awarded).toBe(false);
    expect(progressionSnapshot()).toEqual(afterFirst);
  });

  it('keeps one award per room when two different rooms clear (QA floor)', async () => {
    await encounterController.submitNote({
      roomId: TARGET_ROOM,
      noteText: QA_VALID_NOTE,
      manualConfirmed: true,
    });
    const neighbour = room(NEIGHBOUR_ROOM);
    expectOk(
      await encounterController.submitNote({
        roomId: NEIGHBOUR_ROOM,
        noteText: QA_VALID_NOTE.replace(/linked list/gi, 'linked list variant'),
        manualConfirmed: true,
      }),
    );
    void neighbour;
    // Two distinct rooms, two distinct clear generations, two awards - never a shared one.
    expect(useProgressionStore.getState().roomsCleared).toBe(2);
  });
});

/* ── Criterion 3: an invalid note saves a draft without progression ────────── */

describe('criterion 3: an invalid note saves a draft and progresses nothing', () => {
  it('leaves every progression field byte-identical across five draft submissions', async () => {
    const before = progressionSnapshot();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const outcome = expectOk(
        await encounterController.submitNote({
          roomId: TARGET_ROOM,
          noteText: QA_INVALID_NOTE,
          manualConfirmed: false,
        }),
      );
      expect(outcome.kind).toBe('draft');
      if (outcome.kind !== 'draft') throw new Error('unreachable');
      // "No reward" is in the type, not merely implied by an absent field.
      expect(outcome.progression).toBeNull();
      expect(outcome.artifactMarkdown).toBeNull();
      expect(outcome.validation.finalPass).toBe(false);
    }
    expect(progressionSnapshot()).toEqual(before);
  });

  it('saves the draft text and the drafted room status, and generates no artifact', async () => {
    expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_INVALID_NOTE,
        manualConfirmed: false,
      }),
    );
    const saved = room(TARGET_ROOM);
    expect(saved.noteText).toBe(QA_INVALID_NOTE);
    expect(saved.state).toBe('NotesDrafted');
    expect(saved.artifactMarkdown).toBeNull();
    expect(saved.validationState.finalPass).toBe(false);
    const summary = useSubjectStore
      .getState()
      .snapshot!.dungeon.rooms.find((entry) => entry.roomId === TARGET_ROOM);
    expect(summary?.status).toBe('NotesDrafted');
  });

  it('a draft after a clear removes the artifact and still awards nothing (QA)', () => {
    // The dangerous ordering: clear the room, then write an invalid note. If the artifact
    // survived, or if the room stayed `ArtifactCollected`, a learner would be told a
    // collected artifact still existed.
    return (async () => {
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      });
      expect(room(TARGET_ROOM).artifactMarkdown).not.toBeNull();
      const before = progressionSnapshot();

      const outcome = expectOk(
        await encounterController.submitNote({
          roomId: TARGET_ROOM,
          noteText: QA_INVALID_NOTE,
          manualConfirmed: false,
        }),
      );
      expect(outcome.kind).toBe('draft');
      expect(room(TARGET_ROOM).artifactMarkdown).toBeNull();
      expect(room(TARGET_ROOM).state).toBe('NotesDrafted');
      expect(progressionSnapshot()).toEqual(before);
      expect(room(TARGET_ROOM).validationState.finalPass).toBe(false);
    })();
  });

  it('refuses an unknown room without touching progression (QA floor)', async () => {
    const before = progressionSnapshot();

    const unknown = expectRefusal(
      await encounterController.submitNote({
        roomId: 'r-not-a-room',
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    expect(unknown).toMatchObject({ code: 'ROOM_NOT_FOUND', message: 'Room not found' });
    expect(progressionSnapshot()).toEqual(before);
  });

  it('refuses a submit with no subject snapshot at all (QA floor)', async () => {
    useSubjectStore.setState({ snapshot: null });
    const refusal = expectRefusal(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    expect(refusal).toMatchObject({ code: 'NO_ACTIVE_SUBJECT', message: 'No active subject' });
  });

  it('records what happens when the progression record is missing (QA: observed behaviour)', async () => {
    // Recorded, not asserted as correct. With no active progression subject the store
    // refuses the award, and the command still reports `kind: 'cleared'` with
    // `awarded: false, duplicate: false`. This probe pins what happens so the defect report
    // cannot drift; see tests/phase15-qa/qaDefects.test.ts for the failing assertion.
    useProgressionStore.getState().setActiveSubject(null);
    const outcome = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    expect(outcome.kind).toBe('cleared');
    if (outcome.kind !== 'cleared') throw new Error('unreachable');
    expect(outcome.progression.awarded).toBe(false);
    // Neither a duplicate nor a real award: the state the outcome type does not name.
    expect(outcome.progression.duplicate).toBe(false);
    expect(outcome.progression.xpGained).toBe(0);
    // The note and its artifact are still written - only the reward is missing.
    expect(room(TARGET_ROOM).artifactMarkdown).not.toBeNull();
    expect(room(TARGET_ROOM).validationState.finalPass).toBe(true);
  });
});

/* ── Criterion 5: generation and pickup remain separate actions ───────────── */

describe('criterion 5: artifact generation and pickup are separate actions', () => {
  it('generates the artifact on clear and does not touch the journal', async () => {
    const before = progressionSnapshot();
    const cleared = expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_VALID_NOTE,
        manualConfirmed: true,
      }),
    );
    expect(cleared.kind === 'cleared' && cleared.artifactMarkdown.length > 0).toBe(true);

    const after = progressionSnapshot();
    expect(after.collectedNoteIds).toEqual(before.collectedNoteIds);
    expect(after.collectedNoteIds).toEqual([]);
    expect(after.artifactCount).toBe(before.artifactCount);
    // The artifact lives on the room, not in the journal, until a pickup happens.
    expect(room(TARGET_ROOM).artifactMarkdown).not.toBeNull();
    expect(useProgressionStore.getState().collectedNotes).toEqual([]);
  });

  it('refuses a pickup before one is asked for, and performs it only when asked', async () => {
    await encounterController.submitNote({
      roomId: TARGET_ROOM,
      noteText: QA_VALID_NOTE,
      manualConfirmed: true,
    });

    // No world flow is bound, so a pickup must fail loudly rather than silently reporting a
    // collection that did not happen. Observed behaviour: the bound port *throws*, so the
    // promise rejects rather than returning the declared `EncounterCommandResult`. The UI
    // catches it, so the learner is safe; the type and the store module's own header are not.
    // Pinned here; see qaDefects.test.ts.
    await expect(
      encounterController.artifactCollect({ roomId: TARGET_ROOM }),
    ).rejects.toThrow('No world flow is bound to collect artifacts.');
    expect(useProgressionStore.getState().collectedNotes).toEqual([]);

    // Bind the real shape a host binds: forward to the store's own journal write.
    const seen: string[] = [];
    bindArtifactCollection((command) => {
      seen.push(command.payload.roomId);
      const live = useSubjectStore.getState().snapshot!;
      const target = live.rooms[command.payload.roomId];
      if (target === undefined || target.artifactMarkdown === null) return;
      useProgressionStore.getState().collectArtifactNote({
        dungeonId: live.dungeon.dungeonId,
        roomId: target.roomId,
        topic: target.topic,
        floorLabel: live.dungeon.subjectName,
        artifactPreview: 'preview',
        noteMarkdown: target.noteText,
        artifactMarkdown: target.artifactMarkdown,
      });
    });

    const picked = expectOk(await encounterController.artifactCollect({ roomId: TARGET_ROOM }));
    expect(picked).toMatchObject({
      command: 'artifact/collect',
      roomId: TARGET_ROOM,
      handedToWorldFlow: true,
    });
    expect(seen).toEqual([TARGET_ROOM]);
    expect(useProgressionStore.getState().collectedNotes.map((entry) => entry.noteId)).toEqual([
      TARGET_NOTE_ID,
    ]);

    // A second pickup is refused by the store's own idempotency, and the room keeps its
    // artifact text: picking it up moves a copy into the journal, it does not consume the
    // room.
    expectOk(await encounterController.artifactCollect({ roomId: TARGET_ROOM }));
    expect(useProgressionStore.getState().collectedNotes).toHaveLength(1);
    expect(room(TARGET_ROOM).artifactMarkdown).not.toBeNull();
    expect(useProgressionStore.getState().roomsCleared).toBe(1);
  });

  it('has no artifact-generation command: generation is a property of submitNote alone', () => {
    // If a second verb existed, "separate actions" would be two implementations of one idea.
    const declared = useProgressionStore.getState();
    expect(Object.keys(declared).some((key) => /generateArtifact/i.test(key))).toBe(false);
    expect(
      (encounterController as unknown as Record<string, unknown>).artifactGenerate,
    ).toBeUndefined();
  });

  it('a draft generates no artifact at all (QA floor)', async () => {
    expectOk(
      await encounterController.submitNote({
        roomId: TARGET_ROOM,
        noteText: QA_INVALID_NOTE,
        manualConfirmed: false,
      }),
    );
    expect(room(TARGET_ROOM).artifactMarkdown).toBeNull();
    expect(useProgressionStore.getState().collectedNotes).toEqual([]);
  });
});