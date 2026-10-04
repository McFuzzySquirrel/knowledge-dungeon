/**
 * `data-village-player` on the village screen: the published surface, end to end.
 *
 * ## What this file is for
 *
 * `tests/phase17/village-player-position.test.ts` proves the *format* and the *refusals* of
 * the attribute in isolation. It cannot prove that the screen publishes it, that it
 * publishes it on a long-lived element, or that it comes from whichever renderer is
 * mounted rather than from a constant somewhere in the DOM tree. That is what this file
 * does: it renders `VillageScreen` with a renderer adapter it controls and reads the
 * attribute a consumer reads.
 *
 * The attribute was added because a walker - a keyboard learner, or an end-to-end harness -
 * could not know where it was standing, so each leg aimed at a structure's centre while
 * pressing from wherever the previous leg ended: 30.8 px and 41.6 px off on a 48 px tile,
 * and one instrumented run never once saw the pond row. A test-visible attribute that lies
 * is worse than one that is absent, so the fourth test below is the load-bearing one: an
 * adapter that cannot say publishes **nothing**, and the attribute is gone rather than
 * stale.
 *
 * ## The seam, stated plainly
 *
 * `createVillageGame` is the screen's dynamic import of the Phaser adapter - the lane the
 * failing walk actually runs against, because `build:web:pixi-fishing` switches only the
 * fishing flag and leaves `VITE_WORLD_RENDERER` alone. The test replaces it with a handle
 * that implements the renderer-neutral `readPlayerGridPosition` read. That is the *whole*
 * interaction: no engine, no canvas, no walk, no stride. Which is also why the same wiring
 * is the Pixi lane's - the screen reads it off whichever handle is mounted, so a Pixi build
 * publishes from `VillageWorld`'s handle and this test's assertions hold unchanged. See the
 * last test for what is and is not proven about the Pixi lane.
 *
 * ## Timers
 *
 * Fake timers, driven explicitly with `vi.advanceTimersByTimeAsync` rather than through
 * `waitFor`, because the publish is a throttled interval and this file needs to step that
 * interval rather than wait for it. The publisher samples once in a layout effect, so the
 * *first* publish needs no timer - but on the real screen the renderer handle arrives a tick
 * after commit, and the first test pins the state before it does.
 *
 * ## Hermeticity
 *
 * No engine, no canvas, no `dist/`, no network, no commit. The only store writes are the
 * zustand singletons the screen already owns, and each test resets them.
 */
import { act, cleanup, render } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import { VILLAGE_MAP } from '@/data/villageLayout';

/**
 * The pond this file drives the fishing scene swap through.
 *
 * Read from the authored map rather than typed, so the id cannot drift from the layout the
 * flow resolves it in. Same reasoning as `tests/phase12/village-fishing-signal.test.tsx`,
 * which is the test this file's seam is modelled on.
 */
const POND_ID = (() => {
  const pond = VILLAGE_MAP.structures.find((structure) => structure.type === 'fishing-pond');
  if (pond === undefined) throw new Error('VILLAGE_MAP.structures has no fishing-pond to test against.');
  return pond.id;
})();

/** The one renderer callback this file drives. The screen hands the adapter the same bag. */
interface SceneCallbacks {
  onStructureInteract(structureId: string): void;
}

/** What the fake adapter reports, and what the test drives it with. */
const adapter = {
  /** The callbacks bag the screen passed to the renderer adapter at construction. */
  callbacks: null as SceneCallbacks | null,
  /** The learner's tile, or `null` for "the world cannot answer". */
  tile: { gridX: 9, gridY: 12 } as { gridX: number; gridY: number } | null,
  /** Whether the adapter implements the neutral read at all. */
  implementsRead: true,
  /** How many times the world asked where the learner is. */
  reads: 0,
  /** Resets between tests; `null` means "unmounted". */
  reset(): void {
    adapter.callbacks = null;
    adapter.tile = { gridX: 9, gridY: 12 };
    adapter.implementsRead = true;
    adapter.reads = 0;
  },
};

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
      fishing: () => ({ enter: () => {}, returnToVillage: () => {} }),
      // The renderer-neutral read under test. Deliberately a *method* rather than an arrow
      // closing over the scene, because that is how every other member of the capability
      // port is written and the publisher must not depend on the difference.
      readPlayerGridPosition(this: { tile: unknown }): unknown {
        adapter.reads += 1;
        return adapter.tile;
      },
      ...(adapter.implementsRead ? {} : { readPlayerGridPosition: undefined }),
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

/**
 * Renders the screen and lets the async renderer factory hand over the seam, but does
 * **not** step the publish interval.
 *
 * Deliberately split from {@link mountScreen} so a test can observe the state *before* the
 * first publish - which is the honest state, because the screen's renderer handle arrives a
 * tick after commit and before it arrives the world genuinely has no position to report.
 */
async function mountScreenRaw(): Promise<HTMLElement> {
  // Imported dynamically because the screen resolves its renderer factory at module scope,
  // and `vi.mock` above has to be in place before that module is first evaluated.
  const { VillageScreen } = await import('@/ui/screens/VillageScreen');
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<VillageScreen />));
  });
  // The factory is a dynamic import, so it settles on a microtask rather than on a timer.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(
    adapter.callbacks,
    'the screen never handed its callbacks to the renderer adapter, so nothing below is about the seam',
  ).not.toBeNull();
  return container;
}

/** {@link mountScreenRaw}, plus one publish interval. */
async function mountScreen(): Promise<HTMLElement> {
  const container = await mountScreenRaw();
  await tick();
  return container;
}

/** The village screen root: the element that carries `data-village-player`. */
function screenRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.village-screen');
}

/** The published tile, or `null` when the attribute is absent. */
function readPlayer(container: HTMLElement): string | null {
  return screenRoot(container)?.getAttribute('data-village-player') ?? null;
}

/** Steps the publish interval. */
async function tick(ms = 150): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Advances far enough for the screen's own startup work to finish.
 *
 * The screen loads its subject list a tick or two after mount, and that is a legitimate one-off
 * render. A test that measures render *cost* has to be past it first, or it measures the load
 * instead of the thing under test.
 */
async function settle(): Promise<void> {
  await tick(400);
  await tick(400);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Imports a subject whose every field is a distinctive learner value. */
async function importLearnerSubject(): Promise<void> {
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
}

beforeEach(() => {
  adapter.reset();
  vi.useFakeTimers();
  useSessionStore.setState({ activeScreen: 'village' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('the village screen publishes the learner tile', () => {
  it('on the screen root, in the pinned format, and only once the world can answer', async () => {
    const container = await mountScreenRaw();
    const root = screenRoot(container);
    expect(root, 'the screen root that carries the attribute is missing').not.toBeNull();

    // The state before the first publish is asserted, not assumed. The screen's renderer
    // handle arrives a tick after commit, and before it arrives the world has no position
    // to report - so the honest attribute is **absent**, not the spawn tile and not `0,0`.
    // A consumer that starts walking during this window must find nothing rather than a
    // plausible coordinate it will aim from.
    expect(
      readPlayer(container),
      'a position was published before the renderer was mounted, so there was nothing to read',
    ).toBeNull();

    await tick();
    expect(readPlayer(container)).toBe('9,12');

    // And it is the same element the village's other published facts live on, so a consumer
    // reads every village signal off one long-lived node.
    expect(root?.getAttribute('data-world')).toBe('village');
    expect(root?.hasAttribute('data-theme')).toBe(true);
  });

  it('it follows the learner, and is the tile the renderer reports', async () => {
    const container = await mountScreen();
    expect(readPlayer(container)).toBe('9,12');

    const walk = [
      { gridX: 10, gridY: 12 },
      { gridX: 10, gridY: 11 },
      // The far corner of the authored map. Nothing on the DOM side of the village knows
      // this value - it is not the spawn tile, not a structure the screen rendered, and not
      // derivable from the world model - so publishing it proves the value came *through*
      // the renderer rather than from a constant that happened to look right.
      { gridX: VILLAGE_MAP.width - 1, gridY: VILLAGE_MAP.height - 1 },
    ];
    for (const tile of walk) {
      adapter.tile = tile;
      await tick();
      expect(readPlayer(container), `the attribute did not follow the learner to ${tile.gridX},${tile.gridY}`)
        .toBe(`${tile.gridX},${tile.gridY}`);
    }

    // The value is the renderer's, read on an interval - not a screen-side constant that
    // happens to match. A publisher that computed its own position would still pass the
    // three assertions above.
    expect(adapter.reads, 'the published tile was not read from the renderer').toBeGreaterThan(0);
  });

  it('it lands on one long-lived node, and stays there across a fishing session', async () => {
    const container = await mountScreen();
    const root = screenRoot(container) as HTMLElement;
    expect(root).not.toBeNull();

    adapter.tile = { gridX: 14, gridY: 21 };
    await tick();
    expect(root.getAttribute('data-village-player')).toBe('14,21');
    expect(screenRoot(container), 'the element carrying the attribute was replaced').toBe(root);

    // The fishing world is a canvas scene swap, not a route change: the DOM does not move,
    // so a consumer polling this attribute across a session must not have to re-find it.
    await act(async () => {
      (adapter.callbacks as SceneCallbacks).onStructureInteract(POND_ID);
    });
    await tick();
    expect(screenRoot(container)).toBe(root);
    expect(root.getAttribute('data-world'), 'the fishing swap did not happen').toBe('fishing');
    expect(
      root.getAttribute('data-village-player'),
      'the published tile was lost when the world swapped to fishing',
    ).toBe('14,21');
  });

  it('it publishes nothing at all when the renderer cannot say where the learner is', async () => {
    // The honest-refusal case, and the one that decides whether this attribute is worth
    // trusting. Two flavours, both absent rather than plausible:
    adapter.tile = null;
    const container = await mountScreen();
    expect(
      readPlayer(container),
      'a renderer that cannot answer published a position anyway, so a walker would aim from a tile that never existed',
    ).toBeNull();
  });

  it('it removes the attribute when the world stops answering, rather than leaving it stale', async () => {
    // A restarting renderer has no position to report for a moment. Keeping the old tile
    // would be the failure this attribute was added to end: a walker reading a
    // well-formed but stale tile cannot tell it from a live one.
    const container = await mountScreen();
    expect(readPlayer(container)).toBe('9,12');

    adapter.tile = null;
    await tick();
    expect(readPlayer(container), 'a stale tile survived the world going away').toBeNull();

    // And it comes back, rather than staying absent for the rest of the session.
    adapter.tile = { gridX: 5, gridY: 27 };
    await tick();
    expect(readPlayer(container)).toBe('5,27');
  });

  it('it publishes nothing when the mounted adapter does not implement the read at all', async () => {
    // The lane that has not caught up. `readPlayerGridPosition: undefined` is not a stub
    // that returns a position and not a crash: the screen feature-detects, and the DOM says
    // nothing at all. This is the property that lets the consumer branch on presence rather
    // than on a sentinel value.
    adapter.implementsRead = false;
    const container = await mountScreen();
    await tick();
    expect(readPlayer(container)).toBeNull();
    // The screen still renders and still publishes its other facts.
    expect(screenRoot(container)?.getAttribute('data-world')).toBe('village');
  });

  it('it refuses an off-the-map or malformed tile instead of publishing it', async () => {
    const container = await mountScreen();
    expect(readPlayer(container)).toBe('9,12');

    for (const bad of [
      { gridX: VILLAGE_MAP.width, gridY: 12 },
      { gridX: 9, gridY: -1 },
      { gridX: Number.NaN, gridY: 12 },
      { gridX: 9.5, gridY: 12 },
      { gridX: '9' as unknown as number, gridY: 12 },
      {} as unknown as { gridX: number; gridY: number },
    ]) {
      adapter.tile = bad;
      await tick();
      expect(readPlayer(container), `an unusable tile was published: ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('it carries no learner data, in the value or anywhere on the element', async () => {
    await importLearnerSubject();
    const container = await mountScreen();

    adapter.tile = { gridX: 12, gridY: 8 };
    await tick();
    expect(readPlayer(container)).toBe('12,8');

    // Every attribute the root carries, not just the new one: a subject name smuggled into
    // `data-theme`, an id into a portal hook, anything.
    const root = screenRoot(container) as HTMLElement;
    const attributes = [...root.attributes].map((attribute) => `${attribute.name}=${attribute.value}`);
    for (const learnerValue of ['Zaphod', 'Beeblebrox', 'Improbability', 'subject-privacy-probe']) {
      expect(
        attributes.join(' '),
        `a learner value ("${learnerValue}") reached an attribute on the village screen root`,
      ).not.toContain(learnerValue);
    }
    // And the value's shape is the format, not a payload.
    expect(readPlayer(container)).toMatch(/^\d+,\d+$/);
  });
});

describe('a moving learner costs zero React renders', () => {
  it('publishes a new tile on every sample while walking, and commits nothing', async () => {
    // The one caution this feature carries. A coordinate that updates on every animation
    // frame, wired through `useState`, is a React render of the whole village subtree at
    // the sample rate - a real regression on every device, and the reason the compass
    // before this was rewritten. So the cost is measured, not asserted in a comment.
    //
    // React's own `Profiler` is the instrument, because it counts *commits*, which is what
    // "does not re-render" means. A source-level check for `useState` is in
    // `village-player-position.test.ts` and proves the absence of the obvious mistake; this
    // proves the absence of the render, whatever the mechanism.
    const { VillageScreen } = await import('@/ui/screens/VillageScreen');

    let commits = 0;
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <Profiler id="village" onRender={() => { commits += 1; }}>
          <VillageScreen />
        </Profiler>,
      ));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await tick();

    // Settle before taking the baseline. The screen has one-off startup renders of its own -
    // it finishes its subject load a tick or two after mount - and folding those into the
    // measurement would make this test fail for a reason that has nothing to do with the
    // publish. Settled, the claim below is exactly "the publish costs nothing".
    await settle();
    const commitsAfterMount = commits;

    // An idle village: nothing moves, so nothing commits.
    for (let step = 0; step < 10; step += 1) await tick();
    expect(
      commits,
      'an idle village committed while the position sampler was running, so the sampler is not the only thing publishing',
    ).toBe(commitsAfterMount);

    // Walk thirty tiles, one per publish interval.
    let published = 0;
    for (let step = 0; step < 30; step += 1) {
      adapter.tile = { gridX: 5 + (step % 10), gridY: 20 - (step % 8) };
      await tick();
      if (readPlayer(container) !== null) published += 1;
    }

    expect(published, 'the attribute stopped being published while the learner walked').toBe(30);
    expect(
      commits,
      `walking 30 tiles caused ${commits - commitsAfterMount} React commit(s); a per-sample render in the ` +
        'village is a regression, and the publish is supposed to be a ref plus one attribute write',
    ).toBe(commitsAfterMount);

    // And the value really did move, so "no renders" is not "no work".
    expect(readPlayer(container)).toMatch(/^\d+,\d+$/);
  });
});

describe('what this file proves about each lane, precisely', () => {
  it('the screen reads the neutral port, so both lanes publish from their own renderer', async () => {
    // Recorded as a source-level claim because it is the part a future edit could quietly
    // break: a screen that stopped feature-detecting and started importing a renderer, or
    // that computed a position itself, would still pass every behavioural test above on the
    // Phaser lane. `tests/phase12/village-shell-split.test.ts` holds the same rule for every
    // module under `src/ui/village/**`; this is the screen-side half, named here.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      `${process.cwd()}/src/ui/screens/VillageScreen.tsx`,
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The read goes through the neutral reader, and the screen names no renderer member.
    expect(source).toContain('readVillagePlayerGridPosition(activeCapabilities())');
    expect(source).not.toMatch(/data-village-player/);
    // The published name comes from the module, not from a second spelling here.
    expect(source).not.toMatch(/['"]data-[a-z-]+['"]\s*=/);
    // And the screen did not grow a runtime renderer import to get the value.
    const specifiers = [
      ...[...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((match) => match[1] as string),
    ];
    expect(specifiers.filter((specifier) => /^@\/renderers/.test(specifier))).toEqual([
      // The one type-only import the file is already allowed, which the Phase 12 gate
      // pins: erased at build time, and about `VillageWorldHandle` rather than a position.
      '@/renderers/pixi/village/VillageWorld',
    ]);
  });
});