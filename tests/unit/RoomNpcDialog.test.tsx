import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoomNpcDialog } from '@/ui/components/RoomNpcDialog';

describe('RoomNpcDialog', () => {
  it('shows creator guidance for created rooms', () => {
    render(
      <RoomNpcDialog
        topic="Vector Spaces"
        phase="creator"
        roomState="Created"
        isCleared={false}
      />,
    );

    expect(screen.getByText(/Creator Brief: Vector Spaces/i)).toBeInTheDocument();
    expect(screen.getByText(/Press E to open topic activities for this room/i)).toBeInTheDocument();
  });

  it('shows archaeologist fallback guidance when room is uncleared', () => {
    render(
      <RoomNpcDialog
        topic="Matrix Multiplication"
        phase="archaeologist"
        roomState="NeedsRevalidation"
        isCleared={false}
      />,
    );

    expect(screen.getByText(/not ready for review passes/i)).toBeInTheDocument();
    expect(screen.getByText(/Switch to Scribe phase first/i)).toBeInTheDocument();
  });

  it('switches to anchored mode when an NPC anchor position is provided', () => {
    render(
      <RoomNpcDialog
        topic="Matrix Multiplication"
        phase="scribe"
        roomState="Created"
        isCleared={false}
        anchorPosition={{ x: 420, y: 260 }}
      />,
    );

    const dialog = screen.getByRole('status', { name: 'Room guide' });
    expect(dialog.className).toContain('npc-dialog--anchored');
  });
});
