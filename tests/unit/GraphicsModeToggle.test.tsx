import { describe, expect, it, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { GraphicsModeToggle } from '@/ui/components/GraphicsModeToggle';
import { usePreferencesStore } from '@/store/preferencesStore';

describe('GraphicsModeToggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePreferencesStore.setState({ graphicsMode: 'mindmap' });
  });

  it('renders two radio options reflecting the current preference', () => {
    const { container } = render(<GraphicsModeToggle />);
    const radios = container.querySelectorAll('[role="radio"]');
    expect(radios).toHaveLength(2);
    const checked = container.querySelector('[role="radio"][aria-checked="true"]');
    expect(checked?.textContent).toBe('Mind map');
  });

  it('updates the preferences store when an option is clicked', () => {
    const { container } = render(<GraphicsModeToggle />);
    const rpgButton = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (node) => node.textContent === 'RPG',
    ) as HTMLButtonElement | undefined;
    expect(rpgButton).toBeDefined();
    rpgButton?.click();
    expect(usePreferencesStore.getState().graphicsMode).toBe('rpg');
  });
});
