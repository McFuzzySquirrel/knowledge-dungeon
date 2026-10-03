/**
 * The rollback lane: with `VITE_CREATOR_WORKSPACE` false, the pre-Phase-14 Creator view.
 *
 * ## What is being held here
 *
 * Phase 14's rollback line is "retain the existing RoomPanel Creator view behind the phase
 * flag", which means two things, and only the first is a rendering question:
 *
 * 1. **The old view still renders.** `RoomPanel` shows the same controls in the same place.
 * 2. **The old path still works.** This is the half that matters, and it is why the last
 *    test in this file does not stop at "a button is there": it clicks the legacy
 *    "Add child rooms" control and asserts the *store* grew a child room. That path runs
 *    `useSubjectStore.addChildRooms` - the pre-Phase-14 action, which calls `src/core/graph`
 *    and does its own revalidation propagation - and not the new application layer. A
 *    rollback that renders but no longer mutates would be a worse bug than the phase it
 *    rolls back.
 *
 * The flag is mocked explicitly rather than left at its default, so this file fails if the
 * default ever changes instead of silently testing the new lane.
 */
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/persistence/subjectPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/persistence/subjectPersistence')>();
  return { ...actual, saveSubjectSnapshot: vi.fn(async () => ({ success: true })) };
});

vi.mock('@/config/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/featureFlags')>();
  return {
    ...actual,
    runtimeConfig: { ...actual.runtimeConfig, creatorWorkspace: false },
  };
});

import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { RoomPanel } from '@/ui/components/RoomPanel';
import { childrenOf, buildCreatorFixture, type CreatorFixture } from './support/creatorFixtures';

let fixture: CreatorFixture;

function panel(roomId: string): ReactElement {
  const snapshot = useSubjectStore.getState().snapshot;
  if (snapshot === null) throw new Error('No snapshot installed');
  return (
    <RoomPanel
      snapshot={snapshot}
      focusedRoom={snapshot.rooms[roomId] ?? null}
      onInteract={() => undefined}
      onClose={() => undefined}
      onTravelToRoom={() => undefined}
      reviewPassesCompleted={0}
      reviewRoomsTowardNextPass={0}
      reviewNextPassTarget={1}
      reviewTotalRooms={1}
    />
  );
}

beforeEach(() => {
  fixture = buildCreatorFixture();
  useSubjectStore.setState({ snapshot: fixture.snapshot, lastError: null });
  useSessionStore.setState({ phase: 'creator', selectedClass: null, focusedRoomId: fixture.rootRoomId });
});

afterEach(() => {
  cleanup();
});

describe('the flag-off Creator lane', () => {
  it('renders the pre-Phase-14 Creator view, not the workspace', () => {
    render(panel(fixture.rootRoomId));

    expect(screen.queryByLabelText('Creator workspace')).toBeNull();
    expect(screen.getByRole('button', { name: /Add child rooms/i })).toBeInTheDocument();
    // The tools menu behaviour is unchanged: the floor line is behind the `⋯` button.
    expect(screen.queryByText(/Floor:/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show room tools/i }));
    expect(screen.getByText(/Floor:/i)).toBeInTheDocument();
  });

  it('keeps the legacy room picker on "the room you are standing in"', () => {
    render(panel(fixture.matrixRoomId));

    expect(screen.getByRole('heading', { name: 'Matrices' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add child rooms/i })).toBeInTheDocument();
  });

  it('still mutates through the pre-Phase-14 store actions', async () => {
    render(panel(fixture.rootRoomId));

    const before = useSubjectStore.getState().snapshot;
    if (before === null) throw new Error('No snapshot installed');
    expect(childrenOf(before, fixture.rootRoomId)).toHaveLength(3);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tensors, Eigenvectors' } });
    fireEvent.click(screen.getByRole('button', { name: /Add child rooms/i }));

    // The store action is async and persists before it resolves; the assertion waits for
    // the state it writes rather than for the click to return.
    await vi.waitFor(() => {
      const after = useSubjectStore.getState().snapshot;
      if (after === null) throw new Error('No snapshot installed');
      expect(childrenOf(after, fixture.rootRoomId)).toHaveLength(5);
    });

    const after = useSubjectStore.getState().snapshot;
    if (after === null) throw new Error('No snapshot installed');
    // Bulk creation is preserved: two topics typed as one list become two rooms.
    expect(after.dungeon.rooms.filter((room) => room.topic === 'Tensors')).toHaveLength(1);
    expect(after.dungeon.rooms.filter((room) => room.topic === 'Eigenvectors')).toHaveLength(1);
    expect(after.rooms[Object.keys(after.rooms).find((id) => after.rooms[id]?.topic === 'Tensors') ?? '']).toBeDefined();
  });

  it('keeps the native confirmation on the legacy delete path', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      render(panel(fixture.matrixRoomId));
      fireEvent.click(screen.getByRole('button', { name: /Show room tools/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete topic' }));

      expect(confirm).toHaveBeenCalledTimes(1);
      // Refused, so the room is still here.
      expect(useSubjectStore.getState().snapshot?.rooms[fixture.matrixRoomId]).toBeDefined();
    } finally {
      confirm.mockRestore();
    }
  });

  it('still offers the Scribe transition once the map has three rooms', () => {
    render(panel(fixture.rootRoomId));

    // The legacy transition lives behind the tools menu, exactly as it always did.
    fireEvent.click(screen.getByRole('button', { name: /Show room tools/i }));
    expect(screen.getByText(/Your map has enough rooms to start Scribe encounters\./i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Scribe' }));
    expect(useSessionStore.getState().phase).toBe('scribe');
  });

  it('carries the guide-conversation route in every phase, because it is not part of the cutover', () => {
    useSessionStore.setState({ phase: 'scribe' });
    render(panel(fixture.matrixRoomId));

    expect(
      screen.getByRole('button', { name: 'Talk to the room guide about Matrices' }),
    ).toBeInTheDocument();
  });
});
