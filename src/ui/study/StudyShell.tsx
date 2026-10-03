/**
 * The shared, phase-aware study shell.
 *
 * ## Why this is not "the Creator shell"
 *
 * Phase 14 delivers a Creator workspace; Phases 15 and 16 deliver a Scribe encounter
 * workspace and an Archaeologist review workspace. All three answer the same four
 * questions of a learner who has arrived somewhere with work to do - *where am I, what
 * is around me, what does the structure look like, what do I do next* - and all three
 * have to satisfy the same rules: a live status sentence, a refusal that is visible
 * where the control that refused is, 44-pixel targets, and reduced motion honoured.
 *
 * So this module holds only that shape, and nothing Creator-specific:
 *
 * - `phase` selects a label and a one-sentence purpose. It does not select behaviour.
 *   Adding a fourth phase is a new entry in {@link STUDY_PHASE_LABELS}, not a new
 *   branch through the shell.
 * - `regions` is an ordered list of titled, independently collapsible sections. The
 *   order is the caller's, which is how a later phase expresses its own prominence.
 * - `nextAction` is an optional region of its own, positioned by the caller, because
 *   "what do I do next" is a different kind of answer from "what is around me".
 * - `feedback` is the live status/refusal channel. One region, `role="status"`, and
 *   the refusal text is rendered as text a learner can read with the control it
 *   belongs to - never as a colour and never only as an `aria-describedby` target.
 *
 * ## What this module deliberately does not do
 *
 * It imports no store, no renderer, and no domain mutation. It receives data and
 * renders it. `tests/phase14/study-shell-boundary.test.ts` holds the boundary: no
 * Phaser, no Pixi, no `src/game`, no `src/renderers` anywhere under `src/ui/study/**`.
 *
 * That file was authored in **Phase 15**, for a boundary Phase 14 asserted in this
 * comment and never tested. It now also covers `src/ui/study/scribe/**`, which Phase 15
 * added under the same unenforced claim. The path was kept as written above so the
 * claim and the gate finally name the same thing.
 */
import type { ReactNode } from 'react';

import type { GamePhase } from '@/store/sessionStore';

import './study.css';

/** The phase names the shell renders, with the one sentence that names the job. */
export const STUDY_PHASE_LABELS: Readonly<Record<GamePhase, { label: string; purpose: string }>> =
  Object.freeze({
    creator: {
      label: 'Creator',
      purpose: 'Shape the subject map: the current topic, what is related to it, and the graph around it.',
    },
    scribe: {
      label: 'Scribe',
      purpose: 'Write this room up: draft the note, check it, and confirm it by hand.',
    },
    archaeologist: {
      label: 'Archaeologist',
      purpose: 'Revisit cleared rooms, read the artifact, and count a review pass.',
    },
  });

/** The attribute every region writes, so a test can read the order the shell rendered. */
export const STUDY_REGION_ATTRIBUTE = 'data-study-region';

/** The attribute the shell writes its phase to. Static vocabulary, never a learner value. */
export const STUDY_PHASE_ATTRIBUTE = 'data-study-phase';

export interface StudyRegionSpec {
  /**
   * Stable identifier for the region.
   *
   * Static vocabulary (`'current-topic'`, `'graph-structure'`, ...), written to
   * {@link STUDY_REGION_ATTRIBUTE}. It is never a room id, a topic, or any other
   * learner value: DOM attributes are read by tests and pasted into issue reports.
   */
  readonly id: string;
  /** The region's visible heading. */
  readonly title: string;
  /** One sentence under the heading, or nothing. */
  readonly description?: string;
  /** Whether the region starts open. */
  readonly expanded: boolean;
  /**
   * Collapse/expand handler.
   *
   * Omit it for a region that is always open: {@link StudyRegion} renders no toggle
   * without one, so a control that opens nothing cannot exist.
   */
  readonly onToggle?: () => void;
  /** The region's body. */
  readonly children: ReactNode;
}

export interface StudyContextSummary {
  /** The topic the workspace is currently about. */
  readonly topic: string;
  /** That room's state, in words. */
  readonly status: string;
  /** Which floor of the dungeon it sits on. */
  readonly floor: string;
  /** Ancestor topics, root first. Empty for the root room. */
  readonly breadcrumb: readonly string[];
}

/** The recommended next step, rendered as its own region. */
export interface StudyNextActionSpec {
  /** Static identifier, used as a DOM id suffix and in tests. */
  readonly id: string;
  /** The heading: what to do. */
  readonly label: string;
  /** Why that is the next step, in one sentence. */
  readonly detail: string;
  /** The control that performs it, when the step is one button. */
  readonly action?: ReactNode;
}

export type StudyFeedbackTone = 'progress' | 'done' | 'refusal';

export interface StudyFeedback {
  readonly tone: StudyFeedbackTone;
  /**
   * The sentence.
   *
   * For a refusal this is the graph domain's own message, passed through verbatim -
   * the shell never restates a domain error, so it cannot drift from the wording the
   * domain already uses everywhere else.
   */
  readonly message: string;
}

export interface StudyShellProps {
  readonly phase: GamePhase;
  readonly subjectName: string;
  /**
   * Which archetype is playing, and how its tools are arranged.
   *
   * A sentence, not a claim: it is built from the same plan that decides the region
   * order and the primary next action, so the words cannot promise a prominence the
   * layout does not deliver.
   */
  readonly archetypeNote?: string;
  readonly context: StudyContextSummary;
  /** Ordered, collapsible regions. The order is the caller's prominence decision. */
  readonly regions: readonly StudyRegionSpec[];
  readonly nextAction?: StudyNextActionSpec | null;
  /** Where the next-action region sits relative to the tool regions. */
  readonly nextActionPlacement?: 'before-regions' | 'after-regions';
  readonly feedback?: StudyFeedback | null;
  /** Anything that is not a region - a footer sentence, for instance. */
  readonly children?: ReactNode;
  /** Accessible name of the workspace landmark. */
  readonly label?: string;
}

const FEEDBACK_PREFIX: Readonly<Record<StudyFeedbackTone, string>> = Object.freeze({
  progress: 'Working:',
  done: 'Done:',
  refusal: 'Not applied:',
});

/**
 * Render the workspace frame.
 *
 * Deliberately a plain composition: no `useState`, no effects, no data fetching. Every
 * piece of behaviour a workspace needs belongs to the workspace that owns it, which is
 * what lets Phases 15 and 16 reuse this without inheriting a Creator rule.
 */
export function StudyShell({
  phase,
  subjectName,
  archetypeNote,
  context,
  regions,
  nextAction,
  nextActionPlacement = 'after-regions',
  feedback = null,
  children,
  label = 'Study workspace',
}: StudyShellProps): ReactNode {
  const phaseLabel = STUDY_PHASE_LABELS[phase];
  const feedbackTone = feedback?.tone ?? 'progress';
  const feedbackText =
    feedback === null ? '' : `${FEEDBACK_PREFIX[feedbackTone]} ${feedback.message}`;

  const nextActionRegion =
    nextAction == null ? null : (
      <section className="study-next-action" aria-labelledby={`study-next-action-${nextAction.id}`}>
        <h3 id={`study-next-action-${nextAction.id}`} className="study-next-action__label">
          Next: {nextAction.label}
        </h3>
        <p className="study-next-action__detail">{nextAction.detail}</p>
        {nextAction.action == null ? null : (
          <div className="study-next-action__action">{nextAction.action}</div>
        )}
      </section>
    );

  return (
    <section
      className="study-shell"
      {...{ [STUDY_PHASE_ATTRIBUTE]: phase }}
      aria-label={label}
      data-study-shell={phase}
    >
      <header className="study-shell__header">
        <p className="study-shell__phase">
          <span className="study-shell__phase-name">{phaseLabel.label}</span>
          <span className="study-shell__phase-purpose">{phaseLabel.purpose}</span>
        </p>
        <h2 className="study-shell__topic">{context.topic}</h2>
        <dl className="study-shell__context">
          <div className="study-shell__context-row">
            <dt>Subject</dt>
            <dd>{subjectName}</dd>
          </div>
          <div className="study-shell__context-row">
            <dt>Status</dt>
            <dd>{context.status}</dd>
          </div>
          <div className="study-shell__context-row">
            <dt>Floor</dt>
            <dd>{context.floor}</dd>
          </div>
          <div className="study-shell__context-row">
            <dt>Path</dt>
            <dd>{context.breadcrumb.length === 0 ? 'This is the root topic.' : context.breadcrumb.join(' → ')}</dd>
          </div>
        </dl>
        {archetypeNote == null ? null : (
          <p className="study-shell__archetype">{archetypeNote}</p>
        )}
      </header>

      {/*
        The live channel. `role="status"` rather than `role="alert"` because a refused
        mutation is an expected outcome of a form, not an emergency, and an assertive
        region would interrupt a learner mid-sentence for every duplicate tag.
      */}
      <p
        className={`study-feedback study-feedback--${feedbackTone}`}
        role="status"
        aria-live="polite"
        data-study-feedback={feedback === null ? undefined : feedbackTone}
      >
        {feedbackText}
      </p>

      {nextActionPlacement === 'before-regions' ? nextActionRegion : null}

      {regions.map((region) => (
        <StudyRegion key={region.id} {...region} />
      ))}

      {nextActionPlacement === 'after-regions' ? nextActionRegion : null}

      {children}
    </section>
  );
}

export interface StudyRegionProps extends StudyRegionSpec {
  /**
   * Whether the region may be collapsed at all.
   *
   * The toggle is rendered only when this is `true` **and** an {@link StudyRegionSpec.onToggle}
   * handler was supplied: a toggle with no handler is a control that opens nothing, which is
   * worse than no control at all.
   */
  readonly collapsible?: boolean;
  /** Id of the region's body, so the toggle can point `aria-controls` at it. */
  readonly bodyId?: string;
  /** Extra class names for the section. */
  readonly className?: string;
}

/**
 * One titled region.
 *
 * A `<section>` with an accessible name, so a screen-reader user can jump between the
 * parts of the workspace by region instead of reading it linearly. Collapsing uses the
 * `hidden` attribute rather than a class, because `hidden` is what removes the subtree
 * from the accessibility tree and from Tab order at the same time - a visually
 * collapsed region that is still focusable is the defect plan section 10.1 is about.
 */
export function StudyRegion({
  id,
  title,
  description,
  expanded,
  children,
  onToggle,
  collapsible = true,
  bodyId,
  className,
}: StudyRegionProps): ReactNode {
  const headingId = `study-region-${id}-heading`;
  const resolvedBodyId = bodyId ?? `study-region-${id}-body`;
  const canCollapse = collapsible && onToggle !== undefined;

  return (
    <section
      className={`study-region${className == null ? '' : ` ${className}`}`}
      aria-labelledby={headingId}
      {...{ [STUDY_REGION_ATTRIBUTE]: id }}
    >
      <div className="study-region__header">
        <h3 id={headingId} className="study-region__title">
          {title}
        </h3>
        {canCollapse ? (
          <button
            type="button"
            className="study-region__toggle"
            aria-expanded={expanded}
            aria-controls={resolvedBodyId}
            data-study-touch-target={`toggle-${id}`}
            style={{ minWidth: '44px', minHeight: '44px' }}
            onClick={onToggle}
          >
            {expanded ? `Hide ${title}` : `Show ${title}`}
          </button>
        ) : null}
      </div>
      {/*
        The description sits outside the collapsible body on purpose: it is the sentence
        that explains what the region is for, and hiding it behind a toggle would hide
        the explanation of the control that un-hides the rest.
      */}
      {description == null ? null : <p className="study-region__description">{description}</p>}
      <div id={resolvedBodyId} className="study-region__body" hidden={canCollapse && !expanded}>
        {children}
      </div>
    </section>
  );
}
