/**
 * Phase 18 blocker: the **shipping** lane must record a completed note, and must not pay twice.
 *
 * ## The defect this file exists for
 *
 * `qa-engineer` reproduced it in real Chromium against the default `dist`: Start Tutorial, fill
 * the note, confirm, "Defeat encounter" - the toast said "Room cleared! +26 XP", `xpTotal` became
 * 27, `roomsCleared` became 1, and every statistic was zero. The progression record's
 * `extraFields` was `null` and the session record read `notesSubmitted: 0, xpEarned: 0`.
 *
 * The cause was a single condition in `awardRoomClear`: statistics were written only under
 * `clear !== undefined`, and `clear` is the Phase 15 valid-clear identity. The default build
 * renders `NoteEditorModal`, which supplied no identity at all - so on the one lane that ships,
 * the statistics layer recorded nothing, ever. `VITE_SCRIBE_ENCOUNTER_WORKSPACE` defaults to
 * `false`, so the command lane that does supply the identity is not the shipping path.
 *
 * ## Why fixing it was not one change
 *
 * Plan §5.3 lists as a known defect: *"A valid note can be resubmit and award room-clear
 * progression again."* Phase 15 closed it **using the clear identity as the awarded-once key** -
 * and the lane with no identity was never guarded at all. So supplying an identity without a
 * matching guard would have produced the worse defect on the lane that ships: statistics that
 * appear, and a room that pays every time the note is resubmitted.
 *
 * The guard is therefore the statistics ledger itself - `decideNoteSubmission` - so "this
 * submission was counted" and "this submission was paid" are one durable fact in one record,
 * written in the same `set` as the XP.
 *
 * ## What these tests can and cannot fail on
 *
 * Everything is asserted against real persisted state read back through the validators the
 * application uses: the canonical progression record's preserved fields, the **legacy
 * `localStorage` progression key** (the shipping repository), and the legacy sessions key. No
 * assertion compares a value to itself after a coercion, and no `expect(NaN)` appears; every
 * money-shaped assertion is a positive integer compared against the amount the action reported.
 *
 * Privacy: every fixture is synthetic - app-minted room ids, synthetic subject names, no
 * learner text.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import {
  deriveNoteSubmissionSourceIdentity,
  eventsOfKind,
  noteSubmissionEventId,
  readStatisticsEventLedgerFromFields,
  STATISTICS_EVENT_LEDGER_KEY,
  totalXpAwarded,
} from '@/core/statistics/statisticsEvents';
import { resetStatisticsSinks } from '@/core/statistics/activitySink';
import {
  resetRepositorySelection,
  selectLegacyRepository,
} from '@/services/persistence/v2/repositorySelection';

const PROGRESSION_KEY = 'knowledge-dungeon:v1:progression';
const SUBJECT = 'synthetic-phase18-shipping-subject';
const ROOM_A = 'synthetic-phase18-shipping-room-a';
const ROOM_B = 'synthetic-phase18-shipping-room-b';
const NOW = '2026-09-24T12:34:56.789Z';

type ProgressionModule = typeof import('@/store/progressionStore');
type TrackerModule = typeof import('@/services/sessionTracker');

const INSTALLED: Array<() => void> = [];

function room(roomId: string): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass: true },
  };
}

/** A one-room graph whose room has already validated, so a clear is a reward and not a refusal. */
function clearedSnapshot(): SubjectSnapshot {
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT,
    subjectName: 'Synthetic Phase 18 Shipping Subject',
    createdAt: NOW,
    updatedAt: NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: ROOM_A,
    rooms: [
      { roomId: ROOM_A, topic: `synthetic-topic-${ROOM_A}`, status: 'ArtifactCollected' },
      { roomId: ROOM_B, topic: `synthetic-topic-${ROOM_B}`, status: 'ArtifactCollected' },
    ],
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return { dungeon, rooms: { [ROOM_A]: room(ROOM_A), [ROOM_B]: room(ROOM_B) } };
}

/**
 * The badge-progress inputs `NoteEditorModal` passes.
 *
 * `totalRooms: 1` with `scribeClearedRooms: 1` so the clear is a *reward*, and `qualityBonus: 5`
 * so it pays a non-zero amount: an XP award of `0` would make "one XP event was recorded"
 * unable to distinguish a recorded award from a clamped one.
 */
function clearInputs() {
  return {
    qualityBonus: 5,
    totalRooms: 1,
    creatorMappedRooms: 1,
    scribeClearedRooms: 1,
    archaeologistFullReviewPasses: 0,
  };
}

/** Exactly the call `NoteEditorModal.handleSubmit` makes, once the fix shipped. */
function shippingLaneClear(roomId: string) {
  return { ...clearInputs(), roomId };
}

/**
 * A freshly imported application with the **real** lifecycle wiring installed.
 *
 * `vi.resetModules()` gives a fresh `@/core/statistics/activitySink`, so every sink-aware module
 * is imported dynamically after it - a statically imported one would still hold the previous
 * module instance and every "the wiring recorded it" assertion below would be measuring a no-op.
 */
async function harness(options: { readonly keepStorage?: boolean } = {}): Promise<{
  progression: ProgressionModule;
  tracker: TrackerModule;
}> {
  vi.resetModules();
  if (options.keepStorage !== true) window.localStorage.clear();
  resetRepositorySelection();
  selectLegacyRepository();

  const subject = await import('@/store/subjectStore');
  const progression: ProgressionModule = await import('@/store/progressionStore');
  const session = await import('@/store/sessionStore');
  const tracker: TrackerModule = await import('@/services/sessionTracker');
  const binding = await import('@/store/sessionLifecycleBinding');
  // Dynamic for the reason the idempotency file documents: a statically imported
  // `activateSubject` would still hold the pre-`resetModules` copy of
  // `@/core/statistics/activitySink` and would report into a module this binding never
  // installed a sink into, so the session would never open and every session-record
  // assertion below would be measuring a no-op.
  const activation: typeof import('@/application/subjectActivation') = await import(
    '@/application/subjectActivation'
  );

  subject.useSubjectStore.getState().setSnapshot(clearedSnapshot());
  progression.useProgressionStore
    .getState()
    .hydrateProgression(progression.readPersistedProgressionPayload());
  session.useSessionStore.getState().setActiveScreen('game');

  // Installed **before** the activation, because the binding installs the subject-activation
  // sink that opens the session.
  INSTALLED.push(binding.installSessionLifecycleBinding());

  // The canonical activation is the only place a study session starts. Going through it - rather
  // than writing the stores by hand - is what makes the session record below a real one.
  const activated = await activation.activateSubject(SUBJECT, {
    loadSubject: async () => clearedSnapshot(),
    setSessionActiveSubjectId: (id) => session.useSessionStore.getState().setActiveSubjectId(id),
    setProgressionActiveSubject: (id) =>
      progression.useProgressionStore.getState().setActiveSubject(id ?? ''),
  });
  expect(activated.activated).toBe(true);
  await tracker.pendingSessionWrites();
  // A non-vacuity guard for every session assertion below: no session, no proof.
  expect(tracker.getCurrentSession()).not.toBeNull();

  return { progression, tracker };
}

/** The active subject's preserved app-owned fields, read from the live store. */
function preserved(progression: ProgressionModule): Record<string, unknown> | undefined {
  return progression.useProgressionStore.getState().readProgressionPreservedFields();
}

/**
 * The active subject's preserved fields as the **shipping repository** persisted them.
 *
 * The legacy `localStorage` key is where the default build's state actually lives, so a statistic
 * that only exists in memory would not survive a reload. `projectToLegacyV3SubjectRecord`
 * flattens `extraFields` onto the record, which is how the ledger gets there.
 */
function persistedRecord(): Record<string, unknown> {
  const raw = window.localStorage.getItem(PROGRESSION_KEY);
  if (raw === null) throw new Error('the progression store wrote nothing to the legacy key');
  const payload = JSON.parse(raw) as { bySubject: Record<string, Record<string, unknown>> };
  const record = payload.bySubject[SUBJECT];
  if (record === undefined) throw new Error('the legacy key has no record for the active subject');
  return record;
}

interface StoredSession {
  readonly notesSubmitted: number;
  readonly reviewsCompleted: number;
  readonly xpEarned: number;
}

/** The stored sessions, read through the validator the dashboard's reader uses. */
function storedSessions(tracker: TrackerModule): StoredSession[] {
  return tracker.readSessionRecords().map((record) => ({
    notesSubmitted: record.notesSubmitted,
    reviewsCompleted: record.reviewsCompleted,
    xpEarned: record.xpEarned,
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  resetStatisticsSinks();
});

afterEach(() => {
  while (INSTALLED.length > 0) {
    const dispose = INSTALLED.pop();
    if (dispose === undefined) continue;
    try {
      dispose();
    } catch {
      /* the module registry was reset underneath it; the listeners went with the module */
    }
  }
  window.localStorage.clear();
  resetStatisticsSinks();
});

describe('the shipping lane records a completed note', () => {
  it('writes a note-submission and an XP award into the reward record, and into the legacy key', async () => {
    const { progression } = await harness();

    const reward = progression.useProgressionStore
      .getState()
      .awardRoomClear(shippingLaneClear(ROOM_A));

    // The award really happened, and paid real XP. Asserting the amount is positive is what makes
    // every "one XP event" assertion below able to fail.
    expect(reward.awarded).toBe(true);
    expect(reward.duplicate).toBe(false);
    expect(Number.isInteger(reward.xpGained)).toBe(true);
    expect(reward.xpGained).toBeGreaterThan(0);

    // ── In the canonical record's preserved fields.
    const fields = preserved(progression) ?? {};
    const ledger = readStatisticsEventLedgerFromFields(fields);
    const notes = eventsOfKind(ledger, 'note-submission');
    const xp = eventsOfKind(ledger, 'xp-award');
    expect(notes).toHaveLength(1);
    expect(xp).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'note-submission', roomId: ROOM_A, xpAwarded: reward.xpGained });
    expect(xp[0]).toMatchObject({ kind: 'xp-award', source: 'note-submission', amount: reward.xpGained });
    expect(ledger.events[0].localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The ledger's own total agrees with the award the action reported - a cross-check between
    // two independently computed numbers, not the same value compared with itself.
    expect(totalXpAwarded(ledger)).toBe(reward.xpGained);
    // Exactly one preserved key: no Phase 15 clear ledger, because this lane has no clear identity.
    expect(Object.keys(fields).sort()).toEqual([STATISTICS_EVENT_LEDGER_KEY]);

    // ── And in the shipping repository's key, so it survives a reload on the default build.
    const onDisk = persistedRecord();
    expect(onDisk[STATISTICS_EVENT_LEDGER_KEY]).toBeDefined();
    expect(onDisk).not.toHaveProperty('extraFields');
    const persistedLedger = readStatisticsEventLedgerFromFields(onDisk);
    expect(eventsOfKind(persistedLedger, 'note-submission')).toHaveLength(1);
    expect(totalXpAwarded(persistedLedger)).toBe(reward.xpGained);
    // The thirteen legacy keys are still present, in order, ahead of the added key.
    expect(Object.keys(onDisk).slice(0, 13)).toEqual([
      'xpTotal',
      'rank',
      'badges',
      'inventory',
      'equippedItems',
      'collectedNotes',
      'streakCount',
      'subjectsMastered',
      'roomsCleared',
      'reviewPasses',
      'artifacts',
      'bossesDefeated',
      'fishCollection',
    ]);
  });

  it('leaves a non-zero session record, which is what the dashboard reads first', async () => {
    const { progression, tracker } = await harness();

    const reward = progression.useProgressionStore
      .getState()
      .awardRoomClear(shippingLaneClear(ROOM_A));
    await tracker.pendingSessionWrites();

    // The open session's record, before the close.
    const open = tracker.getCurrentSession();
    expect(open?.notesSubmitted).toBe(1);
    expect(open?.xpEarned).toBe(reward.xpGained);

    tracker.endCurrentSession();
    await tracker.pendingSessionWrites();

    const stored = storedSessions(tracker);
    expect(stored).toHaveLength(1);
    expect(stored[0].notesSubmitted).toBe(1);
    expect(stored[0].xpEarned).toBe(reward.xpGained);
    expect(stored[0].reviewsCompleted).toBe(0);
  });

  it('counts a second room separately, so per-room statistics are not one global counter', async () => {
    const { progression } = await harness();

    const first = progression.useProgressionStore
      .getState()
      .awardRoomClear(shippingLaneClear(ROOM_A));
    const second = progression.useProgressionStore
      .getState()
      .awardRoomClear(shippingLaneClear(ROOM_B));

    expect(first.awarded).toBe(true);
    expect(second.awarded).toBe(true);
    expect(second.xpGained).toBeGreaterThan(0);

    const ledger = readStatisticsEventLedgerFromFields(preserved(progression));
    const notes = eventsOfKind(ledger, 'note-submission');
    expect(notes).toHaveLength(2);
    expect(notes.map((event) => event.roomId).sort()).toEqual([ROOM_A, ROOM_B].sort());
    expect(totalXpAwarded(ledger)).toBe(first.xpGained + second.xpGained);
    expect(progression.useProgressionStore.getState().roomsCleared).toBe(2);
  });
});

describe('the shipping lane is awarded once - the trap in this task', () => {
  it('releases a resubmitted valid note instead of paying and counting it again', async () => {
    const { progression, tracker } = await harness();

    // The submit the learner made.
    const first = progression.useProgressionStore
      .getState()
      .awardRoomClear(shippingLaneClear(ROOM_A));
    expect(first.awarded).toBe(true);
    const afterFirstRecord = JSON.stringify(persistedRecord());
    const xpAfterFirst = progression.useProgressionStore.getState().xpTotal;

    // The same note, submitted again. Identical inputs, because the modal derives no clock or
    // random component into the call: this is the resubmission, not a second room.
    const resubmit = progression.useProgressionStore
      .getState()
      .awardRoomClear(shippingLaneClear(ROOM_A));
    await tracker.pendingSessionWrites();

    // ── The reward is released, and says so in the established shape.
    expect(resubmit.awarded).toBe(false);
    expect(resubmit.duplicate).toBe(true);
    expect(resubmit.xpGained).toBe(0);
    expect(resubmit.loot).toBeNull();
    expect(resubmit.unlockedBadges).toEqual([]);

    // ── No second count, on either record.
    const ledger = readStatisticsEventLedgerFromFields(preserved(progression));
    expect(eventsOfKind(ledger, 'note-submission')).toHaveLength(1);
    expect(eventsOfKind(ledger, 'xp-award')).toHaveLength(1);
    expect(totalXpAwarded(ledger)).toBe(first.xpGained);
    expect(storedSessions(tracker)[0].notesSubmitted).toBe(1);

    // ── No second payment, on any counter.
    expect(progression.useProgressionStore.getState().xpTotal).toBe(xpAfterFirst);
    expect(progression.useProgressionStore.getState().roomsCleared).toBe(1);
    expect(progression.useProgressionStore.getState().streakCount).toBe(1);

    // ── And the durable bytes did not move at all, so the guard lives in the same record as the
    // reward: a write that only reached one of them would show up here.
    expect(JSON.stringify(persistedRecord())).toBe(afterFirstRecord);
  });

  it('survives a reload: the guard is durable, not an in-memory flag', async () => {
    const first = await harness();
    const awarded = first.progression.useProgressionStore
      .getState()
      .awardRoomClear(shippingLaneClear(ROOM_A));
    expect(awarded.awarded).toBe(true);

    // A real reload: fresh modules and fresh hydration over the **same** legacy keys, which is
    // what the default build restores from.
    const reloaded = await harness({ keepStorage: true });
    const xpAfterReload = reloaded.progression.useProgressionStore.getState().xpTotal;
    expect(xpAfterReload).toBeGreaterThan(0);

    const resubmit = reloaded.progression.useProgressionStore
      .getState()
      .awardRoomClear(shippingLaneClear(ROOM_A));

    expect(resubmit.awarded).toBe(false);
    expect(resubmit.duplicate).toBe(true);
    expect(reloaded.progression.useProgressionStore.getState().xpTotal).toBe(xpAfterReload);
    expect(eventsOfKind(readStatisticsEventLedgerFromFields(preserved(reloaded.progression)), 'note-submission')).toHaveLength(1);
  });

  });

describe('the identity the shipping lane uses', () => {
  it('is the id the recorded event carries, so the guard and the count cannot disagree', async () => {
    // The failure this pins is a *mismatch*: a guard derived from one set of components and a
    // count derived from another. Then the guard suppresses nothing, the count grows, and both
    // assertions still look individually reasonable.
    const { progression } = await harness();
    progression.useProgressionStore.getState().awardRoomClear(shippingLaneClear(ROOM_A));

    const ledger = readStatisticsEventLedgerFromFields(preserved(progression));
    const [recorded] = eventsOfKind(ledger, 'note-submission');
    const clearIdentity = deriveNoteSubmissionSourceIdentity({ roomId: ROOM_A });
    expect(clearIdentity, 'a non-blank room id produced no note-submission identity').not.toBeNull();
    if (clearIdentity === null) throw new Error('a non-blank room id produced no identity');
    const expected = noteSubmissionEventId({
      subjectId: SUBJECT,
      identity: { roomId: ROOM_A, clearIdentity },
    });
    expect(recorded.eventId).toBe(expected);
  });

  it('is deterministic, prefixed, and different per room', () => {
    const first = deriveNoteSubmissionSourceIdentity({ roomId: ROOM_A });
    const again = deriveNoteSubmissionSourceIdentity({ roomId: ROOM_A });
    const other = deriveNoteSubmissionSourceIdentity({ roomId: ROOM_B });
    if (first === null || again === null || other === null) {
      throw new Error('a non-blank room id produced no note-submission identity');
    }

    expect(first).toBe(again);
    expect(first).not.toBe(other);
    // The prefix is the reason a dump says which rule minted the identity.
    expect(first.startsWith('csub-')).toBe(true);
    // Not equal to a room id and not equal to a Phase 15 clear digest for the same room, so the
    // two key spaces cannot collide.
    expect(first).not.toBe(ROOM_A);
    expect(first.startsWith('clear-')).toBe(false);
    // And a value that names no room mints nothing at all, rather than a payable identity for it.
    expect(deriveNoteSubmissionSourceIdentity({ roomId: '' })).toBeNull();
    expect(deriveNoteSubmissionSourceIdentity({ roomId: '  ' })).toBeNull();
  });

  it('keeps the two lanes in separate key spaces, and says so rather than hiding it', async () => {
    // A device that clears the same room once on each lane pays twice, because the two lanes
    // define "one clear" differently and their ledgers are separate. Asserted rather than
    // papered over: a reader who assumes the lanes share a key space would be wrong.
    const { progression } = await harness();
    const byRoom = progression.useProgressionStore.getState().awardRoomClear(shippingLaneClear(ROOM_A));
    const byGeneration = progression.useProgressionStore.getState().awardRoomClear({
      ...clearInputs(),
      clear: { roomId: ROOM_A, clearIdentity: 'clear-77aa11bb' },
    });
    expect(byRoom.awarded).toBe(true);
    expect(byGeneration.awarded).toBe(true);
    expect(eventsOfKind(readStatisticsEventLedgerFromFields(preserved(progression)), 'note-submission')).toHaveLength(2);
  });
});

describe('a call that names no room records nothing, by construction', () => {
  it('pays, and writes no ledger - a note-submission event has nowhere to point', async () => {
    // The shape the byte-comparison fixtures call. It cannot record by *type*, not by policy:
    // `StatisticsNoteSubmissionEvent.roomId` is a required app-minted id, so there is no honest
    // event to write. Phase 18 originally kept this carve-out to protect the record shape, which
    // meant the shipping lane inherited it - that is the defect, and this test is the boundary.
    const { progression, tracker } = await harness();
    const reward = progression.useProgressionStore.getState().awardRoomClear(clearInputs());
    await tracker.pendingSessionWrites();

    expect(reward.awarded).toBe(true);
    expect(reward.duplicate).toBe(false);
    expect(preserved(progression)).toBeUndefined();
    expect(persistedRecord()).not.toHaveProperty(STATISTICS_EVENT_LEDGER_KEY);
    expect(storedSessions(tracker)[0].notesSubmitted).toBe(0);
  });

  it('is still an unconditional award, so a no-room caller keeps the pre-Phase-15 behaviour', async () => {
    // Named explicitly because it is a live trade: this lane has no awarded-once guard, because
    // there is no identity to guard on. The shipping lane names its room, and the only production
    // caller of this action is the shipping lane.
    const { progression } = await harness();
    progression.useProgressionStore.getState().awardRoomClear(clearInputs());
    const again = progression.useProgressionStore.getState().awardRoomClear(clearInputs());
    expect(again.awarded).toBe(true);
    expect(again.duplicate).toBe(false);
    expect(again.xpGained).toBeGreaterThan(0);
    expect(progression.useProgressionStore.getState().roomsCleared).toBe(2);
  });
});