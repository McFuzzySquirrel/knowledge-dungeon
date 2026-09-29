import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORE_PATH = '@/store/preferencesStore';

type PreferencesStoreModule = typeof import('@/store/preferencesStore');

async function loadStore(): Promise<PreferencesStoreModule> {
  vi.resetModules();
  const mod = (await import(STORE_PATH)) as PreferencesStoreModule;
  return mod;
}

/**
 * Phase 10: audio preferences.
 *
 * These tests are the compatibility proof for adding five fields to a payload that
 * every other build in the rollback window also writes. The three cases that matter
 * are: a payload with no audio keys at all (the existing device), a payload with
 * hostile values in them (a corrupted or hand-edited write), and a payload written
 * by *this* build being read by a resolution rule that predates the fields.
 */
describe('preferencesStore audio preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('hydrates the documented audio defaults for a device that stored only a theme', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    // Exactly the payload a pre-Phase-10 build wrote.
    window.localStorage.setItem(
      __testing.PREFERENCES_STORAGE_KEY,
      JSON.stringify({ graphicsMode: 'rpg', colorTheme: 'colorful', activeSpritePack: null }),
    );

    usePreferencesStore.getState().hydratePreferences(__testing.readPersistedPreferences());

    const state = usePreferencesStore.getState();
    // The existing preference survives, and the new fields arrive at their defaults
    // rather than as `undefined` - which is what a slider bound to `undefined`
    // renders as "no value" and a gain node reads as `NaN`.
    expect(state.colorTheme).toBe('colorful');
    expect(state.musicVolume).toBe(0.4);
    expect(state.sfxVolume).toBe(0.6);
    expect(state.muted).toBe(false);
    expect(state.musicEnabled).toBe(true);
    expect(state.sfxEnabled).toBe(true);
  });

  it('hydrates the same defaults when there is no payload at all', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    usePreferencesStore.getState().hydratePreferences(__testing.readPersistedPreferences());
    expect(usePreferencesStore.getState()).toMatchObject({
      musicVolume: 0.4,
      sfxVolume: 0.6,
      muted: false,
      musicEnabled: true,
      sfxEnabled: true,
    });
  });

  it('honours stored audio values that are legal', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    window.localStorage.setItem(
      __testing.PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        graphicsMode: 'rpg',
        colorTheme: 'dark',
        activeSpritePack: null,
        musicVolume: 0.15,
        sfxVolume: 0.9,
        muted: true,
        musicEnabled: false,
        sfxEnabled: false,
      }),
    );

    usePreferencesStore.getState().hydratePreferences(__testing.readPersistedPreferences());

    expect(usePreferencesStore.getState()).toMatchObject({
      musicVolume: 0.15,
      sfxVolume: 0.9,
      muted: true,
      musicEnabled: false,
      sfxEnabled: false,
    });
  });

  it('coerces every hostile stored audio value to the documented default', async () => {
    const { __testing } = await loadStore();
    const resolve = __testing.initialAudioPreferencesState;

    // `localStorage` is writable by hand and is damaged by partial writes, so each of
    // these is reachable in the field. None of them may reach an `AudioParam`.
    expect(resolve({ musicVolume: '0.4', sfxVolume: null })).toMatchObject({
      musicVolume: 0.4,
      sfxVolume: 0.6,
    });
    expect(resolve({ musicVolume: Number.NaN })).toMatchObject({ musicVolume: 0.4 });
    // Out of range becomes the default rather than a clamp: `1e9` is not a learner
    // asking for loud, it is a payload this build did not write.
    expect(resolve({ musicVolume: 1e9, sfxVolume: -0.2 })).toMatchObject({
      musicVolume: 0.4,
      sfxVolume: 0.6,
    });
    expect(resolve({ muted: 'false', musicEnabled: 0, sfxEnabled: 'true' })).toMatchObject({
      muted: false,
      musicEnabled: true,
      sfxEnabled: true,
    });
  });

  it('clamps a live volume and persists it alongside the untouched fields', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    usePreferencesStore.getState().setColorTheme('aurora');
    usePreferencesStore.getState().setMusicVolume(3);

    expect(usePreferencesStore.getState().musicVolume).toBe(1);
    const raw = JSON.parse(window.localStorage.getItem(__testing.PREFERENCES_STORAGE_KEY) ?? '{}');
    // Every field is written, not just the one that changed. A partial payload here
    // would drop the colour theme on the next reload.
    expect(raw).toEqual({
      graphicsMode: 'rpg',
      colorTheme: 'aurora',
      activeSpritePack: null,
      musicVolume: 1,
      sfxVolume: 0.6,
      muted: false,
      musicEnabled: true,
      sfxEnabled: true,
    });
  });

  it('persists a mute change without disturbing the other audio fields', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    usePreferencesStore.getState().setSfxVolume(0.25);
    usePreferencesStore.getState().setMuted(true);

    const raw = JSON.parse(window.localStorage.getItem(__testing.PREFERENCES_STORAGE_KEY) ?? '{}');
    expect(raw).toMatchObject({ sfxVolume: 0.25, muted: true, musicVolume: 0.4 });
  });

  it('round-trips every audio field through storage', async () => {
    const { usePreferencesStore } = await loadStore();
    usePreferencesStore.getState().setMusicVolume(0.2);
    usePreferencesStore.getState().setSfxVolume(0.7);
    usePreferencesStore.getState().setMuted(true);
    usePreferencesStore.getState().setMusicEnabled(false);
    usePreferencesStore.getState().setSfxEnabled(false);

    // A fresh module instance is what a reload looks like: no in-memory state, only
    // what was written.
    const reloaded = await loadStore();
    reloaded.usePreferencesStore.getState().hydratePreferences(
      reloaded.__testing.readPersistedPreferences(),
    );

    expect(reloaded.usePreferencesStore.getState()).toMatchObject({
      musicVolume: 0.2,
      sfxVolume: 0.7,
      muted: true,
      musicEnabled: false,
      sfxEnabled: false,
    });
  });

  it('publishes the resolved values into the running audio service', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    // The audio manager is a singleton and importing the store does not touch it,
    // so this is the production seam rather than a test double: every audio change
    // goes through a store action, and the running mix has to follow without the
    // settings surface remembering to push it.
    const { audioManager } = await import('@/services/audioManager');

    usePreferencesStore.getState().setMuted(true);
    expect(audioManager.getState().muted).toBe(true);

    usePreferencesStore.getState().setMusicVolume(0.3);
    expect(audioManager.getState().musicVolume).toBe(0.3);

    usePreferencesStore.getState().setSfxVolume(5);
    expect(audioManager.getState().sfxVolume).toBe(1);

    // And hydration resets the running mix rather than leaving it as it was. The
    // stored payload is cleared first, so this models a device with *no* audio keys
    // - the case where hydration has to actively write the defaults into the
    // manager, rather than leaving whatever was there.
    usePreferencesStore.getState().setMuted(false);
    window.localStorage.clear();
    usePreferencesStore.getState().hydratePreferences(__testing.readPersistedPreferences());
    expect(audioManager.getState()).toMatchObject({
      muted: false,
      musicVolume: 0.4,
      sfxVolume: 0.6,
      musicEnabled: true,
      sfxEnabled: true,
    });
  });

  it('ignores audio keys it does not recognise rather than failing hydration', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    // A payload from a *newer* build, which is what a rollback window can contain.
    window.localStorage.setItem(
      __testing.PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        graphicsMode: 'rpg',
        colorTheme: 'dark',
        activeSpritePack: null,
        ambienceProfile: 'rainy-harbour',
        futureField: 42,
      }),
    );

    expect(() =>
      usePreferencesStore.getState().hydratePreferences(__testing.readPersistedPreferences()),
    ).not.toThrow();
    expect(usePreferencesStore.getState().colorTheme).toBe('dark');
  });
});

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
    // The payload carries all five Phase 10 audio fields as well, at their documented
    // defaults, because every setter writes the whole payload.
    expect(JSON.parse(raw ?? '{}')).toEqual({
      graphicsMode: 'rpg',
      colorTheme: 'dark',
      activeSpritePack: null,
      musicVolume: 0.4,
      sfxVolume: 0.6,
      muted: false,
      musicEnabled: true,
      sfxEnabled: true,
    });
  });

  it('persists changes via setColorTheme', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    usePreferencesStore.getState().setColorTheme('aurora');
    expect(usePreferencesStore.getState().colorTheme).toBe('aurora');
    const raw = window.localStorage.getItem(__testing.PREFERENCES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}')).toEqual({
      graphicsMode: 'rpg',
      colorTheme: 'aurora',
      activeSpritePack: null,
      musicVolume: 0.4,
      sfxVolume: 0.6,
      muted: false,
      musicEnabled: true,
      sfxEnabled: true,
    });
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
      musicVolume: 0.4,
      sfxVolume: 0.6,
      muted: false,
      musicEnabled: true,
      sfxEnabled: true,
    });
    // The generation write is asynchronous and lands after the lazy import, so it
    // is not observable in the same tick as the synchronous setter.
    expect(published).toEqual([]);
    await vi.waitFor(() =>
      expect(published).toEqual([
        {
          graphicsMode: 'rpg',
          colorTheme: 'colorful',
          activeSpritePack: null,
          musicVolume: 0.4,
          sfxVolume: 0.6,
          muted: false,
          musicEnabled: true,
          sfxEnabled: true,
        },
      ]),
    );
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
