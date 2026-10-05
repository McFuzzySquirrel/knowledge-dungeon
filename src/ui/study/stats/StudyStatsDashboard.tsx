/**
 * The statistics dashboard body: totals, daily activity, retention, per-subject cards, and
 * recent sessions.
 *
 * ## Presentation only
 *
 * Every number and every sentence in this file arrives from
 * {@link buildStudyStatsView}. The component decides layout, semantics and *which words are
 * headings*, and it re-derives nothing: there is no arithmetic in this file, no store read,
 * and no formatting of a count. That is what makes the view model the reviewable artefact
 * and this file the boring one.
 *
 * ## The three accessibility properties this file is responsible for
 *
 * 1. **Dialog semantics live in the panel**, not here: `role="dialog"`, `aria-modal`, the
 *    focus trap and Escape all belong to `StudyStatsPanel`, which owns the open/closed edge.
 *    This file is a fragment and can be rendered in a test with no dialog around it.
 * 2. **Every state is a word.** `reviewUrgency` arrives as one of three literals and is
 *    rendered as a glyph *and* the literal's own label *and* a CSS border-width change. The
 *    pre-Phase-18 panel carried the same information as a colour on a number, which is the
 *    one thing plan 10.1 forbids outright.
 * 3. **Every control is a real control.** The window selector is three `<button>`s in a
 *    labelled group with `aria-pressed`, not a hover menu, a slider with no value text, or a
 *    `<select>` whose only affordance is a native popup - so it is reachable by Tab, operable
 *    by Enter and Space, and announceable.
 *
 * ## 44 by 44 CSS pixels, written inline
 *
 * `STUDY_STATS_TOUCH_TARGET_STYLE` is applied as a `style` prop rather than left to the
 * stylesheet, for the reason `src/ui/village/villageTypes.ts` gives: jsdom does not compute
 * layout, so a touch-target floor that exists only in CSS cannot be asserted by a component
 * test at all. The stylesheet restates it as a backstop for a control added later.
 *
 * ## Nothing learner-private that is not useful
 *
 * The panel prints subject **names**, counts, and short local dates. It does not print a
 * subject id, a room id, a room topic, a note, a session id, or anything from the assistance
 * history - and it cannot, because the view model has none of those fields. Subject cards are
 * keyed on their position, which is a structural index.
 */
import type { ReactNode } from 'react';

import { REVIEW_URGENCY_COPY, STUDY_STATS_PRIVACY_NOTE, type ReviewUrgency } from './studyStatsCopy';
import { STUDY_STATS_IDS, STUDY_STATS_SECTIONS } from './studyStatsTestIds';
import type {
  StudyActivityEntry,
  StudyRetentionRow,
  StudySessionRow,
  StudyStatsView,
  StudySubjectCard,
  StudySubjectRow,
  StudyTotalRow,
} from './studyStatsViewModel';

import './studyStats.css';

/**
 * The 44 by 44 CSS-pixel floor, as a `style` object.
 *
 * Written out rather than interpolated from a token for the reason
 * `VILLAGE_TOUCH_TARGET_STYLE` is: the token is why 44 is the number, and a component test
 * can only check the value it can see.
 */
export const STUDY_STATS_TOUCH_TARGET_STYLE: {
  readonly minWidth: string;
  readonly minHeight: string;
} = Object.freeze({ minWidth: '44px', minHeight: '44px' });

/** The window options the activity chart offers, in days. */
export const STUDY_STATS_WINDOW_OPTIONS: readonly number[] = Object.freeze([7, 14, 30]);

export interface StudyStatsDashboardProps {
  readonly view: StudyStatsView;
  /** Days in the activity window, read from the store by the panel. */
  readonly windowDays: number;
  /** Applies a new window. An action from the store; this component calls nothing else. */
  readonly onWindowChange: (days: number) => void;
}

/**
 * Static heading ids.
 *
 * Static rather than `useId`-generated for the same reason `STUDY_STATS_IDS` is static: a
 * heading id reaches test output, and `useId` produces a different string in every render
 * environment, which makes a test that names one a test that only passes on the machine that
 * wrote it. There is exactly one dashboard in a document, so a fixed id is unique.
 */
const totalsHeadingId = 'study-stats-heading-totals';
const activityHeadingId = 'study-stats-heading-activity';
const retentionHeadingId = 'study-stats-heading-retention';
const subjectsHeadingId = 'study-stats-heading-subjects';
const sessionsHeadingId = 'study-stats-heading-sessions';

export function StudyStatsDashboard({
  view,
  windowDays,
  onWindowChange,
}: StudyStatsDashboardProps): ReactNode {
  return (
    <div
      className="study-stats__dashboard"
      id={STUDY_STATS_IDS.dashboard}
      data-study-stats-dashboard="recorded"
    >
      <RestoredNotice sentences={view.restoredSentences} />
      <OpenSessionsNotice sentence={view.openSessionsSentence} />

      <section
        className="study-stats__section"
        data-study-stats-section={STUDY_STATS_SECTIONS.totals}
        aria-labelledby={totalsHeadingId}
      >
        <h3 className="study-stats__heading" id={totalsHeadingId}>
          Totals
        </h3>
        <p className="study-stats__section-note">
          Everything below is counted on this device and added up across every subject.
        </p>
        <TotalList rows={view.totals} listId={STUDY_STATS_IDS.totals} />
      </section>

      <ActivitySection
        entries={view.activity.entries}
        caption={view.activity.caption}
        days={view.activity.days}
        windowDays={windowDays}
        onWindowChange={onWindowChange}
      />

      <section
        className="study-stats__section"
        data-study-stats-section={STUDY_STATS_SECTIONS.retention}
        aria-labelledby={retentionHeadingId}
      >
        <h3 className="study-stats__heading" id={retentionHeadingId}>
          Review and retention
        </h3>
        <RetentionList rows={view.retention} listId={STUDY_STATS_IDS.retention} />
        <p
          className="study-stats__note study-stats__note--scope"
          id={STUDY_STATS_IDS.reviewScope}
          data-study-scope={view.reviewScopeLimited ? 'partial' : 'complete'}
        >
          {view.reviewScopeNote}
        </p>
      </section>

      <section
        className="study-stats__section"
        data-study-stats-section={STUDY_STATS_SECTIONS.subjects}
        // On the `<section>`, not on the `<ul>`: the list is absent when there is nothing to
        // list, and an attribute that appears only when some other condition happens to hold
        // is an attribute a test can assert and the component can lie about.
        data-study-stats-subject-count={view.subjects.length}
        aria-labelledby={subjectsHeadingId}
      >
        <h3 className="study-stats__heading" id={subjectsHeadingId}>
          Dungeons
        </h3>
        {view.subjects.length === 0 ? (
          <p className="study-stats__note">No dungeon records on this device yet.</p>
        ) : (
          <ul className="study-stats__subjects" id={STUDY_STATS_IDS.subjects}>
            {view.subjects.map((card) => (
              <SubjectCard key={card.position} card={card} />
            ))}
          </ul>
        )}
      </section>

      <section
        className="study-stats__section"
        data-study-stats-section={STUDY_STATS_SECTIONS.sessions}
        data-study-stats-session-count={view.sessions.length}
        aria-labelledby={sessionsHeadingId}
      >
        <h3 className="study-stats__heading" id={sessionsHeadingId}>
          Recent sessions
        </h3>
        {view.sessions.length === 0 ? (
          <p className="study-stats__note">
            No closed sessions to list yet. The first one appears the moment you leave a
            dungeon.
          </p>
        ) : (
          <SessionList rows={view.sessions} />
        )}
      </section>

      <p className="study-stats__privacy" id={STUDY_STATS_IDS.privacy}>
        {STUDY_STATS_PRIVACY_NOTE}
      </p>
    </div>
  );
}

// ── Totals '──────────────────────────────────────────────────────────────────

function TotalList({
  rows,
  listId,
}: {
  readonly rows: readonly StudyTotalRow[];
  readonly listId: string;
}): ReactNode {
  return (
    <dl className="study-stats__grid" id={listId} data-study-stats-row-count={rows.length}>
      {rows.map((row) => (
        <div
          className="study-stats__tile"
          key={row.id}
          data-study-stats-total={row.id}
          // Sourced from the same `rawValue` the text was formatted from, so the two cannot
          // disagree. `undefined` rather than an empty string when there is no number, so no
          // test can read `data-...-value=""` and call it zero.
          {...(row.rawValue === null ? {} : { 'data-study-stats-value': row.rawValue })}
          data-study-stats-unit={row.unit}
        >
          <dt className="study-stats__tile-label">{row.label}</dt>
          <dd className="study-stats__tile-value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RetentionList({ rows, listId }: { readonly rows: readonly StudyRetentionRow[]; readonly listId: string }): ReactNode {
  return (
    <dl className="study-stats__rows" id={listId} data-study-stats-row-count={rows.length}>
      {rows.map((row) => (
        <div
          className="study-stats__row"
          key={row.id}
          data-study-stats-retention={row.id}
          {...(row.rawValue === null ? {} : { 'data-study-stats-value': row.rawValue })}
          data-study-stats-unit={row.unit}
        >
          <dt className="study-stats__row-label">{row.label}</dt>
          <dd className="study-stats__row-value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Activity '────────────────────────────────────────────────────────────────

function ActivitySection({
  entries,
  caption,
  days,
  windowDays,
  onWindowChange,
}: {
  readonly entries: readonly StudyActivityEntry[];
  readonly caption: string;
  readonly days: number;
  readonly windowDays: number;
  readonly onWindowChange: (days: number) => void;
}): ReactNode {
  return (
    <section
      className="study-stats__section"
      data-study-stats-section={STUDY_STATS_SECTIONS.activity}
      aria-labelledby={activityHeadingId}
    >
      <h3 className="study-stats__heading" id={activityHeadingId}>
        Daily activity
      </h3>
      <p className="study-stats__section-note">{caption}</p>

      <div
        className="study-stats__window"
        role="group"
        id={STUDY_STATS_IDS.activityWindow}
        aria-label="How many days of daily activity to show"
      >
        {STUDY_STATS_WINDOW_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className="study-stats__window-button"
            // `aria-pressed` is the word-and-attribute half of "which window is on". The
            // `--selected` class is the painted half and is never the only signal: the CSS
            // gives it a font weight and an inset bar as well as a fill.
            aria-pressed={option === windowDays}
            onClick={() => onWindowChange(option)}
            style={STUDY_STATS_TOUCH_TARGET_STYLE}
            data-study-stats-window={option}
          >
            {`Last ${option} days`}
          </button>
        ))}
      </div>

      <ol className="study-stats__activity" id={STUDY_STATS_IDS.activity} data-study-stats-day-count={entries.length}>
        {entries.map((entry) => (
          <li
            className="study-stats__day"
            key={entry.dateKey}
            // A local calendar day, which is also this cell's visible text three lines down.
            // `src/ui/study/stats/studyStatsTestIds.ts` states why that one value is allowed
            // where no subject id or room id is.
            data-study-stats-day={entry.dateKey}
            data-study-stats-day-minutes={entry.minutes}
            data-study-stats-day-active={entry.active ? 'yes' : 'no'}
            data-study-stats-day-today={entry.isToday ? 'yes' : 'no'}
          >
            {/*
              The bar is decorative and says so. Every number it encodes is in the sentence
              beneath it, in the DOM, in reading order - so the chart is a picture of data a
              learner can also read, which is what 1.4.1 and 1.1.1 ask for and what a
              `<div title>` is not.
            */}
            <span className="study-stats__bar-track" aria-hidden="true">
              <span className="study-stats__bar" style={{ height: `${entry.heightPercent}%` }} />
            </span>
            {/*
              One label, one word. `formatActivityDayLabel` already prints `Today` for the
              snapshot's today, so the flag this used to sit beside was a second copy of the
              same word - and a test looking for it found two. Today is additionally marked by
              the cell's border *width* in the stylesheet and by `data-study-stats-day-today`,
              both sourced from `entry.isToday`.
            */}
            <span className="study-stats__day-label">{entry.label}</span>
            <span className="study-stats__day-detail">{entry.description}</span>
          </li>
        ))}
      </ol>
      {/*
        The window's extent, in words. Naming the day it ends on is what turns "14 days" from
        a vague window into something a learner can match against the chart above, and it is
        the last entry's own label rather than a second date computation here.
      */}
      <p className="study-stats__note" data-study-stats-window-days={days}>
        {days === 0
          ? 'The activity window is empty. Choose a window above to show days.'
          : `Showing ${days} ${days === 1 ? 'day' : 'days'}, ending on the newest one above.`}
      </p>
    </section>
  );
}

// ── Notices '─────────────────────────────────────────────────────────────────

function RestoredNotice({ sentences }: { readonly sentences: readonly string[] }): ReactNode {
  if (sentences.length === 0) return null;
  return (
    <div
      className="study-stats__notice study-stats__notice--restored"
      id={STUDY_STATS_IDS.restored}
      data-study-stats-section={STUDY_STATS_SECTIONS.restored}
      // `status`, not `alert`: this is an explanation a learner may want to read at their own
      // pace, and it appears because records were restored, not because anything failed.
      role="status"
    >
      <h3 className="study-stats__notice-heading">Restored history</h3>
      {sentences.map((sentence) => (
        <p className="study-stats__notice-body" key={sentence}>
          {sentence}
        </p>
      ))}
    </div>
  );
}

function OpenSessionsNotice({ sentence }: { readonly sentence: string | null }): ReactNode {
  if (sentence === null) return null;
  return (
    <p className="study-stats__notice study-stats__notice--open" id={STUDY_STATS_IDS.openSessions} data-study-stats-open-sessions="yes">
      {sentence}
    </p>
  );
}

// ── Subject cards '───────────────────────────────────────────────────────────

/**
 * One subject's card.
 *
 * The review chip is the load-bearing element. It carries three non-colour signals for the
 * same fact - a glyph, a word, and a border width - so it survives greyscale, a
 * colour-vision deficiency, forced colours, and a monochrome print. The counts are separate
 * numeric attributes so a test compares numbers rather than a formatted phrase.
 */
function SubjectCard({ card }: { readonly card: StudySubjectCard }): ReactNode {
  const urgency: ReviewUrgency = card.reviewUrgency;
  const copy = REVIEW_URGENCY_COPY[urgency];
  return (
    <li
      className={`study-stats__subject study-stats__subject--${urgency}`}
      data-study-stats-subject={card.position}
      data-study-stats-subject-urgency={urgency}
      data-study-stats-subject-total-rooms={card.totalRooms}
      data-study-stats-cleared-rooms={card.clearedRooms}
      data-study-stats-review-due={card.reviewDueCount}
      data-study-stats-review-overdue={card.reviewOverdueCount}
    >
      <h4 className="study-stats__subject-name">{card.name}</h4>

      {/*
        The state sentence. `mastery` is the ordered scale's word and `provenMastery` is the
        separate proven-mastery sentence, because the proven rule is a rule over two other
        facts and folding it into one label would make the label wrong when either changed.
      */}
      <p className="study-stats__subject-mastery">{card.mastery}</p>
      {card.provenMastery !== null ? (
        <p className="study-stats__subject-proven" data-study-stats-proven="yes">
          {card.provenMastery}
        </p>
      ) : null}
      <p className="study-stats__subject-rooms">{card.rooms}</p>

      <dl className="study-stats__rows study-stats__rows--tight">
        {card.rows.map((row) => (
          <SubjectRow key={row.id} row={row} />
        ))}
      </dl>

      <h5 className="study-stats__subject-subheading">Review and retention</h5>
      <p
        className={`study-stats__chip study-stats__chip--${urgency}`}
        data-study-stats-review-state={urgency}
      >
        <span className="study-stats__chip-glyph" aria-hidden="true">
          {copy.glyph}
        </span>
        <span className="study-stats__chip-label">{copy.label}</span>
      </p>
      <p className="study-stats__subject-review-detail">
        {`${card.reviewDueCount} due now, ${card.reviewOverdueCount} overdue`}
      </p>
      <dl className="study-stats__rows study-stats__rows--tight">
        {card.reviewRows.map((row) => (
          <SubjectRow key={row.id} row={row} />
        ))}
      </dl>

      {card.bonusNote !== null ? (
        <p className="study-stats__note" data-study-stats-bonus-note="yes">
          {card.bonusNote}
        </p>
      ) : null}
      {card.clearReconciliation.sentence !== null ? (
        <p
          className="study-stats__note"
          // `counter-discrepancy` is kept as a stable selector even though the framing is now
          // three tallies rather than two - it is on the rendered element either way, and a
          // selector QA already has keeps resolving. The four numbers below are the assertion
          // surface: a test reads those and never the sentence.
          data-study-stats-counter-discrepancy="yes"
          data-study-stats-clear-reconciliation="yes"
          data-study-stats-clear-counter={card.clearReconciliation.counter}
          data-study-stats-clear-awarded={card.clearReconciliation.awarded}
          data-study-stats-clear-counted-notes={card.clearReconciliation.countedNotes}
          data-study-stats-clear-unrecorded={card.clearReconciliation.unrecordedClears}
        >
          {card.clearReconciliation.sentence}
        </p>
      ) : null}
      {card.lastActiveLabel !== null ? (
        <p className="study-stats__note" data-study-stats-last-active={card.lastActiveLabel}>
          {`Last active ${card.lastActiveLabel}`}
        </p>
      ) : (
        <p className="study-stats__note" data-study-stats-last-active="none">
          Not active on any recorded day yet
        </p>
      )}
    </li>
  );
}

function SubjectRow({ row }: { readonly row: StudySubjectRow }): ReactNode {
  return (
    <div
      className="study-stats__row"
      data-study-stats-subject-row={row.id}
      {...(row.rawValue === null ? {} : { 'data-study-stats-value': row.rawValue })}
      data-study-stats-unit={row.unit}
    >
      <dt className="study-stats__row-label">{row.label}</dt>
      <dd className="study-stats__row-value">{row.value}</dd>
    </div>
  );
}

// ── Sessions '────────────────────────────────────────────────────────────────

function SessionList({ rows }: { readonly rows: readonly StudySessionRow[] }): ReactNode {
  return (
    <ol className="study-stats__sessions" id={STUDY_STATS_IDS.sessions}>
      {rows.map((row) => (
        <li
          className="study-stats__session"
          key={row.position}
          data-study-stats-session={row.position}
          data-study-stats-session-open={row.open ? 'yes' : 'no'}
          data-study-stats-session-minutes={row.minutes === null ? 'open' : row.minutes}
          data-study-stats-session-rooms={row.roomsVisited}
          data-study-stats-session-notes={row.notes}
          data-study-stats-session-reviews={row.reviews}
          data-study-stats-session-xp={row.xp}
        >
          <span className="study-stats__session-when">
            {row.open ? <span className="study-stats__open-flag">Still open</span> : null}
            {`${row.dayLabel} · ${row.subjectName}`}
          </span>
          <span className="study-stats__session-duration">{row.duration}</span>
          <span className="study-stats__session-detail">
            {`${row.roomsVisited} ${row.roomsVisited === 1 ? 'room' : 'rooms'} · ` +
              `${row.notes} ${row.notes === 1 ? 'note' : 'notes'} · ` +
              `${row.reviews} ${row.reviews === 1 ? 'review' : 'reviews'} · ` +
              `${row.xp} XP`}
          </span>
        </li>
      ))}
    </ol>
  );
}
