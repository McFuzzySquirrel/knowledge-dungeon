/**
 * Renderer-neutral Archaeologist review view model.
 *
 * ## What this module does and does not decide
 *
 * It **arranges**. Every fact it reports was already decided somewhere else and is
 * carried here rather than recomputed, because a second derivation is a second answer:
 *
 * | Value | Comes from | Never re-derived here |
 * |-------|-----------|------------------------|
 * | `fullReviewPasses`, `nextPassTarget`, `roomsTowardNextPass`, `totalRooms`, `reviewedRoomIds` | `deriveReviewPassProgress` | yes - by arithmetic on `reviewPassCount` |
 * | `dueState` | `describeReviewDueState` | yes - by comparing ISO dates here |
 * | `unlock` counts and `refusal` sentence | `canReviewRoom`, `describeReviewRefusal` | yes - by re-deriving the completion ratio |
 * | recall prompts | `generateSelfCheckPrompts` | yes - by inventing prompt text |
 * | the 0-5 rating labels | `QUALITY_LABELS` / `QUALITY_SHORT_LABELS` | yes - by writing new SM-2 wording |
 *
 * The only sentences written here are the ones about *this surface*: what the pass
 * progress reads as, and what each due state is called in English. Both exist because no
 * domain function is their subject - `ReviewDueState` is a discriminant plus a number, and
 * a number is not something a learner can read.
 *
 * ## Why the due wording is here and not in `reviewPasses.ts`
 *
 * Adding `describeReviewDueLabel` to `@/core/review` would have been the tidier home, and
 * it was rejected for a reason worth stating: that module is renderer-neutral *domain*, and
 * "Overdue by 3 days" is a presentation string. `reviewPasses.ts`'s own header draws the
 * line ("inventing a fourth `never-scheduled` variant would put a presentation decision
 * ('new') in the domain"), and this stays on the presentation side of it. The *discriminant*
 * is the domain's; only the words are here.
 *
 * ## Why `nowIso` is injected
 *
 * The due state is relative to a clock, and a view model that read `Date.now()` would make
 * "due today" untestable and would make the same room report two different states in one
 * render. The caller supplies it, exactly as `reviewCommands.ts` supplies `nowIso` to its
 * commands.
 *
 * ## Totality
 *
 * Every function is total. A `null` room, a room the snapshot does not list, a room with no
 * SM-2 date, a room with no artifact, and a marker for a *different* room all produce a
 * defined result rather than throwing, because this module is called during a render that
 * can race a room removal.
 *
 * Plain TypeScript by construction: no React, no JSX, no DOM global, no store, no renderer.
 *
 * ## Privacy
 *
 * Nothing here logs. The only learner-authored string that appears in the output is the
 * artifact markdown, which the review is *about*, and the room's own topic, which the
 * workspace heading already shows. No value produced here is ever placed in an id, an
 * attribute, or a selector - the prompts carry a static `ordinal` rather than the domain's
 * `${roomId}:prompt:N` `promptId` so that even a React key is static vocabulary.
 */
import { deriveGraphHierarchy } from '@/core/graph';
import {
  canReviewRoom,
  currentReviewPassNumber,
  deriveReviewPassProgress,
  describeReviewDueState,
  describeReviewRefusal,
  extractMarkdownHeadings,
  generateSelfCheckPrompts,
  type ReviewDueState,
} from '@/core/review';
import type { InterruptedReviewSession } from '@/core/review/interruptedReviewSession';
import { QUALITY_SHORT_LABELS, type QualityRating } from '@/core/review/spacedRepetition';
import type { RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';

// ── Due wording ─────────────────────────────────────────────────────────────

/** How a due state reads to a learner, and why the number is absent from some of them. */
export type ReviewDueLabel = 'overdue' | 'due-today' | 'due-in' | 'not-scheduled';

/**
 * The word a due state is called by, and the whole sentence beside it.
 *
 * `overdue` and `due-today` are the two the plan forbids communicating by colour alone,
 * and both are a *different word* from `due-in` - not the same word with a fill changed -
 * so a screen-reader user and a greyscale print read the same distinction.
 *
 * The singular/plural is decided rather than left to a caller, because
 * `1 days overdue` is the kind of small lie that makes a learner doubt the number next to
 * it.
 */
export function reviewDueSentence(input: {
  readonly dueState: ReviewDueState;
  /** The room's stored SM-2 date, so "never scheduled" is distinguishable from "due now". */
  readonly hasSchedule: boolean;
}): { readonly label: ReviewDueLabel; readonly sentence: string } {
  if (!input.hasSchedule) {
    return {
      label: 'not-scheduled',
      sentence: 'Not scheduled yet. Reviewing this room sets its next date.',
    };
  }
  const { dueState } = input;
  if (dueState.kind === 'overdue') {
    return {
      label: 'overdue',
      sentence: dueState.days === 1 ? 'Overdue by 1 day.' : `Overdue by ${dueState.days} days.`,
    };
  }
  if (dueState.kind === 'due-today') {
    return { label: 'due-today', sentence: 'Due today.' };
  }
  return {
    label: 'due-in',
    sentence: dueState.days === 1 ? 'Due in 1 day.' : `Due in ${dueState.days} days.`,
  };
}

// ── Input ───────────────────────────────────────────────────────────────────

export interface ReviewViewModelInput {
  /** The room being reviewed, or `null` when there is none. */
  readonly room: RoomMetadata | null;
  /** The live subject snapshot. */
  readonly snapshot: SubjectSnapshot;
  /** The caller's clock. The only source of "now" in this module. */
  readonly nowIso: string;
  /** The rating the learner has chosen in this surface, or `null` for none. */
  readonly rating: QualityRating | null;
  /**
   * The durable interrupted-review marker, or `null`.
   *
   * Passed as data rather than read from a store, for the reason `scribeViewModel.ts` gives
   * for `collectedNoteIds`.
   */
  readonly pendingSession: InterruptedReviewSession | null;
}

// ── Sub-views ───────────────────────────────────────────────────────────────

/** One recall prompt, with a static ordinal instead of the domain's room-scoped id. */
export interface ReviewPromptRow {
  /** 1-based position. Static vocabulary, safe as a React key. */
  readonly ordinal: number;
  /** The prompt text, from `generateSelfCheckPrompts`. */
  readonly text: string;
}

/** Pass progress, as numbers and as the sentences a learner reads. */
export interface ReviewPassView {
  readonly fullPasses: number;
  /** `fullReviewPasses + 1`: the pass this room is being reviewed in. */
  readonly nextPassTarget: number;
  readonly roomsTowardNextPass: number;
  readonly totalRooms: number;
  /**
   * `roomsTowardNextPass` as a whole percentage, clamped to 0-100.
   *
   * `0` when there are no rooms, because an empty dungeon has no progress to show and a
   * division by zero would be `NaN` - which renders as the literal text `NaN%`.
   */
  readonly percent: number;
  /** The pass-number sentences, for the region that is not a progressbar. */
  readonly lines: readonly string[];
}

/** What this room's own schedule says. */
export interface ReviewDueView {
  readonly state: ReviewDueState;
  readonly label: ReviewDueLabel;
  /** The whole sentence, including the day count. */
  readonly sentence: string;
  /** The stored ISO date, or `null` when the room has never been scheduled. */
  readonly nextReviewDateIso: string | null;
}

/** Whether this room may be reviewed, and the domain's own sentence when it may not. */
export interface ReviewAccessView {
  readonly allowed: boolean;
  /** `describeReviewRefusal`'s sentence verbatim, or `null` when allowed. */
  readonly refusal: string | null;
  /** Cleared rooms over total rooms, in words. Never a colour. */
  readonly unlockSentence: string;
}

/** What this room has already accrued. */
export interface ReviewRoomFacts {
  readonly reviewPassCount: number;
  /** Whether this room's count has reached the pass currently being worked. */
  readonly reviewedInCurrentPass: boolean;
  readonly artifactMarkdown: string | null;
  readonly hasArtifact: boolean;
}

/** Arrival: is there an interrupted review, and is it this one? */
export interface ReviewArrivalView {
  /** A marker for **this** room exists. */
  readonly resumable: boolean;
  /** A marker for some other room exists, so this room's review starts fresh. */
  readonly waitingForOtherRoom: boolean;
  readonly headline: string;
  /** The pass the marker was started in, or `null`. */
  readonly passNumber: number | null;
  /** The rating the marker remembered, or `null`. */
  readonly rememberedRating: QualityRating | null;
  /** The remembered rating's short label, or `null`. */
  readonly rememberedLabel: string | null;
}

// ── The next action ─────────────────────────────────────────────────────────

/**
 * Which step this model recommends, as a discriminant rather than a control id.
 *
 * The discriminant rather than the id because the ids are static vocabulary declared in
 * `controlIds.ts`, and a view model that spelled `archaeologist-session-resume` out itself
 * would be a second place a rename had to be made - which is the drift
 * `ARCHAEOLOGIST_CONTROL_IDS` exists to prevent. `ArchaeologistWorkspace` is the one place
 * that maps a discriminant to a control.
 */
export type ReviewNextStepKind =
  | 'locked'
  | 'resume'
  | 'no-artifact'
  | 'no-prompts'
  | 'already-reviewed'
  | 'rate-recall';

/** The recommended step. */
export interface ReviewNextAction {
  readonly kind: ReviewNextStepKind;
  readonly label: string;
  readonly detail: string;
}

// ── View model ──────────────────────────────────────────────────────────────

/** The complete, display-ready review model. */
export interface ReviewViewModel {
  readonly roomId: string | null;
  readonly topic: string;
  /** The subject name, for the shell header. */
  readonly subjectName: string;
  /** The room's status, for the shell header. */
  readonly status: string;
  readonly pass: ReviewPassView;
  readonly due: ReviewDueView;
  readonly facts: ReviewRoomFacts;
  readonly prompts: readonly ReviewPromptRow[];
  readonly access: ReviewAccessView;
  readonly arrival: ReviewArrivalView;
  /** The recommended step, or `null` when there is no room. */
  readonly next: ReviewNextAction | null;
}

// ── Derivations ─────────────────────────────────────────────────────────────

/** Non-negative whole number, for the two counters a hand-edited record can make negative. */
function toCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * The connected topics a room's recall prompts are drawn from.
 *
 * The same population `RoomPanel`'s self-check tab has always used - the dungeon summaries'
 * direct children - and read from `snapshot.dungeon.rooms` rather than from a graph
 * traversal, because that is the set the existing prompts were generated from and a
 * different set would make this workspace and the self-check tab disagree about what to
 * ask.
 */
function relatedTopics(snapshot: SubjectSnapshot, roomId: string): string[] {
  const room = snapshot.rooms[roomId];
  if (room === undefined) return [];
  /*
   * Siblings, not connections.
   *
   * `DungeonRoomSummary` carries no parent id - the hierarchy is derived, not stored - so the
   * siblings are found through `deriveGraphHierarchy`, which is the one function that owns
   * "which rooms are children of which". `getConnectedRoomIds` would be the other candidate
   * and is wrong here: it answers *edge* adjacency, which includes a room's parent and its
   * cross-links, and `generateSelfCheckPrompts` renders the first sibling into the prompt
   * text as "connects to X". Naming the learner's parent floor as a "connection" would put a
   * weaker prompt in front of them than the question deserves.
   */
  const hierarchy = deriveGraphHierarchy(snapshot.dungeon);
  const parentRoomId = hierarchy.parentByRoomId[roomId] ?? null;
  if (parentRoomId === null) return [];
  return (hierarchy.childRoomIdsByParentId[parentRoomId] ?? [])
    .filter((candidateId) => candidateId !== roomId)
    .map((candidateId) => snapshot.rooms[candidateId]?.topic)
    .filter((topic): topic is string => typeof topic === 'string' && topic.length > 0);
}

function buildPassView(input: {
  readonly progress: ReturnType<typeof deriveReviewPassProgress>;
  readonly roomReviewed: boolean;
}): ReviewPassView {
  const { progress } = input;
  const percent =
    progress.totalRooms > 0
      ? Math.min(100, Math.round((progress.roomsTowardNextPass / progress.totalRooms) * 100))
      : 0;
  return {
    fullPasses: progress.fullReviewPasses,
    nextPassTarget: progress.nextPassTarget,
    roomsTowardNextPass: progress.roomsTowardNextPass,
    totalRooms: progress.totalRooms,
    percent,
    lines: [
      `Full review passes completed: ${progress.fullReviewPasses}.`,
      `${progress.roomsTowardNextPass}/${progress.totalRooms} rooms reviewed toward pass ${progress.nextPassTarget}.`,
      input.roomReviewed
        ? `This room has already been reviewed in pass ${progress.nextPassTarget}.`
        : `This room has not been reviewed in pass ${progress.nextPassTarget} yet.`,
    ],
  };
}

function buildArrival(input: {
  readonly roomId: string | null;
  readonly session: InterruptedReviewSession | null;
}): ReviewArrivalView {
  const { roomId, session } = input;
  if (session === null) {
    return {
      resumable: false,
      waitingForOtherRoom: false,
      headline: 'No review is waiting to be picked up. This review starts from the top.',
      passNumber: null,
      rememberedRating: null,
      rememberedLabel: null,
    };
  }
  if (roomId === null || session.roomId !== roomId) {
    return {
      resumable: false,
      waitingForOtherRoom: true,
      headline:
        'An unfinished review is saved for a different room. It stays there until you go back to that room.',
      passNumber: session.passNumber,
      rememberedRating: session.qualityRating,
      rememberedLabel:
        session.qualityRating === null ? null : QUALITY_SHORT_LABELS[session.qualityRating],
    };
  }
  return {
    resumable: true,
    waitingForOtherRoom: false,
    headline: session.qualityRating === null
      ? 'You left this review part way through. Pick it up where you stopped.'
      : `You left this review part way through, rated ${QUALITY_SHORT_LABELS[
          session.qualityRating
        ].toLocaleLowerCase()}. Pick it up where you stopped.`,
    passNumber: session.passNumber,
    rememberedRating: session.qualityRating,
    rememberedLabel:
      session.qualityRating === null ? null : QUALITY_SHORT_LABELS[session.qualityRating],
  };
}

/**
 * The step this model recommends.
 *
 * ## Why this order
 *
 * **Ordered by what actually blocks a pass from counting:**
 *
 * 1. **A locked room first.** `canReviewRoom` is the same call the flow enforces, so a
 *    locked room can neither be rated nor completed at all. Pointing past the lock would
 *    send a learner to a control whose every command is refused.
 * 2. **Pick the review back up** outranks everything else. "Handle exit during an open
 *    review with a save, resume, or discard decision" is the phase's own scope line, and a
 *    learner who returns to a half-finished review and is pointed at the rating control has
 *    been pointed past the decision that is actually waiting for them.
 * 3. **Read the artifact** outranks rating. A room that has not written an artifact has
 *    nothing to review - and `generateSelfCheckPrompts` was asked anyway, because it
 *    produces prompts from the topic alone - so "rate your recall" here would be rating a
 *    room the learner has not read.
 * 4. **No prompts at all** is ranked above rating because rating with nothing to have
 *    recalled asks for a self-assessment of a blank. It is genuinely reachable - an
 *    artifact with no headings and no sibling topics produces zero prompts - so it is named
 *    rather than hidden.
 * 5. **Already reviewed this pass** is named rather than omitted, because the completion
 *    control is still there and still does something a learner can see: it reports that the
 *    pass already counted. Dropping the step would make that region look broken.
 * 6. **Rate the recall** is the ordinary path, and last, because every entry before it is a
 *    reason this is *not* the ordinary path.
 *
 * There is deliberately **no** "collect the artifact" step here, unlike the Scribe
 * workspace's next action. Collection is `studyFlowController.collectArtifact` - a different
 * flow, a different verb, and a phase-15 decision - and a review of a room whose artifact is
 * still lying on the floor is a review of the room, which is what this surface is for. The
 * artifact region's own sentence names the pickup route.
 *
 * A `null` room yields `null`, because there is no control to name.
 */
export function resolveReviewNextAction(model: ReviewViewModel): ReviewNextAction | null {
  if (model.roomId === null) return null;
  if (model.access.allowed === false) {
    return {
      kind: 'locked',
      label: 'Review is locked for now',
      detail:
        model.access.refusal ??
        'Clear the remaining room encounters before reviewing, and this room will open up.',
    };
  }
  if (model.arrival.resumable) {
    return {
      kind: 'resume',
      label: 'Pick this review back up',
      detail:
        'A review for this room was left unfinished. Picking it up re-opens it; discarding it abandons it and awards nothing.',
    };
  }
  if (model.facts.hasArtifact === false) {
    return {
      kind: 'no-artifact',
      label: 'Read the artifact first',
      detail:
        'This room has not written an artifact yet, so there is nothing here to review. Defeat its encounter in the Scribe phase, then come back.',
    };
  }
  if (model.prompts.length === 0) {
    return {
      kind: 'no-prompts',
      label: 'Nothing to recall from this room',
      detail:
        'This artifact has no headings and no related topics, so no recall prompt could be written for it.',
    };
  }
  if (model.facts.reviewedInCurrentPass) {
    return {
      kind: 'already-reviewed',
      label: 'Review this room again',
      detail:
        'This room already counts toward the current pass. Completing it again awards nothing new until the next pass starts.',
    };
  }
  return {
    kind: 'rate-recall',
    label: 'Rate how well you recalled it',
    detail:
      'Answer the recall prompt in your own words first, then pick the rating that matches what actually happened. The rating is what decides when this room comes back.',
  };
}

/**
 * Build the review view model.
 *
 * One call, one value: a surface renders it and has no review presentation of its own to
 * keep in step.
 */
export function buildReviewViewModel(input: ReviewViewModelInput): ReviewViewModel {
  const { room, snapshot, nowIso, pendingSession } = input;
  const roomId = room?.roomId ?? null;

  const progress = deriveReviewPassProgress({ dungeon: snapshot.dungeon, rooms: snapshot.rooms });
  const passNumber = currentReviewPassNumber(progress);

  /*
   * `canReviewRoom` is asked even when there is no room: it returns the same
   * `evaluateReviewUnlock` evaluation either way, and the unlock sentence is wanted in both
   * cases. A null room takes the `room-not-cleared` refusal, which is the honest one.
   */
  const permission = canReviewRoom({
    dungeon: snapshot.dungeon,
    rooms: snapshot.rooms,
    roomId: roomId ?? '',
  });
  const access: ReviewAccessView = {
    allowed: permission.allowed,
    refusal: permission.allowed ? null : describeReviewRefusal(permission),
    unlockSentence: `${permission.unlock.clearedRooms}/${permission.unlock.totalRooms} rooms cleared.`,
  };

  const nextReviewDateIso =
    typeof room?.sm2NextReviewDate === 'string' && room.sm2NextReviewDate.length > 0
      ? room.sm2NextReviewDate
      : null;
  const dueState = describeReviewDueState({ nextReviewDateIso, nowIso });
  const dueWord = reviewDueSentence({
    dueState,
    hasSchedule: nextReviewDateIso !== null,
  });

  const artifactMarkdown =
    typeof room?.artifactMarkdown === 'string' && room.artifactMarkdown.length > 0
      ? room.artifactMarkdown
      : null;
  const reviewPassCount = toCount(room?.reviewPassCount ?? 0);
  const reviewedInCurrentPass =
    roomId !== null && progress.reviewedRoomIds.includes(roomId) && reviewPassCount >= passNumber;

  const prompts: ReviewPromptRow[] =
    room === null
      ? []
      : generateSelfCheckPrompts({
          roomId: room.roomId,
          subjectName: snapshot.dungeon.subjectName,
          roomTopic: room.topic,
          noteHeadings:
            artifactMarkdown === null ? [] : extractMarkdownHeadings(artifactMarkdown),
          relatedTopics: relatedTopics(snapshot, room.roomId),
        }).map((prompt, index) => ({ ordinal: index + 1, text: prompt.text }));

  const pass = buildPassView({ progress, roomReviewed: reviewedInCurrentPass });

  /*
   * Built in two steps because `next` is derived from every field above it: constructing it
   * inside the object literal would mean reading a half-built model. The spread is one extra
   * allocation on a render that already allocates a snapshot-sized object graph, and the
   * alternative - a second exported function every caller must remember to call - is the
   * shape that gets forgotten.
   */
  const base: Omit<ReviewViewModel, 'next'> = {
    roomId,
    topic: room?.topic ?? '',
    subjectName: snapshot.dungeon.subjectName,
    status: room?.state ?? 'No room',
    pass,
    due: {
      state: dueState,
      label: dueWord.label,
      sentence: dueWord.sentence,
      nextReviewDateIso,
    },
    facts: {
      reviewPassCount,
      reviewedInCurrentPass,
      artifactMarkdown,
      hasArtifact: artifactMarkdown !== null,
    },
    prompts,
    access,
    arrival: buildArrival({ roomId, session: pendingSession }),
  };

  return { ...base, next: resolveReviewNextAction({ ...base, next: null }) };
}