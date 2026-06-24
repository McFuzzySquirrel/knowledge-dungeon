/**
 * Keyboard shortcut configuration store.
 *
 * Phase 5: Quality & Scale - Keyboard shortcut customization.
 * Extends preferencesStore with configurable shortcut bindings persisted
 * to localStorage.
 */
import { create } from 'zustand';

export interface ShortcutBinding {
  /** Human-readable action name. */
  label: string;
  /** Translation key for the action name. */
  labelKey: string;
  /** Default key binding (case-sensitive, single character or named key). */
  defaultKey: string;
  /** Current key binding. */
  key: string;
  /** Whether this shortcut requires the ctrl/meta modifier. */
  ctrlKey: boolean;
  /** Whether this shortcut requires the shift modifier. */
  shiftKey: boolean;
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  {
    label: 'Toggle Help',
    labelKey: 'shortcuts.toggleHelp',
    defaultKey: '/',
    key: '/',
    ctrlKey: false,
    shiftKey: true,
  },
  {
    label: 'Toggle Map',
    labelKey: 'shortcuts.toggleMap',
    defaultKey: 'm',
    key: 'm',
    ctrlKey: false,
    shiftKey: false,
  },
  {
    label: 'Toggle Info Panel',
    labelKey: 'shortcuts.toggleInfoPanel',
    defaultKey: 'i',
    key: 'i',
    ctrlKey: false,
    shiftKey: false,
  },
];

const SHORTCUT_STORAGE_KEY = 'knowledge-dungeon:session:shortcuts';

function loadShortcuts(): ShortcutBinding[] {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ShortcutBinding[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    }
  } catch {
    // Fall through to defaults
  }
  return JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS)) as ShortcutBinding[];
}

function saveShortcuts(shortcuts: ShortcutBinding[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(shortcuts));
    }
  } catch {
    // Non-fatal
  }
}

export interface ShortcutState {
  shortcuts: ShortcutBinding[];
  setShortcutKey: (index: number, key: string) => void;
  resetShortcuts: () => void;
}

export const useShortcutStore = create<ShortcutState>((set) => ({
  shortcuts: loadShortcuts(),
  setShortcutKey: (index, key) =>
    set((state) => {
      const updated = state.shortcuts.map((s, i) => (i === index ? { ...s, key } : s));
      saveShortcuts(updated);
      return { shortcuts: updated };
    }),
  resetShortcuts: () => {
    const defaults = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS)) as ShortcutBinding[];
    saveShortcuts(defaults);
    set({ shortcuts: defaults });
  },
}));
