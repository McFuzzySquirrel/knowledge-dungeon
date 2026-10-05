/**
 * Phase 18 gate 3: nothing is counted twice.
 *
 * ## The exit criterion under test
 *
 * Phase 18: *"No duplicate sessions, XP, room, note, review, or fish events occur."* That is a
 * claim about **five** different triggers colliding, so this file drives all five:
 *
 * 1. **React StrictMode** - an install / dispose / install cycle of the real wiring, plus
 *    repeated canonical activations. Not a *simulated* double call: the real disposer runs and
 *    the real installer runs again, which is what StrictMode does to an effect.
 * 2. **Retries** - the same room clear, the same review pass, and the same catch issued twice,
 *    against the real progression store.
 * 3. **Repeated close events** - five real `pagehide` dispatches, and a `pagehide` that follows
 *    a real `visibilitychange`.
 * 4. **Re-entrancy** - an end request issued from inside the notification the close itself
 *    causes.
 * 5. **All five end signals in sequence, then a reload** - subject change, return to village,
 *    route unmount, `pagehide`, reliable visibility transition, and a module-level reload.
 *
 * Plus the storage-v2 **write race** the domain layer reports as fixed: twenty concurrent keyed
 * writes must all land, measured against a real generation rather than against local array
 * arithmetic.
 *
 * ## What is measured
 *
 * Real persisted state, read back:
 *
 * - the legacy `knowledge-dungeon:v1:sessions` key, through the one validator the reader uses;
 * - the canonical progression record's `statisticsEventLedger`, for note / review / XP / fish;
 * - the progression counters themselves, so "no duplicate XP" is a statement about XP and not
 *   only about a ledger row.
 *
 * Where a case needs to prove its *measurement* can distinguish two outcomes, a `CONTROL`
 * case asserts the opposite outcome with the same fixture.
 *
 * ## What this file does NOT do
 *
 * It does not assert that the wiring is *installed*; it asserts what the wiring writes. A test
 * that proved the installer ran would still pass with a sink that recorded nothing.
 *
 * Privacy: every fixture is synthetic. No learner data, no URL, no request body.
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
import { readStatisticsEventLedgerFromFields } from '@/core/statistics/statisticsEvents';
import { createSessionLifecycleController } from '@/application/sessionLifecycle';
import { FISH_CATALOG, type FishCatalogEntry } from '@/core/fishing/fishingTypes';
import { toCatchRewardIdentity } from '@/core/fishing/catchRewards';
import { createDeterministicIdFactory, fixedClock } from '@/services/persistence/v2/database';
import {
  openStorageV2Repository,
  type StorageV2Repository,
} from '@/services/persistence/v2/repository';
import {
  resetRepositorySelection,
  selectLegacyRepository,
} from '@/services/persistence/v2/repositorySelection';

const SESSION_KEY = 'knowledge-dungeon:v1:sessions';
const SUBJECT = 'synthetic-qa18-idempotency-subject';
const OTHER_SUBJECT = 'synthetic-qa18-idempotency-other';
const ROOM = 'synthetic-qa18-room-a';
const NOW = '2026-08-08T08:08:08.000Z';

type TrackerModule = typeof import('@/services/sessionTracker');
type StudyFlowModule = typeof import('@/application/studyFlow');
type ActivationModule = typeof import('@/application/subjectActivation');

function room(roomId: string): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass: true },
    reviewPassCount: 0,
  };
}

/**
 * The room-clear progress inputs.
 *
 * `totalRooms: 1` with `scribeClearedRooms: 1` so the clear is a *reward* rather than a refusal,
 * and `qualityBonus: 5` so it pays a non-zero amount - an XP award of `0` would make the
 * "one XP event" assertions unable to distinguish a recorded award from a clamped one.
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

/** One fully cleared room, so a room clear is a *reward* and not a refusal. */
function clearedSnapshot(
  dungeonId = SUBJECT,
  subjectName = 'Synthetic QA18 Subject',
): SubjectSnapshot {
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId,
    subjectName,
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

interface StoredSession {
  readonly sessionId: string;
  readonly subjectId: string;
  readonly endedAt: string | null;
  readonly roomsVisited: readonly string[];
  readonly notesSubmitted: number;
  readonly reviewsCompleted: number;
  readonly xpEarned: number;
}

/**
 * Read the stored sessions through the reader the application uses.
 *
 * Not `JSON.parse` of the raw key: the validator is the only thing standing between a
 * hand-edited key and the dashboard, so the count has to be taken on the validated side.
 */
function storedSessions(tracker: TrackerModule): StoredSession[] {
  return tracker.readSessionRecords().map((record) => ({
    sessionId: record.sessionId,
    subjectId: record.subjectId,
    endedAt: record.endedAt,
    roomsVisited: record.roomsVisited,
    notesSubmitted: record.notesSubmitted,
    reviewsCompleted: record.reviewsCompleted,
    xpEarned: record.xpEarned,
  }));
}

interface Harness {
  /** The store **modules**, so a fresh registry after `vi.resetModules()` is typed correctly. */
  readonly subject: typeof import('@/store/subjectStore');
  readonly progression: typeof import('@/store/progressionStore');
  readonly session: typeof import('@/store/sessionStore');
  readonly binding: typeof import('@/store/sessionLifecycleBinding');
  readonly tracker: TrackerModule;
  readonly flow: StudyFlowModule;
  readonly activation: ActivationModule;
  /** The snapshot the canonical activation loads for a given id. */
  readonly loadFor: (subjectId: string) => SubjectSnapshot;
  /** Run the canonical activation with the real store actions and this load function. */
  readonly activate: (subjectId: string) => Promise<boolean>;
}

/**
 * A freshly imported application, with the lifecycle wiring installed.
 *
 * The modules are re-imported per test because hydration is explicit in Phase 4: a reload is a
 * fresh module plus fresh hydration, and anything less is not a reload. `vi.resetModules()`
 * also resets the *singletons* - the lifecycle controller, the statistics sinks, and the
 * repository selection - which is what makes the StrictMode case below a real re-install
 * rather than a second call into an already-installed wiring.
 *
 * The activation's two store writes are the **real** actions, because the lifecycle's subject
 * port reads them when it decides whether to restart a session after a resume. Only
 * `loadSubject` is injected, so the fixture does not have to be a whole subject on disk.
 */
async function harness(options: { readonly keepStorage?: boolean } = {}): Promise<Harness> {
  vi.resetModules();
  if (options.keepStorage !== true) window.localStorage.clear();
  resetRepositorySelection();
  selectLegacyRepository();

  const subject = await import('@/store/subjectStore');
  const progression = await import('@/store/progressionStore');
  const session = await import('@/store/sessionStore');
  const tracker = await import('@/services/sessionTracker');
  const binding = await import('@/store/sessionLifecycleBinding');
  const flow = await import('@/application/studyFlow');
  // Imported **dynamically** for a reason this file exists to exercise. `vi.resetModules()`
  // gives the harness a fresh `@/core/statistics/activitySink`, and a statically imported
  // `activateSubject` would still hold the *old* copy - so the activation would report into a
  // module the binding never installed a sink into, and every "the wiring recorded it" assertion
  // below would be passing against a no-op. The static import is silently wrong here; this
  // comment is the fix, not a style preference.
  const activation: ActivationModule = await import('@/application/subjectActivation');

  subject.useSubjectStore.getState().setSnapshot(clearedSnapshot());
  progression.useProgressionStore
    .getState()
    .hydrateProgression(progression.readPersistedProgressionPayload());
  progression.useProgressionStore.getState().setActiveSubject(SUBJECT);
  session.useSessionStore.getState().setActiveSubjectId(SUBJECT);
  session.useSessionStore.getState().setActiveScreen('game');

  const dispose = installTracked(binding);
  void dispose;

  const loadFor = (subjectId: string): SubjectSnapshot =>
    subjectId === SUBJECT
      ? clearedSnapshot(SUBJECT)
      : clearedSnapshot(OTHER_SUBJECT, 'Synthetic QA18 Other');

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

  return { subject, progression, session, binding, tracker, flow, activation, loadFor, activate };
}

/**
 * A study-flow store port bound to the **real** stores.
 *
 * The point of using the real actions is that `returnToVillage` sets `activeScreen`, and the
 * route-unmount subscription in `sessionLifecycleBinding` reads that store. A fake port would
 * make the route-unmount trigger unreachable and the "five signals" case would quietly be
 * testing four.
 */
function storePortFor(h: Harness): Parameters<typeof h.flow.createStudyFlowController>[0]['store'] {
  const noop = (): void => undefined;
  const port = {
    getSnapshot: () => h.subject.useSubjectStore.getState().snapshot,
    getPhase: () => 'archaeologist',
    persistActiveSubjectId: noop,
    setFocusedRoomId: (id: string | null) => h.session.useSessionStore.getState().setFocusedRoomId(id),
    setActiveSubjectId: (id: string | null) => h.session.useSessionStore.getState().setActiveSubjectId(id),
    setActiveScreen: (screen: never) => h.session.useSessionStore.getState().setActiveScreen(screen),
    openNoteEditor: noop,
    closeMapView: noop,
    cancelTeleportMode: noop,
    setMobileHudOpen: noop,
    setProgressionActiveSubject: (id: string | null) =>
      h.progression.useProgressionStore.getState().setActiveSubject(id ?? ''),
    collectArtifactNote: () => true,
    awardReviewPass: () => ({ xpGained: 0, awarded: false, duplicate: false }),
    awardBadge: () => false,
    readProgressionBadges: (): readonly string[] => [],
    recordReviewPass: () => Promise.resolve(),
    readProgressionPreservedFields: () =>
      h.progression.useProgressionStore.getState().readProgressionPreservedFields(),
    writeReviewSession: noop,
  };
  return port as unknown as Parameters<typeof h.flow.createStudyFlowController>[0]['store'];
}

/** The study-flow controller, bound to the real stores. */
function controllerFor(h: Harness): ReturnType<typeof h.flow.createStudyFlowController> {
  return h.flow.createStudyFlowController({
    store: storePortFor(h),
    renderer: {} as Parameters<typeof h.flow.createStudyFlowController>[0]['renderer'],
    teleport: {} as Parameters<typeof h.flow.createStudyFlowController>[0]['teleport'],
    dungeonUi: { pushToast: () => undefined } as unknown as Parameters<
      typeof h.flow.createStudyFlowController
    >[0]['dungeonUi'],
  });
}

/**
 * Install the wiring and track its disposer.
 *
 * Every installation goes through here. A wiring installed directly and not tracked survives
 * `vi.resetModules()` - its listeners stay attached to the same `window` and the same
 * `localStorage` - so a later `firePageHide()` would close an *earlier* test's session and every
 * record count after it would be off. This helper is what makes "the record count" a number this
 * file can assert on.
 */
function installTracked(
  binding: typeof import('@/store/sessionLifecycleBinding'),
): () => void {
  const dispose = binding.installSessionLifecycleBinding();
  INSTALLED.push(dispose);
  return dispose;
}

/** Fire the real `pagehide` event the wiring listens for. */
function firePageHide(): void {
  window.dispatchEvent(new Event('pagehide'));
}

/**
 * Fire a real `visibilitychange`.
 *
 * `document.visibilityState` is a getter the wiring reads, so it is redefined for the duration
 * of the dispatch. The real `Event` is dispatched, so the wiring's own listener runs - this
 * does not call the handler directly.
 */
function fireVisibility(state: 'visible' | 'hidden'): void {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  try {
    document.dispatchEvent(new Event('visibilitychange'));
  } finally {
    if (descriptor === undefined) {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    } else {
      Object.defineProperty(document, 'visibilityState', descriptor);
    }
  }
}

/**
 * Wait until the active generation holds `count` session records.
 *
 * `pendingSessionWrites()` awaits the module's own serialized queue, but the storage-v2 publish
 * is deliberately fire-and-forget (`writeThroughInBackground`), so awaiting the queue is **not**
 * enough to observe the generation: verified, with only `pendingSessionWrites()` awaited the
 * active generation is still `null`. The dual-write *report* cannot be used as the signal
 * either - it is keyed by operation name, so twenty session publishes report as one entry.
 *
 * So the wait is on the thing being asserted, with a bound so a regression fails rather than
 * hangs. Polling the repository is not a weakening here: the assertion afterwards is on the
 * repository's contents, and a gate that waited on a proxy for a property would be the weaker
 * gate.
 */
async function waitForSessionsIn(
  repository: StorageV2Repository,
  count: number,
): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const generationId = await repository.readActiveGenerationId();
    if (generationId !== null) {
      const snapshot = await repository.readRecords(generationId);
      if (snapshot.records.sessions.length >= count) return generationId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the generation never held ${count} session records`);
}

/** Statistics events of one kind in the active subject's ledger. */
function eventsOfKind(h: Harness, kind: string): unknown[] {
  const record = h.progression.useProgressionStore.getState().bySubject[SUBJECT];
  const fields = record?.extraFields as Record<string, unknown> | undefined;
  return readStatisticsEventLedgerFromFields(fields).events.filter((event) => event.kind === kind);
}

/** Disposers for every wiring installed by this file, newest last. */
const INSTALLED: Array<() => void> = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  while (INSTALLED.length > 0) {
    const dispose = INSTALLED.pop();
    if (dispose === undefined) continue;
    try {
      dispose();
    } catch {
      /* the module registry was reset underneath it; the listeners are gone with the module */
    }
  }
  window.localStorage.clear();
  document.body.innerHTML = '';
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. StrictMode
// ─────────────────────────────────────────────────────────────────────────────

describe('React StrictMode: a double-invoked effect records once', () => {
  it('an install / dispose / install cycle leaves one wiring and one session', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);

    // StrictMode runs an effect's cleanup and the effect again. Calling the real disposer and
    // then the real installer is that sequence, not a simulation of it.
    const dispose = installTracked(h.binding);
    // A second install *without* disposing is what a double-invoked effect body does when the
    // cleanup has not run yet; it must return the same disposer rather than install a second set
    // of listeners.
    const disposeAgain = installTracked(h.binding);
    expect(disposeAgain).toBe(dispose);

    dispose();
    installTracked(h.binding);

    // And StrictMode double-*invokes* the activation itself.
    expect(await h.activate(SUBJECT)).toBe(true);
    expect(await h.activate(SUBJECT)).toBe(true);

    const open = h.tracker.getCurrentSession();
    expect(open).not.toBeNull();
    expect(open?.subjectId).toBe(SUBJECT);

    // One record so far: three installer calls and three activations produced one session.
    const sessions = storedSessions(h.tracker);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(open?.sessionId);

    // The room visit is recorded once even though the wiring was installed three times. Three
    // sets of `focusedRoomId` subscribers would each call `recordActivity`, and the session's
    // own `roomsVisited` set is what has to absorb that.
    h.session.useSessionStore.getState().setFocusedRoomId(ROOM);
    h.session.useSessionStore.getState().setFocusedRoomId(null);
    h.session.useSessionStore.getState().setFocusedRoomId(ROOM);
    h.session.useSessionStore.getState().setFocusedRoomId(null);
    h.session.useSessionStore.getState().setFocusedRoomId(ROOM);
    expect(h.tracker.getCurrentSession()?.roomsVisited).toEqual([ROOM]);

    h.tracker.endCurrentSession();
    const closed = storedSessions(h.tracker);
    expect(closed).toHaveLength(1);
    expect(closed[0].roomsVisited).toEqual([ROOM]);
  });

  it('CONTROL: the disposer really removes the wiring, so nothing is recorded at all', async () => {
    // Without this control the case above could be green because `recordActivity` de-duplicates
    // rather than because there was only ever one subscriber. Here the wiring is disposed, and
    // the observable is stronger than "a room visit records nothing": with the sinks removed, a
    // canonical activation starts **no session at all**, and a room entry writes nothing.
    const h = await harness();
    // The harness installed the wiring; dispose it before anything is recorded, so the only
    // possible outcome of the activation below is "the sink was not there".
    installTracked(h.binding)();
    expect(h.binding.hasSessionLifecycleBinding()).toBe(false);

    expect(await h.activate(SUBJECT)).toBe(true);
    // The canonical activation still ran - both store writes happened - but nothing was
    // recorded, because the sink it reports through has been uninstalled.
    expect(h.session.useSessionStore.getState().activeSubjectId).toBe(SUBJECT);
    expect(h.tracker.getCurrentSession()).toBeNull();
    h.session.useSessionStore.getState().setFocusedRoomId(ROOM);
    expect(storedSessions(h.tracker)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Retries at the three award sites
// ─────────────────────────────────────────────────────────────────────────────

describe('a retried award records one event and pays one reward', () => {
  it('a room clear issued three times records one note, one XP award, and one session note', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);

    const clear = { roomId: ROOM, clearIdentity: 'clear-0000qa18' };
    const first = h.progression.useProgressionStore
      .getState()
      .awardRoomClear({ ...clearInputs(), clear });
    const retry = h.progression.useProgressionStore
      .getState()
      .awardRoomClear({ ...clearInputs(), clear });
    const third = h.progression.useProgressionStore
      .getState()
      .awardRoomClear({ ...clearInputs(), clear });

    // One reward paid.
    expect(first.awarded).toBe(true);
    expect(retry.awarded).toBe(false);
    expect(third.awarded).toBe(false);

    // One note event and one XP event, in the ledger that rides the same record write.
    expect(eventsOfKind(h, 'note-submission')).toHaveLength(1);
    expect(eventsOfKind(h, 'xp-award')).toHaveLength(1);

    // And one session-side counter, not three. The ledger is the authority; this is the display
    // copy, emitted only where the award actually happened.
    expect(h.tracker.getCurrentSession()?.notesSubmitted).toBe(1);

    h.tracker.endCurrentSession();
    const sessions = storedSessions(h.tracker);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].notesSubmitted).toBe(1);
    expect(sessions[0].reviewsCompleted).toBe(0);
  });

  it('a review pass issued twice records one completion, and the next pass records another', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);

    const identity = { roomId: ROOM, passNumber: 1, reviewIdentity: 'review-0000qa18' };
    h.progression.useProgressionStore.getState().awardReviewPass(identity);
    h.progression.useProgressionStore.getState().awardReviewPass(identity);

    expect(eventsOfKind(h, 'review-completion')).toHaveLength(1);
    expect(eventsOfKind(h, 'xp-award')).toHaveLength(1);
    expect(h.progression.useProgressionStore.getState().reviewPasses).toBe(1);

    // A *different* pass is a different identity, so it records again. This is what makes the
    // "once" in "exactly once" mean once-per-award rather than once-per-subject.
    h.progression.useProgressionStore.getState().awardReviewPass({
      roomId: ROOM,
      passNumber: 2,
      reviewIdentity: 'review-0000qa18-pass-2',
    });
    expect(eventsOfKind(h, 'review-completion')).toHaveLength(2);
    expect(eventsOfKind(h, 'xp-award')).toHaveLength(2);
    expect(h.progression.useProgressionStore.getState().reviewPasses).toBe(2);
  });

  it('a catch issued twice records one kept fish, and a declined one records nothing', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();
    const catalogEntry = FISH_CATALOG.find((entry) => entry.id === 'moss-carp') as FishCatalogEntry;
    const identityFor = (castNumber: number) =>
      toCatchRewardIdentity({
        contextId: 'synthetic-qa18-pond-visit',
        catalogId: catalogEntry.id,
        castNumber,
      });
    const payload = {
      subjectId: SUBJECT,
      identity: identityFor(1),
      outcome: 'answered-correct' as const,
      catalogEntry,
      subjectName: 'Synthetic QA18 Subject',
      recallRoomId: null,
    };

    const first = store.recordCatch(payload);
    const retry = store.recordCatch(payload);

    expect(first.awarded).toBe(true);
    expect(retry.awarded).toBe(false);
    expect(eventsOfKind(h, 'fishing-outcome')).toHaveLength(1);
    expect(eventsOfKind(h, 'xp-award')).toHaveLength(1);
    expect(h.progression.useProgressionStore.getState().fishCollection).toHaveLength(1);

    // A declined outcome: no reward, no statistic, no session counter. A second cast of the
    // same species in the same pond visit, so only the outcome differs.
    h.progression.useProgressionStore.getState().recordCatch({
      ...payload,
      identity: identityFor(2),
      outcome: 'released',
    });
    expect(eventsOfKind(h, 'fishing-outcome')).toHaveLength(1);
    expect(h.progression.useProgressionStore.getState().fishCollection).toHaveLength(1);
  });

  it('CONTROL: a *different* clear identity DOES record again, so the suppression is per award', async () => {
    // The control for all three retry cases. Without it, a ledger that recorded nothing at all
    // would pass them.
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const store = h.progression.useProgressionStore.getState();
    store.awardRoomClear({
      ...clearInputs(),
      clear: { roomId: ROOM, clearIdentity: 'clear-generation-one' },
    });
    expect(eventsOfKind(h, 'note-submission')).toHaveLength(1);
    store.awardRoomClear({
      ...clearInputs(),
      clear: { roomId: ROOM, clearIdentity: 'clear-generation-two' },
    });
    expect(eventsOfKind(h, 'note-submission')).toHaveLength(2);
    expect(eventsOfKind(h, 'xp-award')).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 + 4. Repeated close events and re-entrancy
// ─────────────────────────────────────────────────────────────────────────────

describe('repeated close signals write one record', () => {
  it('five pagehide events in a row close one session', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    for (let index = 0; index < 5; index += 1) firePageHide();

    const sessions = storedSessions(h.tracker);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].endedAt).not.toBeNull();
    expect(h.tracker.getCurrentSession()).toBeNull();
  });

  it('a visibility transition closes the session and starts a fresh one, and pagehide closes that', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    const before = h.tracker.getCurrentSession();
    expect(before).not.toBeNull();
    const beforeId = before?.sessionId as string;

    // The reliable visibility transition, with a subject still active. The documented behaviour
    // is *both* halves: the open session closes, and a fresh one starts, so the tab-away window
    // falls outside both records. Asserting only the first half would pass with the restart
    // removed, and every award after the resume would then record nothing.
    fireVisibility('hidden');
    const resumed = h.tracker.getCurrentSession();
    expect(resumed, 'the resume did not start a session').not.toBeNull();
    expect(resumed?.sessionId, 'the resume reused the closed session id').not.toBe(beforeId);
    expect(resumed?.subjectId).toBe(SUBJECT);
    expect(resumed?.endedAt).toBeNull();

    // Now `pagehide`, then both again. Each closes at most the one that was open.
    firePageHide();
    firePageHide();
    fireVisibility('hidden');

    const sessions = storedSessions(h.tracker);
    // The original record exists exactly once, and closed.
    expect(sessions.filter((entry) => entry.sessionId === beforeId)).toHaveLength(1);
    expect(sessions.find((entry) => entry.sessionId === beforeId)?.endedAt).not.toBeNull();
    // No duplicate id anywhere: a second record with one id is the double write the ordering
    // inside `endSession` exists to prevent.
    expect(new Set(sessions.map((entry) => entry.sessionId)).size).toBe(sessions.length);
    // Exactly one session is left open, and it is not the original.
    const open = sessions.filter((entry) => entry.endedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].sessionId).not.toBe(beforeId);
    expect(h.tracker.getCurrentSession()?.sessionId).toBe(open[0].sessionId);
  });

  it('CONTROL: a visibility transition with no active subject starts nothing', async () => {
    // The control for the case above. Without it, the restart could be green because the
    // handler starts a session unconditionally - which is exactly the behaviour the module
    // header rules out, because a `visibilitychange` on the welcome screen must start nothing.
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);
    h.tracker.endCurrentSession();
    h.session.useSessionStore.getState().setActiveSubjectId(null);

    fireVisibility('hidden');
    expect(h.tracker.getCurrentSession()).toBeNull();
    expect(storedSessions(h.tracker).filter((entry) => entry.endedAt === null)).toHaveLength(0);
    expect(storedSessions(h.tracker)).toHaveLength(1);
  });

  it('a close that is re-entered from the notification it causes writes once', async () => {
    const h = await harness();
    expect(await h.activate(SUBJECT)).toBe(true);

    // `endSession` clears the active session *before* it persists, and notifies subscribers
    // after. A re-entrant end request from inside that notification has to find nothing open.
    // The re-entrancy is driven through a real store subscriber that fires on the very write
    // the close performs, which is the only notification a host can observe.
    let reentryCount = 0;
    const unsubscribe = h.progression.useProgressionStore.subscribe(() => {
      reentryCount += 1;
      if (reentryCount <= 5) h.tracker.endCurrentSession();
    });

    const sessionId = h.tracker.getCurrentSession()?.sessionId;
    expect(sessionId).toBeDefined();
    // Three end requests in a row, each able to re-enter the previous one.
    h.tracker.endCurrentSession();
    h.tracker.endCurrentSession();
    h.tracker.endCurrentSession();
    unsubscribe();

    const sessions = storedSessions(h.tracker);
    expect(sessions.filter((entry) => entry.sessionId === sessionId)).toHaveLength(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].endedAt).not.toBeNull();
  });

  it('an onChange subscriber that ends the session again writes once', async () => {
    // The genuine re-entrancy path: `endSession` notifies `onChange` **after** persisting, and
    // the ordering claim is that the active session is cleared *before* both. So a subscriber
    // that closes from inside the notification must find nothing open.
    //
    // This case builds its own controller rather than driving the module singleton, because the
    // singleton's `onChange` is fixed at construction and cannot be replaced from outside. The
    // persistence port is a recording fake, so what is asserted is *what the controller asked to
    // be written* - the property the ordering protects - and not a count read back from storage.
    const writes: Array<{ sessionId: string; endedAt: string | null }> = [];
    let reentries = 0;
    let armed = false;
    let controller!: import('@/application/sessionLifecycle').SessionLifecycleController;
    controller = createSessionLifecycleController({
      nowMs: () => Date.parse(NOW),
      persistence: {
        write: (record) => {
          writes.push({ sessionId: record.sessionId, endedAt: record.endedAt });
          return Promise.resolve();
        },
        read: () => Promise.resolve([]),
      },
      subject: { readActiveSubject: () => null },
      onChange: (record) => {
        // Armed only after the activation. A subscriber that re-entered during the activation's
        // own notification would close the brand-new session before the test could do anything
        // else, which is correct behaviour and not what this case is about.
        if (record === null || !armed) return;
        reentries += 1;
        // Re-enter from inside the notification the close itself caused.
        controller.endSession('pagehide');
      },
    });

    const started = controller.handleSubjectActivated({ subjectId: SUBJECT, subjectName: 'S' });
    expect(started).not.toBeNull();
    const sessionId = started?.sessionId as string;

    expect(controller.activeSession()?.sessionId).toBe(sessionId);
    armed = true;
    const outcome = controller.endSession('requested');
    expect(outcome.ended).toBe(true);
    // The subscriber ran, and its re-entrant end found nothing open.
    expect(reentries).toBeGreaterThanOrEqual(1);
    expect(controller.activeSession()).toBeNull();

    // Exactly two writes: the open record at activation, and the closed record at the end. The
    // re-entrant call wrote nothing.
    const closed = writes.filter((entry) => entry.endedAt !== null);
    expect(closed).toHaveLength(1);
    expect(closed[0].sessionId).toBe(sessionId);
    expect(new Set(writes.map((entry) => entry.sessionId)).size).toBe(1);

    // CONTROL: the same subscriber, without the re-entrant call, produces the same write count -
    // so the assertion above is measuring the re-entrancy and not the subscriber's existence.
    const controlWrites: Array<{ sessionId: string; endedAt: string | null }> = [];
    let control!: import('@/application/sessionLifecycle').SessionLifecycleController;
    control = createSessionLifecycleController({
      nowMs: () => Date.parse(NOW),
      persistence: {
        write: (record) => {
          controlWrites.push({ sessionId: record.sessionId, endedAt: record.endedAt });
          return Promise.resolve();
        },
        read: () => Promise.resolve([]),
      },
      subject: { readActiveSubject: () => null },
      onChange: () => undefined,
    });
    control.handleSubjectActivated({ subjectId: SUBJECT, subjectName: 'S' });
    control.endSession('requested');
    expect(controlWrites).toHaveLength(2);
    expect(controlWrites.filter((entry) => entry.endedAt !== null)).toHaveLength(1);
  });

  it('a close with nothing open reports false and writes nothing at all', async () => {
    const h = await harness();
    const keyBefore = window.localStorage.getItem(SESSION_KEY);
    expect(h.tracker.endCurrentSession().ended).toBe(false);
    expect(h.tracker.endCurrentSession().ended).toBe(false);
    expect(window.localStorage.getItem(SESSION_KEY)).toBe(keyBefore);
    expect(storedSessions(h.tracker)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. All five end signals, then a reload
// ─────────────────────────────────────────────────────────────────────────────

describe('the five end signals in sequence, then a reload', () => {
  it('leaves one closed session, no open session, and stable totals after a reload', async () => {
    const h = await harness();

    // ── Enter subject A, do real work, leave it.
    expect(await h.activate(SUBJECT)).toBe(true);
    h.session.useSessionStore.getState().setActiveScreen('game');
    h.session.useSessionStore.getState().setFocusedRoomId(ROOM);
    const clear = { roomId: ROOM, clearIdentity: 'clear-0000qa18-a' };
    h.progression.useProgressionStore.getState().awardRoomClear({ ...clearInputs(), clear });
    h.progression.useProgressionStore.getState().awardRoomClear({ ...clearInputs(), clear });

    // Leave through the canonical application path: `returnToVillage`, which is one of the five
    // end signals and is bound to the real stores so the `activeScreen` transition really
    // fires the route-unmount subscription.
    controllerFor(h).returnToVillage();

    // ── Every remaining end signal, in the order a browser and the router produce them. None
    // of them may open a second record for the same session.
    fireVisibility('hidden');
    firePageHide();
    h.session.useSessionStore.getState().setActiveScreen('welcome');
    firePageHide();

    const beforeReload = storedSessions(h.tracker);
    expect(beforeReload).toHaveLength(1);
    expect(beforeReload[0].subjectId).toBe(SUBJECT);
    expect(beforeReload[0].endedAt).not.toBeNull();
    expect(beforeReload[0].notesSubmitted).toBe(1);
    expect(beforeReload[0].roomsVisited).toEqual([ROOM]);
    expect(new Set(beforeReload.map((entry) => entry.sessionId)).size).toBe(1);

    // ── Reload: fresh modules, fresh hydration, the same legacy key.
    const beforeReloadBytes = window.localStorage.getItem(SESSION_KEY);
    const reloaded = await harness({ keepStorage: true });
    expect(window.localStorage.getItem(SESSION_KEY)).toBe(beforeReloadBytes);
    const afterReload = storedSessions(reloaded.tracker);
    expect(afterReload).toHaveLength(1);
    expect(afterReload[0].sessionId).toBe(beforeReload[0].sessionId);
    expect(afterReload[0].notesSubmitted).toBe(1);
    expect(afterReload[0].xpEarned).toBe(beforeReload[0].xpEarned);
    expect(afterReload[0].endedAt).toBe(beforeReload[0].endedAt);
    // The reload itself started nothing: recovery has no unterminated record to close.
    expect(reloaded.tracker.getCurrentSession()).toBeNull();

    // ── The reader over the reloaded records, twice, reports the same numbers.
    const first = reloaded.tracker.computeSessionStats(new Date(NOW));
    const second = reloaded.tracker.computeSessionStats(new Date(NOW));
    expect(first.totalSessions).toBe(1);
    expect(first.sessionsOpen).toBe(0);
    expect(first.totalNotesSubmitted).toBe(1);
    expect(second.totalSessions).toBe(1);
    expect(second.totalNotesSubmitted).toBe(1);
  });

  it('switching subjects closes the first session and does not disturb the first subject counters', async () => {
    const h = await harness();

    expect(await h.activate(SUBJECT)).toBe(true);
    h.progression.useProgressionStore
      .getState()
      .awardRoomClear({
        ...clearInputs(),
        clear: { roomId: ROOM, clearIdentity: 'clear-0000qa18-first' },
      });
    const firstSessionId = h.tracker.getCurrentSession()?.sessionId;

    // A second subject, loaded through the same canonical activation path.
    expect(await h.activate(OTHER_SUBJECT)).toBe(true);
    expect(h.tracker.getCurrentSession()?.subjectId).toBe(OTHER_SUBJECT);
    expect(h.tracker.getCurrentSession()?.sessionId).not.toBe(firstSessionId);

    // Activating the second subject again changes nothing.
    expect(await h.activate(OTHER_SUBJECT)).toBe(true);
    h.tracker.endCurrentSession();

    const sessions = storedSessions(h.tracker);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((entry) => entry.subjectId).sort()).toEqual([SUBJECT, OTHER_SUBJECT].sort());
    expect(sessions.every((entry) => entry.endedAt !== null)).toBe(true);
    // The first session keeps the note it earned; the second earned none.
    expect(sessions.find((entry) => entry.subjectId === SUBJECT)?.notesSubmitted).toBe(1);
    expect(sessions.find((entry) => entry.subjectId === OTHER_SUBJECT)?.notesSubmitted).toBe(0);
    // And the first subject's ledger is untouched by the second subject's session.
    expect(eventsOfKind(h, 'note-submission')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The storage-v2 write race
// ─────────────────────────────────────────────────────────────────────────────

describe('the storage-v2 write race is gone, measured against a real generation', () => {
  it('twenty concurrent keyed writes all land, and no record is lost or duplicated', async () => {
    const databaseName = `qa18-session-race-${process.pid}-${Date.now()}`;
    const repository: StorageV2Repository = await openStorageV2Repository({
      databaseName,
      clock: fixedClock(NOW),
      idFactory: createDeterministicIdFactory('qa18-race'),
    });

    let selection: typeof import('@/services/persistence/v2/repositorySelection') | null = null;
    try {
      // The lane the pre-Phase-18 race lived on: storage-v2 selected.
      //
      // The selection module is imported **after** `vi.resetModules()`, from the same fresh
      // registry the session tracker will see. Selecting on the statically imported copy is a
      // silent no-op here: the tracker reads a different module instance's selection, finds the
      // legacy default, and never publishes anything - so the whole case would "pass" against a
      // store that was not being tested. The assertion below is on the *dynamic* instance for
      // the same reason.
      vi.resetModules();
      window.localStorage.clear();
      selection = await import('@/services/persistence/v2/repositorySelection');
      selection.resetRepositorySelection();
      selection.selectStorageV2Repository(repository);
      expect(selection.isStorageV2Selected()).toBe(true);
      const tracker = await import('@/services/sessionTracker');
      expect(tracker.sessionPersistencePort).toBeDefined();

      const recordFor = (index: number) => ({
        sessionId: `synthetic-qa18-race-${String(index).padStart(2, '0')}`,
        subjectId: SUBJECT,
        subjectName: 'Synthetic QA18 Subject',
        startedAt: '2026-08-08T08:00:00.000Z',
        endedAt: '2026-08-08T08:05:00.000Z',
        roomsVisited: [ROOM],
        notesSubmitted: index,
        reviewsCompleted: 0,
        xpEarned: index * 2,
      });

      // Twenty distinct records written with no awaiting between them - the interleaving the
      // old read-modify-write could not survive, because every writer merged onto its own read.
      await Promise.all(
        Array.from({ length: 20 }, (_unused, index) =>
          tracker.sessionPersistencePort.write(recordFor(index)),
        ),
      );
      await tracker.pendingSessionWrites();
      const generationId = await waitForSessionsIn(repository, 20);
      const snapshot = await repository.readRecords(generationId);
      const ids = snapshot.records.sessions.map((entry) => entry.value.sessionId).sort();

      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
      expect(ids[0]).toBe('synthetic-qa18-race-00');
      expect(ids[19]).toBe('synthetic-qa18-race-19');
      // The per-record payloads are the ones that were written, not the last writer's.
      const notesById = new Map(
        snapshot.records.sessions.map((entry) => [
          entry.value.sessionId,
          entry.value.notesSubmitted,
        ]),
      );
      expect(notesById.get('synthetic-qa18-race-07')).toBe(7);
      expect(notesById.get('synthetic-qa18-race-19')).toBe(19);

      // And the legacy mirror the shipping repository reads agrees, because it is written
      // synchronously before the generation publish.
      expect(storedSessions(tracker)).toHaveLength(20);

      // Re-publishing the same twenty ids must converge on twenty records, not forty.
      for (const id of ids) {
        await tracker.sessionPersistencePort.write({
          ...recordFor(0),
          sessionId: id,
          endedAt: '2026-08-08T08:06:00.000Z',
          notesSubmitted: 1,
          xpEarned: 1,
        });
      }
      await tracker.pendingSessionWrites();
      const after = await repository.readRecords(await waitForSessionsIn(repository, 20));
      expect(after.records.sessions).toHaveLength(20);
      expect(storedSessions(tracker)).toHaveLength(20);
    } finally {
      if (selection !== null) {
        selection.resetRepositorySelection();
        selection.selectLegacyRepository();
      }
      repository.close();
      indexedDB.deleteDatabase(databaseName);
    }
  });

  it('CONTROL: a whole-list publish loses the first writer, which is why the write is keyed', async () => {
    // The positive control for the case above, in the simplest possible form. Computed here,
    // not asserted about the module, so the contrast is explicit.
    const first = { sessionId: 'synthetic-qa18-race-a' };
    const second = { sessionId: 'synthetic-qa18-race-b' };
    const emptyRead: Array<{ sessionId: string }> = [];
    const writeByFirst = [...emptyRead, first];
    const writeBySecond = [...emptyRead, second];
    expect(writeByFirst.map((entry) => entry.sessionId)).toEqual(['synthetic-qa18-race-a']);
    expect(writeBySecond.map((entry) => entry.sessionId)).toEqual(['synthetic-qa18-race-b']);
    // The state the store holds after both writes is the second list, and it does not contain
    // the first writer's record.
    expect(writeBySecond.map((entry) => entry.sessionId)).not.toContain('synthetic-qa18-race-a');

    // The real keyed merge, given the same two records in the same order, keeps both.
    const { mergeSessionRecord } = await import('@/services/sessionTracker');
    type Record_ = Parameters<typeof mergeSessionRecord>[1];
    let stored: Parameters<typeof mergeSessionRecord>[0] = [];
    stored = mergeSessionRecord(stored, first as unknown as Record_);
    stored = mergeSessionRecord(stored, second as unknown as Record_);
    expect(stored.map((entry) => entry.sessionId).sort()).toEqual([
      'synthetic-qa18-race-a',
      'synthetic-qa18-race-b',
    ]);
  });
});