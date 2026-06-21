/**
 * Markdown syntax highlighting for textarea editors.
 *
 * Since native <textarea> doesn't support rich text, we provide a
 * lightweight syntax-highlighted overlay that mirrors the textarea
 * content. The overlay sits behind the textarea (which has a transparent
 * background) so the user gets the visual effect of highlighted text
 * while editing a real textarea.
 */

export type TokenType =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'code'
  | 'link'
  | 'image'
  | 'list'
  | 'text';

export interface HighlightToken {
  type: TokenType;
  start: number;
  end: number;
}

/**
 * Tokenize a markdown string into highlight ranges.
 * Returns an array of non-overlapping tokens (first match wins).
 */
export function tokenizeForHighlighting(source: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const covered = new Array<boolean>(source.length).fill(false);

  // Order matters: match more specific patterns first.
  const patterns: Array<{ regex: RegExp; type: TokenType }> = [
    // Headings: # Text at start of line
    { regex: /^#{1,3}\s+.+$/gm, type: 'heading' },
    // Images: ![...](...)
    { regex: /!\[([^\]]*)\]\([^)\s]+\)/g, type: 'image' },
    // Links: [...](...)
    { regex: /\[([^\]]+)\]\([^)\s]+\)/g, type: 'link' },
    // Inline code: `...`
    { regex: /`[^`\n]+`/g, type: 'code' },
    // Bold: **...**
    { regex: /\*\*[^*]+\*\*/g, type: 'bold' },
    // Italic: *...*
    { regex: /\*[^*]+\*/g, type: 'italic' },
    // List markers: - or * at line start
    { regex: /^[\t ]*[-*]\s/gm, type: 'list' },
  ];

  for (const { regex, type } of patterns) {
    let match: RegExpExecArray | null;
    // Reset lastIndex for each pattern
    regex.lastIndex = 0;
    while ((match = regex.exec(source)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Check for overlap with existing tokens
      let overlaps = false;
      for (let i = start; i < end && i < covered.length; i++) {
        if (covered[i]) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps && start < end) {
        tokens.push({ type, start, end });
        for (let i = start; i < end; i++) {
          covered[i] = true;
        }
      }
    }
  }

  return tokens.sort((a, b) => a.start - b.start);
}

/**
 * CSS class names for each token type (used in the overlay).
 */
export const HIGHLIGHT_CLASSES: Record<TokenType, string> = {
  heading: 'md-hl-heading',
  bold: 'md-hl-bold',
  italic: 'md-hl-italic',
  code: 'md-hl-code',
  link: 'md-hl-link',
  image: 'md-hl-image',
  list: 'md-hl-list',
  text: 'md-hl-text',
};

/**
 * Generate HTML for the highlight overlay from tokenized markdown.
 */
export function renderHighlightHtml(source: string, tokens: readonly HighlightToken[]): string {
  if (tokens.length === 0) return escapeHtml(source);

  let result = '';
  let lastEnd = 0;

  for (const token of tokens) {
    // Append any text before this token
    if (token.start > lastEnd) {
      result += escapeHtml(source.slice(lastEnd, token.start));
    }
    // Append the highlighted token
    const cls = HIGHLIGHT_CLASSES[token.type];
    result += `<span class="${cls}">${escapeHtml(source.slice(token.start, token.end))}</span>`;
    lastEnd = token.end;
  }

  // Append remaining text
  if (lastEnd < source.length) {
    result += escapeHtml(source.slice(lastEnd));
  }

  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}
