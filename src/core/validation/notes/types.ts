import type { CriterionScores, QualityScoreKey } from '@/core/validation/persistence';

export const NOTE_MINIMUM_WORD_COUNT = 120;

export const REQUIRED_NOTE_SECTIONS = ['Summary', 'Key Points', 'Recall Question'] as const;

export type RequiredNoteSection = (typeof REQUIRED_NOTE_SECTIONS)[number];

export interface NoteValidationInput {
  noteText: string;
  manualConfirmed: boolean;
  roomTopic: string;
  referenceTerms?: readonly string[];
}

export type NoteValidationFailureCode =
  | 'VAL_WORD_COUNT_TOO_LOW'
  | 'VAL_REQUIRED_SECTION_MISSING'
  | 'VAL_MANUAL_CONFIRM_REQUIRED';

export interface NoteValidationCriterionResult {
  code: NoteValidationFailureCode;
  passed: boolean;
  required: number | boolean | readonly string[];
  actual: number | boolean | readonly string[];
  message: string;
}

export interface RubricCriterionBreakdown {
  criterion: QualityScoreKey;
  score: 0 | 1 | 2;
  rationale: string;
}

export interface NoteValidationOutput {
  wordCount: number;
  requiredSectionsPresent: boolean;
  manualConfirmed: boolean;
  missingSections: RequiredNoteSection[];
  failedChecks: NoteValidationFailureCode[];
  criteria: NoteValidationCriterionResult[];
  criterionScores: CriterionScores;
  rubric: RubricCriterionBreakdown[];
  qualityBonus: number;
  finalPass: boolean;
}
