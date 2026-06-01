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
    expect(screen.getByText(/Open map tools to add rooms/i)).toBeInTheDocument();
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
});
