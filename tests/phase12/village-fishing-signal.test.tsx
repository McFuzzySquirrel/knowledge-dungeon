/**
 * The village screen's fishing-entry signal: the only DOM-observable consequence of
 * starting a fishing session.
 *
 * ## Why this file exists
 *
 * Fishing used to have no DOM-observable signal at all. It is a Phaser *scene swap*
 * inside the village's own canvas - `phaserFishingRenderer` sleeps `VillageScene` and
 * starts `FishingScene` in the same `Phaser.Game`, and its own header says so
 * (`src/game/adapters/phaserFishingRenderer.ts:1-13`) - so the only "you are fishing now"
 * surface was a `Text` object drawn inside the canvas, unreachable by a screen reader,
 * by a keyboard user, and by any DOM assertion.
 *
 * That is not a cosmetic gap. Plan 10.1's rule is that a surface which arrives on its own
 * must be announced in words, and a screen-reader user pressing a labelled pond row had
 * no way to learn that anything had happened. `data-world` on the screen root and a
 * `role="status"` live region are the whole of the DOM-side fix, and this file pins both.
 *
 * ## Why it is here and not in a browser test
 *
 * The browser lane proves the two *lanes* differ - `currentBuild.spec.ts` walks to a pond
 * on the default Phaser build and asserts the signal appears, and its Pixi counterpart
 * asserts it does not. Neither of those can pin the *wiring* on its own, and one of them
 * cannot be run on every project at all: reaching a named structure by walking needs the
 * harness's stride to be smaller than the 96 px approach window, which is not true on the
 * slower projects. This file is the deterministic gate: it drives the flow through the
 * same seam the real renderer uses, and it needs no walk, no stride, and no engine.
 *
 * ## The seam, stated plainly
 *
 * `createVillageGame` is the screen's dynamic import of the Phaser adapter. The test
 * replaces it with a handle that captures the `callbacks` bag the screen hands to the
 * renderer and reports a fishing host. Firing `callbacks.onStructureInteract(pondId)` is
 * then *exactly* what the real scene does when a nearby-action row is pressed - it is the
 * same callback, reached through the same screen wiring, with no renderer object required
 * to understand it. That is the property Phase 12's exit criterion asks for, asserted by
 * construction here rather than by review.
 *
 * ## Hermeticity
 *
 * No canvas, no engine, no `dist/`, no network, no commit. The only store writes are the
 * zustand singletons the screen already owns, and each test resets them.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { VILLAGE_MAP } from '@/data/villageLayout';

/**
 * The one pond this file uses.
 *
 * Read from the authored map rather than typed, so the id cannot drift from the layout
 * the flow looks the structure up in - `studyFlow.structureInteract` resolves the id
 * through `findVillageStructure`, and an id that no longer exists would simply stop
 * entering fishing, which is a confusing way for this file to fail.
 */
const POND_ID = (() => {
  const pond = VILLAGE_MAP.structures.find((structure) => structure.type === 'fishing-pond');
  if (pond === undefined) throw new Error('VILLAGE_MAP.structures has no fishing-pond to test against.');
  return pond.id;
})();

/**
 * The slice of the renderer's callback bag this file drives.
 *
 * Declared here rather than imported, because the real type lives in
 * `src/renderers/pixi/village/VillageRenderer.ts` - and a test whose subject is "no
 * renderer object is required" should not import the renderer tree to say so. One member
 * is enough: it is the only callback this file needs, and the screen hands the renderer
 * the same function it hands this object.
 */
interface SceneCallbacks {
  onStructureInteract(structureId: string): void;
}

/** The sentence `VillageScreen` publishes when a fishing session starts. */
const FISHING_ANNOUNCEMENT =
  'You have started fishing. Use the Return to Village control in the world to come back.';

/** What the fake adapter hands back to the screen, and what the test drives it with. */
interface FakeAdapter {
  /** The callbacks bag the screen passes to the renderer at construction. */
  callbacks: SceneCallbacks | null;
  /** How many times the flow asked the adapter to start the fishing world. */
  enterCalls: number;
}

const adapter: FakeAdapter = { callbacks: null, enterCalls: 0 };

/**
 * Whether the handle the fake adapter hands over reports a fishing host.
 *
 * The Phaser lane does; a renderer that mounts a village handle without carrying a
 * fishing world would not. The last test pins what happens then, because the answer is
 * not the obvious one.
 */
let adapterHasFishingHost = true;

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
      ...(adapterHasFishingHost
        ? {
            fishing: () => ({
              enter: () => {
                adapter.enterCalls += 1;
              },
              returnToVillage: () => {},
            }),
          }
        : {}),
    };
  },
}));

vi.mock('@/services/persistence/subjectPersistence', async () => {
  const actual = await vi.importActual('@/services/persistence/subjectPersistence');
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
  // Imported dynamically because the screen resolves its renderer factory at module
  // scope, and `vi.mock` above has to be in place before that module is first
  // evaluated.
  const { VillageScreen } = await import('@/ui/screens/VillageScreen');
  const view = render(<VillageScreen />);
  await waitFor(() => {
    expect(adapter.callbacks, 'the screen never handed its callbacks to the renderer adapter').not.toBeNull();
  });
  return view.container;
}

/** The `data-world` the screen root currently publishes. */
function readWorld(container: HTMLElement): string | null {
  return container.querySelector('.village-screen')?.getAttribute('data-world') ?? null;
}

/** The text of the fishing live region, or `null` when no such region is rendered. */
function readFishingAnnouncement(container: HTMLElement): string | null {
  const regions = [...container.querySelectorAll('p.village-visually-hidden[role="status"]')];
  const match = regions.find((node) => (node.textContent ?? '').trim().length > 0);
  return match === undefined ? null : (match.textContent ?? '').trim();
}

beforeEach(() => {
  adapter.callbacks = null;
  adapter.enterCalls = 0;
  adapterHasFishingHost = true;
  useSessionStore.setState({ activeScreen: 'village' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the village screen publishes a DOM-observable fishing-entry signal', () => {
  it('is absent until a fishing session is actually started', async () => {
    const container = await renderVillageScreen();

    // The baseline has to be read rather than assumed: a signal that is simply always on
    // would make the assertion after the activation below prove nothing.
    expect(readWorld(container), 'the screen published no data-world at all').toBe('village');
    expect(
      readFishingAnnouncement(container),
      'a fishing session is announced before anything was started',
    ).toBeNull();
    expect(adapter.enterCalls, 'the fishing world started on its own').toBe(0);
  });

  it('appears, and announces itself in words, when a pond row is activated', async () => {
    const container = await renderVillageScreen();

    await act(async () => {
      // The same callback the real scene fires for a nearby-action row press.
      (adapter.callbacks as SceneCallbacks).onStructureInteract(POND_ID);
    });

    await waitFor(() => {
      expect(readWorld(container), 'starting a fishing session published no fishing signal').toBe('fishing');
    });
    expect(adapter.enterCalls, 'the flow did not ask the adapter to start fishing').toBe(1);
    expect(
      readFishingAnnouncement(container),
      'the fishing world started but nothing was announced in words, so entering it is still visual-only for a ' +
        'screen-reader user - the in-world Return control is a canvas object and cannot be reached',
    ).toBe(FISHING_ANNOUNCEMENT);
  });

  it('carries no learner data in the announcement', async () => {
    const container = await renderVillageScreen();

    // A subject is what a learner value looks like from inside this screen, so one is
    // imported first: if the announcement interpolated any of it, this is where it shows.
    await act(async () => {
      await useSubjectStore.getState().importSnapshot({
        dungeon: {
          schemaVersion: '1.0.0',
          dungeonId: 'subject-privacy-probe',
          subjectName: 'Zaphod Beeblebrox Study Plan',
          author: 'probe',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          phaseState: 'ScribeActive',
          rootRoomId: 'room-1',
          rooms: [{ roomId: 'room-1', topic: 'Root Topic', status: 'Created' }],
          edges: [],
          progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
        },
        rooms: {
          'room-1': {
            roomId: 'room-1',
            topic: 'Improbability Drive',
            status: 'Created',
            notePath: 'rooms/room-1/notes.md',
            artifactPath: 'rooms/room-1/artifact.md',
            noteText: '',
            artifactMarkdown: null,
            validationState: {
              wordCount: 0,
              requiredSectionsPresent: false,
              manualConfirmed: false,
              criterionScores: {
                documentStructure: 0,
                conceptTermCoverage: 0,
                linkReferences: 0,
                recallQuestionQuality: 0,
                clarityReadability: 0,
              },
              failedChecks: [],
              qualityBonus: 0,
              finalPass: false,
            },
          },
        },
        legacy: { dungeons: {}, collection: {} },
      } as never);
    });

    await act(async () => {
      (adapter.callbacks as SceneCallbacks).onStructureInteract(POND_ID);
    });
    await waitFor(() => {
      expect(readWorld(container)).toBe('fishing');
    });

    const announcement = readFishingAnnouncement(container) ?? '';
    expect(announcement).toBe(FISHING_ANNOUNCEMENT);
    // Belt and braces: the pinned literal above already forbids interpolation, and these
    // name the specific values a future edit would be tempted to add.
    for (const learnerValue of ['Zaphod', 'Beeblebrox', 'Improbability', 'subject-privacy-probe', POND_ID]) {
      expect(announcement, `the fishing announcement leaked "${learnerValue}"`).not.toContain(learnerValue);
    }
    expect(
      screen.queryByText(/Zaphod|Beeblebrox|Improbability/),
      'a learner value reached the screen while a fishing session was being announced',
    ).toBeNull();
  });

  it('the signal and the fishing world move together when a host is mounted', async () => {
    // The Pixi lane's shape at the flow's boundary is: no handle. `phaserVillageFactory`
    // is `null` on a `VITE_PIXI_VILLAGE=true` build, so the screen's mount effect
    // returns before `createVillageGame` is ever called, `rendererRef` stays `null`,
    // and `studyFlow.enterFishing` returns at its mount guard - before it clears any
    // state and before it calls `prepareFishingSession`.
    //
    // That guard is pinned deterministically by
    // `tests/contracts/phase-2-study-flow.test.ts` ("checks the mount guard before
    // clearing any village UI state"), which asserts `prepareFishingSession` is *not*
    // called when `isMounted()` is false. Re-deriving it here would need the build-time
    // switch flipped and the Pixi chunk evaluated in jsdom, which is neither hermetic
    // nor necessary; and the *browser* proof - a real Pixi build, a real pond row, and no
    // signal - is `currentBuild.spec.ts`'s "GAP (Phase 17)" test.
    //
    // So what this file adds is the consequence that matters and that the contract test
    // cannot see: the signal is a *rendered* surface, and a flow that never ran must not
    // have produced one. The cleanest way to see that here is to assert it is still
    // absent after the interaction has been driven, which is what the first test does on
    // an untouched screen and what the known-limitation test below shows is *not* true of
    // a handle that does exist.
    const container = await renderVillageScreen();

    await act(async () => {
      (adapter.callbacks as SceneCallbacks).onStructureInteract(POND_ID);
    });
    await waitFor(() => {
      expect(adapter.enterCalls).toBe(1);
    });
    expect(readWorld(container), 'the signal did not follow the fishing world').toBe('fishing');
  });

  /*
   * ── KNOWN LIMITATION, not correct behaviour ────────────────────────────────
   *
   * `isMounted()` reports whether a renderer *handle* exists; it does not ask whether
   * that handle carries a fishing world. So a handle that mounts a village but has no
   * `fishing()` member passes the guard, `prepareFishingSession` publishes the signal,
   * and then `enter` no-ops - a screen-reader user is told they have started fishing
   * when nothing started.
   *
   * No shipped lane has that shape today: the Phaser adapter always carries `fishing()`,
   * and the Pixi lane mounts no handle at all (the previous test). So this is not a live
   * defect. It is a trap laid directly in Phase 17's path, where a Pixi handle will
   * start carrying nearby-action rows before it carries a fishing world, and the ordering
   * that makes the guard work today will quietly stop making it work.
   *
   * Pinned as-is so the shape is recorded. **Phase 17 should tighten the guard to require
   * a fishing host, not merely a handle**, and this test becomes the one that fails then -
   * `enterCalls` and the signal should be asserted together, because after that change
   * neither may happen without the other.
   */
  it('KNOWN LIMITATION: a handle with no fishing host still publishes the signal, then starts nothing', async () => {
    adapterHasFishingHost = false;
    const container = await renderVillageScreen();

    await act(async () => {
      (adapter.callbacks as SceneCallbacks).onStructureInteract(POND_ID);
    });
    await waitFor(() => {
      expect(readWorld(container)).toBe('fishing');
    });

    // The signal fired...
    expect(readFishingAnnouncement(container)).toBe(FISHING_ANNOUNCEMENT);
    // ...and the world did not.
    expect(
      adapter.enterCalls,
      'a fishing world was entered despite the handle reporting no fishing host',
    ).toBe(0);
  });
});