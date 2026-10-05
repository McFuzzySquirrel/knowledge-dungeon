/**
 * Phase 18 gate 5: the awarded-once guard on the **default shipping lane**, attacked.
 *
 * ## The fix under test
 *
 * Phase 18's blocker, confirmed in Chromium by the verifier before the fix: the default artifact's
 * Scribe is the pre-Phase-15 `NoteEditorModal`, and it called `awardRoomClear` with **no identity
 * at all**. Phase 18 wrote the statistics events only when an identity was present, so a real note
 * submission on the shipping lane paid XP and incremented `roomsCleared` while recording no note
 * event, no XP event and no session counter.
 *
 * The fix: `NoteEditorModal` names its `roomId`, and `progressionStore` derives
 * `deriveNoteSubmissionSourceIdentity({ roomId })` - **in the store**, so the command lane and this
 * one cannot mint different digests for one submission. The guard is the statistics event ledger
 * itself, read through `decideNoteSubmission`.
 *
 * ## Why this file exists separately from the fixer's own tests
 *
 * Supplying an identity where there was none would have fixed the missing statistics by
 * **re-opening** plan §5.3's duplicate-reward defect on the default artifact: the lane that had no
 * guard is exactly the lane a guard has to be proven on. So this file tries to make the default
 * lane pay twice, eight ways, and then checks that a rejected resubmit performs **no write at all**
 * rather than a zero-value one.
 *
 * ## The accepted trade, and what this file does *not* claim
 *
 * The lane-scoped identity is room-only, so **a room pays once per subject, ever** - a re-clear after
 * a graph edit is not payable again on this lane. That is a deliberate trade and the direction is
 * safe (under-paying is a reporting question; re-paying is the defect). This file pins the trade as
 * stated: the once-per-subject case asserts `roomsCleared` stays at `1` and XP does not move again,
 * and nothing here claims per-generation payment survives on this lane.
 *
 * ## What "no write at all" is measured as
 *
 * Three independent measurements, because any one of them alone is satisfiable by a write that
 * happens to be harmless:
 *
 * 1. **`localStorage.setItem` is not called** for the progression key during the rejected call.
 * 2. **The store's `bySubject` object identity is unchanged** - a `set` that rebuilt the record
 *    with identical values would still be a write.
 * 3. **`Math.random` is not called.** Loot rolls and minted ids draw from it, so a roll that
 *    happened and was discarded is caught here and by nothing else.
 *
 * Each measurement is preceded by a positive control that it can move, because a spy on a method
 * that is never called reports "zero calls" for a spy that was never installed.
 *
 * ## Privacy
 *
 * Every fixture is synthetic. No learner data, no URL, no request body.
 */

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
  readStatisticsEventLedgerFromFields,
  type StatisticsEvent,
} from '@/core/statistics/statisticsEvents';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';

const SUBJECT = 'synthetic-qa18-guard-subject';
const OTHER_SUBJECT = 'synthetic-qa18-guard-other';
const ROOM = 'synthetic-qa18-guard-room';
const NOW = '2026-10-10T10:10:10.000Z';
const PROG_KEY = STORAGE_KEYS.progression;

function room(roomId: string): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass: true },
    reviewPassCount: 0,
  };
}

function clearedSnapshot(dungeonId = SUBJECT): SubjectSnapshot {
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId,
    subjectName: 'Synthetic QA18 Guard Subject',
    createdAt: NOW,
    updatedAt: NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: ROOM,
    rooms: [{ roomId: ROOM, topic: `synthetic-topic-${ROOM}`, status: 'ArtifactCollected' }],
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return { dungeon, rooms: { [ROOM]: room(ROOM) } };
}

/**
 * The call the default artifact's `NoteEditorModal` makes.
 *
 * Copied field for field from `src/ui/components/NoteEditorModal.tsx`'s
 * `awardRoomClear({...})`, including `roomId` and **no** `clear`. Kept as a named constant rather
 * than inlined so a change to the modal's call shape is a diff here rather than a silent divergence
 * between the test and the shipping lane.
 */
type DefaultLaneClearInput = Parameters<
  import('@/store/progressionStore').ProgressionStoreState['awardRoomClear']
>[0];

function defaultLaneClear(
  overrides: Partial<DefaultLaneClearInput> = {},
): DefaultLaneClearInput {
  return {
    qualityBonus: 5,
    totalRooms: 1,
    creatorMappedRooms: 1,
    scribeClearedRooms: 1,
    archaeologistFullReviewPasses: 0,
    roomId: ROOM,
    isBossEncounter: false,
    ...overrides,
  };
}

interface Harness {
  /** The store **modules**, so a fresh registry after `vi.resetModules()` types correctly. */
  readonly progression: typeof import('@/store/progressionStore');
  readonly session: typeof import('@/store/sessionStore');
  readonly subject: typeof import('@/store/subjectStore');
  readonly tracker: typeof import('@/services/sessionTracker');
  readonly binding: typeof import('@/store/sessionLifecycleBinding');
  readonly activate: (subjectId: string) => Promise<boolean>;
}

/**
 * A freshly imported application with the lifecycle wired.
 *
 * `vi.resetModules()` per harness is what makes "after reload" a real reload: fresh module
 * instances, fresh store singletons, and - the point - no in-memory carry-over of the guard's own
 * state. The guard reads `extraFields` from the persisted record every time, so a harness that did
 * not reset would be testing a different thing.
 */
async function harness(options: { readonly freshModules?: boolean } = {}): Promise<Harness> {
  if (options.freshModules !== false) {
    vi.resetModules();
    window.localStorage.clear();
  }
  const subject = await import('@/store/subjectStore');
  const progression = await import('@/store/progressionStore');
  const session = await import('@/store/sessionStore');
  const tracker = await import('@/services/sessionTracker');
  const binding = await import('@/store/sessionLifecycleBinding');
  const activation = await import('@/application/subjectActivation');

  subject.useSubjectStore.getState().setSnapshot(clearedSnapshot());
  progression.useProgressionStore
    .getState()
    .hydrateProgression(progression.readPersistedProgressionPayload());
  progression.useProgressionStore.getState().setActiveSubject(SUBJECT);
  session.useSessionStore.getState().setActiveSubjectId(SUBJECT);
  window.localStorage.setItem(STORAGE_KEYS.activeSubjectId, SUBJECT);
  // Tracked so `afterEach` can dispose it. A wiring left installed would keep its `pagehide`
  // listener attached to the shared `window` after `vi.resetModules()`, and the next harness's
  // close events would reach this one's controller - which is how a record count becomes off by an
  // amount nobody can explain.
  INSTALLED.push(binding.installSessionLifecycleBinding());

  const loadFor = (subjectId: string): SubjectSnapshot =>
    subjectId === SUBJECT ? clearedSnapshot(SUBJECT) : clearedSnapshot(OTHER_SUBJECT);

  const activate = async (subjectId: string): Promise<boolean> => {
    subject.useSubjectStore.getState().setSnapshot(loadFor(subjectId));
    const result = await activation.activateSubject(subjectId, {
      loadSubject: async (id) => loadFor(id),
      setSessionActiveSubjectId: (id) => session.useSessionStore.getState().setActiveSubjectId(id),
      setProgressionActiveSubject: (id) =>
        progression.useProgressionStore.getState().setActiveSubject(id ?? ''),
    });
    return result.activated;
  };

  return { progression, session, subject, tracker, binding, activate };
}

/** Every statistics event on the active subject, read from the persisted record. */
function persistedEvents(h: Harness): readonly StatisticsEvent[] {
  void h;
  const raw = window.localStorage.getItem(PROG_KEY);
  if (raw === null) return [];
  const parsed = JSON.parse(raw) as {
    bySubject?: Record<string, Record<string, unknown> & { extraFields?: Record<string, unknown> }>;
  };
  const own = parsed.bySubject?.[SUBJECT];
  // The legacy mirror flattens the preserved bag into the record's top level. Read the canonical
  // bag first, then the flattened key, so this helper is correct on either repository - and the
  // browser lane pins which shape each repository produces.
  const fromCanonical = readStatisticsEventLedgerFromFields(own?.extraFields);
  if (fromCanonical.events.length > 0) return fromCanonical.events;
  const flattened = own?.statisticsEventLedger;
  return flattened === undefined
    ? []
    : readStatisticsEventLedgerFromFields({ statisticsEventLedger: flattened }).events;
}

/** The counts this gate asserts on, read from the **persisted** record. */
function persistedTotals(h: Harness): {
  xpTotal: number;
  roomsCleared: number;
  streakCount: number;
  noteEvents: number;
  xpEvents: number;
} {
  const raw = window.localStorage.getItem(PROG_KEY);
  const parsed =
    raw === null
      ? { bySubject: {} as Record<string, Record<string, unknown>> }
      : (JSON.parse(raw) as { bySubject: Record<string, Record<string, unknown>> });
  const own = parsed.bySubject[SUBJECT] ?? {};
  const events = persistedEvents(h);
  return {
    xpTotal: Number(own.xpTotal ?? 0),
    roomsCleared: Number(own.roomsCleared ?? 0),
    streakCount: Number(own.streakCount ?? 0),
    noteEvents: events.filter((event) => event.kind === 'note-submission').length,
    xpEvents: events.filter((event) => event.kind === 'xp-award').length,
  };
}

/**
 * Count `localStorage.setItem` calls for the progression key, and `Math.random` calls, across one
 * synchronous block.
 *
 * Returned as counters with their own positive controls, because a spy that was never installed
 * reports zero and a spy that was installed on the wrong object also reports zero.
 */
function measureWrites<T>(run: () => T): {
  readonly result: T;
  readonly progressionWrites: number;
  readonly randomCalls: number;
} {
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const random = vi.spyOn(Math, 'random');
  try {
    const result = run();
    return {
      result,
      progressionWrites: setItem.mock.calls.filter((call) => call[0] === PROG_KEY).length,
      randomCalls: random.mock.calls.length,
    };
  } finally {
    setItem.mockRestore();
    random.mockRestore();
  }
}

/** Disposers for every wiring this file installs, newest last. */
const INSTALLED: Array<() => void> = [];

beforeEach(() => {
  window.localStorage.clear();
  // The legacy repository is selected explicitly. A leaked storage-v2 selection from an earlier
  // test in this worker makes `savePersistedBySubject` route the mirror write through
  // `writeThroughInBackground`, which is **asynchronous** - so a synchronous write-counting block
  // would see zero calls for an action that did write, and every "no write" assertion below would
  // pass for the wrong reason. Caught by the positive control in the last case.
  resetRepositorySelection();
  while (INSTALLED.length > 0) {
    const dispose = INSTALLED.pop();
    if (dispose === undefined) continue;
    try {
      dispose();
    } catch {
      /* module registry was reset underneath it */
    }
  }
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// The guard, on its own terms
// ─────────────────────────────────────────────────────────────────────────────

describe('the default lane derives a stable identity from the room alone', () => {
  it('is deterministic, room-scoped, and prefixed so it cannot collide with a clear identity', async () => {
    await harness();
    const first = deriveNoteSubmissionSourceIdentity({ roomId: ROOM });
    const second = deriveNoteSubmissionSourceIdentity({ roomId: ROOM });
    const other = deriveNoteSubmissionSourceIdentity({ roomId: `${ROOM}-2` });
    // `ROOM` is app-minted and non-blank, so the derivation cannot return `null`. Asserted rather
    // than asserted-away, because a `null` here would make every comparison below vacuously true.
    expect(first, 'a non-blank room id produced no note-submission identity').not.toBeNull();
    if (first === null || second === null || other === null) {
      throw new Error('a non-blank room id produced no note-submission identity');
    }
    const clearIdentity = (await import('@/core/progression/roomClearRewards')).deriveRoomClearIdentity;
    const clear = clearIdentity({
      dungeon: clearedSnapshot().dungeon,
      roomId: ROOM,
    } as never);

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    // Two key spaces that provably cannot overlap, which is what the prefix is for.
    expect(first.startsWith('csub-')).toBe(true);
    expect(clear.startsWith('clear-')).toBe(true);
    expect(clear).not.toContain('csub-');

    // The payload is the room and a version tag, and nothing else. A subject in here would buy
    // nothing - the event id already carries it - and a topic would be learner content in a digest.
    const digest = first.slice('csub-'.length);
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('CONTROL: the store really does derive it, so the case above is not testing a helper the lane ignores', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    h.progression.useProgressionStore.getState().awardRoomClear(defaultLaneClear());

    // The recorded event's own identity is the one the store derived. Recomputing it from the same
    // rule is a cross-check, not the assertion: the assertion is that ONE note event exists at all.
    expect(persistedTotals(h).noteEvents).toBe(1);
    expect(persistedTotals(h).xpEvents).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The eight attacks
// ─────────────────────────────────────────────────────────────────────────────

describe('eight ways to try to make the default lane pay twice', () => {
  it('ATTACK 1 - resubmitting the same valid note pays once', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();

    const first = store.awardRoomClear(defaultLaneClear());
    const second = store.awardRoomClear(defaultLaneClear());
    const third = store.awardRoomClear(defaultLaneClear());

    expect(first.awarded).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.xpGained).toBeGreaterThan(0);
    expect(second.awarded).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.awarded).toBe(false);

    const totals = persistedTotals(h);
    expect(totals.xpTotal).toBe(first.xpGained);
    expect(totals.roomsCleared).toBe(1);
    expect(totals.streakCount).toBe(1);
    expect(totals.noteEvents).toBe(1);
    expect(totals.xpEvents).toBe(1);
  });

  it('ATTACK 2 - a double dispatch in one tick pays once', async () => {
    // The StrictMode double-invocation shape: two dispatches with nothing awaited between them.
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();
    const outcomes = [
      store.awardRoomClear(defaultLaneClear()),
      store.awardRoomClear(defaultLaneClear()),
      store.awardRoomClear(defaultLaneClear()),
    ];
    expect(outcomes.filter((entry) => entry.awarded)).toHaveLength(1);
    expect(persistedTotals(h).noteEvents).toBe(1);
    expect(persistedTotals(h).roomsCleared).toBe(1);
  });

  it('ATTACK 3 - resubmitting after a reload pays once, because the guard reads the persisted record', async () => {
    const before = await harness();
    expect(await before.activate(SUBJECT)).toBe(true);
    const first = before.progression.useProgressionStore.getState().awardRoomClear(defaultLaneClear());
    expect(first.awarded).toBe(true);
    const xpAfterFirst = persistedTotals(before).xpTotal;
    expect(xpAfterFirst).toBeGreaterThan(0);
    before.tracker.endCurrentSession();

    // A genuine reload: fresh modules, fresh store singletons, the same legacy keys. Any guard
    // held in a module-level variable rather than in the record would be lost here - which is the
    // whole reason the statistics ledger was chosen as the guard.
    const after = await harness({ freshModules: false });
    const record = window.localStorage.getItem(PROG_KEY);
    expect(record, 'the reload lost the progression key entirely').not.toBeNull();

    const second = after.progression.useProgressionStore.getState().awardRoomClear(defaultLaneClear());
    expect(second.awarded).toBe(false);
    expect(second.duplicate).toBe(true);
    const totals = persistedTotals(after);
    expect(totals.xpTotal).toBe(xpAfterFirst);
    expect(totals.roomsCleared).toBe(1);
    expect(totals.noteEvents).toBe(1);
    expect(totals.xpEvents).toBe(1);
  });

  it('ATTACK 4 - switching subject and back pays once', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const first = h.progression.useProgressionStore.getState().awardRoomClear(defaultLaneClear());
    expect(first.awarded).toBe(true);

    // Away to another subject: the progression store's active subject moves, the record for the
    // first subject is carried forward untouched, and the first session closes.
    expect(await h.activate(OTHER_SUBJECT)).toBe(true);
    expect(await h.activate(SUBJECT)).toBe(true);

    const again = h.progression.useProgressionStore.getState().awardRoomClear(defaultLaneClear());
    expect(again.awarded).toBe(false);
    expect(again.duplicate).toBe(true);
    const totals = persistedTotals(h);
    expect(totals.roomsCleared).toBe(1);
    expect(totals.noteEvents).toBe(1);
    // And the second subject's own record was never given the first subject's ledger.
    const raw = JSON.parse(window.localStorage.getItem(PROG_KEY) as string) as {
      bySubject: Record<string, Record<string, unknown>>;
    };
    expect(raw.bySubject[OTHER_SUBJECT]?.xpTotal).toBe(0);
    expect(raw.bySubject[OTHER_SUBJECT]?.statisticsEventLedger).toBeUndefined();
  });

  it('ATTACK 5 - the accepted trade, pinned: the room pays once per subject, not once per generation', async () => {
    // This is the trade the fix accepted, stated as a test rather than as a caveat. A graph edit
    // that re-opens the room does **not** re-pay on this lane, and the lane-scoped identity is why.
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();
    const first = store.awardRoomClear(defaultLaneClear());
    expect(first.awarded).toBe(true);
    const xpAfterFirst = first.xpGained;

    // A second submission carrying a *different* per-generation clear identity, which is what the
    // command lane would pass. The store prefers the explicit `clear` when it is given one, so this
    // call is a different identity and IS payable - which is the command lane's behaviour, and the
    // reason the two lanes must not be conflated.
    const withClearIdentity = store.awardRoomClear({
      ...defaultLaneClear(),
      clear: { roomId: ROOM, clearIdentity: 'clear-generation-two' },
    });
    expect(withClearIdentity.awarded).toBe(true);
    expect(withClearIdentity.xpGained).toBeGreaterThan(0);

    // And the *lane-scoped* resubmission after that is still refused, because the lane-scoped
    // identity is still recorded from the first call.
    const laneScopedAgain = store.awardRoomClear(defaultLaneClear());
    expect(laneScopedAgain.awarded).toBe(false);
    expect(laneScopedAgain.duplicate).toBe(true);

    const totals = persistedTotals(h);
    expect(totals.roomsCleared).toBe(2);
    expect(totals.xpTotal).toBe(xpAfterFirst + withClearIdentity.xpGained);
    expect(totals.noteEvents).toBe(2);
  });

  it('ATTACK 6 - two closes in a row pay once (the close path cannot re-award)', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();
    store.awardRoomClear(defaultLaneClear());
    const xpAfterFirst = persistedTotals(h).xpTotal;

    h.tracker.endCurrentSession();
    h.tracker.endCurrentSession();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    expect(await h.activate(SUBJECT)).toBe(true);

    const again = h.progression.useProgressionStore.getState().awardRoomClear(defaultLaneClear());
    expect(again.awarded).toBe(false);
    expect(persistedTotals(h).xpTotal).toBe(xpAfterFirst);
    expect(persistedTotals(h).noteEvents).toBe(1);
  });

  it('ATTACK 7 - the session-side counter also refuses, so the display copy cannot drift', async () => {
    // The ledger is the authority; the session record's `notesSubmitted` is a display copy written
    // after the award. If a rejected resubmit still bumped it, the dashboard's per-session cards
    // would disagree with the device totals - two answers to one question.
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();
    store.awardRoomClear(defaultLaneClear());
    const afterFirst = h.tracker.getCurrentSession();
    expect(afterFirst?.notesSubmitted).toBe(1);
    const xpAfterFirst = afterFirst?.xpEarned as number;
    expect(xpAfterFirst).toBeGreaterThan(0);

    store.awardRoomClear(defaultLaneClear());
    const afterSecond = h.tracker.getCurrentSession();
    expect(afterSecond?.notesSubmitted).toBe(1);
    expect(afterSecond?.xpEarned).toBe(xpAfterFirst);
  });

  it('ATTACK 8 - a room with no id falls back to the uncounted pre-Phase-15 lane, and does not poison the guard', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();

    // `roomId: undefined` is the pre-Phase-15 call shape, preserved on purpose for the
    // byte-comparison fixtures. No identity, therefore no guard and no count - which is the trade,
    // stated rather than hidden.
    const missing = store.awardRoomClear({ ...defaultLaneClear(), roomId: undefined });
    expect(missing.duplicate).toBe(false);
    expect(persistedTotals(h).noteEvents).toBe(0);
    expect(persistedTotals(h).xpEvents).toBe(0);

    // RESIDUAL, stated rather than hidden: the fallback lane **pays** and is **not counted**. So
    // `roomsCleared` and XP move while the dashboard reports nothing - which is the pre-Phase-18
    // defect, still present on the no-`roomId` call shape that `savePersistedBySubject`'s
    // byte-comparison fixtures and `tests/phase15/**` depend on. That shape is preserved
    // deliberately, and the shipping lane no longer uses it (it passes `roomId`), so this is a
    // documented residue rather than a live path. The number is asserted so a future change to it
    // is a visible diff.
    expect(persistedTotals(h).roomsCleared, 'the uncounted fallback lane changed roomsCleared').toBe(1);

    // And the real room still pays exactly once afterwards: the fallback left no guard behind that
    // would swallow it, and no ledger row that would double-count later.
    const real = store.awardRoomClear(defaultLaneClear());
    expect(real.awarded).toBe(true);
    expect(persistedTotals(h).noteEvents).toBe(1);
    expect(persistedTotals(h).roomsCleared).toBe(2);
  });

  it('ATTACK 9 - two DIFFERENT rooms on the default lane both pay, so the identity is not coarser than the room', async () => {
    // Added while probing, and the reason is worth recording accurately.
    //
    // Probe R3 replaced `deriveNoteSubmissionSourceIdentity` with a **constant** - every room in a
    // subject sharing one key - and eight attacks stayed green, because all eight resubmit the
    // *same* room, and a coarser identity is strictly stronger at suppression. So this case was
    // added for the failure a coarse identity would cause if it had one: a second room silently
    // never paying.
    //
    // **It then turned out this case does not detect R3 either, and the reason is structural.**
    // `noteSubmissionEventSourceIdentity` is `[room:<roomId>, clear:<clearIdentity>]`, and
    // `deriveStatisticsEventId` hashes both, so `roomId` discriminates *independently* of the
    // lane-scoped digest. The digest is therefore a redundant discriminator rather than the load-
    // bearing one, and coarsening it costs nothing. R3 is caught only by the identity-shape case,
    // which is the honest accounting: this case pins a real property, but it is not the probe for
    // R3 and this comment previously said it was.
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();

    const firstRoom = store.awardRoomClear(defaultLaneClear());
    const secondRoom = store.awardRoomClear(
      defaultLaneClear({ roomId: `${ROOM}-2`, totalRooms: 2, scribeClearedRooms: 2 }),
    );

    expect(firstRoom.awarded).toBe(true);
    expect(secondRoom.awarded, 'a second distinct room was refused on the default lane').toBe(true);
    expect(secondRoom.duplicate).toBe(false);
    expect(secondRoom.xpGained).toBeGreaterThan(0);

    const totals = persistedTotals(h);
    expect(totals.roomsCleared).toBe(2);
    expect(totals.noteEvents).toBe(2);
    expect(totals.xpEvents).toBe(2);
    expect(totals.xpTotal).toBe(firstRoom.xpGained + secondRoom.xpGained);
    // And the two events name two different rooms, so the pair is not one event seen twice.
    const rooms = persistedEvents(h)
      .filter((event) => event.kind === 'note-submission')
      .map((event) => (event as { roomId: string }).roomId)
      .sort();
    expect(rooms).toEqual([ROOM, `${ROOM}-2`].sort());
  });

  it('a BLANK or whitespace-only roomId takes the uncounted lane, exactly as an absent id does', async () => {
    // The registered reproduction, kept as a live assertion. Found while writing ATTACK 8:
    // `deriveNoteSubmissionSourceIdentity` hashed `` `room:${roomId}` `` without validating it, and
    // the store derived an identity whenever `roomId !== undefined`. `''` and `'   '` are two
    // *different* strings, so they minted two distinct payable identities for one room that does not
    // exist. `deriveNoteSubmissionSourceIdentity`'s own comment argued "the separator is a newline,
    // which cannot occur inside a room id" - true, and beside the point: the question is whether the
    // id is a room id at all.
    //
    // ── A correction to the registered reproduction, because the shape of the damage matters ──
    // The registration said "`noteEvents` is 2". It was not. `readStatisticsEventLedger` already
    // routes a note event's `roomId` through `toTrimmedString` and drops the row when nothing is
    // left, so the two note rows were invisible on read. What *did* survive - and what a learner
    // would see - was their `xp-award` sibling, which carries no room and is accepted as written:
    // the ledger reported 54 XP for two rooms that do not exist. Worse, the note row was constructed,
    // written, silently dropped by the reader inside `writeStatisticsEventsToFields`' own
    // read-modify-write, and its sibling kept - so the persisted ledger held an XP award with no
    // submission behind it. Both halves are closed by refusing to mint the identity at all.
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();

    // CONTROL: the same fixture with *absent* ids, which already took the uncounted lane. Two calls,
    // like the two blank ones below, so the comparison is like-for-like rather than one award
    // against two.
    const absent = await harness();
    expect(await absent.activate(SUBJECT)).toBe(true);
    const absentStore = absent.progression.useProgressionStore.getState();
    absentStore.awardRoomClear({ ...defaultLaneClear(), roomId: undefined });
    absentStore.awardRoomClear({ ...defaultLaneClear(), roomId: undefined });
    const absentTotals = persistedTotals(absent);

    const empty = store.awardRoomClear({ ...defaultLaneClear(), roomId: '' });
    const padded = store.awardRoomClear({ ...defaultLaneClear(), roomId: '   ' });

    // ── Nothing is counted, on either blank spelling.
    const totals = persistedTotals(h);
    expect(totals.noteEvents, 'a blank room id was counted').toBe(0);
    expect(totals.xpEvents, 'a blank room id was paid in the ledger').toBe(0);
    // No event of any kind may name a blank room, and none may exist at all.
    expect(persistedEvents(h), 'the uncounted lane wrote a statistics event').toEqual([]);
    for (const event of persistedEvents(h)) {
      if (event.kind !== 'note-submission') continue;
      expect(String(event.roomId).trim().length, 'a blank room id reached the ledger').toBeGreaterThan(0);
    }

    // ── Indistinguishable from the absent-id lane, value for value. This is the assertion that
    // makes "routed to the uncounted lane" a measurement rather than a claim: if a blank id had
    // been *rejected* instead, `roomsCleared` and `xpTotal` would be 0 here and 1 there.
    expect(totals.xpTotal, 'a blank room id changed the payment the absent-id lane makes').toBe(
      absentTotals.xpTotal,
    );
    expect(totals.roomsCleared).toBe(absentTotals.roomsCleared);
    expect(totals.streakCount).toBe(absentTotals.streakCount);
    // The documented residue of that lane: it PAYS and is not counted. Stated here so the trade is
    // visible in the test that introduced the case, and asserted so a future change to it is a diff.
    expect(totals.roomsCleared, 'the uncounted lane stopped paying').toBe(2);
    expect(empty.duplicate, 'a blank room id was reported as a duplicate').toBe(false);
    expect(padded.duplicate).toBe(false);

    // ── And it poisons nothing: a real room still pays exactly once, and is counted exactly once,
    // afterwards. A minted-then-discarded identity would leave a ledger row here.
    const real = h.progression.useProgressionStore
      .getState()
      .awardRoomClear(defaultLaneClear());
    expect(real.awarded).toBe(true);
    expect(real.duplicate, 'the blank ids left a guard that swallowed the real room').toBe(false);
    const after = persistedTotals(h);
    expect(after.noteEvents).toBe(1);
    expect(after.xpEvents).toBe(1);
    expect(after.roomsCleared).toBe(3);

    // ── The derivation itself, so the rule is pinned where it is enforced and not only through the
    // store. `null`, not a digest of nothing.
    expect(deriveNoteSubmissionSourceIdentity({ roomId: '' })).toBeNull();
    expect(deriveNoteSubmissionSourceIdentity({ roomId: '   ' })).toBeNull();
    expect(deriveNoteSubmissionSourceIdentity({ roomId: '\t\n ' })).toBeNull();
    // And a real id is untouched, including one that merely *contains* whitespace.
    expect(deriveNoteSubmissionSourceIdentity({ roomId: ROOM })).toMatch(/^csub-[0-9a-f]{8}$/);
    const paddedReal = deriveNoteSubmissionSourceIdentity({ roomId: ` ${ROOM} ` });
    expect(paddedReal).toMatch(/^csub-[0-9a-f]{8}$/);
    // A padded id is a **different** string and keeps its own identity: folding it into the trimmed
    // spelling would merge two ids on a guess about which one the caller meant.
    expect(paddedReal).not.toBe(deriveNoteSubmissionSourceIdentity({ roomId: ROOM }));
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// A rejected resubmit performs no write at all
// ─────────────────────────────────────────────────────────────────────────────

describe('a rejected resubmit performs no write at all', () => {
  it('writes nothing to storage, does not rebuild the record, and burns no Math.random', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);

    // ── The A side. The first award is the positive control, and it is the *same measurement* as
    // the B side: the same spy's counters, the same filter, the same synchronous block. An earlier
    // version of this case measured the control on a *second* call - which is itself a reject, and
    // so reported zero writes, and the control then "proved" that the spy worked by proving that a
    // call which does nothing writes nothing.
    const paid = measureWrites(() =>
      h.progression.useProgressionStore.getState().awardRoomClear(defaultLaneClear()),
    );
    expect(paid.result.awarded).toBe(true);
    expect(paid.progressionWrites, 'the setItem spy cannot see a real progression write').toBeGreaterThan(0);
    const xpAfterFirst = paid.result.xpGained;
    expect(xpAfterFirst).toBeGreaterThan(0);

    // `Math.random` is drawn on by the badge and loot paths only for some inputs, so the control
    // for that counter is a direct call: what is being proved is that the spy is installed on the
    // function the store would draw from, not that this particular award draws.
    const randomSpy = vi.spyOn(Math, 'random');
    try {
      Math.random();
      expect(randomSpy.mock.calls.length, 'the Math.random spy is not installed').toBeGreaterThan(0);
    } finally {
      randomSpy.mockRestore();
    }

    // ── The B side. Everything below is a measurement of a *reject*.
    const bySubjectBefore = h.progression.useProgressionStore.getState().bySubject;
    const persistedBefore = window.localStorage.getItem(PROG_KEY);
    const totalsBefore = persistedTotals(h);

    const released = measureWrites(() =>
      h.progression.useProgressionStore.getState().awardRoomClear(defaultLaneClear()),
    );

    expect(released.result.awarded).toBe(false);
    expect(released.result.duplicate).toBe(true);
    // The whole released-result shape, not just `awarded`: a caller announces loot, badges and
    // achievements from these, so an empty shape is part of "writes nothing".
    expect(released.result.xpGained).toBe(0);
    expect(released.result.loot).toBeNull();
    expect(released.result.unlockedBadges).toEqual([]);
    expect(released.result.unlockedAchievements).toEqual([]);
    expect(released.result.rankChanged).toBe(false);
    // 1. No persistence write at all.
    expect(released.progressionWrites, 'the rejected resubmit still wrote the progression key').toBe(0);
    // 2. The store's record object is the same object, so no `set` rebuilt it.
    expect(h.progression.useProgressionStore.getState().bySubject).toBe(bySubjectBefore);
    // 3. No randomness was drawn.
    expect(released.randomCalls, 'the rejected resubmit burned Math.random').toBe(0);

    // And the bytes on disk are identical, not merely equivalent.
    expect(window.localStorage.getItem(PROG_KEY)).toBe(persistedBefore);
    expect(persistedTotals(h)).toEqual(totalsBefore);
    expect(persistedTotals(h).xpTotal).toBe(xpAfterFirst);
  });

  it('the rejected result reports the record\'s OWN rank, never a fabricated default', async () => {
    // `releasedRoomClear(current.rank)` is passed the record's rank deliberately. A released
    // award that reported `Novice` would describe a learner who had earned something as a beginner,
    // and `rankChanged: false` beside a wrong rank is a self-contradiction in the return value.
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();
    const first = store.awardRoomClear(defaultLaneClear());
    expect(first.awarded).toBe(true);

    const rankBefore = h.progression.useProgressionStore.getState().rank;
    const released = store.awardRoomClear(defaultLaneClear());
    expect(released.awarded).toBe(false);
    expect(released.newRank).toBe(rankBefore);
    expect(released.rankChanged).toBe(false);
    expect(released.newRank).toBe(first.newRank);
  });
});