/**
 * Keyboard shortcut configuration store.
 *
 * Phase 5: Quality & Scale - Keyboard shortcut customization.
 * Extends preferencesStore with configurable shortcut bindings persisted
 * to localStorage.
 *
 * Phase 4: hydration is explicit and storage-v2 is the primary repository. The
 * store no longer decides an order of its own - `hydrateShortcuts` applies
 * {@link canonicalShortcutBindings}, the one order both repositories share, so a
 * device that reloads hydrates the same list whichever repository it read. A
 * storage-v2 generation stores shortcuts as an unordered set of records, so any
 * order invented in the reader or here would be a second source of truth that
 * disagrees with the other repository.
 */
import { create } from 'zustand';

import type { PersistedShortcutBinding } from '@/services/persistence/v2/appState';
import { writeThroughInBackground } from '@/services/persistence/v2/dualWrite';
import { currentStorageV2Repository, isStorageV2Selected } from '@/services/persistence/v2/repositorySelection';

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

/**
 * Write the legacy mirror. Returns `false` when the storage refused it, so a
 * mirror failure is reported rather than silently swallowed.
 */
function saveShortcuts(shortcuts: ShortcutBinding[]): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(shortcuts));
    }
    return true;
  } catch {
    // Non-fatal for the store: the in-memory bindings still apply this session,
    // and `writeThrough` records the mirror failure.
    return false;
  }
}

/**
 * The order every hydration uses, for both repositories.
 *
 * The order is a user-visible property, not a detail: the settings list renders
 * in store order, so two repositories that disagreed about it would show the
 * learner's shortcuts in a different order after a rollback. Declared once, here,
 * and applied by {@link ShortcutState.hydrateShortcuts}. A stored binding for a
 * `labelKey` the app does not know is kept, in its own declared order after the
 * known ones, so a payload from a newer build is never silently dropped.
 */
export const canonicalShortcutBindings: readonly string[] = DEFAULT_SHORTCUTS.map(
  (binding) => binding.labelKey,
);

/** The order {@link canonicalShortcutBindings} implies, for `bindings`. */
function inCanonicalOrder(bindings: readonly ShortcutBinding[]): ShortcutBinding[] {
  const byLabel = new Map(bindings.map((binding) => [binding.labelKey, binding]));
  const ordered: ShortcutBinding[] = [];
  for (const labelKey of canonicalShortcutBindings) {
    const binding = byLabel.get(labelKey);
    if (binding === undefined) continue;
    ordered.push(binding);
    byLabel.delete(labelKey);
  }
  // Anything the app does not know yet, in a stable order so a reload cannot
  // reshuffle it.
  for (const binding of [...byLabel.values()].sort((left, right) =>
    left.labelKey < right.labelKey ? -1 : 1,
  )) {
    ordered.push(binding);
  }
  return ordered;
}

/** Read the persisted bindings. The legacy repository's half of hydration. */
export function readPersistedShortcuts(): ShortcutBinding[] {
  return loadShortcuts();
}

/**
 * Write the bindings to the selected repository.
 *
 * With storage-v2 selected the generation is the primary one, so a binding the
 * learner changed has to reach it or a reload on the build they changed it on
 * loses it. The legacy key stays the rollback mirror and is written only after
 * the primary succeeds, so a failed primary can never leave the mirror ahead.
 */
function persistShortcuts(shortcuts: ShortcutBinding[]): void {
  if (!isStorageV2Selected()) {
    saveShortcuts(shortcuts);
    return;
  }
  const repository = currentStorageV2Repository();
  if (repository === null) {
    saveShortcuts(shortcuts);
    return;
  }
  writeThroughInBackground({
    operation: 'shortcuts',
    // Lazy: the storage-v2 record adapter is not part of the default artifact.
    primary: () =>
      import('@/services/persistence/v2/appRepository').then((records) =>
        records.publishShortcutsToActiveGeneration(
          repository,
          shortcuts as PersistedShortcutBinding[],
          new Date().toISOString(),
        ),
      ),
    mirror: () => saveShortcuts(shortcuts),
  });
}

export interface ShortcutState {
  shortcuts: ShortcutBinding[];
  /**
   * Apply a persisted payload, in the canonical order. Called once by the
   * application bootstrap, before the first render. Passing `null` resets to the
   * defaults, which is what a device with no stored binding hydrates to.
   */
  hydrateShortcuts: (
    persisted: readonly PersistedShortcutBinding[] | ShortcutBinding[] | null,
  ) => void;
  setShortcutKey: (index: number, key: string) => void;
  /**
   * Rebind by `labelKey`, not by index.
   *
   * The index-based setter addressed a position in a list whose order the two
   * repositories could disagree about, so a settings row could rebind a different
   * action than the one the learner pressed. Addressing the stable identity makes
   * the rebind independent of order.
   */
  setShortcutForAction: (labelKey: string, key: string) => void;
  resetShortcuts: () => void;
}

export const useShortcutStore = create<ShortcutState>((set) => ({
  shortcuts: loadShortcuts(),
  hydrateShortcuts: (persisted) =>
    set(() => {
      if (persisted === null) {
        const defaults = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS)) as ShortcutBinding[];
        return { shortcuts: defaults };
      }
      return { shortcuts: inCanonicalOrder(persisted as ShortcutBinding[]) };
    }),
  setShortcutKey: (index, key) =>
    set((state) => {
      const updated = state.shortcuts.map((s, i) => (i === index ? { ...s, key } : s));
      persistShortcuts(updated);
      return { shortcuts: updated };
    }),
  setShortcutForAction: (labelKey, key) =>
    set((state) => {
      const updated = state.shortcuts.map((binding) =>
        binding.labelKey === labelKey ? { ...binding, key } : binding,
      );
      persistShortcuts(updated);
      return { shortcuts: updated };
    }),
  resetShortcuts: () => {
    const defaults = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS)) as ShortcutBinding[];
    persistShortcuts(defaults);
    set({ shortcuts: defaults });
  },
}));
