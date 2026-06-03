import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NoteEditorModal } from '@/ui/components/NoteEditorModal';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import type { RoomAttachment, SubjectSnapshot } from '@/core/validation/persistence';

function makeSnapshot({
  attachments = [],
}: {
  attachments?: RoomAttachment[];
} = {}): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: '1.0.0',
      dungeonId: 'subject-1',
      subjectName: 'Linear Algebra',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      phaseState: 'ScribeActive',
      rootRoomId: 'room-1',
      rooms: [{ roomId: 'room-1', topic: 'Vector Spaces', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      'room-1': {
        roomId: 'room-1',
        topic: 'Vector Spaces',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        state: 'Created',
        notePath: 'rooms/room-1/notes.md',
        artifactPath: 'rooms/room-1/artifact.md',
        noteText: '',
        artifactMarkdown: null,
        validationState: {
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
          failedChecks: [],
          qualityBonus: 0,
          finalPass: false,
        },
        reviewPassCount: 0,
        attachments,
      },
    },
  };
}

describe('NoteEditorModal', () => {
  beforeEach(() => {
    useSubjectStore.setState({ snapshot: makeSnapshot(), lastError: null });
    useSessionStore.setState({
      isNoteEditorOpen: true,
      noteEditorRoomId: 'room-1',
      noteEditorPendingInsert: null,
    });
  });

  it('shows a neutral checklist on first open before edits', () => {
    render(<NoteEditorModal />);

    expect(
      screen.getByText(/Keep headings: Summary, Key Points, Recall Question/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tick confirmation when your draft is ready to submit/i),
    ).toBeInTheDocument();
  });

  it('shows explicit missing requirements after editing', () => {
    render(<NoteEditorModal />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'A short draft only.' },
    });

    expect(
      screen.getByText(/Add notes in: Key Points, Recall Question\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Check the confirmation box before defeating this encounter\./i),
    ).toBeInTheDocument();
  });

  it('preserves content while switching between section chips', () => {
    render(<NoteEditorModal />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Summary draft text' },
    });

    fireEvent.click(screen.getByRole('tab', { name: /Key Points/i }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '- Point A' },
    });

    fireEvent.click(screen.getByRole('tab', { name: /Summary/i }));
    expect(screen.getByRole('textbox')).toHaveValue('Summary draft text');
  });

  it('applies pending inserts into the active section editor', () => {
    useSessionStore.setState({ noteEditorPendingInsert: '![diagram](local:asset-1)' });
    render(<NoteEditorModal />);

    expect(screen.getByRole('textbox')).toHaveValue('![diagram](local:asset-1)');
  });

  it('keeps the image library collapsed until expanded', () => {
    useSubjectStore.setState({
      snapshot: makeSnapshot({
        attachments: [
          {
            attachmentId: 'ext-1',
            sourceType: 'external',
            fileName: 'diagram.png',
            mimeType: 'image/png',
            externalUrl: 'https://example.com/diagram.png',
            addedAt: '2026-06-01T00:00:00.000Z',
          },
        ],
      }),
    });
    render(<NoteEditorModal />);

    expect(screen.getByRole('button', { name: /Show image library \(1\)/i })).toBeInTheDocument();
    expect(screen.queryByText('diagram.png')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show image library \(1\)/i }));
    expect(screen.getByText('diagram.png')).toBeInTheDocument();
  });
});
