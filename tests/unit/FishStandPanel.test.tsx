import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FishStandPanel } from '@/ui/components/FishStandPanel';
import { useProgressionStore } from '@/store/progressionStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { FishEntry } from '@/game/systems/fishingTypes';
import { FISH_CATALOG } from '@/game/systems/fishingTypes';

const mockListSubjectIds = vi.fn<() => Promise<string[]>>();

vi.mock('@/services/persistence/subjectPersistence', async () => {
  const actual = await vi.importActual('@/services/persistence/subjectPersistence');
  return {
    ...actual,
    listSubjectIds: () => mockListSubjectIds(),
  };
});

function makeFishEntry(overrides: Partial<FishEntry> = {}): FishEntry {
  return {
    id: 'moss-carp:abc-123',
    name: 'Moss Carp',
    rarity: 'common',
    subjectId: 'subject-1',
    subjectName: 'Linear Algebra',
    caughtAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('FishStandPanel', () => {
  beforeEach(() => {
    mockListSubjectIds.mockReset();
    // Default: subjects still exist
    mockListSubjectIds.mockResolvedValue(['subject-1', 'subject-2']);
    useProgressionStore.setState({
      bySubject: {},
      activeSubjectId: null,
    });
    usePreferencesStore.setState({ colorTheme: 'dark' });
  });

  it('empty state: shows "No fish caught yet" message', async () => {
    useProgressionStore.setState({
      bySubject: {},
    });

    render(<FishStandPanel onClose={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSubjectIds).toHaveBeenCalled();
    });

    // Both the header meta text and the empty-state paragraph contain "No fish caught yet"
    expect(screen.getAllByText(/No fish caught yet/i)).toHaveLength(2);
  });

  it('renders fish cards with names, rarity badges, subject names', async () => {
    useProgressionStore.setState({
      bySubject: {
        'subject-1': {
          xpTotal: 100,
          rank: 'Apprentice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 1,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [
            makeFishEntry({ id: 'moss-carp:1', name: 'Moss Carp', rarity: 'common', subjectId: 'subject-1', subjectName: 'Linear Algebra' }),
            makeFishEntry({ id: 'lunar-trout:2', name: 'Lunar Trout', rarity: 'rare', subjectId: 'subject-1', subjectName: 'Linear Algebra' }),
          ],
        },
      },
    });

    render(<FishStandPanel onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Moss Carp')).toBeInTheDocument();
    });

    expect(screen.getByText('Lunar Trout')).toBeInTheDocument();
    expect(screen.getByText('common')).toBeInTheDocument();
    expect(screen.getByText('rare')).toBeInTheDocument();
    // Both fish cards share the same subject name
    expect(screen.getAllByText('Linear Algebra')).toHaveLength(2);
  });

  it('shows "(Deleted Subject)" when subject is not in the store', async () => {
    // listSubjectIds returns some IDs but NOT subject-1 — so subject-1 is "deleted"
    mockListSubjectIds.mockResolvedValue(['subject-2', 'subject-3']);

    useProgressionStore.setState({
      bySubject: {
        'subject-1': {
          xpTotal: 100,
          rank: 'Apprentice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 1,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [
            makeFishEntry({ id: 'moss-carp:1', name: 'Moss Carp', rarity: 'common', subjectId: 'subject-1', subjectName: 'Old Subject' }),
          ],
        },
      },
    });

    render(<FishStandPanel onClose={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSubjectIds).toHaveBeenCalled();
    });

    expect(screen.getByText('Moss Carp')).toBeInTheDocument();
    expect(screen.getByText('(Deleted Subject)')).toBeInTheDocument();
  });

  it('shows completion banner when all 8 fish types are caught', async () => {
    // Create a collection with all 8 catalog fish types
    const allFishEntries: FishEntry[] = FISH_CATALOG.map((c, index) => ({
      id: `${c.id}:${index}`,
      name: c.name,
      rarity: c.rarity,
      subjectId: 'subject-1',
      subjectName: 'Linear Algebra',
      caughtAt: new Date().toISOString(),
    }));

    useProgressionStore.setState({
      bySubject: {
        'subject-1': {
          xpTotal: 800,
          rank: 'Master',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 20,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: allFishEntries,
        },
      },
    });

    render(<FishStandPanel onClose={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText(/Your collection is complete!/i),
      ).toBeInTheDocument();
    });
  });

  it('closes when the close button is clicked', async () => {
    const onClose = vi.fn();
    useProgressionStore.setState({
      bySubject: {
        'subject-1': {
          xpTotal: 100,
          rank: 'Apprentice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 1,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [makeFishEntry()],
        },
      },
    });

    render(<FishStandPanel onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Moss Carp')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when clicking the backdrop', async () => {
    const onClose = vi.fn();
    useProgressionStore.setState({
      bySubject: {
        'subject-1': {
          xpTotal: 100,
          rank: 'Apprentice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 1,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [makeFishEntry()],
        },
      },
    });

    render(<FishStandPanel onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Moss Carp')).toBeInTheDocument();
    });

    // Click the backdrop (the outer div with class modal-backdrop)
    const backdrop = document.querySelector('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows fish count and unique subject count in header', async () => {
    useProgressionStore.setState({
      bySubject: {
        'subject-1': {
          xpTotal: 100,
          rank: 'Apprentice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 1,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [
            makeFishEntry({ id: 'moss-carp:1', name: 'Moss Carp', rarity: 'common', subjectId: 'subject-1', subjectName: 'Linear Algebra' }),
            makeFishEntry({ id: 'lunar-trout:2', name: 'Lunar Trout', rarity: 'rare', subjectId: 'subject-1', subjectName: 'Linear Algebra' }),
            makeFishEntry({ id: 'sun-skip:3', name: 'Sun Skip', rarity: 'common', subjectId: 'subject-2', subjectName: 'Calculus' }),
          ],
        },
        'subject-2': {
          xpTotal: 50,
          rank: 'Novice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 0,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [],
        },
      },
    });

    render(<FishStandPanel onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/3 fish caught/i)).toBeInTheDocument();
    });
  });

  it('renders fish card dates', async () => {
    useProgressionStore.setState({
      bySubject: {
        'subject-1': {
          xpTotal: 100,
          rank: 'Apprentice',
          badges: [],
          inventory: [],
          equippedItems: [],
          collectedNotes: [],
          streakCount: 0,
          subjectsMastered: 0,
          roomsCleared: 1,
          reviewPasses: 0,
          artifacts: 0,
          bossesDefeated: 0,
          fishCollection: [
            makeFishEntry({ id: 'moss-carp:1', name: 'Moss Carp', rarity: 'common', caughtAt: '2026-06-01T00:00:00.000Z' }),
          ],
        },
      },
    });

    render(<FishStandPanel onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Moss Carp')).toBeInTheDocument();
    });

    // The date should be formatted and visible
    const dateElement = screen.getByText(/2026/);
    expect(dateElement).toBeInTheDocument();
  });
});
