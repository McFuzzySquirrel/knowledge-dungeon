/**
 * Preferences store — durable, user-facing display settings that survive
 * across sessions.
 *
 * Today this only carries `graphicsMode`, which selects between the original
 * mind-map look (`mindmap`) and the richer RPG dungeon style (`rpg`). The
 * value is persisted to `localStorage` so the choice is remembered across
 * page reloads in both the web and Electron builds.
 *
 * Default policy:
 *  - Fresh users (no persisted preferences) get `rpg` — the more inviting
 *    first impression.
 *  - Pre-existing installs that already have subject data but no stored
 *    preference are nudged back to `mindmap` so the UI does not visually
 *    re-skin out from under them on upgrade.
 */
import { create } from 'zustand';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';

export type GraphicsMode = 'mindmap' | 'rpg';

interface PersistedPreferences {
  graphicsMode?: GraphicsMode;
}

const PREFERENCES_STORAGE_KEY = `${STORAGE_KEYS.session}:preferences`;
const LEGACY_SUBJECT_INDEX_KEY = STORAGE_KEYS.subjectIndex;

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

function detectExistingUser(): boolean {
  if (!hasWindow()) return false;
  try {
    const subjectsRaw = window.localStorage.getItem(LEGACY_SUBJECT_INDEX_KEY);
    if (!subjectsRaw) return false;
    const ids = JSON.parse(subjectsRaw) as unknown;
    return Array.isArray(ids) && ids.length > 0;
  } catch {
    return false;
  }
}

function resolveInitialGraphicsMode(): GraphicsMode {
  const persisted = readPersisted();
  if (persisted?.graphicsMode === 'mindmap' || persisted?.graphicsMode === 'rpg') {
    return persisted.graphicsMode;
  }
  // No persisted preference: keep existing users on the mind-map look they
  // already know, and onboard new users into the RPG style.
  return detectExistingUser() ? 'mindmap' : 'rpg';
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
