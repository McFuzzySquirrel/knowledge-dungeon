/**
 * Phase 18: the redesigned statistics dashboard.
 *
 * ## What this file is
 *
 * The *presentation* gate. `tests/phase18/statisticsMetrics.test.ts` owns the claim that
 * every number is correct; this file owns the claim that the numbers a learner reads are the
 * numbers the domain published, that the states are words rather than colours, that the
 * dialog is operable from a keyboard, and that the phase's rollback hides the dashboard
 * without touching a record.
 *
 * ## Fixtures are computed, not hand-written
 *
 * Every snapshot here comes out of `computeStatisticsSnapshot` from
 * `src/core/statistics`, the single implementation of every number. A hand-written
 * `StatisticsSnapshot` literal would let this file agree with a component that had drifted
 * from the domain, because both would be wrong in the same direction. Computing the fixture
 * means the expected value and the rendered value share a producer - so the assertions below
 * are about **presentation**, which is what this phase owns, and a domain regression fails in
 * the domain's own file first.
 *
 * The room fixtures carry `sm2NextReviewDate`, because `summarizeReviewAnalytics` classifies
 * a room as overdue from that field against the real clock - the one piece of the review
 * summary that is not a pure function of its input, and therefore the one a test has to
 * construct rather than derive.
 *
 * ## Non-vacuity
 *
 * Every behavioural fix in this file has a mutation probe, recorded in the commit message and
 * reported by the phase. Three claims here are worth naming up front because they are the
 * ones that could have passed while asserting nothing:
 *
 * - **No `Number()` on a composite string.** The domain publishes no denominator for
 *   `distinctFishSpecies`, so the panel prints a count and never an "x of y". Every numeric
 *   assertion below reads a `data-study-stats-value` attribute that the view model filled
 *   from the same number the text was formatted from, and compares it to
 *   `snapshot.totals.*` - a number to a number.
 * - **No attribute asserted before it can be sourced.** `data-study-stats-value` is written
 *   from `row.rawValue` and *omitted* when that is `null`, so no test can read `""` and call
 *   it zero. The one place a `data-*` attribute can be absent is asserted absent, by name.
 * - **The gate's structural purity is read off the file, not asserted in prose.** The gate
 *   module's comment claims it imports nothing but React; this file reads the real import
 *   set and fails if a second specifier appears.
 *
 * ## Hermeticity
 *
 * No renderer, no canvas, no network, no `dist/`, no IndexedDB. The one clock dependency -
 * overdue review classification - is satisfied by a `sm2NextReviewDate` far enough in the
 * past that no plausible test run makes it due again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeStatisticsSnapshot,
  toNoteSubmissionEvent,
  toReviewCompletionEvent,
  type StatisticsEvent,
  type StatisticsSessionRecord,
  type StatisticsSnapshot,
  type SubjectStatistics,
  type SubjectStatisticsInput,
} from '@/core/statistics';
import { deriveRoomClearIdentity } from '@/core/progression/roomClearRewards';
import { deriveReviewPassIdentity } from '@/core/review/reviewPassRewards';
import {
  makeDefaultSubjectProgression,
  type CanonicalSubjectProgressionWriteShape,
} from '@/core/progression/canonicalProgression';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type DungeonMetadata,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import { useStatisticsStore } from '@/store/statisticsStore';
import { useProgressionStore } from '@/store/progressionStore';
import { StudyStatsPanel } from '@/ui/components/StudyStatsPanel';
import { VillageHud } from '@/ui/village/VillageHud';
import {
  isStudyStatsDashboardEnabled,
  resetStudyStatsGate,
  setStudyStatsDashboardEnabled,
  subscribeStudyStatsGate,
  STUDY_STATS_DASHBOARD_ENABLED_BY_DEFAULT,
} from '@/ui/study/stats/studyStatsGate';
import {
  REVIEW_URGENCY_COPY,
  clearTallySentence,
  emptyStateCopy,
  restoredStateCopy,
  STUDY_STATS_DISABLED_BODY,
  STUDY_STATS_DISABLED_HUD_NOTE,
  STUDY_STATS_DISABLED_TITLE,
  STUDY_STATS_TITLE,
} from '@/ui/study/stats/studyStatsCopy';
import { studyClearReconciliation } from '@/ui/study/stats/studyStatsViewModel';
import { STUDY_STATS_IDS, STUDY_STATS_SECTIONS } from '@/ui/study/stats/studyStatsTestIds';
import { readSpecifiers, stripComments } from '../privacy/support/appGraph';

// ── Fixtures '────────────────────────────────────────────────────────────────

const SUBJECT = 'synthetic-dashboard-subject';
const SUBJECT_B = 'synthetic-dashboard-subject-b';
const SUBJECT_NAME = 'Photosynthesis';
const SUBJECT_B_NAME = 'Cell Division';
const ROOM_A = 'synthetic-dashboard-room-a';
const ROOM_B = 'synthetic-dashboard-room-b';
const ROOM_C = 'synthetic-dashboard-room-c';
/** Local noon on a mid-year day, built through UTC so the fixture is zone-independent. */
const DAY = '2026-06-05';
const NOW_ISO = '2026-06-05T15:00:00.000Z';

function noonOn(day: string, offsetMinutes = 0): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date, 12) + offsetMinutes * 60_000).toISOString();
}

/** A day safely in the past, so `summarizeReviewAnalytics` always calls it overdue. */
const LONG_OVERDUE = '2020-01-01T00:00:00.000Z';

function room(
  roomId: string,
  options: {
    readonly finalPass?: boolean;
    readonly reviewPassCount?: number;
    readonly nextReviewDate?: string;
    readonly easeFactor?: number;
  } = {},
): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId, topic: `synthetic-topic-${roomId}`, nowIso: NOW_ISO }),
    state: 'ArtifactCollected',
    validationState: { ...makeEmptyValidationState(), finalPass: options.finalPass ?? true },
    reviewPassCount: options.reviewPassCount ?? 0,
    ...(options.nextReviewDate === undefined ? {} : { sm2NextReviewDate: options.nextReviewDate }),
    ...(options.easeFactor === undefined ? {} : { sm2EaseFactor: options.easeFactor }),
  };
}

function snapshotOf(subjectId: string, subjectName: string, rooms: Record<string, RoomMetadata>): SubjectSnapshot {
  const roomIds = Object.keys(rooms);
  const dungeon: DungeonMetadata = {
    schemaVersion: '1.1.0',
    dungeonId: subjectId,
    subjectName,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    phaseState: 'ArchaeologistActive',
    rootRoomId: roomIds[0] as string,
    rooms: roomIds.map((roomId) => ({
      roomId,
      topic: `synthetic-topic-${roomId}`,
      status: 'ArtifactCollected',
    })),
    edges: [],
    progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
  };
  return { dungeon, rooms };
}

/**
 * One note-submission event, with its identity derived the way the reward site derives it.
 *
 * `deriveRoomClearIdentity` and `deriveReviewPassIdentity` are used rather than hand-written
 * digest strings, so the fixture's `eventId` is a real deterministic identity - which is what
 * makes "the panel counts each event once" a claim about the real pipeline.
 */
/**
 * A one-room dungeon, for the fixtures that only need a room identity to derive.
 *
 * Named rather than inlined at each call site so a reader can see the room list that the
 * identity digest depends on - `deriveRoomClearIdentity` hashes the room's position among its
 * neighbours, so a fixture whose digest was derived against a *different* room list would
 * silently produce a different event id than the reward site would.
 */
function noteEventsDungeon(): DungeonMetadata {
  return snapshotOf(SUBJECT, SUBJECT_NAME, { [ROOM_A]: room(ROOM_A) }).dungeon;
}

function noteEvents(dungeon: DungeonMetadata, entries: readonly [string, number][]): StatisticsEvent[] {
  return entries.map(([roomId, xpAwarded]) =>
    toNoteSubmissionEvent({
      subjectId: SUBJECT,
      identity: { roomId, clearIdentity: deriveRoomClearIdentity({ roomId, dungeon }) },
      localDate: DAY,
      recordedAt: noonOn(DAY),
      xpAwarded,
    }),
  );
}

function reviewEvents(
  entries: readonly [string, number, number][],
): StatisticsEvent[] {
  return entries.map(([roomId, passNumber, xpAwarded]) =>
    toReviewCompletionEvent({
      subjectId: SUBJECT,
      identity: {
        roomId,
        passNumber,
        reviewIdentity: deriveReviewPassIdentity({ roomId, passNumber }),
      },
      localDate: DAY,
      recordedAt: noonOn(DAY, 5),
      xpAwarded,
    }),
  );
}

function session(overrides: Partial<StatisticsSessionRecord> = {}): StatisticsSessionRecord {
  return {
    sessionId: 'synthetic-dashboard-session',
    subjectId: SUBJECT,
    subjectName: SUBJECT_NAME,
    startedAt: noonOn(DAY),
    endedAt: noonOn(DAY, 45),
    roomsVisited: [ROOM_A, ROOM_B],
    notesSubmitted: 1,
    reviewsCompleted: 1,
    xpEarned: 10,
    ...overrides,
  };
}

function subjectInput(overrides: Partial<SubjectStatisticsInput> = {}): SubjectStatisticsInput {
  return {
    subjectId: SUBJECT,
    subjectName: SUBJECT_NAME,
    snapshot: null,
    progression: null,
    events: [],
    ...overrides,
  };
}

interface RecordedFixture {
  readonly snapshot: StatisticsSnapshot;
}

/**
 * A device with two closed sessions, two notes, two reviews, one subject with a map and one
 * without.
 *
 * The base fixture schedules **no** reviews, so its review state is `clear` - which is the
 * state a learner is in who has finished a pass and has nothing waiting. That is what makes
 * the state-change assertions comparable: the only difference between the base fixture and
 * the `overdueRoom` one is one room's `sm2NextReviewDate`, so a change in the rendered word
 * can only have come from that.
 *
 * @param overdueRoom Whether `ROOM_C` is scheduled far in the past, which is what moves the
 *   subject's review state from `clear` to `overdue`.
 */
function recordedFixture(options: { readonly overdueRoom?: boolean } = {}): RecordedFixture {
  const rooms = {
    [ROOM_A]: room(ROOM_A, { reviewPassCount: 2, easeFactor: 2.6 }),
    [ROOM_B]: room(ROOM_B, { reviewPassCount: 1, easeFactor: 2.4 }),
    [ROOM_C]: room(ROOM_C, {
      reviewPassCount: 0,
      ...(options.overdueRoom === true ? { nextReviewDate: LONG_OVERDUE } : {}),
    }),
  };
  const subjectSnapshot = snapshotOf(SUBJECT, SUBJECT_NAME, rooms);
  const progression: CanonicalSubjectProgressionWriteShape = {
    ...makeDefaultSubjectProgression(),
    xpTotal: 120,
    rank: 'Scholar',
    roomsCleared: 2,
    streakCount: 2,
  };

  const snapshot = computeStatisticsSnapshot({
    sessions: [
      session({ sessionId: 'synthetic-dashboard-session-1' }),
      session({
        sessionId: 'synthetic-dashboard-session-2',
        startedAt: noonOn('2026-06-04'),
        endedAt: noonOn('2026-06-04', 20),
      }),
    ],
    subjects: [
      subjectInput({
        snapshot: subjectSnapshot,
        progression,
        events: [
          ...noteEvents(subjectSnapshot.dungeon, [
            [ROOM_A, 10],
            [ROOM_B, 15],
          ]),
          ...reviewEvents([
            [ROOM_A, 1, 5],
            [ROOM_B, 1, 5],
          ]),
        ],
      }),
      // A subject the device holds records for but has no map for: the asymmetry the
      // domain's type declares, and the one that makes `reviewScopeLimited` true.
      subjectInput({ subjectId: SUBJECT_B, subjectName: SUBJECT_B_NAME }),
    ],
    now: noonOn(DAY, 180),
  });
  return { snapshot };
}

/** A device with nothing recorded at all. */
function emptyFixture(options: { readonly withDungeons?: boolean } = {}): RecordedFixture {
  const snapshot = computeStatisticsSnapshot({
    sessions: [],
    subjects:
      options.withDungeons === true
        ? [subjectInput({ snapshot: snapshotOf(SUBJECT, SUBJECT_NAME, { [ROOM_A]: room(ROOM_A, { finalPass: false }) }) })]
        : [],
    now: noonOn(DAY, 180),
  });
  return { snapshot };
}

/**
 * Publishes a computed snapshot.
 *
 * Deliberately sets **only** the snapshot: `setDailyActivityDays` in the window test moves the
 * store's window to 7 and the test then installs a seven-day snapshot, so an `install` that
 * also reset the window would silently undo the very thing under test. The window is reset in
 * `beforeEach` instead, where a per-test reset belongs.
 */
function install(snapshot: StatisticsSnapshot): void {
  useStatisticsStore.setState({ snapshot });
}

// ── Lifecycle '───────────────────────────────────────────────────────────────

beforeEach(() => {
  window.localStorage.clear();
  resetStudyStatsGate();
  useStatisticsStore.setState({ dailyActivityDays: 14, recentSessionLimit: 10 });
  useProgressionStore.setState({
    bySubject: {},
    crossSubjectAchievements: [],
    collectedNotes: [],
  });
});

afterEach(() => {
  cleanup();
  resetStudyStatsGate();
  vi.restoreAllMocks();
});

// ── The default build '───────────────────────────────────────────────────────

describe('the production default build renders the redesigned dashboard', () => {
  it('the gate defaults on and reads no environment, so the default build is the dashboard', () => {
    // The constant, not a mock: this is the value the shipped build uses.
    expect(STUDY_STATS_DASHBOARD_ENABLED_BY_DEFAULT).toBe(true);
    expect(isStudyStatsDashboardEnabled()).toBe(true);

    // And the gate reaches no configuration module at all. A gate that read a flag would
    // have to name one, so this is the structural half of "there is no new feature flag".
    const source = stripComments(
      readFileSync(join(process.cwd(), 'src', 'ui', 'study', 'stats', 'studyStatsGate.ts'), 'utf8'),
    );
    expect(readSpecifiers(source)).toEqual(['react']);
    for (const forbidden of ['@/', 'import.meta', 'process.env', 'localStorage', 'sessionStorage', 'indexedDB']) {
      expect(source, `the gate names ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('renders all five sections, in the plan\'s order', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const sections = [...document.querySelectorAll('[data-study-stats-section]')].map((node) =>
      node.getAttribute('data-study-stats-section'),
    );
    expect(sections).toEqual([
      STUDY_STATS_SECTIONS.totals,
      STUDY_STATS_SECTIONS.activity,
      STUDY_STATS_SECTIONS.retention,
      STUDY_STATS_SECTIONS.subjects,
      STUDY_STATS_SECTIONS.sessions,
    ]);
  });

  it('has one section per heading the plan names, and each heading is a real heading', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    for (const heading of ['Totals', 'Daily activity', 'Review and retention', 'Dungeons', 'Recent sessions']) {
      expect(screen.getByRole('heading', { name: heading, level: 3 })).toBeInTheDocument();
    }
  });

  it('renders no statistics without a network request in its module graph', () => {
    // The panel's whole closure, read off disk. `fetch`, `XMLHttpRequest` and `sendBeacon`
    // would appear as a call in one of these files; none does.
    const panel = readFileSync(join(process.cwd(), 'src', 'ui', 'components', 'StudyStatsPanel.tsx'), 'utf8');
    const dashboard = readFileSync(join(process.cwd(), 'src', 'ui', 'study', 'stats', 'StudyStatsDashboard.tsx'), 'utf8');
    const viewModel = readFileSync(join(process.cwd(), 'src', 'ui', 'study', 'stats', 'studyStatsViewModel.ts'), 'utf8');
    const copy = readFileSync(join(process.cwd(), 'src', 'ui', 'study', 'stats', 'studyStatsCopy.ts'), 'utf8');
    for (const source of [stripComments(panel), stripComments(dashboard), stripComments(viewModel), stripComments(copy)]) {
      expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|EventSource|navigator\.sendBeacon|WebSocket/);
      expect(source).not.toMatch(/https?:\/\//);
    }
  });
});

// ── Totals: the domain's numbers, read as numbers '────────────────────────────

describe('totals', () => {
  it('prints every published total, with the domain\'s number beside the formatted text', () => {
    const { snapshot } = recordedFixture();
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const totals = document.getElementById(STUDY_STATS_IDS.totals) as HTMLElement;
    expect(totals).not.toBeNull();

    // Number to number. The attribute and the domain field are both numbers, so this
    // comparison can fail; a comparison against the formatted string could not.
    const readTotal = (key: string): number =>
      Number(totals.querySelector(`[data-study-stats-total="${key}"]`)?.getAttribute('data-study-stats-value'));

    expect(readTotal('sessions-completed')).toBe(snapshot.totals.sessionsCompleted);
    expect(readTotal('study-time')).toBe(snapshot.totals.studyTimeMinutes);
    expect(readTotal('longest-session')).toBe(snapshot.totals.longestSessionMinutes);
    expect(readTotal('average-session')).toBe(snapshot.totals.averageSessionMinutes);
    expect(readTotal('active-days')).toBe(snapshot.totals.activeDays);
    expect(readTotal('rooms-explored')).toBe(snapshot.totals.uniqueRoomsVisited);
    expect(readTotal('room-visits')).toBe(snapshot.totals.roomVisits);
    expect(readTotal('notes-written')).toBe(snapshot.totals.notesSubmitted);
    expect(readTotal('reviews-completed')).toBe(snapshot.totals.reviewsCompleted);
    expect(readTotal('experience-earned')).toBe(snapshot.totals.xpEarned);
    expect(readTotal('subjects-tracked')).toBe(snapshot.totals.subjectsTracked);
  });

  it('the numbers move when the records do - the assertion can fail', () => {
    install(recordedFixture().snapshot);
    const { unmount } = render(<StudyStatsPanel onClose={() => {}} />);
    const before = Number(
      document
        .querySelector('[data-study-stats-total="notes-written"]')
        ?.getAttribute('data-study-stats-value'),
    );
    unmount();

    // Half the notes and one review gone: a strictly smaller record set.
    install(
      computeStatisticsSnapshot({
        sessions: [session()],
        subjects: [subjectInput({ events: noteEvents(noteEventsDungeon(), [[ROOM_A, 10]]) })],
        now: noonOn(DAY, 180),
      }),
    );
    render(<StudyStatsPanel onClose={() => {}} />);
    const after = Number(
      document
        .querySelector('[data-study-stats-total="notes-written"]')
        ?.getAttribute('data-study-stats-value'),
    );

    expect(before).toBe(2);
    expect(after).toBe(1);
  });

  it('prints a duration in words, and a zero-minute session as "under a minute"', () => {
    install(
      computeStatisticsSnapshot({
        sessions: [session({ startedAt: noonOn(DAY), endedAt: noonOn(DAY, 0.1) })],
        subjects: [],
        now: noonOn(DAY, 180),
      }),
    );
    render(<StudyStatsPanel onClose={() => {}} />);
    const tile = document.querySelector('[data-study-stats-total="study-time"]') as HTMLElement;
    expect(within(tile).getByText('Time in the dungeon')).toBeInTheDocument();
    // The count is genuinely zero after rounding, and "0 min" would read as "nothing
    // happened" rather than "very briefly".
    expect(tile.getAttribute('data-study-stats-value')).toBe('0');
    expect(within(tile).getByText('under a minute')).toBeInTheDocument();
  });

  it('never prints a composite ratio, because the domain publishes no denominator', () => {
    const { snapshot } = recordedFixture();
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    // `distinctFishSpecies` has no catalogue total in the snapshot, so the panel prints the
    // count on its own row rather than inventing "2 of 41".
    const tile = document.querySelector('[data-study-stats-total="species-collected"]') as HTMLElement;
    expect(within(tile).getByText('Different species')).toBeInTheDocument();
    expect(tile.textContent).not.toMatch(/\bof\b/);
    expect(tile.textContent).not.toMatch(/\//);
  });

  it('publishes no `data-study-stats-value` for a row that has no single number', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    // The subject card's rank row is text with no number behind it. Asserting the attribute
    // is *absent* is the point: an empty string would read as zero.
    const rank = document.querySelector('[data-study-stats-subject-row="rank"]') as HTMLElement;
    expect(rank).not.toBeNull();
    expect(rank.hasAttribute('data-study-stats-value')).toBe(false);
  });
});

// ── Retention, and the asymmetry the domain declares '─────────────────────────

describe('review and retention', () => {
  it('publishes five device-wide rows, none of which duplicates a total', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const retention = document.getElementById(STUDY_STATS_IDS.retention) as HTMLElement;
    const retentionKeys = [...retention.querySelectorAll('[data-study-stats-retention]')].map((node) =>
      node.getAttribute('data-study-stats-retention'),
    );
    expect(retentionKeys).toEqual([
      'review-day-streak',
      'rooms-reviewed',
      'review-passes',
      'full-review-passes',
      'subjects-mastered',
    ]);

    const totalKeys = new Set(
      [...document.querySelectorAll('[data-study-stats-total]')].map((node) =>
        node.getAttribute('data-study-stats-total'),
      ),
    );
    for (const key of retentionKeys) expect(totalKeys.has(key as string)).toBe(false);
  });

  it('says out loud that review counts are limited by the one loaded map', () => {
    const { snapshot } = recordedFixture();
    // The fixture holds two subjects and only one has a map, so the scope note must fire.
    expect(snapshot.subjects.some((subject) => subject.mastery.totalRooms === 0)).toBe(true);
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const note = document.getElementById(STUDY_STATS_IDS.reviewScope) as HTMLElement;
    expect(note.getAttribute('data-study-scope')).toBe('partial');
    expect(note).toHaveTextContent('this device holds one map');
  });

  it('marks the scope complete when every subject has a map', () => {
    const rooms = { [ROOM_A]: room(ROOM_A), [ROOM_B]: room(ROOM_B) };
    install(
      computeStatisticsSnapshot({
        sessions: [session()],
        subjects: [subjectInput({ snapshot: snapshotOf(SUBJECT, SUBJECT_NAME, rooms) })],
        now: noonOn(DAY, 180),
      }),
    );
    render(<StudyStatsPanel onClose={() => {}} />);
    const note = document.getElementById(STUDY_STATS_IDS.reviewScope) as HTMLElement;
    expect(note.getAttribute('data-study-scope')).toBe('complete');
  });

  it('reports a subject with no map as having no rooms, never as zero of zero percent', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    const card = document.querySelector('[data-study-stats-subject="1"]') as HTMLElement;
    expect(card.getAttribute('data-study-stats-subject-total-rooms')).toBe('0');
    expect(card).toHaveTextContent('no map on this device');
    expect(card).not.toHaveTextContent('0 of 0 rooms');
    expect(card).not.toHaveTextContent('0%');
  });
});

// ── No colour-only state '────────────────────────────────────────────────────

describe('review state is a word, never a colour', () => {
  it('three states, three words, and the word follows the counts', () => {
    // No overdue room: the state is `clear`.
    install(recordedFixture().snapshot);
    const first = render(<StudyStatsPanel onClose={() => {}} />);
    const clearCard = document.querySelector('[data-study-stats-subject="0"]') as HTMLElement;
    expect(clearCard.getAttribute('data-study-stats-subject-urgency')).toBe('clear');
    expect(within(clearCard).getByText(REVIEW_URGENCY_COPY.clear.label)).toBeInTheDocument();
    expect(within(clearCard).getByText(REVIEW_URGENCY_COPY.clear.glyph)).toBeInTheDocument();
    expect(clearCard.querySelector('[data-study-stats-review-state]')?.getAttribute('data-study-stats-review-state')).toBe('clear');
    first.unmount();

    // One overdue room: the state becomes `overdue`, and the *word* changes with it.
    install(recordedFixture({ overdueRoom: true }).snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    const overdueCard = document.querySelector('[data-study-stats-subject="0"]') as HTMLElement;
    expect(overdueCard.getAttribute('data-study-stats-subject-urgency')).toBe('overdue');
    expect(within(overdueCard).getByText(REVIEW_URGENCY_COPY.overdue.label)).toBeInTheDocument();
    expect(within(overdueCard).getByText(REVIEW_URGENCY_COPY.overdue.glyph)).toBeInTheDocument();
    expect(overdueCard.querySelector('[data-study-stats-review-state="clear"]')).toBeNull();
    expect(overdueCard.querySelector('[data-study-stats-review-state="due"]')).toBeNull();
  });

  it('the `due` state is its own word, distinct from both neighbours', () => {
    /*
     * `summarizeReviewAnalytics` is the one piece of the review summary that reads the wall
     * clock: `dueTodayCount` wants a room whose next review is later today and
     * `overdueReviewCount` wants one already past. Building "later today" from `new Date()`
     * would break at 23:59, so the clock is frozen at 09:00 **local** and the room is
     * scheduled for 18:00 the same local day. Only `Date` is faked - every timer stays real,
     * so React's scheduling and `queueMicrotask` are untouched.
     */
    vi.useFakeTimers({ toFake: ['Date'] });
    const morning = new Date(2026, 5, 5, 9, 0, 0, 0);
    vi.setSystemTime(morning);
    try {
      const evening = new Date(2026, 5, 5, 18, 0, 0, 0).toISOString();
      const snapshot = computeStatisticsSnapshot({
        sessions: [session()],
        subjects: [
          subjectInput({
            snapshot: snapshotOf(SUBJECT, SUBJECT_NAME, {
              [ROOM_A]: room(ROOM_A, { nextReviewDate: evening }),
            }),
          }),
        ],
        now: noonOn(DAY, 180),
      });
      const review = snapshot.subjects[0]?.review;
      // The fixture really is in the middle state, before any assertion about the panel.
      expect(review?.reviewOverdueCount).toBe(0);
      expect(review?.reviewDueCount).toBe(1);

      install(snapshot);
      render(<StudyStatsPanel onClose={() => {}} />);
      const card = document.querySelector('[data-study-stats-subject="0"]') as HTMLElement;
      expect(card.getAttribute('data-study-stats-subject-urgency')).toBe('due');
      expect(within(card).getByText(REVIEW_URGENCY_COPY.due.label)).toBeInTheDocument();
      expect(within(card).queryByText(REVIEW_URGENCY_COPY.overdue.label)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the chip\'s two numbers are readable as numbers, and they match the domain', () => {
    const { snapshot } = recordedFixture({ overdueRoom: true });
    const subject = snapshot.subjects[0];
    expect(subject?.review.reviewOverdueCount).toBeGreaterThan(0);
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const card = document.querySelector('[data-study-stats-subject="0"]') as HTMLElement;
    expect(Number(card.getAttribute('data-study-stats-review-due'))).toBe(
      subject?.review.reviewDueCount,
    );
    expect(Number(card.getAttribute('data-study-stats-review-overdue'))).toBe(
      subject?.review.reviewOverdueCount,
    );
    // The same two numbers in words, so a learner is not left reading only attributes.
    expect(card).toHaveTextContent(
      `${subject?.review.reviewDueCount} due now, ${subject?.review.reviewOverdueCount} overdue`,
    );
  });

  it('carries no inline colour anywhere in the dashboard', () => {
    install(recordedFixture({ overdueRoom: true }).snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    // The pre-Phase-18 panel set `style={{ color: 'var(--bad)' }}` on the overdue number. A
    // text sweep for a colour declaration is the direct regression test for that defect.
    const dashboard = document.getElementById(STUDY_STATS_IDS.dashboard) as HTMLElement;
    for (const node of [dashboard, ...dashboard.querySelectorAll('*')]) {
      const style = (node as HTMLElement).getAttribute('style') ?? '';
      expect(style, `${node.tagName} carries an inline style with a colour`).not.toMatch(/color|background|border/);
    }
  });

  it('names the mastery state in words, and proven mastery separately', () => {
    install(
      computeStatisticsSnapshot({
        sessions: [session()],
        subjects: [
          subjectInput({
            snapshot: snapshotOf(SUBJECT, SUBJECT_NAME, { [ROOM_A]: room(ROOM_A, { reviewPassCount: 2 }) }),
          }),
        ],
        now: noonOn(DAY, 180),
      }),
    );
    render(<StudyStatsPanel onClose={() => {}} />);
    const card = document.querySelector('[data-study-stats-subject="0"]') as HTMLElement;
    // One room, cleared and reviewed twice: a full pass, so both facts hold.
    expect(card).toHaveTextContent('Every room cleared and reviewed');
    expect(card.querySelector('[data-study-stats-proven="yes"]')).not.toBeNull();
    expect(card).toHaveTextContent('Mastered');
  });

  it('does not claim proven mastery when only the rooms are cleared', () => {
    install(
      computeStatisticsSnapshot({
        sessions: [session()],
        subjects: [
          subjectInput({
            snapshot: snapshotOf(SUBJECT, SUBJECT_NAME, { [ROOM_A]: room(ROOM_A, { reviewPassCount: 0 }) }),
          }),
        ],
        now: noonOn(DAY, 180),
      }),
    );
    render(<StudyStatsPanel onClose={() => {}} />);
    const card = document.querySelector('[data-study-stats-subject="0"]') as HTMLElement;
    expect(card).toHaveTextContent('Every room cleared');
    expect(card).not.toHaveTextContent('Every room cleared and reviewed');
    expect(card.querySelector('[data-study-stats-proven="yes"]')).toBeNull();
  });

  it('an untouched subject says so, and does not print a percentage', () => {
    install(emptyFixture({ withDungeons: false }).snapshot);
    // No sessions means the empty state, so give the subject a session to make the dashboard
    // render while the subject itself has done nothing.
    install(
      computeStatisticsSnapshot({
        sessions: [session({ subjectId: SUBJECT_B, subjectName: SUBJECT_B_NAME })],
        subjects: [
          subjectInput({
            subjectId: SUBJECT_B,
            subjectName: SUBJECT_B_NAME,
            snapshot: snapshotOf(SUBJECT_B, SUBJECT_B_NAME, {
              [ROOM_A]: room(ROOM_A, { finalPass: false }),
              [ROOM_B]: room(ROOM_B, { finalPass: false }),
            }),
          }),
        ],
        now: noonOn(DAY, 180),
      }),
    );
    render(<StudyStatsPanel onClose={() => {}} />);
    const card = document.querySelector('[data-study-stats-subject="0"]') as HTMLElement;
    expect(card).toHaveTextContent('Not started');
    expect(card.getAttribute('data-study-stats-cleared-rooms')).toBe('0');
    expect(card).toHaveTextContent('0 of 2 rooms (0%)');
  });
});

// ── Empty and restored '──────────────────────────────────────────────────────

describe('the empty state is an explanation, not zeros', () => {
  it('a learner with nothing gets the warm explanation and no totals at all', () => {
    install(emptyFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const empty = document.getElementById(STUDY_STATS_IDS.empty) as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.getAttribute('data-study-stats-empty')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Nothing to count yet' })).toBeInTheDocument();

    for (const sentence of emptyStateCopy(0)) {
      expect(empty).toHaveTextContent(sentence);
    }
    // The load-bearing half: not one zero row, and no totals list at all.
    expect(document.querySelectorAll('[data-study-stats-total]')).toHaveLength(0);
    expect(document.getElementById(STUDY_STATS_IDS.totals)).toBeNull();
    expect(document.getElementById(STUDY_STATS_IDS.dashboard)).toBeNull();
  });

  it('names the dungeons the learner already has, so the page is not a dead end', () => {
    const { snapshot } = emptyFixture({ withDungeons: true });
    expect(snapshot.totals.subjectsTracked).toBe(1);
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const empty = document.getElementById(STUDY_STATS_IDS.empty) as HTMLElement;
    expect(empty).toHaveTextContent('You already have 1 dungeon ready');
    expect(empty).toHaveTextContent('it just has not been walked yet');
  });

  it('the empty copy function itself never prints a zero', () => {
    for (const sentence of emptyStateCopy(0)) expect(sentence).not.toMatch(/\b0\b/);
    for (const sentence of emptyStateCopy(3)) expect(sentence).not.toMatch(/\b0\b/);
  });

  it('the restored-history notice appears only when provenance says so', () => {
    const { snapshot } = recordedFixture();
    expect(snapshot.provenance.sessionsBeforeEventLedger).toBe(0);
    install(snapshot);
    const first = render(<StudyStatsPanel onClose={() => {}} />);
    expect(document.getElementById(STUDY_STATS_IDS.restored)).toBeNull();
    first.unmount();

    // A session whose subject carries no event ledger: exactly the restored-archive shape.
    install(
      computeStatisticsSnapshot({
        sessions: [
          session({ sessionId: 'synthetic-legacy-session-1', subjectId: SUBJECT_B, subjectName: SUBJECT_B_NAME }),
          session({ sessionId: 'synthetic-legacy-session-2', subjectId: SUBJECT_B, subjectName: SUBJECT_B_NAME }),
          session({ sessionId: 'synthetic-ledger-session' }),
        ],
        subjects: [
          subjectInput({
            snapshot: snapshotOf(SUBJECT, SUBJECT_NAME, { [ROOM_A]: room(ROOM_A) }),
            events: noteEvents(snapshotOf(SUBJECT, SUBJECT_NAME, { [ROOM_A]: room(ROOM_A) }).dungeon, [[ROOM_A, 10]]),
          }),
          subjectInput({ subjectId: SUBJECT_B, subjectName: SUBJECT_B_NAME }),
        ],
        now: noonOn(DAY, 180),
      }),
    );
    render(<StudyStatsPanel onClose={() => {}} />);
    const restored = document.getElementById(STUDY_STATS_IDS.restored) as HTMLElement;
    expect(restored).not.toBeNull();
    for (const sentence of restoredStateCopy(2)) expect(restored).toHaveTextContent(sentence);
    expect(restored).toHaveTextContent('not added to the totals');
    // The dashboard itself still renders: restored history is not an error state.
    expect(document.getElementById(STUDY_STATS_IDS.dashboard)).not.toBeNull();
  });

  it('the open-session note appears only while a session is open', () => {
    install(recordedFixture().snapshot);
    const first = render(<StudyStatsPanel onClose={() => {}} />);
    expect(document.getElementById(STUDY_STATS_IDS.openSessions)).toBeNull();
    first.unmount();

    install(
      computeStatisticsSnapshot({
        sessions: [session({ endedAt: null })],
        subjects: [],
        now: noonOn(DAY, 180),
      }),
    );
    render(<StudyStatsPanel onClose={() => {}} />);
    const note = document.getElementById(STUDY_STATS_IDS.openSessions) as HTMLElement;
    expect(note).toHaveTextContent('Sessions still open: 1 session');
    // An open session still counts as recorded, so this is not the empty state.
    expect(document.getElementById(STUDY_STATS_IDS.empty)).toBeNull();
  });
});

// ── Activity '────────────────────────────────────────────────────────────────

describe('daily activity', () => {
  it('one entry per day in the window, each carrying the day\'s own minutes', () => {
    const { snapshot } = recordedFixture();
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const list = document.getElementById(STUDY_STATS_IDS.activity) as HTMLElement;
    expect(list.querySelectorAll('[data-study-stats-day]')).toHaveLength(snapshot.dailyActivity.length);
    expect(snapshot.dailyActivity).toHaveLength(14);

    for (const bucket of snapshot.dailyActivity) {
      const cell = list.querySelector(`[data-study-stats-day="${bucket.dateKey}"]`);
      expect(cell, `no cell for ${bucket.dateKey}`).not.toBeNull();
      expect(Number(cell?.getAttribute('data-study-stats-day-minutes'))).toBe(bucket.studyMinutes);
      expect(cell?.getAttribute('data-study-stats-day-today')).toBe(bucket.isToday ? 'yes' : 'no');
    }
  });

  it('an empty day is a zero-height bar and the words "no activity", never a stub', () => {
    const { snapshot } = recordedFixture();
    const quiet = snapshot.dailyActivity.find((bucket) => bucket.studyMinutes === 0);
    expect(quiet).toBeDefined();
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const cell = document.querySelector(
      `[data-study-stats-day="${(quiet as { dateKey: string }).dateKey}"]`,
    ) as HTMLElement;
    expect(cell.getAttribute('data-study-stats-day-active')).toBe('no');
    expect(cell).toHaveTextContent('no activity');
    const bar = cell.querySelector('.study-stats__bar') as HTMLElement;
    expect(bar.getAttribute('style')).toContain('height: 0%');
  });

  it('the bar is decorative and every number is in the text', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    const bars = [...document.querySelectorAll('.study-stats__bar-track')];
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.getAttribute('aria-hidden')).toBe('true');
    }
    const busiest = recordedFixture().snapshot.dailyActivity.reduce((max, bucket) =>
      bucket.studyMinutes > max.studyMinutes ? bucket : max,
    );
    const cell = document.querySelector(`[data-study-stats-day="${busiest.dateKey}"]`) as HTMLElement;
    expect(cell).toHaveTextContent('session');
    expect(cell).toHaveTextContent('min');
  });

  it('today is marked by the word, not by a tint', () => {
    const { snapshot } = recordedFixture();
    const today = snapshot.dailyActivity.find((bucket) => bucket.isToday);
    expect(today).toBeDefined();
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    const cell = document.querySelector(`[data-study-stats-day="${(today as { dateKey: string }).dateKey}"]`);
    expect(within(cell as HTMLElement).getByText('Today')).toBeInTheDocument();
  });

  it('the window selector is three real buttons, and the current one says so', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const group = screen.getByRole('group', { name: 'How many days of daily activity to show' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Last 7 days',
      'Last 14 days',
      'Last 30 days',
    ]);
    const pressed = buttons.filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent).toBe('Last 14 days');
  });

  it('choosing a window goes through the store action, and the chart follows it', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    expect(document.querySelectorAll('[data-study-stats-day]')).toHaveLength(14);

    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));

    /*
     * `setDailyActivityDays` is a store *action*: it rebuilds the whole snapshot from
     * `readSessionRecords()` and the live stores. In this file those hold nothing, so the
     * snapshot it produces is the empty one and the panel correctly falls back to the empty
     * state - which is itself worth asserting, because it proves the window control does not
     * hold a stale view of the world. The claim under test is then split in two: the click
     * reached the action, and a snapshot built for the new window draws the new width.
     */
    expect(useStatisticsStore.getState().dailyActivityDays).toBe(7);
    expect(document.getElementById(STUDY_STATS_IDS.empty)).not.toBeNull();

    const sevenDay = computeStatisticsSnapshot({
      sessions: [session()],
      subjects: [subjectInput()],
      now: noonOn(DAY, 180),
      dailyActivityDays: 7,
    });
    const fourteenDay = recordedFixture().snapshot;
    act(() => install(sevenDay));

    expect(document.querySelectorAll('[data-study-stats-day]')).toHaveLength(7);
    // The oldest of the seven is the eighth-from-last of the fourteen, not the first of the
    // seven - so the window really moved rather than being truncated in the view.
    expect(document.querySelectorAll('[data-study-stats-day]')[0]?.getAttribute('data-study-stats-day')).toBe(
      fourteenDay.dailyActivity[7]?.dateKey,
    );
    expect(screen.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Last 14 days' }).getAttribute('aria-pressed')).toBe('false');
  });
});

// ── Recent sessions '─────────────────────────────────────────────────────────

describe('recent sessions', () => {
  it('each row carries the session record\'s own counters, and the totals do not include them', () => {
    const { snapshot } = recordedFixture();
    const first = snapshot.recentSessions[0];
    expect(first).toBeDefined();
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const row = document.querySelector('[data-study-stats-session="0"]') as HTMLElement;
    expect(Number(row.getAttribute('data-study-stats-session-minutes'))).toBe(first?.studyMinutes ?? -1);
    expect(Number(row.getAttribute('data-study-stats-session-rooms'))).toBe(first?.roomsVisited ?? -1);
    expect(Number(row.getAttribute('data-study-stats-session-notes'))).toBe(first?.notesSubmitted ?? -1);
    expect(Number(row.getAttribute('data-study-stats-session-reviews'))).toBe(first?.reviewsCompleted ?? -1);
    expect(Number(row.getAttribute('data-study-stats-session-xp'))).toBe(first?.xpEarned ?? -1);
    expect(row).toHaveTextContent('room');
    expect(row).toHaveTextContent('XP');
  });

  it('an open session says so in words and reports no minutes', () => {
    install(
      computeStatisticsSnapshot({
        sessions: [session({ endedAt: null })],
        subjects: [],
        now: noonOn(DAY, 180),
      }),
    );
    render(<StudyStatsPanel onClose={() => {}} />);
    const row = document.querySelector('[data-study-stats-session="0"]') as HTMLElement;
    expect(row.getAttribute('data-study-stats-session-open')).toBe('yes');
    expect(row.getAttribute('data-study-stats-session-minutes')).toBe('open');
    expect(within(row).getByText('Still open')).toBeInTheDocument();
    expect(within(row).getByText('still open')).toBeInTheDocument();
  });

  it('says the empty list is empty rather than showing an empty box', () => {
    install(emptyFixture({ withDungeons: true }).snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    // The empty state owns this render, so the sessions section is absent rather than blank.
    expect(document.getElementById(STUDY_STATS_IDS.sessions)).toBeNull();
  });
});

// ── Privacy of the surface '──────────────────────────────────────────────────

describe('nothing private and useless reaches the DOM', () => {
  it('no subject id, room id, room topic, session id, or note id appears in the text', () => {
    const { snapshot } = recordedFixture();
    install(snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const text = document.body.textContent ?? '';
    for (const secret of [
      SUBJECT,
      SUBJECT_B,
      ROOM_A,
      ROOM_B,
      ROOM_C,
      'synthetic-topic',
      'synthetic-dashboard-session',
      'synthetic-note',
    ]) {
      expect(text, `the panel printed ${secret}`).not.toContain(secret);
    }
    // The learner's own names *are* useful and do appear.
    expect(text).toContain(SUBJECT_NAME);
    expect(text).toContain(SUBJECT_B_NAME);
  });

  it('subject cards are keyed by position, so no subject id is a DOM-facing identity', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    const positions = [...document.querySelectorAll('[data-study-stats-subject]')].map((node) =>
      node.getAttribute('data-study-stats-subject'),
    );
    expect(positions).toEqual(['0', '1']);
    for (const position of positions) expect(SUBJECT.includes(position as string)).toBe(false);
  });

  it('prints the privacy sentence in the footer', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    const privacy = document.getElementById(STUDY_STATS_IDS.privacy) as HTMLElement;
    expect(privacy).toHaveTextContent('stored on this device');
    expect(privacy).toHaveTextContent('no account and no leaderboard');
  });
});

// ── The room-clear reconciliation '──────────────────────────────────────────

/**
 * A device whose three room-clear tallies are set independently.
 *
 * The three are set by three different award lanes and the panel has to reconcile all three:
 *
 * | `roomsClearedCounter` | `roomClearRewardLedger` | `note-submission` events | which lane |
 * | --- | --- | --- | --- |
 * | +1 | entry | +1 | the command lane (`clear` supplied) |
 * | +1 | — | +1 | **the default lane** (`roomId` only) - what ships |
 * | +1 | — | — | the no-identity lane - a clear that leaves no record anywhere |
 *
 * So the default lane is a device where the counter and the reward ledger *always* differ, and
 * `clearTallySentence` has to be told the difference apart from a real one. `clearLedgerEntries`
 * and `noteEvents` are the two knobs; `graphCleared` is how many rooms the subject's own map
 * shows cleared, which is the only rooms-cleared figure a learner is entitled to.
 */
function clearTallyFixture(options: {
  readonly counter: number;
  readonly noteEvents: number;
  readonly clearLedgerEntries?: number;
  readonly graphCleared?: number;
}): StatisticsSnapshot {
  const rooms = {
    [ROOM_A]: room(ROOM_A, { finalPass: true }),
    [ROOM_B]: room(ROOM_B, { finalPass: options.graphCleared !== 1 }),
    [ROOM_C]: room(ROOM_C, { finalPass: options.graphCleared !== 1 }),
  };
  const clearLedgerEntries = options.clearLedgerEntries ?? 0;
  return computeStatisticsSnapshot({
    sessions: [
      session({
        sessionId: 'synthetic-clear-tally-session',
        notesSubmitted: options.noteEvents,
        reviewsCompleted: 0,
        xpEarned: 0,
      }),
    ],
    subjects: [
      subjectInput({
        snapshot: snapshotOf(SUBJECT, SUBJECT_NAME, rooms),
        progression: {
          ...makeDefaultSubjectProgression(),
          xpTotal: 26 * options.noteEvents,
          roomsCleared: options.counter,
          streakCount: options.counter,
          ...(clearLedgerEntries === 0
            ? {}
            : {
                extraFields: {
                  roomClearRewardLedger: {
                    version: 1,
                    entries: Array.from({ length: clearLedgerEntries }, (_unused, index) => ({
                      roomId: `synthetic-clear-tally-room-${index}`,
                      clearIdentity: `synthetic-clear-tally-clear-${index}`,
                      awardedAt: NOW_ISO,
                    })),
                  },
                },
              }),
        },
        events: Array.from({ length: options.noteEvents }, (_unused, index) =>
          toNoteSubmissionEvent({
            subjectId: SUBJECT,
            // A deliberately distinct identity per entry, so the counted notes really are
            // `options.noteEvents` separate events rather than one event counted `n` times.
            identity: {
              roomId: index === 0 ? ROOM_A : `synthetic-clear-tally-room-${index}`,
              clearIdentity: `synthetic-clear-tally-clear-${index}`,
            },
            localDate: DAY,
            recordedAt: noonOn(DAY, index),
            xpAwarded: 26,
          }),
        ),
      }),
    ],
    now: noonOn(DAY, 180),
  });
}

/** The reconciliation element, and the four numbers it publishes. */
function renderReconciliation(snapshot: StatisticsSnapshot): {
  readonly node: HTMLElement | null;
  readonly card: HTMLElement | null;
} {
  install(snapshot);
  render(<StudyStatsPanel onClose={() => {}} />);
  return {
    node: document.querySelector('[data-study-stats-clear-reconciliation]'),
    card: document.querySelector('[data-study-stats-subject="0"]'),
  };
}

/** The published numbers, read as numbers - never parsed back out of the sentence. */
function reconciliationNumbers(node: HTMLElement): Readonly<Record<string, number>> {
  const read = (name: string): number => {
    // `Number(null)` is `0`, so an absent attribute would read as a real zero and every
    // `awarded: 0` assertion below would be unfailable. Presence is asserted, not assumed.
    expect(
      node.hasAttribute(name),
      `the reconciliation published no ${name}, so its value could not be measured`,
    ).toBe(true);
    const raw = node.getAttribute(name) as string;
    expect(raw, `${name} is empty rather than a number`).toMatch(/^\d+$/);
    return Number(raw);
  };
  return {
    counter: read('data-study-stats-clear-counter'),
    awarded: read('data-study-stats-clear-awarded'),
    countedNotes: read('data-study-stats-clear-counted-notes'),
    unrecorded: read('data-study-stats-clear-unrecorded'),
  };
}

/** Every claim of unpaid work this panel has ever made, named rather than discovered. */
const UNPAID_CLAIMS: readonly RegExp[] = Object.freeze([
  /without a reward record/i,
  /without a counted record here/i,
  /the reward record is the one that paid out/i,
  /paid nothing/i,
  /went unrewarded/i,
  /is the one that paid\b/i,
]);

describe('the room-clear reconciliation is true on every lane', () => {
  it('the default lane - a paid note with no reward record - never says the work went unpaid', () => {
    // The shipping lane. `roomsClearedCounter` is 1, the reward ledger is empty, and the
    // difference is *fully explained* by one counted note. Pre-fix this rendered, on every
    // default-lane subject: "The cleared-room counter reads 1 while 0 clears have a reward
    // record. The extra 1 came from a clear made without a reward record, and the reward record
    // is the one that paid out." Every clause of that was false: the clear was paid.
    const { node, card } = renderReconciliation(
      clearTallyFixture({ counter: 1, noteEvents: 1 }),
    );
    expect(node, 'the reconciliation is gone rather than honest').not.toBeNull();
    expect(card).not.toBeNull();

    const numbers = reconciliationNumbers(node as HTMLElement);
    // The numbers first: the difference between the counter and the ledger really is 1, so a
    // panel that silenced the case would pass the absence check below by printing nothing.
    expect(numbers).toEqual({ counter: 1, awarded: 0, countedNotes: 1, unrecorded: 0 });
    expect(numbers.counter - numbers.awarded, 'the fixture is not the default lane after all').toBe(1);

    const text = (card?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text.length, 'the search ran over an empty card').toBeGreaterThan(100);
    for (const claim of UNPAID_CLAIMS) {
      expect(text, `the default lane told the learner their work went unpaid (${String(claim)})`).not.toMatch(claim);
    }
    // And it says the true thing instead: the counted record is what the totals rest on.
    expect(text).toContain('every total on this page is worked out from that same counted record');
  });

  it('the no-identity lane still reports a clear that left no counted record at all', () => {
    // The signal the pre-Phase-18 panel had, and the one an over-correction would destroy. A
    // clear with no room named increments the counter and writes neither ledger, so it really
    // is unrecorded - and the panel must still say so.
    const { node } = renderReconciliation(clearTallyFixture({ counter: 3, noteEvents: 1 }));
    expect(node).not.toBeNull();
    const numbers = reconciliationNumbers(node as HTMLElement);
    expect(numbers).toEqual({ counter: 3, awarded: 0, countedNotes: 1, unrecorded: 2 });
    expect(node?.textContent).toContain('2 clears have no counted record here');
  });

  it('a clear the counter counts above the counted notes is named as unrecorded, not as unpaid', () => {
    // Two counted notes against a counter that read five: three clears this device counted left
    // no counted record. That is the one genuinely missing-work sentence, and it is about the
    // device's records rather than about what a learner's work earned.
    const { node } = renderReconciliation(clearTallyFixture({ counter: 5, noteEvents: 2 }));
    expect(node).not.toBeNull();
    expect(reconciliationNumbers(node as HTMLElement)).toEqual({
      counter: 5,
      awarded: 0,
      countedNotes: 2,
      unrecorded: 3,
    });
    const gapText = node?.textContent ?? '';
    expect(gapText).toContain('room-clear count reads 5');
    expect(gapText).toContain('3 clears have no counted record here');
    // "Nothing to show" is a statement about this device's records. It must not become a claim
    // that the learner's work earned nothing.
    expect(gapText).toContain('nothing to show for them');
    for (const claim of [/paid nothing/i, /went unrewarded/i, /earned nothing/i]) {
      expect(gapText).not.toMatch(claim);
    }
  });

  it('three tallies that agree render no sentence, and that is a property not an absence', () => {
    // The command lane, where the clear wrote both records.
    const { node } = renderReconciliation(
      clearTallyFixture({ counter: 2, noteEvents: 2, clearLedgerEntries: 2 }),
    );
    expect(node, 'a device whose three tallies agree was given a reconciliation line').toBeNull();

    // The same three reads straight off the snapshot, so "no sentence" is corroborated by the
    // numbers rather than resting on the DOM alone.
    const subject = clearTallyFixture({
      counter: 2,
      noteEvents: 2,
      clearLedgerEntries: 2,
    }).subjects[0];
    expect(subject?.roomsClearedCounter).toBe(2);
    expect(subject?.roomsClearedAwarded).toBe(2);
    expect(subject?.notesSubmitted).toBe(2);
    expect(studyClearReconciliation(subject as SubjectStatistics).agrees).toBe(true);
    expect(studyClearReconciliation(subject as SubjectStatistics).sentence).toBeNull();
  });

  it('a counter below the counted notes is reported as a separate tally, never as missing work', () => {
    const { node } = renderReconciliation(clearTallyFixture({ counter: 1, noteEvents: 4 }));
    expect(node).not.toBeNull();
    const numbers = reconciliationNumbers(node as HTMLElement);
    expect(numbers).toEqual({ counter: 1, awarded: 0, countedNotes: 4, unrecorded: 0 });
    const text = node?.textContent ?? '';
    expect(text).toContain('room-clear count reads 1');
    for (const claim of UNPAID_CLAIMS) {
      expect(text, `the panel invented missing work (${String(claim)})`).not.toMatch(claim);
    }
  });

  it('CONTROL: the same reconciliation fires in all four lanes, so none of the cases is always-on', () => {
    // A single scan over four renderings. Without it, each case above could be satisfied by a
    // panel that rendered one fixed answer, or by a reconciliation that never renders at all.
    const cases: ReadonlyArray<readonly [string, ReturnType<typeof clearTallyFixture>]> = [
      ['default', clearTallyFixture({ counter: 1, noteEvents: 1 })],
      ['command', clearTallyFixture({ counter: 2, noteEvents: 2, clearLedgerEntries: 2 })],
      ['no-identity', clearTallyFixture({ counter: 3, noteEvents: 1 })],
      ['counter-behind', clearTallyFixture({ counter: 1, noteEvents: 4 })],
    ];
    const sentences = cases.map(([name, snapshot]) => {
      cleanup();
      const { node } = renderReconciliation(snapshot);
      expect(node === null || (node.textContent ?? '').length > 0, `${name} rendered an empty note`).toBe(true);
      return [name, node?.textContent?.replace(/\s+/g, ' ').trim() ?? null] as const;
    });
    const rendered = sentences.filter(([, text]) => text !== null);
    // Three of the four disagreeing fixtures render a sentence; the command lane does not.
    expect(rendered).toHaveLength(3);
    // And no two renderings are the same string, so the sentence really is per-lane.
    const unique = new Set(rendered.map(([, text]) => text));
    expect(unique.size).toBe(3);
    expect(sentences.find(([name]) => name === 'command')?.[1]).toBeNull();
  });

  it('CONTROL: the unpaid-claim scan can find a claim, so its silence means something', () => {
    // The pre-fix sentence, verbatim. Rendered into the same DOM position the reconciliation
    // occupies, then run through the same scan.
    const planted = document.createElement('p');
    planted.textContent =
      'The cleared-room counter reads 1 while 0 clears have a reward record. The extra 1 came ' +
      'from a clear made without a reward record, and the reward record is the one that paid out.';
    install(clearTallyFixture({ counter: 1, noteEvents: 1 }));
    render(<StudyStatsPanel onClose={() => {}} />);
    const card = document.querySelector('[data-study-stats-subject="0"]') as HTMLElement;
    expect(card).not.toBeNull();
    const before = (card.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(UNPAID_CLAIMS.some((claim) => claim.test(before)), 'the card is already making a claim').toBe(false);

    card.appendChild(planted);
    const after = (card.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(UNPAID_CLAIMS.some((claim) => claim.test(after)), 'the scan cannot find a planted claim').toBe(true);
  });

  it('the copy function itself decides from the three numbers, and never from a string', () => {
    // The pure function, so the rule is stated in one place: `null` only when all three agree.
    expect(clearTallySentence({ counter: 0, awarded: 0, countedNotes: 0 })).toBeNull();
    expect(clearTallySentence({ counter: 2, awarded: 2, countedNotes: 2 })).toBeNull();
    // Every other combination produces a sentence, and every one of them names the counted
    // record as what the totals rest on.
    const combinations: ReadonlyArray<readonly [number, number, number]> = [
      [1, 0, 1],
      [1, 0, 0],
      [3, 0, 1],
      [1, 0, 4],
      [0, 0, 2],
      [5, 2, 5],
    ];
    for (const [counter, awarded, countedNotes] of combinations) {
      const sentence = clearTallySentence({ counter, awarded, countedNotes });
      expect(sentence, `${counter}/${awarded}/${countedNotes} produced no sentence`).not.toBeNull();
      expect(
        (sentence ?? '').includes('every total on this page is worked out from that same counted record'),
        `${counter}/${awarded}/${countedNotes} did not name the counted record`,
      ).toBe(true);
      for (const claim of UNPAID_CLAIMS) {
        expect(sentence, `${counter}/${awarded}/${countedNotes} matched ${String(claim)}`).not.toMatch(claim);
      }
    }
  });

  it('a counter inflated by an unvalidated identity is never the rooms-cleared figure a learner reads', () => {
    // The domain's `deriveNoteSubmissionSourceIdentity` accepts any string, so `''` and `'   '`
    // mint two distinct identities, each is counted and each is paid, and the device's
    // `roomsCleared` reads 7 for a subject whose own map shows one cleared room. The durable fix
    // belongs to `src/core/statistics/statisticsEvents.ts`; what is asserted here is the property
    // the DOM owes regardless: **the learner-facing count of cleared rooms is the graph-derived
    // one**, and an inflated counter is never presented as rooms cleared.
    const { card } = renderReconciliation(
      clearTallyFixture({ counter: 7, noteEvents: 7, graphCleared: 1 }),
    );
    expect(card).not.toBeNull();
    const cardText = (card?.textContent ?? '').replace(/\s+/g, ' ').trim();

    // The graph-derived count, which is the one true statement about rooms cleared.
    expect(card?.getAttribute('data-study-stats-cleared-rooms')).toBe('1');
    expect(card?.getAttribute('data-study-stats-subject-total-rooms')).toBe('3');
    expect(cardText).toContain('1 of 3 rooms (33%)');
    expect(cardText).not.toContain('7 of 3 rooms');

    // And the inflated counter is not offered as a rooms-cleared reading either. `roomsCleared 7`
    // appears nowhere on the card: the reconciliation in this branch quotes only the counted
    // notes, because there is no gap to report.
    const reconciliation = card?.querySelector('[data-study-stats-clear-reconciliation]');
    expect(reconciliation, 'this case must render a reconciliation').not.toBeNull();
    // Case-insensitively, and in both word orders. A first version of these two assertions used
    // lowercase `rooms cleared reads` while the copy capitalised it, so a mutation that printed
    // `Rooms cleared reads 7` sailed straight past - a scan that cannot fail.
    expect(reconciliation?.textContent).not.toMatch(/room-clear count reads/i);
    expect(cardText).not.toMatch(/\b7\s+rooms\s+cleared\b/i);
    expect(cardText).not.toMatch(/rooms\s+cleared\s+reads\s+7\b/i);
    expect(cardText).not.toMatch(/rooms\s+cleared[^\n]{0,20}\b7\b/i);
    for (const claim of UNPAID_CLAIMS) {
      expect(cardText, `the inflated counter produced a claim (${String(claim)})`).not.toMatch(claim);
    }
  });
});

// ── Dialog behaviour '────────────────────────────────────────────────────────

describe('the dialog', () => {
  it('is a modal dialog with the heading as its name and a description', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const dialog = screen.getByRole('dialog', { name: STUDY_STATS_TITLE });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)).not.toBeNull();
    expect(document.getElementById(describedBy as string)?.textContent).toContain('this device');
  });

  it('moves initial focus to the frame rather than to the first button', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    // Focusing Close would put the next Enter on dismissing the panel.
    expect(document.activeElement?.id).toBe(STUDY_STATS_IDS.dialog);
  });

  it('Escape closes it, and the handler is the one the host supplied', () => {
    const onClose = vi.fn();
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab from the last control wraps to the first, and Shift+Tab wraps back', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const dialog = screen.getByRole('dialog', { name: STUDY_STATS_TITLE });
    const controls = [...dialog.querySelectorAll<HTMLElement>('button')];
    expect(controls.length).toBeGreaterThan(2);
    const first = controls[0] as HTMLElement;
    const last = controls[controls.length - 1] as HTMLElement;

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the opener when it unmounts', () => {
    install(recordedFixture().snapshot);
    const opener = document.createElement('button');
    opener.textContent = 'Stats';
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = render(<StudyStatsPanel onClose={() => {}} />);
    expect(document.activeElement?.id).toBe(STUDY_STATS_IDS.dialog);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('gives every control at least 44 by 44 CSS pixels', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);

    const dialog = screen.getByRole('dialog', { name: STUDY_STATS_TITLE });
    const controls = [...dialog.querySelectorAll<HTMLElement>('button')];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.style.minWidth, `${control.textContent} has no min-width`).toBe('44px');
      expect(control.style.minHeight, `${control.textContent} has no min-height`).toBe('44px');
    }
  });

  it('closes from both the header and the footer control', () => {
    const onClose = vi.fn();
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={onClose} />);

    const headerClose = screen.getByRole('button', { name: 'Close your study record' });
    const footerClose = screen.getByText('Close', { selector: '.study-stats__footer button' });
    // Named queries so the assertion cannot pass because there happened to be one button.
    expect(footerClose).not.toBe(headerClose);
    expect(document.getElementById(STUDY_STATS_IDS.close)).toBe(headerClose);

    fireEvent.click(headerClose);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(footerClose);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('has no hover-only action: every element with a click handler is a button', () => {
    install(recordedFixture().snapshot);
    render(<StudyStatsPanel onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: STUDY_STATS_TITLE });
    // A `div` or `span` with a click handler is not reachable by keyboard; this dashboard
    // has five kinds of control and every one of them is a `button` or an `a[href]`.
    const clickableNonControls = [...dialog.querySelectorAll('div, span, li, p, dd')].filter(
      (node) => node.getAttribute('onclick') !== null || node.getAttribute('tabindex') !== null,
    );
    expect(clickableNonControls).toHaveLength(0);
    expect(dialog.querySelectorAll('a[href]')).toHaveLength(0);
  });
});

// ── The rollback gate '───────────────────────────────────────────────────────

describe('the Phase 18 rollback gate', () => {
  it('turning it off hides the dashboard and keeps every record', () => {
    const { snapshot } = recordedFixture({ overdueRoom: true });
    install(snapshot);
    useProgressionStore.setState({
      bySubject: {
        [SUBJECT]: { xpTotal: 120, rank: 'Scholar', badges: [], fishCollection: [] },
      } as never,
      crossSubjectAchievements: [],
      collectedNotes: [],
    });

    // The whole recorded state, captured as strings so a before/after comparison cannot be
    // satisfied by two different objects that happen to look alike.
    const progressionBefore = JSON.stringify(useProgressionStore.getState().bySubject);
    const snapshotBefore = JSON.stringify(useStatisticsStore.getState().snapshot);
    const storageBefore = JSON.stringify(Object.entries(window.localStorage).sort());

    const restore = setStudyStatsDashboardEnabled(false);
    try {
      const { unmount } = render(<StudyStatsPanel onClose={() => {}} />);

      // Half 1: the display is off.
      const disabled = document.getElementById(STUDY_STATS_IDS.disabled) as HTMLElement;
      expect(disabled).not.toBeNull();
      expect(disabled).toHaveTextContent(STUDY_STATS_DISABLED_TITLE);
      expect(disabled).toHaveTextContent(STUDY_STATS_DISABLED_BODY);
      expect(document.getElementById(STUDY_STATS_IDS.dashboard)).toBeNull();
      expect(document.querySelectorAll('[data-study-stats-total]')).toHaveLength(0);
      expect(document.querySelectorAll('[data-study-stats-subject]')).toHaveLength(0);
      expect(screen.queryByText(STUDY_STATS_TITLE)).not.toBeNull();
      // And it is still a dismissible dialog rather than a trap.
      expect(screen.getByRole('dialog', { name: STUDY_STATS_TITLE })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Close your study record' })).toBeInTheDocument();

      // Half 2: the records are untouched.
      expect(JSON.stringify(useProgressionStore.getState().bySubject)).toBe(progressionBefore);
      expect(JSON.stringify(useStatisticsStore.getState().snapshot)).toBe(snapshotBefore);
      expect(JSON.stringify(Object.entries(window.localStorage).sort())).toBe(storageBefore);
      unmount();
    } finally {
      restore();
    }

    // Half 3: turning it back on shows exactly the same numbers.
    render(<StudyStatsPanel onClose={() => {}} />);
    const tile = document.querySelector('[data-study-stats-total="notes-written"]') as HTMLElement;
    expect(tile.getAttribute('data-study-stats-value')).toBe(String(snapshot.totals.notesSubmitted));
    expect(
      document.querySelector('[data-study-stats-subject="0"]')?.getAttribute('data-study-stats-subject-urgency'),
    ).toBe('overdue');
  });

  it('a second override restores only if nothing else changed the gate underneath it', () => {
    const first = setStudyStatsDashboardEnabled(false);
    const second = setStudyStatsDashboardEnabled(false);
    // `second` installed over an already-off gate, so restoring it is a no-op: it has no
    // earlier value to put back.
    second();
    expect(isStudyStatsDashboardEnabled()).toBe(false);
    first();
    expect(isStudyStatsDashboardEnabled()).toBe(true);
  });

  it('notifies subscribers, and reports the value it changed to', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeStudyStatsGate(() => seen.push(isStudyStatsDashboardEnabled()));
    const restore = setStudyStatsDashboardEnabled(false);
    restore();
    unsubscribe();
    expect(seen).toEqual([false, true]);
    // Nothing after the unsubscribe.
    setStudyStatsDashboardEnabled(false)();
    expect(seen).toEqual([false, true]);
  });

  it('notifies nobody when the value does not change', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeStudyStatsGate(() => seen.push(isStudyStatsDashboardEnabled()));
    const noop = setStudyStatsDashboardEnabled(true);
    expect(typeof noop).toBe('function');
    expect(seen).toEqual([]);
    unsubscribe();
  });

  it('is not a build-time feature flag, and the flag matrix is unchanged', async () => {
    const { CUTOVER_BOOLEAN_FLAG_KEYS, NON_CUTOVER_FLAG_KEYS, FEATURE_FLAG_MATRIX } =
      await import('@/config/featureFlags');
    const { DEFAULT_RUNTIME_CONFIG, RUNTIME_FLAG_ENV_KEYS } = await import('@/config/runtimeConfig');

    // Exactly the one kill switch Phase 10 added, and no Phase 18 entry beside it.
    expect([...NON_CUTOVER_FLAG_KEYS]).toEqual(['audioEnabled']);
    // No key anywhere in the runtime config names this phase or this panel.
    for (const key of Object.keys(DEFAULT_RUNTIME_CONFIG)) {
      expect(key.toLowerCase()).not.toMatch(/stats|statistic|study/);
    }
    for (const key of Object.values(RUNTIME_FLAG_ENV_KEYS)) {
      expect(key).not.toMatch(/STAT/i);
    }
    // The flags that default on are exactly the reviewed cutover booleans plus the one kill
    // switch, so an unreviewed flag cannot quietly default on - and this phase added no flag
    // at all.
    const defaultsOn = Object.entries(FEATURE_FLAG_MATRIX)
      .filter(([, definition]) => definition.productionDefault === true)
      .map(([key]) => key)
      .sort();
    expect(defaultsOn).toEqual([...CUTOVER_BOOLEAN_FLAG_KEYS, 'audioEnabled'].sort());
  });
});

// ── The HUD entry point '─────────────────────────────────────────────────────

describe('the village Stats entry point', () => {
  function renderHud(onStatsClick = vi.fn()): { onStatsClick: ReturnType<typeof vi.fn> } {
    render(
      <VillageHud
        questStep="intro"
        subjects={[{ id: SUBJECT, subjectName: SUBJECT_NAME, roomCount: 3, clearedRoomCount: 1 }]}
        selectedClass={null}
        onSelectClass={() => {}}
        onCreateSubject={() => {}}
        onOpenData={() => {}}
        colorTheme="dark"
        onColorThemeChange={() => {}}
        onQuestClick={() => {}}
        onStatsClick={onStatsClick}
        onSettingsClick={() => {}}
        nearbyTargets={[]}
        nearbyListAvailable={false}
        nearbyInvokeAvailable={false}
        onInvokeNearby={() => {}}
      />,
    );
    return { onStatsClick };
  }

  it('is an ordinary enabled control in the default build', () => {
    renderHud();
    const button = screen.getByRole('button', { name: /Stats/ });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(document.getElementById(STUDY_STATS_IDS.hudDisabledNote)).toBeNull();

    fireEvent.click(button);
    expect(screen.getByRole('button', { name: /Stats/ })).toBeInTheDocument();
  });

  it('is present, focusable, and explained when the gate is off - and inert', () => {
    const restore = setStudyStatsDashboardEnabled(false);
    try {
      const { onStatsClick } = renderHud();
      const button = screen.getByRole('button', { name: /Stats/ });
      expect(button.getAttribute('aria-disabled')).toBe('true');
      const describedBy = button.getAttribute('aria-describedby');
      expect(describedBy).toBe(STUDY_STATS_IDS.hudDisabledNote);
      const note = document.getElementById(describedBy as string) as HTMLElement;
      // Visible, not screen-reader-only: a reason a sighted learner cannot see is half a
      // reason, and this rule only applies when the gate is off.
      expect(note).toHaveTextContent(STUDY_STATS_DISABLED_HUD_NOTE);
      expect(note.className).not.toMatch(/visually-hidden|sr-only/);
      // `aria-disabled` keeps it in the tab order, which is what makes the reason reachable.
      button.focus();
      expect(document.activeElement).toBe(button);

      fireEvent.click(button);
      expect(onStatsClick).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('keeps its 44-pixel floor', () => {
    renderHud();
    const button = screen.getByRole('button', { name: /Stats/ });
    expect(button.style.minWidth).toBe('44px');
    expect(button.style.minHeight).toBe('44px');
  });
});
