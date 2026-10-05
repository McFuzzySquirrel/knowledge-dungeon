/**
 * The study statistics dialog.
 *
 * ## What this file owns
 *
 * Three things, and no arithmetic:
 *
 * 1. **The dialog edge.** `role="dialog"`, `aria-modal`, the labelled heading, initial focus,
 *    Tab containment, Escape, and focus restoration - all from `useModalFocus`, which is the
 *    single implementation plan 10.1 asks for. The pre-Phase-18 panel was a `div` with
 *    `role="dialog"` painted as a modal and **no** focus trap, no initial focus, no Escape,
 *    and no restoration, so a keyboard user who opened it landed wherever the browser chose
 *    and could Tab straight out into the village behind it.
 * 2. **Which state renders**: the redesigned dashboard, the empty explanation, or the
 *    gate-off notice. Decided in {@link buildStudyStatsView} and
 *    {@link useStudyStatsDashboardEnabled}; this file only chooses the branch.
 * 3. **The two store reads** - the snapshot and the window length - as selectors, plus the
 *    one window action. Nothing else touches a store, and no mutation is invented here.
 *
 * ## What it deliberately does not do
 *
 * - It does not call `computeSessionStats()`. That function still exists with its pre-Phase-18
 *    shape for back-compat, and the pre-Phase-18 panel called it - which is why the panel
 *    showed `0` sessions forever: nothing ever started a session, and every `track*` returned
 *    early on a `currentSession` that was never set. `useStatistics()` reads the one
 *    authoritative snapshot, so a dashboard that could disagree with a progression record
 *    cannot be written here.
 * - It does not import `@/core/review` and recompute review analytics. The snapshot publishes
 *    `reviewDueCount` / `reviewOverdueCount` per subject from the same module the review flow
 *    uses, and a second call to `summarizeReviewAnalytics` with a hard `0` for the longest
 *    streak is precisely the defect the domain removed.
 * - It does not render an internal id, a room id, a room topic, a note, a badge name list, or
 *    anything from the assistance history. Badges are a count, not a list of internal names.
 *
 * ## The rollback gate
 *
 * {@link useStudyStatsDashboardEnabled} is the DOM-layer gate this phase's rollback uses, and
 * `src/ui/study/stats/studyStatsGate.ts` explains why it is not a feature flag. The important
 * property here is the negative one: with the gate off, this component renders a notice and
 * **reads no statistic and writes nothing**. The records are in the stores, they stay there,
 * and re-enabling the gate shows the same numbers.
 */
import type { ReactNode } from 'react';

import { localDateKey } from '@/core/statistics';
import { useStatistics, useStatisticsStore } from '@/store/statisticsStore';
import { useModalFocus } from '@/ui/hooks/useModalFocus';
import { usePreferencesStore } from '@/store/preferencesStore';

import {
  STUDY_STATS_DISABLED_BODY,
  STUDY_STATS_DISABLED_TITLE,
  STUDY_STATS_TITLE,
  countWithUnit,
} from '@/ui/study/stats/studyStatsCopy';
import { StudyStatsDashboard } from '@/ui/study/stats/StudyStatsDashboard';
import { useStudyStatsDashboardEnabled } from '@/ui/study/stats/studyStatsGate';
import { STUDY_STATS_IDS, STUDY_STATS_SECTIONS } from '@/ui/study/stats/studyStatsTestIds';
import { buildStudyStatsView } from '@/ui/study/stats/studyStatsViewModel';

// No `import './studyStats.css'` here. `StudyStatsDashboard.tsx` - a static import of this
// file - already declares the stylesheet, which is the colocated-CSS idiom
// `src/ui/fishing/fishing.css` and `src/ui/study/study.css` use: one import, from the module
// that owns the family. `VillageHud.tsx` does not import it either, for the same reason - its
// one rule from that file is in the initial bundle regardless, because the whole family is
// statically reachable from `src/main.tsx`.

export interface StudyStatsPanelProps {
  /** Closes the dialog. Escape and both close controls call it. */
  readonly onClose: () => void;
}

export function StudyStatsPanel({ onClose }: StudyStatsPanelProps): ReactNode {
  const snapshot = useStatistics();
  const windowDays = useStatisticsStore((state) => state.dailyActivityDays);
  const setWindowDays = useStatisticsStore((state) => state.setDailyActivityDays);
  const colorTheme = usePreferencesStore((state) => state.colorTheme);
  const dashboardEnabled = useStudyStatsDashboardEnabled();

  const headingId = STUDY_STATS_IDS.title;
  const subtitleId = `${STUDY_STATS_IDS.title}-subtitle`;
  const panelRef = useModalFocus<HTMLDivElement>({ active: true, onEscape: onClose });
  const view = buildStudyStatsView(snapshot);

  return (
    <div className="modal-backdrop">
      <div
        ref={panelRef}
        className="modal study-stats__dialog ui-skin"
        id={STUDY_STATS_IDS.dialog}
        data-theme={colorTheme}
        data-study-stats-dialog={dashboardEnabled ? 'enabled' : 'disabled'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={subtitleId}
        // The container itself must be focusable, or `useModalFocus` has nothing to focus on
        // open and nothing to pull a stray Tab back to.
        tabIndex={-1}
      >
        <div className="study-stats__header">
          <div>
            <h2 className="study-stats__title" id={headingId}>
              {STUDY_STATS_TITLE}
            </h2>
            {/*
              The subtitle is the dialog's description, so a screen reader announces what
              opened *before* the fourteen totals rather than after them. It states the scope
              honestly - all of it local, none of it uploaded - because that is the first
              question a learner has about a statistics page.
            */}
            <p className="study-stats__subtitle" id={subtitleId}>
              {`Counted on this device, across every dungeon. Updated ${formatGeneratedAt(snapshot.generatedAt)}.`}
            </p>
          </div>
          <button
            type="button"
            className="study-stats__close"
            id={STUDY_STATS_IDS.close}
            onClick={onClose}
            aria-label="Close your study record"
            style={{ minWidth: '44px', minHeight: '44px' }}
            data-study-stats-touch-target="close"
          >
            Close
          </button>
        </div>

        {dashboardEnabled ? (
          view.empty ? (
            <EmptyState sentences={view.emptySentences} />
          ) : (
            <StudyStatsDashboard
              view={view}
              windowDays={windowDays}
              onWindowChange={setWindowDays}
            />
          )
        ) : (
          <DisabledNotice />
        )}

        <div className="study-stats__footer">
          <button
            type="button"
            className="study-stats__close"
            onClick={onClose}
            style={{ minWidth: '44px', minHeight: '44px' }}
            data-study-stats-touch-target="close-footer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The empty state.
 *
 * Not zeros and not a blank panel. It says what the page is for, what fills it, and - when
 * the device already holds dungeons - that the dungeons are there and simply have not been
 * walked. The second sentence is the one a learner with a fresh subject needs, because the
 * failure they are actually worried about is "my work is not being saved".
 */
function EmptyState({ sentences }: { readonly sentences: readonly string[] }): ReactNode {
  return (
    <div
      className="study-stats__empty"
      id={STUDY_STATS_IDS.empty}
      data-study-stats-section={STUDY_STATS_SECTIONS.empty}
      data-study-stats-empty="true"
    >
      <h3 className="study-stats__empty-heading">Nothing to count yet</h3>
      {sentences.map((sentence) => (
        <p className="study-stats__empty-body" key={sentence}>
          {sentence}
        </p>
      ))}
    </div>
  );
}

/**
 * The gate-off body.
 *
 * It is a real dialog with a real close control, not a blank sheet, because a sheet with no
 * content and no way out is a trap. It says the records are intact, which is the claim the
 * rollback makes and the one a learner would otherwise have no way to check.
 */
function DisabledNotice(): ReactNode {
  return (
    <div
      className="study-stats__disabled"
      id={STUDY_STATS_IDS.disabled}
      data-study-stats-section={STUDY_STATS_SECTIONS.disabled}
      data-study-stats-disabled="true"
      role="status"
    >
      <h3 className="study-stats__disabled-heading">{STUDY_STATS_DISABLED_TITLE}</h3>
      <p className="study-stats__disabled-body">{STUDY_STATS_DISABLED_BODY}</p>
    </div>
  );
}

/**
 * When the snapshot was built, in words.
 *
 * "just now" / "12 minutes ago" / a short local date and time, from
 * `snapshot.generatedAt`. A statistics page that cannot say when it was last worked out is a
 * page whose numbers a learner cannot reason about; the value is the domain's own timestamp,
 * not a `new Date()` read here, so the sentence describes the snapshot rather than the render.
 */
function formatGeneratedAt(generatedAt: string): string {
  const parsed = Date.parse(generatedAt);
  if (Number.isNaN(parsed)) return 'at an unknown time';
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - parsed) / 60000));
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return `${countWithUnit(elapsedMinutes, 'minute')} ago`;
  const date = new Date(parsed);
  const sameDay = localDateKey(date) === localDateKey(new Date());
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay
    ? `today at ${time}`
    : `on ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`;
}
