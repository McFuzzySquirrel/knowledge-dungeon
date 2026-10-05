/**
 * The suggestion card: the learner-facing half of Phase 19.
 *
 * ## This module is lazy-loaded, and that is a budget decision
 *
 * `check:budget:welcome` measures the assets `dist/index.html` names, and the Welcome closure
 * already holds every study workspace because `RoomPanel` and `GameScreen` are statically
 * reachable from the entry. An eager import of this card - and of the 1,532-line engine behind
 * it - would therefore be paid for by a learner who has never opened a subject. So
 * {@link AssistanceSlot} gates on the flag and the mode *before* anything dynamic is rendered,
 * and this module sits behind a `lazy()` that only evaluates once a suggestion actually exists.
 *
 * With the production default (`VITE_ADAPTIVE_ASSISTANCE=false`) nothing here is ever fetched.
 *
 * ## The rules this component holds itself to
 *
 * 1. **Nothing is dispatched from a suggestion.** The only handler is `onDismiss`, which the
 *    caller binds to `useAssistanceStore.getState().dismissSuggestion` - a counter increment and
 *    nothing else. A suggestion's `action` is **rendered as text and never called**:
 *    `core-logic-engineer` proved advisory-only structurally through the import graph, and a
 *    component that called a store writer from a suggestion click would invalidate that proof
 *    without changing a line of it. `tests/phase19/assistanceUiAdvisory.test.ts` re-walks the
 *    closure from this directory and fails on any writer.
 * 2. **No colour-only signalling.** Intensity is a word in the markup, published as a static
 *    attribute as well, and never as a tint on its own.
 * 3. **Dismiss is a real control.** A `<button>` with the house 44x44 floor, keyboard reachable,
 *    and carrying the suggestion's own title in its accessible name so a screen-reader user
 *    arriving at a list of "Dismiss" buttons can tell them apart.
 * 4. **Announcement is deliberate.** A newly appeared suggestion is announced through one
 *    `role="status"` region, written in an effect keyed on the count, and never on first render -
 *    see {@link AnnouncementRegion}.
 * 5. **Focus-trap behaviour is respected, not fought.** The card adds no `keydown` handler, no
 *    focus trap, and no `autofocus`. Inside `RoomPanel` or a dialog the card is ordinary flow
 *    content: the surrounding trap continues to decide where focus goes, and the card never
 *    steals it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  explainAssistanceSuggestion,
  rankAssistance,
} from '@/core/assistance/assistanceEngine';
import { toAssistanceSubjects } from '@/core/assistance/subjectInput';
import type {
  AssistanceExplanation,
  AssistanceMode,
  AssistanceSignals,
} from '@/core/assistance/types';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import type { SupportedLocale } from '@/i18n';

import { assistanceNowIso } from './assistanceClock';
import {
  assistanceEngineInputFor,
  buildAssistanceCardModel,
  type AssistanceCardModel,
  type AssistanceSurfaceFilter,
  type AssistanceSuggestionRow,
} from './assistanceCardModel';
import { ASSISTANCE_INTENSITY_COPY } from './assistanceCopy';
import {
  ASSISTANCE_COUNT_ATTRIBUTES,
  ASSISTANCE_IDS,
  ASSISTANCE_ID_ATTRIBUTE,
  ASSISTANCE_INTENSITY_ATTRIBUTE,
  ASSISTANCE_KIND_ATTRIBUTE,
  ASSISTANCE_REASON_ATTRIBUTE,
  ASSISTANCE_SCREEN_READER_ONLY_CLASS,
  ASSISTANCE_SURFACE_ATTRIBUTE,
} from './assistanceTestIds';
import type { AssistanceFishingFacts } from './AssistanceSlot';

import './assistance.css';

export interface AssistanceCardProps {
  /** Which surface rendered it, published as an attribute so a test can tell the four apart. */
  readonly surface: AssistanceSurfaceFilter;
  /** The subject snapshot the caller already holds. Converted here, never by a caller. */
  readonly snapshot: SubjectSnapshot | null;
  /** The fishing lane's facts, when this is the fishing surface. */
  readonly fishing: AssistanceFishingFacts | null;
  readonly mode: AssistanceMode;
  readonly signals: AssistanceSignals;
  readonly flagEnabled: boolean;
  readonly locale: SupportedLocale;
  /**
   * Dismiss a suggestion.
   *
   * A prop rather than a store read, so this module holds no store handle at all - the property
   * `tests/phase19/assistanceUiAdvisory.test.ts` asserts structurally.
   */
  readonly onDismiss: () => void;
}

/**
 * The card: run the engine, build the model, and render it - or render nothing.
 *
 * ## Where the clock is read, and why it is read once per render
 *
 * `nowIso` is read **once**, at the top of this render, into a local `const`, and handed to both
 * the ranking and the explanations. Two reasons, and the second is the Phase 17 lesson:
 *
 * - reading it twice could produce two different timestamps for one frame, so a suggestion could
 *   be ranked against one `nowIso` and explained against another;
 * - a value captured into a module constant, a `useState` initialiser, or a `useRef` would be
 *   correct for the frame that captured it and wrong for every frame after.
 *
 * A render-local `const` is scoped to exactly the frame that produced it, which is the property
 * the engine's determinism gate protects.
 */
export function AssistanceCard(props: AssistanceCardProps): ReactNode {
  const { surface, snapshot, fishing, mode, signals, flagEnabled, locale, onDismiss } = props;

  // Read during render, never stored. See the doc comment above.
  const nowIso = assistanceNowIso();

  const model = useMemo<AssistanceCardModel | null>(() => {
    const subjects = toAssistanceSubjects(snapshot === null ? [] : [snapshot]);
    const result = rankAssistance(
      assistanceEngineInputFor({
        mode,
        signals,
        subjects,
        nowIso,
        flagEnabled,
        ...(fishing === null ? {} : { fishing }),
      }),
    );

    // The engine's answer is filtered to this surface and localized by the model builder, which
    // returns `null` when there is nothing to show. `emptyReason` is deliberately not read here:
    // see `buildAssistanceCardModel`'s header for why testing the list is the safe condition.
    //
    // `AssistanceExplanationInput` takes no `fishing` - the fishing facts shape a *ranking*, and
    // the reason a fishing suggestion appeared is already in its `reasonCode`. Passing the
    // snapshot's evidence only is what the engine's own signature permits.
    const explanations = new Map<string, AssistanceExplanation>();
    for (const suggestion of result.suggestions) {
      explanations.set(
        suggestion.suggestionId,
        explainAssistanceSuggestion(suggestion, { signals, subjects, nowIso }),
      );
    }

    return buildAssistanceCardModel({
      locale,
      surface,
      flagEnabled,
      result,
      explanations,
      subjects,
    });
  }, [surface, snapshot, fishing, mode, signals, flagEnabled, locale, nowIso]);

  if (model === null) return null;
  return <SuggestionList model={model} surface={surface} onDismiss={onDismiss} />;
}

/**
 * The presentational half: the rows, their evidence, and the Dismiss control.
 *
 * Dismissal is **view-scoped**, and the reason is the store's own design rather than a
 * preference. `dismissSuggestion()` takes no argument, by design, so the store has nowhere to
 * keep a per-suggestion suppression key and dismissal cannot become punitive. What is left for
 * the DOM to hold is which rows are currently set aside, and that is presentation state:
 * `useState` here, lost on unmount, so re-opening the panel brings the suggestion back.
 */
function SuggestionList({
  model,
  surface,
  onDismiss,
}: {
  readonly model: AssistanceCardModel;
  readonly surface: AssistanceSurfaceFilter;
  readonly onDismiss: () => void;
}): ReactNode {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = model.suggestions.filter((row) => !dismissed.has(row.suggestionId));
  const hiddenCount = model.suggestions.length - visible.length;

  const dismiss = (row: AssistanceSuggestionRow): void => {
    onDismiss();
    setDismissed((previous) => new Set(previous).add(row.suggestionId));
  };

  const { locale } = model;
  return (
    <section
      className="assistance-card"
      aria-labelledby={`${ASSISTANCE_IDS.heading}-${surface}`}
      {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.card }}
      {...{ [ASSISTANCE_SURFACE_ATTRIBUTE]: surface }}
      {...{ [ASSISTANCE_COUNT_ATTRIBUTES.suggestions]: String(visible.length) }}
    >
      <h3 id={`${ASSISTANCE_IDS.heading}-${surface}`} className="assistance-card__heading">
        {model.heading}
      </h3>

      <AnnouncementRegion visibleCount={visible.length} locale={locale} />

      <ol className="assistance-card__list">
        {visible.map((row) => (
          <SuggestionRow
            key={row.suggestionId}
            row={row}
            locale={locale}
            model={model}
            onDismiss={() => dismiss(row)}
          />
        ))}
      </ol>

      {/*
        The dismissed-sentence block renders **only** when something is actually hidden, because
        it is the one piece of copy that would otherwise hint the feature exists. With nothing
        dismissed it is absent from the DOM entirely, not present and empty.
      */}
      {hiddenCount > 0 ? (
        <p
          className="assistance-card__dismissed"
          {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.dismissed }}
        >
          {model.dismissedLabel}
        </p>
      ) : null}

      <p
        className="assistance-card__note"
        {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.advisoryNote }}
      >
        {model.advisoryNote}
      </p>
    </section>
  );
}

/** One suggestion, as a list item wrapping its own article. */
function SuggestionRow({
  row,
  locale,
  model,
  onDismiss,
}: {
  readonly row: AssistanceSuggestionRow;
  readonly locale: SupportedLocale;
  readonly model: AssistanceCardModel;
  readonly onDismiss: () => void;
}): ReactNode {
  const headingId = `assistance-suggestion-${row.suggestionId}`;
  const evidenceId = `${headingId}-evidence`;
  return (
    <li
      className="assistance-suggestion"
      {...{ [ASSISTANCE_KIND_ATTRIBUTE]: row.kind }}
      {...{ [ASSISTANCE_REASON_ATTRIBUTE]: row.reasonCode }}
    >
      {/*
        An `<article>` per suggestion rather than a bare `<h4>` in the list item, so each
        suggestion is its own landmark with its own accessible name and a screen-reader user can
        navigate between them by article rather than by counting list items.
      */}
      <article className="assistance-suggestion__body" aria-labelledby={headingId}>
        <h4 id={headingId} className="assistance-suggestion__title">
          {row.title}
        </h4>
        <p className="assistance-suggestion__detail">{row.detail}</p>

        {/*
          Intensity is published three ways on purpose: as a word the learner reads, and as a
          static attribute for a test. No colour, and no colour-only difference between a gentle
          cue and a stronger one.
        */}
        <p
          className="assistance-suggestion__intensity"
          {...{ [ASSISTANCE_INTENSITY_ATTRIBUTE]: row.intensity }}
        >
          {ASSISTANCE_INTENSITY_COPY[row.intensity][locale]}
        </p>

        {/*
          Both numbers ride on the container that owns them and are written unconditionally, so
          `data-assistance-priority` cannot outlive the row it describes. The empty case is its
          own sentence rather than a bare `0`, because "no evidence rows" and "an evidence row
          worth zero" are different facts and a learner should not have to tell which is which.
        */}
        <section
          className="assistance-suggestion__evidence"
          aria-labelledby={evidenceId}
          {...{ [ASSISTANCE_COUNT_ATTRIBUTES.evidence]: String(row.evidence.length) }}
          {...{ [ASSISTANCE_COUNT_ATTRIBUTES.priority]: String(row.priority) }}
        >
          <h5 id={evidenceId} className="assistance-suggestion__evidence-heading">
            {model.whyHeading}
          </h5>
          {row.evidence.length === 0 ? (
            <p className="assistance-suggestion__evidence-empty">{EVIDENCE_EMPTY[locale]}</p>
          ) : (
            <ul className="assistance-suggestion__evidence-list">
              {row.evidence.map((entry) => (
                <li
                  key={`${entry.labelKey}-${entry.value}`}
                  className="assistance-suggestion__evidence-row"
                  data-assistance-evidence={entry.labelKey}
                >
                  {/* The count is its own text node, so a test reads a number, not a sentence. */}
                  <span className="assistance-suggestion__evidence-value">{entry.value}</span>
                  <span className="assistance-suggestion__evidence-label">{entry.label}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {row.offer === null ? null : (
          <p className="assistance-suggestion__offer">
            <span className="assistance-suggestion__offer-verb">{model.offerHeading}</span>{' '}
            {row.offer}
            {row.targetTopic === null ? null : (
              // The visible topic, never the room id: an id in a screenshot is both meaningless
              // to a learner and a pointer at one of their records.
              <span className="assistance-suggestion__offer-target"> ({row.targetTopic})</span>
            )}
          </p>
        )}

        <button
          type="button"
          className="assistance-suggestion__dismiss"
          // Inline rather than in the stylesheet, for the reason
          // `STUDY_TOUCH_TARGET_STYLE` records: jsdom computes no layout, so a stylesheet rule
          // is not assertable, and an inline floor survives a stylesheet that failed to load.
          style={{ minWidth: '44px', minHeight: '44px' }}
          // The suggestion's title is in the accessible name, so a learner tabbing through four
          // identical "Dismiss" buttons can hear which one each will set aside.
          aria-label={`${model.dismissLabel}: ${row.title}`}
          {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.dismiss }}
          data-assistance-touch-target="dismiss"
          onClick={onDismiss}
        >
          {model.dismissLabel}
        </button>
      </article>
    </li>
  );
}

/** The sentence for a suggestion the engine ranked but gave no evidence rows. */
const EVIDENCE_EMPTY: Readonly<Record<SupportedLocale, string>> = Object.freeze({
  en: 'The sentence above is the whole reason.',
  es: 'La frase de arriba es toda la razón.',
});

/**
 * The polite live region that announces newly appeared suggestions.
 *
 * Deliberate in four ways, each of which is a bug otherwise:
 *
 * - `role="status"`, not `role="alert"`. A card appearing as a side effect of opening a panel is
 *   not an emergency, and an assertive region would interrupt whatever the learner was doing.
 * - The text is **only** the count, so a screen reader announces "2 suggestions" rather than
 *   reading a paragraph the learner has not reached yet.
 * - The text is written in an effect keyed on the count, never during render. Writing during
 *   render fires on every parent re-render, and a parent re-render is not news.
 * - **The first frame does not announce.** The region is created together with the card, so
 *   announcing its first value would make every visit to a workspace speak - including a return
 *   visit where nothing changed. Only a later change speaks, which is what "newly appeared
 *   suggestions" means.
 */
function AnnouncementRegion({
  visibleCount,
  locale,
}: {
  readonly visibleCount: number;
  readonly locale: SupportedLocale;
}): ReactNode {
  const [announced, setAnnounced] = useState<number | null>(null);
  const previous = useRef(visibleCount);
  useEffect(() => {
    if (previous.current === visibleCount) return;
    previous.current = visibleCount;
    setAnnounced(visibleCount);
  }, [visibleCount]);
  return (
    <p
      className={ASSISTANCE_SCREEN_READER_ONLY_CLASS}
      role="status"
      {...{ [ASSISTANCE_ID_ATTRIBUTE]: ASSISTANCE_IDS.status }}
      data-assistance-announced={announced === null ? '' : String(announced)}
    >
      {announced === null ? '' : ANNOUNCE[locale](announced)}
    </p>
  );
}

/** The announcement sentence. A function per locale so the count is formatted, not concatenated. */
const ANNOUNCE: Readonly<Record<SupportedLocale, (count: number) => string>> = Object.freeze({
  en: (count) => `${count} suggestion${count === 1 ? '' : 's'}`,
  es: (count) => `${count} sugerencia${count === 1 ? '' : 's'}`,
});