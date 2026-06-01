import {
  REQUIRED_NOTE_SECTIONS,
  type RequiredNoteSection,
} from '@/core/validation/notes';

export type NoteSections = Record<RequiredNoteSection, string>;

const SECTION_HEADING_PREFIX_REGEX = /^\s{0,3}(?:#{1,6}\s*)?/;

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionForLine(line: string): RequiredNoteSection | null {
  const normalized = normalizeLabel(line.replace(SECTION_HEADING_PREFIX_REGEX, ''));

  for (const section of REQUIRED_NOTE_SECTIONS) {
    const expected = normalizeLabel(section);
    if (normalized === expected) {
      return section;
    }
  }

  return null;
}

export function emptyNoteSections(): NoteSections {
  return {
    Summary: '',
    'Key Points': '',
    'Recall Question': '',
  };
}

export function extractNoteSections(noteText: string): NoteSections {
  const sections = emptyNoteSections();
  const buffers: Record<RequiredNoteSection, string[]> = {
    Summary: [],
    'Key Points': [],
    'Recall Question': [],
  };
  const preamble: string[] = [];

  let current: RequiredNoteSection | null = null;
  for (const line of noteText.split(/\r?\n/)) {
    const matched = sectionForLine(line);
    if (matched) {
      current = matched;
      continue;
    }

    if (current) {
      buffers[current].push(line);
    } else if (line.trim().length > 0) {
      preamble.push(line);
    }
  }

  if (preamble.length > 0) {
    buffers.Summary.push(...preamble, '');
  }

  for (const section of REQUIRED_NOTE_SECTIONS) {
    sections[section] = buffers[section].join('\n').trim();
  }

  return sections;
}

export function composeNoteSections(sections: NoteSections): string {
  return REQUIRED_NOTE_SECTIONS.map((section) => {
    const body = sections[section].trim();
    return body.length > 0 ? `${section}\n${body}` : `${section}\n`;
  }).join('\n\n');
}
