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
        phase="creator"
        onPhaseChange={() => undefined}
        onHelp={() => undefined}
      />,
    );

    expect(screen.getByText('Linear Algebra')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/120/)).toBeInTheDocument();
  });
});
