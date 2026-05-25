import { describe, expect, it } from 'vitest';
import { generateRoomArtifact } from '@/core/artifacts';

describe('generateRoomArtifact', () => {
  it('renders deterministic markdown with rubric breakdown', () => {
    const output = generateRoomArtifact({
      subjectName: 'Linear Algebra',
      roomId: 'room-1',
      roomTopic: 'Vector Spaces',
      noteText: 'Summary\nA vector space is...',
      criterionScores: {
        sectionCompleteness: 2,
        conceptTermCoverage: 1,
        linkReferences: 1,
        recallQuestionQuality: 2,
        clarityReadability: 2,
      },
      qualityBonus: 8,
      generatedAtIso: '2026-01-01T00:00:00.000Z',
    });

    expect(output.metadata.artifactId).toBe('artifact-room-1');
    expect(output.markdown).toContain('# Scribe Artifact');
    expect(output.markdown).toContain('Vector Spaces');
    expect(output.markdown).toContain('Quality Bonus: 8/10');
    expect(output.markdown).toContain('sectionCompleteness: 2/2');
  });
});
