/**
 * Markdown auto-complete suggestions for the note editor.
 *
 * Provides context-aware suggestions based on the current cursor position
 * in the markdown text. Supports:
 *   - Markdown syntax snippets (bold, italic, links, images, headings, lists)
 *   - Section headers (standard note sections)
 *   - Hashtag suggestions (#keyword)
 */

export interface AutoCompleteSuggestion {
  /** Display text shown in the suggestion list. */
  label: string;
  /** Text to insert at the cursor position. */
  insertText: string;
  /** Short description of the suggestion. */
  description: string;
  /** Category for grouping. */
  category: 'syntax' | 'section' | 'link' | 'tag';
}

const MARKDOWN_SYNTAX_SUGGESTIONS: AutoCompleteSuggestion[] = [
  {
    label: '**bold**',
    insertText: '**bold text**',
    description: 'Bold text',
    category: 'syntax',
  },
  {
    label: '*italic*',
    insertText: '*italic text*',
    description: 'Italic text',
    category: 'syntax',
  },
  {
    label: '[link](url)',
    insertText: '[link text](https://)',
    description: 'Markdown link',
    category: 'link',
  },
  {
    label: '![image](url)',
    insertText: '![alt text](https://)',
    description: 'Markdown image',
    category: 'link',
  },
  {
    label: '`code`',
    insertText: '`code`',
    description: 'Inline code',
    category: 'syntax',
  },
  {
    label: '- list',
    insertText: '- ',
    description: 'List item',
    category: 'syntax',
  },
  {
    label: '## Heading',
    insertText: '## ',
    description: 'Level 2 heading',
    category: 'syntax',
  },
  {
    label: '### Subheading',
    insertText: '### ',
    description: 'Level 3 heading',
    category: 'syntax',
  },
  {
    label: '> Quote',
    insertText: '> ',
    description: 'Block quote',
    category: 'syntax',
  },
  {
    label: '---',
    insertText: '\n---\n',
    description: 'Horizontal rule',
    category: 'syntax',
  },
];

/**
 * Get auto-complete suggestions based on the text before the cursor.
 */
export function getSuggestions(
  textBeforeCursor: string,
  _fullText: string,
  _cursorPosition: number,
): AutoCompleteSuggestion[] {
  const trimmed = textBeforeCursor.trimStart();

  // Hash-tag based suggestion
  if (trimmed.endsWith('#') && !trimmed.endsWith('##') && !trimmed.endsWith('###')) {
    return [
      {
        label: '#keyword',
        insertText: 'keyword',
        description: 'Tag a keyword',
        category: 'tag',
      },
    ];
  }

  // Heading trigger: if line starts with #, suggest heading formats
  const lastLine = textBeforeCursor.split('\n').pop() ?? '';
  if (lastLine === '#' || lastLine === '##' || lastLine === '###') {
    return [
      {
        label: '# Topic',
        insertText: '# ',
        description: 'Level 1 heading',
        category: 'syntax',
      },
      {
        label: '## Section',
        insertText: '## ',
        description: 'Level 2 heading',
        category: 'syntax',
      },
      {
        label: '### Subsection',
        insertText: '### ',
        description: 'Level 3 heading',
        category: 'syntax',
      },
    ];
  }

  // Link trigger: display when [ is typed
  if (textBeforeCursor.endsWith('[')) {
    return MARKDOWN_SYNTAX_SUGGESTIONS.filter((s) => s.category === 'link');
  }

  // Image trigger
  if (textBeforeCursor.endsWith('![')) {
    return [
      {
        label: '![alt](url)',
        insertText: 'alt text](https://)',
        description: 'Insert image',
        category: 'link',
      },
    ];
  }

  // If the text is mostly empty or triggerless, show formatting syntax
  if (trimmed.length < 3) {
    return MARKDOWN_SYNTAX_SUGGESTIONS;
  }

  return MARKDOWN_SYNTAX_SUGGESTIONS;
}

/**
 * Default auto-complete trigger characters.
 */
export const AUTOCOMPLETE_TRIGGERS = ['#', '[', '!', '-', '*', '`', '>'];

/**
 * Check if a character should trigger auto-complete.
 */
export function isAutocompleteTrigger(char: string): boolean {
  return AUTOCOMPLETE_TRIGGERS.includes(char);
}
