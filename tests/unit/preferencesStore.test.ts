import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORE_PATH = '@/store/preferencesStore';

type PreferencesStoreModule = typeof import('@/store/preferencesStore');

async function loadStore(): Promise<PreferencesStoreModule> {
  vi.resetModules();
  const mod = (await import(STORE_PATH)) as PreferencesStoreModule;
  return mod;
}

describe('preferencesStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('defaults new users to the RPG graphics mode', async () => {
    const { usePreferencesStore } = await loadStore();
    expect(usePreferencesStore.getState().graphicsMode).toBe('rpg');
    expect(usePreferencesStore.getState().colorTheme).toBe('dark');
  });

  it('keeps RPG mode for existing users when no preference is stored', async () => {
    window.localStorage.setItem('knowledge-dungeon:subjects:index', JSON.stringify(['legacy-subject']));
    const { usePreferencesStore } = await loadStore();
    expect(usePreferencesStore.getState().graphicsMode).toBe('rpg');
  });

  it('honours a previously persisted graphics-mode preference', async () => {
    const { __testing } = await loadStore();
    window.localStorage.setItem(
      __testing.PREFERENCES_STORAGE_KEY,
      JSON.stringify({ graphicsMode: 'rpg', colorTheme: 'colorful' }),
    );
    const { usePreferencesStore } = await loadStore();
    expect(usePreferencesStore.getState().graphicsMode).toBe('rpg');
    expect(usePreferencesStore.getState().colorTheme).toBe('colorful');
  });

  it('persists changes via setGraphicsMode', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    usePreferencesStore.getState().setGraphicsMode('rpg');
    expect(usePreferencesStore.getState().graphicsMode).toBe('rpg');
    const raw = window.localStorage.getItem(__testing.PREFERENCES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}')).toEqual({ graphicsMode: 'rpg', colorTheme: 'dark', activeSpritePack: null });
  });

  it('persists changes via setColorTheme', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    usePreferencesStore.getState().setColorTheme('aurora');
    expect(usePreferencesStore.getState().colorTheme).toBe('aurora');
    const raw = window.localStorage.getItem(__testing.PREFERENCES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}')).toEqual({ graphicsMode: 'rpg', colorTheme: 'aurora', activeSpritePack: null });
  });
});
