/**
 * Minimal, safe markdown renderer for note/artifact text.
 *
 * Supports a tiny subset of Markdown so users can author rich notes with
 * clickable links:
 *  - ATX headings (`#` .. `###`)
 *  - Paragraphs (blank-line separated)
 *  - Unordered lists (`-` or `*` prefixed lines)
 *  - Inline `**bold**`, `*italic*`, `` `code` ``
 *  - Explicit `[label](href)` links
 *  - Bare http(s) URLs auto-linked
 *
 * Anything not recognised is rendered as plain text, so unsupported syntax
 * shows through verbatim instead of being silently dropped. Links are only
 * rendered for http/https/mailto schemes to avoid `javascript:` style XSS,
 * and they open in a new tab with `noopener noreferrer`.
 */
import type { JSX, ReactNode } from 'react';

const SAFE_PROTOCOL = /^(https?:|mailto:)/i;
const BARE_URL = /\bhttps?:\/\/[^\s<>()\][]+/g;
// `[label](href)` — non-greedy label, href stops at whitespace or `)`.
const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BOLD = /\*\*([^*]+)\*\*/g;
const ITALIC = /(^|[^*])\*([^*]+)\*/g;
const CODE = /`([^`]+)`/g;

interface Token {
  type: 'text' | 'link' | 'bold' | 'italic' | 'code';
  text: string;
  href?: string;
}

function escapeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!SAFE_PROTOCOL.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse a single line of text into inline tokens (links, emphasis, code).
 * Done in passes by replacing matches with placeholders to avoid having
 * to write a full grammar.
 */
function tokenizeInline(line: string): Token[] {
  const tokens: Token[] = [];
  const placeholders: Token[] = [];
  const PH = (i: number) => `\u0000${i}\u0000`;

  let working = line;

  // Explicit markdown links first so bare-URL pass doesn't double-link them.
  working = working.replace(MD_LINK, (_match, label: string, href: string) => {
    const safe = escapeHref(href);
    if (!safe) return label;
    placeholders.push({ type: 'link', text: label, href: safe });
    return PH(placeholders.length - 1);
  });

  // Bare URLs.
  working = working.replace(BARE_URL, (match: string) => {
    const safe = escapeHref(match);
    if (!safe) return match;
    placeholders.push({ type: 'link', text: match, href: safe });
    return PH(placeholders.length - 1);
  });

  // Inline code (before emphasis so `*foo*` inside code stays literal).
  working = working.replace(CODE, (_match, text: string) => {
    placeholders.push({ type: 'code', text });
    return PH(placeholders.length - 1);
  });

  // Bold then italic.
  working = working.replace(BOLD, (_match, text: string) => {
    placeholders.push({ type: 'bold', text });
    return PH(placeholders.length - 1);
  });
  working = working.replace(ITALIC, (_match, lead: string, text: string) => {
    placeholders.push({ type: 'italic', text });
    return `${lead}${PH(placeholders.length - 1)}`;
  });

  // Split on the placeholder separator and reconstitute.
  const parts = working.split(/\u0000(\d+)\u0000/);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 1) {
      const ref = placeholders[Number(part)];
      if (ref) tokens.push(ref);
      continue;
    }
    if (part.length > 0) tokens.push({ type: 'text', text: part });
  }

  return tokens;
}

function renderInline(line: string, keyBase: string): ReactNode[] {
  return tokenizeInline(line).map((token, idx) => {
    const key = `${keyBase}-${idx}`;
    switch (token.type) {
      case 'link':
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {token.text}
          </a>
        );
      case 'bold':
        return <strong key={key}>{token.text}</strong>;
      case 'italic':
        return <em key={key}>{token.text}</em>;
      case 'code':
        return <code key={key}>{token.text}</code>;
      default:
        return <span key={key}>{token.text}</span>;
    }
  });
}

interface Block {
  type: 'heading' | 'paragraph' | 'list';
  level?: 1 | 2 | 3;
  lines: string[];
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let listBuffer: string[] = [];

  const flushParagraph = () => {
    if (buffer.length === 0) return;
    blocks.push({ type: 'paragraph', lines: buffer });
    buffer = [];
  };
  const flushList = () => {
    if (listBuffer.length === 0) return;
    blocks.push({ type: 'list', lines: listBuffer });
    listBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/u, '');
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, lines: [headingMatch[2]] });
      continue;
    }
    const listMatch = /^[-*]\s+(.+)$/.exec(line.trim());
    if (listMatch) {
      flushParagraph();
      listBuffer.push(listMatch[1]);
      continue;
    }
    flushList();
    buffer.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

interface MarkdownProps {
  source: string;
  className?: string;
}

export function Markdown({ source, className }: MarkdownProps): JSX.Element {
  const blocks = parseBlocks(source);
  return (
    <div className={className ?? 'markdown-body'}>
      {blocks.map((block, idx) => {
        const key = `b-${idx}`;
        if (block.type === 'heading') {
          const text = block.lines[0] ?? '';
          const children = renderInline(text, key);
          if (block.level === 1) return <h3 key={key}>{children}</h3>;
          if (block.level === 2) return <h4 key={key}>{children}</h4>;
          return <h5 key={key}>{children}</h5>;
        }
        if (block.type === 'list') {
          return (
            <ul key={key}>
              {block.lines.map((line, li) => (
                <li key={`${key}-${li}`}>{renderInline(line, `${key}-${li}`)}</li>
              ))}
            </ul>
          );
        }
        // paragraph: preserve hard line breaks within
        return (
          <p key={key}>
            {block.lines.map((line, li) => (
              <span key={`${key}-${li}`}>
                {renderInline(line, `${key}-${li}`)}
                {li < block.lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
