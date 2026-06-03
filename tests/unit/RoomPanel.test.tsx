import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SubjectSnapshot } from '@/core/validation/persistence';
import { RoomPanel } from '@/ui/components/RoomPanel';

function createSnapshot(): SubjectSnapshot {
  return {
    dungeon: {
      schemaVersion: '1.0.0',
      dungeonId: 'subject-1',
      subjectName: 'Imported Subject',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
      phaseState: 'CreatorActive',
      rootRoomId: 'room-1',
      rooms: [{ roomId: 'room-1', topic: 'Core Concepts', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [] },
    },
    rooms: {
      'room-1': {
        roomId: 'room-1',
        topic: 'Core Concepts',
        createdAt: '2026-05-30T00:00:00.000Z',
        updatedAt: '2026-05-30T00:00:00.000Z',
        state: 'Created',
        notePath: 'rooms/room-1/notes.txt',
        artifactPath: 'rooms/room-1/artifact.md',
        noteText: 'Imported note content',
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
        attachments: [],
      },
    },
  };
}

describe('RoomPanel', () => {
  it('renders imported note text even when validation count is zero', () => {
    const snapshot = createSnapshot();
    const focusedRoom = snapshot.rooms['room-1'];

    render(
      <RoomPanel
        snapshot={snapshot}
        focusedRoom={focusedRoom}
        onInteract={() => undefined}
        onTravelToRoom={() => undefined}
        reviewPassesCompleted={0}
        reviewRoomsTowardNextPass={0}
        reviewNextPassTarget={1}
        reviewTotalRooms={1}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));

    expect(screen.getByText('Imported note content')).toBeInTheDocument();
    expect(screen.queryByText(/No notes drafted yet/i)).toBeNull();
  });

  it('shows local-image fallback text when attachment token cannot be resolved', () => {
    const snapshot = createSnapshot();
    snapshot.rooms['room-1'] = {
      ...snapshot.rooms['room-1'],
      noteText: '![Missing artifact](local:att-missing)',
    };

    render(
      <RoomPanel
        snapshot={snapshot}
        focusedRoom={snapshot.rooms['room-1']}
        onInteract={() => undefined}
        onTravelToRoom={() => undefined}
        reviewPassesCompleted={0}
        reviewRoomsTowardNextPass={0}
        reviewNextPassTarget={1}
        reviewTotalRooms={1}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(
      screen.getByText(/Missing image \(att-missing\)\. Reattach it or remove this token\./i),
    ).toBeInTheDocument();
  });

  it('shows lock messaging and archaeologist progress card for uncleared rooms', () => {
    const snapshot = createSnapshot();

    render(
      <RoomPanel
        snapshot={snapshot}
        focusedRoom={snapshot.rooms['room-1']}
        onInteract={() => undefined}
        onTravelToRoom={() => undefined}
        reviewPassesCompleted={0}
        reviewRoomsTowardNextPass={0}
        reviewNextPassTarget={1}
        reviewTotalRooms={1}
      />,
    );

    expect(
      screen.getByText(/Artifact and Self-check unlock after you defeat this room encounter\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Archaeologist unlock: 0\/1 rooms cleared/i),
    ).toBeInTheDocument();
  });

  it('drags the panel when using the drag handle', () => {
    const snapshot = createSnapshot();

    render(
      <RoomPanel
        snapshot={snapshot}
        focusedRoom={snapshot.rooms['room-1']}
        onInteract={() => undefined}
        onTravelToRoom={() => undefined}
        reviewPassesCompleted={0}
        reviewRoomsTowardNextPass={0}
        reviewNextPassTarget={1}
        reviewTotalRooms={1}
      />,
    );

    const panel = screen.getByLabelText('Room information');
    const handle = screen.getByTestId('room-panel-drag-handle');

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 220, clientY: 140 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 360, clientY: 260 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(panel.getAttribute('style')).toContain('left:');
    expect(panel.getAttribute('style')).toContain('top:');
  });
});