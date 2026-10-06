/**
 * The village HUD: the persistent status and control column.
 *
 * ## Extracted, not redesigned
 *
 * This is the pre-Phase-12 `VillageHudContent`, moved out of a 1798-line screen
 * into a module of its own, plus three deliberate additions. The layout, the class
 * names, the archetype grid, the quest log and the control row are unchanged, so
 * the legacy stylesheet in `src/styles.css` still paints them and the four Phase-1
 * viewport projects still see the same screen.
 *
 * The additions are all reachable-from-the-DOM work the phase asks for:
 *
 * 1. **The nearby-action list** is now part of the HUD, not only reachable by
 *    walking into something. It is the exit criterion's surface, and an exit
 *    criterion that needs the canvas to reach is not met.
 * 2. **The quest overview** is a native `<details>` disclosure at the bottom of
 *    the quest section, so "who do I ask?" is answerable from the HUD with no
 *    renderer and with no JavaScript. `<details>` rather than a button plus state:
 *    a disclosure is a native control, it is keyboard-operable for free, and it
 *    costs no `aria-expanded` bookkeeping that can drift.
 * 3. **A polite status sentence** naming the current structure, because the
 *    structure panel is opened by *walking* rather than by an action, so on a wide
 *    side panel - which deliberately never takes focus - this sentence is how a
 *    screen-reader user learns that the panel changed.
 *
 * ## Two shapes, one component, and the touch drawer *is* the bottom sheet
 *
 * On a wide viewport this is a permanent 240-pixel side column and there is nothing
 * to collapse. On touch it is a bottom sheet, and Phase 12 gives that sheet the
 * three things the phase's exit criterion demands of a bottom sheet: it is a
 * `role="dialog"` with `aria-modal="false"`, focus moves into it and is contained
 * while it is open, and it closes on `Escape` and on a labelled ≥44-pixel toggle.
 * The pre-Phase-12 drawer was a `translateY(100%)` box with no semantics at all.
 *
 * The drawer is **closed by default on touch**, which is a change and the reason
 * is a collision: the sheet occupies the bottom 60dvh, and so does the world's
 * own 56-pixel Interact control at `bottom: 14px; left: 14px` (`z-index: 6` against
 * the drawer's 80). Open by default it covered the one control a touch learner
 * needs most. It also means the structure panel - the *other* bottom sheet - has the
 * bottom of the viewport to itself, and `onDrawerOpenChange` lets the screen close
 * one when the other opens.
 *
 * That last point is why the collapsed drawer carries `hidden` rather than only the
 * legacy `village-hud--hidden` class: that class is `transform` + `opacity` +
 * `pointer-events`, which leaves every control inside it in the tab order and
 * focusable. `hidden` takes it out of the accessibility tree and the tab order
 * together. The cost is that the slide-in transition no longer runs on open, which
 * is motion that carried no information.
 */
import {
  useCallback,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { PLAYER_CLASSES } from '@/game/systems/playerClasses';
import { QUEST_LABELS, QUEST_ORDER, type QuestStep } from '@/store/sessionStore';
import type { VillageNearbyTarget } from '@/application/contracts/villageNpc';

import { useModalFocus } from '@/ui/hooks/useModalFocus';
import { STUDY_STATS_DISABLED_HUD_NOTE } from '@/ui/study/stats/studyStatsCopy';
import { useStudyStatsDashboardEnabled } from '@/ui/study/stats/studyStatsGate';
import { STUDY_STATS_IDS } from '@/ui/study/stats/studyStatsTestIds';

import { NearbyActionList } from './NearbyActionList';
import { VillageQuestOverview } from './QuestBoard';
import { useVillageSurfaceMode } from './useVillageSurfaceMode';
import { VILLAGE_TOUCH_TARGET_STYLE, type VillageSubjectSummary } from './villageTypes';

import './villagePanels.css';
// `src/ui/study/stats/studyStats.css` is deliberately not imported here. That file is
// declared by `StudyStatsDashboard.tsx`, which is statically reachable from `src/main.tsx`
// through the stats launcher, so its one rule this file uses - `.study-stats-hud-note` - is
// in the initial bundle without a second edge here, and one import per stylesheet family is
// the colocated-CSS idiom.

export interface VillageHudProps {
  /** The learner's current quest step. */
  readonly questStep: QuestStep;
  /** The subjects the village portal slots are built from. */
  readonly subjects: readonly VillageSubjectSummary[];
  /** The chosen archetype id, or `null`. */
  readonly selectedClass: string | null;
  /** Selects (or clears) an archetype. */
  readonly onSelectClass: (cls: string | null) => void;
  /** Opens the create-subject dialog. */
  readonly onCreateSubject: () => void;
  /** Opens the data-management dialog. */
  readonly onOpenData: () => void;
  /** The current colour theme id. */
  readonly colorTheme: string;
  /** Changes the colour theme. */
  readonly onColorThemeChange: (theme: string) => void;
  /** Selects a quest step and shows its guidance. */
  readonly onQuestClick: (step: QuestStep) => void;
  /** Opens the statistics dashboard. */
  readonly onStatsClick: () => void;
  /** Opens settings. */
  readonly onSettingsClick: () => void;

  /* ── The Phase 12 DOM surfaces, all renderer-neutral ─────────────────── */
  /** The contract's selected nearby rows, in its order. */
  readonly nearbyTargets: readonly VillageNearbyTarget[];
  /** Whether a snapshot capability has answered at least once. */
  readonly nearbyListAvailable: boolean;
  /** Whether an action dispatcher is present. */
  readonly nearbyInvokeAvailable: boolean;
  /** The shared, data-driven click handler. */
  readonly onInvokeNearby: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Told when the touch drawer opens or closes.
   *
   * The screen uses it to close an open structure panel, because a sheet and a
   * drawer both want the bottom of a touch viewport and two of them at once is
   * neither readable nor dismissible. On a wide viewport this never fires: the
   * HUD is a permanent column and there is no drawer to toggle.
   */
  readonly onDrawerOpenChange?: (open: boolean) => void;
}

/**
 * The colour-theme control.
 *
 * ## Why this is a radio group and not three toggle buttons
 *
 * Phase 21. This control was three buttons each carrying `aria-pressed`, so a screen reader
 * announced three independent toggles when the fact is one choice out of three. It is a
 * `radiogroup` now: one tab stop for the whole set, arrows to move, and `aria-checked` on the
 * member that is chosen. That is the ARIA pattern for "exactly one of these", and it is what makes
 * the set announce as one thing rather than three.
 *
 * ## Roving tabindex, and why the arrows both move *and* select
 *
 * A radio group has a single tab stop. Exactly one member carries `tabindex=0` - the checked one,
 * or the first when none is checked - and the rest carry `tabindex=-1`. Arrow keys move focus
 * between members and select as they go, which is the behaviour `role="radio"` promises and which a
 * plain button cannot: `Space` and `Enter` on a native button already activate it, so the only
 * keyboard contract this control has to write is the arrow movement and the roving index.
 *
 * ## The non-colour half of "which theme is on"
 *
 * Three, deliberately redundant, because no one of them is sufficient alone: `aria-checked` for a
 * screen reader, a `✓` mark in the DOM for a learner who cannot separate the gold accent from the
 * panel behind it, and the underline the stylesheet adds to `.active`. Removing colour is what
 * Phase 21 requires, and leaving only the colour is what it forbids.
 */
function ThemePicker({
  current,
  onChange,
}: {
  current: string;
  onChange: (theme: string) => void;
}): ReactNode {
  const themes = [
    { id: 'dark', label: 'Night' },
    { id: 'colorful', label: 'Arcade' },
    { id: 'aurora', label: 'Aurora' },
  ];
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = themes.findIndex((theme) => theme.id === current);
  // One tab stop, and it is never -1 for the whole group: with nothing checked the first member
  // takes the stop, so the group is always reachable by Tab.
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0;

  /** Move focus to a member, and check it. Arrow keys in a radio group do both. */
  const selectAt = useCallback(
    (index: number) => {
      const bounded = ((index % themes.length) + themes.length) % themes.length;
      const theme = themes[bounded];
      if (theme === undefined) return;
      onChange(theme.id);
      // After `onChange` the control re-renders with this member checked, so focusing it now
      // leaves focus and `aria-checked` agreeing.
      buttonRefs.current[bounded]?.focus();
    },
    [onChange],
  );

  return (
    <div className="village-theme-picker" role="radiogroup" aria-label="Colour theme">
      {themes.map((theme, index) => {
        const checked = theme.id === current;
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={checked}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            tabIndex={index === rovingIndex ? 0 : -1}
            className={checked ? 'active' : ''}
            onClick={() => onChange(theme.id)}
            onKeyDown={(event) => {
              // Arrow keys move and select. `Home` and `End` are the two the pattern also
              // allows, and they are cheap once the index arithmetic is written.
              let next: number | null = null;
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index + 1;
              else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index - 1;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = themes.length - 1;
              if (next === null) return;
              // The arrows move focus inside the group and are not page scrolling.
              event.preventDefault();
              selectAt(next);
            }}
          >
            {/*
              The check mark is `aria-hidden` because `aria-checked` already says it, and a screen
              reader that read both would say "checked Night check mark" every time it passed the
              control. It is here for a learner looking at the screen.
            */}
            {checked ? (
              <span className="village-theme-picker__mark" aria-hidden="true">
                ✓
              </span>
            ) : null}
            {theme.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The HUD column, and the toggle that collapses it on a touch viewport.
 */
export function VillageHud(props: VillageHudProps): ReactNode {
  const {
    questStep,
    subjects,
    selectedClass,
    onSelectClass,
    onCreateSubject,
    onOpenData,
    colorTheme,
    onColorThemeChange,
    onQuestClick,
    onStatsClick,
    onSettingsClick,
    nearbyTargets,
    nearbyListAvailable,
    nearbyInvokeAvailable,
    onInvokeNearby,
    onDrawerOpenChange,
  } = props;

  const surfaceMode = useVillageSurfaceMode();
  const collapsible = surfaceMode === 'sheet';
  // Closed by default on touch, open by default on a wide viewport. The lazy
  // initializer reads `collapsible`, which the hook has already resolved for this
  // first render, so there is no flash of the wrong shape - and a later
  // orientation change deliberately does *not* reset it, because reopening a sheet
  // the learner just dismissed is worse than keeping their choice.
  const [hudOpen, setHudOpen] = useState(!collapsible);
  const regionId = useId();
  const statusId = useId();
  /*
   * Phase 18's rollback gate, read here rather than in `VillageLaunchers`.
   *
   * The gate hides the dashboard; this is where the *entry point* has to know, because a
   * control that opens a panel which then says "this is switched off" is a dead end, and a
   * control that silently does nothing is worse. So the Stats button stays in the tab order
   * with `aria-disabled` and a described-by explanation, which is the ARIA pattern for
   * "present, not actionable, and here is why" - the button is still reachable, still
   * announces as disabled, and still hands a screen-reader user the reason.
   *
   * In the default build `statsEnabled` is `true`, the note is not rendered, the button has
   * no `aria-disabled`, and this HUD is byte-identical to the one before Phase 18.
   */
  const statsEnabled = useStudyStatsDashboardEnabled();
  const sheetRef = useModalFocus<HTMLDivElement>({
    active: collapsible && hudOpen,
    onEscape: collapsible && hudOpen ? () => setHudOpen(false) : null,
  });

  const toggleDrawer = useCallback((): void => {
    setHudOpen((open) => {
      const next = !open;
      onDrawerOpenChange?.(next);
      return next;
    });
  }, [onDrawerOpenChange]);
  const activeClass = PLAYER_CLASSES.find((entry) => entry.id === selectedClass);
  const questLabel = QUEST_LABELS[questStep]?.label ?? questStep;
  const questHint = QUEST_LABELS[questStep]?.hint ?? '';

  const column = (
    <>
      <div className="village-hud-header">
        <div className="village-hud-title">
          <span className="village-hud-icon" aria-hidden="true">
            🏘
          </span>
          <span>Dungeon Village</span>
        </div>
        <div className="village-hud-subtitle">
          <ThemePicker current={colorTheme} onChange={onColorThemeChange} />
        </div>
      </div>

      {/*
        The word-carrying status sentence. It names the current quest and the
        archetype, which are the two things a learner cannot see from the canvas
        and which the panel that opens on approach never gets focus to announce.
      */}
      <p className="village-hud-info" id={statusId} role="status" aria-live="polite">
        <span className="village-hud-status">
          Quest: {questLabel}. Archetype: {activeClass?.name ?? 'not set'}.
        </span>
      </p>

      <div className="village-hud-stats">
        <div className="village-stat">
          <span className="village-stat-label">Dungeons</span>
          <strong className="village-stat-value">{subjects.length}</strong>
        </div>
        <div className="village-stat">
          <span className="village-stat-label">Archetype</span>
          <strong className="village-stat-value">{activeClass?.name ?? 'Not set'}</strong>
        </div>
      </div>

      <NearbyActionList
        targets={nearbyTargets}
        onInvoke={onInvokeNearby}
        invokeAvailable={nearbyInvokeAvailable}
        listAvailable={nearbyListAvailable}
      />

      <div className="village-hud-classes">
        <span className="village-hud-section-label" id={regionId}>
          Study Archetype
        </span>
        <div className="village-class-grid" role="group" aria-labelledby={regionId}>
          {PLAYER_CLASSES.map((cls) => (
            <button
              key={cls.id}
              type="button"
              className={`village-class-btn${selectedClass === cls.id ? ' village-class-btn--selected' : ''}`}
              // `aria-pressed` carries "which archetype is chosen" as a word and an
              // attribute; the `--selected` class is the painted half.
              aria-pressed={selectedClass === cls.id}
              onClick={() => onSelectClass(cls.id)}
            >
              <strong>{cls.name}</strong>
              <span className="village-class-tagline">{cls.tagline}</span>
            </button>
          ))}
        </div>
        {activeClass ? (
          <div className="village-class-detail">
            <p className="village-class-desc">{activeClass.description}</p>
            <div className="village-class-perk">
              <span aria-hidden="true">✨</span> <strong>Perk:</strong> {activeClass.perk}
            </div>
          </div>
        ) : null}
      </div>

      {/* The quest log. The row and the dots are buttons now: the pre-Phase-12
          markup was a `div` and a `span` with `onClick`, which is not a control. */}
      <div className="village-quest-log">
        <span className="village-hud-section-label">Quest (choose to hear guidance)</span>
        <div className="village-quest-step">
          <span className="village-quest-icon" aria-hidden="true">
            {questStep === 'complete' ? '✅' : '▶'}
          </span>
          <div>
            <strong>{questLabel}</strong>
            <p className="village-quest-hint">{questHint}</p>
          </div>
        </div>
        <div
          className="village-quest-progress"
          role="group"
          aria-label="Quest steps. Choose one to hear its guidance."
        >
          {QUEST_ORDER.filter((step) => step !== 'intro').map((step) => {
            const index = QUEST_ORDER.indexOf(step);
            const currentIndex = QUEST_ORDER.indexOf(questStep);
            const done = index <= currentIndex;
            return (
              <button
                key={step}
                type="button"
                className={`village-quest-dot${done ? ' village-quest-dot--done' : ''}${step === questStep ? ' village-quest-dot--current' : ''}`}
                aria-current={step === questStep ? 'step' : undefined}
                // The dot is a glyph with no text, so the button needs a name.
                aria-label={`${QUEST_LABELS[step]?.label ?? step}: ${done ? 'done' : 'not yet'}${step === questStep ? ', current step' : ''}`}
                onClick={() => onQuestClick(step)}
                data-quest-step={step}
                data-village-touch-target="quest-dot"
                style={{ minWidth: '44px', minHeight: '44px' }}
              />
            );
          })}
        </div>

        <details className="village-quest-disclosure">
          <summary>Who can help with this quest</summary>
          <VillageQuestOverview questStep={questStep} />
        </details>
      </div>

      <div className="village-hud-info">
        <p className="village-hint">
          Walk with <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows. Press{' '}
          <kbd>E</kbd> to interact. Everything the world can do is also a button in the
          Nearby list above.
        </p>
      </div>

      <div className="village-hud-actions">
        <button type="button" className="village-action-btn" onClick={onCreateSubject}>
          + Create New
        </button>
        {statsEnabled ? null : (
          <p className="study-stats-hud-note" id={STUDY_STATS_IDS.hudDisabledNote}>
            {STUDY_STATS_DISABLED_HUD_NOTE}
          </p>
        )}
        <button
          type="button"
          className="village-action-btn"
          // Only wired when it can be honoured. With the gate off the handler is absent, so
          // clicking cannot open a panel that has nothing to show.
          onClick={statsEnabled ? onStatsClick : undefined}
          aria-disabled={statsEnabled ? undefined : true}
          aria-describedby={statsEnabled ? undefined : STUDY_STATS_IDS.hudDisabledNote}
          data-study-stats-touch-target="village-stats"
          style={VILLAGE_TOUCH_TARGET_STYLE}
        >
          <span aria-hidden="true">📊</span> Stats
        </button>
        <button
          type="button"
          className="village-action-btn"
          onClick={onOpenData}
          style={{ fontSize: 11, opacity: 0.7 }}
        >
          <span aria-hidden="true">🛡</span> Data
        </button>
        <button
          type="button"
          className="village-action-btn"
          onClick={onSettingsClick}
          /*
           * Phase 21: an explicit `aria-label` on this one launcher, and the reason is not cosmetic.
           *
           * Its accessible name was already "Settings" - the platform excludes the `aria-hidden` gear glyph
           * from the computation - so nothing about what a screen reader says has changed. What changed is
           * that the name is **stated** rather than derived from a decorative glyph that sits *before* the
           * label in the DOM.
           *
           * That matters because the control is the thing focus is restored to when the Settings dialog
           * closes, and `tests/e2e/a11yAudit.spec.ts`'s focus-restoration probe identifies the opener by
           * `aria-label` **or** by trimmed `textContent`. With only the glyph-plus-text, the probe reads
           * `"⚙ Settings"` and cannot match `"Settings"` - so a dialog that genuinely restored focus was
           * reported as one that did not.
           *
           * `aria-label` also fails nothing here: axe's `label-content-name-mismatch` requires the visible
           * text to be contained in the accessible name, and "Settings" is contained in "Settings". The same
           * treatment is deliberately **not** given to the Data launcher, whose probe is not part of any
           * dialog's focus-restoration contract, and giving it one would be an edit nobody asked for.
           */
          aria-label="Settings"
          style={{ fontSize: 11, opacity: 0.7 }}
        >
          <span aria-hidden="true">⚙</span> Settings
        </button>
      </div>
    </>
  );

  if (!collapsible) {
    return (
      <div className="village-hud-wrapper">
        <div
          className="village-hud ui-skin"
          data-theme={colorTheme}
          data-village-surface="side"
          role="region"
          aria-label="Village status and controls"
        >
          {column}
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="village-hud-toggle"
        onClick={toggleDrawer}
        aria-expanded={hudOpen}
        aria-controls={regionId}
        aria-label={hudOpen ? 'Close village status and controls' : 'Open village status and controls'}
        data-village-touch-target="hud-toggle"
        style={{ minWidth: '44px', minHeight: '44px' }}
      >
        <span aria-hidden="true">{hudOpen ? '✕' : '☰'}</span>
      </button>
      {/*
        The sheet is only in the tree while it is open. Unmounting rather than
        hiding means a closed drawer cannot be reached by Tab, cannot be read by a
        screen reader, and cannot be the stale thing `aria-controls` points at -
        and it means the focus trap's restore path runs exactly once, when the
        sheet closes, instead of being armed against an element that was never
        focusable.
      */}
      {hudOpen ? (
        <div
          ref={sheetRef}
          className="village-hud ui-skin village-hud--mobile village-hud--open"
          data-theme={colorTheme}
          data-village-surface="sheet"
          id={regionId}
          role="dialog"
          // The world stays live and operable behind the sheet, so this is not a
          // modal dialog and saying otherwise would make a screen reader hide the
          // world from the learner who just opened this.
          aria-modal={false}
          aria-label="Village status and controls"
          tabIndex={-1}
        >
          {column}
        </div>
      ) : null}
    </>
  );
}
