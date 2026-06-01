import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORE_PATH = '@/store/progressionStore';

type ProgressionStoreModule = typeof import('@/store/progressionStore');

async function loadStore(): Promise<ProgressionStoreModule> {
  vi.resetModules();
  const mod = (await import(STORE_PATH)) as ProgressionStoreModule;
  return mod;
}

describe('progressionStore subject scoping', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('keeps badges and xp isolated per subject', async () => {
    const { useProgressionStore } = await loadStore();

    useProgressionStore.getState().setActiveSubject('subject-a');
    useProgressionStore.getState().awardBadge('CreatorPhaseComplete');

    expect(useProgressionStore.getState().badges).toContain('CreatorPhaseComplete');

    useProgressionStore.getState().setActiveSubject('subject-b');
    expect(useProgressionStore.getState().badges).toEqual([]);
    expect(useProgressionStore.getState().xpTotal).toBe(0);

    useProgressionStore.getState().setActiveSubject('subject-a');
    expect(useProgressionStore.getState().badges).toContain('CreatorPhaseComplete');
  });

  it('keeps collected notes isolated per subject', async () => {
    const { useProgressionStore } = await loadStore();

    useProgressionStore.getState().setActiveSubject('subject-a');
    const addedInA = useProgressionStore.getState().collectArtifactNote({
      dungeonId: 'subject-a',
      roomId: 'room-1',
      topic: 'Vectors',
      floorLabel: 'Linear Algebra',
      artifactPreview: 'Vector space summary',
      noteMarkdown: '## Notes\nVectors',
      artifactMarkdown: '## Artifact\nVectors',
    });
    expect(addedInA).toBe(true);
    expect(useProgressionStore.getState().collectedNotes).toHaveLength(1);

    useProgressionStore.getState().setActiveSubject('subject-b');
    expect(useProgressionStore.getState().collectedNotes).toHaveLength(0);

    const addedInB = useProgressionStore.getState().collectArtifactNote({
      dungeonId: 'subject-b',
      roomId: 'room-2',
      topic: 'Integrals',
      floorLabel: 'Calculus',
      artifactPreview: 'Integral techniques',
      noteMarkdown: '## Notes\nIntegrals',
      artifactMarkdown: '## Artifact\nIntegrals',
    });
    expect(addedInB).toBe(true);
    expect(useProgressionStore.getState().collectedNotes).toHaveLength(1);

    useProgressionStore.getState().setActiveSubject('subject-a');
    expect(useProgressionStore.getState().collectedNotes).toHaveLength(1);
    expect(useProgressionStore.getState().collectedNotes[0]?.topic).toBe('Vectors');
  });
});
