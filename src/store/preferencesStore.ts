/**
 * Preferences store for persistent UI preferences.
 *
 * We keep the `graphicsMode` and `colorTheme` fields in localStorage so the
 * current UI theme selection survives reloads.
 */
import { create } from 'zustand';

export type GraphicsMode = 'rpg';
export type ColorTheme = 'dark' | 'colorful' | 'aurora';

interface PersistedPreferences {
  graphicsMode?: GraphicsMode;
  colorTheme?: ColorTheme | 'light' | 'sepia';
  activeSpritePack?: string | null;
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

function resolveInitialColorTheme(): ColorTheme {
  const persisted = readPersisted();
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

export interface PreferencesState {
  graphicsMode: GraphicsMode;
  colorTheme: ColorTheme;
  activeSpritePack: string | null;
  setGraphicsMode: (mode: GraphicsMode) => void;
  setColorTheme: (theme: ColorTheme) => void;
  setActiveSpritePack: (packName: string | null) => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  graphicsMode: resolveInitialGraphicsMode(),
  colorTheme: resolveInitialColorTheme(),
  activeSpritePack: readPersisted()?.activeSpritePack ?? null,
  setGraphicsMode: (graphicsMode) => {
    set((state) => {
      writePersisted({ graphicsMode, colorTheme: state.colorTheme, activeSpritePack: state.activeSpritePack });
      return { graphicsMode };
    });
  },
  setColorTheme: (colorTheme) => {
    set((state) => {
      writePersisted({ graphicsMode: state.graphicsMode, colorTheme, activeSpritePack: state.activeSpritePack });
      return { colorTheme };
    });
  },
  setActiveSpritePack: (activeSpritePack) => {
    set((state) => {
      writePersisted({ graphicsMode: state.graphicsMode, colorTheme: state.colorTheme, activeSpritePack });
      return { activeSpritePack };
    });
  },
}));

// Exported for unit tests so they can exercise the resolution rules without
// touching the live store singleton.
export const __testing = {
  PREFERENCES_STORAGE_KEY,
  resolveInitialGraphicsMode,
  resolveInitialColorTheme,
};
