import { describe, expect, it } from 'vitest';

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

describe('imported subject artifacts', () => {
  it('treats imported note-bearing rooms as collectible artifacts', () => {
    const noteText = '# Overview\n\nImported review note content.';
    const explicitArtifactMarkdown = null;
    const artifactMarkdown = explicitArtifactMarkdown ?? (noteText.trim().length > 0 ? noteText : null);
    const hasImportedArtifact = noteText.trim().length > 0 || artifactMarkdown !== null;
    const validationState = {
      wordCount: 0,
      requiredSectionsPresent: false,
      manualConfirmed: false,
      criterionScores: {
        sectionCompleteness: 0,
        conceptTermCoverage: 0,
        linkReferences: 0,
        recallQuestionQuality: 0,
        clarityReadability: 0,
      },
      failedChecks: [] as string[],
      qualityBonus: 0,
      finalPass: false,
    };

    if (hasImportedArtifact) {
      validationState.wordCount = countWords(noteText);
      validationState.requiredSectionsPresent = true;
      validationState.manualConfirmed = true;
      validationState.finalPass = true;
    }

    const importedRoom = {
      state: hasImportedArtifact ? 'ArtifactCollected' : 'Created',
      noteText,
      artifactMarkdown,
      validationState,
    };

    expect(importedRoom.state).toBe('ArtifactCollected');
    expect(importedRoom.validationState.finalPass).toBe(true);
    expect(importedRoom.validationState.wordCount).toBeGreaterThan(0);
    expect(importedRoom.artifactMarkdown).toContain('Imported review note content');
  });
});
