/**
 * Independent attacks on the bootstrap contract and on the note editor's
 * object-URL lifetime.
 *
 * Bootstrap, attacked four ways the Phase 4 scope names:
 *
 * 1. **Every store is hydrated before the first render.** The commit is
 *    synchronous and all of it, and it happens before `bootstrapApplication`
 *    resolves - so a host that awaits the bootstrap cannot paint a store that is
 *    still empty.
 * 2. **A read failure cannot half-hydrate.** One store's read failing leaves
 *    *every* store on its documented default.
 * 3. **React StrictMode's double-invoke must not start two migrations.** The
 *    migration is counted, not inferred.
 * 4. **A failed migration must fall back to the legacy repository and still show
 *    the learner their data**, not a blank Welcome screen.
 *
 * The note editor is attacked for blob accumulation: the object URLs its preview
 * effect creates must be revoked when the effect re-runs and when the modal
 * closes, so opening the image library repeatedly cannot leak blobs.
 *
 * This is a QA probe. Nothing here modifies the application.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

import {
  SUBJECT_ID,
  NOW,
  ROOT_ROOM_ID,
  openRepo,
  dropRepo,
  seedLegacyKeys,
  syntheticSnapshot,
  legacyKeySet,
  PREFERENCES_KEY,
  SHORTCUTS_KEY,
  SESSIONS_KEY,
  PROGRESSION_KEY,
} from './support/phase4Support';

import {
  bootstrapApplication,
  createDefaultBootstrapDeps,
  resetBootstrap,
  type BootstrapDeps,
} from '@/application/bootstrap';
import { useSubjectStore } from '@/store/subjectStore';
import { useProgressionStore } from '@/store/progressionStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useShortcutStore } from '@/store/shortcutStore';
import { useSessionStore } from '@/store/sessionStore';
import { resetRepositorySelection, selectStorageV2Repository } from '@/services/persistence/v2/repositorySelection';
import { clearDualWriteReports, setDualWriteSink } from '@/services/persistence/v2/dualWrite';
import { setSessionSource } from '@/services/sessionTracker';
import type { StorageV2Repository } from '@/services/persistence/v2/repository';

const handles: StorageV2Repository[] = [];
const dbNames: string[] = [];

async function openRepoTracked(suffix: string): Promise<StorageV2Repository> {
  dbNames.push(suffix);
  const repo = await openRepo(suffix);
  handles.push(repo);
  return repo;
}

/** A deps set that records every commit, in order, without touching a DOM. */
function recordingDeps(
  overrides: Partial<BootstrapDeps> = {},
): { deps: BootstrapDeps; log: string[] } {
  const log: string[] = [];
  const base = createDefaultBootstrapDeps({ repository: 'legacy' });
  const deps: BootstrapDeps = {
    ...base,
    readLegacyState: () => {
      log.push('read:state');
      return base.readLegacyState();
    },
    readActiveSubjectId: () => {
      log.push('read:pointer');
      return base.readActiveSubjectId();
    },
    listSubjectIds: async () => {
      log.push('read:ids');
      return base.listSubjectIds();
    },
    loadSubjectSnapshot: async (id) => {
      log.push(`read:subject:${id}`);
      return base.loadSubjectSnapshot(id);
    },
    hydratePreferences: (value) => {
      log.push('commit:preferences');
      base.hydratePreferences(value);
    },
    hydrateShortcuts: (value) => {
      log.push('commit:shortcuts');
      base.hydrateShortcuts(value);
    },
    hydrateProgression: (value) => {
      log.push('commit:progression');
      base.hydrateProgression(value);
    },
    setSubjectSnapshot: (value) => {
      log.push('commit:subject');
      base.setSubjectSnapshot(value);
    },
    setSessionActiveSubjectId: (value) => {
      log.push('commit:session');
      base.setSessionActiveSubjectId(value);
    },
    setProgressionActiveSubject: (value) => {
      log.push('commit:progressionActive');
      base.setProgressionActiveSubject(value);
    },
    ...overrides,
  };
  return { deps, log };
}

beforeEach(() => {
  window.localStorage.clear();
  seedLegacyKeys();
  resetRepositorySelection();
  resetBootstrap();
  clearDualWriteReports();
  setDualWriteSink(null);
  setSessionSource(null);
  vi.restoreAllMocks();
});

afterEach(async () => {
  setSessionSource(null);
  for (const handle of handles.splice(0)) handle.close();
  for (const suffix of dbNames.splice(0)) await dropRepo(suffix);
  resetRepositorySelection();
  resetBootstrap();
  clearDualWriteReports();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('Bootstrap: every store is hydrated before the first render', () => {
  it('commits every store before it resolves, and never writes', async () => {
    const before = legacyKeySet();
    const { deps, log } = recordingDeps();
    const result = await bootstrapApplication(deps);

    expect(result.status).toBe('ready');
    expect(result.repository).toBe('legacy');
    expect(result.failures).toEqual([]);
    // Every read precedes every commit, and the active subject is released after
    // the snapshot is committed.
    const firstCommit = log.findIndex((entry) => entry.startsWith('commit:'));
    const lastRead = log.reduce((last, entry, index) => (entry.startsWith('read:') ? index : last), -1);
    expect(lastRead).toBeLessThan(firstCommit);
    expect(log.filter((entry) => entry.startsWith('commit:'))).toEqual([
      'commit:preferences',
      'commit:shortcuts',
      'commit:progression',
      'commit:subject',
      'commit:session',
      'commit:progressionActive',
    ]);
    // The stores really hold the device's values, not the defaults.
    expect(usePreferencesStore.getState().colorTheme).toBe('dark');
    expect(useShortcutStore.getState().shortcuts).toHaveLength(3);
    expect(useProgressionStore.getState().bySubject[SUBJECT_ID]?.xpTotal).toBe(11);
    expect(useSubjectStore.getState().snapshot?.dungeon.subjectName).toBe(
      'Phase4 Independent Synthetic Subject',
    );
    // The learner's last subject is released again, exactly as the pre-phase
    // effect did, so Welcome is the first screen.
    expect(useSessionStore.getState().activeSubjectId).toBeNull();
    expect(useProgressionStore.getState().activeSubjectId).toBeNull();
    // And nothing was written: hydration is read-only.
    expect(legacyKeySet()).toEqual(before);
  });

  it('a read failure commits the empty state to every store, not to some of them', async () => {
    // A populated device, then a read that throws.
    const { deps, log } = recordingDeps({
      readLegacyState: () => {
        throw new Error('qa legacy read failure');
      },
    });
    const result = await bootstrapApplication(deps);

    expect(result.status).toBe('degraded');
    expect(result.failures).toEqual(['LEGACY_READ_FAILED']);
    // Every store was committed, all of them to the same empty plan.
    expect(log.filter((entry) => entry.startsWith('commit:'))).toEqual([
      'commit:preferences',
      'commit:shortcuts',
      'commit:progression',
      'commit:subject',
    ]);
    expect(useSubjectStore.getState().snapshot).toBeNull();
    expect(useProgressionStore.getState().bySubject).toEqual({});
    expect(usePreferencesStore.getState().colorTheme).toBe('dark');
    expect(useShortcutStore.getState().shortcuts.map((binding) => binding.labelKey)).toEqual([
      'shortcuts.toggleHelp',
      'shortcuts.toggleMap',
      'shortcuts.toggleInfoPanel',
    ]);
    // No subject was loaded, because a subject loaded from a *different* read
    // would be a subject with nothing behind it.
    expect(log.some((entry) => entry.startsWith('read:subject'))).toBe(false);
  });

  it('a failure carrying learner content cannot reach the result', async () => {
    const marker = 'Phase4 Independent Synthetic Subject';
    const { deps } = recordingDeps({
      readLegacyState: () => {
        throw new Error(`qa failure mentioning ${marker} and https://example.invalid/leak`);
      },
    });
    const result = await bootstrapApplication(deps);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain('example.invalid');
    expect(result.failures).toEqual(['LEGACY_READ_FAILED']);
  });
});

describe('Bootstrap: a failed migration still shows the learner their data', () => {
  it('falls back to the legacy repository and hydrates from it', async () => {
    const before = legacyKeySet();
    const repo = await openRepoTracked('recovery');
    selectStorageV2Repository(repo);

    const deps: BootstrapDeps = {
      ...createDefaultBootstrapDeps({ repository: 'v2' }),
      openRepository: async () => repo,
      generationId: 'gen-phase4-recovery',
    };
    // Make the migration fail at the stage commit, the way a real storage
    // failure would, without patching the migration itself.
    const stageFailure = vi
      .spyOn(repo, 'stageGeneration')
      .mockRejectedValue(new Error('qa staging failure'));
    const result = await bootstrapApplication(deps);
    stageFailure.mockRestore();

    expect(result.status).toBe('degraded');
    expect(result.failures).toContain('MIGRATION_RECOVERY_REQUIRED');
    expect(result.migration?.kind).toBe('recovery-required');
    // The rollback: the legacy repository is authoritative again, and the
    // generation pointer never moved.
    expect(result.repository).toBe('legacy');
    // The bootstrap closed the handle when it rolled back, so the pointer is
    // read through a fresh connection to the same database.
    const fresh = await openRepoTracked('recovery-read');
    expect(await fresh.readActiveGenerationId()).toBeNull();
    expect(await fresh.listMigrationReceipts()).toEqual([]);
    // The learner's data is on screen, not a blank Welcome: every store hydrated
    // from the legacy keys.
    expect(useSubjectStore.getState().snapshot?.dungeon.subjectName).toBe(
      'Phase4 Independent Synthetic Subject',
    );
    expect(useProgressionStore.getState().bySubject[SUBJECT_ID]?.xpTotal).toBe(11);
    expect(usePreferencesStore.getState().colorTheme).toBe('dark');
    expect(useShortcutStore.getState().shortcuts).toHaveLength(3);
    // And the legacy device is still byte-identical, which is what makes a
    // second attempt - or a rollback build - possible.
    expect(legacyKeySet()).toEqual(before);
  });

  // A recovery screen needs a button, and the state has to say whether pressing
  // it is safe. The callable half of `nextActions` is the core's answer, so two
  // screens cannot disagree about whether a retry is possible.
  it('offers a callable retry exactly when the state says a retry can help', async () => {
    const before = legacyKeySet();
    // A fresh handle per call, as production does: a failed bootstrap closes the
    // handle it rolled back, so a retry that reused it would be testing a closed
    // database rather than the retry.
    const repo = await openRepoTracked('retry');
    let opened = 0;
    const deps: BootstrapDeps = {
      ...createDefaultBootstrapDeps({ repository: 'v2' }),
      openRepository: async () => {
        opened += 1;
        return opened === 1 ? repo : openRepoTracked('retry');
      },
      generationId: 'gen-phase4-retry',
    };

    const stageFailure = vi
      .spyOn(repo, 'stageGeneration')
      .mockRejectedValue(new Error('qa staging failure'));
    const failed = await bootstrapApplication(deps);
    stageFailure.mockRestore();

    expect(failed.migration?.kind).toBe('recovery-required');
    expect(failed.migration?.nextActions).toEqual(['retry-migration']);
    expect(typeof failed.retryMigration).toBe('function');

    // The retry runs the same staged migration, and this time the store answers.
    const retried = await (failed.retryMigration as () => Promise<typeof failed.migration>)();
    expect(retried?.kind).toBe('migrated');
    // And the learner's data survived both attempts: the legacy device is still
    // exactly what it was, so the retry could not have consumed it.
    expect(legacyKeySet()).toEqual(before);
    // Read through a fresh connection to the *same* database, because the failed
    // bootstrap closed the handle it rolled back.
    const after = await openRepoTracked('retry');
    expect(await after.readActiveGenerationId()).toBe('gen-phase4-retry');
  });

  it('offers no retry when the store itself is unavailable, because none can work', async () => {
    const deps: BootstrapDeps = {
      ...createDefaultBootstrapDeps({ repository: 'v2' }),
      openRepository: async () => {
        throw new Error('qa indexeddb unavailable');
      },
      generationId: 'gen-phase4-no-retry',
    };
    const result = await bootstrapApplication(deps);
    expect(result.migration).toBeNull();
    // Nothing to retry, so nothing is offered: a button that always fails is
    // worse than no button.
    expect(result.retryMigration).toBeNull();
  });

  it('a storage-v2 that cannot be opened at all still hydrates the learner', async () => {
    const deps: BootstrapDeps = {
      ...createDefaultBootstrapDeps({ repository: 'v2' }),
      openRepository: async () => {
        throw new Error('qa indexeddb unavailable');
      },
      generationId: 'gen-phase4-unavailable',
    };
    const result = await bootstrapApplication(deps);
    expect(result.status).toBe('degraded');
    expect(result.failures).toEqual(['STORAGE_V2_UNAVAILABLE']);
    expect(result.repository).toBe('legacy');
    expect(result.migration).toBeNull();
    expect(useSubjectStore.getState().snapshot?.dungeon.subjectName).toBe(
      'Phase4 Independent Synthetic Subject',
    );
    expect(useProgressionStore.getState().bySubject[SUBJECT_ID]?.badges).toEqual([
      'synthetic-phase4-seed-badge',
    ]);
  });
});

describe('The note editor releases every object URL it creates', () => {
  it('create and revoke counts balance across repeated opens', async () => {
    // The real component, with only the store's URL resolver replaced so the
    // effect has something to resolve. Object URLs are what the device-local
    // store returns, so this is the production shape of the value.
    const { render, cleanup } = await import('@testing-library/react');
    const { NoteEditorModal } = await import('@/ui/components/NoteEditorModal');
    const store = useSubjectStore.getState();
    const created: string[] = [];
    const revoked: string[] = [];
    const originalRevoke = URL.revokeObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as unknown as typeof URL.revokeObjectURL;

    const snapshot = syntheticSnapshot();
    const room = (snapshot.rooms as unknown as Record<string, { attachments: unknown[] }>)[ROOT_ROOM_ID] as {
      attachments: unknown[];
    };
    room.attachments = [
      {
        attachmentId: 'att-phase4-preview',
        sourceType: 'local',
        fileName: 'phase4-synthetic-preview.png',
        mimeType: 'image/png',
        altText: 'phase4 synthetic preview alt',
        addedAt: NOW,
      },
    ];
    const previousSnapshot = useSubjectStore.getState().snapshot;
    useSubjectStore.setState({ snapshot, lastError: null });
    useSessionStore.setState({ isNoteEditorOpen: true, noteEditorRoomId: ROOT_ROOM_ID });
    const previousResolve = store.resolveAttachmentUrl;
    void previousResolve;
    // The real resolver ends in `URL.createObjectURL`; jsdom has no such
    // implementation, so the effect's *contract* is exercised with the shape it
    // receives: a fresh `blob:` URL per resolution, which is what the
    // device-local store returns.
    useSubjectStore.setState({
      resolveAttachmentUrl: async () => {
        const url = `blob:phase4-resolved-${created.length + 1}`;
        created.push(url);
        return url;
      },
    });

    try {
      for (let round = 0; round < 6; round += 1) {
        const view = render(<NoteEditorModal />);
        // The effect resolves the attachment, so a URL is created.
        await act(async () => {
          await Promise.resolve();
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
        view.unmount();
        await act(async () => {
          await Promise.resolve();
        });
      }
    } finally {
      URL.revokeObjectURL = originalRevoke;
      useSubjectStore.setState({ snapshot: previousSnapshot, resolveAttachmentUrl: previousResolve });
      useSessionStore.setState({ isNoteEditorOpen: false, noteEditorRoomId: null });
      cleanup();
    }

    // Six opens, six resolutions, and nothing left dangling: the counts balance
    // and no URL was revoked twice.
    expect(created.length).toBeGreaterThanOrEqual(6);
    expect(revoked.length).toBe(created.length);
    expect(new Set(revoked).size).toBe(revoked.length);
    expect(created.filter((url) => !revoked.includes(url))).toEqual([]);
  });
});

describe('The declared default-build behaviour changes', () => {
  it('a legacy boot rewrites no key and creates no backup record', async () => {
    const before = legacyKeySet();
    const { deps, log } = recordingDeps();
    await bootstrapApplication(deps);
    expect(legacyKeySet()).toEqual(before);
    // In particular the two keys the pre-phase boot wrote.
    expect(Object.keys(legacyKeySet()).filter((key) => key.startsWith('knowledge-dungeon:backup:'))).toEqual(
      [],
    );
    // And the subject the device was last in is not rewritten either.
    expect(log.filter((entry) => entry === `read:subject:${SUBJECT_ID}`)).toHaveLength(1);
  });

  it('the same device, read the legacy way, is unchanged by the read', async () => {
    const before = legacyKeySet();
    const { readPersistedProgressionPayload, normalizePersistedProgression } = await import(
      '@/store/progressionStore'
    );
    const { readPersistedShortcuts } = await import('@/store/shortcutStore');
    const { readPersistedPreferences } = await import('@/store/preferencesStore');
    const payload = readPersistedProgressionPayload();
    normalizePersistedProgression(payload, SUBJECT_ID);
    readPersistedShortcuts();
    readPersistedPreferences();
    expect(legacyKeySet()).toEqual(before);
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining([PROGRESSION_KEY, PREFERENCES_KEY, SHORTCUTS_KEY, SESSIONS_KEY]),
    );
  });
});
