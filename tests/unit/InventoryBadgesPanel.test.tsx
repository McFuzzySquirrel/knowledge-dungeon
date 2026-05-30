import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InventoryBadgesPanel } from '@/ui/components/InventoryBadgesPanel';

describe('InventoryBadgesPanel', () => {
  it('renders empty inventory placeholder when no items are present', () => {
    render(
      <InventoryBadgesPanel
        view="inventory"
        inventory={[]}
        badges={[]}
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
        xpTotal={50}
        rank="Apprentice"
        onSwitchView={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('First Steps')).toBeInTheDocument();
    expect(screen.getByText('Apprentice')).toBeInTheDocument();
  });
});
