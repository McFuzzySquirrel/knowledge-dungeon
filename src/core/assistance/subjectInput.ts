/**
 * The one adapter between a subject snapshot and the assistance engine's reduced view.
 *
 * ## Why this file exists and is the only one
 *
 * {@link AssistanceRoomInput} deliberately has no `noteText` and no `artifactMarkdown`
 * field, so an engine that accepted a `SubjectSnapshot` could put a learner's own prose
 * into a suggestion, an explanation, or a log line. It does not accept one. This module is
 * the entire bridge, and it copies **numeric and enum facts** out of each room and nothing
 * else:
 *
 * | Copied | Read from | Why it is safe |
 * | --- | --- | --- |
 * | `noteWordCount` | `validationState.wordCount` | A count the validator already computed. The text is never opened. |
 * | `failedChecks` | `validationState.failedChecks` | App-owned failure codes, e.g. `VAL_REQUIRED_SECTION_MISSING`. |
 * | `criterionScores` | `validationState.criterionScores` | Five rubric numbers. |
 * | `finalPass` | `validationState.finalPass` | The deterministic validator's verdict, copied and never recomputed. |
 * | `sm2QualityResponse`, `sm2NextReviewDate` | the room's SM-2 fields | Two scalars the review module already wrote. |
 * | `tags` | the room's tags | The learner's own words, kept in memory only - see below. |
 *
 * There is no path from this module's output to a sentence, and
 * `tests/unit/assistanceEngine.test.ts` scans this file for the two field names and fails if
 * either appears. That file is the one that exists; an earlier version of this comment cited
 * a `tests/phase19/assistancePrivacy.test.ts` that was never written, which is the same class
 * of error - a comment asserting a gate - that an attack found twice more in this phase.
 *
 * ## What it refuses to do
 *
 * It does not re-evaluate validation. `evaluateNoteValidation` is the deterministic owner of
 * `finalPass`, `criterionScores`, `failedChecks`, and `wordCount`, and this adapter copies
 * what that function wrote. An assistance path that re-derived those from `noteText` would
 * be a second answer to "did this note pass", which is the duplication plan rule 13 and the
 * Phase 18 statistics defect both exist to prevent.
 *
 * ## The one thing a stored room cannot supply, and what is done about it
 *
 * `RoomMetadata.validationState` records `requiredSectionsPresent` as a **boolean** and does
 * not store *which* section is missing. So a pass that has only the persisted room cannot
 * name a section, and saying so is better than guessing: `scribe.missing-section` then fires
 * with `reasonCode: 'note-validation-failed'` and no section name, which the engine's
 * explanation renders as "a required check did not pass" instead of "add a Summary".
 *
 * When the caller *does* hold the validator's live output - the Scribe flow always does,
 * because it is the thing that just produced it - {@link toAssistanceRoom} takes it and the
 * missing sections are named exactly. Two entry points rather than one that guesses.
 *
 * ## The tag decision
 *
 * `tags` are copied because a shared tag is the one basis for "these two rooms are related"
 * that the learner created deliberately, and the plan's "graph structure and related topics"
 * names it. They are **not** put in a signal, a log, or a report; they stay in the in-memory
 * input, are only ever compared for equality after lower-casing, and never become part of a
 * persisted record. Plan working rule 6 (no learner data in reports) holds because nothing
 * here writes anything.
 */

import { QUALITY_SCORE_KEYS } from '@/core/validation/persistence/types';
import type { SubjectSnapshot } from '@/core/validation/persistence/types';

import type {
  AssistanceEdgeInput,
  AssistanceRoomInput,
  AssistanceSubjectInput,
} from './types';

/** Coerce an unknown scalar to a non-negative integer. Total, and never throws. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * A rubric score map that is safe to hand to the engine.
 *
 * Only the five keys the app's `QUALITY_SCORE_KEYS` names are kept, and each is coerced to
 * an integer in `0..2` - the rubric's own range. A room whose stored score map came from a
 * restored `.kdsubject` is untrusted input, and an out-of-range or non-numeric score would
 * otherwise reach `lowRubricCriteria`, where `=== 0` is the whole test and a `NaN` would
 * quietly become "no criterion is low".
 *
 * Key order is the app's declaration order, not the stored object's order, so two devices
 * whose stored maps were written by different code paths produce identical input objects.
 */
function toCriterionScores(
  scores: Readonly<Record<string, unknown>> | undefined,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const criterion of QUALITY_SCORE_KEYS) {
    const raw = scores?.[criterion];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const truncated = Math.trunc(raw);
    resolved[criterion] = truncated < 0 ? 0 : truncated > 2 ? 2 : truncated;
  }
  return resolved;
}

/** The live validator's output, in the only two fields this adapter reads from it. */
export interface AssistanceLiveValidation {
  /** The validator's own `missingSections`, in the validator's order. */
  readonly missingSections: readonly string[];
  /** The validator's own `failedChecks`. */
  readonly failedChecks: readonly string[];
}

/** Anything with the shape this adapter reads out of a room. */
export interface AssistanceRoomSource {
  readonly roomId: unknown;
  readonly topic: unknown;
  readonly state: unknown;
  readonly validationState?: {
    readonly wordCount?: unknown;
    readonly requiredSectionsPresent?: unknown;
    readonly failedChecks?: unknown;
    readonly criterionScores?: Readonly<Record<string, unknown>>;
    readonly finalPass?: unknown;
  };
  readonly reviewPassCount?: unknown;
  readonly sm2QualityResponse?: unknown;
  readonly sm2NextReviewDate?: unknown;
  readonly tags?: unknown;
}

/**
 * Reduce one room to the engine's view.
 *
 * `liveValidation` is optional and is supplied only by a caller that is holding the
 * deterministic validator's own output right now. When it is absent, `missingSections` is
 * left empty rather than inferred from `requiredSectionsPresent`, because the boolean says
 * *that* a section is missing and not *which* - and an engine that guessed would produce a
 * scaffold for a section the note may well already contain.
 *
 * Total by construction: every field is coerced, so a hand-edited or truncated snapshot
 * produces a room the engine can read rather than an exception on a learner-facing path.
 *
 * ## `sm2NextReviewDate` is copied through **unvalidated**, on purpose
 *
 * This adapter checks only that the stored value is a non-empty string. It deliberately does
 * **not** normalise, reject, or shape-check the value, because the decision about what an
 * offset-less timestamp *means* belongs to exactly one function - `readUtcEpochMs` in
 * `./assistanceEngine`, which is the only timestamp parser in this domain. Duplicating that
 * rule here would be a second answer to one question, and the two would drift.
 *
 * That was not always true. With no shape check anywhere in `src/`, a stored
 * `2026-03-17T04:00:00` - UTC wall clock with the `Z` stripped, which `toISOString().slice(0,
 * 19)`, a SQL `DATETIME`, a SOAP payload, or a hand edit all produce - reached the engine and
 * was parsed by `Date.parse` **in the host's time zone**, so the same archive restored on two
 * devices ranked differently. The parser is the fix, and keeping the adapter a pure copy is
 * what makes the parser the only place the rule can be got wrong.
 *
 * The empty-string case *is* normalised to `null` here, and that is not an inconsistency: an
 * empty string is not a timestamp in any zone, so it is absence rather than ambiguity, and
 * absence has exactly one representation.
 */
export function toAssistanceRoom(
  room: AssistanceRoomSource,
  liveValidation?: AssistanceLiveValidation | null,
): AssistanceRoomInput {
  const validation = room.validationState ?? {};
  const storedFailedChecks = Array.isArray(validation.failedChecks)
    ? validation.failedChecks.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const failedChecks =
    liveValidation === null || liveValidation === undefined
      ? storedFailedChecks
      : [...new Set([...liveValidation.failedChecks, ...storedFailedChecks])]
          .filter((entry): entry is string => typeof entry === 'string')
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const tags = Array.isArray(room.tags)
    ? room.tags.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const qualityResponse =
    typeof room.sm2QualityResponse === 'number' && Number.isFinite(room.sm2QualityResponse)
      ? Math.trunc(room.sm2QualityResponse)
      : null;
  const nextReviewDate =
    typeof room.sm2NextReviewDate === 'string' && room.sm2NextReviewDate.length > 0
      ? room.sm2NextReviewDate
      : null;
  const missingSections =
    liveValidation === null || liveValidation === undefined
      ? []
      : liveValidation.missingSections.filter((entry): entry is string => typeof entry === 'string');

  return {
    roomId: typeof room.roomId === 'string' ? room.roomId : '',
    topic: typeof room.topic === 'string' ? room.topic : '',
    state: typeof room.state === 'string' ? room.state : '',
    noteWordCount: toCount(validation.wordCount),
    missingSections,
    failedChecks,
    criterionScores: toCriterionScores(validation.criterionScores),
    finalPass: validation.finalPass === true,
    reviewPassCount: toCount(room.reviewPassCount),
    sm2QualityResponse: qualityResponse,
    sm2NextReviewDate: nextReviewDate,
    tags,
  };
}

/** Anything with the shape this adapter reads out of an edge. */
export interface AssistanceEdgeSource {
  readonly fromRoomId: unknown;
  readonly toRoomId: unknown;
  readonly relationType: unknown;
}

/**
 * Reduce one edge to the engine's view.
 *
 * Only the three fields any rule reads. `createdAt` and `createdByPhase` are dropped rather
 * than carried: no rule orders by them, and carrying them would put a timestamp in the
 * engine's input for no reason.
 */
export function toAssistanceEdge(edge: AssistanceEdgeSource): AssistanceEdgeInput {
  return {
    fromRoomId: typeof edge.fromRoomId === 'string' ? edge.fromRoomId : '',
    toRoomId: typeof edge.toRoomId === 'string' ? edge.toRoomId : '',
    relationType: typeof edge.relationType === 'string' ? edge.relationType : '',
  };
}

/**
 * Reduce a subject snapshot to the engine's view.
 *
 * Room and edge order is preserved exactly as the snapshot stores them, because the engine
 * sorts rooms by id before it reads anything and never iterates an edge list for a result -
 * sorting here as well would be a second place that has to know the rule, and one of the two
 * would eventually be the one that is wrong.
 *
 * A `null` snapshot yields `null`: a device with no subject loaded has nothing to advise
 * about, and returning an empty subject with an empty id would produce a
 * `creator.missing-branch` suggestion for a subject that does not exist.
 *
 * `liveValidationByRoomId` lets a caller that is mid-flow supply the validator's output for
 * the room it is currently writing. Rooms it does not name are reduced from stored state
 * alone, so a partially-known flow degrades to less specific suggestions rather than to
 * guesses.
 */
export function toAssistanceSubject(
  snapshot: SubjectSnapshot | null | undefined,
  liveValidationByRoomId?: Readonly<Record<string, AssistanceLiveValidation>> | null,
): AssistanceSubjectInput | null {
  if (snapshot === null || snapshot === undefined) return null;
  const dungeon = snapshot.dungeon;
  if (dungeon === null || dungeon === undefined) return null;
  const rooms = snapshot.rooms ?? {};
  const live = liveValidationByRoomId ?? {};
  return {
    subjectId: dungeon.dungeonId,
    subjectName: dungeon.subjectName,
    rootRoomId: dungeon.rootRoomId,
    phaseState: dungeon.phaseState,
    rooms: Object.values(rooms).map((room) =>
      toAssistanceRoom(room, live[room.roomId] ?? null),
    ),
    edges: Array.isArray(dungeon.edges) ? dungeon.edges.map(toAssistanceEdge) : [],
  };
}

/**
 * Reduce every subject a caller has, dropping the ones that could not be read.
 *
 * Returns a **new array** and never mutates its input, so a caller can hold a snapshot
 * before and after and assert the adapter is pure - which is what
 * `tests/phase19/assistanceDeterminism.test.ts` does over a corpus.
 */
export function toAssistanceSubjects(
  snapshots: readonly (SubjectSnapshot | null | undefined)[],
): AssistanceSubjectInput[] {
  const subjects: AssistanceSubjectInput[] = [];
  for (const snapshot of snapshots) {
    const subject = toAssistanceSubject(snapshot);
    if (subject !== null) subjects.push(subject);
  }
  return subjects;
}
