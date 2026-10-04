/**
 * Phase 17's exit criterion, measured: "Returning to Village destroys fishing GPU
 * resources cleanly."
 *
 * ## The two altitudes, and why there are two
 *
 * "Cleanly" is a claim about four different things, and only some of them are observable
 * from outside a PixiJS `Application`. Rather than assert what cannot be read, this file
 * measures each thing at the altitude where it *can* be:
 *
 * | Claim                                            | Measured by                    | How                                             |
 * |--------------------------------------------------|--------------------------------|-------------------------------------------------|
 * | the canvas does not outlive the pond             | `createPixiFishingRenderer`    | `document.querySelectorAll('canvas')`            |
 * | no DOM listener outlives the pond                | `createPixiFishingRenderer`    | a spy counting `window` add/remove pairs         |
 * | the ticker stops and the stage empties           | `createPixiWorldHost` directly | `WorldApplication.tickerRunning`, `stage.children` |
 * | every environment subscription is released       | `createPixiWorldHost` directly | the instrumented `WorldEnvironment` seam         |
 *
 * The second pair goes through `createPixiWorldHost` rather than the fishing renderer because
 * the host is what accepts an injected `WorldEnvironment` and a `WorldApplicationFactory`;
 * `createPixiFishingRenderer` calls `currentWorldEnvironment()` internally, so an instrumented
 * seam cannot be threaded through it. The composition is the shipping one - the same
 * `createApplication`, the same `createScene` with the real `createFishingScene`, the same
 * quality profile - so what is measured is the pond's teardown and not a double's.
 *
 * ## What this file deliberately does NOT claim
 *
 * **No GPU-memory number.** No API in jsdom reports bytes of texture memory or a count of
 * live WebGL contexts. What *is* measured is the release-side fact a context count would have
 * detected indirectly: the stage is empty, the ticker is not running, and the canvas is gone.
 * `tests/e2e/pixi-memory-lane.ts` records the same boundary for the browser lane, including
 * the PixiJS 8.21 `CanvasObserver` defect it cannot detect without `Ticker.shared`.
 *
 * **No texture claim.** Every visual in the pond is procedural `Graphics`, so it owns no
 * textures and a "no texture leak" result here would be vacuous. Asserted rather than
 * claimed: the pond never calls a texture-creating API, and a phase that adds one has to say
 * so here.
 *
 * **No frame-time or frame-rate claim.** Phase 22 owns those; Phases 13 through 16 all
 * recorded them UNVERIFIED for the same reason.
 *
 * **Four cycles, not twenty.** Enough to make a per-mount leak visible (it compounds), cheap
 * enough to run on every change. Plan 10.2's "no material growth over 20 mount and unmount
 * cycles" is measured in a browser by `tests/e2e/pixi-memory-lane.ts`, which switches on
 * `VITE_WORLD_RENDERER` and does **not** reach a fishing world. Recorded as a gap.
 *
 * ## Non-vacuity
 *
 * Each cycle asserts its *mid-mount* positive before its zero: a live ticker, a non-empty
 * stage, and at least one registered subscription. "Zero after teardown" is also what a pond
 * that never mounted produces, and this file refuses to be that.
 *
 * Hermeticity: synthetic ids, a fixed session date, a fixed cosmetic stream, no network, no
 * `dist/`, and no real clock - the pond integrates its own clock from frame deltas.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { readSpecifiers, stripComments } from '../privacy/support/appGraph';
import { REPO_ROOT } from '../phase9/support/phase9Build';
import { asPixiApplication, createPixiApplication } from '@/renderers/pixi/runtime/createPixiApplication';
import { createPixiWorldHost } from '@/renderers/pixi/runtime/createPixiWorldHost';
import { resolveCozyWorldTheme } from '@/renderers/pixi/runtime/cozyWorldTheme';
import {
  resolveWorldQualityProfile,
  type WorldApplication,
  type WorldEnvironment,
} from '@/renderers/pixi/runtime/types';
import { currentWorldEnvironment } from '@/renderers/pixi/runtime/worldEnvironment';
import { createPixiFishingRenderer } from '@/renderers/pixi/fishing/FishingController';
import { createFishingScene, type FishingScene } from '@/renderers/pixi/fishing/createFishingScene';
import type { FishingScenePort } from '@/renderers/pixi/fishing/FishingController';
import type { FishingWorldModel } from '@/application/contracts/world';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from '../phase9/support/canvasContextStub';

const WORLD: FishingWorldModel = {
  kind: 'fishing',
  playerClass: 'scholar',
  hasClearedRooms: true,
  // An app-minted subject id. No topic, no note, and no learner content anywhere in this file.
  subjectId: 'synthetic-subject',
};

/** How many mount/unmount cycles the residue test runs. */
const CYCLES = 4;

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

let stub: StubbedContext;
let observer: StubbedResizeObserver;

beforeAll(() => {
  stub = installCanvasContextStub();
  observer = installResizeObserverStub();
});

afterAll(() => {
  observer.restore();
  stub.restore();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

/* ── A window listener ledger ──────────────────────────────────────────────── */

/**
 * Counts `addEventListener` and `removeEventListener` calls on the window.
 *
 * ## Why the spy is scoped to one cycle and restored inside it
 *
 * The obvious version of this ledger - one spy for the whole file - measures nothing usable,
 * and that was measured rather than guessed. A `vi.spyOn` on `window.addEventListener`
 * replaces the method for *every* caller, and PixiJS's `Ticker` and `EventSystem` register
 * window listeners through it: three cycles under a file-wide spy reported `net=1819` after
 * the first cycle, while the same three cycles under a per-cycle spy reported zero residue
 * and three clean readiness flips. So the ledger is installed, used and restored **inside**
 * one cycle, and what it reports is the pond's net effect on window listeners for that mount.
 * `vi.restoreAllMocks()` in `afterEach` is the backstop; the per-cycle restore is what keeps
 * one mount's spy out of the next mount's path.
 *
 * Net-zero is the claim that matters and is what "no listener outlived the pond" means.
 * Counting rather than comparing function identity, because the host registers fresh closures
 * per mount and an identity comparison would assert the implementation, not the outcome.
 */
function watchWindowListeners(win: Window): { net: () => number; restore: () => void } {
  const live = new Map<string, number>();
  const add = win.addEventListener.bind(win);
  const remove = win.removeEventListener.bind(win);

  const addSpy = vi
    .spyOn(win, 'addEventListener')
    .mockImplementation((type, listener, options) => {
      const handler = typeof listener === 'function' ? listener : listener?.handleEvent;
      if (handler) {
        const key = handlerKey(type, handler);
        live.set(key, (live.get(key) ?? 0) + 1);
      }
      return add(type, listener, options);
    });
  const removeSpy = vi
    .spyOn(win, 'removeEventListener')
    .mockImplementation((type, listener, options) => {
      // `handleEvent`, not a misspelling of it: an object listener's remove is passed the
      // same object its add was passed, and reading a member that does not exist would make
      // every object listener look unmatched and inflate the net figure.
      const handler = typeof listener === 'function' ? listener : listener?.handleEvent;
      if (handler) {
        const key = handlerKey(type, handler);
        const next = (live.get(key) ?? 0) - 1;
        if (next <= 0) live.delete(key);
        else live.set(key, next);
      }
      return remove(type, listener, options);
    });

  return {
    net: () => [...live.values()].reduce((sum, count) => sum + count, 0),
    restore: () => {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    },
  };
}

/** A key by event type and the handler's own name, which is stable across a mount. */
function handlerKey(type: string, handler: EventListenerOrEventListenerObject): string {
  const fn = typeof handler === 'function' ? handler : (handler.handleEvent ?? (() => {}));
  return `${type}:${(fn as unknown as { name?: string }).name ?? 'anonymous'}`;
}

/* ── The instrumented environment ──────────────────────────────────────────── */

interface EnvironmentInstrument {
  readonly environment: WorldEnvironment;
  /** Subscriptions currently held, summed over the three channels. */
  live(): number;
  /** Subscriptions registered since construction, summed over the three channels. */
  registered(): number;
}

/**
 * Wraps the real environment and counts what is registered and what is released.
 *
 * `WorldEnvironment` is the host's *only* route to a DOM subscription for reduced motion,
 * visibility, and element size, so instrumenting it enumerates the complete set a mounted
 * pond creates through that seam. The keydown listener the host adds directly is counted
 * separately by the window ledger above.
 */
function instrumentEnvironment(base: WorldEnvironment): EnvironmentInstrument {
  let registered = 0;
  const held = new Set<() => void>();

  const wrap = (stop: () => void): (() => void) => {
    const wrapped = (): void => {
      held.delete(wrapped);
      stop();
    };
    held.add(wrapped);
    return wrapped;
  };

  return {
    environment: {
      reducedMotion: () => base.reducedMotion(),
      hidden: () => base.hidden(),
      observeReducedMotion: (listener) => {
        registered += 1;
        return wrap(base.observeReducedMotion(listener));
      },
      observeVisibility: (listener) => {
        registered += 1;
        return wrap(base.observeVisibility(listener));
      },
      observeSize: (element, listener) => {
        registered += 1;
        return wrap(base.observeSize(element, listener));
      },
    },
    live: () => held.size,
    registered: () => registered,
  };
}

/* ── Cycle 1: the fishing renderer, end to end ─────────────────────────────── */

interface RendererCycle {
  readonly canvasesWhileMounted: number;
  readonly readyWhileMounted: boolean;
  readonly netWindowListenersWhileMounted: number;
  readonly canvasesAfterTeardown: number;
  readonly netWindowListenersAfterTeardown: number;
  /** Whether a keypress after teardown threw. `null` when it did not. */
  readonly postTeardownThrew: string | null;
}

async function runRendererCycle(): Promise<RendererCycle> {
  const host = document.createElement('div');
  host.style.width = `${VIEWPORT_WIDTH}px`;
  host.style.height = `${VIEWPORT_HEIGHT}px`;
  document.body.append(host);

  const win = window as unknown as Window;
  const ledger = watchWindowListeners(win);

  const renderer = createPixiFishingRenderer({
    host,
    world: WORLD,
    onReturnToVillage: () => {},
    playAudioHook: () => {},
    scene: { sessionDate: '2026-01-01', cosmeticRng: () => 0.5, nowMs: 0 },
  });
  renderer.mount();

  // `mount()` is fire-and-forget by contract and `isReady()` is the documented poll.
  await waitForReady(() => renderer.isReady(), 'the fishing renderer');

  const canvasesWhileMounted = document.querySelectorAll('canvas').length;
  const netWindowListenersWhileMounted = ledger.net();
  const readyWhileMounted = renderer.isReady();

  renderer.destroy();

  // Measured with the host element still in the document, so "no canvas left" cannot be
  // satisfied by removing the thing the canvas hangs off.
  const canvasesAfterTeardown = document.querySelectorAll('canvas').length;
  const netWindowListenersAfterTeardown = ledger.net();
  ledger.restore();

  // And the pond's own listeners are gone, which is the *behavioural* form of the ledger's
  // figure: a keypress after teardown changes nothing and throws nothing. A leaked listener
  // would still be bound to a destroyed scene, and `present()` would touch a released
  // Graphics - so this catches a leak the count would miss if the count were wrong.
  let postTeardownThrew: string | null = null;
  try {
    for (const key of [' ', 'a', 'ArrowLeft']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key }));
    }
  } catch (error) {
    postTeardownThrew = error instanceof Error ? error.message : String(error);
  }

  host.remove();
  return {
    canvasesWhileMounted,
    readyWhileMounted,
    netWindowListenersWhileMounted,
    canvasesAfterTeardown,
    netWindowListenersAfterTeardown,
    postTeardownThrew,
  };
}

describe('the pond mounts a live renderer, so "clean teardown" is not "never mounted"', () => {
  it('presents a first frame behind exactly one canvas, and holds window listeners', async () => {
    const cycle = await runRendererCycle();

    // The positive control. Every zero in the next test would also hold for a pond that never
    // mounted, so the mount itself is asserted first.
    expect(cycle.readyWhileMounted).toBe(true);
    expect(cycle.canvasesWhileMounted).toBe(1);
    // The host's `keydown` listener, plus whatever the environment registered on the window.
    expect(cycle.netWindowListenersWhileMounted).toBeGreaterThan(0);
  }, 60_000);
});

describe('repeated mount and unmount leaves nothing behind', () => {
  it(`runs ${CYCLES} renderer cycles with no canvas and no listener residue`, async () => {
    const cycles: RendererCycle[] = [];
    for (let index = 0; index < CYCLES; index += 1) {
      cycles.push(await runRendererCycle());
    }

    for (const cycle of cycles) {
      expect(cycle.readyWhileMounted).toBe(true);
      expect(cycle.canvasesWhileMounted).toBe(1);
      expect(cycle.netWindowListenersWhileMounted).toBeGreaterThan(0);
      // The release-side facts.
      expect(cycle.canvasesAfterTeardown).toBe(0);
      expect(cycle.netWindowListenersAfterTeardown).toBe(0);
      expect(cycle.postTeardownThrew, 'a keypress after teardown must reach nothing').toBeNull();
    }

    // Flat across cycles, which is the shape a per-mount leak cannot take.
    expect(new Set(cycles.map((cycle) => cycle.canvasesAfterTeardown))).toEqual(new Set([0]));
    expect(new Set(cycles.map((cycle) => cycle.netWindowListenersAfterTeardown))).toEqual(
      new Set([0]),
    );
  }, 240_000);
});

/* ── Cycle 2: the host seam, where the ticker and the stage are readable ───── */

interface HostCycle {
  /** Top-level children on the real PixiJS stage while mounted. */
  readonly stageChildrenWhileMounted: number;
  /** Labelled descendants of the pond's root while mounted. */
  readonly displayObjectsWhileMounted: number;
  readonly tickerRunningWhileMounted: boolean;
  readonly subscriptionsRegistered: number;
  readonly stageChildrenAfterTeardown: number;
  readonly tickerRunningAfterTeardown: boolean;
  readonly liveSubscriptionsAfterTeardown: number;
  readonly applicationTickerAfterTeardown: unknown;
}

/**
 * Wait until the world has presented a frame, or fail.
 *
 * `mount()` resolving is not the same as the world being up: the Phase 9 host flips readiness
 * inside the frame callback, so a host whose ticker has not run once yet is legitimately not
 * ready. Polling `isReady()` is the documented poll, and the floor is generous because
 * jsdom's WebGL negotiation is the slow part.
 */
async function waitForReady(isReady: () => boolean, what = 'the pond'): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!isReady() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!isReady()) throw new Error(`${what} never presented a first frame under jsdom`);
}

async function runHostCycle(): Promise<HostCycle> {
  const host = document.createElement('div');
  host.style.width = `${VIEWPORT_WIDTH}px`;
  host.style.height = `${VIEWPORT_HEIGHT}px`;
  document.body.append(host);

  const quality = resolveWorldQualityProfile('balanced');
  const theme = resolveCozyWorldTheme({ theme: null, reducedMotion: false });
  const instrument = instrumentEnvironment(currentWorldEnvironment());

  // A holder, because both are assigned inside `createScene` and a bare `let` narrows to
  // `never` at the read site - a narrowing artefact, not a real absence.
  const created: { scene: FishingScene | null; application: WorldApplication | null } = {
    scene: null,
    application: null,
  };

  // The third type argument is the scene's capability port, so `worldHost.capabilities` is
  // `FishingScenePort | undefined` rather than `{}` - which is what lets the cast below be
  // typed rather than cast.
  const worldHost = createPixiWorldHost<WorldApplication, FishingScene, FishingScenePort>({
    host,
    createApplication: createPixiApplication,
    createScene: (application, init) => {
      created.application = application;
      const built = createFishingScene(asPixiApplication(application), init, {
        world: { playerClass: WORLD.playerClass, hasClearedRooms: WORLD.hasClearedRooms },
        callbacks: { onAudioHook: () => {}, onReturnToVillage: () => {} },
        sessionDate: '2026-01-01',
        cosmeticRng: () => 0.5,
        nowMs: 0,
      });
      created.scene = built;
      return built;
    },
    theme,
    quality,
    reducedMotion: false,
    environment: instrument.environment,
  });

  await worldHost.mount();

  // Readiness flips on the first *presented* frame, not at construction - that is the Phase 9
  // rule, and it means `mount()` resolving is not the same thing as the world being up. So
  // the frame is awaited here, the way the Phase 16 parity file polls `isReady()`.
  await waitForReady(() => worldHost.isReady());

  // A cast, far enough to create a landing splash and a cast trajectory: the objects most
  // likely to survive a naive teardown because they are made *after* the mount.
  const port = worldHost.capabilities;
  if (port === undefined) throw new Error('the host exposed no capability port');
  port.beginPower();
  for (let frame = 0; frame < 20; frame += 1) {
    port.release();
    port.beginPower();
  }
  port.release();

  // Read through a typed holder rather than the closure variable: `application` is assigned
  // inside `createScene`, and TypeScript narrows a `let` that a closure writes to `never` at
  // this point, so the reads below would not typecheck even though the values are there.
  const liveApplication = created.application;
  if (liveApplication === null) throw new Error('no application was created');
  if (created.scene === null) throw new Error('no scene was created');

  // The stage is captured *before* teardown and read after it, because
  // `Application.destroy` nulls the renderer - so `stage` is not readable afterwards. Reading
  // the live stage instead would measure nothing, and reading a captured reference measures
  // exactly "what is left on the graph the pond built on", which is the claim.
  const stage = asPixiApplication(liveApplication).stage;
  const stageChildrenWhileMounted = stage.children.length;
  const displayObjectsWhileMounted = countLabelled(stage);
  const tickerRunningWhileMounted = liveApplication.tickerRunning;
  const subscriptionsRegistered = instrument.registered();

  worldHost.unmount();

  const stageChildrenAfterTeardown = stage.children.length;
  const tickerRunningAfterTeardown = liveApplication.tickerRunning;
  const liveSubscriptionsAfterTeardown = instrument.live();
  // `TickerPlugin.destroy`, which `Application.destroy` runs, replaces `app.ticker` with
  // `null`. That is the engine's own statement that the private ticker is gone, and it is
  // the fact a "live context count" would have detected indirectly.
  const applicationTickerAfterTeardown = (
    liveApplication as unknown as { native: { ticker: unknown } }
  ).native.ticker;

  host.remove();

  return {
    stageChildrenWhileMounted,
    displayObjectsWhileMounted,
    tickerRunningWhileMounted,
    subscriptionsRegistered,
    stageChildrenAfterTeardown,
    tickerRunningAfterTeardown,
    liveSubscriptionsAfterTeardown,
    applicationTickerAfterTeardown,
  };
}

/** Every labelled display object on the stage, counted. */
function countLabelled(stage: { children: readonly unknown[] }): number {
  let total = 0;
  const visit = (node: { label?: string; children?: readonly unknown[] }): void => {
    if (typeof node.label === 'string' && node.label.length > 0) total += 1;
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  for (const child of stage.children) visit(child as typeof stage);
  return total;
}

describe('the host seam releases the ticker, the stage, and every subscription', () => {
  it('a mounted pond has a live ticker and a populated stage, and a torn-down one has neither', async () => {
    const cycle = await runHostCycle();

    // Mid-mount positives.
    expect(cycle.tickerRunningWhileMounted).toBe(true);
    expect(cycle.stageChildrenWhileMounted).toBe(1);
    // More than one, so "the stage is non-empty" is not a single-child artefact.
    expect(cycle.displayObjectsWhileMounted).toBeGreaterThan(5);
    // Three channels registered by the host: reduced motion, visibility, element size.
    expect(cycle.subscriptionsRegistered).toBe(3);

    // Release-side facts.
    expect(cycle.stageChildrenAfterTeardown).toBe(0);
    expect(cycle.tickerRunningAfterTeardown).toBe(false);
    expect(cycle.liveSubscriptionsAfterTeardown).toBe(0);
    expect(cycle.applicationTickerAfterTeardown).toBeNull();
  }, 60_000);

  it(`runs ${CYCLES} host cycles with a flat, empty residue`, async () => {
    const cycles: HostCycle[] = [];
    for (let index = 0; index < CYCLES; index += 1) {
      cycles.push(await runHostCycle());
    }

    for (const cycle of cycles) {
      expect(cycle.tickerRunningWhileMounted).toBe(true);
      expect(cycle.stageChildrenWhileMounted).toBe(1);
      expect(cycle.subscriptionsRegistered).toBe(3);
      expect(cycle.stageChildrenAfterTeardown).toBe(0);
      expect(cycle.tickerRunningAfterTeardown).toBe(false);
      expect(cycle.liveSubscriptionsAfterTeardown).toBe(0);
      expect(cycle.applicationTickerAfterTeardown).toBeNull();
    }

    // No growth in the mounted footprint either: a pond that created more objects on the
    // second mount than the first would pass every zero above and still be leaking.
    expect(new Set(cycles.map((cycle) => cycle.displayObjectsWhileMounted)).size).toBe(1);
  }, 240_000);
});

/* ── The handle's total behaviour ──────────────────────────────────────────── */

describe('the handle is total before mount and after teardown', () => {
  it('every read answers and every verb is a no-op, so a panel never polls undefined', () => {
    const host = document.createElement('div');
    const renderer = createPixiFishingRenderer({
      host,
      world: WORLD,
      onReturnToVillage: () => {},
      playAudioHook: () => {},
    });

    // This is the defect `VillageWorld`'s header records in a different shape - a handle that
    // silently omitted a member - caught from the other side: a handle whose members all
    // exist but must not lie before they can work.
    expect(renderer.isReady()).toBe(false);
    expect(renderer.readReadout()).toEqual({
      phase: 'idle',
      power: 0,
      canReset: false,
      eligible: false,
      moveIntent: 0,
      facing: 'right',
      castNumber: 0,
      caughtCount: 0,
    });
    expect(renderer.readPresentation().bucketCount).toBe(0);
    expect(renderer.getCaughtCount()).toBe(0);

    expect(() => {
      renderer.beginPower();
      renderer.release();
      renderer.hook();
      renderer.reset();
      renderer.move(-1);
      renderer.resize(320, 200);
      renderer.returnToVillage();
    }).not.toThrow();
    expect(document.querySelectorAll('canvas').length).toBe(0);
  });

  it('destroy is idempotent, so a StrictMode double teardown is not a second teardown', async () => {
    const host = document.createElement('div');
    host.style.width = `${VIEWPORT_WIDTH}px`;
    host.style.height = `${VIEWPORT_HEIGHT}px`;
    document.body.append(host);

    const renderer = createPixiFishingRenderer({
      host,
      world: WORLD,
      onReturnToVillage: () => {},
      playAudioHook: () => {},
      scene: { sessionDate: '2026-01-01', cosmeticRng: () => 0.5, nowMs: 0 },
    });
    renderer.mount();
    await waitForReady(() => renderer.isReady(), 'the fishing renderer');

    // React runs mount effects twice under StrictMode in development, and a screen may unmount
    // while `app.init()` is still negotiating a GPU context. Both produce a second teardown, so
    // it must be a no-op rather than a throw.
    expect(() => {
      renderer.destroy();
      renderer.destroy();
      renderer.unmount();
    }).not.toThrow();

    // The reads stay total after teardown, so a panel that polls once more during teardown
    // gets a value rather than a throw.
    expect(renderer.readReadout().phase).toBe('idle');
    expect(renderer.getCaughtCount()).toBe(0);

    host.remove();
    expect(document.querySelectorAll('canvas').length).toBe(0);
  }, 60_000);
});

/* ── What the pond does not own ────────────────────────────────────────────── */

describe('the pond owns no textures and no learner data', () => {
  it('the scene draws with Container and Graphics only, so a texture claim would be vacuous', () => {
    // Stated from the import line rather than measured at run time, because a runtime zero
    // would be indistinguishable from a scene that had not drawn yet. The line is the
    // artefact the claim is about: `createFishingScene` imports exactly two display classes
    // from the engine, and neither creates a texture.
    const importLine = readSceneImportLine();

    expect(importLine).toContain('Container');
    expect(importLine).toContain('Graphics');
    // No texture class, no sprite, no asset loader, no image loading.
    for (const forbidden of ['Texture', 'Sprite', 'Assets', 'AssetsLoader', 'loadTexture']) {
      expect(importLine, `${forbidden} must not be drawn with in this scene`).not.toContain(
        forbidden,
      );
    }
  });

  it('the scene names no fish: the catalogue is reached by type only, never by value', () => {
    // The catalog's *ids* are app-minted and may cross the renderer boundary; a display name
    // is catalog content and must never be keyed on. This asserts the scene reaches
    // `fishingTypes.ts` for the `FishRarity` *type* and for nothing else, so it has no value
    // path to a species name at all - and it reads the source rather than the output,
    // because a renderer can name a species in a comment and still be correct, while a value
    // import of the catalogue is a code path to every name in it.
    const code = stripComments(readSceneSource());
    const specifiers = readSpecifiers(code);

    // The import exists...
    expect(specifiers, 'the rarity type is needed to map a rarity to a colour').toContain(
      '@/core/fishing/fishingTypes',
    );
    // ...and it is type-only, which is what makes it a vocabulary and not a catalogue.
    const importStatement = code
      .split('\n')
      .filter((line) => line.includes("'@/core/fishing/fishingTypes'"))
      .join(' ');
    expect(importStatement).toContain('import type');
    expect(importStatement).toContain('FishRarity');
    expect(importStatement).not.toContain('FISH_CATALOG');

    // And the catalogue identifier itself appears nowhere in the scene's code, so there is no
    // second route to it. The machine's re-export of `FISH_CATALOG` is deliberately unused.
    expect(code).not.toContain('FISH_CATALOG');
    // The machine supplies the candidate entry; the scene reads its `rarity` and nothing else,
    // so no `.name` property of a catalogue entry is reachable from here.
    expect(code).toContain('state.candidate.rarity');
    expect(/\.candidate\.name/.test(code)).toBe(false);
  });
});

function readSceneSource(): string {
  return readFileSync(
    join(REPO_ROOT, 'src/renderers/pixi/fishing/createFishingScene.ts'),
    'utf8',
  );
}

/**
 * The scene's `pixi.js` import line, which is the artefact this claim is about.
 *
 * Source rather than a runtime count, and the reason is in the test's name: a runtime zero
 * would be indistinguishable from a scene that had not drawn yet.
 */
function readSceneImportLine(): string {
  const source = readFileSync(join(REPO_ROOT, 'src/renderers/pixi/fishing/createFishingScene.ts'), 'utf8');
  return source
    .split('\n')
    .filter((line) => line.startsWith('import') && line.includes("from 'pixi.js'"))
    .join('\n');
}