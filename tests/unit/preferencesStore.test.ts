import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';

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
  });

  it('keeps existing users on the mind-map look when no preference is stored', async () => {
    window.localStorage.setItem(STORAGE_KEYS.subjectIndex, JSON.stringify(['legacy-subject']));
    const { usePreferencesStore } = await loadStore();
    expect(usePreferencesStore.getState().graphicsMode).toBe('mindmap');
  });

  it('honours a previously persisted graphics-mode preference', async () => {
    window.localStorage.setItem(STORAGE_KEYS.subjectIndex, JSON.stringify(['legacy-subject']));
    const { __testing } = await loadStore();
    window.localStorage.setItem(
      __testing.PREFERENCES_STORAGE_KEY,
      JSON.stringify({ graphicsMode: 'rpg' }),
    );
    const { usePreferencesStore } = await loadStore();
    expect(usePreferencesStore.getState().graphicsMode).toBe('rpg');
  });

  it('persists changes via setGraphicsMode', async () => {
    const { usePreferencesStore, __testing } = await loadStore();
    usePreferencesStore.getState().setGraphicsMode('mindmap');
    expect(usePreferencesStore.getState().graphicsMode).toBe('mindmap');
    const raw = window.localStorage.getItem(__testing.PREFERENCES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}')).toEqual({ graphicsMode: 'mindmap' });
  });
});
