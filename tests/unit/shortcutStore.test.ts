/**
 * Phase 5: Unit tests for keyboard shortcut store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useShortcutStore, DEFAULT_SHORTCUTS, canonicalShortcutBindings } from '@/store/shortcutStore';

describe('useShortcutStore', () => {
  beforeEach(() => {
    // Reset store state
    useShortcutStore.setState({ shortcuts: JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS)) });
    localStorage.clear();
  });

  it('starts with default shortcuts', () => {
    const state = useShortcutStore.getState();
    expect(state.shortcuts).toHaveLength(3);
    expect(state.shortcuts[0].key).toBe('/');
    expect(state.shortcuts[1].key).toBe('m');
    expect(state.shortcuts[2].key).toBe('i');
  });

  it('can change a shortcut key', () => {
    useShortcutStore.getState().setShortcutKey(1, 'j');
    const state = useShortcutStore.getState();
    expect(state.shortcuts[1].key).toBe('j');
    // Other shortcuts unchanged
    expect(state.shortcuts[0].key).toBe('/');
    expect(state.shortcuts[2].key).toBe('i');
  });

  it('persists to localStorage', () => {
    useShortcutStore.getState().setShortcutKey(0, 'h');
    // New store should load from localStorage
    const state = useShortcutStore.getState();
    expect(state.shortcuts[0].key).toBe('h');
  });

  it('resetShortcuts restores defaults', () => {
    useShortcutStore.getState().setShortcutKey(0, 'x');
    useShortcutStore.getState().setShortcutKey(1, 'y');
    useShortcutStore.getState().setShortcutKey(2, 'z');

    useShortcutStore.getState().resetShortcuts();

    const state = useShortcutStore.getState();
    expect(state.shortcuts[0].key).toBe('/');
    expect(state.shortcuts[1].key).toBe('m');
    expect(state.shortcuts[2].key).toBe('i');
  });

  // Phase 4 regression: `shortcutsFrom` used to sort by `labelKey` while the
  // legacy reader kept the persisted array order, so the two repositories
  // rendered the settings list in a different order, and `setShortcutKey` was
  // index-based, so one press rebound a different action after a reload.
  it('hydrates a stored payload in the canonical order, whatever order it arrives in', () => {
    const canonical = canonicalShortcutBindings;
    expect(canonical).toEqual([
      'shortcuts.toggleHelp',
      'shortcuts.toggleMap',
      'shortcuts.toggleInfoPanel',
    ]);

    // The same three bindings, persisted in an order neither repository declares.
    const shuffled = [
      { label: 'Toggle Info Panel', labelKey: 'shortcuts.toggleInfoPanel', defaultKey: 'i', key: 'i', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Help', labelKey: 'shortcuts.toggleHelp', defaultKey: '/', key: '/', ctrlKey: false, shiftKey: true },
      { label: 'Toggle Map', labelKey: 'shortcuts.toggleMap', defaultKey: 'm', key: 'v', ctrlKey: false, shiftKey: false },
    ];
    useShortcutStore.getState().hydrateShortcuts(shuffled);
    expect(useShortcutStore.getState().shortcuts.map((binding) => binding.labelKey)).toEqual([...canonical]);
    // And the stored keys survive the reordering.
    expect(useShortcutStore.getState().shortcuts.map((binding) => binding.key)).toEqual(['/', 'v', 'i']);
  });

  it('binds by label, not by position, so a reorder cannot rebind another action', () => {
    // The list arrives shuffled; the learner rebinds the *second* action they see.
    useShortcutStore.getState().hydrateShortcuts([
      { label: 'Toggle Info Panel', labelKey: 'shortcuts.toggleInfoPanel', defaultKey: 'i', key: 'i', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Map', labelKey: 'shortcuts.toggleMap', defaultKey: 'm', key: 'm', ctrlKey: false, shiftKey: false },
      { label: 'Toggle Help', labelKey: 'shortcuts.toggleHelp', defaultKey: '/', key: '/', ctrlKey: false, shiftKey: true },
    ]);
    useShortcutStore.getState().setShortcutForAction('shortcuts.toggleMap', 'j');
    const state = useShortcutStore.getState();
    expect(state.shortcuts.find((binding) => binding.labelKey === 'shortcuts.toggleMap')?.key).toBe('j');
    // Nothing else moved.
    expect(state.shortcuts.find((binding) => binding.labelKey === 'shortcuts.toggleHelp')?.key).toBe('/');
    expect(state.shortcuts.find((binding) => binding.labelKey === 'shortcuts.toggleInfoPanel')?.key).toBe('i');
  });

  it('keeps a binding it does not recognise rather than dropping it', () => {
    useShortcutStore.getState().hydrateShortcuts([
      { label: 'Toggle Help', labelKey: 'shortcuts.toggleHelp', defaultKey: '/', key: '/', ctrlKey: false, shiftKey: true },
      { label: 'A Future Action', labelKey: 'shortcuts.futureAction', defaultKey: 'z', key: 'z', ctrlKey: false, shiftKey: false },
    ]);
    expect(useShortcutStore.getState().shortcuts.map((binding) => binding.labelKey)).toEqual([
      'shortcuts.toggleHelp',
      'shortcuts.futureAction',
    ]);
  });

  it('hydrates the documented defaults when nothing is stored', () => {
    useShortcutStore.getState().hydrateShortcuts(null);
    expect(useShortcutStore.getState().shortcuts).toHaveLength(3);
    expect(useShortcutStore.getState().shortcuts.map((binding) => binding.key)).toEqual(['/', 'm', 'i']);
  });

  it('handles invalid localStorage gracefully', () => {
    localStorage.setItem('knowledge-dungeon:session:shortcuts', 'invalid json');
    // Should fall back to defaults
    useShortcutStore.getState().resetShortcuts();
    const state = useShortcutStore.getState();
    expect(state.shortcuts).toHaveLength(3);
  });
});
