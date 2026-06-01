import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SCRIBE_CENTURY_120_BADGE_ID } from '@/core/progression';
import { InventoryBadgesPanel } from '@/ui/components/InventoryBadgesPanel';

describe('InventoryBadgesPanel', () => {
  it('renders empty inventory placeholder when no items are present', () => {
    render(
      <InventoryBadgesPanel
        view="inventory"
        inventory={[]}
        badges={[]}
        collectedNotes={[]}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={0}
        rank="Novice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/No loot yet/i)).toBeInTheDocument();
  });

  it('renders badges when present', () => {
    render(
      <InventoryBadgesPanel
        view="badges"
        inventory={[]}
        badges={['First Steps']}
        collectedNotes={[]}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('First Steps')).toBeInTheDocument();
    expect(screen.getByText('Apprentice')).toBeInTheDocument();
  });

  it('renders a friendly label for the 120-word badge id', () => {
    render(
      <InventoryBadgesPanel
        view="badges"
        inventory={[]}
        badges={[SCRIBE_CENTURY_120_BADGE_ID]}
        collectedNotes={[]}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Scribe Century (120+ Words)')).toBeInTheDocument();
  });

  it('renders description for archaeologist milestone badges', () => {
    render(
      <InventoryBadgesPanel
        view="badges"
        inventory={[]}
        badges={['ArchaeologistReviewPass7']}
        collectedNotes={[]}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('ArchaeologistReviewPass7')).toBeInTheDocument();
    expect(
      screen.getByText('Completed at least 7 full archaeology review passes.'),
    ).toBeInTheDocument();
  });

  it('renders collected notes journal entries', () => {
    render(
      <InventoryBadgesPanel
        view="journal"
        inventory={[]}
        badges={[]}
        collectedNotes={[
          {
            noteId: 'dungeon:room-1',
            dungeonId: 'dungeon',
            roomId: 'room-1',
            topic: 'Vector Spaces',
            floorLabel: 'Linear Algebra',
            artifactPreview: 'A concise artifact summary.',
            noteMarkdown: '## Key ideas\nA full encounter note.',
            artifactMarkdown: '## Key ideas\nA full artifact note.',
            collectedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Vector Spaces')).toBeInTheDocument();
    expect(screen.getByText('Linear Algebra')).toBeInTheDocument();
  });

  it('opens full collected note content from the diary list', () => {
    render(
      <InventoryBadgesPanel
        view="journal"
        inventory={[]}
        badges={[]}
        collectedNotes={[
          {
            noteId: 'dungeon:room-1',
            dungeonId: 'dungeon',
            roomId: 'room-1',
            topic: 'Vector Spaces',
            floorLabel: 'Linear Algebra',
            artifactPreview: 'A concise artifact summary.',
            noteMarkdown: '## Key ideas\nA full encounter note for recall.',
            artifactMarkdown: '## Key ideas\nA full artifact note for recall.',
            collectedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        subjectName="Linear Algebra"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Vector Spaces' }));
    expect(screen.getByText('A full encounter note for recall.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to journal' })).toBeInTheDocument();
  });

  it('auto-opens a collected note when autoOpenNoteId is provided', () => {
    render(
      <InventoryBadgesPanel
        view="journal"
        inventory={[]}
        badges={[]}
        collectedNotes={[
          {
            noteId: 'dungeon:room-2',
            dungeonId: 'dungeon',
            roomId: 'room-2',
            topic: 'Graph Traversal',
            floorLabel: 'Algorithms',
            artifactPreview: 'Traversal summary',
            noteMarkdown: '## Summary\nDepth-first and breadth-first traversal notes.',
            artifactMarkdown: '## Summary\nArtifact fallback text.',
            collectedAt: '2026-01-02T00:00:00.000Z',
          },
        ]}
        autoOpenNoteId="dungeon:room-2"
        subjectName="Algorithms"
        clearedRoomCount={0}
        totalRoomCount={1}
        xpTotal={10}
        rank="Novice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText('Depth-first and breadth-first traversal notes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to journal' })).toBeInTheDocument();
  });
});
