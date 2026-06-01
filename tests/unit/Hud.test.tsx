import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Hud } from '@/ui/components/Hud';

describe('Hud', () => {
  it('renders the active subject and phase labels', () => {
    render(
      <Hud
        subjectName="Linear Algebra"
        roomCount={3}
        xpTotal={120}
        rank="Novice"
        phase="creator"
        currentFloorLabel="Linear Algebra"
        teleportRemainingMs={0}
        teleportModeArmed={false}
        phaseChangeNeedsConfirmation={false}
        showScribeNudge={false}
        onPhaseChange={() => undefined}
        onHelp={() => undefined}
        onOpenMap={() => undefined}
        onTeleport={() => undefined}
        onHome={() => undefined}
      />,
    );

    expect(screen.getAllByText('Linear Algebra')).toHaveLength(2);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/120/)).toBeInTheDocument();
  });

  it('asks for confirmation before phase switch when flow-sensitive UI is active', async () => {
    const user = userEvent.setup();
    const onPhaseChange = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <Hud
        subjectName="Linear Algebra"
        roomCount={3}
        xpTotal={120}
        rank="Novice"
        phase="creator"
        currentFloorLabel="Linear Algebra"
        teleportRemainingMs={0}
        teleportModeArmed={true}
        phaseChangeNeedsConfirmation={true}
        showScribeNudge={true}
        onPhaseChange={onPhaseChange}
        onHelp={() => undefined}
        onOpenMap={() => undefined}
        onTeleport={() => undefined}
        onHome={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Scribe' }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onPhaseChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Teleport Mode armed: open map, pick a destination room, then confirm teleport\./i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open help/i })).toBeInTheDocument();
    expect(screen.getByText(/Your map has enough rooms to start Scribe encounters\./i)).toBeInTheDocument();

    confirmSpy.mockRestore();
  });
});
