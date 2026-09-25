/**
 * Phase 2 contract test: Phaser renderer adapters against a stubbed
 * Phaser-shaped host.
 *
 * The adapter is the only place where the neutral world model, the neutral
 * renderer contract, and the Phaser engine meet, so this is the right level to
 * pin the edge behaviour the screens depend on:
 *
 * - `mount()` starts the right scene key with the right data, derived from the
 *   renderer-neutral `DungeonWorldModel` / `VillageWorldModel` / `FishingWorldModel`
 * - `mount()` is idempotent; `unmount()` destroys the game and clears readiness
 * - `isReady()` is false before the engine's `ready` event and true after
 * - `onReady` listeners fire exactly once and unsubscribing works
 * - `restart()` issues the scene restart in the same tick the pre-Phase-2
 *   screen did, with the custom-sprite blob-URL revocation scheduled first
 * - every capability forwards to the scene and **no-ops safely** while no scene
 *   is available. This replaced the `sceneRef.current?.…` optional calls the
 *   screens used to make, so it is a real behaviour and a real regression risk.
 * - `readPoi()` hides points of interest at `distance >= 1e9`
 * - the fishing `returnToVillage()` keeps its `setTimeout(…, 0)` before
 *   stop/wake
 *
 * Phaser itself is never imported: the engine module is replaced by a
 * controllable stub, and the three scene modules are stubbed too, so this file
 * asserts the adapter's engine calls rather than Phaser's behaviour. Real
 * Phaser rendering is covered by `npm run test:e2e`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FishRarity } from '@/core/fishing/fishingTypes';
import type {
  DungeonSceneEvents,
  PhaserDungeonRenderer,
  PhaserVillageRenderer,
  VillageSceneEvents,
} from '@/game/adapters';
import type { FishingSceneEvents } from '@/game/scenes/FishingScene';
import type {
  DungeonRendererCapabilities,
  FishingRendererCapabilities,
  VillageRendererCapabilities,
  WorldRenderer,
} from '@/application/contracts/renderer';
import type {
  DungeonWorldModel,
  FishingWorldModel,
  FloorVisibilityModel,
  VillageWorldModel,
} from '@/application/contracts/world';
import type { VillageStructure } from '@/data/villageLayout';

// ── Stubbed Phaser engine ───────────────────────────────────────────────────

/**
 * A Phaser-shaped scene: the capability surface the adapter forwards to, plus
 * the `scene.restart` / `scene.sleep` / `scene.wake` handles it drives.
 *
 * These stubs live inside `vi.hoisted` because the `phaser` mock factory is
 * hoisted above the module body and has to reach the `Game` constructor.
 */
const phaserStub = vi.hoisted(() => {
  class StubScene {
    readonly restarts: string[] = [];
    readonly sleeps: number[] = [];
    readonly wakes: number[] = [];

    // Dungeon capabilities.
    readonly setFloorVisibility = vi.fn();
    readonly teleportToRoom = vi.fn();
    readonly setArtifactRooms = vi.fn();
    readonly setCollectedArtifactRooms = vi.fn();
    readonly setReviewedArtifactRooms = vi.fn();
    readonly setImageRooms = vi.fn();
    readonly setRoomOverlayStates = vi.fn();
    readonly triggerInteract = vi.fn();

    // Village capabilities.
    readonly setDynamicStructures = vi.fn();
    readonly setPlayerClass = vi.fn();

    // Fishing capabilities.
    readonly getCaughtCount = vi.fn<() => number>();

    /** Village HUD read-out source; `lastPoi` is what `readPoi()` projects. */
    lastPoi: { name: string; angle: number; distance: number } = {
      name: '',
      angle: 0,
      distance: Number.POSITIVE_INFINITY,
    };

    /** Phaser scene-plugin namespace the adapter drives. */
    readonly scene = {
      restart: () => {
        this.restarts.push('restart');
      },
      sleep: () => {
        this.sleeps.push(1);
      },
      wake: () => {
        this.wakes.push(1);
      },
    };
  }

  /** A Phaser-shaped scene manager. */
  class StubSceneManager {
    readonly started: Array<{ key: string; data: unknown }> = [];
    readonly stopped: string[] = [];
    readonly callLog: string[] = [];
    private readonly scenes = new Map<string, StubScene>();

    constructor(keys: readonly string[]) {
      for (const key of keys) this.scenes.set(key, new StubScene());
    }

    start(key: string, data?: unknown): void {
      this.started.push({ key, data });
      this.callLog.push(`start:${key}`);
    }

    stop(key: string): void {
      this.stopped.push(key);
      this.callLog.push(`stop:${key}`);
    }

    getScene(key: string): StubScene | null {
      return this.scenes.get(key) ?? null;
    }
  }

  /** A Phaser-shaped game. */
  class StubGame {
    static instances: StubGame[] = [];

    readonly scene: StubSceneManager;
    readonly destroyed: boolean[] = [];
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

    destroy(removeCanvas?: boolean): void {
      this.destroyed.push(removeCanvas ?? false);
    }

    /** Fire the engine's `ready` event, the handshake the adapter waits for. */
    emitReady(): void {
      for (const handler of [...this.readyHandlers]) handler();
    }
  }

  return { StubGame, StubScene, StubSceneManager };
});

const { StubGame } = phaserStub;
/** Instance type of the hoisted scene stub, named for this file's annotations. */
type StubSceneInstance = InstanceType<(typeof phaserStub)['StubScene']>;

vi.mock('phaser', () => ({
  default: {
    AUTO: 'AUTO',
    Scale: { RESIZE: 'RESIZE', CENTER_BOTH: 'CENTER_BOTH' },
    Scene: class {},
    Game: phaserStub.StubGame,
  },
}));

// Named scene stubs so `scene.start(key, …)` and the capability lookups resolve.
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

/** Order log shared by the custom-sprite revocation and the scene restart. */
const restartOrder: string[] = [];
vi.mock('@/services/customSprites', () => ({
  revokeAllBlobUrls: vi.fn(() => {
    restartOrder.push('revoke-blob-urls');
  }),
}));

const { createPhaserDungeonRenderer, createPhaserVillageRenderer } = await import(
  '@/game/adapters'
);

// ── Synthetic fixtures ──────────────────────────────────────────────────────

const SYNTHETIC_SUBJECT_ID = 'synthetic-subject-1';
const SYNTHETIC_ROOM_ALPHA = 'synthetic-room-alpha';
const SYNTHETIC_ROOM_BETA = 'synthetic-room-beta';
const SYNTHETIC_POI_NAME = 'Synthetic Signpost';
const SYNTHETIC_STRUCTURE_ID = 'synthetic-portal-icon';

const SYNTHETIC_DUNGEON_MAP = {
  tileSize: 32,
  bounds: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
  rooms: [
    {
      roomId: SYNTHETIC_ROOM_ALPHA,
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      topic: 'Test Room Alpha',
      doorSides: [],
    },
    {
      roomId: SYNTHETIC_ROOM_BETA,
      x: 2,
      y: 0,
      width: 2,
      height: 2,
      topic: 'Test Room Beta',
      doorSides: [],
    },
  ],
  corridors: [],
  doors: [],
} as unknown as DungeonWorldModel['map'];

const SYNTHETIC_FLOOR: FloorVisibilityModel = {
  floorId: SYNTHETIC_ROOM_ALPHA,
  visibleRoomIds: [SYNTHETIC_ROOM_ALPHA, SYNTHETIC_ROOM_BETA],
  portalUpRoomId: null,
  portalDownRoomIds: [SYNTHETIC_ROOM_BETA],
  biomeId: 'scienceLabs',
};

const SYNTHETIC_DUNGEON_WORLD: DungeonWorldModel = {
  kind: 'dungeon',
  map: SYNTHETIC_DUNGEON_MAP,
  floor: SYNTHETIC_FLOOR,
  playerClass: 'scholar',
};

const SYNTHETIC_DUNGEON_STRUCTURES: readonly VillageStructure[] = [
  {
    id: SYNTHETIC_STRUCTURE_ID,
    type: 'portal-icon',
    label: 'Synthetic Portal',
    gridX: 3,
    gridY: 3,
    width: 1,
    height: 1,
    subjectId: SYNTHETIC_SUBJECT_ID,
  },
];

const SYNTHETIC_VILLAGE_WORLD: VillageWorldModel = {
  kind: 'village',
  structures: SYNTHETIC_DUNGEON_STRUCTURES,
  playerClass: 'cartographer',
};

const SYNTHETIC_FISHING_WORLD: FishingWorldModel = {
  kind: 'fishing',
  playerClass: 'archivist',
  hasClearedRooms: true,
  subjectId: SYNTHETIC_SUBJECT_ID,
};

const SYNTHETIC_FISH = {
  fishName: 'Synthetic Test Fish',
  rarity: 'common' as FishRarity,
  catalogId: 'synthetic-fish-1',
  description: 'A synthetic fish invented for contract tests.',
};

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

function villageCallbacks(): VillageSceneEvents {
  return {
    onStructureApproached: vi.fn(),
    onStructureLeft: vi.fn(),
    onStructureInteract: vi.fn(),
    onNpcApproached: vi.fn(),
    onNpcLeft: vi.fn(),
    onNpcInteract: vi.fn(),
    onNpcDialogPosition: vi.fn(),
    onReady: vi.fn(),
  };
}

type StubGameInstance = InstanceType<(typeof phaserStub)['StubGame']>;

function lastGame(): StubGameInstance {
  const game = StubGame.instances.at(-1);
  if (!game) throw new Error('no Phaser.Game was constructed');
  return game;
}

function sceneOf(game: StubGameInstance, key: string): StubSceneInstance {
  const scene = game.scene.getScene(key);
  if (!scene) throw new Error(`stub scene ${key} is missing`);
  return scene;
}

/** Every capability call the neutral dungeon port declares, as one thunk each. */
function dungeonCapabilityCalls(
  capabilities: DungeonRendererCapabilities,
): Array<[string, () => void]> {
  return [
    ['setFloorVisibility', () => capabilities.setFloorVisibility(SYNTHETIC_FLOOR)],
    ['teleportToRoom', () => capabilities.teleportToRoom(SYNTHETIC_ROOM_BETA)],
    ['setArtifactRooms', () => capabilities.setArtifactRooms([SYNTHETIC_ROOM_ALPHA], true)],
    ['setCollectedArtifactRooms', () => capabilities.setCollectedArtifactRooms([SYNTHETIC_ROOM_ALPHA])],
    ['setReviewedArtifactRooms', () => capabilities.setReviewedArtifactRooms([SYNTHETIC_ROOM_BETA])],
    ['setImageRooms', () => capabilities.setImageRooms([SYNTHETIC_ROOM_BETA])],
    [
      'setRoomOverlayStates',
      () => capabilities.setRoomOverlayStates({ [SYNTHETIC_ROOM_ALPHA]: 'Created' }),
    ],
    ['triggerInteract', () => capabilities.triggerInteract()],
  ];
}

/** Every capability call the neutral village port declares, as one thunk each. */
function villageCapabilityCalls(
  capabilities: VillageRendererCapabilities,
): Array<[string, () => unknown]> {
  return [
    [
      'setDynamicStructures',
      () => capabilities.setDynamicStructures(SYNTHETIC_DUNGEON_STRUCTURES),
    ],
    ['setPlayerClass', () => capabilities.setPlayerClass('archivist')],
    ['setPlayerClass(null)', () => capabilities.setPlayerClass(null)],
    ['triggerInteract', () => capabilities.triggerInteract()],
    ['readPoi', () => capabilities.readPoi()],
  ];
}

/** Every capability call the neutral fishing port declares, as one thunk each. */
function fishingCapabilityCalls(
  capabilities: FishingRendererCapabilities,
): Array<[string, () => unknown]> {
  return [
    ['setPlayerClass', () => capabilities.setPlayerClass('cartographer')],
    ['getCaughtCount', () => capabilities.getCaughtCount()],
    ['returnToVillage', () => capabilities.returnToVillage()],
  ];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Phase 2 Phaser adapter lifecycle', () => {
  beforeEach(() => {
    StubGame.instances = [];
    restartOrder.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('dungeon renderer', () => {
    it('mounts the dungeon scene with data derived from the neutral world model', () => {
      const callbacks = dungeonCallbacks();
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks,
      });

      renderer.mount();

      const game = lastGame();
      expect(game.config.parent).toBeDefined();
      expect(game.config.scene).toEqual([StubDungeonScene]);
      expect(game.config.scale).toMatchObject({ mode: 'RESIZE', autoCenter: 'CENTER_BOTH' });
      expect(game.config.physics).toMatchObject({ default: 'arcade' });
      expect(game.scene.started).toEqual([
        {
          key: 'DungeonScene',
          data: {
            dungeonMap: SYNTHETIC_DUNGEON_MAP,
            callbacks,
            playerClass: 'scholar',
            initialFloor: SYNTHETIC_FLOOR,
          },
        },
      ]);
      // The neutral floor model crosses the boundary unconverted: the scene's
      // `FloorVisibilityInput` accepts the readonly arrays directly.
      const started = game.scene.started[0].data as { initialFloor: FloorVisibilityModel };
      expect(started.initialFloor).toBe(SYNTHETIC_FLOOR);
      expect(started.initialFloor.visibleRoomIds).toBe(SYNTHETIC_FLOOR.visibleRoomIds);
    });

    it('passes a null player class through unchanged when no archetype is selected', () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: { ...SYNTHETIC_DUNGEON_WORLD, playerClass: null },
        callbacks: dungeonCallbacks(),
      });

      renderer.mount();

      const started = lastGame().scene.started[0].data as { playerClass: string | null };
      expect(started.playerClass).toBeNull();
    });

    it('is idempotent: a second mount does not construct or start a second game', () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });

      renderer.mount();
      renderer.mount();
      renderer.mount();

      expect(StubGame.instances).toHaveLength(1);
      expect(lastGame().scene.started).toHaveLength(1);
    });

    it('reports readiness only after the engine ready event, and clears it on unmount', () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });

      expect(renderer.isReady()).toBe(false);
      renderer.mount();
      expect(renderer.isReady()).toBe(false);

      lastGame().emitReady();
      expect(renderer.isReady()).toBe(true);

      renderer.unmount();
      expect(renderer.isReady()).toBe(false);
    });

    it('destroys the game with removeCanvas on unmount and is safe to repeat', () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });
      renderer.mount();
      const game = lastGame();

      renderer.unmount();
      renderer.unmount();

      expect(game.destroyed).toEqual([true]);
    });

    it('notifies onReady listeners once and honours unsubscribe', () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });
      const listener = vi.fn();
      const unsubscribed = vi.fn();
      renderer.onReady(listener);
      const unsubscribe = renderer.onReady(unsubscribed);
      unsubscribe();

      renderer.mount();
      lastGame().emitReady();
      lastGame().emitReady();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(unsubscribed).not.toHaveBeenCalled();
    });

    it('restarts the scene in the same tick the pre-Phase-2 screen did', async () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });
      renderer.mount();
      const scene = sceneOf(lastGame(), 'DungeonScene');
      scene.restarts.length = 0;
      lastGame().scene.callLog.length = 0;

      renderer.restart();
      // Restart is issued synchronously, exactly as `GameScreen` did before the
      // adapter existed; the blob-URL revocation is a dynamic import that
      // settles afterwards. That ordering is preserved, not improved.
      expect(scene.restarts).toEqual(['restart']);
      expect(restartOrder).toEqual([]);

      await vi.waitFor(() => {
        expect(restartOrder).toEqual(['revoke-blob-urls']);
      });
    });

    it('no-ops restart before mount', () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });

      expect(() => renderer.restart()).not.toThrow();
      expect(StubGame.instances).toHaveLength(0);
    });

    it('forwards every capability to the scene once ready', () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });
      renderer.mount();
      lastGame().emitReady();
      const scene = sceneOf(lastGame(), 'DungeonScene');

      for (const [name, call] of dungeonCapabilityCalls(renderer)) {
        expect(call, name).not.toThrow();
      }

      expect(scene.setFloorVisibility).toHaveBeenCalledWith(SYNTHETIC_FLOOR);
      expect(scene.teleportToRoom).toHaveBeenCalledWith(SYNTHETIC_ROOM_BETA);
      expect(scene.setArtifactRooms).toHaveBeenCalledWith([SYNTHETIC_ROOM_ALPHA], true);
      expect(scene.setCollectedArtifactRooms).toHaveBeenCalledWith([SYNTHETIC_ROOM_ALPHA]);
      expect(scene.setReviewedArtifactRooms).toHaveBeenCalledWith([SYNTHETIC_ROOM_BETA]);
      expect(scene.setImageRooms).toHaveBeenCalledWith([SYNTHETIC_ROOM_BETA]);
      expect(scene.setRoomOverlayStates).toHaveBeenCalledWith({
        [SYNTHETIC_ROOM_ALPHA]: 'Created',
      });
      expect(scene.triggerInteract).toHaveBeenCalledTimes(1);
    });

    it('no-ops every capability while no scene is available', () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });

      for (const [name, call] of dungeonCapabilityCalls(renderer)) {
        expect(call, name).not.toThrow();
      }
      // Also no-ops between mount and the engine ready event, when the adapter
      // holds a game but not yet a scene reference.
      renderer.mount();
      for (const [name, call] of dungeonCapabilityCalls(renderer)) {
        expect(call, name).not.toThrow();
      }
      const scene = sceneOf(lastGame(), 'DungeonScene');
      expect(scene.setFloorVisibility).not.toHaveBeenCalled();
      expect(scene.triggerInteract).not.toHaveBeenCalled();
    });

    it('no-ops every capability again after unmount', () => {
      const renderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });
      renderer.mount();
      lastGame().emitReady();
      renderer.unmount();
      const scene = sceneOf(lastGame(), 'DungeonScene');
      vi.clearAllMocks();

      for (const [name, call] of dungeonCapabilityCalls(renderer)) {
        expect(call, name).not.toThrow();
      }
      expect(scene.setFloorVisibility).not.toHaveBeenCalled();
      expect(scene.triggerInteract).not.toHaveBeenCalled();
    });

    it('is usable through the neutral ports alone, with no Phaser type in sight', () => {
      const renderer: PhaserDungeonRenderer = createPhaserDungeonRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_DUNGEON_WORLD,
        callbacks: dungeonCallbacks(),
      });
      // A screen only ever needs the neutral surface; the adapter's extra
      // `onReady` is additive, not a replacement.
      const neutral: WorldRenderer & DungeonRendererCapabilities = renderer;

      expect(typeof neutral.mount).toBe('function');
      expect(typeof neutral.unmount).toBe('function');
      expect(typeof neutral.isReady).toBe('function');
      expect(typeof neutral.restart).toBe('function');
      expect(neutral.isReady()).toBe(false);
      neutral.mount();
      lastGame().emitReady();
      expect(neutral.isReady()).toBe(true);
      neutral.unmount();
    });
  });

  describe('village renderer', () => {
    it('mounts the village scene with the neutral village world model', () => {
      const callbacks = villageCallbacks();
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks,
      });

      renderer.mount();

      const game = lastGame();
      expect(game.config.scene).toEqual([StubVillageScene, StubFishingScene]);
      expect(game.scene.started).toEqual([
        {
          key: 'VillageScene',
          data: {
            callbacks,
            dynamicStructures: SYNTHETIC_DUNGEON_STRUCTURES,
            playerClass: 'cartographer',
            spawnGridX: null,
            spawnGridY: null,
          },
        },
      ]);
    });

    it('applies the spawn override and the default scholar archetype', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: { ...SYNTHETIC_VILLAGE_WORLD, playerClass: null },
        callbacks: villageCallbacks(),
        spawn: { gridX: 4, gridY: 6 },
      });

      renderer.mount();

      const started = lastGame().scene.started[0].data as Record<string, unknown>;
      expect(started).toMatchObject({
        playerClass: 'scholar',
        spawnGridX: 4,
        spawnGridY: 6,
      });
    });

    it('is idempotent, reports readiness, and clears it on unmount', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });

      renderer.mount();
      renderer.mount();
      expect(StubGame.instances).toHaveLength(1);
      expect(renderer.isReady()).toBe(false);

      lastGame().emitReady();
      expect(renderer.isReady()).toBe(true);

      renderer.unmount();
      expect(renderer.isReady()).toBe(false);
      expect(lastGame().destroyed).toEqual([true]);
    });

    it('forwards every capability to the village scene once ready', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      renderer.mount();
      lastGame().emitReady();
      const scene = sceneOf(lastGame(), 'VillageScene');
      scene.lastPoi = { name: SYNTHETIC_POI_NAME, angle: 42, distance: 12 };

      renderer.setDynamicStructures(SYNTHETIC_DUNGEON_STRUCTURES);
      renderer.setPlayerClass('archivist');
      renderer.triggerInteract();

      expect(scene.setDynamicStructures).toHaveBeenCalledWith(SYNTHETIC_DUNGEON_STRUCTURES);
      expect(scene.setPlayerClass).toHaveBeenCalledWith('archivist');
      expect(scene.triggerInteract).toHaveBeenCalledTimes(1);
      expect(renderer.readPoi()).toEqual({
        name: SYNTHETIC_POI_NAME,
        angle: 42,
        distance: 12,
      });
    });

    it('maps a null archetype onto the scholar default the scene expects', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      renderer.mount();
      lastGame().emitReady();
      const scene = sceneOf(lastGame(), 'VillageScene');

      renderer.setPlayerClass(null);

      expect(scene.setPlayerClass).toHaveBeenCalledWith('scholar');
    });

    it('no-ops every village capability while no scene is available', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });

      for (const [name, call] of villageCapabilityCalls(renderer)) {
        expect(call, name).not.toThrow();
      }
      expect(renderer.readPoi()).toBeNull();

      renderer.mount();
      for (const [name, call] of villageCapabilityCalls(renderer)) {
        expect(call, name).not.toThrow();
      }
      const scene = sceneOf(lastGame(), 'VillageScene');
      expect(scene.setDynamicStructures).not.toHaveBeenCalled();
      expect(scene.triggerInteract).not.toHaveBeenCalled();
    });

    it('hides a point of interest at the scene out-of-range sentinel distance', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      renderer.mount();
      lastGame().emitReady();
      const scene = sceneOf(lastGame(), 'VillageScene');

      scene.lastPoi = { name: SYNTHETIC_POI_NAME, angle: 0, distance: 1e9 };
      expect(renderer.readPoi()).toBeNull();

      scene.lastPoi = { name: SYNTHETIC_POI_NAME, angle: 0, distance: 1e9 + 1 };
      expect(renderer.readPoi()).toBeNull();

      scene.lastPoi = { name: SYNTHETIC_POI_NAME, angle: 12, distance: 1e9 - 1 };
      expect(renderer.readPoi()).toEqual({
        name: SYNTHETIC_POI_NAME,
        angle: 12,
        distance: 1e9 - 1,
      });
    });

    it('projects a read-only point of interest rather than the live scene object', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      renderer.mount();
      lastGame().emitReady();
      const scene = sceneOf(lastGame(), 'VillageScene');
      scene.lastPoi = { name: SYNTHETIC_POI_NAME, angle: 5, distance: 8 };

      const poi = renderer.readPoi();

      expect(poi).not.toBe(scene.lastPoi);
      expect(poi).toEqual({ name: SYNTHETIC_POI_NAME, angle: 5, distance: 8 });
    });

    it('notifies onReady once, honours unsubscribe, and restarts in the same tick', async () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      const listener = vi.fn();
      const unsubscribed = vi.fn();
      renderer.onReady(listener);
      const unsubscribe = renderer.onReady(unsubscribed);
      unsubscribe();

      renderer.mount();
      lastGame().emitReady();
      lastGame().emitReady();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(unsubscribed).not.toHaveBeenCalled();

      const scene = sceneOf(lastGame(), 'VillageScene');
      scene.restarts.length = 0;
      renderer.restart();
      expect(scene.restarts).toEqual(['restart']);
      await vi.waitFor(() => {
        expect(restartOrder).toEqual(['revoke-blob-urls']);
      });
    });

    it('no-ops restart before mount', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });

      expect(() => renderer.restart()).not.toThrow();
      expect(StubGame.instances).toHaveLength(0);
    });

    it('is usable through the neutral ports alone, with no Phaser type in sight', () => {
      const renderer: PhaserVillageRenderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      const neutral: WorldRenderer & VillageRendererCapabilities = renderer;

      expect(typeof neutral.mount).toBe('function');
      expect(typeof neutral.unmount).toBe('function');
      expect(typeof neutral.isReady).toBe('function');
      expect(typeof neutral.restart).toBe('function');
      expect(neutral.readPoi()).toBeNull();
      expect(renderer.fishing()).toBeDefined();
    });
  });

  describe('fishing renderer', () => {
    it('sleeps the village scene and starts the fishing scene with the neutral model', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      renderer.mount();
      lastGame().emitReady();
      const game = lastGame();
      const village = sceneOf(game, 'VillageScene');
      game.scene.callLog.length = 0;
      const onFishCaught = vi.fn();
      const onReturnToVillage = vi.fn();
      const onReady = vi.fn();

      renderer.fishing().enter(SYNTHETIC_FISHING_WORLD, {
        onFishCaught,
        onReturnToVillage,
        onReady,
      });

      expect(village.sleeps).toEqual([1]);
      expect(game.scene.callLog).toEqual(['start:FishingScene']);
      const started = game.scene.started.at(-1) as { key: string; data: Record<string, unknown> };
      expect(started.key).toBe('FishingScene');
      expect(started.data).toMatchObject({
        playerClass: 'archivist',
        hasClearedRooms: true,
      });

      // The adapter projects the neutral handlers onto the scene callbacks.
      const sceneCallbacks = started.data.callbacks as FishingSceneEvents;
      sceneCallbacks.onFishCaught?.(SYNTHETIC_FISH);
      sceneCallbacks.onReturnToVillage();
      sceneCallbacks.onReady();
      expect(onFishCaught).toHaveBeenCalledWith(SYNTHETIC_FISH);
      expect(onReturnToVillage).toHaveBeenCalledTimes(1);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('no-ops enter while the owning world host is not mounted', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      const handlers = {
        onFishCaught: vi.fn(),
        onReturnToVillage: vi.fn(),
        onReady: vi.fn(),
      };

      expect(() => renderer.fishing().enter(SYNTHETIC_FISHING_WORLD, handlers)).not.toThrow();
      expect(StubGame.instances).toHaveLength(0);
    });

    it('no-ops enter after the village host unmounted', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      renderer.mount();
      const game = lastGame();
      game.scene.callLog.length = 0;
      renderer.unmount();

      expect(() =>
        renderer.fishing().enter(SYNTHETIC_FISHING_WORLD, {
          onFishCaught: vi.fn(),
          onReturnToVillage: vi.fn(),
          onReady: vi.fn(),
        }),
      ).not.toThrow();
      expect(game.scene.callLog).toEqual([]);
    });

    it('holds an archetype override for the next session because textures preload', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      renderer.mount();
      lastGame().emitReady();
      const game = lastGame();

      renderer.fishing().setPlayerClass('cartographer');
      const fishing = renderer.fishing();
      fishing.enter({ ...SYNTHETIC_FISHING_WORLD, playerClass: null }, {
        onFishCaught: vi.fn(),
        onReturnToVillage: vi.fn(),
        onReady: vi.fn(),
      });

      const started = game.scene.started.at(-1) as { data: Record<string, unknown> };
      expect(started.data.playerClass).toBe('cartographer');
    });

    it('reads the caught count from the fishing scene, and zero when absent', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });

      expect(renderer.fishing().getCaughtCount()).toBe(0);

      renderer.mount();
      lastGame().emitReady();
      const fishing = sceneOf(lastGame(), 'FishingScene');
      fishing.getCaughtCount.mockReturnValue(3);
      expect(renderer.fishing().getCaughtCount()).toBe(3);
    });

    it('defers the stop/wake pair by one task, exactly as the village screen did', () => {
      vi.useFakeTimers();
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      renderer.mount();
      lastGame().emitReady();
      const game = lastGame();
      const village = sceneOf(game, 'VillageScene');
      game.scene.callLog.length = 0;

      renderer.fishing().returnToVillage();

      // Nothing has happened yet: the teardown must wait for the current
      // interaction to finish.
      expect(game.scene.callLog).toEqual([]);

      vi.advanceTimersByTime(0);

      expect(game.scene.callLog).toEqual(['stop:FishingScene']);
      expect(game.scene.stopped).toEqual(['FishingScene']);
      expect(village.wakes).toEqual([1]);
    });

    it('no-ops the deferred return when the host unmounted before the task ran', () => {
      vi.useFakeTimers();
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      renderer.mount();
      const game = lastGame();
      const village = sceneOf(game, 'VillageScene');
      game.scene.callLog.length = 0;

      renderer.fishing().returnToVillage();
      renderer.unmount();
      vi.advanceTimersByTime(0);

      expect(game.scene.callLog).toEqual([]);
      expect(village.wakes).toEqual([]);
    });

    it('satisfies the neutral fishing capability port', () => {
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });
      const fishing: FishingRendererCapabilities = renderer.fishing();
      expect(typeof fishing.setPlayerClass).toBe('function');
      expect(typeof fishing.getCaughtCount).toBe('function');
      expect(typeof fishing.returnToVillage).toBe('function');
    });

    it('no-ops every fishing capability while no world host is mounted', () => {
      vi.useFakeTimers();
      const renderer = createPhaserVillageRenderer({
        parent: document.createElement('div'),
        world: SYNTHETIC_VILLAGE_WORLD,
        callbacks: villageCallbacks(),
      });

      for (const [name, call] of fishingCapabilityCalls(renderer.fishing())) {
        expect(call, name).not.toThrow();
      }
      expect(renderer.fishing().getCaughtCount()).toBe(0);

      vi.advanceTimersByTime(0);
      expect(StubGame.instances).toHaveLength(0);
    });
  });
});
