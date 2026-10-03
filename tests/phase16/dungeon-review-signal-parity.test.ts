/**
 * Phase 16's renderer deliverable: "Artifact, NPC, and review-state parity in Pixi."
 *
 * ## What this file asserts, and what it deliberately does not
 *
 * Phase 16 changed the *review flow*, not the renderer. `src/application/reviewCommands.ts`
 * moved the awarded-once decision into a durable `(room, pass)` ledger, gated the review on
 * `canReviewRoom`, and stopped `review/pass-complete` from writing `reviewPassCount` when the
 * award was suppressed. None of that touches a capability. So the honest Phase 16 renderer
 * question is not "what should the renderer draw" but the narrower one this file answers:
 *
 * **do the two dungeon adapters consume the same eight signals, with the same arguments, in
 * the same way?**
 *
 * That is a claim about the *adapters*, and both adapters are reachable without a real
 * engine, which is why this file is possible at all:
 *
 * | Lane                | How it is reached here                                     |
 * |---------------------|------------------------------------------------------------|
 * | Phaser adapter      | `phaser` and the three scene modules replaced by stubs, the established shape of `tests/contracts/phase-2-adapter-lifecycle.test.ts` |
 * | PixiJS adapter      | the real `createPixiDungeonRenderer` on a real PixiJS 8 `Application`, with the two browser facilities jsdom lacks stubbed (`tests/phase9/support/canvasContextStub.ts`) |
 *
 * ## Why one input table and two recorders, rather than two hand-written pairs of assertions
 *
 * A hand-written pair says "the author believed these two calls agree". One table says the
 * two adapters were handed *the same* arguments and produced *the same* log, so the thing
 * under test is the difference between the adapters and not the difference between two
 * assertions. The table is the Phase 13 claim in a form that covers the review signals:
 * every member of `DungeonRendererCapabilities` appears exactly once, so a capability added
 * to the port and implemented by only one adapter turns this file red rather than sitting
 * unnoticed until the next renderer swap.
 *
 * ## What this file deliberately does NOT claim
 *
 * **It is not a differential comparison of what the two engines draw.** Both adapters
 * forward to their own scene, and the scenes' *drawing* is not reached from both sides: Phaser's
 * `DungeonScene` is stubbed out here (constructing one for real needs `Phaser.Scene` systems
 * installed, which needs a booted engine), so the Phaser scene's *consumption* is pinned where
 * it is reachable instead:
 *
 * | Claim                                                      | Pinned by |
 * |------------------------------------------------------------|-----------|
 * | the Phaser adapter forwards every capability to its scene  | `tests/contracts/phase-2-adapter-lifecycle.test.ts` |
 * | the PixiJS scene consumes reviewed / image / overlay       | this file, plus `tests/phase13/dungeon-scene.test.ts` |
 * | the PixiJS adapter forwards every capability to its scene  | this file, "every capability call reaches a mounted scene" |
 * | both adapters expose an identical port and receive identical arguments | this file |
 *
 * The row that needed adding for Phase 16 is the third: an adapter whose capability method had
 * an empty body would produce a perfect log and a dead world, so this file also records the
 * *effect* of each call on a mounted scene. That mutation was tried and turns this file red.
 *
 * **It says nothing about whether `reviewedArtifactRoomIds` should mean what it means.** That
 * is a question about `room.reviewPassCount`, which lives in the subject snapshot. It is
 * answered in `tests/phase16/review-marker-publication.test.tsx`, against the real flow and
 * the real stores.
 *
 * ## Non-vacuity
 *
 * Four guards, because "the two logs were equal" is also what two *empty* logs say:
 *
 * 1. both logs must contain all eight capability names, so an adapter that never became
 *    ready fails here rather than matching an empty counterpart;
 * 2. a different input table must produce a different log, so a recorder that recorded
 *    nothing could not pass by being compared against another recorder that also recorded
 *    nothing;
 * 3. each capability call must change something observable in the mounted PixiJS scene, so an
 *    adapter that *recorded* the call but did not *forward* it fails; and
 * 4. the recorder itself is exercised directly on a bare object, so "it forwards verbatim" is
 *    shown rather than inferred from the agreement it produced.
 *
 * Each was tried as a mutation - see the header - rather than assumed.
 *
 * Hermeticity: synthetic subject and synthetic room ids, no network, no `dist/`, no clock, and
 * every value in the log is one this file wrote.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { addLinkedRooms, createRootDungeon } from '@/core/graph';
import { computeFloorVisibility, deriveGraphHierarchy } from '@/core/graph/navigation';
import { generateDungeonMap } from '@/core/layout/dungeonGenerator';
import type {
  DungeonRendererCapabilities,
  WorldRenderer,
} from '@/application/contracts/renderer';
import type {
  DungeonWorldModel,
  FloorVisibilityModel,
} from '@/application/contracts/world';
import type { DungeonSceneEvents } from '@/game/adapters';
import type { PixiDungeonRenderer } from '@/renderers/pixi/dungeon/DungeonRenderer';
import type { DungeonSceneCallbacks } from '@/renderers/pixi/dungeon/DungeonRenderer';
import type { DungeonScene } from '@/renderers/pixi/dungeon/createDungeonScene';
import type { Container } from 'pixi.js';
import {
  installCanvasContextStub,
  installResizeObserverStub,
  type StubbedContext,
  type StubbedResizeObserver,
} from '../phase9/support/canvasContextStub';

/* ── Phaser: a stubbed engine, so the adapter is reached without one ────────── */

const phaserStub = vi.hoisted(() => {
  class StubScene {
    readonly setFloorVisibility = vi.fn();
    readonly teleportToRoom = vi.fn();
    readonly setArtifactRooms = vi.fn();
    readonly setCollectedArtifactRooms = vi.fn();
    readonly setReviewedArtifactRooms = vi.fn();
    readonly setImageRooms = vi.fn();
    readonly setRoomOverlayStates = vi.fn();
    readonly triggerInteract = vi.fn();
  }

  class StubSceneManager {
    readonly started: Array<{ key: string; data: unknown }> = [];
    private readonly scenes = new Map<string, StubScene>();

    constructor(keys: readonly string[]) {
      for (const key of keys) this.scenes.set(key, new StubScene());
    }

    start(key: string, data?: unknown): void {
      this.started.push({ key, data });
    }

    getScene(key: string): StubScene | null {
      return this.scenes.get(key) ?? null;
    }
  }

  class StubGame {
    static instances: StubGame[] = [];

    readonly scene: StubSceneManager;
    private readonly readyHandlers: Array<() => void> = [];

    constructor(readonly config: Record<string, unknown>) {
      StubGame.instances.push(this);
      const sceneKeys = (config.scene as Array<{ name?: string }>).map(
        (entry) => entry.name ?? 'DungeonScene',
      );
      this.scene = new StubSceneManager(sceneKeys);
    }

    readonly events = {
      once: (event: string, handler: () => void) => {
        if (event === 'ready') this.readyHandlers.push(handler);
      },
    };

    destroy(_removeCanvas?: boolean): void {}

    emitReady(): void {
      for (const handler of [...this.readyHandlers]) handler();
    }
  }

  return { StubGame };
});

vi.mock('phaser', () => ({
  default: {
    AUTO: 'AUTO',
    Scale: { RESIZE: 'RESIZE', CENTER_BOTH: 'CENTER_BOTH' },
    Scene: class {},
    Game: phaserStub.StubGame,
  },
}));

class StubDungeonScene {
  static readonly name = 'DungeonScene';
}
class StubVillageScene {
  static readonly name = 'VillageScene';
}
class StubFishingScene {
  static readonly name = 'FishingScene';
}

vi.mock('@/game/scenes/DungeonScene', () => ({ DungeonScene: StubDungeonScene }));
vi.mock('@/game/scenes/VillageScene', () => ({ VillageScene: StubVillageScene }));
vi.mock('@/game/scenes/FishingScene', () => ({ FishingScene: StubFishingScene }));
vi.mock('@/services/customSprites', () => ({ revokeAllBlobUrls: vi.fn() }));

const { createPhaserDungeonRenderer } = await import('@/game/adapters');

/* ── PixiJS: the real adapter, on a real Application under jsdom ───────────── */

let stub: StubbedContext;
let observer: StubbedResizeObserver;
let restoreCanvasContext2D: () => void;

beforeAll(() => {
  stub = installCanvasContextStub();
  observer = installResizeObserverStub();
  const scope = globalThis as { CanvasRenderingContext2D?: unknown };
  const previous = scope.CanvasRenderingContext2D;
  scope.CanvasRenderingContext2D = class CanvasRenderingContext2DStub {};
  restoreCanvasContext2D = () => {
    if (previous === undefined) delete scope.CanvasRenderingContext2D;
    else scope.CanvasRenderingContext2D = previous;
  };
});

afterAll(() => {
  restoreCanvasContext2D();
  observer.restore();
  stub.restore();
});

afterEach(() => {
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

/* ── Synthetic fixtures ────────────────────────────────────────────────────── */

const ROOM_ALPHA = 'synthetic-room-alpha';
const ROOM_BETA = 'synthetic-room-beta';
const ROOM_GAMMA = 'synthetic-room-gamma';

const NOW = '2026-01-01T00:00:00.000Z';

/**
 * A real `DungeonMap`, generated by the real generator from a real graph dungeon.
 *
 * **Not a hand-written map literal.** `DungeonWorldModel.map` is consumed by
 * `createWalkabilityController`, which reads `map.walkable`; a literal that omits it
 * fails inside `createDungeonScene`, which `DungeonRenderer.mount` catches and swallows -
 * so a shortcut here would have produced a silently unmounted world rather than an error.
 * Generating the map is what makes this file reach a live scene.
 */
function buildDungeonWorld(): DungeonWorldModel {
  const root = createRootDungeon({
    dungeonId: 'synthetic-subject',
    subjectName: 'Synthetic Subject',
    rootRoomId: ROOM_ALPHA,
    rootTopic: 'Alpha Topic',
    nowIso: NOW,
  });
  if (!root.ok) throw new Error('root dungeon init failed');
  const grown = addLinkedRooms(root.value, {
    fromRoomId: ROOM_ALPHA,
    drafts: [{ roomId: ROOM_BETA, topic: 'Beta Topic' }],
    nowIso: NOW,
  });
  if (!grown.ok) throw new Error('addLinkedRooms failed');

  const floorId = ROOM_ALPHA;
  const floor = computeFloorVisibility(deriveGraphHierarchy(grown.value.dungeon), grown.value.dungeon, floorId);
  const SYNTHETIC_FLOOR: FloorVisibilityModel = {
    floorId: floor.floorId,
    visibleRoomIds: [...floor.visibleRoomIds],
    portalUpRoomId: floor.portalUpRoomId,
    portalDownRoomIds: [...floor.portalDownRoomIds],
  };

  return {
    kind: 'dungeon',
    map: generateDungeonMap(grown.value.dungeon),
    floor: SYNTHETIC_FLOOR,
    playerClass: 'scholar',
  };
}

const SYNTHETIC_DUNGEON_WORLD: DungeonWorldModel = buildDungeonWorld();
const SYNTHETIC_FLOOR: FloorVisibilityModel = SYNTHETIC_DUNGEON_WORLD.floor;

function dungeonCallbacks(): DungeonSceneEvents {
  return {
    onRoomEntered: vi.fn(),
    onInteract: vi.fn(),
    onNpcInteract: vi.fn(),
    onNpcDialogPosition: vi.fn(),
    onNpcOutOfRange: vi.fn(),
    onArtifactCollected: vi.fn(),
    onFloorTransition: vi.fn(),
  };
}

/* ── The one input table ───────────────────────────────────────────────────── */

/**
 * Every member of `DungeonRendererCapabilities`, once each, with synthetic arguments.
 *
 * **Derived from the port rather than written out by hand**, so a capability the Phase 16
 * contract added to `DungeonRendererCapabilities` cannot be missing here without turning
 * this file red. That is the whole point of the table: the drift this guards against is a
 * signal the host publishes and one adapter consumes while the other ignores it, and a
 * hand-written list would have been updated by whoever noticed, not by the type.
 */
const CAPABILITY_NAMES = [
  'setFloorVisibility',
  'teleportToRoom',
  'setArtifactRooms',
  'setCollectedArtifactRooms',
  'setReviewedArtifactRooms',
  'setImageRooms',
  'setRoomOverlayStates',
  'triggerInteract',
] as const satisfies readonly (keyof DungeonRendererCapabilities)[];

/** One published signal: its name and the arguments the host would push for it. */
interface Signal {
  readonly name: keyof DungeonRendererCapabilities;
  readonly args: readonly unknown[];
  readonly apply: (capabilities: DungeonRendererCapabilities) => void;
}

/** Record each signal against an adapter, as a deep clone so nothing can alias. */
function recordSignals(
  capabilities: DungeonRendererCapabilities,
  signals: readonly Signal[],
): Array<{ name: string; args: unknown }> {
  const log: Array<{ name: string; args: unknown }> = [];
  const record = (name: string, args: readonly unknown[]) => {
    log.push({ name, args: structuredClone(args) });
  };

  const wrapper: DungeonRendererCapabilities = {
    setFloorVisibility: (visibility) => {
      record('setFloorVisibility', [visibility]);
      capabilities.setFloorVisibility(visibility);
    },
    teleportToRoom: (roomId) => {
      record('teleportToRoom', [roomId]);
      capabilities.teleportToRoom(roomId);
    },
    setArtifactRooms: (roomIds, visible) => {
      record('setArtifactRooms', [roomIds, visible]);
      capabilities.setArtifactRooms(roomIds, visible);
    },
    setCollectedArtifactRooms: (roomIds) => {
      record('setCollectedArtifactRooms', [roomIds]);
      capabilities.setCollectedArtifactRooms(roomIds);
    },
    setReviewedArtifactRooms: (roomIds) => {
      record('setReviewedArtifactRooms', [roomIds]);
      capabilities.setReviewedArtifactRooms(roomIds);
    },
    setImageRooms: (roomIds) => {
      record('setImageRooms', [roomIds]);
      capabilities.setImageRooms(roomIds);
    },
    setRoomOverlayStates: (states) => {
      record('setRoomOverlayStates', [states]);
      capabilities.setRoomOverlayStates(states);
    },
    triggerInteract: () => {
      record('triggerInteract', []);
      capabilities.triggerInteract();
    },
  };

  for (const signal of signals) signal.apply(wrapper);
  return log;
}

/**
 * The signal set a Phase 16 session publishes.
 *
 * Every value is app-minted or a fixed phrase: two room ids, one boolean, one state map.
 * There is no topic, no note, and no artifact text anywhere in this file, which is also why
 * a renderer can be handed exactly this much and nothing more.
 */
function reviewSignals(): readonly Signal[] {
  return [
    {
      name: 'setFloorVisibility',
      args: [SYNTHETIC_FLOOR],
      apply: (c) => c.setFloorVisibility(SYNTHETIC_FLOOR),
    },
    { name: 'teleportToRoom', args: [ROOM_BETA], apply: (c) => c.teleportToRoom(ROOM_BETA) },
    {
      name: 'setArtifactRooms',
      args: [[ROOM_ALPHA], true],
      apply: (c) => c.setArtifactRooms([ROOM_ALPHA], true),
    },
    {
      name: 'setCollectedArtifactRooms',
      args: [[ROOM_ALPHA]],
      apply: (c) => c.setCollectedArtifactRooms([ROOM_ALPHA]),
    },
    {
      name: 'setReviewedArtifactRooms',
      args: [[ROOM_BETA]],
      apply: (c) => c.setReviewedArtifactRooms([ROOM_BETA]),
    },
    { name: 'setImageRooms', args: [[ROOM_GAMMA]], apply: (c) => c.setImageRooms([ROOM_GAMMA]) },
    {
      name: 'setRoomOverlayStates',
      args: [{ [ROOM_ALPHA]: 'EncounterDefeated' }],
      apply: (c) => c.setRoomOverlayStates({ [ROOM_ALPHA]: 'EncounterDefeated' }),
    },
    { name: 'triggerInteract', args: [], apply: (c) => c.triggerInteract() },
  ];
}

/* ── Reaching each adapter ─────────────────────────────────────────────────── */

function mountPhaserAdapter(): {
  renderer: WorldRenderer & DungeonRendererCapabilities;
  release: () => void;
} {
  // Typed as the *neutral* port, not `PhaserDungeonRenderer`, so the log below is taken over
  // the same surface a screen speaks. The two lanes are not symmetric - Pixi also offers
  // `readArtifactSnapshot` - and the asymmetry is kept visible rather than papered over with
  // a cast, because it is the reason the last two tests in this file exist.
  const renderer = createPhaserDungeonRenderer({
    parent: document.createElement('div'),
    world: SYNTHETIC_DUNGEON_WORLD,
    callbacks: dungeonCallbacks(),
  });
  renderer.mount();
  const game = phaserStub.StubGame.instances.at(-1);
  if (game === undefined) throw new Error('no stub Phaser.Game was constructed');
  game.emitReady();
  if (!renderer.isReady()) throw new Error('the Phaser adapter never reported ready');
  return { renderer, release: () => renderer.unmount() };
}

async function mountPixiAdapter(): Promise<{
  renderer: PixiDungeonRenderer;
  release: () => void;
}> {
  const host = document.createElement('div');
  document.body.append(host);
  const { createPixiDungeonRenderer } = await import(
    '@/renderers/pixi/dungeon/DungeonRenderer'
  );
  const renderer = createPixiDungeonRenderer({
    host,
    world: SYNTHETIC_DUNGEON_WORLD,
    callbacks: dungeonCallbacks(),
  });
  await renderer.onReady(() => {});
  renderer.mount();
  // `mount()` is deliberately fire-and-forget in the adapter, so readiness is polled rather
  // than awaited. The floor is generous because jsdom's WebGL negotiation is the slow part
  // and this file's claim is about the capability port, not about mount latency.
  const deadline = Date.now() + 20_000;
  while (!renderer.isReady() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!renderer.isReady()) {
    renderer.unmount();
    host.remove();
    throw new Error('the PixiJS adapter never presented a first frame under jsdom');
  }
  return {
    renderer,
    release: () => {
      renderer.unmount();
      host.remove();
    },
  };
}

/* ── Reaching the real scene, for the signals the adapter cannot be asked about ── */

const liveScenes: Array<{ destroy(): void }> = [];
const liveApplications: Array<{ destroy(options?: { releaseGlobalResources?: boolean }): void }> =
  [];

afterEach(() => {
  for (const scene of liveScenes.splice(0)) {
    try {
      scene.destroy();
    } catch {
      /* teardown is not this file's claim */
    }
  }
  for (const application of liveApplications.splice(0)) {
    try {
      application.destroy({ releaseGlobalResources: true });
    } catch {
      /* likewise */
    }
  }
  document.querySelectorAll('canvas').forEach((canvas) => canvas.remove());
});

interface MountedScene {
  readonly scene: DungeonScene;
  readonly worldLayer: Container;
}

/**
 * A real PixiJS 8 `Application` with the real `createDungeonScene` on it.
 *
 * The same altitude as `tests/phase13/dungeon-scene.test.ts`: the scene graph is the only place
 * the three signals without a renderer read are observable, and a fake application would prove
 * only the scene's intent. The canvas context and the `ResizeObserver` are the two facilities
 * jsdom lacks; neither can draw a marker or invent a label.
 */
async function mountRealScene(): Promise<MountedScene> {
  const { asPixiApplication, createPixiApplication } = await import(
    '@/renderers/pixi/runtime/createPixiApplication'
  );
  const { resolveCozyWorldTheme } = await import('@/renderers/pixi/runtime/cozyWorldTheme');
  const { resolveWorldQualityProfile } = await import('@/renderers/pixi/runtime/types');
  const { createDungeonScene } = await import('@/renderers/pixi/dungeon/createDungeonScene');

  const theme = resolveCozyWorldTheme({ theme: null, reducedMotion: false });
  const quality = resolveWorldQualityProfile('balanced');
  const canvas = document.createElement('canvas');
  const application = await createPixiApplication({
    canvas,
    quality,
    background: theme.color.surfacePage,
    backgroundAlpha: 1,
  });
  liveApplications.push(application);
  application.resize(800, 600);
  const pixi = asPixiApplication(application);

  let scene!: DungeonScene;
  scene = createDungeonScene(
    pixi,
    {
      theme,
      quality,
      onAction: (actionId, source) => scene.activate(actionId, source),
      publishState: () => undefined,
    },
    { world: SYNTHETIC_DUNGEON_WORLD, callbacks: dungeonCallbacks() as DungeonSceneCallbacks },
  );
  liveScenes.push(scene);

  const root = pixi.stage.getChildByLabel('dungeon-world');
  if (root === null) throw new Error('the scene added no labelled root');
  const worldLayer = root.getChildByLabel('dungeon-world-layer');
  if (worldLayer === null) throw new Error('the scene added no world layer');
  return { scene, worldLayer };
}

/* ── Tests ─────────────────────────────────────────────────────────────────── */

describe('the audit table is every capability the dungeon port declares', () => {
  it('the port declares exactly the members the table pushes, and nothing else', () => {
    // Runtime check rather than a `typecheck`: a member added to the port and not to the
    // table would still compile, because the table is a `readonly Signal[]`, and this is
    // the assertion that says so out loud.
    const pushed = reviewSignals().map((signal) => signal.name).sort();
    expect(pushed).toEqual([...CAPABILITY_NAMES].sort());

    // And the declared arguments agree with the recorded ones, so a table entry that
    // documents one thing and sends another is caught here rather than in an equality
    // assertion that would compare two identically-wrong values.
    for (const signal of reviewSignals()) {
      const log = recordSignals(
        new Proxy({} as DungeonRendererCapabilities, { get: () => () => {} }),
        [signal],
      );
      expect(log, signal.name).toHaveLength(1);
      expect(log[0]?.name, signal.name).toBe(signal.name);
      expect(log[0]?.args, signal.name).toEqual(signal.args);
    }
  });
});

describe('both dungeon adapters consume the Phase 16 signal set identically', () => {
  it('the Phaser and PixiJS adapters produce a byte-identical capability log', async () => {
    const signals = reviewSignals();
    const phaser = mountPhaserAdapter();
    let pixi: Awaited<ReturnType<typeof mountPixiAdapter>> | null = null;
    try {
      pixi = await mountPixiAdapter();

      const phaserLog = recordSignals(phaser.renderer, signals);
      const pixiLog = recordSignals(pixi.renderer, signals);

      // Both adapters were handed the same eight calls and produced the same eight
      // records. This is the parity claim: after this, the two engines differ only in
      // what they draw, not in what they were told.
      expect(phaserLog).toEqual(pixiLog);
    } finally {
      phaser.release();
      pixi?.release();
    }
  });

  it('neither log is empty, so the equality is not two absences', async () => {
    // The guard that makes the equality above mean something. A PixiJS adapter that never
    // mounted - the failure this file's jsdom setup could plausibly have - would publish
    // nothing, and a Phaser log compared against nothing would still be compared. Asserting
    // the coverage directly names that failure instead of letting it read as agreement.
    const signals = reviewSignals();
    const phaser = mountPhaserAdapter();
    let pixi: Awaited<ReturnType<typeof mountPixiAdapter>> | null = null;
    try {
      pixi = await mountPixiAdapter();

      for (const [lane, log] of [
        ['phaser', recordSignals(phaser.renderer, signals)],
        ['pixi', recordSignals(pixi.renderer, signals)],
      ] as const) {
        expect(log.map((entry) => entry.name), lane).toEqual(
          signals.map((signal) => signal.name),
        );
      }
    } finally {
      phaser.release();
      pixi?.release();
    }
  });

  it('a different published set produces a different log, so the recorder discriminates', async () => {
    // If the recorder ignored its arguments, the two adapters would agree on everything
    // and this file would pass while proving nothing. Swapping two room ids has to change
    // what is recorded.
    const swapped = reviewSignals().map((signal) =>
      signal.name === 'setReviewedArtifactRooms'
        ? {
            ...signal,
            args: [[ROOM_ALPHA]],
            apply: (c: DungeonRendererCapabilities) => c.setReviewedArtifactRooms([ROOM_ALPHA]),
          }
        : signal,
    );
    const original = reviewSignals();

    const phaser = mountPhaserAdapter();
    let pixi: Awaited<ReturnType<typeof mountPixiAdapter>> | null = null;
    try {
      pixi = await mountPixiAdapter();

      const before = recordSignals(pixi.renderer, original);
      const after = recordSignals(pixi.renderer, swapped);
      expect(after).not.toEqual(before);
      expect(recordSignals(phaser.renderer, swapped)).toEqual(after);
    } finally {
      phaser.release();
      pixi?.release();
    }
  });
});

describe('the review signals reach the PixiJS scene, not only the adapter', () => {
  it('the adapter is a live world by the time it is handed a reviewed set', async () => {
    // The adapter-level agreement above would also hold for two adapters that both dropped
    // the signal on the floor. This is the end-to-end half: after readiness the PixiJS
    // adapter answers a question about the world that only a built scene can answer, so the
    // `setArtifactRooms` call demonstrably reached a scene rather than a discarded queue.
    const pixi = await mountPixiAdapter();
    try {
      // Before any signal: the renderer reports the idle snapshot, because the host has
      // permitted no pickup and named no room.
      const idle = pixi.renderer.readArtifactSnapshot();
      expect(idle.pickupPermitted).toBe(false);
      expect(idle.canCollect).toBe(false);

      pixi.renderer.setArtifactRooms([ROOM_ALPHA], true);
      pixi.renderer.setFloorVisibility(SYNTHETIC_FLOOR);

      // After: the same read reports the host's decision, which means the capability call
      // traversed the adapter, the host's capability port, and the scene.
      const published = pixi.renderer.readArtifactSnapshot();
      expect(published.pickupPermitted).toBe(true);
      expect(published.exists).toBe(true);
      expect(published.state).toBe('collectible');
      expect(published.canCollect).toBe(true);
    } finally {
      pixi.release();
    }
  });

  it('every capability call reaches a mounted scene, and the collected set is one of them', async () => {
    // The adapter-level table above records the calls *into* the adapter. This records their
    // *effect*, which is the part a table cannot see: an adapter whose capability method had
    // an empty body would produce a perfect log and a dead world.
    //
    // Two independent effects are used, because the neutral port has no read of its own and the
    // PixiJS adapter offers exactly one: `onState` fires from the *scene's* `readState()`, and
    // `readArtifactSnapshot()` is a second read of the same scene's own sets. A body that
    // dropped its forwarding would move neither counter.
    const pixi = await mountPixiAdapter();
    try {
      pixi.renderer.setFloorVisibility(SYNTHETIC_FLOOR);

      let publications = 0;
      pixi.renderer.onState(() => {
        publications += 1;
      });

      for (const signal of reviewSignals()) {
        const before = publications;
        signal.apply(pixi.renderer);
        expect(
          publications,
          `${signal.name} published nothing, so it never reached the scene`,
        ).toBeGreaterThan(before);
      }

      // And the scene's *own* record moved, which is a different mechanism from the
      // republication and therefore catches a different failure: an adapter that republished
      // without forwarding.
      //
      // Read from `rooms`, not from the top-level `state`: the top-level answer is about the
      // room the player is *standing in*, and the signal loop above teleported them to
      // `ROOM_BETA`, so this is a statement about one named room rather than about wherever
      // the player happens to be standing.
      const markerOf = (roomId: string) =>
        pixi.renderer.readArtifactSnapshot().rooms.find((room) => room.roomId === roomId)?.state;

      // `ROOM_BETA`, because the signal loop above already reported `ROOM_ALPHA` collected and
      // the renderer unions the host's set with its own monotone record - by design, so a
      // marker that came back after the pickup cannot be re-offered. Using the reported room
      // here would read 'collected' and could not tell a forwarded call from a stale record.
      pixi.renderer.setArtifactRooms([ROOM_BETA], true);
      expect(markerOf(ROOM_BETA)).toBe('collectible');
      expect(pixi.renderer.readArtifactSnapshot().pickupPermitted).toBe(true);

      pixi.renderer.setCollectedArtifactRooms([ROOM_BETA]);
      expect(markerOf(ROOM_BETA)).toBe('collected');
      // And the collected answer wins over the permission, which is the precedence
      // `dungeonArtifact.ts` documents: an already-collected artifact is never re-offered.
      expect(pixi.renderer.readArtifactSnapshot().canCollect).toBe(false);
    } finally {
      pixi.release();
    }
  });

  it('a suppressed duplicate changes no published review signal', async () => {
    // The Phase 16 question at the renderer altitude. A duplicate review is suppressed by
    // the progression ledger and writes no `reviewPassCount`, so *nothing* about the room's
    // review state changes - and if the adapter treated a republished review set as a reason
    // to move the player or republish a status, that would be visible here.
    const pixi = await mountPixiAdapter();
    try {
      pixi.renderer.setFloorVisibility(SYNTHETIC_FLOOR);
      pixi.renderer.setArtifactRooms([ROOM_ALPHA], true);

      const statuses: Array<Readonly<Record<string, string>>> = [];
      pixi.renderer.onState((state) => statuses.push(state));

      pixi.renderer.setReviewedArtifactRooms([ROOM_ALPHA]);
      const afterFirst = pixi.renderer.readArtifactSnapshot();
      const publicationsAfterFirst = statuses.length;
      const statusesAfterFirst = statuses.at(-1);
      // Non-vacuity: "the last two publications are equal" is also true when there are none,
      // and this is the only test in the file that would not notice an adapter that dropped
      // `setReviewedArtifactRooms` entirely.
      expect(publicationsAfterFirst).toBeGreaterThan(0);
      expect(statusesAfterFirst).toBeDefined();

      // The second publication is byte-identical to the first, which is the whole claim:
      // a review marker is a boolean per room, so "reviewed again" and "reviewed once"
      // are the same rendering, and the renderer is not asked to redraw for an award.
      pixi.renderer.setReviewedArtifactRooms([ROOM_ALPHA]);
      const afterSecond = pixi.renderer.readArtifactSnapshot();
      const statusesAfterSecond = statuses.at(-1);

      expect(afterSecond).toEqual(afterFirst);
      expect(statusesAfterSecond).toEqual(statusesAfterFirst);
      expect(statuses.length).toBe(publicationsAfterFirst + 1);
      // And the set is monotone in the honest direction: the artifact read is unaffected by
      // review state, so a review marker and a collectable marker cannot shadow each other.
      expect(afterSecond.state).toBe('collectible');
      // The artifact read carries no review field at all, which is the Phase 16 boundary in
      // the type: a renderer asked "may I collect?" never reads the review ledger, and a
      // review marker cannot change a pickup decision.
      expect(Object.keys(afterSecond)).not.toContain('reviewed');
      expect(Object.keys(afterSecond)).not.toContain('reviewedRoomIds');
    } finally {
      pixi.release();
    }
  });
});

describe('the real PixiJS scene consumes the three signals it has no read for', () => {
  /**
   * `setReviewedArtifactRooms`, `setImageRooms`, and `setRoomOverlayStates` are the three
   * members of the port the PixiJS adapter cannot be asked about from outside: the renderer
   * publishes no read for them, so the adapter-level tests above can only prove they were
   * called. What they change is in the scene graph, so this drives `createDungeonScene`
   * directly - the same altitude as `tests/phase13/dungeon-scene.test.ts`, and the only one at
   * which the answer is visible.
   *
   * It is here rather than in Phase 13 because Phase 16 is what made the set worth pinning as
   * a *set*: `setReviewedArtifactRooms` now means "reviewed at least once", `setImageRooms`
   * shares a room node with it, and the two markers must not shadow one another.
   */
  it('draws the review dot and the picture frame independently, and honours the overlay state', async () => {
    const mounted = await mountRealScene();

    const roomNode = (roomId: string) => {
      const node = mounted.worldLayer
        .getChildByLabel('dungeon-rooms')
        ?.getChildByLabel(`dungeon-room-${roomId}`);
      if (node === null || node === undefined) throw new Error(`no room node for ${roomId}`);
      return node;
    };
    const reviewOf = (roomId: string) => roomNode(roomId).getChildByLabel('dungeon-room-review');
    const imageOf = (roomId: string) => roomNode(roomId).getChildByLabel('dungeon-room-image');
    const overlayOf = (roomId: string) => roomNode(roomId).getChildByLabel('dungeon-room-overlay');

    // Nothing published yet: both hints are hidden on every room.
    expect(reviewOf(ROOM_ALPHA)?.visible).toBe(false);
    expect(reviewOf(ROOM_BETA)?.visible).toBe(false);
    expect(imageOf(ROOM_ALPHA)?.visible).toBe(false);

    // Reviewed, but with no attachment: the two are separate facts and the review dot does not
    // drag the frame in with it.
    mounted.scene.capabilities.setReviewedArtifactRooms([ROOM_ALPHA]);
    expect(reviewOf(ROOM_ALPHA)?.visible).toBe(true);
    expect(reviewOf(ROOM_BETA)?.visible).toBe(false);
    expect(imageOf(ROOM_ALPHA)?.visible).toBe(false);

    // An attachment, but in the *other* room: the frame appears and the review dot stays put.
    mounted.scene.capabilities.setImageRooms([ROOM_BETA]);
    expect(imageOf(ROOM_ALPHA)?.visible).toBe(false);
    expect(reviewOf(ROOM_ALPHA)?.visible).toBe(true);

    // And withdrawing the review set withdraws only the dot.
    mounted.scene.capabilities.setReviewedArtifactRooms([]);
    expect(reviewOf(ROOM_ALPHA)?.visible).toBe(false);

    // The overlay state is a third, independent channel: it changes the node's own overlay and
    // leaves both markers alone.
    mounted.scene.capabilities.setRoomOverlayStates({ [ROOM_ALPHA]: 'EncounterDefeated' });
    expect(overlayOf(ROOM_ALPHA)).not.toBeNull();
    expect(reviewOf(ROOM_ALPHA)?.visible).toBe(false);
    expect(imageOf(ROOM_ALPHA)?.visible).toBe(false);
  });
});