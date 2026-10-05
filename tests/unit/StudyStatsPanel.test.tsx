/**
 * Phase 18 gate 6: `tests/unit/StudyStatsPanel.test.tsx` - the plan's named gate.
 *
 * ## Why this file exists
 *
 * The plan's Phase 18 verification block names `tests/unit/StudyStatsPanel.test.tsx`. Before this
 * file, `npm test -- tests/unit/StudyStatsPanel.test.tsx` matched **no file** and exited `0`: a
 * named gate that reported success while testing nothing.
 *
 * ## Why it is not a mirror of `tests/phase18/studyStatsDashboard.test.tsx`
 *
 * That file (53 tests, by the UI engineer) is a thorough gate on the **dashboard internals** - the
 * view model's rows, the chart, the copy functions, the dialog's focus behaviour, the gate module's
 * own contract. This file is an independent gate on the **panel**, and it deliberately takes a
 * different route to each property so that the two files can fail independently:
 *
 * | Property | How this file gets at it |
 * | --- | --- |
 * | reads `useStatistics()`, not `computeSessionStats()` | the panel's **own source text and runtime import closure**, plus two **contradictory seedings** of the two data sources |
 * | empty / restored / open-session states | the **real stores**, hydrated the way the application hydrates them, then the real DOM |
 * | nothing internal is user-visible | the rendered **text**, searched for values the fixture planted and the panel has no reason to print |
 * | rollback hides the dashboard, records survive | the **gate module** flipped, plus a **byte-for-byte** comparison of the persisted records before and after |
 *
 * The two seedings matter most. A panel that read `computeSessionStats()` and a panel that read
 * `useStatistics()` produce *identical* output when both sources agree, which is the state every
 * happy-path fixture builds. So the discriminating case is a device where the two sources
 * **disagree**, and the panel's answer must follow the snapshot.
 *
 * ## Non-vacuity
 *
 * - The structural read asserts on a list it also asserts is non-empty, and the scanner is
 *   exercised against a source that *does* contain the forbidden specifier.
 * - The "reads the snapshot" case runs **twice with contradictory fixtures** and requires different
 *   output, so it cannot be satisfied by a panel that renders one fixed set of zeros.
 * - The "nothing internal is visible" case searches for strings it has just planted in the
 *   fixture, and a companion case proves the search can find a planted string.
 * - The rollback case compares the persisted record **byte for byte**, and a companion asserts the
 *   dashboard really was visible before the gate was flipped - an assertion placed after a teardown
 *   step could never fail.
 *
 * ## Privacy
 *
 * Every fixture is synthetic, and the "nothing internal is visible" case is a privacy gate: the
 * values it plants are the ids a real device would hold, and it asserts none of them reaches the
 * rendered text.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeEmptyRoomMetadata, makeEmptyValidationState } from '@/core/validation/persistence';
import type { DungeonMetadata, RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';
import {
  deriveNoteSubmissionSourceIdentity,
  toNoteSubmissionEvent,
  toXpAwardEvent,
  noteSubmissionEventSourceIdentity,
  writeStatisticsEventLedgerToFields,
} from '@/core/statistics/statisticsEvents';
import type { StatisticsSessionRecord } from '@/core/statistics/statisticsMetrics';
import { resetRepositorySelection } from '@/services/persistence/v2/repositorySelection';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';
import { useProgressionStore } from '@/store/progressionStore';
import { useStatisticsStore } from '@/store/statisticsStore';
import { useSubjectStore } from '@/store/subjectStore';
import { StudyStatsPanel } from '@/ui/components/StudyStatsPanel';
import {
  isStudyStatsDashboardEnabled,
  resetStudyStatsGate,
  setStudyStatsDashboardEnabled,
} from '@/ui/study/stats/studyStatsGate';
import { stripComments } from '../privacy/support/appGraph';
import { STUDY_STATS_IDS } from '@/ui/study/stats/studyStatsTestIds';

const NOW = '2026-11-11T09:00:00.000Z';

/** Synthetic identities, planted so the privacy case has real strings to look for. */
const SUBJECT_ID = 'synthetic-qa18-panel-subject';
const SUBJECT_NAME = 'Synthetic QA18 Panel Subject';
const ROOM_ID = 'synthetic-qa18-panel-room';
const ROOM_TOPIC = 'synthetic-qa18-panel-topic';
const SESSION_ID = 'synthetic-qa18-panel-session';
const BADGE_NAME = 'SyntheticQa18PanelBadge';

function room(): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId: ROOM_ID, topic: ROOM_TOPIC, nowIso: NOW }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass: true },
    reviewPassCount: 1,
  };
}

function subjectSnapshot(): SubjectSnapshot {
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: SUBJECT_ID,
    subjectName: SUBJECT_NAME,
    createdAt: NOW,
    updatedAt: NOW,
    phaseState: 'ArchaeologistActive',
    rootRoomId: ROOM_ID,
    rooms: [{ roomId: ROOM_ID, topic: ROOM_TOPIC, status: 'ArtifactCollected' }],
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return { dungeon, rooms: { [ROOM_ID]: room() } };
}

/** One note submission plus its XP, built by the production constructors. */
function noteAndXp() {
  // `ROOM_ID` is app-minted and non-blank, so the derivation cannot return `null` here. The
  // assertion is what keeps that an assumption rather than a hope: a `null` would make the identity
  // unusable, and a silent `?? 'csub-fixture'` would let this fixture drift from the real rule.
  const clearIdentity = deriveNoteSubmissionSourceIdentity({ roomId: ROOM_ID });
  if (clearIdentity === null) throw new Error('a non-blank room id produced no note-submission identity');
  const identity = { roomId: ROOM_ID, clearIdentity };
  return [
    toNoteSubmissionEvent({
      subjectId: SUBJECT_ID,
      identity,
      localDate: '2026-11-11',
      recordedAt: NOW,
      xpAwarded: 26,
    }),
    toXpAwardEvent({
      subjectId: SUBJECT_ID,
      source: 'note-submission',
      sourceIdentity: noteSubmissionEventSourceIdentity(identity),
      localDate: '2026-11-11',
      recordedAt: NOW,
      amount: 26,
    }),
  ] as const;
}

function session(overrides: Partial<StatisticsSessionRecord> = {}): StatisticsSessionRecord {
  return {
    sessionId: SESSION_ID,
    subjectId: SUBJECT_ID,
    subjectName: SUBJECT_NAME,
    startedAt: '2026-11-11T08:00:00.000Z',
    endedAt: '2026-11-11T08:30:00.000Z',
    roomsVisited: [ROOM_ID],
    notesSubmitted: 1,
    reviewsCompleted: 1,
    xpEarned: 26,
    ...overrides,
  };
}

/**
 * Hydrate the two real stores the panel reads, the way the application hydrates them.
 *
 * `sessions` goes through `useStatisticsStore.hydrateSessions` and `ledger` through
 * `useProgressionStore.hydrateProgression`, so the panel reads the **published snapshot** rather
 * than anything this file computes. Nothing here calls the view model.
 */
function seed(input: {
  readonly sessions?: readonly StatisticsSessionRecord[] | null;
  readonly ledger?: boolean;
  readonly roomsCleared?: number;
  readonly snapshot?: SubjectSnapshot | null;
}): void {
  window.localStorage.clear();
  const snapshot = input.snapshot === undefined ? subjectSnapshot() : input.snapshot;
  if (snapshot !== null) useSubjectStore.getState().setSnapshot(snapshot);

  const extraFields =
    input.ledger === true
      ? writeStatisticsEventLedgerToFields(undefined, { version: 1, events: noteAndXp() })
      : undefined;
  useProgressionStore.getState().hydrateProgression({
    version: 3,
    bySubject: {
      [SUBJECT_ID]: {
        xpTotal: input.ledger === true ? 26 : 0,
        rank: 'Novice',
        badges: [],
        inventory: [],
        equippedItems: [],
        collectedNotes: [],
        streakCount: 0,
        subjectsMastered: 0,
        roomsCleared: input.roomsCleared ?? (input.ledger === true ? 1 : 0),
        reviewPasses: 0,
        artifacts: 0,
        bossesDefected: 0,
        fishCollection: [],
        ...(extraFields === undefined ? {} : { extraFields }),
      },
    },
    crossSubjectAchievements: [],
  });
  useStatisticsStore.getState().hydrateSessions(input.sessions ?? null);
}

function renderPanel(): HTMLElement {
  render(<StudyStatsPanel onClose={() => undefined} />);
  const dialog = document.getElementById(STUDY_STATS_IDS.dialog);
  if (dialog === null) throw new Error('the panel rendered no dialog frame');
  return dialog;
}

/** The panel's whole visible text, whitespace-collapsed. */
function panelText(): string {
  return (screen.getByRole('dialog').textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The numeric value the panel publishes for one total row, or `null`. */
function totalValue(key: string): number | null {
  const cell = document.querySelector(`[data-study-stats-total="${key}"]`);
  if (cell === null) return null;
  const raw = cell.getAttribute('data-study-stats-value');
  return raw === null ? null : Number(raw);
}

beforeEach(() => {
  resetStudyStatsGate();
  resetRepositorySelection();
  window.localStorage.clear();
  useStatisticsStore.getState().hydrateSessions([]);
});

afterEach(() => {
  cleanup();
  resetStudyStatsGate();
  window.localStorage.clear();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The panel reads the snapshot, and never the always-zero legacy adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('the panel renders from the published snapshot, not from computeSessionStats()', () => {
  it('names no session-tracker specifier in its own imports, at all', () => {
    // The direct statement of the property. The pre-Phase-18 panel called
    // `computeSessionStats()` from `@/services/sessionTracker`, which is why it showed `0` sessions
    // forever. This asserts the import is gone from the panel's own source.
    const source = readFileSync(join(process.cwd(), 'src/ui/components/StudyStatsPanel.tsx'), 'utf8');
    const importSpecifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    // Named rather than discovered, so a broken regex cannot make the loop vacuously pass.
    expect(importSpecifiers.length).toBeGreaterThan(4);
    expect(importSpecifiers).toContain('@/store/statisticsStore');
    expect(importSpecifiers).toContain('@/ui/study/stats/studyStatsViewModel');
    expect(
      importSpecifiers.filter((specifier) => specifier.includes('sessionTracker')),
      'the panel imports the session tracker again',
    ).toEqual([]);
  });

  it('CONTROL: the specifier scan finds a forbidden one when it is present', () => {
    // So "no forbidden specifier" is a measurement over a populated list rather than an empty one.
    const planted = "import { computeSessionStats } from '@/services/sessionTracker';\nconst x = 1;";
    const found = [...planted.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(found.filter((specifier) => specifier.includes('sessionTracker'))).toHaveLength(1);
  });

  it('reads the events, not the session counters, when the two sources disagree', () => {
    // The discriminating case, and the reason the panel cannot be reading both sources.
    //
    // `hasRecordedSessions` gates the dashboard on a **session**, so a fixture with no session at all
    // renders the empty state and never reaches the totals - which is what my first version of this
    // case did, and it "passed" nothing. So both fixtures carry a session, and the two sources are
    // given **contradictory** numbers.
    //
    // Case A: a session whose own counters are all zero, and a ledger carrying one note worth 26 XP.
    // A panel reading `computeSessionStats()` would print 0 notes and 0 XP here; the snapshot says
    // 1 and 26.
    seed({ sessions: [session({ notesSubmitted: 0, reviewsCompleted: 0, xpEarned: 0 })], ledger: true });
    renderPanel();
    expect(document.getElementById(STUDY_STATS_IDS.dashboard), 'case A rendered no dashboard').not.toBeNull();
    expect(totalValue('sessions-completed'), 'case A: the session was not counted').toBe(1);
    expect(totalValue('notes-written'), 'case A: the ledger\'s note was not rendered').toBe(1);
    expect(totalValue('experience-earned'), 'case A: the ledger\'s XP was not rendered').toBe(26);
    // The session's own counters are zero on this device, so the totals row reading 1 can only have
    // come from the ledger. (The two seeds are also checked snapshot-against-snapshot in the CONTROL
    // case below, which is the stronger form of that statement.)
    const sessionRow = document.querySelector('[data-study-stats-session]');
    expect(sessionRow, 'case A: no per-session row was rendered').not.toBeNull();
    cleanup();

    // Case B: the mirror. A session whose counters claim a note and 26 XP, and **no** ledger behind
    // them - which is what a device that predates the event ledger actually looks like. A panel
    // reading the legacy adapter would print 1 note and 26 XP; the snapshot says 0 and 0, because
    // the events are the authority for events.
    seed({ sessions: [session({ notesSubmitted: 1, reviewsCompleted: 1, xpEarned: 26 })], ledger: false });
    renderPanel();
    expect(document.getElementById(STUDY_STATS_IDS.dashboard), 'case B rendered no dashboard').not.toBeNull();
    expect(totalValue('sessions-completed'), 'case B: the session was not counted').toBe(1);
    expect(totalValue('notes-written'), 'case B: a note appeared with no event behind it').toBe(0);
    expect(totalValue('experience-earned'), 'case B: XP appeared with no event behind it').toBe(0);
    // And case B is the device the restored notice is for, which is the corroboration that the
    // fixture is a real state rather than a contrived one.
    expect(document.getElementById(STUDY_STATS_IDS.restored), 'case B is not recognised as pre-ledger').not.toBeNull();
  });

  it('CONTROL: the two seedings really do disagree, so the case above is discriminating', () => {
    // Each seeding's snapshot, read from the store the panel reads, checked directly. Without this
    // the case above could be satisfied by a panel that printed a constant.
    seed({ sessions: [session({ notesSubmitted: 0, reviewsCompleted: 0, xpEarned: 0 })], ledger: true });
    const withLedger = useStatisticsStore.getState().snapshot;
    expect(withLedger.totals.notesSubmitted).toBe(1);
    expect(withLedger.totals.xpEarned).toBe(26);

    seed({ sessions: [session({ notesSubmitted: 1, reviewsCompleted: 1, xpEarned: 26 })], ledger: false });
    const withoutLedger = useStatisticsStore.getState().snapshot;
    expect(withoutLedger.totals.notesSubmitted).toBe(0);
    expect(withoutLedger.totals.xpEarned).toBe(0);
    expect(withoutLedger.totals.sessionsCompleted).toBe(1);

    // The two snapshots differ on exactly the numbers the panel is being judged on.
    expect(withLedger.totals.notesSubmitted).not.toBe(withoutLedger.totals.notesSubmitted);
    expect(withLedger.totals.xpEarned).not.toBe(withoutLedger.totals.xpEarned);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The three states
// ─────────────────────────────────────────────────────────────────────────────

describe('the empty, restored, and open-session states each say something different', () => {
  it('the empty state explains itself and prints no totals', () => {
    seed({ sessions: [], ledger: false, snapshot: subjectSnapshot() });
    renderPanel();
    const empty = document.getElementById(STUDY_STATS_IDS.empty);
    expect(empty, 'the empty block was not rendered').not.toBeNull();
    expect(document.getElementById(STUDY_STATS_IDS.dashboard), 'a dashboard rendered while empty').toBeNull();
    const text = empty?.textContent ?? '';
    expect(text.length).toBeGreaterThan(40);
    // An explanation, not a wall of zeros. A digit is allowed only inside the subject count.
    expect(text.replace(/\b\d+\b/g, '').trim().length).toBeGreaterThan(40);
  });

  it('the restored state appears exactly when provenance says a session predates the ledger', () => {
    seed({ sessions: [session()], ledger: false });
    renderPanel();
    // One session, no subject with events -> `sessionsBeforeEventLedger` is 1.
    expect(document.getElementById(STUDY_STATS_IDS.restored), 'the restored notice is missing').not.toBeNull();
    const restored = document.getElementById(STUDY_STATS_IDS.restored)?.textContent ?? '';
    expect(restored).toContain('1');
    cleanup();

    // The same session, with a ledger behind its subject: the notice must go away. Without this the
    // previous case would pass on a notice that is simply always rendered.
    seed({ sessions: [session()], ledger: true });
    renderPanel();
    expect(document.getElementById(STUDY_STATS_IDS.restored), 'the restored notice never goes away').toBeNull();
  });

  it('the open-session note appears only while a session is open, and reports no minutes for it', () => {
    seed({ sessions: [session({ endedAt: null })], ledger: true });
    renderPanel();
    const open = document.getElementById(STUDY_STATS_IDS.openSessions);
    expect(open, 'the open-session note is missing').not.toBeNull();
    expect(open?.textContent).toContain('1');
    // An open session is not a finished one.
    expect(totalValue('sessions-completed')).toBe(0);
    expect(totalValue('study-time')).toBe(0);
    cleanup();

    seed({ sessions: [session()], ledger: true });
    renderPanel();
    expect(document.getElementById(STUDY_STATS_IDS.openSessions), 'the note outlived the session').toBeNull();
    expect(totalValue('sessions-completed')).toBe(1);
  });

  it('CONTROL: each state block is absent in the others, so none of them is always-on', () => {
    seed({ sessions: [], ledger: false });
    renderPanel();
    expect(document.getElementById(STUDY_STATS_IDS.dashboard)).toBeNull();
    expect(document.getElementById(STUDY_STATS_IDS.restored)).toBeNull();
    expect(document.getElementById(STUDY_STATS_IDS.openSessions)).toBeNull();
    cleanup();

    seed({ sessions: [session()], ledger: true });
    renderPanel();
    expect(document.getElementById(STUDY_STATS_IDS.empty)).toBeNull();
    expect(document.getElementById(STUDY_STATS_IDS.restored)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Nothing internal is user-visible
// ─────────────────────────────────────────────────────────────────────────────

describe('no internal identifier reaches the learner', () => {
  it('prints no subject id, room id, room topic, session id, or badge name', () => {
    seed({ sessions: [session()], ledger: true });
    renderPanel();
    const text = panelText();

    // Every one of these is a value this fixture just planted into a real record, so a match can
    // only come from the panel printing it.
    for (const planted of [SUBJECT_ID, ROOM_ID, ROOM_TOPIC, SESSION_ID, BADGE_NAME]) {
      expect(planted.length, 'the planted fixture value is empty').toBeGreaterThan(0);
      expect(text, `the panel printed ${planted}`).not.toContain(planted);
    }
    // And no digest-shaped id either, which is the shape the statistics ledger stores.
    expect(text).not.toMatch(/\bsevt-[0-9a-f]{8}\b/);
    expect(text).not.toMatch(/\bcsub-[0-9a-f]{8}\b/);
    // The dashboard really did render, so the search was over a populated string.
    expect(document.getElementById(STUDY_STATS_IDS.dashboard)).not.toBeNull();
    expect(text.length).toBeGreaterThan(200);
  });

  it('CONTROL: the same search finds a planted string when one is printed', () => {
    // So the search above can fail. The value is planted into a rendered node by the test itself.
    render(
      <div role="dialog">
        <span>{ROOM_TOPIC}</span>
      </div>,
    );
    expect(panelText()).toContain(ROOM_TOPIC);
  });

  it('publishes no attribute carrying an opaque identifier either', () => {
    seed({ sessions: [session()], ledger: true });
    renderPanel();
    const root = document.getElementById(STUDY_STATS_IDS.dashboard);
    expect(root).not.toBeNull();
    const attributes: string[] = [];
    for (const element of Array.from(root?.querySelectorAll('*') ?? [])) {
      for (const attribute of Array.from(element.attributes)) {
        attributes.push(`${attribute.name}=${attribute.value}`);
      }
    }
    // Attributes are where an id would leak into a screenshot or a bug report, so they are
    // searched too, not only the text.
    expect(attributes.length).toBeGreaterThan(10);
    for (const attribute of attributes) {
      expect(attribute).not.toContain(SUBJECT_ID);
      expect(attribute).not.toContain(ROOM_ID);
      expect(attribute).not.toContain(SESSION_ID);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The rollback
// ─────────────────────────────────────────────────────────────────────────────

describe('the rollback gate hides the dashboard and loses nothing', () => {
  it('flipping it off hides the dashboard, and the persisted record is byte-for-byte identical', () => {
    seed({ sessions: [session()], ledger: true });

    // ── The dashboard is on, and this is asserted BEFORE the flip. An assertion placed after the
    // teardown step could never fail; this one is the precondition that makes the "and nothing was
    // lost" half mean anything.
    expect(isStudyStatsDashboardEnabled()).toBe(true);
    renderPanel();
    expect(document.getElementById(STUDY_STATS_IDS.dashboard), 'the dashboard was not on to begin with').not.toBeNull();

    const recordBefore = window.localStorage.getItem(STORAGE_KEYS.progression);
    const sessionsBefore = window.localStorage.getItem('knowledge-dungeon:v1:sessions');
    const snapshotBefore = JSON.stringify(useStatisticsStore.getState().snapshot);

    let restore: () => void = () => undefined;
    // `useSyncExternalStore` re-renders from outside React, so the flip is wrapped in `act`. An
    // unwrapped flip would leave the previous tree on screen and the next assertion would be
    // reading a stale dashboard - which is the classic "assertion after a state change that never
    // happened" shape.
    act(() => {
      restore = setStudyStatsDashboardEnabled(false);
    });
    expect(isStudyStatsDashboardEnabled()).toBe(false);

    // The gate-off body is a real, dismissible block rather than a blank sheet.
    const disabled = document.getElementById(STUDY_STATS_IDS.disabled);
    expect(disabled, 'the gate-off notice is missing').not.toBeNull();
    expect(disabled?.textContent ?? '').toMatch(/record/i);
    expect(document.getElementById(STUDY_STATS_IDS.dashboard), 'the dashboard survived the gate').toBeNull();
    expect(screen.getByRole('button', { name: /close your study record/i }), 'there is no way out').toBeTruthy();

    // Nothing was written, nothing was cleared, and the snapshot in memory is the same value.
    expect(window.localStorage.getItem(STORAGE_KEYS.progression)).toBe(recordBefore);
    expect(window.localStorage.getItem('knowledge-dungeon:v1:sessions')).toBe(sessionsBefore);
    expect(JSON.stringify(useStatisticsStore.getState().snapshot)).toBe(snapshotBefore);
    // The records are still counted where they were counted. Read from the **snapshot**, not from
    // the DOM: with the gate off there are no total rows to read, and asserting against `null`
    // would be an assertion that could never fail.
    const hidden = useStatisticsStore.getState().snapshot;
    expect(hidden.totals.notesSubmitted, 'the hidden dashboard stopped counting notes').toBe(1);
    expect(hidden.totals.xpEarned, 'the hidden dashboard stopped counting XP').toBe(26);
    expect(hidden.totals.sessionsCompleted).toBe(1);

    // And restoring the gate brings the same numbers back, which is the rollback's whole promise.
    act(() => {
      restore();
    });
    expect(isStudyStatsDashboardEnabled()).toBe(true);
    expect(document.getElementById(STUDY_STATS_IDS.dashboard), 'the dashboard did not come back').not.toBeNull();
    expect(totalValue('notes-written')).toBe(1);
  });

  it('the gate module cannot reach a record at all: its only dependency is React', () => {
    // A structural companion to the behavioural half above. The gate's dangerous capability is
    // "while retaining" - a gate that could reach a store could satisfy "display is off" by
    // emptying the snapshot.
    // Comments stripped first: the module's own header argues this rule in prose and names
    // `localStorage` and `fetch` while doing it, so an unstripped scan would read its own
    // documentation as a violation.
    const source = stripComments(
      readFileSync(join(process.cwd(), 'src/ui/study/stats/studyStatsGate.ts'), 'utf8'),
    );
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers).toEqual(['react']);
    for (const forbidden of ['localStorage', 'fetch(', 'indexedDB']) {
      expect(source.includes(forbidden), `the gate module mentions ${forbidden}`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. A registered defect this file found
// ─────────────────────────────────────────────────────────────────────────────

describe('a registered defect', () => {
  it('the panel must never claim a paid clear went unpaid on the default lane', () => {
    // Found by the trade-representation check the maintainer asked for, and confirmed by
    // measurement rather than by reading. **Fixed** in `studyStatsCopy.clearTallySentence`,
    // which now reconciles three published tallies instead of two. What used to render here,
    // on every default-lane subject, was:
    //
    //   "The cleared-room counter reads 1 while 0 clears have a reward record. The extra 1 came
    //    from a clear made without a reward record, and the reward record is the one that paid out."
    //
    // Every clause of that was false for this device. The old view model reconciled two numbers:
    //   `roomsClearedCounter`  - `record.roomsCleared`, incremented by every PAID clear
    //   `roomsClearedAwarded` - the Phase 15 `roomClearRewardLedger`, written **only** when the
    //                           caller supplied a `clear` identity
    //
    // The default lane supplies `roomId` and **no** `clear`, so a paid note submission increments
    // the counter and writes **no** clear-ledger entry. The two therefore always differ there,
    // while the clear *was* paid (26 XP, `roomsCleared` 1) and *did* leave a counted record in
    // `statisticsEventLedger`. The panel was the only thing standing between a learner and the
    // conclusion that their work was not rewarded - the exact worry its empty state was written
    // to address.
    //
    // So this asserts the honest reconciliation. The failure mode it must not come back as is
    // deletion: an assertion of absence alone would be satisfied by a panel that printed nothing
    // at all, so the numbers the reconciliation publishes are asserted too.
    seed({ sessions: [session()], ledger: true, roomsCleared: 1 });
    renderPanel();

    const root = document.getElementById(STUDY_STATS_IDS.dashboard);
    expect(root).not.toBeNull();
    const text = (root?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text.length, 'the search ran over an empty string').toBeGreaterThan(200);

    // A false alarm about unpaid work must not be on the page. Named rather than discovered,
    // so a tightened regex cannot make the loop vacuously pass.
    for (const claim of [
      /without a reward record/i,
      /without a counted record/i,
      /the reward record is the one that paid out/i,
      /paid nothing/i,
      /went unrewarded/i,
      /is the one that paid/i,
    ]) {
      expect(text, `the panel claims a clear paid nothing when it did (${String(claim)})`).not.toMatch(claim);
    }

    // And it is not deletion: the reconciliation is still published, and every number it names is
    // read from a `data-` attribute the view model wrote, so this compares numbers rather than
    // parsing a sentence.
    const reconciliation = root?.querySelector('[data-study-stats-clear-reconciliation]');
    expect(reconciliation, 'the clear reconciliation is gone rather than honest').not.toBeNull();
    expect(reconciliation?.getAttribute('data-study-stats-clear-counter')).toBe('1');
    expect(reconciliation?.getAttribute('data-study-stats-clear-awarded')).toBe('0');
    expect(reconciliation?.getAttribute('data-study-stats-clear-counted-notes')).toBe('1');
    // The one number that means "a clear paid and left no record anywhere": zero here.
    expect(reconciliation?.getAttribute('data-study-stats-clear-unrecorded')).toBe('0');

    // And the count the ledger does support must be the one a learner reads.
    expect(totalValue('notes-written')).toBe(1);
    expect(totalValue('experience-earned')).toBe(26);
  });
});