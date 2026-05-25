import type { CriterionScores } from '@/core/validation/persistence';

export interface ArtifactGenerationInput {
  subjectName: string;
  roomId: string;
  roomTopic: string;
  noteText: string;
  criterionScores: CriterionScores;
  qualityBonus: number;
  generatedAtIso: string;
}

export interface ArtifactMetadata {
  artifactId: string;
  artifactVersion: 'v1';
  roomId: string;
  generatedAtIso: string;
  qualityBonus: number;
  criterionScores: CriterionScores;
}

export interface ArtifactGenerationOutput {
  metadata: ArtifactMetadata;
  markdown: string;
}
