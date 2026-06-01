import { describe, expect, it } from 'vitest';
import {
  composeNoteSections,
  emptyNoteSections,
  extractNoteSections,
} from '@/ui/utils/noteSections';

describe('noteSections', () => {
  it('extracts section bodies from a canonical note', () => {
    const sections = extractNoteSections(
      [
        'Summary',
        'Summary body',
        '',
        'Key Points',
        '- Alpha',
        '- Beta',
        '',
        'Recall Question',
        'Why does this matter?',
      ].join('\n'),
    );

    expect(sections.Summary).toBe('Summary body');
    expect(sections['Key Points']).toBe('- Alpha\n- Beta');
    expect(sections['Recall Question']).toBe('Why does this matter?');
  });

  it('puts unsectioned text into Summary', () => {
    const sections = extractNoteSections('Loose line one\nLoose line two');
    expect(sections.Summary).toContain('Loose line one');
    expect(sections.Summary).toContain('Loose line two');
  });

  it('always composes required headings', () => {
    const sections = emptyNoteSections();
    sections.Summary = 'One paragraph';

    const composed = composeNoteSections(sections);

    expect(composed).toContain('Summary\nOne paragraph');
    expect(composed).toContain('Key Points');
    expect(composed).toContain('Recall Question');
  });
});
