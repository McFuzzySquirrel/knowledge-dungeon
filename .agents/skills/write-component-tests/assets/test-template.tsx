# Annotated Example Test File

This is a complete, working test file for a Knowledge Dungeon React UI component. Use it as a reference when writing new tests.
It demonstrates: store state setup, rendering, user interaction, conditional rendering, edge case handling, and the correct mock patterns.

```typescript
// tests/unit/Hud.test.tsx — annotated example
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore } from '../../src/store/sessionStore';
import { useSubjectStore } from '../../src/store/subjectStore';
import { useProgressionStore } from '../../src/store/progressionStore';
import { Hud } from '../../src/ui/components/Hud';

// Mock Phaser imports — GameScreen/VillageScreen tests need this;
// HUD doesn't import Phaser directly, but if the test file transitively
// imports a module that does, mock it at the module level.
vi.mock('../../src/game/createGame', () => ({
  default: vi.fn(() => ({ destroy: vi.fn() })),
}));

vi.mock('../../src/game/createVillageGame', () => ({
  default: vi.fn(() => ({ destroy: vi.fn() })),
}));

describe('Hud', () => {
  beforeEach(() => {
    // Reset stores to defaults before each test
    useSessionStore.setState({
      phase: 'scribe',
      activeScreen: 'game',
      selectedClass: 'scholar',
    });
    useSubjectStore.setState({
      activeSubjectId: 'test-subject',
      subjects: {
        'test-subject': {
          id: 'test-subject',
          name: 'Linear Algebra',
          rooms: { 'room-1': {}, 'room-2': {} },
        },
      },
    });
    useProgressionStore.setState({
      currentXp: 150,
      rank: 'novice',
      badges: [],
    });
  });

  // --- RENDERING TESTS ---

  describe('rendering', () => {
    it('renders the active subject name', () => {
      render(<Hud />);
      expect(screen.getByText('Linear Algebra')).toBeDefined();
    });

    it('renders room count', () => {
      render(<Hud />);
      expect(screen.getByText(/2 rooms/i)).toBeDefined();
    });

    it('renders XP and rank', () => {
      render(<Hud />);
      expect(screen.getByText(/150/)).toBeDefined();
      expect(screen.getByText(/novice/i)).toBeDefined();
    });

    it('renders empty state when no subject is active', () => {
      useSubjectStore.setState({ activeSubjectId: null });
      render(<Hud />);
      expect(screen.getByText(/no subject/i)).toBeDefined();
    });
  });

  // --- INTERACTION TESTS ---

  describe('interactions', () => {
    it('shows map on button click', async () => {
      const user = userEvent.setup();
      render(<Hud />);
      await user.click(screen.getByLabelText(/map/i));
      // Verify map is opened — actual check depends on implementation
      expect(screen.getByRole('dialog')).toBeDefined();
    });

    it('handles phase switch', async () => {
      const user = userEvent.setup();
      render(<Hud />);

      // Wrap direct store changes in act() for re-render flush
      await act(() => {
        useSessionStore.setState({ phase: 'creator' });
      });

      expect(screen.getByText(/creator/i)).toBeDefined();
    });
  });

  // --- CONDITIONAL RENDERING ---

  describe('conditional behavior', () => {
    it('shows different tabs per phase', () => {
      render(<Hud />);

      // Scribe phase — expect Notes-related elements
      expect(screen.queryByText(/add topic/i)).toBeNull();

      // Switch to Creator phase
      act(() => {
        useSessionStore.setState({ phase: 'creator' });
      });

      expect(screen.getByText(/add topic/i)).toBeDefined();
    });
  });
});
```
