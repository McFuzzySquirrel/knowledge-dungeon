/**
 * The redesigned Archaeologist review workspace.
 *
 * ## What this workspace is organised around
 *
 * The pre-Phase-16 Archaeologist view was the room panel's `notes` tab with three
 * information cards *above* the notes and one button below them: "Archaeologist unlock:
 * k/N rooms cleared", "Review passes: n complete", "k/N rooms toward pass n" with a
 * progressbar, and a "Done reviewing" button whose only explanation was "Close this panel
 * when you are done reviewing to count the pass." The artifact was a separate, disabled-until-
 * unlocked tab. The self-check prompts were a fourth tab with a number at the bottom - "Reviewed
 * N time(s)" - and **no way to rate anything at all**, which is what
 * `src/data/gameGuide.ts` had been promising learners in the meantime.
 *
 * This workspace is organised around the phase's own scope line - *current artifact, recall
 * prompt, confidence or quality rating, next due date, current pass progress* - and adds the
 * one thing the scope line asks for and the old view could not express: **the interrupted
 * session**, because "Handle exit during an open review with a save, resume, or discard
 * decision" is a third scope line and it is a property of *arrival*, not of recalling.
 *
 * ## Why that order, and not another
 *
 * 1. **Where this review stands, first, and never collapsible.** It answers three questions
 *    in one block - can this room be reviewed at all, is there a review already half done
 *    here, and how far through the pass are we - and every one of them changes what the
 *    regions below are allowed to do. If it sat below the artifact, a learner who arrived at
 *    a locked dungeon would read a whole artifact before learning that none of it counts. It
 *    is also the only region with no toggle, for the reason the Scribe workspace gives: "where
 *    was I" is not optional.
 * 2. **The artifact second.** It is *the thing being reviewed*. Recalling something you have
 *    not read is not review, and the rating control is the only input to SM-2, so the
 *    artifact has to be on screen before the prompt that asks about it. It starts open.
 * 3. **Recall third.** The prompt and the rating, in one region, because they are one
 *    decision: the prompt is the question, the rating is the answer, and splitting them
 *    would put the answer on one side of a collapsed region boundary and the question on the
 *    other. The rating is the phase's reason to exist, so this region is open on arrival.
 * 4. **Schedule fourth, closed on arrival.** "When does this come back" is a consequence of
 *    the rating above it, and reading it before rating tells a learner a date that is about
 *    to change. It is one toggle away, and the next action names it once a rating exists.
 * 5. **Complete last, open on arrival.** Two reasons it is last and two reasons it is open.
 *    Last: completion is the only verb that awards, so it must not sit above the input it
 *    depends on - a learner who reads "Complete this pass" first has been told the rating is
 *    optional. Open: the refusal lives on that control, and a refusal a learner cannot see is
 *    the exact defect `StudyActionButton`'s header documents.
 *
 * ## The four rules this component holds itself to
 *
 * These are the Scribe workspace's rules, unchanged, because they are the workspace's rules:
 *
 * 1. **No dispatch leaves an event handler.** Every review command runs from
 *    {@link useReviewActions}, and every call site of it is an `onClick` or an `onChange`.
 *    The two effects below move focus and re-read the durable marker; neither dispatches.
 *    StrictMode re-runs effects; it does not re-fire clicks.
 * 2. **Presentation is the view model's.** {@link ReviewProgress} and {@link RecallCard}
 *    render `reviewViewModel.ts` and restate none of it. The pass numbers, the due
 *    discriminant, the unlock counts, and the refusal sentence all come from `@/core/review`;
 *    the *words* for the due states are the only sentences this surface owns, and they live
 *    in one function so there is one of them.
 * 3. **Every verb has a DOM route.** Rate, complete, save, resume, discard, and done are a
 *    radio group and five buttons in this tree. None needs a canvas, a drag, or a pointer, and
 *    every target is at least 44 by 44 through the shared inline style.
 * 4. **Nothing is written for the learner.** The rating is only ever set by an `onChange` of
 *    a rating radio, the region overrides only by a region toggle, and the focus request only
 *    by the next-action button. There is no code path that invents a rating, and the
 *    `Complete` control is disabled - with the reason in visible text - until the learner has
 *    answered. "Disabled until answered" is a claim about *this button*, and it is
 *    deliberately not advertised as a claim about the review: see
 *    {@link PANEL_CLOSE_COUNTS_AT} below for the other route out of this workspace, and why
 *    both routes say so out loud.
 *
 * ## The two routes out, and why every sentence here names both
 *
 * There are exactly two ways to finish a review in this phase, and they are not the same
 * number:
 *
 * - **This workspace's `Complete this review pass`**, which records the rating the learner
 *   picked and refuses to act until there is one.
 * - **Closing the room panel** - `closeInfoPanel` -> `finalizePendingReview` - which
 *   completes the same pass through {@link PANEL_CLOSE_COUNTS_AT}. That is a *real* SM-2
 *   rating of 3, not the absence of one, and it is applied whether or not a rating was chosen
 *   here: the chosen rating is local state in this component and never reaches the flow.
 *
 * So a disabled `Complete` button does not mean "this review cannot be completed yet", and
 * writing it as though it did was the defect this section exists to prevent: a learner who
 * read the refusal, decided a rating was overkill, and closed the panel got a recorded pass
 * they had been told was not available. Every sentence below that mentions either route -
 * the `Complete` region's description, the unrated refusal, both button descriptions - is
 * built from the one {@link PANEL_CLOSE_SENTENCE}, so the number cannot drift between them.
 *
 * ## Why this is not a dialog
 *
 * `ScribeEncounterDialog` is a dialog because its route into the application is
 * `studyFlowController.roomInteract`, which opens a modal over the dungeon. The review route
 * is different and was not changed by this phase: `roomInteract` opens the *room panel* on
 * the `notes` tab, which is an `<aside>` that was already on screen. Rendering this workspace
 * inside it keeps the panel-close route - `closeInfoPanel` -> `finalizePendingReview` - as the
 * way a review is finalised without an exit criterion, and it means the "done reviewing"
 * control here is that same route rather than a second one. Adding a dialog would have meant
 * a second review surface per room, which double-answers every question the panel already
 * answers.
 *
 * ## The rollback
 *
 * `RoomPanel` renders this workspace only when `runtimeConfig.archaeologistReviewWorkspace` is
 * `true`. With the flag off - the production default - the pre-Phase-16 `notes` tab renders,
 * unchanged, including the three progress cards, the note body, and the "Done reviewing"
 * button; `tests/phase16/review-rollback.test.tsx` pins that.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { deriveGraphHierarchy } from '@/core/graph';
import type { InterruptedReviewSession } from '@/core/review/interruptedReviewSession';
import type { QualityRating } from '@/core/review/spacedRepetition';
import type { RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';
import { CLOSED_WITHOUT_RATING_QUALITY } from '@/application/reviewCommands';

import { StudyActionButton } from '../StudyControls';
import { StudyShell, type StudyRegionSpec } from '../StudyShell';
import { ARCHAEOLOGIST_CONTROL_IDS, focusStudyControl } from '../controlIds';
import { Markdown } from '@/ui/utils/markdown';
import { RecallCard } from './RecallCard';
import { ReviewProgress } from './ReviewProgress';
import {
  buildReviewViewModel,
  resolveReviewNextAction,
  type ReviewNextStepKind,
} from './reviewViewModel';
import { REVIEW_COMMAND_SCOPES, useReviewActions } from './useReviewActions';
import { AssistanceSlot } from '@/ui/assistance/AssistanceSlot';
import './review.css';

/**
 * The rating the panel-close route records, as the learner is told it.
 *
 * Imported rather than written out, because `finalizePendingReview` in
 * `src/application/studyFlow.ts` passes exactly this value to `review/pass-complete` on
 * every panel close and a copy that spelled out a different number would be a lie the moment
 * that constant moved. It is read here as a value purely to render it.
 *
 * Note what it is not: it is *not* "no rating". It is a real rating of 3 - "Correct -
 * required serious mental effort" - which is written into SM-2 and moves the room's next
 * review date. The upstream constant is named `CLOSED_WITHOUT_RATING_QUALITY`, which says
 * *when* it applies instead of claiming the absence of a rating; the learner is told the
 * number, which is what is true, and the constant is another owner's file.
 */
const PANEL_CLOSE_COUNTS_AT = CLOSED_WITHOUT_RATING_QUALITY;

/**
 * The one sentence every mention of the panel-close route is built from.
 *
 * Unconditional on purpose: the flow applies {@link PANEL_CLOSE_COUNTS_AT} whether or not a
 * rating was chosen in {@link RecallCard}, so a conditional wording - "counts this pass if
 * you rated it" - was false in both directions. It did not award the pass when a rating was
 * absent, and it did not use the rating when one was present.
 */
const PANEL_CLOSE_SENTENCE = `Closing the room panel counts this pass at a rating of ${PANEL_CLOSE_COUNTS_AT}, whatever you picked here.`;

/**
 * The regions, in the order the header above argues for.
 *
 * Static vocabulary. These strings reach the DOM as `data-study-region`, which tests read
 * and issue reports quote, so nothing here is a room id, a topic, or any other value a
 * learner can type.
 */
type ArchaeologistRegionId = 'standing' | 'artifact' | 'recall' | 'schedule' | 'complete';

/**
 * Which region holds each focusable control a next action can target.
 *
 * Opening the region before the focus lands is what stops a next action from focusing a
 * `hidden` element, which the browser drops silently and which a keyboard user reads as a
 * button that does nothing. This is the Scribe workspace's map, over the review controls.
 */
const CONTROL_REGION: Readonly<Record<string, ArchaeologistRegionId>> = Object.freeze({
  [ARCHAEOLOGIST_CONTROL_IDS.arrival]: 'standing',
  [ARCHAEOLOGIST_CONTROL_IDS.passComplete]: 'complete',
  [ARCHAEOLOGIST_CONTROL_IDS.progress]: 'schedule',
  [ARCHAEOLOGIST_CONTROL_IDS.qualityRating]: 'recall',
  [ARCHAEOLOGIST_CONTROL_IDS.sessionDiscard]: 'standing',
  [ARCHAEOLOGIST_CONTROL_IDS.sessionResume]: 'standing',
});

/**
 * The control each next step moves focus to.
 *
 * A locked room's step and the "no artifact" step deliberately name a control that already
 * exists and is already open - the arrival block for the first, the prompts block for the
 * second - because the learner needs to *read* the sentence that explains the block, and
 * pointing focus at the one screen reader would otherwise skip is what makes them read it.
 */
const NEXT_STEP_CONTROL: Readonly<Record<ReviewNextStepKind, string>> = Object.freeze({
  'already-reviewed': ARCHAEOLOGIST_CONTROL_IDS.passComplete,
  locked: ARCHAEOLOGIST_CONTROL_IDS.arrival,
  'no-artifact': ARCHAEOLOGIST_CONTROL_IDS.recallPrompts,
  'no-prompts': ARCHAEOLOGIST_CONTROL_IDS.qualityRating,
  'rate-recall': ARCHAEOLOGIST_CONTROL_IDS.qualityRating,
  resume: ARCHAEOLOGIST_CONTROL_IDS.sessionResume,
});

/**
 * Regions that start open.
 *
 * `standing`, `artifact`, `recall`, and `complete` are open; `schedule` is closed because its
 * answer changes the moment a rating is given. `standing` is listed even though it has no
 * toggle, because `expanded` is also what the shell reads before deciding whether the body is
 * hidden, and a region reported as collapsed while rendering open is a small lie that makes a
 * later refactor introduce a real one.
 */
const OPEN_BY_DEFAULT: readonly ArchaeologistRegionId[] = [
  'standing',
  'artifact',
  'recall',
  'complete',
];

export interface ArchaeologistWorkspaceProps {
  /** The room under review. */
  readonly room: RoomMetadata | null;
  readonly snapshot: SubjectSnapshot;
  /**
   * The durable interrupted-review marker, or `null`.
   *
   * A value rather than a getter: it is re-read on every render from the same preserved-field
   * carrier `flow.readPendingReviewSession()` reads, and passing the record rather than a
   * function is what lets the workspace react to a discard the moment it happens.
   */
  readonly pendingSession: InterruptedReviewSession | null;
  /**
   * The wall clock, in ISO form.
   *
   * Injected for the same reason `reviewCommands.ts` injects `nowIso`: "due today" is
   * untestable against a real clock, and the due state is the one part of this workspace that
   * must not be stale.
   */
  readonly nowIso: string;
  /** Device-local image resolution, so an artifact's images preview. */
  readonly resolveLocalImage: (attachmentId: string) => string | null;
  /** Re-enter the saved review, through the flow so the close route can still finalize it. */
  readonly onResumeReview: (roomId: string) => boolean;
  /** Abandon the saved review. Awards nothing. */
  readonly onDiscardReview: (roomId: string) => boolean;
  /** Close the room panel, which finalizes the review through `closeInfoPanel`. */
  readonly onClose: () => void;
}

export function ArchaeologistWorkspace({
  room,
  snapshot,
  pendingSession,
  nowIso,
  resolveLocalImage,
  onResumeReview,
  onDiscardReview,
  onClose,
}: ArchaeologistWorkspaceProps): ReactNode {
  const actions = useReviewActions();
  const roomId = room?.roomId ?? null;

  /*
   * The rating lives in this component, not in the store and not in the flow.
   *
   * It is a decision the learner has made *in this surface* and has not submitted yet, so it
   * is local state with exactly one writer - the rating radio's `onChange`. Persisting it
   * before submission would mean the SM-2 schedule could be derived from a choice the learner
   * then changed, and writing it into `room` would mean a draft rating was indistinguishable
   * from a reviewed one.
   */
  const [rating, setRating] = useState<QualityRating | null>(null);
  const [regionOverrides, setRegionOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [focusProblem, setFocusProblem] = useState<string | null>(null);

  /*
   * Clear the rating when the room changes, and only then.
   *
   * A ref rather than a `roomId` dependency, because `room` is a new object on every store
   * commit: keying the reset on identity would throw away the learner's chosen rating the
   * moment their own completion landed. The ref guards the second pass of a StrictMode
   * double-invoke, and it dispatches nothing.
   */
  const seededRoomId = useRef<string | null>(null);
  useEffect(() => {
    if (seededRoomId.current === roomId) return;
    seededRoomId.current = roomId;
    setRating(null);
    setRegionOverrides({});
  }, [roomId]);

  const model = useMemo(
    () =>
      buildReviewViewModel({
        room,
        snapshot,
        nowIso,
        rating,
        pendingSession,
      }),
    [nowIso, pendingSession, rating, room, snapshot],
  );

  const nextAction = resolveReviewNextAction(model);

  /*
   * Where this room is, in the shell header's two facts.
   *
   * `breadcrumb: []` and `floor: subjectName` were both placeholders that read as answers.
   * `StudyShell` renders an empty path as "no room is under review here", so every learner
   * reviewing a room three floors down was told, inside this workspace, that there was no
   * room; and the subject's name is a perfectly reasonable *Subject* row and a false *Floor*
   * row. Both are derived here from `snapshot.dungeon` by the same `deriveGraphHierarchy`
   * call, and with the same `?? snapshot.dungeon.subjectName` fallback, that
   * `ScribeEncounter` has always used - so this surface and the Scribe surface cannot
   * answer "which floor am I on" differently.
   *
   * **Derived here rather than passed in from `RoomPanel`, and that is a deliberate choice.**
   * `RoomPanel` does already hold a `hierarchy` and a `currentFloorLabel` for the focused
   * room, so passing those down would also have guaranteed agreement - and it would have
   * guaranteed it the wrong way. The workspace's own `room` prop is the authority for *which*
   * room is under review; a precomputed label belonging to some other room, beside a
   * `room` prop naming this one, is precisely how the two would begin to disagree. It would
   * also make the props impossible to omit honestly: a caller that forgets one gets a
   * fallback, and the natural fallback is the subject name, which is the original lie.
   * One pure function over one snapshot cannot disagree with itself.
   *
   * `roomId === null` is answered in words rather than by a plausible-looking stand-in.
   * There is no floor to name and no path to trace, so both rows say so; the subject name
   * under `<dt>Floor</dt>` would be a second false claim in the same block.
   */
  const hierarchy = useMemo(() => deriveGraphHierarchy(snapshot.dungeon), [snapshot.dungeon]);
  const floorLabel =
    roomId === null
      ? 'No room is under review here, so there is no floor.'
      : (hierarchy.floorLabelByFloorId[hierarchy.floorIdByRoomId[roomId]] ??
        snapshot.dungeon.subjectName);
  const breadcrumb =
    roomId === null
      ? []
      : (hierarchy.breadcrumbRoomIdsByRoomId[roomId] ?? []).map(
          (id) => snapshot.rooms[id]?.topic ?? '',
        );

  const isExpanded = useCallback(
    (regionId: ArchaeologistRegionId): boolean =>
      regionOverrides[regionId] ?? OPEN_BY_DEFAULT.includes(regionId),
    [regionOverrides],
  );
  const toggleRegion = useCallback(
    (regionId: ArchaeologistRegionId): void => {
      setRegionOverrides((current) => ({ ...current, [regionId]: !isExpanded(regionId) }));
    },
    [isExpanded],
  );

  /** Send focus to a control, opening its region first. */
  const requestFocus = useCallback((controlId: string): void => {
    const regionId = CONTROL_REGION[controlId];
    if (regionId !== undefined) {
      setRegionOverrides((current) => ({ ...current, [regionId]: true }));
    }
    setFocusProblem(null);
    setFocusRequest((current) => ({ id: controlId, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  /*
   * Focus only. This effect is presentation - the Scribe workspace has the same one - and it
   * runs when a *button* asks for it, not on mount. That is why no review command can be
   * reached from here.
   */
  useEffect(() => {
    if (focusRequest === null) return;
    const moved = focusStudyControl(focusRequest.id);
    setFocusProblem(
      moved
        ? null
        : 'That step needs a control that is not on screen. Open the region that holds it and try again.',
    );
  }, [focusRequest]);

  const completing = actions.isPending(REVIEW_COMMAND_SCOPES.passComplete);
  const saving = actions.isPending(REVIEW_COMMAND_SCOPES.sessionSave);
  const discarding = actions.isPending(REVIEW_COMMAND_SCOPES.sessionDiscard);
  const resuming = actions.isPending(REVIEW_COMMAND_SCOPES.sessionResume);

  /*
   * The completion refusal, as one sentence, decided before the JSX.
   *
   * `StudyActionButton` takes the reason as the parameter that both disables the control and
   * renders the sentence, so there is no way to produce one without the other. The order is
   * what blocks: a locked room before an unrated room, because a learner who is told "pick a
   * rating" on a locked room would be told to do something that still does not work.
   */
  const completionRefusal = !model.access.allowed
    ? (model.access.refusal ??
      'Clear the remaining room encounters before this room can count toward a review pass.')
    : rating === null
      ? `Pick how well you recalled this room before completing the pass, because your rating is what schedules the next review. ${PANEL_CLOSE_SENTENCE}`
      : null;

  const regionContent: Readonly<Record<ArchaeologistRegionId, ReactNode>> = {
    standing: (
      <div id={ARCHAEOLOGIST_CONTROL_IDS.arrival} tabIndex={-1} className="archaeologist-standing">
        <p className="archaeologist-standing__headline">{model.arrival.headline}</p>
        <ul className="archaeologist-facts">
          <li className="archaeologist-fact">{model.access.unlockSentence}</li>
          <li className="archaeologist-fact">
            {model.access.allowed
              ? 'Review is unlocked, so this room counts toward a pass.'
              : 'Review is locked, so nothing on this room counts toward a pass yet.'}
          </li>
          {model.arrival.passNumber === null ? null : (
            <li className="archaeologist-fact">
              Saved review was started in pass {model.arrival.passNumber}.
            </li>
          )}
        </ul>
        {/*
          * Resume and discard appear only when there is a marker for *this* room, because a
          * control whose only possible outcome is "nothing changed" is worse than no control.
          * When the marker names another room, the headline above already says so.
        */}
        {model.arrival.resumable && roomId !== null ? (
          <div className="archaeologist-standing__actions">
            <StudyActionButton
              id={ARCHAEOLOGIST_CONTROL_IDS.sessionResume}
              label="Pick this review back up"
              description="Re-opens the saved review for this room. It awards nothing on its own."
              touchTarget="review-session-resume"
              tone="primary"
              pending={resuming}
              pendingLabel="Picking it back up…"
              onClick={() => {
                /*
                 * Both calls, in this order, and both from this handler.
                 *
                 * `onResumeReview` is `flow.resumePendingReview`, which re-arms the
                 * in-memory pending-review lane as well as reporting the marker - that arming
                 * is what makes the panel-close route able to finalize this review later, so
                 * it is not optional bookkeeping. `actions.sessionResume` then asks the same
                 * question through the command layer for the sentence the shell announces, and
                 * `review/session-resume` is read-only, so running both costs one record read
                 * and no second mutation.
                 */
                onResumeReview(roomId);
                actions.sessionResume({ roomId });
              }}
            />
            <StudyActionButton
              id={ARCHAEOLOGIST_CONTROL_IDS.sessionDiscard}
              label="Discard the saved review"
              description="Abandons it. Nothing is awarded and the pass does not count."
              touchTarget="review-session-discard"
              tone="danger"
              pending={discarding}
              pendingLabel="Discarding…"
              onClick={() => {
                /*
                 * `onDiscardReview` is `flow.discardPendingReview`, which clears the in-memory
                 * arm *and* the durable marker; `actions.sessionDiscard` asks the same
                 * question through the command layer for the sentence the shell announces.
                 * Calling only the second would leave `pendingReviewRoomId` set in the flow,
                 * and the next panel close would finalize a review the learner just abandoned.
                 */
                onDiscardReview(roomId);
                actions.sessionDiscard({ roomId });
              }}
            />
          </div>
        ) : null}
      </div>
    ),
    artifact: (
      <div className="archaeologist-artifact">
        <p className="archaeologist-hint">
          {model.facts.hasArtifact
            ? 'This is the artifact you are reviewing. Read it before you answer the recall prompt below.'
            : 'This room has not written an artifact yet, so there is nothing to review here. Defeat its encounter in the Scribe phase, then come back.'}
        </p>
        {model.facts.artifactMarkdown === null ? null : (
          <div className="markdown-body archaeologist-artifact__body" aria-label="Room artifact under review">
            <Markdown source={model.facts.artifactMarkdown} resolveLocalImage={resolveLocalImage} />
          </div>
        )}
      </div>
    ),
    recall: (
      <RecallCard
        prompts={model.prompts}
        rating={rating}
        onRatingChange={setRating}
        busy={completing || saving}
      />
    ),
    schedule: (
      <ReviewProgress
        pass={model.pass}
        due={model.due}
        roomReviewPassCount={model.facts.reviewPassCount}
        reviewedInCurrentPass={model.facts.reviewedInCurrentPass}
      />
    ),
    complete: (
      <div className="archaeologist-complete">
        {/*
          * Saving is *offered* unconditionally rather than gated on dirtiness, and that is the
          * honest choice: the durable marker is already written when `roomInteract` armed the
          * review, so "save" here re-writes it with the rating the learner has chosen and
          * refreshes `savedAt`. Whether there is anything to save is a question about a
          * durable record the learner does not see, so the button says what it does instead
          * of hiding behind a condition they cannot evaluate.
        */}
        <StudyActionButton
          id={ARCHAEOLOGIST_CONTROL_IDS.sessionSave}
          label="Save and finish later"
          description="Parks this review with your rating so you can pick it up after a reload or a walk out of the dungeon. Nothing is awarded."
          touchTarget="review-session-save"
          pending={saving}
          pendingLabel="Saving…"
          onClick={() => {
            if (roomId === null) return;
            actions.sessionSave({ roomId, qualityRating: rating });
          }}
        />
        <StudyActionButton
          id={ARCHAEOLOGIST_CONTROL_IDS.passComplete}
          label="Complete this review pass"
          description={`Counts this room toward the current pass and schedules its next review from your rating. ${PANEL_CLOSE_SENTENCE}`}
          touchTarget="review-pass-complete"
          tone="primary"
          pending={completing}
          pendingLabel="Recording…"
          refusal={completionRefusal}
          onClick={() => {
            if (roomId === null || rating === null) return;
            actions.passComplete({ roomId, qualityRating: rating });
          }}
        />
      </div>
    ),
  };

  const regionMeta: Readonly<
    Record<ArchaeologistRegionId, { title: string; description: string; collapsible: boolean }>
  > = {
    standing: {
      title: 'Where this review stands',
      description:
        'Whether this room can be reviewed, whether a review is waiting to be picked up, and how far through the pass you are.',
      collapsible: false,
    },
    artifact: {
      title: 'The artifact under review',
      description: 'What defeating this encounter wrote, which is the thing being recalled.',
      collapsible: true,
    },
    recall: {
      title: 'Recall',
      description: 'Answer the prompt out loud, then rate how well you actually recalled it.',
      collapsible: true,
    },
    schedule: {
      title: 'Schedule',
      description: 'When this room comes back, and how far through the current pass the dungeon is.',
      collapsible: true,
    },
    complete: {
      title: 'Complete',
      description: `Count this pass at the rating you pick, park it for later, or close the panel, which counts it at a rating of ${PANEL_CLOSE_COUNTS_AT}.`,
      collapsible: true,
    },
  };

  const regions: StudyRegionSpec[] = (
    ['standing', 'artifact', 'recall', 'schedule', 'complete'] as const
  ).map((regionId) => {
    const meta = regionMeta[regionId];
    return {
      id: regionId,
      title: meta.title,
      description: meta.description,
      expanded: isExpanded(regionId),
      // No `onToggle` for `standing`: the shell renders no toggle without a handler, which is
      // exactly right - a control that opens nothing cannot exist.
      onToggle: meta.collapsible ? () => toggleRegion(regionId) : undefined,
      children: regionContent[regionId],
    };
  });

  return (
    <StudyShell
      phase="archaeologist"
      subjectName={snapshot.dungeon.subjectName}
      context={{
        topic: model.topic === '' ? 'No room is under review.' : model.topic,
        status: model.status,
        floor: floorLabel,
        breadcrumb,
      }}
      regions={regions}
      nextAction={
        nextAction === null
          ? null
          : {
              id: `review-${nextAction.kind}`,
              label: nextAction.label,
              detail: nextAction.detail,
              action: (
                <StudyActionButton
                  label={`Go to: ${nextAction.label}`}
                  tone="primary"
                  touchTarget={`next-action-review-${nextAction.kind}`}
                  onClick={() => requestFocus(NEXT_STEP_CONTROL[nextAction.kind])}
                />
              ),
            }
      }
      feedback={actions.feedback}
      label="Archaeologist review workspace"
    >
      {/*
        Phase 19: the review card, and the `device` card with it.

        Two surfaces render here, and the reason is the engine's own vocabulary rather than a
        taste decision. `archaeologist.due-room` and `archaeologist.low-recall` are about the
        room under review; `device.due-today` is about reviews waiting across the whole subject,
        and the review surface is where a learner goes to decide what to review next. The `device`
        suggestion is therefore rendered *on this surface, filtered to it* rather than in a fifth
        card somewhere else.

        Two slots rather than one combined slot, because the filter is the engine's `surface`
        field and merging them would mean a card showing a room suggestion and a device suggestion
        under one heading that named neither.

        First child, so both sit after the review's own next action and never above it.
      */}
      <AssistanceSlot surface="archaeologist" snapshot={snapshot} />
      <AssistanceSlot surface="device" snapshot={snapshot} />
      {/*
        * The focus fallback is visible text and *not* a second live region. The shell owns
        * exactly one `role="status"`, and adding another here would make a learner hear two
        * announcements for one action - which is the defect plan 10.1 is about.
      */}
      {focusProblem === null ? null : (
        <p className="archaeologist-hint archaeologist-hint--problem">{focusProblem}</p>
      )}
      {/*
        * The panel-close route, spelled out as a control of its own rather than left to the
        * panel's header button. `closeInfoPanel` is what finalizes a deferred review, so this
        * is the same route as the panel's own "Close review" - not a second finalization
        * path, and not a duplicate answer, because `RoomPanel` renders its header tabs
        * whatever the flag says and this is the body of one of them.
      */}
      <div className="archaeologist-close">
        <StudyActionButton
          id={ARCHAEOLOGIST_CONTROL_IDS.close}
          label="Done reviewing"
          description={`Closes the room panel, which counts this pass at a rating of ${PANEL_CLOSE_COUNTS_AT}.`}
          touchTarget="review-close"
          onClick={onClose}
        />
      </div>
    </StudyShell>
  );
}