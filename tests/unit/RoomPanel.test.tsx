import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useSessionStore } from '@/store/sessionStore';
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
    useSessionStore.setState({ phase: 'scribe' });
    const snapshot = createSnapshot();
    const focusedRoom = snapshot.rooms['room-1'];

    render(
      <RoomPanel
        snapshot={snapshot}
        focusedRoom={focusedRoom}
        onInteract={() => undefined}
        onClose={() => undefined}
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
    useSessionStore.setState({ phase: 'scribe' });
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
        onClose={() => undefined}
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
    useSessionStore.setState({ phase: 'scribe' });
    const snapshot = createSnapshot();

    render(
      <RoomPanel
        snapshot={snapshot}
        focusedRoom={snapshot.rooms['room-1']}
        onInteract={() => undefined}
        onClose={() => undefined}
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
    useSessionStore.setState({ phase: 'scribe' });
    const snapshot = createSnapshot();

    render(
      <RoomPanel
        snapshot={snapshot}
        focusedRoom={snapshot.rooms['room-1']}
        onInteract={() => undefined}
        onClose={() => undefined}
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

  it('keeps creator focus on topic editing until the tools menu is opened', () => {
    useSessionStore.setState({ phase: 'creator' });
    const snapshot = createSnapshot();

    render(
      <RoomPanel
        snapshot={snapshot}
        focusedRoom={snapshot.rooms['room-1']}
        onInteract={() => undefined}
        onClose={() => undefined}
        onTravelToRoom={() => undefined}
        reviewPassesCompleted={0}
        reviewRoomsTowardNextPass={0}
        reviewNextPassTarget={1}
        reviewTotalRooms={1}
      />,
    );

    expect(screen.getByRole('button', { name: /Add child rooms/i })).toBeInTheDocument();
    expect(screen.queryByText(/Floor:/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Show room tools/i }));
    expect(screen.getByText(/Floor:/i)).toBeInTheDocument();
  });

  it('keeps archaeologist review focused on notes until the tools menu is opened', () => {
    useSessionStore.setState({ phase: 'archaeologist' });
    const snapshot = createSnapshot();

    render(
      <RoomPanel
        snapshot={snapshot}
        focusedRoom={snapshot.rooms['room-1']}
        onInteract={() => undefined}
        onClose={() => undefined}
        onTravelToRoom={() => undefined}
        reviewPassesCompleted={0}
        reviewRoomsTowardNextPass={0}
        reviewNextPassTarget={1}
        reviewTotalRooms={1}
      />,
    );

    expect(screen.getByRole('button', { name: 'Done reviewing' })).toBeInTheDocument();
    expect(screen.queryByText(/Quality bonus:/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Show room tools/i }));
    expect(screen.getByText(/Quality bonus:/i)).toBeInTheDocument();
  });
});