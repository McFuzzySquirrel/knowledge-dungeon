/**
 * Phase 2 contract test: every current Phaser callback, exercised through the
 * renderer-neutral event contract.
 *
 * The three `*SceneEvents` types are the callbacks the Phaser host reports
 * through. Each of them is projected onto the contract payload in
 * `src/application/contracts/events.ts`, pushed through `createWorldEventSink`,
 * and asserted at both ends: the application handler received exactly the
 * contract payload, and the scene callback received exactly the flat arguments
 * Phaser passes it.
 *
 * This file is deliberately engine-neutral: it imports the `*SceneEvents`
 * *types* only (`import type` is erased, so no Phaser module is loaded) and
 * never constructs a scene. Real Phaser behaviour is covered by the browser
 * gate and by `phase-2-adapter-lifecycle.test.ts`, which stubs a Phaser-shaped
 * host instead.
 *
 * Drift protection is layered so a new callback cannot land untested:
 * - `DUNGEON/VILLAGE/FISHING_EVENT_BY_CALLBACK` is `satisfies
 *   Record<keyof <SceneEvents>, WorldEventName>`, so adding or removing a scene
 *   callback is a *compile* error until this file is updated.
 * - the three `Expect<Equal<...>>` aliases prove, at compile time, that the
 *   callback map covers exactly the contract's events for that world - in both
 *   directions, so neither side can gain an event alone.
 * - one generated `it` per callback, listed in the `PHASER_CALLBACK_COVERAGE`
 *   table below. Adding an event without adding a row fails the length, the
 *   set-equality, and the uniqueness assertions.
 * - `readContractEventNames()` parses `WorldEventPayloadMap` out of the
 *   contract source so the table cannot diverge from the contract at runtime
 *   either.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorldEventSink,
  type WorldEvent,
  type WorldEventHandlers,
  type WorldEventName,
  type WorldEventPayload,
  type WorldEventSink,
} from '@/application/contracts/events';
import type { DungeonSceneEvents, VillageSceneEvents } from '@/game/adapters';
import type { FishingSceneEvents } from '@/game/scenes/FishingScene';

// ── Synthetic fixtures ──────────────────────────────────────────────────────
// Obviously fake learner data only: these strings are identifiers invented for
// this test, not a subject, note, or any other learner record.

const SYNTHETIC_ROOM_ROOT = 'synthetic-room-root';
const SYNTHETIC_ROOM_ALPHA = 'synthetic-room-alpha';
const SYNTHETIC_STRUCTURE_KEEPER = 'synthetic-keeper-tower';
const SYNTHETIC_STRUCTURE_PORTAL = 'synthetic-portal-icon';
const SYNTHETIC_NPC_VILLAGER = 'synthetic-npc-villager';
const SYNTHETIC_FISH_NAME = 'Synthetic Test Fish';
const SYNTHETIC_FISH_CATALOG_ID = 'synthetic-fish-1';
const SYNTHETIC_FISH_DESCRIPTION = 'A synthetic fish invented for contract tests.';
const SYNTHETIC_FISH_RARITY = 'common' as const;

/** Number of Phaser callbacks this phase is contractually required to cover. */
const EXPECTED_CALLBACK_COUNT = 18;

// ── Compile-time helpers ────────────────────────────────────────────────────

/** Exact-type equality; the distributive conditional defeats `A extends B`. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
/** Compile-time assertion: fails typecheck (not just the test run) when false. */
type Expect<T extends true> = T;

type DungeonEventName = Extract<WorldEventName, `dungeon:${string}`>;
type VillageEventName = Extract<WorldEventName, `village:${string}`>;
type FishingEventName = Extract<WorldEventName, `fishing:${string}`>;

/**
 * Reverse index: scene callback name -> contract event name. `satisfies
 * Record<keyof <SceneEvents>, ...>` is what makes a scene-callback change a
 * compile error here.
 */
const DUNGEON_EVENT_BY_CALLBACK = {
  onRoomEntered: 'dungeon:room-entered',
  onInteract: 'dungeon:interact',
  onNpcInteract: 'dungeon:npc-interact',
  onNpcDialogPosition: 'dungeon:npc-dialog-position',
  onNpcOutOfRange: 'dungeon:npc-out-of-range',
  onArtifactCollected: 'dungeon:artifact-collected',
  onFloorTransition: 'dungeon:floor-transition',
} as const satisfies Record<keyof DungeonSceneEvents, DungeonEventName>;

const VILLAGE_EVENT_BY_CALLBACK = {
  onStructureApproached: 'village:structure-approached',
  onStructureLeft: 'village:structure-left',
  onStructureInteract: 'village:structure-interact',
  onNpcApproached: 'village:npc-approached',
  onNpcLeft: 'village:npc-left',
  onNpcInteract: 'village:npc-interact',
  onNpcDialogPosition: 'village:npc-dialog-position',
  onReady: 'village:ready',
} as const satisfies Record<keyof VillageSceneEvents, VillageEventName>;

const FISHING_EVENT_BY_CALLBACK = {
  onFishCaught: 'fishing:fish-caught',
  onReturnToVillage: 'fishing:return-to-village',
  onReady: 'fishing:ready',
} as const satisfies Record<keyof FishingSceneEvents, FishingEventName>;

/**
 * Compile-time proof that each scene callback map covers exactly its world
 * slice of `WorldEventPayloadMap` - no missing event, no invented event.
 * Exported so the assertion is a module export rather than an unused local.
 */
export type DungeonCallbacksCoverTheContract = Expect<
  Equal<
    (typeof DUNGEON_EVENT_BY_CALLBACK)[keyof typeof DUNGEON_EVENT_BY_CALLBACK],
    DungeonEventName
  >
>;
export type VillageCallbacksCoverTheContract = Expect<
  Equal<
    (typeof VILLAGE_EVENT_BY_CALLBACK)[keyof typeof VILLAGE_EVENT_BY_CALLBACK],
    VillageEventName
  >
>;
export type FishingCallbacksCoverTheContract = Expect<
  Equal<
    (typeof FISHING_EVENT_BY_CALLBACK)[keyof typeof FISHING_EVENT_BY_CALLBACK],
    FishingEventName
  >
>;

// ── Contract helpers ────────────────────────────────────────────────────────

/**
 * Build a tagged contract event. The `payload` parameter is typed from `type`,
 * so a payload that does not match its event name is a compile error at the
 * call site - that is the pairing this file exists to prove.
 */
function taggedEvent<E extends WorldEventName>(
  type: E,
  payload: WorldEventPayload<E>,
): WorldEvent {
  return { type, payload } as WorldEvent;
}

/** Parse the event names out of `WorldEventPayloadMap` in the contract source. */
function readContractEventNames(): string[] {
  const source = readFileSync(
    join(process.cwd(), 'src/application/contracts/events.ts'),
    'utf8',
  );
  const start = source.indexOf('export interface WorldEventPayloadMap {');
  expect(start, 'WorldEventPayloadMap is missing from the event contract').toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf('\n}', start));
  return [...block.matchAll(/^\s*'([^']+)'\s*:/gm)].map((match) => match[1]);
}

// ── Per-scene harnesses ─────────────────────────────────────────────────────

interface Delivery {
  type: WorldEventName;
  payload: unknown;
}

/** A scene callback bag plus the contract handler bag projected from it. */
interface SceneHarness {
  /** The `*SceneEvents` object a Phaser host would hand the scene. */
  callbacks: unknown;
  /**
   * The neutral `WorldEventHandlers` bag the application layer binds. Each
   * harness declares its own slice as `Required<...>`, so a scene that grows an
   * event without a projection fails to compile here.
   */
  handlers: Pick<WorldEventHandlers, WorldEventName>;
  /** Exactly what each application handler received, in delivery order. */
  deliveries: Delivery[];
  /** Flat arguments each scene callback was called with, by callback name. */
  callArgs: Map<string, unknown[]>;
}

function createDungeonHarness(): SceneHarness {
  const spies = {
    onRoomEntered: vi.fn(),
    onInteract: vi.fn(),
    onNpcInteract: vi.fn(),
    onNpcDialogPosition: vi.fn(),
    onNpcOutOfRange: vi.fn(),
    onArtifactCollected: vi.fn(),
    onFloorTransition: vi.fn(),
  } satisfies DungeonSceneEvents;
  const callArgs = new Map<string, unknown[]>();
  const deliveries: Delivery[] = [];
  const record = (type: WorldEventName, payload: unknown): void => {
    deliveries.push({ type, payload });
  };
  const recordArgs = (name: string, args: unknown[]): void => {
    callArgs.set(name, args);
  };

  // Each projection is contextually typed by the contract, so a changed
  // contract field or a changed scene signature breaks the build here.
  const handlers: Required<Pick<WorldEventHandlers, DungeonEventName>> = {
    'dungeon:room-entered': (payload) => {
      record('dungeon:room-entered', payload);
      recordArgs('onRoomEntered', [payload.roomId]);
      spies.onRoomEntered(payload.roomId);
    },
    'dungeon:interact': (payload) => {
      record('dungeon:interact', payload);
      recordArgs('onInteract', [payload.roomId]);
      spies.onInteract(payload.roomId);
    },
    'dungeon:npc-interact': (payload) => {
      record('dungeon:npc-interact', payload);
      recordArgs('onNpcInteract', [payload]);
      spies.onNpcInteract?.(payload);
    },
    'dungeon:npc-dialog-position': (payload) => {
      record('dungeon:npc-dialog-position', payload);
      recordArgs('onNpcDialogPosition', [payload]);
      spies.onNpcDialogPosition?.(payload);
    },
    'dungeon:npc-out-of-range': (payload) => {
      record('dungeon:npc-out-of-range', payload);
      recordArgs('onNpcOutOfRange', [payload.roomId]);
      spies.onNpcOutOfRange?.(payload.roomId);
    },
    'dungeon:artifact-collected': (payload) => {
      record('dungeon:artifact-collected', payload);
      recordArgs('onArtifactCollected', [payload.roomId]);
      spies.onArtifactCollected?.(payload.roomId);
    },
    'dungeon:floor-transition': (payload) => {
      record('dungeon:floor-transition', payload);
      recordArgs('onFloorTransition', [payload]);
      spies.onFloorTransition?.(payload);
    },
  };

  return { callbacks: spies, handlers, deliveries, callArgs };
}

function createVillageHarness(): SceneHarness {
  const spies = {
    onStructureApproached: vi.fn(),
    onStructureLeft: vi.fn(),
    onStructureInteract: vi.fn(),
    onNpcApproached: vi.fn(),
    onNpcLeft: vi.fn(),
    onNpcInteract: vi.fn(),
    onNpcDialogPosition: vi.fn(),
    onReady: vi.fn(),
  } satisfies VillageSceneEvents;
  const callArgs = new Map<string, unknown[]>();
  const deliveries: Delivery[] = [];
  const record = (type: WorldEventName, payload: unknown): void => {
    deliveries.push({ type, payload });
  };
  const recordArgs = (name: string, args: unknown[]): void => {
    callArgs.set(name, args);
  };

  const handlers: Required<Pick<WorldEventHandlers, VillageEventName>> = {
    'village:structure-approached': (payload) => {
      record('village:structure-approached', payload);
      recordArgs('onStructureApproached', [payload.structureId]);
      spies.onStructureApproached(payload.structureId);
    },
    'village:structure-left': (payload) => {
      record('village:structure-left', payload);
      recordArgs('onStructureLeft', [payload.structureId]);
      spies.onStructureLeft(payload.structureId);
    },
    'village:structure-interact': (payload) => {
      record('village:structure-interact', payload);
      recordArgs('onStructureInteract', [payload.structureId]);
      spies.onStructureInteract(payload.structureId);
    },
    'village:npc-approached': (payload) => {
      record('village:npc-approached', payload);
      recordArgs('onNpcApproached', [payload.npcId]);
      spies.onNpcApproached(payload.npcId);
    },
    'village:npc-left': (payload) => {
      record('village:npc-left', payload);
      recordArgs('onNpcLeft', [payload.npcId]);
      spies.onNpcLeft(payload.npcId);
    },
    'village:npc-interact': (payload) => {
      record('village:npc-interact', payload);
      recordArgs('onNpcInteract', [payload.npcId]);
      spies.onNpcInteract(payload.npcId);
    },
    'village:npc-dialog-position': (payload) => {
      record('village:npc-dialog-position', payload);
      recordArgs('onNpcDialogPosition', [payload]);
      spies.onNpcDialogPosition?.(payload);
    },
    'village:ready': () => {
      record('village:ready', undefined);
      recordArgs('onReady', []);
      spies.onReady();
    },
  };

  return { callbacks: spies, handlers, deliveries, callArgs };
}

function createFishingHarness(): SceneHarness {
  const spies = {
    onFishCaught: vi.fn(),
    onReturnToVillage: vi.fn(),
    onReady: vi.fn(),
  } satisfies FishingSceneEvents;
  const callArgs = new Map<string, unknown[]>();
  const deliveries: Delivery[] = [];
  const record = (type: WorldEventName, payload: unknown): void => {
    deliveries.push({ type, payload });
  };
  const recordArgs = (name: string, args: unknown[]): void => {
    callArgs.set(name, args);
  };

  const handlers: Required<Pick<WorldEventHandlers, FishingEventName>> = {
    'fishing:fish-caught': (payload) => {
      record('fishing:fish-caught', payload);
      recordArgs('onFishCaught', [payload]);
      spies.onFishCaught?.(payload);
    },
    'fishing:return-to-village': () => {
      record('fishing:return-to-village', undefined);
      recordArgs('onReturnToVillage', []);
      spies.onReturnToVillage();
    },
    'fishing:ready': () => {
      record('fishing:ready', undefined);
      recordArgs('onReady', []);
      spies.onReady();
    },
  };

  return { callbacks: spies, handlers, deliveries, callArgs };
}

function createHarness(scene: CallbackScene): SceneHarness {
  if (scene === 'dungeon') return createDungeonHarness();
  if (scene === 'village') return createVillageHarness();
  return createFishingHarness();
}

// ── Coverage table ──────────────────────────────────────────────────────────

type CallbackScene = 'dungeon' | 'village' | 'fishing';

interface CoverageRow<C extends string, E extends WorldEventName> {
  readonly scene: CallbackScene;
  readonly callback: C;
  readonly event: E;
  /** Unique `it` title; adding a callback means adding a row here. */
  readonly label: string;
  /** The contract event the scene reports, built with a payload-checked call. */
  readonly emit: () => WorldEvent;
  /** Flat arguments the scene callback is expected to receive. */
  readonly sceneArgs: unknown[];
}

const DUNGEON_COVERAGE: readonly CoverageRow<keyof DungeonSceneEvents, DungeonEventName>[] = [
  {
    scene: 'dungeon',
    callback: 'onRoomEntered',
    event: 'dungeon:room-entered',
    label: 'dungeon onRoomEntered reports the entered room id',
    emit: () => taggedEvent('dungeon:room-entered', { roomId: SYNTHETIC_ROOM_ALPHA }),
    sceneArgs: [SYNTHETIC_ROOM_ALPHA],
  },
  {
    scene: 'dungeon',
    callback: 'onInteract',
    event: 'dungeon:interact',
    label: 'dungeon onInteract reports the interacted room id',
    emit: () => taggedEvent('dungeon:interact', { roomId: SYNTHETIC_ROOM_ALPHA }),
    sceneArgs: [SYNTHETIC_ROOM_ALPHA],
  },
  {
    scene: 'dungeon',
    callback: 'onNpcInteract',
    event: 'dungeon:npc-interact',
    label: 'dungeon onNpcInteract reports the room and the client anchor point',
    emit: () =>
      taggedEvent('dungeon:npc-interact', {
        roomId: SYNTHETIC_ROOM_ALPHA,
        clientX: 12,
        clientY: 34,
      }),
    sceneArgs: [{ roomId: SYNTHETIC_ROOM_ALPHA, clientX: 12, clientY: 34 }],
  },
  {
    scene: 'dungeon',
    callback: 'onNpcDialogPosition',
    event: 'dungeon:npc-dialog-position',
    label: 'dungeon onNpcDialogPosition reports the dialog anchor point',
    emit: () =>
      taggedEvent('dungeon:npc-dialog-position', {
        roomId: SYNTHETIC_ROOM_ROOT,
        clientX: 56,
        clientY: 78,
      }),
    sceneArgs: [{ roomId: SYNTHETIC_ROOM_ROOT, clientX: 56, clientY: 78 }],
  },
  {
    scene: 'dungeon',
    callback: 'onNpcOutOfRange',
    event: 'dungeon:npc-out-of-range',
    label: 'dungeon onNpcOutOfRange reports only the room id',
    emit: () => taggedEvent('dungeon:npc-out-of-range', { roomId: SYNTHETIC_ROOM_ALPHA }),
    sceneArgs: [SYNTHETIC_ROOM_ALPHA],
  },
  {
    scene: 'dungeon',
    callback: 'onArtifactCollected',
    event: 'dungeon:artifact-collected',
    label: 'dungeon onArtifactCollected reports the cleared room id',
    emit: () =>
      taggedEvent('dungeon:artifact-collected', { roomId: SYNTHETIC_ROOM_ALPHA }),
    sceneArgs: [SYNTHETIC_ROOM_ALPHA],
  },
  {
    scene: 'dungeon',
    callback: 'onFloorTransition',
    event: 'dungeon:floor-transition',
    label: 'dungeon onFloorTransition reports the portal room and direction',
    emit: () =>
      taggedEvent('dungeon:floor-transition', {
        fromRoomId: SYNTHETIC_ROOM_ROOT,
        direction: 'down',
      }),
    sceneArgs: [{ fromRoomId: SYNTHETIC_ROOM_ROOT, direction: 'down' }],
  },
];

const VILLAGE_COVERAGE: readonly CoverageRow<keyof VillageSceneEvents, VillageEventName>[] = [
  {
    scene: 'village',
    callback: 'onStructureApproached',
    event: 'village:structure-approached',
    label: 'village onStructureApproached reports the approached structure id',
    emit: () =>
      taggedEvent('village:structure-approached', { structureId: SYNTHETIC_STRUCTURE_KEEPER }),
    sceneArgs: [SYNTHETIC_STRUCTURE_KEEPER],
  },
  {
    scene: 'village',
    callback: 'onStructureLeft',
    event: 'village:structure-left',
    label: 'village onStructureLeft reports the left structure id',
    emit: () => taggedEvent('village:structure-left', { structureId: SYNTHETIC_STRUCTURE_KEEPER }),
    sceneArgs: [SYNTHETIC_STRUCTURE_KEEPER],
  },
  {
    scene: 'village',
    callback: 'onStructureInteract',
    event: 'village:structure-interact',
    label: 'village onStructureInteract reports the interacted structure id',
    emit: () =>
      taggedEvent('village:structure-interact', {
        structureId: SYNTHETIC_STRUCTURE_PORTAL,
      }),
    sceneArgs: [SYNTHETIC_STRUCTURE_PORTAL],
  },
  {
    scene: 'village',
    callback: 'onNpcApproached',
    event: 'village:npc-approached',
    label: 'village onNpcApproached reports the approached npc id',
    emit: () => taggedEvent('village:npc-approached', { npcId: SYNTHETIC_NPC_VILLAGER }),
    sceneArgs: [SYNTHETIC_NPC_VILLAGER],
  },
  {
    scene: 'village',
    callback: 'onNpcLeft',
    event: 'village:npc-left',
    label: 'village onNpcLeft reports the left npc id',
    emit: () => taggedEvent('village:npc-left', { npcId: SYNTHETIC_NPC_VILLAGER }),
    sceneArgs: [SYNTHETIC_NPC_VILLAGER],
  },
  {
    scene: 'village',
    callback: 'onNpcInteract',
    event: 'village:npc-interact',
    label: 'village onNpcInteract reports the interacted npc id',
    emit: () => taggedEvent('village:npc-interact', { npcId: SYNTHETIC_NPC_VILLAGER }),
    sceneArgs: [SYNTHETIC_NPC_VILLAGER],
  },
  {
    scene: 'village',
    callback: 'onNpcDialogPosition',
    event: 'village:npc-dialog-position',
    label: 'village onNpcDialogPosition reports the npc id and client anchor point',
    emit: () =>
      taggedEvent('village:npc-dialog-position', {
        npcId: SYNTHETIC_NPC_VILLAGER,
        clientX: 21,
        clientY: 43,
      }),
    sceneArgs: [{ npcId: SYNTHETIC_NPC_VILLAGER, clientX: 21, clientY: 43 }],
  },
  {
    scene: 'village',
    callback: 'onReady',
    event: 'village:ready',
    label: 'village onReady is a zero-payload readiness notification',
    emit: () => taggedEvent('village:ready', undefined),
    sceneArgs: [],
  },
];

const FISHING_COVERAGE: readonly CoverageRow<keyof FishingSceneEvents, FishingEventName>[] = [
  {
    scene: 'fishing',
    callback: 'onFishCaught',
    event: 'fishing:fish-caught',
    label: 'fishing onFishCaught reports the full catch payload',
    emit: () =>
      taggedEvent('fishing:fish-caught', {
        fishName: SYNTHETIC_FISH_NAME,
        rarity: SYNTHETIC_FISH_RARITY,
        catalogId: SYNTHETIC_FISH_CATALOG_ID,
        description: SYNTHETIC_FISH_DESCRIPTION,
      }),
    sceneArgs: [
      {
        fishName: SYNTHETIC_FISH_NAME,
        rarity: SYNTHETIC_FISH_RARITY,
        catalogId: SYNTHETIC_FISH_CATALOG_ID,
        description: SYNTHETIC_FISH_DESCRIPTION,
      },
    ],
  },
  {
    scene: 'fishing',
    callback: 'onReturnToVillage',
    event: 'fishing:return-to-village',
    label: 'fishing onReturnToVillage is a zero-payload return request',
    emit: () => taggedEvent('fishing:return-to-village', undefined),
    sceneArgs: [],
  },
  {
    scene: 'fishing',
    callback: 'onReady',
    event: 'fishing:ready',
    label: 'fishing onReady is a zero-payload readiness notification',
    emit: () => taggedEvent('fishing:ready', undefined),
    sceneArgs: [],
  },
];

const PHASER_CALLBACK_COVERAGE = [
  ...DUNGEON_COVERAGE,
  ...VILLAGE_COVERAGE,
  ...FISHING_COVERAGE,
] as const;

/** Scene callback name -> contract event name, built from the coverage table. */
const COVERED_EVENT_BY_CALLBACK = new Map<string, WorldEventName>(
  PHASER_CALLBACK_COVERAGE.map((row) => [`${row.scene}.${row.callback}`, row.event]),
);

function dispatch(row: (typeof PHASER_CALLBACK_COVERAGE)[number]): {
  harness: SceneHarness;
  event: WorldEvent;
  sink: WorldEventSink;
} {
  const harness = createHarness(row.scene);
  const sink = createWorldEventSink(harness.handlers);
  const event = row.emit();
  sink(event);
  return { harness, event, sink };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Phase 2 Phaser callback coverage', () => {
  it('declares exactly 18 current Phaser callbacks, 7 dungeon / 8 village / 3 fishing', () => {
    expect(readContractEventNames()).toHaveLength(EXPECTED_CALLBACK_COUNT);
    expect(DUNGEON_COVERAGE).toHaveLength(7);
    expect(VILLAGE_COVERAGE).toHaveLength(8);
    expect(FISHING_COVERAGE).toHaveLength(3);
    expect(PHASER_CALLBACK_COVERAGE).toHaveLength(EXPECTED_CALLBACK_COUNT);
  });

  it('indexes every scene callback onto exactly one contract event', () => {
    expect(Object.keys(DUNGEON_EVENT_BY_CALLBACK).sort()).toEqual(
      DUNGEON_COVERAGE.map((row) => row.callback).sort(),
    );
    expect(Object.keys(VILLAGE_EVENT_BY_CALLBACK).sort()).toEqual(
      VILLAGE_COVERAGE.map((row) => row.callback).sort(),
    );
    expect(Object.keys(FISHING_EVENT_BY_CALLBACK).sort()).toEqual(
      FISHING_COVERAGE.map((row) => row.callback).sort(),
    );

    const declaredEvents = [
      ...Object.values(DUNGEON_EVENT_BY_CALLBACK),
      ...Object.values(VILLAGE_EVENT_BY_CALLBACK),
      ...Object.values(FISHING_EVENT_BY_CALLBACK),
    ];
    expect(new Set(declaredEvents).size).toBe(EXPECTED_CALLBACK_COUNT);
  });

  it('covers exactly the events WorldEventPayloadMap declares, with no drift either way', () => {
    const contractEvents = readContractEventNames();
    const coveredEvents = PHASER_CALLBACK_COVERAGE.map((row) => row.event);

    expect([...coveredEvents].sort()).toEqual([...contractEvents].sort());
    expect(COVERED_EVENT_BY_CALLBACK.size).toBe(EXPECTED_CALLBACK_COUNT);
  });

  it('gives every covered callback a unique generated test', () => {
    const labels = PHASER_CALLBACK_COVERAGE.map((row) => row.label);
    expect(new Set(labels).size).toBe(EXPECTED_CALLBACK_COUNT);
    for (const label of labels) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it('routes a tagged event only to the handler for its own event name', () => {
    const harness = createDungeonHarness();
    const sink = createWorldEventSink(harness.handlers);
    const roomEntered = taggedEvent('dungeon:room-entered', { roomId: SYNTHETIC_ROOM_ROOT });
    const interact = taggedEvent('dungeon:interact', { roomId: SYNTHETIC_ROOM_ALPHA });

    sink(roomEntered);
    sink(interact);

    expect(harness.deliveries).toEqual([
      { type: 'dungeon:room-entered', payload: { roomId: SYNTHETIC_ROOM_ROOT } },
      { type: 'dungeon:interact', payload: { roomId: SYNTHETIC_ROOM_ALPHA } },
    ]);
    expect(harness.callArgs.get('onRoomEntered')).toEqual([SYNTHETIC_ROOM_ROOT]);
    expect(harness.callArgs.get('onInteract')).toEqual([SYNTHETIC_ROOM_ALPHA]);
  });

  it('drops a tagged event that has no handler bound instead of throwing', () => {
    const handlers: WorldEventHandlers = {};
    const sink = createWorldEventSink(handlers);

    expect(() =>
      sink(taggedEvent('fishing:return-to-village', undefined)),
    ).not.toThrow();
  });

  describe('every current Phaser callback reaches its contract handler', () => {
    for (const row of PHASER_CALLBACK_COVERAGE) {
      it(row.label, () => {
        const { harness, event } = dispatch(row);

        // The application layer received exactly the contract payload ...
        expect(harness.deliveries).toHaveLength(1);
        expect(harness.deliveries[0].type).toBe(row.event);
        expect(harness.deliveries[0].payload).toBe(event.payload);
        // ... and the scene callback received its historical flat arguments.
        expect(harness.callArgs.get(row.callback)).toEqual(row.sceneArgs);
        expect(harness.callArgs.size).toBe(1);
      });
    }
  });
});
