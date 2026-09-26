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
    vi.doUnmock('@/services/persistence/v2/repositorySelection');
    vi.doUnmock('@/services/persistence/v2/appRepository');
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
    const { __testing, usePreferencesStore } = await loadStore();
    window.localStorage.setItem(
      __testing.PREFERENCES_STORAGE_KEY,
      JSON.stringify({ graphicsMode: 'rpg', colorTheme: 'colorful' }),
    );
    // Phase 4: the store no longer reads `localStorage` at module load. The
    // application bootstrap owns hydration, and for the legacy repository it is
    // exactly this pair of calls: read the persisted payload, apply it. The
    // assertion below is unchanged - a previously persisted preference is still
    // honoured.
    usePreferencesStore.getState().hydratePreferences(__testing.readPersistedPreferences());
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

  // Phase 4 regression: the setters wrote only the legacy key, so on a flagged
  // device a preference changed by the learner was gone on reload - the change
  // was in the rollback mirror and nowhere else. `publishPreferencesToActiveGeneration`
  // existed and had no caller.
  it('publishes a change to the active generation, not only to the legacy mirror', async () => {
    const published: unknown[] = [];
    vi.doMock('@/services/persistence/v2/repositorySelection', () => ({
      currentStorageV2Repository: () => ({}) as never,
      isStorageV2Selected: () => true,
      selectStorageV2Repository: () => {},
      selectLegacyRepository: () => {},
    }));
    vi.doMock('@/services/persistence/v2/appRepository', () => ({
      publishPreferencesToActiveGeneration: async (_repository: unknown, value: unknown) => {
        published.push(value);
      },
    }));

    const { usePreferencesStore, __testing } = await loadStore();
    usePreferencesStore.getState().setColorTheme('colorful');
    // The legacy key is still written synchronously, exactly as before, so the
    // default build's behaviour is unchanged and a rollback build sees the change.
    expect(JSON.parse(window.localStorage.getItem(__testing.PREFERENCES_STORAGE_KEY) ?? '{}')).toEqual({
      graphicsMode: 'rpg',
      colorTheme: 'colorful',
      activeSpritePack: null,
    });
    // The generation write is asynchronous and lands after the lazy import, so it
    // is not observable in the same tick as the synchronous setter.
    expect(published).toEqual([]);
    await vi.waitFor(() => expect(published).toEqual([{ graphicsMode: 'rpg', colorTheme: 'colorful', activeSpritePack: null }]));
  });

  it('reports a generation write failure instead of rejecting the setter', async () => {
    vi.doMock('@/services/persistence/v2/repositorySelection', () => ({
      currentStorageV2Repository: () => ({}) as never,
      isStorageV2Selected: () => true,
      selectStorageV2Repository: () => {},
      selectLegacyRepository: () => {},
    }));
    vi.doMock('@/services/persistence/v2/appRepository', () => ({
      publishPreferencesToActiveGeneration: async () => {
        throw new Error('synthetic generation write failure');
      },
    }));

    const { usePreferencesStore } = await loadStore();
    // Imported after the reset, so this is the same module instance the store uses.
    const { clearDualWriteReports, dualWriteReports } = await import('@/services/persistence/v2/dualWrite');
    clearDualWriteReports();

    // The setter is synchronous and must not throw: the preference applies in this
    // session either way, and the failure is reported rather than swallowed.
    expect(() => usePreferencesStore.getState().setColorTheme('aurora')).not.toThrow();
    expect(usePreferencesStore.getState().colorTheme).toBe('aurora');
    expect(dualWriteReports()).toEqual([]);
    await vi.waitFor(() =>
      expect(dualWriteReports()).toEqual([
        { sequence: 1, operation: 'preferences', outcome: 'primary-failed', code: 'STORAGE_V2_WRITE_FAILED' },
      ]),
    );
  });
});
