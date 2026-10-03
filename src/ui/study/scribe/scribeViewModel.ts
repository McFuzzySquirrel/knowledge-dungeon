/**
 * Renderer-neutral Scribe encounter view model.
 *
 * Plan section for Phase 15, "Move validation presentation into renderer-neutral
 * view models". Everything a Scribe surface needs to *say* - which required
 * sections are present, what each quality criterion is called and how to improve
 * it, what the rubric scored, whether an unfinished encounter can be picked back
 * up, and whether the room's artifact exists and has been collected - is derived
 * here, from plain data, into display-ready values.
 *
 * Plain TypeScript by construction: no React, no JSX, no DOM global, no Pixi, no
 * Phaser, and no store import. It receives a room, a validation output, a
 * snapshot, and the journal's collected note ids, and returns values a renderer
 * can bind to directly. That is what lets a Pixi dungeon surface and the React
 * Scribe workspace present the same encounter without sharing a component.
 *
 * ## Why the wording lives here
 *
 * The criterion labels, the improvement hints, the score presentation, and the
 * quality-bonus line used to be inlined in `NoteEditorModal.tsx`. They were
 * *moved* to this module, not copied: the modal now calls
 * {@link scribeCriterionLabel} and {@link scribeCriterionHint}. Duplicating them
 * would let the two surfaces drift, which is the same defect
 * `src/application/creatorGraphCommands.ts` exists to prevent.
 *
 * ## Totality
 *
 * Every function here is total. A room that does not exist, a room with no note,
 * a room whose artifact exists but has never been collected, and an encounter
 * with no validation output yet all produce a defined result, because a Scribe
 * surface mounts before any of them is true.
 *
 * Privacy: nothing here logs, and no derived value carries anything the learner
 * wrote except the room's own topic, which the room heading already shows.
 */
import { REQUIRED_NOTE_SECTIONS, type NoteValidationOutput } from '@/core/validation/notes';
import type {
  QualityScoreKey,
  RoomMetadata,
  RoomState,
  SubjectSnapshot,
} from '@/core/validation/persistence';

// ── Criterion labels and hints (moved from `NoteEditorModal.tsx`) ────────────

/** Display name for each quality criterion. */
const CRITERION_LABELS: Record<QualityScoreKey, string> = {
  sectionCompleteness: 'Required sections',
  conceptTermCoverage: 'Topic terms covered',
  linkReferences: 'Links & references',
  recallQuestionQuality: 'Recall questions',
  clarityReadability: 'Readability',
};

/** How to improve each criterion at a given score; empty at a full score. */
function criterionHint(criterion: QualityScoreKey, score: number): string {
  if (score === 2) return '';
  const hints: Record<QualityScoreKey, string> = {
    sectionCompleteness: 'Include Summary, Key Points, and Recall Question headings.',
    conceptTermCoverage: 'Use key terms from the room topic throughout your note.',
    linkReferences: score === 0 ? 'Add 2+ links or "see also" references.' : 'Add one more link or reference.',
    recallQuestionQuality: 'Write 2+ questions in the Recall Question section.',
    clarityReadability: 'Aim for 8-24 words per sentence and at least 2 paragraphs.',
  };
  return hints[criterion];
}

/** The display name for a quality criterion. */
export function scribeCriterionLabel(criterion: QualityScoreKey): string {
  return CRITERION_LABELS[criterion];
}

/**
 * The improvement hint for a quality criterion, or `''` at a full score.
 *
 * Empty rather than `null` because that is what the modal has always bound, and
 * the wording is unchanged from where it moved.
 */
export function scribeCriterionHint(criterion: QualityScoreKey, score: number): string {
  return criterionHint(criterion, score);
}

/** The score presentation for a rubric row, e.g. `2/2`. */
export function scribeScoreDisplay(score: number): string {
  return `${score}/2`;
}

/** How a score should read: earned, partial, or nothing. */
export type ScribeScoreTone = 'full' | 'partial' | 'none';

function scoreTone(score: number): ScribeScoreTone {
  if (score >= 2) return 'full';
  if (score >= 1) return 'partial';
  return 'none';
}

/** The quality-bonus line, verbatim from the note editor it moved from. */
export function scribeQualityBonusLine(qualityBonus: number): string {
  return `Quality bonus: ${qualityBonus}/10 · Each criterion scored 0–2`;
}

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * Everything the view model needs.
 *
 * All four fields are data, not handles. `collectedNoteIds` is the journal's
 * note ids (`${dungeonId}:${roomId}`, the key `collectArtifactNote` already uses),
 * passed in so this module never has to reach for a store.
 */
export interface ScribeEncounterInput {
  /** The room being written, or `null` when the encounter has no room. */
  room: RoomMetadata | null;
  /** Live validation of what is in the composer, or `null` before any is run. */
  validation: NoteValidationOutput | null;
  /** The subject the room belongs to, or `null` when none is loaded. */
  snapshot: SubjectSnapshot | null;
  /** Journal note ids already collected on this device. */
  collectedNoteIds: readonly string[];
  /**
   * Whether the learner has typed since the encounter opened.
   *
   * Drives the *neutral* checklist: a room with no note and no edits shows what
   * the note will need rather than what it currently fails. Derived state
   * (`room.noteText`) is the default when this is omitted.
   */
  hasEdited?: boolean;
}

// ── Sections ────────────────────────────────────────────────────────────────

/** One required section's state. */
export interface ScribeSectionState {
  section: (typeof REQUIRED_NOTE_SECTIONS)[number];
  /** The validator found this section's heading. */
  present: boolean;
  /** The section is missing a heading, so it blocks a clear. */
  missing: boolean;
  /** How many of the required sections are missing, for a headline. */
  missingCount: number;
}

// ── Checks ──────────────────────────────────────────────────────────────────

/** One validation check as a display row. */
export interface ScribeCheckRow {
  code: NoteValidationOutput['criteria'][number]['code'];
  passed: boolean;
  /** The check's message, or the neutral-checklist wording for an untouched draft. */
  message: string;
  /**
   * Whether the check blocks a clear.
   *
   * The word-count check does not: it is the bonus-badge target, and reporting it
   * as a failure would read as a requirement that is not one.
   */
  blocking: boolean;
  /** The glyph to show: `✓` / `✗` for blocking checks, `★` / `○` for the bonus. */
  display: string;
}

/**
 * The neutral-checklist wording.
 *
 * For a draft the learner has not touched, these say what the note will need
 * rather than what it currently lacks - the note editor's existing behaviour,
 * kept because "Add notes in: …" is the honest thing to show before there is
 * anything to add notes to.
 */
const NEUTRAL_CHECK_MESSAGES: Partial<
  Record<NoteValidationOutput['criteria'][number]['code'], string>
> = {
  VAL_REQUIRED_SECTION_MISSING: `Keep headings: ${REQUIRED_NOTE_SECTIONS.join(', ')}.`,
  VAL_MANUAL_CONFIRM_REQUIRED: 'Tick confirmation when your draft is ready to submit.',
};

const BLOCKING_CHECK_CODES = new Set<NoteValidationOutput['criteria'][number]['code']>([
  'VAL_REQUIRED_SECTION_MISSING',
  'VAL_MANUAL_CONFIRM_REQUIRED',
]);

/** The check rows for a validation, in the validator's own order. */
export function scribeCheckRows(input: {
  validation: NoteValidationOutput | null;
  /** Show requirements rather than failures, for an untouched draft. */
  neutral: boolean;
}): ScribeCheckRow[] {
  const validation = input.validation;
  if (validation === null) return [];
  return validation.criteria.map((criterion) => {
    const blocking = BLOCKING_CHECK_CODES.has(criterion.code);
    const passed = input.neutral ? true : criterion.passed;
    const neutralMessage = NEUTRAL_CHECK_MESSAGES[criterion.code];
    return {
      code: criterion.code,
      passed,
      message:
        input.neutral && neutralMessage !== undefined ? neutralMessage : criterion.message,
      blocking,
      display: input.neutral
        ? '•'
        : blocking
          ? passed
            ? '✓'
            : '✗'
          : passed
            ? '★'
            : '○',
    };
  });
}

// ── Rubric ──────────────────────────────────────────────────────────────────

/** One rubric row, ready to bind. */
export interface ScribeCriterionRow {
  criterion: QualityScoreKey;
  /** The criterion's display name. */
  label: string;
  score: number;
  maxScore: 2;
  /** `2/2`, and so on. */
  displayScore: string;
  tone: ScribeScoreTone;
  /** What to do about it, or `null` at a full score. */
  hint: string | null;
  /** The validator's own rationale, verbatim. */
  rationale: string;
}

/** The rubric as the Scribe surface presents it. */
export interface ScribeRubricView {
  rows: ScribeCriterionRow[];
  qualityBonus: number;
  maxQualityBonus: 10;
  /** The one-sentence bonus line, so the wording has one home. */
  qualityBonusLine: string;
}

/** Build the rubric rows and bonus line from a validation, or empty ones from `null`. */
export function scribeRubricView(validation: NoteValidationOutput | null): ScribeRubricView {
  if (validation === null) {
    return { rows: [], qualityBonus: 0, maxQualityBonus: 10, qualityBonusLine: scribeQualityBonusLine(0) };
  }
  return {
    rows: validation.rubric.map((entry) => {
      const hint = criterionHint(entry.criterion, entry.score);
      return {
        criterion: entry.criterion,
        label: CRITERION_LABELS[entry.criterion],
        score: entry.score,
        maxScore: 2 as const,
        displayScore: scribeScoreDisplay(entry.score),
        tone: scoreTone(entry.score),
        hint: hint.length > 0 ? hint : null,
        rationale: entry.rationale,
      };
    }),
    qualityBonus: validation.qualityBonus,
    maxQualityBonus: 10,
    qualityBonusLine: scribeQualityBonusLine(validation.qualityBonus),
  };
}

// ── Resumability ────────────────────────────────────────────────────────────

/**
 * Where an encounter stands.
 *
 * `unavailable` is a room that is not there; `needs-revalidation` is a room whose
 * note a graph change invalidated, which is the one state a learner cannot
 * resume *as cleared* even though their text is still there.
 */
export type ScribeEncounterStage =
  | 'unavailable'
  | 'not-started'
  | 'draft'
  | 'needs-revalidation'
  | 'cleared';

/** What a learner sees on arrival at an encounter they have already started. */
export interface ScribeResumeState {
  stage: ScribeEncounterStage;
  /** Whether arriving shows the learner the text they already wrote. */
  canResume: boolean;
  /** Whether the learner should be told there is something to come back to. */
  resumable: boolean;
  /** A short learner-facing line describing the state. */
  headline: string;
  /** How many required sections are still missing. */
  missingSectionCount: number;
  /** Word count as last recorded by the validator, or 0 before one runs. */
  wordCount: number;
  /** The room's recorded status, or `null` when the room is not in the graph. */
  status: RoomState | null;
}

/**
 * The dungeon's own view of a room's status.
 *
 * Prefers the dungeon summary over `RoomMetadata.state` because revalidation
 * propagation only rewrites the summary: a graph change marks a room
 * `NeedsRevalidation` there and leaves the room's own note untouched. Reading
 * only `RoomMetadata.state` would report a stale `cleared` for a note the graph
 * has invalidated.
 */
function roomStatus(
  room: RoomMetadata,
  snapshot: SubjectSnapshot | null,
): RoomState | null {
  if (snapshot !== null) {
    const summary = snapshot.dungeon.rooms.find((candidate) => candidate.roomId === room.roomId);
    if (summary !== undefined) return summary.status;
  }
  return room.state;
}

/** Derive the arrival state for an encounter. */
export function scribeResumeState(input: ScribeEncounterInput): ScribeResumeState {
  const room = input.room;
  const validation = input.validation;
  const missingSectionCount = validation?.missingSections.length ?? REQUIRED_NOTE_SECTIONS.length;
  const wordCount = validation?.wordCount ?? 0;

  if (room === null) {
    return {
      stage: 'unavailable',
      canResume: false,
      resumable: false,
      headline: 'No room is open for writing.',
      missingSectionCount,
      wordCount,
      status: null,
    };
  }

  const status = roomStatus(room, input.snapshot);
  const hasText = room.noteText.trim().length > 0;
  const edited = input.hasEdited ?? hasText;
  const missingCount = hasText ? missingSectionCount : 0;

  if (status === 'NeedsRevalidation') {
    return {
      stage: 'needs-revalidation',
      canResume: true,
      resumable: true,
      headline: 'The subject graph changed, so this note needs to be rewritten before it clears again.',
      missingSectionCount: missingCount,
      wordCount,
      status,
    };
  }

  if (room.validationState.finalPass) {
    return {
      stage: 'cleared',
      canResume: hasText,
      resumable: false,
      headline: 'This encounter is already cleared. Its artifact is ready to pick up.',
      missingSectionCount: 0,
      wordCount,
      status,
    };
  }

  if (hasText || edited) {
    return {
      stage: 'draft',
      canResume: hasText,
      resumable: true,
      headline: hasText
        ? 'You have a draft here. Pick up where you left off.'
        : 'Start writing this note to begin the encounter.',
      missingSectionCount: missingCount,
      wordCount,
      status,
    };
  }

  return {
    stage: 'not-started',
    canResume: false,
    resumable: false,
    headline: 'Nothing written here yet.',
    missingSectionCount: 0,
    wordCount: 0,
    status,
  };
}

// ── Artifact ────────────────────────────────────────────────────────────────

/** Where a room's artifact stands. */
export type ScribeArtifactState = 'none' | 'awaiting-pickup' | 'collected';

/** Whether an artifact exists, and whether it is in the journal. */
export interface ScribeArtifactView {
  state: ScribeArtifactState;
  /** An artifact has been generated for this room. */
  exists: boolean;
  /** It has been collected into the journal. */
  collected: boolean;
  /**
   * Whether the pickup action should be offered.
   *
   * Generation and pickup stay separate actions, so this is only true once an
   * artifact exists and has not been collected.
   */
  canCollect: boolean;
  /** The journal note id, present only when collected. */
  noteId: string | null;
}

/**
 * Derive artifact state for a room.
 *
 * Existence is `room.artifactMarkdown`: the store sets it on the clear branch and
 * clears it on the draft branch, so it is the one field that means "an artifact
 * was generated here". Collection is a *journal* fact, so it is looked up by the
 * `${dungeonId}:${roomId}` note id `collectArtifactNote` already builds.
 */
export function scribeArtifactView(input: {
  room: RoomMetadata | null;
  snapshot: SubjectSnapshot | null;
  collectedNoteIds: readonly string[];
}): ScribeArtifactView {
  const room = input.room;
  if (room === null) {
    return { state: 'none', exists: false, collected: false, canCollect: false, noteId: null };
  }
  const dungeonId = input.snapshot?.dungeon.dungeonId ?? null;
  const noteId = dungeonId === null ? null : `${dungeonId}:${room.roomId}`;
  const exists = typeof room.artifactMarkdown === 'string' && room.artifactMarkdown.length > 0;
  const collected = noteId !== null && input.collectedNoteIds.includes(noteId);

  return {
    state: !exists ? 'none' : collected ? 'collected' : 'awaiting-pickup',
    exists,
    collected,
    canCollect: exists && !collected,
    noteId: collected ? noteId : null,
  };
}

// ── View model ──────────────────────────────────────────────────────────────

/** The complete, display-ready Scribe encounter model. */
export interface ScribeEncounterViewModel {
  /** The room's topic, or `''` when there is no room. */
  topic: string;
  /** The room id, or `null` when there is no room. */
  roomId: string | null;
  /** The single arrival state; the same value {@link resume} carries. */
  stage: ScribeEncounterStage;
  resume: ScribeResumeState;
  sections: ScribeSectionState[];
  checks: ScribeCheckRow[];
  rubric: ScribeRubricView;
  artifact: ScribeArtifactView;
  /** Word count as last recorded by the validator, or 0 before one runs. */
  wordCount: number;
  /** Whether submitting now would clear the encounter. */
  canClear: boolean;
  /** How many device-local or external images the room has. */
  attachmentCount: number;
}

/**
 * Build the Scribe encounter view model.
 *
 * One call, one value: a surface renders it and has no validation presentation of
 * its own to keep in step.
 */
export function buildScribeEncounterViewModel(input: ScribeEncounterInput): ScribeEncounterViewModel {
  const room = input.room;
  const validation = input.validation;
  const resume = scribeResumeState(input);
  const artifact = scribeArtifactView(input);
  const hasText = room !== null && room.noteText.trim().length > 0;
  const neutral = !hasText && (input.hasEdited ?? false) === false;

  const missingSections = new Set(validation?.missingSections ?? REQUIRED_NOTE_SECTIONS);

  return {
    topic: room?.topic ?? '',
    roomId: room?.roomId ?? null,
    stage: resume.stage,
    resume,
    sections: REQUIRED_NOTE_SECTIONS.map((section) => ({
      section,
      present: validation !== null && !missingSections.has(section),
      missing: validation === null ? true : missingSections.has(section),
      missingCount: validation?.missingSections.length ?? REQUIRED_NOTE_SECTIONS.length,
    })),
    checks: scribeCheckRows({ validation, neutral }),
    rubric: scribeRubricView(validation),
    artifact,
    wordCount: validation?.wordCount ?? 0,
    canClear: validation?.finalPass === true,
    attachmentCount: room?.attachments.length ?? 0,
  };
}