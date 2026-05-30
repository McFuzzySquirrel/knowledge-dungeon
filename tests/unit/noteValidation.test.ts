import { describe, expect, it } from 'vitest';
import {
  NOTE_MINIMUM_WORD_COUNT,
  evaluateNoteValidation,
} from '@/core/validation/notes';

const VALID_NOTE = `Summary
${'Vector spaces are sets equipped with addition and scalar multiplication. '.repeat(8)}

Key Points
- A vector space requires closure under addition.
- A vector space requires closure under scalar multiplication.
- The zero vector must belong to the space.

Recall Question
What are the four axioms of vector spaces, and how do they apply to polynomial spaces? See also [related topic](#).
`;

describe('evaluateNoteValidation', () => {
  it('passes a complete, manually-confirmed note', () => {
    const result = evaluateNoteValidation({
      noteText: VALID_NOTE,
      manualConfirmed: true,
      roomTopic: 'Vector Spaces',
    });
    expect(result.wordCount).toBeGreaterThanOrEqual(NOTE_MINIMUM_WORD_COUNT);
    expect(result.requiredSectionsPresent).toBe(true);
    expect(result.finalPass).toBe(true);
    expect(result.failedChecks).toHaveLength(0);
  });

  it('does not fail when word count is below the bonus target', () => {
    const result = evaluateNoteValidation({
      noteText: 'Summary\nKey Points\nRecall Question\n?',
      manualConfirmed: true,
      roomTopic: 'Vector Spaces',
    });
    expect(result.finalPass).toBe(true);
    expect(result.failedChecks).not.toContain('VAL_WORD_COUNT_BONUS_TARGET');
    const wordBonus = result.criteria.find((c) => c.code === 'VAL_WORD_COUNT_BONUS_TARGET');
    expect(wordBonus?.passed).toBe(false);
  });

  it('fails when manual confirmation is missing', () => {
    const result = evaluateNoteValidation({
      noteText: VALID_NOTE,
      manualConfirmed: false,
      roomTopic: 'Vector Spaces',
    });
    expect(result.failedChecks).toContain('VAL_MANUAL_CONFIRM_REQUIRED');
    expect(result.finalPass).toBe(false);
  });

  it('reports missing required sections', () => {
    const note = 'Summary\n' + 'word '.repeat(200);
    const result = evaluateNoteValidation({
      noteText: note,
      manualConfirmed: true,
      roomTopic: 'Anything',
    });
    expect(result.missingSections).toContain('Key Points');
    expect(result.missingSections).toContain('Recall Question');
    expect(result.failedChecks).toContain('VAL_REQUIRED_SECTION_MISSING');
  });
});
