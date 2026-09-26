/**
 * A small helper for reading the real progression store's hydrated state.
 *
 * Phase 4 removed the module-load read from the store, so a test that wants to
 * compare against a hydrated store has to hydrate it the way the application
 * bootstrap does. Doing that in one place keeps every comparison in the suite
 * honest about *which* hydration it is measuring.
 */
import { readPersistedProgressionPayload, useProgressionStore } from '@/store/progressionStore';

/** Hydrate the real store from the legacy key, then return its public state. */
export function readProgressionStoreState(): ReturnType<typeof useProgressionStore.getState> {
  useProgressionStore.getState().hydrateProgression(readPersistedProgressionPayload());
  return useProgressionStore.getState();
}
