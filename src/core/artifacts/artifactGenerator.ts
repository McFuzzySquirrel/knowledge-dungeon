import type { ArtifactGenerationInput, ArtifactGenerationOutput } from './types';

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function trimTrailingWhitespace(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function createArtifactId(roomId: string): string {
  return `artifact-${roomId.toLocaleLowerCase()}`;
}

function buildScoreLines(input: ArtifactGenerationInput): string[] {
  const { criterionScores } = input;
  return [
    `- sectionCompleteness: ${criterionScores.sectionCompleteness}/2`,
    `- conceptTermCoverage: ${criterionScores.conceptTermCoverage}/2`,
    `- linkReferences: ${criterionScores.linkReferences}/2`,
    `- recallQuestionQuality: ${criterionScores.recallQuestionQuality}/2`,
    `- clarityReadability: ${criterionScores.clarityReadability}/2`,
  ];
}

export function generateRoomArtifact(input: ArtifactGenerationInput): ArtifactGenerationOutput {
  const artifactId = createArtifactId(input.roomId);
  const normalizedNote = trimTrailingWhitespace(normalizeLineEndings(input.noteText));

  const markdown = [
    '# Scribe Artifact',
    '',
    `- Artifact ID: ${artifactId}`,
    `- Subject: ${input.subjectName}`,
    `- Topic: ${input.roomTopic}`,
    `- Room ID: ${input.roomId}`,
    `- Generated At: ${input.generatedAtIso}`,
    `- Quality Bonus: ${input.qualityBonus}/10`,
    '',
    '## Rubric Breakdown',
    ...buildScoreLines(input),
    '',
    '## Submitted Notes',
    '',
    normalizedNote.length > 0 ? normalizedNote : '(No note content)',
    '',
  ].join('\n');

  return {
    metadata: {
      artifactId,
      artifactVersion: 'v1',
      roomId: input.roomId,
      generatedAtIso: input.generatedAtIso,
      qualityBonus: input.qualityBonus,
      criterionScores: { ...input.criterionScores },
    },
    markdown,
  };
}
