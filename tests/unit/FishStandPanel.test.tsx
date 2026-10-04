/**
 * The Fish Stand as a collection view, with canonical counts and four dialog rules.
 *
 * ## The counting defect this file pins
 *
 * The pre-Phase-17 panel decided completeness with
 * `new Set(allFish.map((f) => f.id.split(':')))`-style string splitting on the *entry id*:
 *
 * ```ts
 * const caughtCatalogIds = new Set(allFish.map((f) => f.id.split(':')[0]));
 * ```
 *
 * Three cases that splitting gets wrong, and each is a test here:
 *
 * 1. **An entry with an explicit `catalogId` and a non-conforming id.** Splitting reads the id
 *    and misses the field that is the *authority* - `CanonicalFishEntry` exists because that
 *    field is canonical. A panel that splits reports a caught species as uncaught.
 * 2. **An entry whose id has no `:` at all** - a hand-edited or imported collection. The split
 *    yields the whole id, which matches no catalogue entry, so the fish is counted as kept but
 *    never as a caught species.
 * 3. **A name-matched entry.** `resolveFishCatalogId` resolves a display name against the
 *    catalogue when the id carries no usable prefix, and the panel must count *that*, or an
 *    imported collection looks empty.
 *
 * The subject count had the quieter version of the same defect - it counted `subjectName`s, so
 * two subjects sharing a display name counted once - and that is pinned by id here too.
 *
 * ## What "a collection view" is asserted to mean
 *
 * A grid of one card per *entry* is a list. The three claims this file makes are that the panel
 * shows the **whole catalogue** (uncaught species present and saying so in words), shows
 * **four distinct numbers** rather than one, and groups the history by **subject id**. Each is
 * asserted against a concrete collection.
 *
 * Hermeticity: the subject-existence read is mocked (it is the only storage call), no renderer,
 * no network, no real clock. Dates are asserted by their year, never by locale formatting.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FishStandPanel } from '@/ui/components/FishStandPanel';
import { useProgressionStore } from '@/store/progressionStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { FISH_CATALOG, type FishEntry } from '@/core/fishing/fishingTypes';

const listSubjectIds = vi.hoisted(() => vi.fn<() => Promise<string[]>>());

vi.mock('@/services/persistence/subjectPersistence', async () => {
  const actual = await vi.importActual<typeof import('@/services/persistence/subjectPersistence')>(
    '@/services/persistence/subjectPersistence',
  );
  return { ...actual, listSubjectIds: () => listSubjectIds() };
});

function fish(overrides: Partial<FishEntry> = {}): FishEntry {
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

/** A progression record, with the fields the store's type requires and nothing else. */
function record(fishCollection: FishEntry[]) {
  return {
    xpTotal: 100,
    rank: 'Novice' as const,
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
    fishCollection,
  };
}

function setCollection(bySubject: Record<string, ReturnType<typeof record>>): void {
  useProgressionStore.setState({ bySubject, activeSubjectId: null });
}

describe('FishStandPanel', () => {
  beforeEach(() => {
    listSubjectIds.mockReset();
    listSubjectIds.mockResolvedValue(['subject-1', 'subject-2']);
    setCollection({});
    usePreferencesStore.setState({ colorTheme: 'dark' });
  });
  afterEach(cleanup);

  describe('the collection view', () => {
    it('an empty collection says so, twice, in words', async () => {
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(listSubjectIds).toHaveBeenCalled());
      expect(screen.getAllByText(/no fish kept yet/i).length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(/Visit a fishing pond near a dungeon portal/i)).toBeInTheDocument();
    });

    it('shows the WHOLE catalogue, including species never caught', async () => {
      setCollection({ 'subject-1': record([fish()]) });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull());

      // Every catalogue entry has a cell, not only the caught ones: a collection view that hides
      // what you are missing is a scoreboard.
      const cells = document.querySelectorAll('[data-fish-catalog-id]');
      expect(cells).toHaveLength(FISH_CATALOG.length);
      for (const entry of FISH_CATALOG) {
        expect(document.querySelector(`[data-fish-catalog-id="${entry.id}"]`)).not.toBeNull();
      }
    });

    it('an uncaught species says "Not caught yet" in words, not only in a dashed border', async () => {
      setCollection({ 'subject-1': record([fish()]) });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull());
      const uncaught = screen.getAllByText('Not caught yet');
      expect(uncaught).toHaveLength(FISH_CATALOG.length - 1);
      expect(uncaught[0]?.closest('[data-fish-catalog-id]')).toHaveAttribute('data-fish-caught', '0');
    });

    it('a caught species states how many times, in words', async () => {
      setCollection({
        'subject-1': record([fish({ id: 'moss-carp:1' }), fish({ id: 'moss-carp:2' })]),
      });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull());
      expect(screen.getByText('Caught 2 times')).toBeInTheDocument();
    });

    it('reports four separate numbers rather than one', async () => {
      setCollection({
        'subject-1': record([fish({ id: 'moss-carp:1' }), fish({ id: 'lunar-trout:2' })]),
        'subject-2': record([fish({ id: 'sun-skip:3', subjectId: 'subject-2', subjectName: 'Calculus' })]),
      });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull());

      expect(document.querySelector('[data-fish-stat="kept"]')).toHaveTextContent('3');
      // 3 fish of 8 catalogue species.
      expect(document.querySelector('[data-fish-stat="species"]')).toHaveTextContent('3 of 8');
      expect(document.querySelector('[data-fish-stat="canonical-types"]')).toHaveTextContent('3');
      expect(document.querySelector('[data-fish-stat="subjects"]')).toHaveTextContent('2');
    });

    it('says the collection is complete only when every catalogue species is caught', async () => {
      const all = FISH_CATALOG.map((entry, index) =>
        fish({ id: `${entry.id}:${index}`, name: entry.name, rarity: entry.rarity }),
      );
      setCollection({ 'subject-1': record(all) });
      const { unmount } = render(<FishStandPanel onClose={vi.fn()} />);
      await screen.findByText(/your collection is complete/i);
      unmount();

      setCollection({ 'subject-1': record(all.slice(0, -1)) });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull());
      expect(screen.queryByText(/your collection is complete/i)).toBeNull();
    });
  });

  describe('canonical catalogue identity, not string splitting', () => {
    it('counts an entry whose explicit catalogId contradicts its entry id', async () => {
      // The canonical field wins. Splitting `'moss-carp:1'` here would agree by luck, so the
      // id is deliberately *wrong*: the entry says `lunar-trout` in its id and carries
      // `catalogId: 'moss-carp'`. The catalogue cell for moss-carp must show one catch and the
      // cell for lunar-trout must show none.
      setCollection({
        'subject-1': record([
          fish({ id: 'lunar-trout:1', name: 'Moss Carp', catalogId: 'moss-carp' }),
        ]),
      });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull());

      expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).toHaveAttribute(
        'data-fish-caught',
        '1',
      );
      expect(document.querySelector('[data-fish-catalog-id="lunar-trout"]')).toHaveAttribute(
        'data-fish-caught',
        '0',
      );
    });

    it('counts an entry whose id carries no catalogue prefix at all', async () => {
      // `split(':')[0]` on this id yields the whole id, which matches no catalogue entry, so the
      // pre-Phase-17 panel reported the fish as kept but never as a caught species.
      setCollection({ 'subject-1': record([fish({ id: 'legacy-entry-77', catalogId: 'ember-perch' })]) });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(listSubjectIds).toHaveBeenCalled());

      expect(document.querySelector('[data-fish-catalog-id="ember-perch"]')).toHaveAttribute(
        'data-fish-caught',
        '1',
      );
      expect(document.querySelector('[data-fish-stat="canonical-types"]')).toHaveTextContent('1');
    });

    it('counts an entry resolved from its display name', async () => {
      setCollection({
        'subject-1': record([fish({ id: 'no-prefix-here', name: 'Gilded Koi', catalogId: undefined })]),
      });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(listSubjectIds).toHaveBeenCalled());
      expect(document.querySelector('[data-fish-catalog-id="gilded-koi"]')).toHaveAttribute(
        'data-fish-caught',
        '1',
      );
    });

    it('reports a species the catalogue no longer lists instead of hiding it', async () => {
      setCollection({
        'subject-1': record([fish({ id: 'retired-fish:1', name: 'Retired Carp', catalogId: 'retired-fish' })]),
      });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(listSubjectIds).toHaveBeenCalled());

      // It is in the collection (1) but not in the catalogue grid (0 of 8), and the panel says
      // so rather than letting the two numbers quietly disagree.
      expect(document.querySelector('[data-fish-stat="kept"]')).toHaveTextContent('1');
      expect(document.querySelector('[data-fish-stat="species"]')).toHaveTextContent('0 of 8');
      expect(document.querySelector('[data-fish-stat="canonical-types"]')).toHaveTextContent('1');
      expect(document.querySelector('[data-fish-unknown-species="1"]')).toBeInTheDocument();
    });
  });

  describe('subject identity, not display names', () => {
    it('groups by subject id, so two subjects sharing a name are two subjects', async () => {
      setCollection({
        'subject-1': record([fish({ id: 'moss-carp:1', subjectId: 'subject-1', subjectName: 'Maths' })]),
        'subject-2': record([fish({ id: 'sun-skip:1', subjectId: 'subject-2', subjectName: 'Maths' })]),
      });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull());

      // One shared name, two groups - the pre-Phase-17 `new Set(subjectName)` counted 1.
      expect(document.querySelector('[data-fish-stat="subjects"]')).toHaveTextContent('2');
      expect(screen.getAllByText('Maths')).toHaveLength(2);
    });

    it('marks a subject that no longer exists on this device, in words', async () => {
      listSubjectIds.mockResolvedValue(['subject-2', 'subject-3']);
      setCollection({
        'subject-1': record([fish({ id: 'moss-carp:1', subjectId: 'subject-1', subjectName: 'Old Subject' })]),
      });
      render(<FishStandPanel onClose={vi.fn()} />);
      // The history region starts **collapsed**, and `hidden` removes a subtree from the
      // accessibility tree as well as from Tab order - so the region is opened before its
      // content can be queried at all. That is the point of the workspace pattern.
      fireEvent.click(screen.getByRole('button', { name: /Show Catch history/i }));
      const heading = await screen.findByRole('heading', { name: /Old Subject/ });
      // The deleted marker is part of that heading's text: a badge beside it would be a second,
      // colour-only signal with nothing behind it.
      expect(heading.textContent).toContain('deleted subject');
    });

    it('shows the catch history with a date per fish', async () => {
      setCollection({ 'subject-1': record([fish()]) });
      render(<FishStandPanel onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /Show Catch history/i }));
      const historyHeading = await screen.findByRole('heading', { name: /Catch history/i });
      const history = historyHeading.closest('section') as HTMLElement;
      const row = within(history).getByText('Moss Carp').closest('li') as HTMLElement;
      expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-06-01T00:00:00.000Z');
      expect(within(row).getByText(/2026/)).toBeInTheDocument();
    });
  });

  describe('the workspace pattern', () => {
    it('is composed of collapsible, titled regions that report their own vocabulary', async () => {
      setCollection({ 'subject-1': record([fish()]) });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull());

      const regions = [...document.querySelectorAll('[data-study-region]')].map((element) =>
        element.getAttribute('data-study-region'),
      );
      // Static vocabulary, never a subject or a fish: DOM attributes are read by tests and
      // pasted into issue reports.
      expect(regions).toEqual(['fish-summary', 'fish-catalog', 'fish-history']);
    });

    it('a region toggle collapses its body out of the accessibility tree', async () => {
      setCollection({ 'subject-1': record([fish()]) });
      render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() => expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull());

      const toggle = screen.getByRole('button', { name: /Hide Catalogue/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(toggle);
      expect(screen.getByRole('button', { name: /Show Catalogue/i })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      // `hidden`, not a class: a visually collapsed region that is still in Tab order is the
      // defect plan 10.1 is about.
      const body = document.getElementById(
        screen.getByRole('button', { name: /Show Catalogue/i }).getAttribute('aria-controls') as string,
      );
      expect(body?.hasAttribute('hidden')).toBe(true);
    });
  });

  describe('dialog accessibility, all four rules', () => {
    it('is a labelled modal dialog described by its summary', () => {
      render(<FishStandPanel onClose={vi.fn()} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      const labelledBy = dialog.getAttribute('aria-labelledby') as string;
      expect(document.getElementById(labelledBy)?.textContent).toContain('Fish collection');
      const describedBy = dialog.getAttribute('aria-describedby') as string;
      expect(document.getElementById(describedBy)).not.toBeNull();
    });

    it('takes initial focus on the dialog itself', () => {
      render(<FishStandPanel onClose={vi.fn()} />);
      expect(document.activeElement).toBe(screen.getByRole('dialog'));
    });

    it('contains Tab inside the dialog', () => {
      render(<FishStandPanel onClose={vi.fn()} />);
      const dialog = screen.getByRole('dialog');
      const buttons = screen.getAllByRole('button');
      buttons[buttons.length - 1].focus();
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('Escape closes it', () => {
      const onClose = vi.fn();
      render(<FishStandPanel onClose={onClose} />);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('restores focus to whatever had it before the panel opened', () => {
      const opener = document.createElement('button');
      opener.textContent = 'Open the collection';
      document.body.appendChild(opener);
      opener.focus();

      const { unmount } = render(<FishStandPanel onClose={vi.fn()} />);
      expect(document.activeElement).not.toBe(opener);
      unmount();
      expect(document.activeElement).toBe(opener);
      opener.remove();
    });

    it('a backdrop click does NOT close it, so a mis-aimed touch cannot discard a learner’s place', () => {
      // A deliberate behaviour change from the pre-Phase-17 panel, for `DataManagementDialog`'s
      // reason: a surface that reacts to a click on the dimmed area around it reacts to
      // mis-aimed touch.
      const onClose = vi.fn();
      const { container } = render(<FishStandPanel onClose={onClose} />);
      const backdrop = container.querySelector('.modal-backdrop') as HTMLElement;
      fireEvent.click(backdrop);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('the close control is labelled, not an unlabelled ×', () => {
      render(<FishStandPanel onClose={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Close the fish collection' })).toBeInTheDocument();
    });

    it('every close route carries the 44 by 44 floor inline', async () => {
      render(<FishStandPanel onClose={vi.fn()} />);
      const close = screen.getByRole('button', { name: 'Close the fish collection' });
      expect(close.style.minWidth).toBe('44px');
      expect(close.style.minHeight).toBe('44px');
    });
  });

  describe('no learner data in any key or attribute', () => {
    it('no authored DOM id or data attribute carries a fish or subject name', async () => {
      setCollection({
        'subject-1': record([fish({ id: 'moss-carp:1', subjectId: 'subject-1', subjectName: 'Linear Algebra' })]),
      });
      const { container } = render(<FishStandPanel onClose={vi.fn()} />);
      await waitFor(() =>
        expect(document.querySelector('[data-fish-catalog-id="moss-carp"]')).not.toBeNull(),
      );
      // The history region holds the fish's *name*, which is the string that must not reach an
      // id or an attribute, so it is opened rather than asserted in its collapsed state. Both
      // regions are then scanned, because a name leaking in one and not the other is still a
      // defect.
      fireEvent.click(screen.getByRole('button', { name: /Show Catch history/i }));
      await waitFor(() => expect(screen.getAllByText('Moss Carp')).toHaveLength(2));

      // Display names are content, and appear as text only.
      expect(container.innerHTML).toContain('Linear Algebra');

      // Every `data-*` value in the subtree. A learner value in any of them is the defect.
      for (const element of container.querySelectorAll('*')) {
        for (const attribute of element.getAttributeNames()) {
          if (!attribute.startsWith('data-')) continue;
          expect(element.getAttribute(attribute), `${attribute} must not carry a learner value`).not.toContain(
            'Linear Algebra',
          );
        }
      }

      // Every authored id. React's generated ids and `useId` values are opaque; the rest are
      // static literals, and none may be built from a fish or a subject name.
      for (const element of container.querySelectorAll('[id]')) {
        const id = element.getAttribute('id') as string;
        if (/^_r_/.test(id) || /^study-region-/.test(id)) continue;
        expect(id).not.toContain('Linear Algebra');
        expect(id).not.toContain('Moss Carp');
      }
    });
  });
});
