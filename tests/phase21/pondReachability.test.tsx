/**
 * Phase 21: the recall question is reachable from every route into a pond, on the **shipping** lane.
 *
 * ## The defect this exists for
 *
 * The renderer owner handed over a product defect with a diagnosis:
 *
 * > Pressing the nearby-action row reaches `studyFlow.enterFishing` via `structureInteract` **without**
 * > going through `castFrom`, so `structureIdRef.current` is `null`, `beginFishing` returns early, and
 * > the product tells the learner *"This catch has no open pond session, so the question cannot be
 * > asked."*
 *
 * I confirmed the chain by reading it, and it is right:
 *
 * ```
 *   flow.structureInteract(POND_ID)
 *     → enterFishing(pondId)                  studyFlow.ts:1015
 *     → villageUi.prepareFishingSession()      called BEFORE fishing.enter, and with no arguments
 *     → fishing.prepareSession()               structureIdRef.current is null
 *     → beginFishing(null)                     pondIdRef.current = null → early return
 *     → no context in fishingSessionSlot
 *   …later, on keeping a catch:
 *     → keepFishingCatch(...)                  reads a null slot → NO_OPEN_SESSION
 * ```
 *
 * And the "shipping renderer" half is the load-bearing detail, not a caveat. `pixiFishing`'s
 * **production default is `false`** (`src/config/featureFlags.ts`), so the default build uses the Phaser
 * pond. `phaserFishingRenderer`'s `enter` is a facade over a scene swap and **ignores
 * `handlers.pondId`** — `villageStudyFlow.ts`'s own header says so — so the Pixi lane's
 * `onSessionStarted`, the only other thing on this path that used to record a pond, **does not exist on
 * the artifact a learner downloads**. The recall question is the product's core loop: it was unreachable
 * by keyboard, by touch, and by the `E` key on the default build.
 *
 * ## Why this drives the screen rather than the hook
 *
 * The fix is a parameter threaded from `VillageScreen` — the one scope holding both the identifier and
 * the hook — into `prepareSession`. A hook-only test would pass with the screen still passing `null`,
 * which is exactly the defect, so the assertion here goes through the **real screen** and the **real
 * `studyFlow`**, with only the renderer adapter faked.
 *
 * The fake adapter is the same seam `tests/phase12/village-fishing-signal.test.tsx` uses, and firing
 * `callbacks.onStructureInteract(POND_ID)` is precisely what the real Phaser scene does when a
 * nearby-action row is pressed. The pond id is read from `VILLAGE_MAP` rather than typed, because
 * `studyFlow.structureInteract` resolves it through `findVillageStructure` and an id that no longer
 * exists would simply stop entering fishing — a confusing way for this file to fail.
 *
 * The assertion is on `readFishingSession()` — the real slot in `src/ui/fishing/fishingSession.ts` — not
 * on a mock of it, because a mock would let the test pass while the actual context stayed unminted.
 *
 * ## The subject store, and why the tutorial subject
 *
 * `beginFishingSession` calls `createFishingContext`, which **throws** on an empty subject id or name,
 * and a thrown context becomes `INVALID_SESSION_CONTEXT` — so a session cannot be minted at all without
 * a subject. The fixture is `createTutorialSubject()`: the application's own authored tutorial content,
 * already a fixed string in the repository, so this file adds no learner-shaped value. Every
 * assertion below is a pond id, a boolean, a count, or a fixed copy string.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { VILLAGE_MAP } from '@/data/villageLayout';
import { createTutorialSubject } from '@/data/tutorialSubject';
import { endFishingSession, readFishingSession } from '@/ui/fishing/fishingSession';

/**
 * The one pond this file uses, read from the authored map.
 *
 * See the file header: `studyFlow.structureInteract` resolves the id through `findVillageStructure`, so
 * a typed id that drifts from the layout would fail in a confusing way.
 */
const POND_ID = (() => {
  const pond = VILLAGE_MAP.structures.find((structure) => structure.type === 'fishing-pond');
  if (pond === undefined) throw new Error('VILLAGE_MAP.structures has no fishing-pond to test against.');
  return pond.id;
})();

/**
 * The slice of the renderer's callback bag this file drives.
 *
 * Declared here rather than imported: the real type lives in `src/renderers/pixi/village/**`, and a test
 * whose subject is "no renderer object is required to understand the route" should not import the
 * renderer tree to say so. One member is the whole seam.
 */
interface SceneCallbacks {
  onStructureInteract(structureId: string): void;
}

/** What the fake adapter captured, reset per test. */
const adapter: { callbacks: SceneCallbacks | null; enterCalls: number } = { callbacks: null, enterCalls: 0 };

/**
 * The fake Phaser village adapter.
 *
 * `fishing()` returns a host whose `enter` ignores `handlers.pondId` **exactly as the real Phaser
 * adapter does**. That is the whole point of the fake: it reproduces the shipping lane's behaviour, so
 * the test proves the fix does not depend on a Pixi-lane backstop the default build does not have.
 */
vi.mock('@/game/createVillageGame', () => ({
  createVillageGame: (args: { callbacks: SceneCallbacks }) => {
    adapter.callbacks = args.callbacks;
    return {
      mount: () => {},
      unmount: () => {},
      restart: () => {},
      setDynamicStructures: () => {},
      setPlayerClass: () => {},
      triggerInteract: () => {},
      readPoi: () => null,
      readNpcSnapshot: () => ({ candidates: [], nearby: [], anchor: null }),
      invokeAction: () => {},
      fishing: () => ({
        // `pondId` deliberately dropped: the Phaser facade ignores it. If a test ever started relying
        // on it, this fake would be lying about the lane it stands in for.
        enter: () => {
          adapter.enterCalls += 1;
        },
        returnToVillage: () => {},
      }),
    };
  },
}));

vi.mock('@/services/persistence/subjectPersistence', async () => {
  const actual = await vi.importActual<typeof import('@/services/persistence/subjectPersistence')>(
    '@/services/persistence/subjectPersistence',
  );
  return {
    ...actual,
    getActiveSubjectId: () => null,
    listSubjectIds: () => Promise.resolve([]),
    loadSubjectSnapshot: () => Promise.resolve(null),
    saveSubjectSnapshot: vi.fn(() => Promise.resolve({ success: true })),
    setActiveSubjectId: vi.fn(),
  };
});

/** Renders the screen and waits for the async renderer factory to hand over the seam. */
async function renderVillageScreen(): Promise<HTMLElement> {
  // Imported dynamically because the screen resolves its renderer factory at module scope, and
  // `vi.mock` above has to be in place before that module is first evaluated.
  const { VillageScreen } = await import('@/ui/screens/VillageScreen');
  const view = render(<VillageScreen />);
  await waitFor(() => {
    expect(adapter.callbacks, 'the screen never handed its callbacks to the renderer adapter').not.toBeNull();
  });
  return view.container;
}

/**
 * Enter the pond the way the shipping lane's nearby-action row does.
 *
 * One function, because the defect is precisely that this one route differed from the panel's, and a
 * test that spelled the route out differently at each call site would stop being a statement about it.
 */
async function enterPondFromNearbyRow(): Promise<HTMLElement> {
  const container = await renderVillageScreen();
  await act(async () => {
    adapter.callbacks?.onStructureInteract(POND_ID);
  });
  return container;
}

beforeEach(async () => {
  adapter.callbacks = null;
  adapter.enterCalls = 0;
  useSessionStore.setState({ activeScreen: 'village' });
  await act(async () => {
    await useSubjectStore.getState().importSnapshot(createTutorialSubject());
  });
  endFishingSession();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  endFishingSession();
});

describe('a pond entered from the nearby-action row can keep a catch and ask its question', () => {
  it('the row enters the pond, and the flow asks the adapter to start the world', async () => {
    await enterPondFromNearbyRow();

    // The pre-condition. Without it every assertion below could pass for the wrong reason: a route
    // that did nothing at all would also mint no session.
    expect(
      adapter.enterCalls,
      'the nearby-action row did not enter the pond at all, so the session assertions below would be ' +
        'passing vacuously',
    ).toBe(1);
  });

  it('the pond identifier is recorded, so a session context is minted for the pond entered', async () => {
    await enterPondFromNearbyRow();

    expect(
      readFishingSession()?.pondId,
      'a nearby-action row on a pond entered it with no session, so every catch from it refuses with ' +
        '"no open pond session" and the recall question can never be asked',
    ).toBe(POND_ID);
  });

  it('the screen publishes the fishing world, so the learner is told they are fishing', async () => {
    const container = await enterPondFromNearbyRow();
    expect(container.querySelector('.village-screen')?.getAttribute('data-world')).toBe('fishing');
  });

  it('the fix does not depend on the Pixi lane reporting a pond id back', async () => {
    // The property that closes the loop on the diagnosis. The fake adapter's `enter` drops `pondId`
    // exactly as the Phaser facade does, so this passing means the DOM half now carries the identifier
    // itself rather than leaning on a lane backstop that only exists behind a flag.
    await enterPondFromNearbyRow();
    expect(adapter.enterCalls).toBe(1);
    expect(readFishingSession()?.pondId).toBe(POND_ID);
  });

  it('two ponds entered in a row mint the pond actually entered, not the first one', async () => {
    // The stale-id case: a learner whose `structureIdRef` held a previous pond would file this pond's
    // catches against the other one, which is the same class of defect one level down.
    const ponds = VILLAGE_MAP.structures.filter((structure) => structure.type === 'fishing-pond');
    expect(ponds.length, 'the map has fewer than two ponds, so the stale-id case cannot be exercised').toBeGreaterThan(1);
    const second = ponds[1]?.id ?? '';

    const container = await renderVillageScreen();
    await act(async () => {
      adapter.callbacks?.onStructureInteract(POND_ID);
    });
    endFishingSession();
    await act(async () => {
      adapter.callbacks?.onStructureInteract(second);
    });

    expect(readFishingSession()?.pondId, 'the second pond was entered under the first pond id').toBe(second);
    expect(container.querySelector('.village-screen')?.getAttribute('data-world')).toBe('fishing');
  });

  it('interacting with a structure that is not a pond mints no fishing session', async () => {
    // The negative half. `structureIdRef` is only consulted when the flow has decided to enter a pond,
    // so a library or a fountain must leave the slot empty - a context under a library's id would be a
    // catch filed against a building.
    const other = VILLAGE_MAP.structures.find((structure) => structure.type === 'library');
    if (other === undefined) throw new Error('VILLAGE_MAP.structures has no library to test against.');

    await renderVillageScreen();
    await act(async () => {
      adapter.callbacks?.onStructureInteract(other.id);
    });

    expect(readFishingSession(), 'a non-pond interaction minted a fishing session').toBeNull();
    expect(adapter.enterCalls, 'a non-pond interaction started the fishing world').toBe(0);
  });
});
