import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Hud } from '@/ui/components/Hud';

describe('Hud', () => {
  it('renders the active subject and phase labels', () => {
    render(
      <Hud
        subjectName="Linear Algebra"
        roomCount={3}
        xpTotal={120}
        rank="Novice"
        inventoryCount={0}
        badgeCount={0}
        phase="creator"
        currentFloorLabel="Linear Algebra"
        teleportRemainingMs={0}
        teleportModeArmed={false}
        onPhaseChange={() => undefined}
        onHelp={() => undefined}
        onOpenMap={() => undefined}
        onTeleport={() => undefined}
        onHome={() => undefined}
        onOpenInventory={() => undefined}
        onOpenBadges={() => undefined}
      />,
    );

    expect(screen.getAllByText('Linear Algebra')).toHaveLength(2);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/120/)).toBeInTheDocument();
  });
});
