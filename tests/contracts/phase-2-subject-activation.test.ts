/**
 * Phase 2 contract test: `activateSubject` is the single subject-activation
 * implementation.
 *
 * `src/application/subjectActivation.ts` is the one place that turns a subject
 * id into "this subject is active". The plan requires it to be the only
 * implementation, so this file pins:
 * - a failed load returns `activated: false` and writes nothing at all
 * - a successful load points both the session and the progression store at
 *   `loaded.dungeon.dungeonId` (not the requested id - they can differ)
 * - repeated calls are idempotent
 * - `useLoadSubjectFlow` is a thin React wrapper that delegates to it, proven
 *   both behaviourally (the hook's boolean equals `activateSubject`'s
 *   `activated` for the same injected deps) and structurally (the hook source
 *   contains no second copy of the activation writes)
 *
 * All fixtures are synthetic: `synthetic-*` ids and `Test Room *` topics
 * invented here. No learner data, and nothing is written to a snapshot file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SubjectActivationDeps } from '@/application/subjectActivation';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import { STORAGE_KEYS } from '@/services/persistence/subjectPersistence';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { activateSubject, defaultSubjectActivationDeps } from '@/application/subjectActivation';
import { useLoadSubjectFlow } from '@/ui/hooks/useLoadSubjectFlow';

// The hook and the village flow both import the module under test, so the spy
// records every delegation while still running the real implementation.
const activationSpy = vi.hoisted(() => ({ activate: vi.fn() }));

vi.mock('@/application/subjectActivation', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/application/subjectActivation')>();
  activationSpy.activate.mockImplementation(actual.activateSubject);
  return { ...actual, activateSubject: activationSpy.activate };
});

// ── Synthetic fixtures ──────────────────────────────────────────────────────

const SYNTHETIC_SUBJECT_ID = 'synthetic-subject-1';
const SYNTHETIC_STORED_ID = 'synthetic-stored-subject';
const SYNTHETIC_ROOM_ROOT = 'synthetic-room-root';
const SYNTHETIC_NOW = '2026-09-25T00:00:00.000Z';

/**
 * A minimal synthetic snapshot. `dungeonId` is deliberately different from the
 * key it is stored under, so a test that asserted the *requested* id instead of
 * `loaded.dungeon.dungeonId` would fail.
 */
function makeSyntheticSnapshot(
  dungeonId: string = SYNTHETIC_STORED_ID,
): SubjectSnapshot {
  const rootRoom: RoomMetadata = {
    ...makeEmptyRoomMetadata({
      roomId: SYNTHETIC_ROOM_ROOT,
      topic: 'Test Room Root',
      nowIso: SYNTHETIC_NOW,
    }),
    validationState: { ...makeEmptyValidationState(), finalPass: true },
  };
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId,
      subjectName: 'Synthetic Test Subject',
      createdAt: SYNTHETIC_NOW,
      updatedAt: SYNTHETIC_NOW,
      phaseState: 'ScribeActive',
      rootRoomId: SYNTHETIC_ROOM_ROOT,
      rooms: [{ roomId: SYNTHETIC_ROOM_ROOT, topic: 'Test Room Root', status: 'Created' }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    },
    rooms: { [SYNTHETIC_ROOM_ROOT]: rootRoom },
  };
}

/** The fake port shape, with the spies still statically accessible. */
interface FakeActivationDeps extends SubjectActivationDeps {
  loadSubject: Mock<(subjectId: string) => Promise<SubjectSnapshot | null>>;
  setSessionActiveSubjectId: Mock<(subjectId: string | null) => void>;
  setProgressionActiveSubject: Mock<(subjectId: string | null) => void>;
}

/** Fake store side effects that also record the call order. */
function makeDeps(
  load: SubjectActivationDeps['loadSubject'] = async () => makeSyntheticSnapshot(),
): FakeActivationDeps {
  return {
    loadSubject: vi.fn(load),
    setSessionActiveSubjectId: vi.fn(),
    setProgressionActiveSubject: vi.fn(),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Phase 2 subject activation', () => {
  beforeEach(() => {
    activationSpy.activate.mockClear();
    window.localStorage.clear();
    // The three stores are module singletons, so their state has to be reset
    // explicitly for one activation test not to leak into the next.
    useSessionStore.setState({ activeSubjectId: null });
    useSubjectStore.setState({ snapshot: null, lastError: null });
    useProgressionStore.setState({ activeSubjectId: null, badges: [], xpTotal: 0 });
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('with injected store side effects', () => {
    it('returns activated: false and writes nothing when the load fails', async () => {
      const deps = makeDeps(async () => null);

      const result = await activateSubject(SYNTHETIC_SUBJECT_ID, deps);

      expect(result).toEqual({ activated: false, subjectId: null, snapshot: null });
      expect(deps.loadSubject).toHaveBeenCalledWith(SYNTHETIC_SUBJECT_ID);
      expect(deps.setSessionActiveSubjectId).not.toHaveBeenCalled();
      expect(deps.setProgressionActiveSubject).not.toHaveBeenCalled();
    });

    it('returns activated: false when the load rejects, without writing', async () => {
      const deps = makeDeps(async () => {
        throw new Error('synthetic load failure');
      });

      await expect(activateSubject(SYNTHETIC_SUBJECT_ID, deps)).rejects.toThrow(
        'synthetic load failure',
      );
      expect(deps.setSessionActiveSubjectId).not.toHaveBeenCalled();
      expect(deps.setProgressionActiveSubject).not.toHaveBeenCalled();
    });

    it('points both stores at the loaded dungeon id, not the requested id', async () => {
      const snapshot = makeSyntheticSnapshot(SYNTHETIC_STORED_ID);
      const deps = makeDeps(async () => snapshot);

      const result = await activateSubject(SYNTHETIC_SUBJECT_ID, deps);

      expect(result).toEqual({
        activated: true,
        subjectId: SYNTHETIC_STORED_ID,
        snapshot,
      });
      expect(deps.setSessionActiveSubjectId).toHaveBeenCalledWith(SYNTHETIC_STORED_ID);
      expect(deps.setProgressionActiveSubject).toHaveBeenCalledWith(SYNTHETIC_STORED_ID);
      expect(result.snapshot).toBe(snapshot);
    });

    it('writes the session id before the progression id', async () => {
      const deps = makeDeps();

      await activateSubject(SYNTHETIC_SUBJECT_ID, deps);

      expect(deps.setSessionActiveSubjectId.mock.invocationCallOrder[0]).toBeLessThan(
        deps.setProgressionActiveSubject.mock.invocationCallOrder[0],
      );
    });

    it('is idempotent across repeat calls', async () => {
      const snapshot = makeSyntheticSnapshot(SYNTHETIC_STORED_ID);
      const deps = makeDeps(async () => snapshot);

      const first = await activateSubject(SYNTHETIC_SUBJECT_ID, deps);
      const second = await activateSubject(SYNTHETIC_SUBJECT_ID, deps);
      const third = await activateSubject(SYNTHETIC_SUBJECT_ID, deps);

      expect(first).toEqual(second);
      expect(second).toEqual(third);
      expect(deps.setSessionActiveSubjectId.mock.calls).toEqual([
        [SYNTHETIC_STORED_ID],
        [SYNTHETIC_STORED_ID],
        [SYNTHETIC_STORED_ID],
      ]);
      expect(deps.setProgressionActiveSubject.mock.calls).toEqual([
        [SYNTHETIC_STORED_ID],
        [SYNTHETIC_STORED_ID],
        [SYNTHETIC_STORED_ID],
      ]);
    });
  });

  describe('with the real stores as default dependencies', () => {
    it('synchronizes the session and progression active ids for a stored subject', async () => {
      window.localStorage.setItem(
        STORAGE_KEYS.subject(SYNTHETIC_STORED_ID),
        JSON.stringify(makeSyntheticSnapshot(SYNTHETIC_STORED_ID)),
      );

      const result = await activateSubject(SYNTHETIC_STORED_ID);

      expect(result.activated).toBe(true);
      expect(result.subjectId).toBe(SYNTHETIC_STORED_ID);
      expect(useSessionStore.getState().activeSubjectId).toBe(SYNTHETIC_STORED_ID);
      expect(useProgressionStore.getState().activeSubjectId).toBe(SYNTHETIC_STORED_ID);
      expect(useSubjectStore.getState().snapshot?.dungeon.dungeonId).toBe(
        SYNTHETIC_STORED_ID,
      );
    });

    it('leaves both active ids untouched for an unknown subject', async () => {
      const result = await activateSubject('synthetic-subject-does-not-exist');

      expect(result).toEqual({ activated: false, subjectId: null, snapshot: null });
      expect(useSessionStore.getState().activeSubjectId).toBeNull();
      expect(useProgressionStore.getState().activeSubjectId).toBeNull();
    });

    it('reads the live store actions at call time rather than capturing them', async () => {
      window.localStorage.setItem(
        STORAGE_KEYS.subject(SYNTHETIC_STORED_ID),
        JSON.stringify(makeSyntheticSnapshot(SYNTHETIC_STORED_ID)),
      );

      // The defaults are late-bound wrappers, so they pick up whatever the
      // stores hold now rather than a snapshot taken at import time.
      const loaded = await defaultSubjectActivationDeps.loadSubject(SYNTHETIC_STORED_ID);
      expect(loaded?.dungeon.dungeonId).toBe(SYNTHETIC_STORED_ID);

      defaultSubjectActivationDeps.setSessionActiveSubjectId(SYNTHETIC_STORED_ID);
      defaultSubjectActivationDeps.setProgressionActiveSubject(SYNTHETIC_STORED_ID);
      expect(useSessionStore.getState().activeSubjectId).toBe(SYNTHETIC_STORED_ID);
      expect(useProgressionStore.getState().activeSubjectId).toBe(SYNTHETIC_STORED_ID);
    });
  });

  describe('useLoadSubjectFlow delegation', () => {
    it('returns exactly what activateSubject returns for the same injected deps', async () => {
      window.localStorage.setItem(
        STORAGE_KEYS.subject(SYNTHETIC_STORED_ID),
        JSON.stringify(makeSyntheticSnapshot(SYNTHETIC_STORED_ID)),
      );
      const { activateSubject: realActivate } = await vi.importActual<
        typeof import('@/application/subjectActivation')
      >('@/application/subjectActivation');

      const { result: hook } = renderHook(() => useLoadSubjectFlow());
      let viaHook: boolean | undefined;
      await act(async () => {
        viaHook = await hook.current(SYNTHETIC_STORED_ID);
      });

      const deps = activationSpy.activate.mock.calls.at(-1)?.[1] as SubjectActivationDeps;
      const direct = await realActivate(SYNTHETIC_STORED_ID, deps);

      expect(viaHook).toBe(direct.activated);
      expect(viaHook).toBe(true);
    });

    it('hands activateSubject the subject id and the three store actions', async () => {
      window.localStorage.setItem(
        STORAGE_KEYS.subject(SYNTHETIC_STORED_ID),
        JSON.stringify(makeSyntheticSnapshot(SYNTHETIC_STORED_ID)),
      );
      const { result: hook } = renderHook(() => useLoadSubjectFlow());

      await act(async () => {
        await hook.current(SYNTHETIC_STORED_ID);
      });

      expect(activationSpy.activate).toHaveBeenCalledTimes(1);
      const [subjectId, deps] = activationSpy.activate.mock.calls[0];
      expect(subjectId).toBe(SYNTHETIC_STORED_ID);
      expect(deps.loadSubject).toBe(useSubjectStore.getState().loadSubject);
      expect(deps.setSessionActiveSubjectId).toBe(
        useSessionStore.getState().setActiveSubjectId,
      );
      expect(deps.setProgressionActiveSubject).toBe(
        useProgressionStore.getState().setActiveSubject,
      );
    });

    it('reports failure through the hook without writing either store', async () => {
      const { result: hook } = renderHook(() => useLoadSubjectFlow());
      let viaHook: boolean | undefined;

      await act(async () => {
        viaHook = await hook.current('synthetic-subject-does-not-exist');
      });

      expect(viaHook).toBe(false);
      expect(useSessionStore.getState().activeSubjectId).toBeNull();
      expect(useProgressionStore.getState().activeSubjectId).toBeNull();
    });

    it('keeps the historical (subjectId) => Promise<boolean> signature', () => {
      const { result: hook } = renderHook(() => useLoadSubjectFlow());
      expect(hook.current).toBeTypeOf('function');
      expect(hook.current('synthetic-subject-1')).toBeInstanceOf(Promise);
    });

    it('holds no second copy of the activation writes in the hook source', () => {
      const source = readFileSync(
        join(process.cwd(), 'src/ui/hooks/useLoadSubjectFlow.ts'),
        'utf8',
      );

      expect(source).toMatch(
        /import\s*\{\s*activateSubject\s*\}\s*from\s*'@\/application\/subjectActivation'/,
      );
      // One delegation call site, and no direct store writes of its own.
      expect(source.match(/await activateSubject\(/g)).toHaveLength(1);
      expect(source).not.toMatch(/\.setActiveSubjectId\s*\(/);
      expect(source).not.toMatch(/\.setActiveSubject\s*\(/);
      // The hook only projects the richer result onto the legacy boolean.
      expect(source).toMatch(/return result\.activated;/);
    });
  });
});
