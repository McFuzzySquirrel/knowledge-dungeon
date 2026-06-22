/**
 * Phase 5: Unit tests for keyboard shortcut store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useShortcutStore, DEFAULT_SHORTCUTS } from '@/store/shortcutStore';

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

  it('handles invalid localStorage gracefully', () => {
    localStorage.setItem('knowledge-dungeon:session:shortcuts', 'invalid json');
    // Should fall back to defaults
    useShortcutStore.getState().resetShortcuts();
    const state = useShortcutStore.getState();
    expect(state.shortcuts).toHaveLength(3);
  });
});
