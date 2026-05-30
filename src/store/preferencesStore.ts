/**
 * Preferences store — currently this is intentionally RPG-only.
 *
 * We keep the `graphicsMode` field persisted in localStorage so existing
 * preference payloads remain compatible and future visual options can be
 * reintroduced without another storage shape change.
 */
import { create } from 'zustand';

export type GraphicsMode = 'rpg';

interface PersistedPreferences {
  graphicsMode?: GraphicsMode;
}

const PREFERENCES_STORAGE_KEY = 'knowledge-dungeon:session:preferences';

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readPersisted(): PersistedPreferences | null {
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

function resolveInitialGraphicsMode(): GraphicsMode {
  const persisted = readPersisted();
  return persisted?.graphicsMode === 'rpg' ? 'rpg' : 'rpg';
}

export interface PreferencesState {
  graphicsMode: GraphicsMode;
  setGraphicsMode: (mode: GraphicsMode) => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  graphicsMode: resolveInitialGraphicsMode(),
  setGraphicsMode: (graphicsMode) => {
    set({ graphicsMode });
    writePersisted({ graphicsMode });
  },
}));

// Exported for unit tests so they can exercise the resolution rules without
// touching the live store singleton.
export const __testing = {
  PREFERENCES_STORAGE_KEY,
  resolveInitialGraphicsMode,
};
