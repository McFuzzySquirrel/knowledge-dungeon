import {
  NOTE_BADGE_WORD_COUNT,
  REQUIRED_NOTE_SECTIONS,
  type NoteValidationInput,
  type NoteValidationOutput,
  type RequiredNoteSection,
  type RubricCriterionBreakdown,
} from './types';

const WORD_TOKEN_REGEX = /[A-Za-z0-9][A-Za-z0-9'_-]*/g;
const SENTENCE_SPLIT_REGEX = /[.!?]+/;
const SECTION_HEADING_PREFIX_REGEX = /^\s{0,3}(?:#{1,6}\s*)?/;
const LINK_REFERENCE_REGEX =
  /\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|\bhttps?:\/\/\S+\b|\bsee also\b|->/gi;

function tokenizeWords(text: string): string[] {
  return text.match(WORD_TOKEN_REGEX) ?? [];
}

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findPresentSections(noteText: string): Set<RequiredNoteSection> {
  const lines = noteText.split(/\r?\n/);
  const present = new Set<RequiredNoteSection>();

  for (const line of lines) {
    const normalized = normalizeLabel(line.replace(SECTION_HEADING_PREFIX_REGEX, ''));

    for (const section of REQUIRED_NOTE_SECTIONS) {
      const expected = normalizeLabel(section);
      if (normalized === expected || normalized.startsWith(`${expected} `)) {
        present.add(section);
      }
    }
  }

  return present;
}

function uniqueNormalizedTerms(terms: readonly string[]): string[] {
  const normalized = new Set<string>();

  for (const term of terms) {
    const next = normalizeLabel(term);
    if (next.length >= 3) {
      normalized.add(next);
    }
  }

  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function deriveCandidateTerms(
  roomTopic: string,
  referenceTerms: readonly string[] | undefined,
): string[] {
  const topicTerms = roomTopic
    .split(/\s+/)
    .map((value) => normalizeLabel(value))
    .filter((value) => value.length >= 4);

  return uniqueNormalizedTerms([...(referenceTerms ?? []), ...topicTerms]);
}

function scoreSectionCompleteness(presentSections: Set<RequiredNoteSection>): {
  score: 0 | 1 | 2;
  rationale: string;
} {
  const count = presentSections.size;
  if (count >= REQUIRED_NOTE_SECTIONS.length) {
    return { score: 2, rationale: 'All required sections are present.' };
  }
  if (count > 0) {
    return { score: 1, rationale: 'Some required sections are present.' };
  }
  return { score: 0, rationale: 'No required section headings detected.' };
}

function scoreConceptTermCoverage(
  candidateTerms: readonly string[],
  noteWordSet: ReadonlySet<string>,
): { score: 0 | 1 | 2; rationale: string } {
  if (candidateTerms.length === 0) {
    return {
      score: 1,
      rationale: 'No candidate concept terms provided; assigned neutral score.',
    };
  }

  let matched = 0;
  for (const term of candidateTerms) {
    if (noteWordSet.has(term)) {
      matched += 1;
    }
  }

  const ratio = matched / candidateTerms.length;
  if (ratio >= 0.8) {
    return { score: 2, rationale: 'Strong concept term coverage detected.' };
  }
  if (ratio >= 0.4) {
    return { score: 1, rationale: 'Partial concept term coverage detected.' };
  }
  return { score: 0, rationale: 'Low concept term coverage detected.' };
}

function countLinkReferences(noteText: string): number {
  const matches = noteText.match(LINK_REFERENCE_REGEX);
  return matches ? matches.length : 0;
}

function scoreLinkReferences(noteText: string): { score: 0 | 1 | 2; rationale: string } {
  const count = countLinkReferences(noteText);
  if (count >= 2) {
    return { score: 2, rationale: 'Multiple explicit cross references detected.' };
  }
  if (count === 1) {
    return { score: 1, rationale: 'One explicit cross reference detected.' };
  }
  return { score: 0, rationale: 'No explicit cross references detected.' };
}

function extractRecallSection(noteText: string): string {
  const lines = noteText.split(/\r?\n/);
  const recallKey = normalizeLabel('Recall Question');
  let collecting = false;
  const collected: string[] = [];

  for (const line of lines) {
    const normalized = normalizeLabel(line.replace(SECTION_HEADING_PREFIX_REGEX, ''));

    if (!collecting) {
      if (normalized === recallKey || normalized.startsWith(`${recallKey} `)) {
        collecting = true;
      }
      continue;
    }

    const isHeading = REQUIRED_NOTE_SECTIONS.some((section) => {
      const sectionKey = normalizeLabel(section);
      return normalized === sectionKey || normalized.startsWith(`${sectionKey} `);
    });

    if (isHeading) {
      break;
    }

    collected.push(line);
  }

  return collected.join('\n').trim();
}

function scoreRecallQuestionQuality(noteText: string): { score: 0 | 1 | 2; rationale: string } {
  const recallSection = extractRecallSection(noteText);
  if (recallSection.length === 0) {
    return { score: 0, rationale: 'Recall question section content is missing.' };
  }

  const questionFragments = recallSection
    .split('?')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (questionFragments.length >= 2) {
    return { score: 2, rationale: 'Multiple recall prompts detected.' };
  }
  if (questionFragments.length === 1 || recallSection.includes('?')) {
    return { score: 1, rationale: 'Single recall prompt detected.' };
  }
  return { score: 0, rationale: 'Recall section contains no explicit question prompt.' };
}

function scoreClarityReadability(noteText: string): { score: 0 | 1 | 2; rationale: string } {
  const sentences = noteText
    .split(SENTENCE_SPLIT_REGEX)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const words = tokenizeWords(noteText);

  if (sentences.length === 0 || words.length === 0) {
    return { score: 0, rationale: 'Insufficient sentence structure for readability assessment.' };
  }

  const averageWordsPerSentence = words.length / sentences.length;
  const paragraphCount = noteText
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0).length;

  if (averageWordsPerSentence >= 8 && averageWordsPerSentence <= 24 && paragraphCount >= 2) {
    return { score: 2, rationale: 'Balanced sentence length and paragraph structure.' };
  }
  if (averageWordsPerSentence >= 5 && averageWordsPerSentence <= 30) {
    return {
      score: 1,
      rationale: 'Readable sentence structure with limited formatting support.',
    };
  }
  return { score: 0, rationale: 'Sentence structure suggests low readability.' };
}

function buildRubric(
  noteText: string,
  presentSections: Set<RequiredNoteSection>,
  candidateTerms: readonly string[],
  noteWordSet: ReadonlySet<string>,
): {
  criterionScores: NoteValidationOutput['criterionScores'];
  rubric: RubricCriterionBreakdown[];
} {
  const sectionCompleteness = scoreSectionCompleteness(presentSections);
  const conceptTermCoverage = scoreConceptTermCoverage(candidateTerms, noteWordSet);
  const linkReferences = scoreLinkReferences(noteText);
  const recallQuestionQuality = scoreRecallQuestionQuality(noteText);
  const clarityReadability = scoreClarityReadability(noteText);

  const criterionScores: NoteValidationOutput['criterionScores'] = {
    sectionCompleteness: sectionCompleteness.score,
    conceptTermCoverage: conceptTermCoverage.score,
    linkReferences: linkReferences.score,
    recallQuestionQuality: recallQuestionQuality.score,
    clarityReadability: clarityReadability.score,
  };

  return {
    criterionScores,
    rubric: [
      {
        criterion: 'sectionCompleteness',
        score: sectionCompleteness.score,
        rationale: sectionCompleteness.rationale,
      },
      {
        criterion: 'conceptTermCoverage',
        score: conceptTermCoverage.score,
        rationale: conceptTermCoverage.rationale,
      },
      {
        criterion: 'linkReferences',
        score: linkReferences.score,
        rationale: linkReferences.rationale,
      },
      {
        criterion: 'recallQuestionQuality',
        score: recallQuestionQuality.score,
        rationale: recallQuestionQuality.rationale,
      },
      {
        criterion: 'clarityReadability',
        score: clarityReadability.score,
        rationale: clarityReadability.rationale,
      },
    ],
  };
}

export function evaluateNoteValidation(input: NoteValidationInput): NoteValidationOutput {
  const words = tokenizeWords(input.noteText);
  const wordCount = words.length;
  const presentSections = findPresentSections(input.noteText);
  const missingSections = REQUIRED_NOTE_SECTIONS.filter((section) => !presentSections.has(section));
  const requiredSectionsPresent = missingSections.length === 0;

  const candidateTerms = deriveCandidateTerms(input.roomTopic, input.referenceTerms);
  const noteWordSet = new Set(
    words.map((word) => normalizeLabel(word)).filter((word) => word.length > 0),
  );

  const { criterionScores, rubric } = buildRubric(
    input.noteText,
    presentSections,
    candidateTerms,
    noteWordSet,
  );

  const qualityBonus =
    criterionScores.sectionCompleteness +
    criterionScores.conceptTermCoverage +
    criterionScores.linkReferences +
    criterionScores.recallQuestionQuality +
    criterionScores.clarityReadability;

  const criteria: NoteValidationOutput['criteria'] = [
    {
      code: 'VAL_WORD_COUNT_BONUS_TARGET',
      passed: wordCount >= NOTE_BADGE_WORD_COUNT,
      required: NOTE_BADGE_WORD_COUNT,
      actual: wordCount,
      message: `Bonus badge target: ${NOTE_BADGE_WORD_COUNT}+ words.`,
    },
    {
      code: 'VAL_REQUIRED_SECTION_MISSING',
      passed: requiredSectionsPresent,
      required: REQUIRED_NOTE_SECTIONS,
      actual: missingSections,
      message: 'All required note sections must be present.',
    },
    {
      code: 'VAL_MANUAL_CONFIRM_REQUIRED',
      passed: input.manualConfirmed,
      required: true,
      actual: input.manualConfirmed,
      message: 'Manual confirmation is required before completion.',
    },
  ];

  const blockingCriteriaCodes = new Set<NoteValidationOutput['criteria'][number]['code']>([
    'VAL_REQUIRED_SECTION_MISSING',
    'VAL_MANUAL_CONFIRM_REQUIRED',
  ]);

  const failedChecks = criteria
    .filter((criterion) => blockingCriteriaCodes.has(criterion.code) && !criterion.passed)
    .map((criterion) => criterion.code);
  const finalPass = failedChecks.length === 0;

  return {
    wordCount,
    requiredSectionsPresent,
    manualConfirmed: input.manualConfirmed,
    missingSections,
    failedChecks,
    criteria,
    criterionScores,
    rubric,
    qualityBonus,
    finalPass,
  };
}
