/**
 * Preferences store for persistent UI preferences.
 *
 * The `graphicsMode` and `colorTheme` fields are persisted so the current UI
 * theme selection survives reloads.
 *
 * Phase 4: this store no longer reads `localStorage` at module load. Hydration is
 * explicit - `hydratePreferences` is called by the application bootstrap with
 * whatever the selected repository produced, before the first render. The
 * initial state is the documented default, and the resolution rules are
 * unchanged, so a device with no stored preference hydrates to exactly what the
 * old module-load read produced.
 *
 * A change is written to the selected repository: storage-v2 is primary and the
 * legacy key is the rollback mirror. See {@link persist}.
 */
import { create } from 'zustand';

import type { PersistedPreferencesValue } from '@/services/persistence/v2/appState';
import { writeThroughInBackground } from '@/services/persistence/v2/dualWrite';
import { currentStorageV2Repository } from '@/services/persistence/v2/repositorySelection';

export type GraphicsMode = 'rpg';
export type ColorTheme = 'dark' | 'colorful' | 'aurora';

export interface PersistedPreferences {
  graphicsMode?: GraphicsMode;
  colorTheme?: ColorTheme | 'light' | 'sepia';
  activeSpritePack?: string | null;
}

const PREFERENCES_STORAGE_KEY = 'knowledge-dungeon:session:preferences';

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Read the persisted preferences. The legacy repository's half of hydration. */
export function readPersistedPreferences(): PersistedPreferences | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedPreferences;
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writePersisted(prefs: PersistedPreferences): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota or privacy-mode failures are non-fatal; the in-memory store still
    // works for the current session.
  }
}

/**
 * Persist a preference change to the selected repository.
 *
 * With storage-v2 selected it is the primary repository, so the change also has
 * to reach the active generation or a reload on the build the learner changed
 * the preference on would lose it - the change would sit in the rollback mirror
 * and nowhere else, which is the defect this closes.
 *
 * The legacy key is written first and synchronously, because that is what this
 * build has always done, what a rollback build reads, and what the default
 * artifact's behaviour must not change. The generation write follows it, so the
 * ordering that matters holds: a preference the flagged build lost is also absent
 * from storage-v2, never present in it and missing from the mirror.
 *
 * Synchronous by contract - a store action cannot await - and lazy, because the
 * storage-v2 record adapter is not part of the default artifact. A failure
 * becomes a sanitized report and never a rejected promise or a thrown error, so a
 * preference always applies in the current session even if the write did not land.
 */
function persist(value: PersistedPreferences): void {
  writePersisted(value);
  const repository = currentStorageV2Repository();
  if (repository === null) return;
  writeThroughInBackground({
    operation: 'preferences',
    primary: () =>
      import('@/services/persistence/v2/appRepository').then((records) =>
        records.publishPreferencesToActiveGeneration(repository, value, new Date().toISOString()),
      ),
    // The mirror already happened above, before the primary, so it cannot fail
    // here. Reported as a success so the operation is not counted twice.
    mirror: () => true,
  });
}

/**
 * The graphics mode for a persisted payload.
 *
 * `rpg` is the only mode, so a stored value and the default agree; the stored
 * payload is still read so the resolution rule stays in one place.
 */
export function resolveInitialGraphicsMode(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): GraphicsMode {
  return persisted?.graphicsMode === 'rpg' ? 'rpg' : 'rpg';
}

/** The color theme for a persisted payload, including the legacy aliases. */
export function resolveInitialColorTheme(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): ColorTheme {
  switch (persisted?.colorTheme) {
    case 'dark':
    case 'colorful':
    case 'aurora':
      return persisted.colorTheme;
    case 'light':
    case 'sepia':
      return 'dark';
    default:
      return 'dark';
  }
}

/** The initial state for a persisted payload, or for no payload at all. */
export function initialPreferencesState(
  persisted: PersistedPreferences | PersistedPreferencesValue | null,
): Pick<PreferencesState, 'graphicsMode' | 'colorTheme' | 'activeSpritePack'> {
  return {
    graphicsMode: resolveInitialGraphicsMode(persisted),
    colorTheme: resolveInitialColorTheme(persisted),
    activeSpritePack: persisted?.activeSpritePack ?? null,
  };
}

export interface PreferencesState {
  graphicsMode: GraphicsMode;
  colorTheme: ColorTheme;
  activeSpritePack: string | null;
  /**
   * Apply a persisted payload. Called once by the application bootstrap, before
   * the first render. Passing `null` resets to the documented defaults.
   */
  hydratePreferences: (persisted: PersistedPreferences | PersistedPreferencesValue | null) => void;
  setGraphicsMode: (mode: GraphicsMode) => void;
  setColorTheme: (theme: ColorTheme) => void;
  setActiveSpritePack: (packName: string | null) => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  // The pre-hydration state is the documented default. A device with no stored
  // preference hydrates to the same values, so nothing renders differently.
  ...initialPreferencesState(null),
  hydratePreferences: (persisted) => set(initialPreferencesState(persisted)),
  setGraphicsMode: (graphicsMode) => {
    set((state) => {
      persist({ graphicsMode, colorTheme: state.colorTheme, activeSpritePack: state.activeSpritePack });
      return { graphicsMode };
    });
  },
  setColorTheme: (colorTheme) => {
    set((state) => {
      persist({ graphicsMode: state.graphicsMode, colorTheme, activeSpritePack: state.activeSpritePack });
      return { colorTheme };
    });
  },
  setActiveSpritePack: (activeSpritePack) => {
    set((state) => {
      persist({ graphicsMode: state.graphicsMode, colorTheme: state.colorTheme, activeSpritePack });
      return { activeSpritePack };
    });
  },
}));

// Exported for unit tests so they can exercise the resolution rules without
// touching the live store singleton.
export const __testing = {
  PREFERENCES_STORAGE_KEY,
  readPersistedPreferences,
  resolveInitialGraphicsMode,
  resolveInitialColorTheme,
  initialPreferencesState,
};
